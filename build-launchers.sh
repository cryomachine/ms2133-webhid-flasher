#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
npm run check:source
npm run build
python3 scripts/check-source-only.py --include-dist
mkdir -p release
for target in darwin-arm64 darwin-amd64 windows-amd64 linux-amd64 linux-arm64; do
  platform="${target%-*}"
  arch="${target#*-}"
  extension=""
  if [ "$platform" = windows ]; then extension=".exe"; fi
  CGO_ENABLED=0 GOOS="$platform" GOARCH="$arch" go build -trimpath -ldflags="-s -w" -o "release/ms2133-flasher-$target$extension" .
done
for arch in arm64 amd64; do
  app="release/MS2133 Flasher macOS-$arch.app"
  mkdir -p "$app/Contents/MacOS"
  cp "release/ms2133-flasher-darwin-$arch" "$app/Contents/MacOS/ms2133-flasher"
  cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>ms2133-flasher</string>
<key>CFBundleIdentifier</key><string>local.ms2133.flasher</string>
<key>CFBundleName</key><string>MS2133 Flasher</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.2.4</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
done
