# Release packaging — design

2026-09-30. Approved in session (GitHub Actions with a Jenkins backup; publish and deploy;
version 0.6.6 (renamed 0.6.7 on 2026-10-01, to match the fullnode it bundles); generate an Android upload key, leave Apple unsigned).

## Goal

Every Rand Wallet client downloadable from randprotocol.org through GitHub release links, each
with a SHA-256; a guide to compiling every client; and a package ready for each store.

## What is built where

| package | built by | why there |
|---|---|---|
| `.dmg` arm64 and x64, `.msi` + `-setup.exe`, Linux AppImage / `.deb` / `.rpm` / `.tar.gz` (x86_64, arm64) | `.github/workflows/release.yml` on a tag | each needs its own OS; WiX runs only on Windows |
| Chrome and Firefox zips, the source tarball | the same workflow | so the published zips are the ones a runner built from the tag |
| Android `.aab` and `.apk` | `scripts/release/build-local.sh android` | the upload key is in no CI |
| iOS | `ios/scripts/archive.sh`, once a paid team exists | only a free Personal Team is on this machine |

One set of scripts (`scripts/release/`) is what the workflow, the `Jenkinsfile` and a laptop
run, so there is one build to keep right. No Jenkins exists for Rand on DigitalOcean today; the
`Jenkinsfile` is the pipeline for when one does.

The Linux desktop app is not a new client: it is the Tauri shell over the same `ui/` the
extension uses, which had simply never been built for Linux.

## Release flow

1. Tag `v<version>`; the workflow builds and fills a **draft** release with `SHA256SUMS`.
2. `build-local.sh android`, then `checksums.sh <tag> <apk> <aab>` attaches them, downloads the
   whole release back and rewrites `SHA256SUMS` over what GitHub actually serves.
3. Publish the draft.
4. `site-release.mjs <tag>` writes the site's `src/data/release.ts` from that `SHA256SUMS`; the
   site's client pages link the files and print the sums. Deploy the site.

## The site

`release.ts` (generated) lists files; `clients.ts` says which client offers which, by name, and
a name the release lacks is not shown. Pages: a Download section on each `/clients/<slug>`,
`/clients/build` (the build guide), `/clients/privacy` (the policy the stores link).

## Not signed, and said so

No Developer ID, no Windows certificate: the `.dmg` is ad-hoc signed and the installers are
unsigned. The README and the site say what each OS shows and how to check the sum instead.

## Store readiness

`docs/store/README.md`: every listing field, the privacy forms, reviewer notes, rejection
risks. Found on the way and fixed: Play requires API 36 (was 35); the store notes disagreed
with the manifest. Found and left to the owner: Apple requires an organisation account for a
wallet; a testnet wallet belongs in TestFlight, not the App Store; the export-compliance answer.
