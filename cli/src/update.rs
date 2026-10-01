//! `kwnote update`: replace this executable with the latest GitHub release.
//!
//! Release assets (built by .github/workflows/release.yml):
//!   kwnote-<target-triple>[.exe]   raw executable
//!   SHA256SUMS                     "<sha256>  <asset name>" per line
//! The download is verified against SHA256SUMS before it replaces anything.

use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use sha2::{Digest, Sha256};

pub const DEFAULT_REPO: &str = "igarinpiano/kwnote";
pub const TARGET: &str = env!("KWNOTE_TARGET");
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_BINARY: u64 = 200 * 1024 * 1024;

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

fn repo() -> String {
    std::env::var("KWNOTE_UPDATE_REPO").unwrap_or_else(|_| DEFAULT_REPO.to_string())
}

pub fn asset_name(target: &str) -> String {
    let exe = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    format!("kwnote-{target}{exe}")
}

/// "v1.2.3", "1.2.3", "1.2.3-rc.1" -> (1, 2, 3). Pre-release suffixes are
/// ignored for ordering.
pub fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let core = s.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let mut it = core.split('.').map(|p| p.parse::<u64>().ok());
    let v = (
        it.next()??,
        it.next().flatten().unwrap_or(0),
        it.next().flatten().unwrap_or(0),
    );
    Some(v)
}

/// Finds the checksum for `name` in a SHA256SUMS file (`<hex>  [*]<name>`).
pub fn checksum_for(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let file = parts.next()?.trim_start_matches('*');
        (file == name && hash.len() == 64).then(|| hash.to_ascii_lowercase())
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(120)))
        .user_agent(format!("kwnote/{VERSION}"))
        .build()
        .into()
}

fn get(agent: &ureq::Agent, url: &str, accept: &str) -> Result<ureq::http::Response<ureq::Body>> {
    let mut req = agent.get(url).header("Accept", accept);
    if let Ok(tok) = std::env::var("GITHUB_TOKEN")
        && !tok.is_empty()
        && url.starts_with("https://api.github.com/")
    {
        req = req.header("Authorization", &format!("Bearer {tok}"));
    }
    req.call().with_context(|| format!("GET {url}"))
}

fn fetch_release(agent: &ureq::Agent, tag: Option<&str>) -> Result<Release> {
    let repo = repo();
    let url = match tag {
        Some(t) => format!("https://api.github.com/repos/{repo}/releases/tags/{t}"),
        None => format!("https://api.github.com/repos/{repo}/releases/latest"),
    };
    let body = get(agent, &url, "application/vnd.github+json")
        .map_err(|e| {
            anyhow!(
                "{e:#}\n(no release found for {repo}{})",
                tag.map(|t| format!(" {t}")).unwrap_or_default()
            )
        })?
        .body_mut()
        .read_to_string()?;
    serde_json::from_str(&body).context("unexpected GitHub API response")
}

pub fn run(check_only: bool, force: bool, tag: Option<&str>) -> Result<()> {
    let agent = agent();
    let release = fetch_release(&agent, tag)?;
    let current = parse_version(VERSION).expect("crate version is semver");
    let latest = parse_version(&release.tag_name)
        .ok_or_else(|| anyhow!("release tag {:?} is not a version", release.tag_name))?;

    if latest <= current && !force && tag.is_none() {
        println!(
            "kwnote {VERSION} is up to date (latest release: {})",
            release.tag_name
        );
        return Ok(());
    }
    if check_only {
        if latest > current {
            println!(
                "update available: {VERSION} -> {}  ({})",
                release.tag_name, release.html_url
            );
            println!("run `kwnote update` to install it");
        } else {
            println!("kwnote {VERSION}; requested release {}", release.tag_name);
        }
        return Ok(());
    }

    let name = asset_name(TARGET);
    let asset = release.assets.iter().find(|a| a.name == name).ok_or_else(|| {
        anyhow!(
            "release {} has no prebuilt binary for {TARGET}.\n\
             build from source instead: cargo install --git https://github.com/{}.git --tag {} kwnote",
            release.tag_name,
            repo(),
            release.tag_name
        )
    })?;
    let sums_asset = release
        .assets
        .iter()
        .find(|a| a.name == "SHA256SUMS")
        .ok_or_else(|| {
            anyhow!(
                "release {} has no SHA256SUMS; refusing to install",
                release.tag_name
            )
        })?;

    let sums = get(
        &agent,
        &sums_asset.browser_download_url,
        "application/octet-stream",
    )?
    .body_mut()
    .read_to_string()?;
    let expected =
        checksum_for(&sums, &name).ok_or_else(|| anyhow!("SHA256SUMS has no entry for {name}"))?;

    eprintln!("downloading {name} ({})…", release.tag_name);
    let bytes = get(
        &agent,
        &asset.browser_download_url,
        "application/octet-stream",
    )?
    .body_mut()
    .with_config()
    .limit(MAX_BINARY)
    .read_to_vec()?;
    let actual = hex(&Sha256::digest(&bytes));
    if actual != expected {
        bail!("checksum mismatch for {name}: expected {expected}, got {actual}");
    }

    let tmp = std::env::temp_dir().join(format!("{name}.{}.new", std::process::id()));
    std::fs::write(&tmp, &bytes).with_context(|| format!("write {}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    }
    let exe = std::env::current_exe().context("locate current executable")?;
    let res = self_replace::self_replace(&tmp).with_context(|| {
        format!(
            "replace {} (try again with permission to write there, e.g. sudo)",
            exe.display()
        )
    });
    let _ = std::fs::remove_file(&tmp);
    res?;
    println!(
        "kwnote updated: {VERSION} -> {}  ({})",
        release.tag_name,
        exe.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert_eq!(parse_version("v1.0.0"), Some((1, 0, 0)));
        assert_eq!(parse_version("1.2"), Some((1, 2, 0)));
        assert_eq!(parse_version("v2.3.4-rc.1"), Some((2, 3, 4)));
        assert_eq!(parse_version("latest"), None);
        assert!(parse_version("v1.10.0") > parse_version("v1.9.9"));
        assert!(parse_version(VERSION).is_some());
    }

    #[test]
    fn checksums() {
        let h = "a".repeat(64);
        let sums = format!(
            "{h}  kwnote-x86_64-unknown-linux-gnu\n{}  *kwnote-x86_64-pc-windows-msvc.exe\n",
            "B".repeat(64)
        );
        assert_eq!(
            checksum_for(&sums, "kwnote-x86_64-unknown-linux-gnu"),
            Some(h)
        );
        assert_eq!(
            checksum_for(&sums, "kwnote-x86_64-pc-windows-msvc.exe"),
            Some("b".repeat(64))
        );
        assert_eq!(checksum_for(&sums, "kwnote-aarch64-apple-darwin"), None);
    }

    #[test]
    fn asset_names() {
        assert_eq!(
            asset_name("aarch64-apple-darwin"),
            "kwnote-aarch64-apple-darwin"
        );
        assert_eq!(
            asset_name("x86_64-pc-windows-msvc"),
            "kwnote-x86_64-pc-windows-msvc.exe"
        );
        assert!(asset_name(TARGET).starts_with("kwnote-"));
    }
}
