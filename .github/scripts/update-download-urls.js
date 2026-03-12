#!/usr/bin/env node

/**
 * Update download URLs in patches.json
 * Usage: node update-download-urls.js <package_id> <version> <url>
 */

const fs = require('fs');
const path = require('path');

function main() {
  const args = process.argv.slice(2);

  if (args.length !== 3) {
    console.log(JSON.stringify({
      success: false,
      error: 'Usage: node update-download-urls.js <package_id> <version> <url>'
    }, null, 2));
    process.exit(1);
  }

  const [packageId, version, url] = args;
  const patchesPath = path.join(process.cwd(), 'patches.json');

  try {
    // Read patches.json
    let patches;
    try {
      const content = fs.readFileSync(patchesPath, 'utf8');
      patches = JSON.parse(content);
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log(JSON.stringify({
          success: false,
          error: 'patches.json not found in current directory'
        }, null, 2));
        process.exit(1);
      }
      throw err;
    }

    // Initialize __morphe.download_urls if it doesn't exist
    if (!patches.__morphe) {
      patches.__morphe = {};
    }
    if (!patches.__morphe.download_urls) {
      patches.__morphe.download_urls = {};
    }
    if (!patches.__morphe.download_urls[packageId]) {
      patches.__morphe.download_urls[packageId] = {};
    }

    // Update the URL for the specific version
    patches.__morphe.download_urls[packageId][version] = url;

    // Update latest_supported
    patches.__morphe.download_urls[packageId].latest_supported = url;

    // Write back to patches.json with pretty formatting
    fs.writeFileSync(patchesPath, JSON.stringify(patches, null, 2) + '\n', 'utf8');

    console.log(JSON.stringify({
      success: true,
      packageId,
      version,
      url
    }, null, 2));

  } catch (err) {
    console.log(JSON.stringify({
      success: false,
      error: err.message
    }, null, 2));
    process.exit(1);
  }
}

main();
