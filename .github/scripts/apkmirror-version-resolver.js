#!/usr/bin/env node

/**
 * APKMirror Version Resolver
 * Returns the download URL from patches.json for a specific version
 * This avoids Cloudflare issues by using pre-configured URLs
 */

const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error("Usage: apkmirror-version-resolver.js <package_id> <target_version> <arch>");
  console.error("Example: apkmirror-version-resolver.js com.google.android.youtube 21.09.266 arm64-v8a");
  process.exit(2);
}

const [packageId, targetVersion, preferredArch] = args;

async function resolveApkUrl(packageId, targetVersion, preferredArch) {
  const configPath = path.join(process.cwd(), "patches.json");
  let config;
  
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new Error(`Could not read patches.json: ${e.message}`);
  }
  
  const downloadUrls = config.__morphe?.download_urls || {};
  const packageUrls = downloadUrls[packageId] || {};
  
  // Try exact version first, then latest_supported
  let downloadUrl = packageUrls[targetVersion] || packageUrls.latest_supported;
  
  if (downloadUrl) {
    console.error(`Found URL for ${packageId} ${targetVersion}: ${downloadUrl}`);
    return {
      download_url: downloadUrl,
      version: targetVersion,
      arch: preferredArch,
      dpi: "nodpi",
      file_type: "apk"
    };
  }
  
  // If no URL found, construct a reasonable default based on the version
  // This is a fallback for when the URL isn't in patches.json
  const apkmirrorPaths = config.__morphe?.apkmirror_paths || {};
  const appPath = apkmirrorPaths[packageId];
  
  if (!appPath) {
    throw new Error(`No APKMirror path configured for ${packageId}`);
  }
  
  const baseUrl = "https://www.apkmirror.com";
  const versionSlug = targetVersion.replace(/\./g, "-");
  const appName = appPath.split("/").pop();
  
  // Try variant 2 as default (most common for arm64)
  downloadUrl = `${baseUrl}/apk/${appPath}/${appName}-${versionSlug}-release/${appName}-${versionSlug}-2-android-apk-download/`;
  
  console.error(`Using fallback URL for ${packageId} ${targetVersion}: ${downloadUrl}`);
  
  return {
    download_url: downloadUrl,
    version: targetVersion,
    arch: preferredArch,
    dpi: "nodpi",
    file_type: "apk"
  };
}

resolveApkUrl(packageId, targetVersion, preferredArch)
  .then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch(err => {
    console.error(JSON.stringify({ error: err.message }, null, 2));
    process.exit(1);
  });
