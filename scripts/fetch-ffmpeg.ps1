# Downloads the LGPL Windows ffmpeg/ffprobe build and installs them as
# Tauri sidecars under src-tauri/binaries. Not committed to git (see
# .gitignore) - run this once after a fresh checkout, or whenever you want
# to update to the latest build.
#
# Source: https://github.com/BtbN/FFmpeg-Builds (LGPL configuration - no
# GPL-only components such as libx264; see src-tauri/binaries/NOTICE.md).

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$binDir = Join-Path $repoRoot "src-tauri\binaries"
$scratch = Join-Path $env:TEMP "jcforge-ffmpeg-fetch"

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
New-Item -ItemType Directory -Force -Path $scratch | Out-Null

Write-Output "Looking up latest BtbN/FFmpeg-Builds release..."
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest" -Headers @{ "User-Agent" = "jcforge-setup" }
$asset = $release.assets | Where-Object { $_.name -match "win64-lgpl" -and $_.name -notmatch "shared" } | Select-Object -First 1
if (-not $asset) {
    throw "Could not find a win64-lgpl release asset."
}

$zipPath = Join-Path $scratch $asset.name
Write-Output "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB)..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath

$extractDir = Join-Path $scratch "extract"
if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
Write-Output "Extracting..."
Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

$ffmpegSrc = (Get-ChildItem -Path $extractDir -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1).FullName
$ffprobeSrc = (Get-ChildItem -Path $extractDir -Recurse -Filter "ffprobe.exe" | Select-Object -First 1).FullName
if (-not $ffmpegSrc -or -not $ffprobeSrc) {
    throw "ffmpeg.exe/ffprobe.exe not found in the extracted archive."
}

Copy-Item $ffmpegSrc (Join-Path $binDir "ffmpeg-x86_64-pc-windows-msvc.exe") -Force
Copy-Item $ffprobeSrc (Join-Path $binDir "ffprobe-x86_64-pc-windows-msvc.exe") -Force

Remove-Item $scratch -Recurse -Force

Write-Output "Done - installed to $binDir"
