// The release build for a Jenkins, as a backup to .github/workflows/release.yml: the same
// scripts, in the same order, on Jenkins agents instead of GitHub's runners.
//
// It needs one agent per OS it should build for, labelled:
//
//   linux     Ubuntu 22.04+ (x86_64 or arm64) with: rustup, Node 20+, git, and
//             libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf rpm file
//   macos     macOS on Apple silicon with Xcode Command Line Tools, rustup, Node 20+
//   windows   Windows 10+ with rustup (MSVC toolchain + Build Tools), Node 20+, Git for Windows
//
// A stage whose label has no agent waits in the queue; pass only the platforms you have in
// PLATFORMS. A Linux-only Jenkins (one droplet) builds the Linux packages, both extension zips
// and the source tarball, which is everything except the .dmg and the .msi.
//
// It never publishes. The packages are archived on the build; to attach them to a GitHub release
// run scripts/release/checksums.sh <tag> <files…> from a machine that is signed in to `gh`.
pipeline {
  agent none

  parameters {
    string(name: 'PLATFORMS', defaultValue: 'linux macos windows',
           description: 'Which agents to build on, space separated: linux macos windows')
  }

  options {
    timestamps()
    timeout(time: 3, unit: 'HOURS')
    buildDiscarder(logRotator(numToKeepStr: '10'))
    disableConcurrentBuilds()
  }

  environment {
    RUST_TOOLCHAIN = '1.98.1'
    TAURI_CLI_VERSION = '2.11.5'
    CARGO_TERM_COLOR = 'never'
  }

  stages {
    stage('Build') {
      parallel {
        stage('Linux: desktop, extensions, source') {
          when { expression { params.PLATFORMS.split().contains('linux') } }
          agent { label 'linux' }
          steps {
            checkout scm
            sh '''#!/usr/bin/env bash
              set -euo pipefail
              git submodule update --init --recursive
              rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal --target wasm32-unknown-unknown
              cargo tauri --version 2>/dev/null | grep -q "$TAURI_CLI_VERSION" \
                || cargo install tauri-cli --version "$TAURI_CLI_VERSION" --locked

              core/scripts/build-wasm.sh
              npm ci --prefix ui
              node --test --test-reporter=tap "ui/test/**/*.test.mjs" > ui-test.tap || { grep -B2 -A30 '^not ok' ui-test.tap | head -200; exit 1; }
              chrome/pack.sh
              firefox/pack.sh
              VER=$(node -p "require('./chrome/manifest.json').version")
              mkdir -p "dist/release/v$VER"
              cp "dist/rand-wallet-chrome-$VER.zip" "dist/rand-wallet-firefox-$VER.zip" "dist/release/v$VER/"
              scripts/release/source-tarball.sh "dist/release/v$VER/rand-wallet-$VER-source.tar.gz"

              ( cd desktop/src-tauri && node ../scripts/stage-ui.mjs && cargo test --locked )
              scripts/release/build-desktop.sh
            '''
          }
          post {
            success { archiveArtifacts artifacts: 'dist/release/*/rand-wallet-*', fingerprint: true }
          }
        }

        stage('macOS: dmg (arm64, x64)') {
          when { expression { params.PLATFORMS.split().contains('macos') } }
          agent { label 'macos' }
          steps {
            checkout scm
            sh '''#!/usr/bin/env bash
              set -euo pipefail
              git submodule update --init --recursive
              rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal
              cargo tauri --version 2>/dev/null | grep -q "$TAURI_CLI_VERSION" \
                || cargo install tauri-cli --version "$TAURI_CLI_VERSION" --locked
              ( cd desktop/src-tauri && node ../scripts/stage-ui.mjs && cargo test --locked )
              scripts/release/build-desktop.sh
              scripts/release/build-desktop.sh --target x86_64-apple-darwin
            '''
          }
          post {
            success { archiveArtifacts artifacts: 'dist/release/*/rand-wallet-*', fingerprint: true }
          }
        }

        stage('Windows: msi, setup.exe') {
          when { expression { params.PLATFORMS.split().contains('windows') } }
          agent { label 'windows' }
          steps {
            checkout scm
            // Git for Windows' bash: the release scripts are bash, and it is already on the agent.
            bat '''
              git submodule update --init --recursive || exit /b 1
              rustup toolchain install %RUST_TOOLCHAIN% --profile minimal || exit /b 1
              cargo tauri --version 2>NUL | findstr /C:"%TAURI_CLI_VERSION%" >NUL || cargo install tauri-cli --version %TAURI_CLI_VERSION% --locked || exit /b 1
              "C:\\Program Files\\Git\\bin\\bash.exe" -lc "cd desktop/src-tauri && node ../scripts/stage-ui.mjs && cargo test --locked" || exit /b 1
              "C:\\Program Files\\Git\\bin\\bash.exe" -lc "scripts/release/build-desktop.sh" || exit /b 1
            '''
          }
          post {
            success { archiveArtifacts artifacts: 'dist/release/*/rand-wallet-*', fingerprint: true }
          }
        }
      }
    }
  }
}
