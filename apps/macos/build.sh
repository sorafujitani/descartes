#!/bin/sh
set -eu
cd "$(dirname "$0")"
swift build -c release
app=dist/Descartes.app
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$(swift build -c release --show-bin-path)/Descartes" "$app/Contents/MacOS/"
cp Info.plist "$app/Contents/"
icons=.build/Descartes.iconset
mkdir -p "$icons"
for n in 16 32 128 256 512; do
  sips -z "$n" "$n" ../web/public/icon-512.png --out "$icons/icon_${n}x${n}.png" >/dev/null
  double=$((n*2))
  sips -z "$double" "$double" ../web/public/icon-512.png --out "$icons/icon_${n}x${n}@2x.png" >/dev/null
done
iconutil -c icns "$icons" -o "$app/Contents/Resources/Descartes.icns"
codesign --force --sign - "$app"
printf 'Built %s/%s\n' "$PWD" "$app"
