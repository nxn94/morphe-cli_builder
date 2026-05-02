#!/usr/bin/env node

/**
 * Update download URLs in config.json
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
  const configPath = path.join(process.cwd(), 'config.json');

  try {
    let config;
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(content);
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log(JSON.stringify({
          success: false,
          error: 'config.json not found in current directory'
        }, null, 2));
        process.exit(1);
      }
      throw err;
    }

    // Initialize download_urls if needed
    if (!config.download_urls) {
      config.download_urls = {};
    }
    if (!config.download_urls[packageId]) {
      config.download_urls[packageId] = {};
    }

    const pinVersion = config.patch_repos?.[packageId]?.pin_version;
    if (pinVersion) {
      console.log(JSON.stringify({
        success: true,
        skipped: true,
        reason: `pin_version is set for ${packageId} (${pinVersion}) — skipping URL update`
      }, null, 2));
      return;
    }

    // Update the URL for the specific version and latest_supported
    config.download_urls[packageId][version] = url;
    config.download_urls[packageId].latest_supported = url;

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

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
