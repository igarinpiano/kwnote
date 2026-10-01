//! `kwnote sync`: push the local document to another machine's
//! `kwnote serve` and store the merged result locally.

use std::time::Duration;

use anyhow::{Context, Result, bail};

use crate::model::Doc;
use crate::store::{self, Remote};

pub fn normalize_url(url: &str) -> String {
    let url = url.trim().trim_end_matches('/');
    let url = url.split('#').next().unwrap_or(url);
    if url.starts_with("http://") || url.starts_with("https://") {
        url.to_string()
    } else {
        format!("http://{url}")
    }
}

/// Parses `http://host:port/#key=abc` style URLs (what `serve` prints).
pub fn split_key(url: &str) -> (String, Option<String>) {
    match url.split_once("#key=") {
        Some((u, k)) => (normalize_url(u), Some(k.to_string())),
        None => (normalize_url(url), None),
    }
}

pub fn sync(local: &Doc, remote: &Remote) -> Result<Doc> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
        .http_status_as_error(false)
        .build()
        .into();
    let url = format!("{}/api/sync", normalize_url(&remote.url));
    let mut resp = agent
        .post(&url)
        .header("Content-Type", "application/json")
        .header("X-Kwnote-Key", &remote.key)
        .send(serde_json::to_string(local)?)
        .with_context(|| format!("connect to {url}"))?;
    let status = resp.status().as_u16();
    let body = resp
        .body_mut()
        .with_config()
        .limit(64 * 1024 * 1024)
        .read_to_string()?;
    match status {
        200 => {}
        401 => bail!("server rejected the key (run `kwnote sync <url> --key <key>`)"),
        s => bail!("server returned HTTP {s}: {body}"),
    }
    let merged: Doc = serde_json::from_str(&body).context("server reply is not kwnote data")?;
    store::commit(&merged)
}

/// Resolve which remote to use (args override the saved one) and remember it.
pub fn resolve_remote(url: Option<&str>, key: Option<&str>) -> Result<Remote> {
    let mut cfg = store::load_config();
    let remote = match url {
        Some(u) => {
            let (u, k) = split_key(u);
            let key = key.map(str::to_string).or(k).or_else(|| {
                cfg.remote
                    .as_ref()
                    .filter(|r| r.url == u)
                    .map(|r| r.key.clone())
            });
            Remote {
                url: u,
                key: key.unwrap_or_default(),
            }
        }
        None => match (&cfg.remote, key) {
            (Some(r), Some(k)) => Remote {
                url: r.url.clone(),
                key: k.to_string(),
            },
            (Some(r), None) => r.clone(),
            (None, _) => bail!("no remote configured: kwnote sync http://<host>:7878 --key <key>"),
        },
    };
    cfg.remote = Some(remote.clone());
    store::save_config(&cfg)?;
    Ok(remote)
}
