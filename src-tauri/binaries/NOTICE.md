# Bundled binaries

Not committed to git (100MB+ each). Run `scripts/fetch-ffmpeg.ps1` from the
repo root to download them after a fresh checkout.

`ffmpeg-x86_64-pc-windows-msvc.exe` and `ffprobe-x86_64-pc-windows-msvc.exe`
are the official LGPL Windows builds from
[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (FFmpeg project,
LGPL-licensed configuration - no GPL-only components such as libx264 are
included). See https://ffmpeg.org/legal.html for FFmpeg's licensing terms.

These are invoked as external sidecar processes (never statically linked),
which is the lightest form of LGPL compliance - no linking obligations
apply. If JCForge is ever distributed, keep this notice and a copy of the
LGPL license text alongside the binaries.
