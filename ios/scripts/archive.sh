#!/usr/bin/env bash
# Archive Rand Wallet for TestFlight / the App Store and upload it to App Store Connect.
#   DEVELOPMENT_TEAM=ABCDE12345 ios/scripts/archive.sh
# Needs: the XCFramework (core/scripts/build-ios.sh), an Apple Developer account whose team id is
# given here or in project.yml, and an App Store Connect record for org.randprotocol.wallet.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DEVELOPMENT_TEAM:?set DEVELOPMENT_TEAM to your Apple Developer team id}"
BUILD_NUMBER="${BUILD_NUMBER:-$(date +%Y%m%d%H%M)}"
ARCHIVE=build/RandWallet.xcarchive
[ -d Frameworks/RandWalletCore.xcframework ] || ../core/scripts/build-ios.sh
xcodebuild -project RandWallet.xcodeproj -scheme RandWallet -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  -allowProvisioningUpdates archive
# ExportOptions.plist has destination=upload, so this exports and uploads in one step.
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist ExportOptions.plist \
  -exportPath build/export -allowProvisioningUpdates
echo "archived and uploaded build $BUILD_NUMBER"
