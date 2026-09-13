# Build rand-wallet.exe and a zip into dist\. Run from a Developer PowerShell with Rust installed
# (rustup default stable-x86_64-pc-windows-msvc; the toolchain file pins 1.98.1).
#   powershell -ExecutionPolicy Bypass -File desktop\scripts\build-windows.ps1
# An MSI can be produced afterwards with cargo-wix: cargo install cargo-wix; cargo wix --nocapture
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$version = (Select-String -Path Cargo.toml -Pattern '^version = "(.*)"' | Select-Object -First 1).Matches.Groups[1].Value
cargo build --release
New-Item -ItemType Directory -Force -Path dist | Out-Null
$stage = "dist\rand-wallet-$version-windows-x64"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item target\release\rand-wallet.exe $stage\
Copy-Item assets\icon.png $stage\
Compress-Archive -Path "$stage\*" -DestinationPath "$stage.zip" -Force
Write-Host "wrote $stage.zip"
