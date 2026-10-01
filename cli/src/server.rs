//! `kwnote serve`: a LAN server that hosts the web app (embedded at build
//! time) and a tiny sync API, so phones/PCs on the same network can open the
//! app and merge their data with this machine's data file.
//!
//!   GET  /api/info   -> {"app":"kwnote","version":..,"auth":bool}   (no key)
//!   GET  /api/data   -> full document                              (key)
//!   POST /api/sync   <- client document, -> merged document          (key)
//!
//! The key is sent as `X-Kwnote-Key` (or `?key=`). The printed URL carries it
//! in the fragment (`#key=...`), which the web app stores and strips.

use std::io::Read;
use std::net::{IpAddr, UdpSocket};

use anyhow::{Result, anyhow};
use tiny_http::{Header, Method, Request, Response, Server};

use crate::codec::QrBlock;
use crate::model::Doc;
use crate::store;

const MAX_BODY: u64 = 32 * 1024 * 1024;

struct Asset {
    path: &'static str,
    mime: &'static str,
    body: &'static str,
}

const ASSETS: &[Asset] = &[
    Asset {
        path: "/index.htm",
        mime: "text/html; charset=utf-8",
        body: include_str!("../../index.htm"),
    },
    Asset {
        path: "/script.js",
        mime: "text/javascript; charset=utf-8",
        body: include_str!("../../script.js"),
    },
    Asset {
        path: "/sync.js",
        mime: "text/javascript; charset=utf-8",
        body: include_str!("../../sync.js"),
    },
    Asset {
        path: "/qr.js",
        mime: "text/javascript; charset=utf-8",
        body: include_str!("../../qr.js"),
    },
    Asset {
        path: "/style.css",
        mime: "text/css; charset=utf-8",
        body: include_str!("../../style.css"),
    },
    Asset {
        path: "/sw.js",
        mime: "text/javascript; charset=utf-8",
        body: include_str!("../../sw.js"),
    },
    Asset {
        path: "/manifest.webmanifest",
        mime: "application/manifest+json",
        body: include_str!("../../manifest.webmanifest"),
    },
    Asset {
        path: "/icon.svg",
        mime: "image/svg+xml",
        body: include_str!("../../icon.svg"),
    },
];

/// Best-effort LAN address: "connect" a UDP socket (no packet is sent) and
/// read which local interface the OS would route through.
pub fn lan_ip() -> Option<IpAddr> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("192.168.0.1:9")
        .or_else(|_| sock.connect("10.0.0.1:9"))
        .ok()?;
    let ip = sock.local_addr().ok()?.ip();
    (!ip.is_unspecified() && !ip.is_loopback()).then_some(ip)
}

fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).expect("valid header")
}

fn cors<R: Read>(mut r: Response<R>) -> Response<R> {
    for (k, v) in [
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
        ("Access-Control-Allow-Headers", "Content-Type, X-Kwnote-Key"),
        ("Access-Control-Allow-Private-Network", "true"),
        ("Cache-Control", "no-cache"),
    ] {
        r.add_header(header(k, v));
    }
    r
}

fn json(status: u16, body: String) -> Response<std::io::Cursor<Vec<u8>>> {
    cors(Response::from_string(body).with_status_code(status))
        .with_header(header("Content-Type", "application/json; charset=utf-8"))
}

fn error(status: u16, msg: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    json(status, serde_json::json!({ "error": msg }).to_string())
}

fn query_param<'a>(url: &'a str, name: &str) -> Option<&'a str> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == name).then_some(v)
    })
}

fn authorized(req: &Request, key: Option<&str>) -> bool {
    let Some(key) = key else { return true };
    let from_header = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("X-Kwnote-Key"))
        .map(|h| h.value.as_str().to_string());
    let given = from_header.or_else(|| query_param(req.url(), "key").map(str::to_string));
    given.as_deref() == Some(key)
}

fn handle(mut req: Request, key: Option<&str>) -> Result<()> {
    let method = req.method().clone();
    let path = req
        .url()
        .split(['?', '#'])
        .next()
        .unwrap_or("/")
        .to_string();

    if method == Method::Options {
        return Ok(req.respond(cors(Response::empty(204)))?);
    }

    let resp = match (method, path.as_str()) {
        (Method::Get, "/api/info") => json(
            200,
            serde_json::json!({
                "app": "kwnote",
                "version": env!("CARGO_PKG_VERSION"),
                "auth": key.is_some(),
            })
            .to_string(),
        ),
        (_, p) if p.starts_with("/api/") && !authorized(&req, key) => {
            error(401, "bad or missing key")
        }
        (Method::Get, "/api/data") => json(200, serde_json::to_string(&store::load()?)?),
        (Method::Post, "/api/sync") => {
            let mut body = String::new();
            req.as_reader().take(MAX_BODY).read_to_string(&mut body)?;
            match serde_json::from_str::<Doc>(&body) {
                Ok(client) => {
                    let merged = store::commit(&client)?;
                    eprintln!(
                        "  synced with {} ({} items, {} sentences)",
                        req.remote_addr()
                            .map(|a| a.ip().to_string())
                            .unwrap_or_default(),
                        merged.items.iter().filter(|i| !i.deleted).count(),
                        merged.sentences.iter().filter(|i| !i.deleted).count()
                    );
                    json(200, serde_json::to_string(&merged)?)
                }
                Err(e) => error(400, &format!("invalid document: {e}")),
            }
        }
        (Method::Get, p) => {
            let p = if p == "/" { "/index.htm" } else { p };
            match ASSETS.iter().find(|a| a.path == p) {
                Some(a) => {
                    cors(Response::from_string(a.body)).with_header(header("Content-Type", a.mime))
                }
                None => error(404, "not found"),
            }
        }
        _ => error(405, "method not allowed"),
    };
    Ok(req.respond(resp)?)
}

pub fn serve(bind: &str, port: u16, auth: bool, regen_key: bool, show_qr: bool) -> Result<()> {
    let key = if auth {
        Some(store::server_key(regen_key)?)
    } else {
        None
    };
    let server =
        Server::http((bind, port)).map_err(|e| anyhow!("cannot listen on {bind}:{port}: {e}"))?;

    let frag = key
        .as_ref()
        .map(|k| format!("#key={k}"))
        .unwrap_or_default();
    let host = lan_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|| "localhost".into());
    let url = format!("http://{host}:{port}/{frag}");

    println!("kwnote sync server");
    println!("  data : {}", store::data_path().display());
    println!("  local: http://localhost:{port}/{frag}");
    println!("  LAN  : {url}");
    if show_qr {
        println!("\nScan with your phone camera to open the app (same Wi-Fi):\n");
        print!("{}", QrBlock::new(&url)?.ansi());
    }
    if let Some(k) = &key {
        println!("\nOther CLIs:  kwnote sync http://{host}:{port} --key {k}");
    }
    println!("Ctrl-C to stop.\n");

    for req in server.incoming_requests() {
        if let Err(e) = handle(req, key.as_deref()) {
            eprintln!("  request failed: {e:#}");
        }
    }
    Ok(())
}
