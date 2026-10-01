//! "Sync code" format shared with the web app (see `KWCode` in ../../sync.js).
//!
//! payload = base64url( b'z' + zlib(json) )   (or b'j' + json, uncompressed)
//! frame   = "KW1:<sid>:<index>:<total>:<chunk of payload>"   (index is 1-based)
//!
//! One frame fits in one QR code. Many frames are shown as an animated QR
//! sequence; the receiver collects them in any order. The same frames joined
//! by newlines are the plain-text sync code (copy/paste, chat, AirDrop...).

use std::io::{Read, Write};

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use flate2::Compression;
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use qrcode::{Color, EcLevel, QrCode};

use crate::model::Doc;

pub const PREFIX: &str = "KW1";
pub const DEFAULT_CHUNK: usize = 360;

pub fn encode_payload(doc: &Doc) -> Result<String> {
    let json = serde_json::to_vec(doc)?;
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::best());
    enc.write_all(&json)?;
    let mut bytes = vec![b'z'];
    bytes.extend(enc.finish()?);
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn decode_payload(payload: &str) -> Result<Doc> {
    let bytes = URL_SAFE_NO_PAD
        .decode(payload.trim().trim_end_matches('='))
        .context("sync code is not valid base64url")?;
    let (flag, body) = bytes
        .split_first()
        .ok_or_else(|| anyhow!("empty sync code"))?;
    let json = match flag {
        b'z' => {
            let mut out = Vec::new();
            ZlibDecoder::new(body)
                .read_to_end(&mut out)
                .context("inflate sync code")?;
            out
        }
        b'j' => body.to_vec(),
        _ => bail!("unknown sync code flag {:?}", *flag as char),
    };
    serde_json::from_slice(&json).context("sync code does not contain kwnote data")
}

fn fnv1a(s: &str) -> u32 {
    s.bytes().fold(0x811c9dc5u32, |h, b| {
        (h ^ b as u32).wrapping_mul(0x01000193)
    })
}

pub fn frames(doc: &Doc, chunk: usize) -> Result<Vec<String>> {
    let payload = encode_payload(doc)?;
    let sid = format!("{:06x}", fnv1a(&payload) & 0xff_ffff);
    let chunk = chunk.max(16);
    let parts: Vec<&str> = payload
        .as_bytes()
        .chunks(chunk)
        .map(|c| std::str::from_utf8(c).expect("base64 is ascii"))
        .collect();
    let n = parts.len();
    Ok(parts
        .iter()
        .enumerate()
        .map(|(i, p)| format!("{PREFIX}:{sid}:{}:{n}:{p}", i + 1))
        .collect())
}

/// Collects frames (possibly out of order, with duplicates) until complete.
#[derive(Debug, Default)]
pub struct Assembler {
    sid: String,
    parts: Vec<Option<String>>,
}

impl Assembler {
    /// Returns Ok(true) once every frame of the sequence has been seen.
    pub fn push(&mut self, frame: &str) -> Result<bool> {
        let mut it = frame.trim().splitn(5, ':');
        let (Some(PREFIX), Some(sid), Some(i), Some(n), Some(data)) =
            (it.next(), it.next(), it.next(), it.next(), it.next())
        else {
            bail!("not a kwnote sync frame");
        };
        let i: usize = i.parse().context("frame index")?;
        let n: usize = n.parse().context("frame total")?;
        if n == 0 || i == 0 || i > n {
            bail!("bad frame index {i}/{n}");
        }
        if self.sid != sid || self.parts.len() != n {
            // a different sequence: start over
            self.sid = sid.to_string();
            self.parts = vec![None; n];
        }
        self.parts[i - 1] = Some(data.to_string());
        Ok(self.is_complete())
    }

    pub fn is_complete(&self) -> bool {
        !self.parts.is_empty() && self.parts.iter().all(Option::is_some)
    }

    pub fn progress(&self) -> (usize, usize) {
        (
            self.parts.iter().filter(|p| p.is_some()).count(),
            self.parts.len(),
        )
    }

    pub fn finish(&self) -> Result<Doc> {
        if !self.is_complete() {
            let (have, total) = self.progress();
            bail!("incomplete sync code: {have}/{total} frames");
        }
        let payload: String = self.parts.iter().flatten().map(String::as_str).collect();
        decode_payload(&payload)
    }
}

/// Accepts a JSON export, a full sync code (frames separated by whitespace),
/// or a bare payload.
pub fn decode_any(text: &str) -> Result<Doc> {
    let t = text.trim();
    if t.starts_with('{') {
        return serde_json::from_str(t).context("parse JSON");
    }
    if t.starts_with(PREFIX) {
        let mut asm = Assembler::default();
        for frame in t.split_whitespace() {
            asm.push(frame)?;
        }
        return asm.finish();
    }
    decode_payload(t)
}

/// `text` as a QR code drawn with half-block characters: each line covers two
/// module rows and the glyph (foreground) is the dark module, so callers must
/// paint foreground black on a white background regardless of terminal theme.
pub struct QrBlock {
    /// `true` = dark module, row-major, includes a 2-module quiet zone.
    pub cells: Vec<Vec<bool>>,
}

impl QrBlock {
    pub fn new(text: &str) -> Result<QrBlock> {
        let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::M)
            .or_else(|_| QrCode::with_error_correction_level(text.as_bytes(), EcLevel::L))
            .map_err(|e| anyhow!("QR encode: {e:?}"))?;
        let w = code.width();
        let colors = code.to_colors();
        let quiet = 2;
        let size = w + quiet * 2;
        let mut cells = vec![vec![false; size]; size];
        for y in 0..w {
            for x in 0..w {
                cells[y + quiet][x + quiet] = colors[y * w + x] == Color::Dark;
            }
        }
        Ok(QrBlock { cells })
    }

    pub fn width(&self) -> usize {
        self.cells.len()
    }

    pub fn height_lines(&self) -> usize {
        self.cells.len().div_ceil(2)
    }

    /// Lines of '█' '▀' '▄' ' ' where the glyph colour is *dark*.
    pub fn lines(&self) -> Vec<String> {
        let n = self.cells.len();
        (0..n)
            .step_by(2)
            .map(|y| {
                (0..n)
                    .map(|x| {
                        let top = self.cells[y][x];
                        let bottom = y + 1 < n && self.cells[y + 1][x];
                        match (top, bottom) {
                            (true, true) => '█',
                            (true, false) => '▀',
                            (false, true) => '▄',
                            (false, false) => ' ',
                        }
                    })
                    .collect()
            })
            .collect()
    }

    /// ANSI-coloured version for printing straight to a terminal.
    pub fn ansi(&self) -> String {
        let mut s = String::new();
        for line in self.lines() {
            s.push_str("\x1b[38;5;16;48;5;231m");
            s.push_str(&line);
            s.push_str("\x1b[0m\n");
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Item, Sentence};

    fn sample() -> Doc {
        let mut d = Doc::default();
        for i in 0..80 {
            d.items.push(Item {
                id: format!("id_{i}"),
                question: format!("問題 {i} — どれくらい長い文章でも大丈夫か"),
                answer: format!("答え{i}"),
                registered_date: "2026-09-01".into(),
                ..Default::default()
            });
        }
        d.sentences.push(Sentence {
            id: "s_1".into(),
            text: "Hello".into(),
            ..Default::default()
        });
        d
    }

    #[test]
    fn roundtrip_frames_any_order() {
        let doc = sample();
        let mut fr = frames(&doc, 100).unwrap();
        assert!(fr.len() > 2);
        fr.reverse();
        let mut asm = Assembler::default();
        let mut done = false;
        for f in fr.iter().chain(fr.iter()) {
            done = asm.push(f).unwrap();
        }
        assert!(done);
        assert_eq!(asm.finish().unwrap(), doc);
        assert_eq!(decode_any(&fr.join("\n")).unwrap(), doc);
    }

    #[test]
    fn decodes_uncompressed_json_flag() {
        let doc = sample();
        let mut bytes = vec![b'j'];
        bytes.extend(serde_json::to_vec(&doc).unwrap());
        assert_eq!(decode_payload(&URL_SAFE_NO_PAD.encode(bytes)).unwrap(), doc);
    }

    #[test]
    fn qr_renders() {
        let q = QrBlock::new("KW1:abc:1:1:hello").unwrap();
        assert_eq!(q.lines().len(), q.height_lines());
    }
}
