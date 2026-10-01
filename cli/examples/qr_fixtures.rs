//! Reference QR matrices from the `qrcode` crate, used by
//! ../../tests/qr_crosscheck.mjs to verify the hand-written encoder in qr.js.
//!   cargo run -q --example qr_fixtures > /tmp/fixtures.json

use qrcode::bits::Bits;
use qrcode::{Color, EcLevel, QrCode, Version};

fn encode(data: &[u8], ec: EcLevel) -> (i16, Vec<String>) {
    for v in 1..=40 {
        let mut bits = Bits::new(Version::Normal(v));
        if bits.push_byte_data(data).is_err() || bits.push_terminator(ec).is_err() {
            continue;
        }
        let code = QrCode::with_bits(bits, ec).expect("encode");
        let w = code.width();
        let rows = code
            .to_colors()
            .chunks(w)
            .map(|r| {
                r.iter()
                    .map(|c| if *c == Color::Dark { '1' } else { '0' })
                    .collect()
            })
            .collect();
        return (v, rows);
    }
    panic!("too long");
}

fn main() {
    let mut texts: Vec<String> = vec![
        "".into(),
        "A".into(),
        "hello world".into(),
        "http://192.168.1.20:7878/#key=0123456789abcdef01234567".into(),
        "日本語のテキスト／記憶支援".into(),
    ];
    // payload-like strings across many versions (incl. 7+ version info and 32)
    for len in [
        20, 60, 100, 150, 200, 260, 300, 360, 420, 500, 640, 800, 1000, 1300, 1600, 2000,
    ] {
        let s: String = (0..len)
            .map(|i| {
                b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
                    [(i * 7 + len) % 64] as char
            })
            .collect();
        texts.push(format!("KW1:a1b2c3:1:9:{s}"));
    }
    let mut out = Vec::new();
    for t in &texts {
        for (name, ec) in [
            ("L", EcLevel::L),
            ("M", EcLevel::M),
            ("Q", EcLevel::Q),
            ("H", EcLevel::H),
        ] {
            if t.len() > 1200 && name != "L" && name != "M" {
                continue;
            }
            let (v, rows) = encode(t.as_bytes(), ec);
            out.push(serde_json::json!({ "text": t, "ecl": name, "version": v, "rows": rows }));
        }
    }
    println!("{}", serde_json::to_string(&out).unwrap());
}
