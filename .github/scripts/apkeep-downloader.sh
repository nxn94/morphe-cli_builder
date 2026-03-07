#!/bin/bash
# APKMirror/APKPure downloader using apkeep
# Usage: apkeep-downloader.sh <package_id> <version> <output_dir>

set -euo pipefail

PACKAGE_ID="$1"
VERSION="$2"
OUTPUT_DIR="$3"

if [ -z "$PACKAGE_ID" ] || [ -z "$VERSION" ] || [ -z "$OUTPUT_DIR" ]; then
  echo "Usage: $0 <package_id> <version> <output_dir>" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

echo "Downloading $PACKAGE_ID version $VERSION using apkeep..."

# Use apkeep to download from APKPure
# The output will be in the format: package@version.xapk
apkeep -a "${PACKAGE_ID}@${VERSION}" -d apk-pure "$OUTPUT_DIR"

echo "Download complete. Files in $OUTPUT_DIR:"
ls -la "$OUTPUT_DIR"
