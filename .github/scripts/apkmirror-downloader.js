#!/usr/bin/env node

/**
 * APK Downloader using curl
 * Downloads APK files from APKMirror using curl with proper headers
 */

const fs = require("node:fs");
const { execSync } = require("child_process");

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("Usage: apkmirror-downloader.js <download_url> <output_path>");
  console.error("Example: apkmirror-downloader.js https://www.apkmirror.com/apk/.../youtube-20.44.38-2-android-apk-download/ /path/to/output.apk");
  process.exit(2);
}

const [downloadUrl, outputPath] = args;

// Realistic user agent
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

console.error(`Downloading APK from: ${downloadUrl}`);
console.error(`Output path: ${outputPath}`);

// Ensure output directory exists
const outputDir = require("node:path").dirname(outputPath);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Use curl to download the APK with proper headers and redirects
try {
  execSync(
    `curl -fL --retry 4 --retry-delay 5 --connect-timeout 30 \
      -H "User-Agent: ${UA}" \
      -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" \
      -H "Accept-Language: en-US,en;q=0.9" \
      -H "Referer: https://www.apkmirror.com/" \
      -o "${outputPath}" \
      "${downloadUrl}"`,
    { stdio: 'inherit' }
  );
} catch (e) {
  console.error(`Download failed: ${e.message}`);
  process.exit(1);
}

// Verify the file was downloaded
if (!fs.existsSync(outputPath)) {
  console.error("Error: Output file was not created");
  process.exit(1);
}

const stats = fs.statSync(outputPath);
if (stats.size < 1000) {
  console.error(`Error: Downloaded file is too small (${stats.size} bytes) - likely an error page`);
  process.exit(1);
}

console.error(`Download complete: ${stats.size} bytes`);

// Output JSON for the workflow
console.log(JSON.stringify({
  success: true,
  filename: require("node:path").basename(outputPath),
  bytes: stats.size,
  path: outputPath
}));
