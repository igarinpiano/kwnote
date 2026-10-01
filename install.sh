#!/bin/sh
# kwnote installer for macOS / Linux / BSD / illumos / Android (Termux).
#
#   curl -fsSL https://raw.githubusercontent.com/igarinpiano/kwnote/master/install.sh | sh
#
# Environment variables (all optional):
#   KWNOTE_VERSION      release tag to install, e.g. v1.0.0   (default: latest)
#   KWNOTE_INSTALL_DIR  where to put the binary   (default: ~/.local/bin, or $PREFIX/bin on Termux)
#   KWNOTE_TARGET       override the detected Rust target triple
#   KWNOTE_REPO         GitHub repository           (default: igarinpiano/kwnote)
#
# The download is verified against the release's SHA256SUMS before install.
set -eu

REPO="${KWNOTE_REPO:-igarinpiano/kwnote}"
VERSION="${KWNOTE_VERSION:-latest}"

say() { printf '%s\n' "kwnote-install: $*" >&2; }
die() { say "error: $*"; exit 1; }

# ---------------------------------------------------------------- detect
detect_target() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$arch" in
    x86_64 | amd64) arch=x86_64 ;;
    aarch64 | arm64) arch=aarch64 ;;
    armv7* | armv8l) arch=armv7 ;;
    armv6* | arm) arch=arm ;;
    i386 | i486 | i586 | i686 | x86) arch=i686 ;;
    riscv64) arch=riscv64gc ;;
    ppc64le | powerpc64le) arch=powerpc64le ;;
    s390x) arch=s390x ;;
    loongarch64) arch=loongarch64 ;;
    *) die "unsupported CPU architecture: $arch" ;;
  esac

  case "$os" in
    Darwin)
      # a shell running under Rosetta reports x86_64 on Apple silicon
      if [ "$arch" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
        arch=aarch64
      fi
      case "$arch" in
        x86_64 | aarch64) echo "$arch-apple-darwin" ;;
        *) die "unsupported macOS architecture: $arch" ;;
      esac
      ;;
    Linux)
      if [ "$(uname -o 2>/dev/null || true)" = Android ]; then
        case "$arch" in
          aarch64 | x86_64) echo "$arch-linux-android" ;;
          armv7 | arm) echo "armv7-linux-androideabi" ;;
          *) die "unsupported Android architecture: $arch" ;;
        esac
        return
      fi
      # statically linked musl builds run on any distro (glibc or not)
      case "$arch" in
        x86_64 | aarch64 | i686) echo "$arch-unknown-linux-musl" ;;
        armv7) echo "armv7-unknown-linux-musleabihf" ;;
        arm) echo "arm-unknown-linux-musleabihf" ;;
        *) echo "$arch-unknown-linux-gnu" ;;
      esac
      ;;
    FreeBSD) [ "$arch" = x86_64 ] && echo "x86_64-unknown-freebsd" || die "unsupported FreeBSD architecture: $arch" ;;
    NetBSD) [ "$arch" = x86_64 ] && echo "x86_64-unknown-netbsd" || die "unsupported NetBSD architecture: $arch" ;;
    SunOS) [ "$arch" = x86_64 ] && echo "x86_64-unknown-illumos" || die "unsupported illumos architecture: $arch" ;;
    MINGW* | MSYS* | CYGWIN*) die "on Windows use PowerShell: irm https://raw.githubusercontent.com/$REPO/master/install.ps1 | iex" ;;
    *) die "unsupported OS: $os (build from source: cargo install --git https://github.com/$REPO.git kwnote)" ;;
  esac
}

# ---------------------------------------------------------------- helpers
download() { # url dest
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  elif command -v fetch >/dev/null 2>&1; then
    fetch -q -o "$2" "$1"
  else
    die "need curl, wget or fetch"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v sha256 >/dev/null 2>&1; then sha256 -q "$1"
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed 's/.*= *//'
  else echo ""
  fi
}

default_dir() {
  if [ -n "${PREFIX:-}" ] && [ -d "${PREFIX}/bin" ] && [ "$(uname -o 2>/dev/null || true)" = Android ]; then
    echo "$PREFIX/bin"
  else
    echo "$HOME/.local/bin"
  fi
}

# ---------------------------------------------------------------- main
if [ -n "${KWNOTE_TARGET:-}" ]; then target=$KWNOTE_TARGET; else target=$(detect_target) || exit 1; fi
asset="kwnote-$target"
case "$target" in *windows*) asset="$asset.exe" ;; esac
if [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi
dir="${KWNOTE_INSTALL_DIR:-$(default_dir)}"

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t kwnote)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "platform: $target"
say "downloading $base/$asset"
download "$base/$asset" "$tmp/kwnote" || die "no prebuilt binary for $target in $VERSION release
  build from source instead: cargo install --git https://github.com/$REPO.git kwnote"
download "$base/SHA256SUMS" "$tmp/SHA256SUMS" || die "could not download SHA256SUMS"

expected=$(awk -v f="$asset" '$2 == f || $2 == "*"f { print $1 }' "$tmp/SHA256SUMS")
actual=$(sha256_of "$tmp/kwnote")
[ -n "$expected" ] || die "SHA256SUMS has no entry for $asset"
if [ -z "$actual" ]; then
  say "warning: no sha256 tool found; skipping checksum verification"
elif [ "$expected" != "$actual" ]; then
  die "checksum mismatch for $asset (expected $expected, got $actual)"
else
  say "checksum ok"
fi

chmod +x "$tmp/kwnote"
mkdir -p "$dir" 2>/dev/null || true
if [ -w "$dir" ]; then
  mv -f "$tmp/kwnote" "$dir/kwnote"
else
  die "$dir is not writable; rerun with KWNOTE_INSTALL_DIR=<dir> or with sudo:
  curl -fsSL https://raw.githubusercontent.com/$REPO/master/install.sh | sudo KWNOTE_INSTALL_DIR=/usr/local/bin sh"
fi

say "installed $("$dir/kwnote" --version 2>/dev/null || echo kwnote) to $dir/kwnote"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) say "note: $dir is not on your PATH. Add this to your shell profile:
  export PATH=\"$dir:\$PATH\"" ;;
esac
say "update later with: kwnote update"
