# Builds whisper.cpp from source (CPU-only, statically linked) and
# downloads the base.en ggml model. whisper.cpp publishes no prebuilt
# Windows binaries, so this is a real build - it needs CMake and the
# MSVC toolchain (Visual Studio Build Tools, "Desktop development with
# C++") already on the machine.
#
# Not committed to git - run once after a fresh checkout, or to update.
# Source: https://github.com/ggml-org/whisper.cpp (MIT licensed).
# Model: https://huggingface.co/ggerganov/whisper.cpp (MIT licensed
# ggml conversion of OpenAI's MIT-licensed Whisper weights).

$ErrorActionPreference = "Stop"

if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
    throw "CMake not found. Install it first, e.g.: winget install --id Kitware.CMake -e"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$binDir = Join-Path $repoRoot "src-tauri\binaries"
$modelsDir = Join-Path $repoRoot "src-tauri\models"
# Building under a plain local directory, not %TEMP% - MSBuild's
# incremental-build tracking breaks when the intermediate/output dirs
# live under the Temporary directory.
$buildRoot = "C:\jcforge-whisper-build"

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null

if (Test-Path $buildRoot) { Remove-Item $buildRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null

Write-Output "Cloning whisper.cpp..."
Set-Location $buildRoot
git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git
Set-Location "whisper.cpp"

Write-Output "Configuring (CPU-only, static libs)..."
cmake -B build -A x64 -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON

Write-Output "Building (this takes a few minutes)..."
cmake --build build --config Release -j

$exe = Get-ChildItem -Path "build" -Recurse -Filter "whisper-cli.exe" | Select-Object -First 1
if (-not $exe) { throw "whisper-cli.exe not found after build." }
Copy-Item $exe.FullName (Join-Path $binDir "whisper-cli-x86_64-pc-windows-msvc.exe") -Force

Write-Output "Downloading base.en model (~141 MB)..."
$ProgressPreference = "SilentlyContinue"
Invoke-WebRequest -Uri "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" `
    -OutFile (Join-Path $modelsDir "ggml-base.en.bin") -UseBasicParsing

Set-Location $repoRoot
Remove-Item $buildRoot -Recurse -Force

Write-Output "Done - whisper-cli and the model are installed."
