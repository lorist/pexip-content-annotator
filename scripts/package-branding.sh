#!/usr/bin/env bash
# Build a complete, ready-to-upload webapp3 branding ZIP for the content-annotator
# plugin. Everything is generated from dist/ + an inline manifest into a temp
# staging dir (outside the project), so no persisted webapp3/ tree is required.
#
# Output: ./content-annotator-branding.zip
#
# NOTE: this produces a STANDALONE branding containing only content-annotator.
# To keep an existing branding's other plugins/config, inject content-annotator
# into that branding instead (copy dist/ into plugins/content-annotator/ and
# merge manifest.snippet.json into its manifest.json `plugins[]`).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_ID="content-annotator"
DIST="$ROOT/dist"
OUT="$ROOT/content-annotator-branding.zip"

# 1. ensure a fresh build exists
( cd "$ROOT" && npm run build >/dev/null )
test -f "$DIST/index.html"  || { echo "ABORT: dist/index.html missing"  >&2; exit 1; }
test -f "$DIST/editor.html" || { echo "ABORT: dist/editor.html missing" >&2; exit 1; }
test -f "$DIST/assets/index.js" || { echo "ABORT: dist/assets/index.js missing" >&2; exit 1; }

# 2. stage the branding outside the project (immune to anything wiping webapp3/)
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
BRANDING="$STAGE/webapp3/branding"
mkdir -p "$BRANDING/plugins/$PLUGIN_ID"
cp -R "$DIST/." "$BRANDING/plugins/$PLUGIN_ID/"

# 3. write the manifest (full schema — matches what this Pexip version validates)
cat > "$BRANDING/manifest.json" <<JSON
{
  "version": 0,
  "meta": { "name": "DEFAULT", "brandVersion": "n/a", "baseColor": "#3c5974" },
  "brandName": "",
  "images": {},
  "translations": {},
  "applicationConfig": {},
  "defaultUserConfig": {},
  "colorPalette": [
    "#EEF2F6", "#C6D4E2", "#9DB6CD", "#7598B8", "#51799E", "#3D5A76",
    "#344D65", "#2B4054", "#233443", "#1A2732", "#111A22"
  ],
  "plugins": [
    {
      "src": "./plugins/$PLUGIN_ID/index.html",
      "id": "$PLUGIN_ID",
      "sandboxValues": [
        "allow-same-origin",
        "allow-popups",
        "allow-popups-to-escape-sandbox",
        "allow-forms",
        "allow-scripts"
      ]
    }
  ]
}
JSON

# 4. validate before zipping
python3 -c "import json;json.load(open('$BRANDING/manifest.json'))" \
  || { echo "ABORT: generated manifest is invalid JSON" >&2; exit 1; }

# 5. zip (no junk, no extended attrs)
find "$STAGE" -name .DS_Store -delete
rm -f "$OUT"
( cd "$STAGE" && zip -rqX "$OUT" webapp3 -x '*.DS_Store' )

echo "Built $OUT"
unzip -l "$OUT"
