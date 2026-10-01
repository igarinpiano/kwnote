# kwnote installer for Windows (x64 / ARM64 / x86).
#
#   irm https://raw.githubusercontent.com/igarinpiano/kwnote/master/install.ps1 | iex
#
# Optional environment variables: KWNOTE_VERSION (e.g. v1.0.0, default latest),
# KWNOTE_INSTALL_DIR (default %LOCALAPPDATA%\Programs\kwnote), KWNOTE_REPO.
# The download is verified against the release's SHA256SUMS. The install
# directory is added to the *user* PATH if it is not there yet.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = if ($env:KWNOTE_REPO) { $env:KWNOTE_REPO } else { 'igarinpiano/kwnote' }
$version = if ($env:KWNOTE_VERSION) { $env:KWNOTE_VERSION } else { 'latest' }
$dir = if ($env:KWNOTE_INSTALL_DIR) { $env:KWNOTE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\kwnote' }

$cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
switch ($cpu) {
  'AMD64' { $target = 'x86_64-pc-windows-msvc' }
  'ARM64' { $target = 'aarch64-pc-windows-msvc' }
  'x86'   { $target = 'i686-pc-windows-msvc' }
  default { throw "kwnote-install: unsupported CPU architecture: $cpu" }
}
$asset = "kwnote-$target.exe"
$base = if ($version -eq 'latest') { "https://github.com/$repo/releases/latest/download" } else { "https://github.com/$repo/releases/download/$version" }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("kwnote-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "kwnote-install: platform $target"
  Write-Host "kwnote-install: downloading $base/$asset"
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile (Join-Path $tmp 'kwnote.exe')
  Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile (Join-Path $tmp 'SHA256SUMS')

  $expected = $null
  foreach ($line in Get-Content (Join-Path $tmp 'SHA256SUMS')) {
    $parts = $line -split '\s+'
    if ($parts.Length -ge 2 -and $parts[1].TrimStart('*') -eq $asset) { $expected = $parts[0].ToLower() }
  }
  if (-not $expected) { throw "kwnote-install: SHA256SUMS has no entry for $asset" }
  $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp 'kwnote.exe')).Hash.ToLower()
  if ($actual -ne $expected) { throw "kwnote-install: checksum mismatch for $asset (expected $expected, got $actual)" }
  Write-Host 'kwnote-install: checksum ok'

  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Move-Item -Force (Join-Path $tmp 'kwnote.exe') (Join-Path $dir 'kwnote.exe')
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $dir)) {
  [Environment]::SetEnvironmentVariable('Path', ($(if ($userPath) { "$userPath;" } else { '' }) + $dir), 'User')
  $env:Path = "$env:Path;$dir"
  Write-Host "kwnote-install: added $dir to your user PATH (open a new terminal to pick it up)"
}
$ver = & (Join-Path $dir 'kwnote.exe') --version
Write-Host "kwnote-install: installed $ver to $dir\kwnote.exe"
Write-Host 'kwnote-install: update later with: kwnote update'
