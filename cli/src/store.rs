//! On-disk storage: one JSON file holding the same document the web app
//! exports, plus a small config file (remote server, server key).
//!
//! Every write goes through `commit`, which re-reads the file and merges
//! before writing, so the TUI and `kwnote serve` can run at the same time.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::model::{Doc, merge_docs};

static DATA_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

pub fn set_data_path(p: PathBuf) {
    let _ = DATA_OVERRIDE.set(p);
}

pub fn home_dir() -> PathBuf {
    if let Ok(p) = std::env::var("KWNOTE_HOME") {
        return PathBuf::from(p);
    }
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("kwnote")
}

pub fn data_path() -> PathBuf {
    if let Some(p) = DATA_OVERRIDE.get() {
        return p.clone();
    }
    if let Ok(p) = std::env::var("KWNOTE_DATA") {
        return PathBuf::from(p);
    }
    home_dir().join("data.json")
}

fn config_path() -> PathBuf {
    home_dir().join("config.json")
}

pub fn load() -> Result<Doc> {
    load_from(&data_path())
}

pub fn load_from(path: &Path) -> Result<Doc> {
    match fs::read_to_string(path) {
        Ok(s) if s.trim().is_empty() => Ok(Doc::default()),
        Ok(s) => serde_json::from_str(&s).with_context(|| format!("parse {}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Doc::default()),
        Err(e) => Err(e).with_context(|| format!("read {}", path.display())),
    }
}

pub fn mtime() -> Option<SystemTime> {
    fs::metadata(data_path()).and_then(|m| m.modified()).ok()
}

fn write_atomic(path: &Path, contents: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, contents).with_context(|| format!("write {}", tmp.display()))?;
    fs::rename(&tmp, path).with_context(|| format!("rename to {}", path.display()))?;
    Ok(())
}

/// Overwrite the data file with `doc` as-is (used by `import --replace`).
pub fn replace(doc: &Doc) -> Result<()> {
    write_atomic(&data_path(), &serde_json::to_string_pretty(doc)?)
}

/// Merge `doc` into whatever is on disk, write, and return the result.
pub fn commit(doc: &Doc) -> Result<Doc> {
    let disk = load()?;
    let merged = merge_docs(doc, &disk);
    replace(&merged)?;
    Ok(merged)
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub url: String,
    #[serde(default)]
    pub key: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default)]
    pub remote: Option<Remote>,
    #[serde(default)]
    pub server_key: Option<String>,
}

pub fn load_config() -> Config {
    fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_config(c: &Config) -> Result<()> {
    write_atomic(&config_path(), &serde_json::to_string_pretty(c)?)
}

pub fn random_key() -> String {
    let mut buf = [0u8; 12];
    getrandom::fill(&mut buf).expect("OS random source");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// The pairing key for `kwnote serve`, created on first use.
pub fn server_key(regenerate: bool) -> Result<String> {
    let mut c = load_config();
    match &c.server_key {
        Some(k) if !regenerate && !k.is_empty() => Ok(k.clone()),
        _ => {
            let k = random_key();
            c.server_key = Some(k.clone());
            save_config(&c)?;
            Ok(k)
        }
    }
}
