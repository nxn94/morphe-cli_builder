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
const { chromium } = require("playwright");

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

    let settled = false;
    const cleanup = () => {
      if (!settled) {
        settled = true;
      }
    };

    proc.on("close", (code) => {
      cleanup();
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr || cmd}`));
      }
    });

    proc.on("error", (err) => {
      cleanup();
      reject(err);
    });

    // Handle timeout
    setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGTERM");
        reject(new Error(`Command timed out after ${timeout}ms: ${cmd}`));
      }
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

  // Try apkeep with specific version first (what patches need)
  // apkeep syntax: apkeep -a package@version -d source output_path
  const versionArg = version.includes("-") ? version : version.split(".").join(".");

  let downloadedVersion = version;

  // First, clear any existing files
  if (fs.existsSync(outputDir)) {
    const files = fs.readdirSync(outputDir);
    for (const file of files) {
      if (file !== '.playwright-temp') {
        try {
          fs.unlinkSync(path.join(outputDir, file));
        } catch (e) { /* ignore */ }
      }
    }
  }

  // Try SPECIFIC version first (what Morphe patches need)
  let specificVersionFailed = false;
  try {
    console.error(`[apkeep] Trying specific version ${version}...`);
    await runCommand("apkeep", ["-a", `${packageId}@${versionArg}`, "-d", "apk-pure", outputDir], {
      timeout: 180000
    });
    const apkPath = findApkFile(outputDir);
    if (apkPath) {
      downloadedVersion = version;
      console.error(`[apkeep] Downloaded specific version: ${downloadedVersion}`);
    } else {
      specificVersionFailed = true;
    }
  } catch (e) {
    console.error(`[apkeep] Specific version ${version} not available: ${e.message}`);
    specificVersionFailed = true;
  }

  // If specific version failed, return failure so caller can try APKMirror
  if (specificVersionFailed || !findApkFile(outputDir)) {
    // Clear any partial downloads
    const files = fs.readdirSync(outputDir);
    for (const file of files) {
      if (file !== '.playwright-temp') {
        try {
          fs.unlinkSync(path.join(outputDir, file));
        } catch (e) { /* ignore */ }
      }
    }
    throw new Error(`Specific version ${version} not available on APKPure`);
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
    version: downloadedVersion,
    source: "apkeep",
    url: `apkeep:${packageId}@${downloadedVersion}`
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
 * Resolve APKMirror download URL using Playwright with improved Cloudflare handling
 */
async function resolveApkmirrorUrl(apkmirrorPath, version) {
  const baseUrl = `https://www.apkmirror.com/apk/${apkmirrorPath}/`;
  const variantUrl = `${baseUrl}${version.replace(/\./g, "-")}-release/`;

  // More realistic user agent
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-first-run",
      "--safebrowsing-disable-auto-update"
    ]
  });

  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "America/New_York",
    permissions: ["geolocation"],
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
    }
  });

  // Add stealth scripts
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    window.chrome = { runtime: {} };
    // Override permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );
  });

  const page = await context.newPage();

  // Track if we hit Cloudflare
  let cloudflareAttempts = 0;
  const maxCloudflareAttempts = 3;

  const waitForCloudflare = async () => {
    const title = await page.title();
    if (title.includes("Just a moment") || title.includes("cloudflare") || title.includes("Checking your browser")) {
      cloudflareAttempts++;
      console.error(`[apkmirror] Cloudflare challenge detected, attempt ${cloudflareAttempts}/${maxCloudflareAttempts}`);
      if (cloudflareAttempts >= maxCloudflareAttempts) {
        throw new Error("Cloudflare challenge failed after multiple attempts");
      }
      await page.waitForTimeout(10000); // Wait longer for Cloudflare
      return true;
    }
    return false;
  };

  try {
    // Try variant URL first
    console.error(`[apkmirror] Trying variant URL: ${variantUrl}`);
    await page.goto(variantUrl, { timeout: 60000, waitUntil: "domcontentloaded" });

    // Wait for Cloudflare
    await page.waitForTimeout(5000);
    await waitForCloudflare();

    // Additional wait for page to fully load
    await page.waitForTimeout(3000);

    const title = await page.title();
    console.error(`[apkmirror] Page title: ${title}`);

    if (title.includes("404") || title.includes("Not Found") || title.includes("File not found")) {
      // Try base URL to find correct version
      console.error(`[apkmirror] Version not found, trying base URL`);
      await page.goto(baseUrl, { timeout: 60000, waitUntil: "domcontentloaded" });
      await page.waitForTimeout(5000);
      await waitForCloudflare();
    }

    // Skip anchor links (#all_versions) - these are not actual downloads
    // Find download link that is NOT an anchor
    const downloadLink = await page.$('a.downloadButton[href^="/apk/"], a[class*="downloadButton"][href^="/apk/"], a.btn[href^="/apk/"]');
    if (downloadLink) {
      const href = await downloadLink.getAttribute("href");
      console.error(`[apkmirror] Found download link: ${href}`);
      await browser.close();
      return `https://www.apkmirror.com${href}`;
    }

    // Try to find version-specific link
    const versionSlug = version.replace(/\./g, "-");
    let versionLinks = await page.$$eval('a[href*="release"]', (links, vSlug) =>
      links.map(l => l.href).filter(h => h.includes(vSlug) && !h.includes("#")), versionSlug
    );

    console.error(`[apkmirror] Found ${versionLinks.length} version links for exact version`);

    // If exact version not found, try to get the latest version available
    if (versionLinks.length === 0) {
      console.error(`[apkmirror] Exact version not found, trying to get latest available version...`);

      // Get the first available version from the page (exclude anchor links)
      // Use the correct path for this package (e.g., /youtube/ or /youtube-music/)
      const searchPath = "/" + apkmirrorPath + "/";
      const allVersionLinks = await page.$$eval('a[href*="release"]', (links, search) =>
        links.map(l => l.href).filter(h => h.includes(search) && h.includes("-release") && !h.includes("#"))
      , searchPath);

      if (allVersionLinks.length > 0) {
        console.error(`[apkmirror] Found ${allVersionLinks.length} available versions, using first one`);
        await browser.close();
        return allVersionLinks[0];
      }
    }

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
 * Improved to handle APKMirror's multi-step download process:
 * 1. Initial download button → 2. Variant selection → 3. Final download
 */
async function downloadWithPlaywright(url, outputDir) {
  const tempDir = path.join(outputDir, ".playwright-temp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-first-run",
      "--safebrowsing-disable-auto-update"
    ]
  });

  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "America/New_York",
    permissions: ["geolocation"],
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
    }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  // Set up download handler FIRST before navigation
  const downloadPromise = context.waitForEvent("download", { timeout: 180000 }); // 3 min timeout for download

  try {
    console.error(`[apkmirror] Navigating to: ${url}`);
    await page.goto(url, { timeout: 90000, waitUntil: "domcontentloaded" });

    // Wait for initial page load
    await page.waitForTimeout(5000);

    // Check for Cloudflare
    const title = await page.title();
    console.error(`[apkmirror] Initial page title: ${title}`);

    if (title.includes("Just a moment") || title.includes("cloudflare")) {
      console.error(`[apkmirror] Cloudflare challenge detected, waiting...`);
      // Wait for Cloudflare to complete with retries
      for (let i = 0; i < 15; i++) {
        await page.waitForTimeout(3000);
        const newTitle = await page.title();
        console.error(`[apkmirror] Cloudflare check ${i+1}: ${newTitle}`);
        if (!newTitle.includes("Just a moment") && !newTitle.includes("cloudflare") && !newTitle.includes("Checking your browser")) {
          console.error(`[apkmirror] Cloudflare challenge passed`);
          break;
        }
        if (i === 14) {
          throw new Error("Cloudflare challenge could not be completed");
        }
      }
    }

    // Additional wait for dynamic content
    await page.waitForTimeout(3000);

    // Dismiss consent popup
    const consentSelectors = [
      '#qc-cmp2-container button[mode="primary"]',
      '#qc-cmp2-container button:has-text("Accept")',
      'button:has-text("Accept All")',
      'button:has-text("I Agree")',
      '.qc-cmp2-container button[mode="primary"]'
    ];

    for (const selector of consentSelectors) {
      try {
        const consentBtn = await page.$(selector);
        if (consentBtn) {
          console.error(`[apkmirror] Dismissing consent popup with: ${selector}`);
          await consentBtn.click({ timeout: 5000 });
          await page.waitForTimeout(2000);
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    // Click first download button (on variant selection page)
    const firstDownloadSelectors = [
      "a.downloadButton",
      "a.btn.btn-flat.downloadButton",
      "a:has-text('Download APK')",
      "a[class*='downloadButton']",
      "span[class*='downloadButton'] a"
    ];

    let clickedFirstButton = false;
    for (const selector of firstDownloadSelectors) {
      try {
        const btn = await page.$(selector);
        if (btn) {
          console.error(`[apkmirror] Clicking first download button: ${selector}`);
          await btn.click({ timeout: 10000 });
          clickedFirstButton = true;
          break;
        }
      } catch (e) {
        console.error(`[apkmirror] Selector ${selector} failed: ${e.message}`);
      }
    }

    if (!clickedFirstButton) {
      // Try to find and click any link that leads to download
      const downloadLinks = await page.$$eval('a[href*="/download/"]', links => links.map(l => l.href));
      console.error(`[apkmirror] Found ${downloadLinks.length} download links`);
    }

    // Wait for potential redirect to variant selection
    await page.waitForTimeout(5000);

    // Check current URL - if changed, we might be on variant selection
    const currentUrl = page.url();
    console.error(`[apkmirror] Current URL after first click: ${currentUrl}`);

    // If URL changed to a new page, we might need to click again
    if (currentUrl !== url) {
      console.error(`[apkmirror] Detected page change, waiting for variant/download options...`);
      await page.waitForTimeout(3000);
    }

    // Now click the FINAL download button (might be on same page or new page)
    // APKMirror often has a second button after variant selection
    const finalDownloadSelectors = [
      "a.downloadButton",  // The actual download button
      "a[data-track*='Download']",
      "button:has-text('Download')",
      "a:has-text('Download APK')",
      "a.btn-success",
      "a[class*='btn-primary']"
    ];

    let clickedFinalButton = false;
    for (const selector of finalDownloadSelectors) {
      try {
        const btn = await page.$(selector);
        if (btn) {
          const btnText = await btn.textContent();
          console.error(`[apkmirror] Clicking final download button: ${selector} (text: ${btnText})`);
          await btn.click({ timeout: 10000 });
          clickedFinalButton = true;
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    // If still no button clicked, try to follow any redirect link
    if (!clickedFinalButton) {
      console.error(`[apkmirror] No final button found, looking for download links...`);
      const redirectLink = await page.$('a[href*="download"]');
      if (redirectLink) {
        const href = await redirectLink.getAttribute("href");
        if (href && href.startsWith("http")) {
          console.error(`[apkmirror] Following redirect link: ${href}`);
          await page.goto(href, { timeout: 60000, waitUntil: "domcontentloaded" });
          await page.waitForTimeout(5000);
        }
      }
    }

    // Wait for download to start
    console.error(`[apkmirror] Waiting for download to start...`);

    // Wait longer - APKMirror can be slow
    let download;
    try {
      download = await downloadPromise;
    } catch (downloadError) {
      console.error(`[apkmirror] Download event timed out, checking page state...`);

      // Take a screenshot for debugging (save to temp)
      try {
        const debugPath = path.join(tempDir, "debug.png");
        await page.screenshot({ path: debugPath });
        console.error(`[apkmirror] Debug screenshot saved to: ${debugPath}`);
      } catch (e) { /* ignore */ }

      // Check if there's a countdown or manual download link
      const pageContent = await page.content();
      if (pageContent.includes("countdown") || pageContent.includes("seconds")) {
        console.error(`[apkmirror] Countdown detected, waiting...`);
        await page.waitForTimeout(30000); // Wait for countdown
        // Try to find and click download again
        const retryBtn = await page.$("a.downloadButton, a:has-text('Download')");
        if (retryBtn) {
          console.error(`[apkmirror] Clicking download after countdown...`);
          const newDownloadPromise = context.waitForEvent("download", { timeout: 120000 });
          await retryBtn.click();
          download = await newDownloadPromise;
        }
      } else {
        throw downloadError;
      }
    }

    const filename = download.suggestedFilename();
    console.error(`[apkmirror] Download detected, filename: ${filename}`);

    const downloadedPath = await download.path();
    if (!downloadedPath) {
      throw new Error("Download path is null");
    }

    const outputPath = path.join(tempDir, filename);
    fs.copyFileSync(downloadedPath, outputPath);

    console.error(`[apkmirror] Download complete: ${outputPath}`);
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

  // Check if existing URL is a local file that already exists
  if (existingUrl) {
    console.error(`Found existing URL in patches.json: ${existingUrl}`);

    // Check if it's a local file path that exists
    if (!existingUrl.startsWith("http")) {
      // Treat as local file path
      const localPath = existingUrl;
      if (fs.existsSync(localPath)) {
        console.error(`Using existing local file: ${localPath}`);
        console.log(JSON.stringify({
          success: true,
          filepath: localPath,
          version: version,
          source: "existing",
          url: existingUrl
        }, null, 2));
        process.exit(0);
      }
    }

    // For remote URLs, try to download directly using the existing URL
    if (existingUrl && existingUrl.startsWith("http")) {
      console.error(`Using existing URL from patches.json: ${existingUrl}`);

      // Try to download directly from the existing URL
      try {
        const directResult = await downloadFromUrl(existingUrl, packageId, version, outputDir);
        if (directResult.success) {
          console.error(`[direct] Downloaded using existing URL`);
          console.log(JSON.stringify({
            success: true,
            filepath: directResult.filepath,
            version: version,
            source: "existing-url",
            url: existingUrl
          }, null, 2));
          process.exit(0);
        }
      } catch (e) {
        console.error(`[direct] Failed: ${e.message}, falling back to download chain...`);
      }
    } else {
      console.error(`Existing URL is remote, attempting download as fallback...`);
    }
  }

  // Helper function to download from a direct URL
  async function downloadFromUrl(url, packageId, version, outputDir) {
    // If URL is APKMirror, use Playwright
    if (url.includes("apkmirror.com")) {
      return await downloadWithPlaywright(url, outputDir);
    }
    // For other URLs, could add curl/wget support here
    throw new Error("Direct download not supported for this URL type");
  }

  // Step 2: Try apkeep (APKPure) - first choice
  try {
    return await downloadWithApkeep(packageId, version, outputDir);
  } catch (e) {
    console.error(`[apkeep] Failed: ${e.message}`);
  }

  // Step 3: Skip aurora-store (no working CLI available)
  console.error(`[aurora] Skipping: aurora-store CLI not available`);

  // Step 4: Try APKMirror with Playwright - last resort
  console.error(`[apkmirror] Starting APKMirror fallback...`);
  try {
    return await downloadWithApkmirror(packageId, version, outputDir);
  } catch (e) {
    console.error(`[apkmirror] Failed: ${e.message}`);
    throw e; // Re-throw to see the full error
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
