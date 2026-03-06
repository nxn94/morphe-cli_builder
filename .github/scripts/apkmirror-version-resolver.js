#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("child_process");

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error("Usage: apkmirror-version-resolver.js <package_id> <target_version> <arch>");
  console.error("Example: apkmirror-version-resolver.js com.google.android.youtube 21.09.266 arm64-v8a");
  process.exit(2);
}

const [packageId, targetVersion, preferredArch] = args;

// User agent for curl requests
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// Check if URL exists using curl (bypasses Cloudflare better than Playwright)
function checkUrlExists(url) {
  try {
    const result = execSync(
      `curl -s -I -H "User-Agent: ${UA}" "${url}" | head -1`,
      { timeout: 10000 }
    ).toString();
    return result.includes("HTTP/2 200") || result.includes("HTTP/1.1 200");
  } catch (e) {
    return false;
  }
}

async function resolveApkUrl(packageId, targetVersion, preferredArch) {
  const configPath = path.join(process.cwd(), "patches.json");
  let apkmirrorPaths = {};
  
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    apkmirrorPaths = config.__morphe?.apkmirror_paths || {};
  } catch (e) {
    throw new Error(`Could not read patches.json: ${e.message}`);
  }
  
  const appPath = apkmirrorPaths[packageId];
  if (!appPath) {
    throw new Error(`No APKMirror path configured for ${packageId}`);
  }
  
  const baseUrl = "https://www.apkmirror.com";
  
  // Construct version page URL directly:
  // https://www.apkmirror.com/apk/google-inc/youtube/youtube-20-44-38-release/
  const versionSlug = targetVersion.replace(/\./g, "-");
  const appName = appPath.split("/").pop();
  const versionPageUrl = `${baseUrl}/apk/${appPath}/${appName}-${versionSlug}-release/`;
  
  console.error(`Version page URL: ${versionPageUrl}`);
  
  // Try variant numbers 1-15 to find a working APK
  // Format: {app}-{version}-{variantNumber}-android-apk-download
  const variantNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  
  let downloadUrl = null;
  let foundVariant = null;
  
  for (const variantNum of variantNumbers) {
    const testUrl = `${versionPageUrl}${appName}-${versionSlug}-${variantNum}-android-apk-download/`;
    console.error(`Trying variant ${variantNum}: ${testUrl}`);
    
    if (checkUrlExists(testUrl)) {
      downloadUrl = testUrl;
      foundVariant = variantNum;
      console.error(`Found working variant: ${variantNum}`);
      break;
    }
  }
  
  if (!downloadUrl) {
    throw new Error(`Could not find download URL for ${packageId} ${targetVersion}`);
  }
  
  console.error(`Final download URL: ${downloadUrl}`);
  
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
