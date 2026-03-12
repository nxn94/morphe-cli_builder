#!/usr/bin/env node

/**
 * Unified APK Downloader
 * Downloads APK files from multiple sources with fallback chain:
 * 1. Check patches.json for existing URL
 * 2. apkeep (APKPure) - try first
 * 3. aurora-store - fallback second
 * 4. apkmirror with Playwright - last resort
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("child_process");

// APKMirror paths mapping
const APK_MIRROR_PATHS = {
  "com.google.android.youtube": "google-inc/youtube",
  "com.google.android.apps.youtube.music": "google-inc/youtube-music",
  "com.reddit.frontpage": "redditinc/reddit"
};

/**
 * Parse command-line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    return {
      error: "Usage: unified-downloader.js <package_id> <version> <output_dir>",
      example: "Example: unified-downloader.js com.google.android.youtube 20.40.45 ./downloads"
    };
  }

  const [packageId, version, outputDir] = args;

  // Validate inputs
  if (!packageId || !packageId.includes(".")) {
    return { error: "Invalid package_id. Expected format: com.example.app" };
  }
  if (!version || !/^\d+\.\d+/.test(version)) {
    return { error: "Invalid version. Expected format: X.Y.Z" };
  }
  if (!outputDir) {
    return { error: "Invalid output_dir" };
  }

  return { packageId, version, outputDir };
}

/**
 * Load patches.json to check for existing URL
 */
function loadPatchesJson() {
  const patchesPath = path.join(process.cwd(), "patches.json");
  if (!fs.existsSync(patchesPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(patchesPath, "utf8"));
  } catch (e) {
    console.error(`Warning: Failed to parse patches.json: ${e.message}`);
    return null;
  }
}

/**
 * Check patches.json for existing URL matching the version
 */
function loadExistingUrl(packageId, version) {
  const patches = loadPatchesJson();
  if (!patches) {
    return null;
  }

  const downloadUrls = patches.__morphe?.download_urls?.[packageId];
  if (!downloadUrls) {
    return null;
  }

  // Check for exact version match first
  if (downloadUrls[version]) {
    console.error(`Found existing URL for version ${version} in patches.json`);
    return downloadUrls[version];
  }

  // Also check if it's the latest_supported
  if (downloadUrls.latest_supported) {
    console.error(`Using latest_supported URL from patches.json`);
    return downloadUrls.latest_supported;
  }

  return null;
}

/**
 * Run command with execFile and timeout
 */
function runCommand(cmd, args, options = {}) {
  const timeout = options.timeout || 120000; // 2 minutes default

  return new Promise((resolve, reject) => {
    const proc = execFile(cmd, args, {
      timeout,
      stdio: options.stdio || ["pipe", "pipe", "pipe"],
      ...options
    });

    let stdout = "";
    let stderr = "";

    if (proc.stdout) {
      proc.stdout.on("data", (data) => {
        stdout += data;
      });
    }
    if (proc.stderr) {
      proc.stderr.on("data", (data) => {
        stderr += data;
      });
    }

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr || cmd}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });

    // Handle timeout
    setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Command timed out after ${timeout}ms: ${cmd}`));
    }, timeout);
  });
}

/**
 * Find downloaded APK in output directory
 */
function findApkFile(outputDir) {
  if (!fs.existsSync(outputDir)) {
    return null;
  }
  const extensions = [".apk", ".xapk", ".apkm"];
  const files = fs.readdirSync(outputDir);

  for (const file of files) {
    const lower = file.toLowerCase();
    for (const ext of extensions) {
      if (lower.endsWith(ext)) {
        return path.join(outputDir, file);
      }
    }
  }
  return null;
}

/**
 * Download using apkeep (APKPure)
 */
async function downloadWithApkeep(packageId, version, outputDir) {
  console.error(`[apkeep] Attempting download for ${packageId} v${version}`);

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Try apkeep with specific version first
  // apkeep syntax: apkeep <package>@version or just apkeep <package>
  const versionArg = version.includes("-") ? version : version.split(".").join(".");

  try {
    // First try with version specifier
    await runCommand("apkeep", [`${packageId}@${versionArg}`, "-d", outputDir], {
      timeout: 180000
    });
  } catch (e) {
    console.error(`[apkeep] Version-specific download failed: ${e.message}`);
    // Fall back to latest
    try {
      await runCommand("apkeep", [packageId, "-d", outputDir], {
        timeout: 180000
      });
    } catch (e2) {
      throw new Error(`apkeep failed: ${e2.message}`);
    }
  }

  // Find the downloaded file
  const apkPath = findApkFile(outputDir);
  if (!apkPath) {
    throw new Error("apkeep completed but no APK found in output directory");
  }

  const stats = fs.statSync(apkPath);
  if (stats.size < 1000) {
    throw new Error(`Downloaded file too small (${stats.size} bytes) - likely error`);
  }

  console.error(`[apkeep] Downloaded: ${apkPath} (${stats.size} bytes)`);

  return {
    success: true,
    filepath: apkPath,
    version: version,
    source: "apkeep",
    url: `apkeep:${packageId}@${version}`
  };
}

/**
 * Download using aurora-store
 */
async function downloadWithAurora(packageId, version, outputDir) {
  console.error(`[aurora] Attempting download for ${packageId} v${version}`);

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const tempDir = path.join(outputDir, ".aurora-temp");

  try {
    // aurora-store uses own client to download
    // Try with version specification
    await runCommand("aurora-store", [
      "-d", packageId,
      "-v", version,
      "-o", tempDir
    ], {
      timeout: 180000
    });
  } catch (e) {
    // Try without version (latest)
    try {
      await runCommand("aurora-store", [
        "-d", packageId,
        "-o", tempDir
      ], {
        timeout: 180000
      });
    } catch (e2) {
      throw new Error(`aurora-store failed: ${e2.message}`);
    }
  }

  // Find downloaded file
  const apkPath = findApkFile(tempDir) || findApkFile(outputDir);
  if (!apkPath) {
    throw new Error("aurora-store completed but no APK found");
  }

  // Move to output directory if in temp
  const finalPath = path.join(outputDir, path.basename(apkPath));
  if (apkPath !== finalPath) {
    fs.copyFileSync(apkPath, finalPath);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const stats = fs.statSync(finalPath);
  console.error(`[aurora] Downloaded: ${finalPath} (${stats.size} bytes)`);

  return {
    success: true,
    filepath: finalPath,
    version: version,
    source: "aurora",
    url: `aurora:${packageId}@${version}`
  };
}

/**
 * Download using APKMirror with Playwright
 */
async function downloadWithApkmirror(packageId, version, outputDir) {
  console.error(`[apkmirror] Attempting download for ${packageId} v${version}`);

  const apkmirrorPath = APK_MIRROR_PATHS[packageId];
  if (!apkmirrorPath) {
    throw new Error(`No APKMirror path configured for ${packageId}`);
  }

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // First resolve the download URL
  const { chromium } = require("playwright");

  const downloadUrl = await resolveApkmirrorUrl(apkmirrorPath, version);
  console.error(`[apkmirror] Resolved URL: ${downloadUrl}`);

  // Download using Playwright
  const result = await downloadWithPlaywright(downloadUrl, outputDir);

  if (!result.success) {
    throw new Error("Playwright download failed");
  }

  return {
    success: true,
    filepath: result.path,
    version: version,
    source: "apkmirror",
    url: downloadUrl
  };
}

/**
 * Resolve APKMirror download URL using Playwright
 */
async function resolveApkmirrorUrl(apkmirrorPath, version) {
  const { chromium } = require("playwright");

  const baseUrl = `https://www.apkmirror.com/apk/${apkmirrorPath}/`;
  const variantUrl = `${baseUrl}${version.replace(/\./g, "-")}-release/`;

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  });

  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1920, height: 1080 }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await context.newPage();

  try {
    // Try variant URL first
    await page.goto(variantUrl, { timeout: 30000, waitUntil: "domcontentloaded" });

    // Wait for page to settle
    await page.waitForTimeout(3000);

    const title = await page.title();
    if (title.includes("404") || title.includes("Not Found")) {
      // Try base URL to find correct version
      await page.goto(baseUrl, { timeout: 30000, waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
    }

    // Find download link
    const downloadLink = await page.$('a.downloadButton, a[class*="downloadButton"]');
    if (downloadLink) {
      const href = await downloadLink.getAttribute("href");
      await browser.close();
      return `https://www.apkmirror.com${href}`;
    }

    // Try to find version-specific link
    const versionLinks = await page.$$eval('a[href*="release"]', links =>
      links.map(l => l.href).filter(h => h.includes(version.replace(/\./g, "-")))
    );

    if (versionLinks.length > 0) {
      await browser.close();
      return versionLinks[0];
    }

    throw new Error("Could not find download URL on APKMirror");
  } finally {
    await browser.close();
  }
}

/**
 * Download with Playwright (internal)
 */
async function downloadWithPlaywright(url, outputDir) {
  const { chromium } = require("playwright");

  const tempDir = path.join(outputDir, ".playwright-temp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  });

  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1920, height: 1080 }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await context.newPage();
  const downloadPromise = context.waitForEvent("download", { timeout: 90000 });

  try {
    await page.goto(url, { timeout: 60000, waitUntil: "domcontentloaded" });

    // Wait for Cloudflare
    await page.waitForTimeout(5000);

    // Dismiss consent popup
    const consentBtn = await page.$('#qc-cmp2-container button[mode="primary"]');
    if (consentBtn) {
      await consentBtn.click();
      await page.waitForTimeout(2000);
    }

    // Click download button
    const downloadButtonSelectors = [
      "a.downloadButton",
      "a.btn.btn-flat.downloadButton",
      "a:has-text('Download APK')"
    ];

    for (const selector of downloadButtonSelectors) {
      const btn = await page.$(selector);
      if (btn) {
        await btn.click();
        break;
      }
    }

    const download = await downloadPromise;
    const filename = download.suggestedFilename();
    const downloadedPath = await download.path();

    const outputPath = path.join(tempDir, filename);
    fs.copyFileSync(downloadedPath, outputPath);

    return { success: true, path: outputPath, filename };
  } finally {
    await browser.close();
  }
}

/**
 * Main download function with fallback chain
 */
async function download(packageId, version, outputDir) {
  // Step 1: Check patches.json for existing URL
  const existingUrl = loadExistingUrl(packageId, version);
  if (existingUrl) {
    console.error(`Using existing URL from patches.json: ${existingUrl}`);
    // Could add logic to skip download if file exists
  }

  // Step 2: Try apkeep (APKPure) - first choice
  try {
    return await downloadWithApkeep(packageId, version, outputDir);
  } catch (e) {
    console.error(`[apkeep] Failed: ${e.message}`);
  }

  // Step 3: Try aurora-store - second choice
  try {
    return await downloadWithAurora(packageId, version, outputDir);
  } catch (e) {
    console.error(`[aurora] Failed: ${e.message}`);
  }

  // Step 4: Try APKMirror with Playwright - last resort
  try {
    return await downloadWithApkmirror(packageId, version, outputDir);
  } catch (e) {
    console.error(`[apkmirror] Failed: ${e.message}`);
  }

  // All methods failed
  throw new Error("All download methods failed");
}

/**
 * Main entry point
 */
async function main() {
  // Parse arguments
  const args = parseArgs();
  if (args.error) {
    console.error(args.error);
    if (args.example) {
      console.error(args.example);
    }
    process.exit(2);
  }

  const { packageId, version, outputDir } = args;

  console.error(`Starting unified download for ${packageId} v${version}`);
  console.error(`Output directory: ${outputDir}`);

  try {
    const result = await download(packageId, version, outputDir);

    // Output JSON result to stdout
    console.log(JSON.stringify(result, null, 2));

    process.exit(0);
  } catch (e) {
    const errorResult = {
      success: false,
      error: e.message
    };

    console.error(`Download failed: ${e.message}`);
    console.log(JSON.stringify(errorResult));

    process.exit(1);
  }
}

main();
