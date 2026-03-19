#!/usr/bin/env node

/**
 * Unified APK Downloader
 * Downloads APK files from multiple sources with fallback chain:
 * 1. Check cache for existing APK
 * 2. Check patches.json for existing URL
 * 3. apkeep (APKPure) - try first
 * 4. APKMirror API - second
 * 5. apkmirror with Playwright - last resort
 *
 * Cache: Downloads are cached in ~/.cache/auto-morphe-builder/apks/
 * Old versions are cleaned up when a new version is successfully downloaded
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("child_process");
const { chromium } = require("playwright");
const os = require("node:os");
const cheerio = require('cheerio');

// APKMirror API credentials
const APK_MIRROR_API_USER = "api-apkupdater";
const APK_MIRROR_API_PASS = "rm5rcfruUjKy04sMpyMPJXW8";

// Cache directory
const CACHE_DIR = path.join(os.homedir(), ".cache", "auto-morphe-builder", "apks");

// URL cache directory - stores resolved URLs as JSON
const URL_CACHE_DIR = path.join(os.homedir(), ".cache", "auto-morphe-builder", "urls");

/**
 * Get APKMirror path for a package from config.json, with hardcoded fallback.
 */
function getApkmirrorPath(packageId) {
  const config = loadConfig();
  const paths = config.apkmirror_paths || {
    "com.google.android.youtube": "google-inc/youtube",
    "com.google.android.apps.youtube.music": "google-inc/youtube-music",
    "com.reddit.frontpage": "redditinc/reddit"
  };
  return paths[packageId] || null;
}

/**
 * Build APKMirror release page URL for a given version.
 * Slug is derived from the last path component of apkmirrorPath.
 * e.g. "google-inc/youtube" + "20.44.38" → ".../youtube-20-44-38-release/"
 */
function buildReleasePageUrl(apkmirrorPath, version) {
  const slug = apkmirrorPath.split('/').pop();
  const versionSlug = version.replace(/\./g, '-');
  return `https://www.apkmirror.com/apk/${apkmirrorPath}/${slug}-${versionSlug}-release/`;
}

/**
 * Build ordered variant priority list from preferred arch.
 * Priority: preferred APK → preferred BUNDLE → universal APK → universal BUNDLE → noarch APK
 */
function buildVariantPriorities(preferredArch) {
  const archs = [preferredArch, 'universal', 'noarch'];
  const dpis  = ['nodpi', '120-640dpi', '240-480dpi'];
  const priorities = [];
  for (const dpi of dpis) {
    for (const arch of archs) {
      priorities.push({ arch, dpi, type: 'APK' });
      if (arch !== 'noarch') priorities.push({ arch, dpi, type: 'BUNDLE' });
    }
  }
  return priorities;
}

/**
 * Parse variant table rows from a cheerio-loaded release page.
 * Returns the href of the first row matching the priority list.
 * Throws with available variants if nothing matches.
 */
function selectVariant($, priorities) {
  const rows = [];
  $('.table-row').each((_, row) => {
    const cells = $(row).find('.table-cell');
    if (cells.length < 4) return;
    // Real APKMirror DOM: cells[0]=variant name+type+link, cells[1]=arch, cells[2]=minver, cells[3]=dpi
    const href = $(cells[0]).find('a.accent_color[href], a[href*="/apk/"]').attr('href');
    if (!href || href.includes('#')) return;  // Skip anchor-only sidebar links
    const variantText = $(cells[0]).text().toUpperCase();
    const type = variantText.includes('BUNDLE') ? 'BUNDLE' : 'APK';
    rows.push({
      dpi:  $(cells[3]).text().trim().toLowerCase(),
      arch: $(cells[1]).text().trim().toLowerCase(),
      type,
      href,
    });
  });

  for (const { arch, dpi, type } of priorities) {
    const match = rows.find(r =>
      r.arch.includes(arch.toLowerCase()) &&
      r.dpi === dpi.toLowerCase() &&
      r.type === type
    );
    if (match) return match.href;
  }

  const found = rows.map(r => `${r.arch}/${r.dpi}/${r.type}`).join(', ') || 'none';
  throw new Error(`No matching variant found on APKMirror. Available: ${found}`);
}

/**
 * Collect cookies from a fetch Response's Set-Cookie headers into a plain object.
 * Uses getSetCookie() which returns an array — safe for multi-cookie responses.
 * Merges with any existing cookies.
 */
function collectCookies(response, existing = {}) {
  const setCookies = response.headers.getSetCookie?.() ?? [];
  if (setCookies.length === 0) return existing;
  const cookies = { ...existing };
  for (const cookie of setCookies) {
    const [pair] = cookie.split(';');
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 1) continue;
    cookies[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
  }
  return cookies;
}

/**
 * Make a request with browser-like headers using curl subprocess.
 * Node's built-in fetch has a different TLS fingerprint that Cloudflare detects.
 * curl's TLS fingerprint matches real browsers and passes Cloudflare bot detection.
 */
async function apkmirrorFetch(url, cookies = {}, referer = null) {
  const { execFileSync } = require('child_process');
  const args = [
    '-s', '-L', '--max-time', '30',
    '-A', 'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0',
    '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    '-H', 'Accept-Language: en-US,en;q=0.9',
    '-H', 'DNT: 1',
    '-w', '\n%{http_code}',
  ];
  if (referer) args.push('-H', `Referer: ${referer}`);
  if (Object.keys(cookies).length > 0) {
    args.push('-H', `Cookie: ${Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')}`);
  }
  args.push(url);

  const output = execFileSync('curl', args, { maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' });
  const lastNewline = output.lastIndexOf('\n');
  const statusCode = parseInt(output.slice(lastNewline + 1).trim(), 10);
  const body = output.slice(0, lastNewline);

  if (statusCode >= 400) throw new Error(`HTTP ${statusCode} for ${url}`);

  return {
    text: async () => body,
    headers: { getSetCookie: () => [] },
    ok: statusCode < 400,
    status: statusCode,
  };
}

/**
 * Check URL cache for a package version
 * @returns {object|null} Cache entry or null if not found/invalid
 */
function getCachedUrl(packageId, version) {
  const cacheDir = path.join(URL_CACHE_DIR, packageId);
  const cacheFile = path.join(cacheDir, `${version}.json`);

  if (!fs.existsSync(cacheFile)) {
    console.error(`[url-cache] Miss: ${packageId} v${version}`);
    return null;
  }

  try {
    const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    console.error(`[url-cache] Hit: ${packageId} v${version} (source: ${cacheData.source}, downloads: ${cacheData.downloads})`);
    return cacheData;
  } catch (e) {
    console.error(`[url-cache] Error reading cache: ${e.message}`);
    return null;
  }
}

/**
 * Save URL to cache
 * @param {string} packageId - Package ID
 * @param {string} version - Version
 * @param {string} url - Resolved URL
 * @param {string} source - Source that provided the URL
 * @returns {string} Path to cached file
 */
function saveCachedUrl(packageId, version, url, source) {
  // Input validation
  if (!packageId || !version || !url) {
    throw new Error('Missing required parameters');
  }

  const cacheDir = path.join(URL_CACHE_DIR, packageId);

  // Create directory if it doesn't exist
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  // Sanitize version for use in filename to prevent path traversal
  const safeVersion = version.replace(/[^a-zA-Z0-9.-]/g, '_');
  const cacheFile = path.join(cacheDir, `${safeVersion}.json`);

  // Read existing cache or create new
  let cacheData = { downloads: 0, lastWorkingAt: null };
  if (fs.existsSync(cacheFile)) {
    try {
      cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (e) {
      console.error(`[url-cache] Corrupted cache file, recreating: ${e.message}`);
    }
  }

  // Update cache entry
  const newCacheData = {
    version,
    url,
    source,
    resolvedAt: new Date().toISOString(),
    downloads: cacheData.downloads + 1,
    lastWorkingAt: new Date().toISOString()
  };

  fs.writeFileSync(cacheFile, JSON.stringify(newCacheData, null, 2));
  console.error(`[url-cache] Saved: ${packageId} v${version} from ${source}`);

  return cacheFile;
}

/**
 * Verify URL still works with HEAD request
 * @param {string} url - URL to verify
 * @returns {Promise<boolean>} True if URL is valid
 */
async function verifyUrl(url) {
  // Input validation
  if (!url) {
    throw new Error('URL is required');
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout

    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow'
    });

    clearTimeout(timeout);
    const isValid = response.ok;
    console.error(`[url-cache] URL verify: ${isValid ? 'valid' : 'invalid'} (${response.status})`);
    return isValid;
  } catch (e) {
    console.error(`[url-cache] URL verify failed: ${e.message}`);
    return false;
  }
}

/**
 * Resolve URL using apkeep (APKPure) - returns URL only, no download
 * @param {string} packageId - Package ID
 * @param {string} version - Version to resolve
 * @returns {Promise<object>} { url, source }
 */
async function resolveApkeep(packageId, version) {
  if (!packageId || !packageId.includes('.')) {
    throw new Error('Invalid packageId format');
  }
  if (!version) {
    throw new Error('Version is required');
  }

  console.error(`[apkeep-resolve] Resolving ${packageId} v${version}`);

  // apkeep doesn't support --print-url, so we download to temp and return the URL
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkeep-'));
  const tempFile = path.join(tempDir, `${packageId}_${version}.apk`);

  return new Promise((resolve, reject) => {
    const args = ['-a', `${packageId}@${version}`, '-d', 'apk-pure', tempFile];

    execFile('apkeep', args, { timeout: 60000 }, (error, stdout, stderr) => {
      // Clean up temp file
      try { fs.unlinkSync(tempFile); fs.rmdirSync(tempDir); } catch (e) { /* ignore */ }

      if (error) {
        console.error(`[apkeep-resolve] Failed: ${error.message}`);
        reject(new Error(`apkeep failed: ${error.message}${stderr ? ` - ${stderr}` : ''}`));
        return;
      }

      // Construct URL from package info (apkeep doesn't return the URL directly)
      const url = `https://apkpure.com/${packageId.replace(/\./g, '/')}/${version}`;
      console.error(`[apkeep-resolve] Got APK via apkeep`);
      resolve({ url, source: 'apkeep' });
    });
  });
}

/**
 * Resolve URL using APKMirror API - returns URL only
 * @param {string} packageId - Package ID
 * @param {string} version - Version to resolve
 * @returns {Promise<object>} { url, source }
 */
async function resolveApkmirrorApi(packageId, version) {
  console.error(`[apkmirror-api-resolve] Resolving ${packageId} v${version}`);

  const apkmirrorPath = getApkmirrorPath(packageId);
  if (!apkmirrorPath) {
    throw new Error(`No APKMirror path for ${packageId}`);
  }

  // API endpoint to get download info
  const apiUrl = `https://api.apkmirror.com/wp-json/apkmirror/posts/1/${apkmirrorPath}/${version}`;

  try {
    const response = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json();
    const downloadUrl = data.downloadUrl;

    if (!downloadUrl) {
      throw new Error('No download URL in API response');
    }

    console.error(`[apkmirror-api-resolve] Got URL: ${downloadUrl}`);
    return { url: downloadUrl, source: 'apkmirror-api' };
  } catch (e) {
    console.error(`[apkmirror-api-resolve] Failed: ${e.message}`);
    throw e;
  }
}

/**
 * Resolve URL using APKMirror Playwright - returns URL only
 * @param {string} packageId - Package ID
 * @param {string} version - Version to resolve
 * @returns {Promise<object>} { url, source }
 */
async function resolveApkmirror(packageId, version) {
  console.error(`[apkmirror-resolve] Resolving ${packageId} v${version}`);

  const apkmirrorPath = getApkmirrorPath(packageId);
  if (!apkmirrorPath) {
    throw new Error(`No APKMirror path for ${packageId}`);
  }

  // Use existing resolveApkmirrorUrl function (it already exists and returns URL)
  const url = await resolveApkmirrorUrl(apkmirrorPath, version);
  console.error(`[apkmirror-resolve] Got URL: ${url}`);

  return { url, source: 'apkmirror' };
}

/**
 * Download APK from a pre-resolved URL
 * @param {string} url - Direct URL to APK
 * @param {string} outputDir - Output directory
 * @param {string} packageId - Package ID
 * @param {string} version - Expected version
 * @returns {Promise<object>} Download result
 */
async function downloadWithUrl(url, outputDir, packageId, version) {
  console.error(`[download-url] Downloading from: ${url}`);

  // Use curl for direct downloads
  const filename = `${packageId}_${version}.apk`;
  const outputPath = path.join(outputDir, filename);

  return new Promise((resolve, reject) => {
    const curl = spawn('curl', ['-L', '-o', outputPath, '-w', '%{http_code}', '--fail', url]);

    let stderr = '';

    curl.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    curl.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`curl failed: ${stderr}`));
        return;
      }

      // Validate downloaded file
      if (!fs.existsSync(outputPath)) {
        reject(new Error('Downloaded file not found'));
        return;
      }

      const stats = fs.statSync(outputPath);
      if (stats.size < 10000) { // Less than 10KB is probably an error
        reject(new Error(`Downloaded file too small: ${stats.size} bytes`));
        return;
      }

      // Validate APK version
      const validation = validateApkVersion(outputPath, version);
      if (!validation.valid) {
        reject(new Error(`VERSION MISMATCH: expected ${version}, got ${validation.version}`));
        return;
      }

      console.error(`[download-url] Downloaded and validated: ${outputPath} (${stats.size} bytes)`);
      resolve({
        success: true,
        path: outputPath,
        filename,
        version: validation.version,
        source: 'direct-url',
        url
      });
    });
  });
}

/**
 * Resolve URLs from all sources in parallel, first valid wins
 * @param {string} packageId - Package ID
 * @param {string} version - Version to resolve
 * @returns {Promise<object>} { url, source }
 */
async function parallelResolveSources(packageId, version) {
  const sources = [
    { name: 'apkeep', fn: () => resolveApkeep(packageId, version) },
    { name: 'apkmirror-api', fn: () => resolveApkmirrorApi(packageId, version) },
    { name: 'apkmirror', fn: () => resolveApkmirror(packageId, version) },
  ];

  const SOURCE_TIMEOUT = 60000; // 60 seconds each

  console.error(`[parallel-resolve] Starting parallel resolution for ${packageId} v${version}`);
  const startTime = Date.now();

  const results = await Promise.allSettled(
    sources.map(async (source) => {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${source.name} timeout`)), SOURCE_TIMEOUT)
      );
      return Promise.race([source.fn(), timeout]);
    })
  );

  const elapsed = Date.now() - startTime;
  console.error(`[parallel-resolve] All sources completed in ${elapsed}ms`);

  // Find first successful resolution
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const sourceName = sources[i].name;

    if (result.status === 'fulfilled' && result.value?.url) {
      console.error(`[parallel-resolve] Winner: ${sourceName}`);
      return { ...result.value, source: result.value.source || sourceName };
    }

    const error = result.reason?.message || 'Unknown error';
    console.error(`[parallel-resolve] ${sourceName} failed: ${error}`);
  }

  throw new Error('All sources failed to resolve URL');
}

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
 * Load config.json
 */
function loadConfig() {
  const configPath = path.join(process.cwd(), 'config.json');
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`Warning: Failed to parse config.json: ${e.message}`);
    return {};
  }
}

/**
 * Check config.json for existing URL matching the version
 */
function loadExistingUrl(packageId, version) {
  const config = loadConfig();

  const downloadUrls = config.download_urls?.[packageId];
  if (!downloadUrls) {
    return null;
  }

  // Check for exact version match only — latest_supported is for a specific old version
  // and cannot be used as a direct download URL for a different version
  if (downloadUrls[version]) {
    console.error(`Found existing URL for version ${version} in config.json`);
    return downloadUrls[version];
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
 * Validate APK version matches expected version using aapt
 * Returns { valid: boolean, actualVersion: string }
 */
function validateApkVersion(apkPath, expectedVersion) {
  try {
    const { execSync } = require("child_process");

    // Try using aapt or aapt2
    const aaptCmd = "aapt";
    let output;
    try {
      output = execSync(`${aaptCmd} dump badging "${apkPath}" 2>/dev/null`, { encoding: "utf8" });
    } catch (e) {
      // Try aapt2
      try {
        output = execSync(`aapt2 dump badging "${apkPath}" 2>/dev/null`, { encoding: "utf8" });
      } catch (e2) {
        console.error(`[validate] No aapt available: ${e2.message}`);
        return { valid: false, actualVersion: "unknown", error: "aapt not available - cannot validate version" };
      }
    }

    // Extract versionName from output
    const match = output.match(/versionName='([^']+)'/);
    const actualVersion = match ? match[1] : null;

    if (!actualVersion) {
      console.error(`[validate] Could not extract version from APK`);
      return { valid: false, actualVersion: "unknown", error: "could not extract version from APK" };
    }

    console.error(`[validate] APK version: ${actualVersion}, expected: ${expectedVersion}`);

    if (actualVersion !== expectedVersion) {
      console.error(`[validate] VERSION MISMATCH! Got ${actualVersion} but wanted ${expectedVersion}`);
      return { valid: false, actualVersion, error: `version mismatch: got ${actualVersion}, wanted ${expectedVersion}` };
    }

    return { valid: true, actualVersion };
  } catch (e) {
    console.error(`[validate] Error validating APK: ${e.message}`);
    return { valid: false, actualVersion: "unknown", error: e.message };
  }
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
  // Use version as-is; APKPure accepts standard version formats
  const versionArg = version;

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
  console.error(`[apkeep] Requesting specific version ${version}...`);
  let apkeepSucceeded = false;
  try {
    await runCommand("apkeep", ["-a", `${packageId}@${versionArg}`, "-d", "apk-pure", outputDir], {
      timeout: 180000
    });

    const apkPath = findApkFile(outputDir);
    if (apkPath) {
      const stats = fs.statSync(apkPath);
      if (stats.size > 1000) {
        console.error(`[apkeep] Downloaded: ${apkPath} (${stats.size} bytes)`);

        // ALWAYS validate the downloaded APK matches requested version
        const validation = validateApkVersion(apkPath, version);
        if (!validation.valid) {
          throw new Error(`VERSION MISMATCH: Downloaded APK v${validation.actualVersion} but wanted v${version}. ${validation.error || "The requested version is not available from APKPure."}`);
        }

        downloadedVersion = version;
        console.error(`[apkeep] Version validated: ${downloadedVersion}`);
        apkeepSucceeded = true;
      }
    }
  } catch (e) {
    console.error(`[apkeep] Failed: ${e.message}`);
  }

  // If apkeep failed or version mismatch, return failure - let caller try other sources
  if (!apkeepSucceeded) {
    throw new Error(`APKPure does not have ${packageId}@${version} - version not available`);
  }

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
 * Check cache for existing APK
 */
function checkCache(packageId, version) {
  if (!fs.existsSync(CACHE_DIR)) {
    return null;
  }

  // Look for files matching the package
  const files = fs.readdirSync(CACHE_DIR);
  const prefix = `${packageId.replace(/\./g, "_")}_v${version}`;

  for (const file of files) {
    if (file.startsWith(prefix)) {
      const filepath = path.join(CACHE_DIR, file);

      // Validate cached APK - check size and magic bytes
      const stats = fs.statSync(filepath);
      if (stats.size < 1000000) {
        console.error(`[cache] Invalid cache (too small): ${filepath}, removing`);
        fs.unlinkSync(filepath);
        continue;
      }

      // Check magic bytes (PK = ZIP/APK)
      const buffer = Buffer.alloc(2);
      const fd = fs.openSync(filepath, 'r');
      fs.readSync(fd, buffer, 0, 2, 0);
      fs.closeSync(fd);

      if (buffer[0] !== 0x50 || buffer[1] !== 0x4B) {
        console.error(`[cache] Invalid cache (not APK): ${filepath}, removing`);
        fs.unlinkSync(filepath);
        continue;
      }

      console.error(`[cache] Found cached APK: ${filepath}`);
      return filepath;
    }
  }

  return null;
}

/**
 * Save to cache
 */
function saveToCache(packageId, version, filepath) {
  // Validate APK before caching - check file size and magic bytes
  if (fs.existsSync(filepath)) {
    const stats = fs.statSync(filepath);
    if (stats.size < 1000000) { // Less than 1MB is suspicious
      console.error(`[cache] Skipping cache - file too small (${stats.size} bytes)`);
      return null;
    }

    // Check magic bytes (PK = ZIP/APK)
    const buffer = Buffer.alloc(2);
    const fd = fs.openSync(filepath, 'r');
    fs.readSync(fd, buffer, 0, 2, 0);
    fs.closeSync(fd);

    if (buffer[0] !== 0x50 || buffer[1] !== 0x4B) {
      console.error(`[cache] Skipping cache - not a valid APK (wrong magic bytes)`);
      return null;
    }
  }

  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  const ext = path.extname(filepath);
  const filename = `${packageId.replace(/\./g, "_")}_v${version}${ext}`;
  const destPath = path.join(CACHE_DIR, filename);

  fs.copyFileSync(filepath, destPath);
  console.error(`[cache] Saved to cache: ${destPath}`);

  // Clean up old versions (keep only latest 2 per package)
  cleanupOldVersions(packageId);
}

/**
 * Clean up old APK versions from cache
 */
function cleanupOldVersions(packageId) {
  if (!fs.existsSync(CACHE_DIR)) {
    return;
  }

  const files = fs.readdirSync(CACHE_DIR);
  const prefix = `${packageId.replace(/\./g, "_")}_v`;

  // Get all versions for this package
  const packageFiles = files
    .filter(f => f.startsWith(prefix) && (f.endsWith(".apk") || f.endsWith(".xapk") || f.endsWith(".apkm")))
    .sort()
    .reverse();

  // Keep only the latest 2 versions
  const toDelete = packageFiles.slice(2);
  for (const file of toDelete) {
    const filepath = path.join(CACHE_DIR, file);
    fs.unlinkSync(filepath);
    console.error(`[cache] Removed old version: ${filepath}`);
  }
}

/**
 * Download using APKMirror API
 */
async function downloadWithApkmirrorApi(packageId, version, outputDir) {
  console.error(`[apkmirror-api] Attempting download for ${packageId} v${version} via API`);

  const apkmirrorPath = getApkmirrorPath(packageId);
  if (!apkmirrorPath) {
    throw new Error(`No APKMirror path configured for ${packageId}`);
  }

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Try to get download URL from APKMirror API
  const apiUrl = `https://www.apkmirror.com/wp-json/apkm/v1/${apkmirrorPath}/${version}`;

  try {
    // Make API request with basic auth
    const auth = Buffer.from(`${APK_MIRROR_API_USER}:${APK_MIRROR_API_PASS}`).toString("base64");

    const response = await fetch(apiUrl, {
      headers: {
        "Authorization": `Basic ${auth}`,
        "Accept": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json();
    const downloadUrl = data.downloadUrl;

    if (!downloadUrl) {
      throw new Error("No download URL in API response");
    }

    console.error(`[apkmirror-api] Got download URL: ${downloadUrl}`);

    // Download the file using curl
    const filename = `${packageId.replace(/\./g, "_")}_v${version}.apk`;
    const outputPath = path.join(outputDir, filename);

    const curlResult = await new Promise((resolve, reject) => {
      const curl = execFile("curl", [
        "-L",
        "-o", outputPath,
        downloadUrl
      ], { timeout: 300000 }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    if (fs.existsSync(outputPath)) {
      const stats = fs.statSync(outputPath);
      console.error(`[apkmirror-api] Downloaded: ${outputPath} (${stats.size} bytes)`);

      // Save to cache
      saveToCache(packageId, version, outputPath);

      return {
        success: true,
        filepath: outputPath,
        version: version,
        source: "apkmirror-api",
        url: downloadUrl
      };
    }

    throw new Error("Download file not found");
  } catch (e) {
    console.error(`[apkmirror-api] Failed: ${e.message}`);
    throw e;
  }
}

/**
 * Download using APKMirror with Playwright
 */
async function downloadWithApkmirror(packageId, version, outputDir) {
  console.error(`[apkmirror] Attempting download for ${packageId} v${version}`);

  const apkmirrorPath = getApkmirrorPath(packageId);
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
  const result = await downloadWithPlaywright(downloadUrl, outputDir, packageId, version);

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
 * Resolve APKMirror direct APK download URL using fetch + cheerio (3-page navigation).
 * Page 1: Release page → find correct arch/DPI/type variant row
 * Page 2: Variant page → find download button
 * Page 3: Download page → find final APK link
 */
async function resolveApkmirrorUrlViaCurl(apkmirrorPath, version, priorities) {
  // Page 1: Release page
  const page1Url = buildReleasePageUrl(apkmirrorPath, version);
  console.error(`[apkmirror-scraper] Page 1 (curl): ${page1Url}`);
  const resp1 = await apkmirrorFetch(page1Url);
  let cookies = collectCookies(resp1);
  const $1 = cheerio.load(await resp1.text());

  const variantHref = selectVariant($1, priorities);

  // Page 2: Variant page
  const page2Url = `https://www.apkmirror.com${variantHref}`;
  console.error(`[apkmirror-scraper] Page 2 (curl): ${page2Url}`);
  const resp2 = await apkmirrorFetch(page2Url, cookies, page1Url);
  cookies = collectCookies(resp2, cookies);
  const $2 = cheerio.load(await resp2.text());

  const downloadButtonHref = $2('a.downloadButton[href]').attr('href');
  if (!downloadButtonHref) {
    throw new Error('Download button not found on APKMirror variant page');
  }

  // Page 3: Download page
  const page3Url = `https://www.apkmirror.com${downloadButtonHref}`;
  console.error(`[apkmirror-scraper] Page 3 (curl): ${page3Url}`);
  const resp3 = await apkmirrorFetch(page3Url, cookies, page2Url);
  cookies = collectCookies(resp3, cookies);
  const $3 = cheerio.load(await resp3.text());

  const finalHref =
    $3('a[data-google-interstitial="false"][href]').attr('href') ||
    $3('a[rel=nofollow][href*=".apk"]').attr('href');

  if (!finalHref) {
    throw new Error('Final APK download link not found on APKMirror download page');
  }

  const finalUrl = finalHref.startsWith('http')
    ? finalHref
    : `https://www.apkmirror.com${finalHref}`;

  console.error(`[apkmirror-scraper] Resolved (curl): ${finalUrl}`);
  return finalUrl;
}

/**
 * Resolve APKMirror download URL using Playwright (Chromium).
 * Used as fallback when curl is blocked by Cloudflare (HTTP 403).
 * Chromium's TLS fingerprint passes bot detection that curl cannot.
 */
async function resolveApkmirrorUrlViaPlaywright(apkmirrorPath, version, priorities) {
  console.error(`[apkmirror-scraper] Using Playwright fallback for ${apkmirrorPath} v${version}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0',
      locale: 'en-US',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'DNT': '1',
      },
    });
    const page = await context.newPage();

    // Page 1: Release page
    const page1Url = buildReleasePageUrl(apkmirrorPath, version);
    console.error(`[apkmirror-scraper] Page 1 (PW): ${page1Url}`);
    await page.goto(page1Url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const html1 = await page.content();
    const $1 = cheerio.load(html1);
    const variantHref = selectVariant($1, priorities);

    // Page 2: Variant page
    const page2Url = `https://www.apkmirror.com${variantHref}`;
    console.error(`[apkmirror-scraper] Page 2 (PW): ${page2Url}`);
    await page.goto(page2Url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const html2 = await page.content();
    const $2 = cheerio.load(html2);
    const downloadButtonHref = $2('a.downloadButton[href]').attr('href');
    if (!downloadButtonHref) throw new Error('Download button not found on APKMirror variant page');

    // Page 3: Download page
    const page3Url = `https://www.apkmirror.com${downloadButtonHref}`;
    console.error(`[apkmirror-scraper] Page 3 (PW): ${page3Url}`);
    await page.goto(page3Url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const html3 = await page.content();
    const $3 = cheerio.load(html3);
    const finalHref =
      $3('a[data-google-interstitial="false"][href]').attr('href') ||
      $3('a[rel=nofollow][href*=".apk"]').attr('href');
    if (!finalHref) throw new Error('Final APK download link not found on APKMirror download page');

    const finalUrl = finalHref.startsWith('http')
      ? finalHref
      : `https://www.apkmirror.com${finalHref}`;
    console.error(`[apkmirror-scraper] Resolved (PW): ${finalUrl}`);
    return finalUrl;
  } finally {
    await browser.close();
  }
}

async function resolveApkmirrorUrl(apkmirrorPath, version) {
  const config = loadConfig();
  const preferredArch = config.preferred_arch || 'arm64-v8a';
  const priorities = buildVariantPriorities(preferredArch);

  // Try curl first (fast, no browser overhead)
  try {
    return await resolveApkmirrorUrlViaCurl(apkmirrorPath, version, priorities);
  } catch (e) {
    // Fall back to Playwright when Cloudflare blocks curl (HTTP 403)
    if (e.message.includes('403')) {
      console.error(`[apkmirror-scraper] curl blocked by Cloudflare, switching to Playwright`);
      return await resolveApkmirrorUrlViaPlaywright(apkmirrorPath, version, priorities);
    }
    throw e;
  }
}

/**
 * Download with Playwright (internal)
 * Improved to handle APKMirror's multi-step download process:
 * 1. Initial download button → 2. Variant selection → 3. Final download
 */
async function downloadWithPlaywright(url, outputDir, packageId, version) {
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
    },
    // Set downloads directory for automatic downloads
    downloadsPath: tempDir
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  // Set up network interception to detect download URLs
  let downloadUrlFromNetwork = null;
  page.on("response", async (response) => {
    const headers = response.headers();
    const contentDisposition = headers["content-disposition"];
    if (contentDisposition && contentDisposition.includes("attachment")) {
      const url = response.url();
      console.error(`[apkmirror] Detected download via network: ${url}`);
      downloadUrlFromNetwork = url;
    }
  });

  // Don't set up download handler yet - we'll do that after trying direct URL extraction

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
    let downloadUrl = null;

    // First, try to extract download URL directly from the page
    // This is more reliable than clicking through the UI
    console.error(`[apkmirror] Trying to extract download URL directly...`);

    // Look for download.php links - APKMirror uses these for actual downloads
    const downloadPhpLinks = await page.$$eval('a[href*="download.php"]', links =>
      links.map(l => l.href).filter(h => h.includes('download.php'))
    );

    if (downloadPhpLinks.length > 0) {
      console.error(`[apkmirror] Found download.php link directly: ${downloadPhpLinks[0]}`);
      downloadUrl = downloadPhpLinks[0];
    }

    // Also check for other download patterns
    if (!downloadUrl) {
      const otherDownloadLinks = await page.$$eval('a[href*="/download/"]', links =>
        links.map(l => l.href).filter(h => !h.includes('#'))
      );
      if (otherDownloadLinks.length > 0) {
        console.error(`[apkmirror] Found direct download link: ${otherDownloadLinks[0]}`);
        downloadUrl = otherDownloadLinks[0];
      }
    }

    // If we found a direct download URL, just log it - we'll use button clicking instead
    // The URL we extracted is time-sensitive and won't work with curl
    if (downloadUrl) {
      console.error(`[apkmirror] Found download URL but will use button clicking for proper session handling`);
    }

    // Set up download handler for button clicking fallback (only needed if direct URL didn't work)
    // Also set up URL change handler to track redirects
    const downloadPromise = context.waitForEvent("download", { timeout: 180000 }); // 3 min timeout for download
    let currentPageUrl = url;

    // Fall back to button clicking if direct URL extraction didn't work
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
    let currentUrl = page.url();
    console.error(`[apkmirror] Current URL after first click: ${currentUrl}`);

    // Handle Google vignette redirect - strip the fragment and reload if needed
    if (currentUrl.includes('#google_vignette') || currentUrl.includes('google_vignette')) {
      console.error(`[apkmirror] Detected Google vignette redirect, cleaning URL...`);
      currentUrl = currentUrl.split('#')[0];
      try {
        await page.goto(currentUrl, { timeout: 60000, waitUntil: "domcontentloaded" });
        await page.waitForTimeout(3000);
        console.error(`[apkmirror] Reloaded clean URL: ${currentUrl}`);
      } catch (e) {
        console.error(`[apkmirror] Reload failed: ${e.message}`);
      }
    }

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
    let finalDownloadUrl = null;
    for (const selector of finalDownloadSelectors) {
      try {
        const btn = await page.$(selector);
        if (btn) {
          const btnText = await btn.textContent();

          // Skip scroll buttons
          if (btnText && btnText.includes('Scroll to available')) {
            console.error(`[apkmirror] Skipping scroll button: ${selector}`);
            continue;
          }

          console.error(`[apkmirror] Clicking final download button: ${selector} (text: ${btnText})`);

          // Track URL before click
          const urlBeforeClick = page.url();

          await btn.click({ timeout: 10000 });
          clickedFinalButton = true;

          // Wait for potential URL change or download
          await page.waitForTimeout(3000);

          // Check if URL changed - this is the actual download URL
          const urlAfterClick = page.url();
          if (urlAfterClick !== urlBeforeClick) {
            console.error(`[apkmirror] URL changed after click: ${urlAfterClick}`);
            // This is the download URL - capture it
            if (urlAfterClick.includes('/download/')) {
              finalDownloadUrl = urlAfterClick;
            }
          }

          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    // If we captured the download URL, try to download using browser cookies
    // This keeps the session alive and should work with the time-sensitive URL
    console.error(`[apkmirror] Final button clicked: ${clickedFinalButton}, finalDownloadUrl: ${finalDownloadUrl ? 'set' : 'null'}`);
    if (finalDownloadUrl) {
      console.error(`[apkmirror] Attempting download with browser cookies: ${finalDownloadUrl}`);
      try {
        // Get cookies from the current context
        const cookies = await context.cookies();
        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

        // Download using fetch with cookies
        const filename = `${packageId.replace(/\./g, "_")}_v${version}.apk`;
        const downloadPath = path.join(tempDir, filename);

        const response = await fetch(finalDownloadUrl, {
          headers: {
            'User-Agent': UA,
            'Accept': '*/*',
            'Cookie': cookieHeader,
            'Referer': url
          }
        });

        if (response.ok) {
          const buffer = await response.arrayBuffer();
          fs.writeFileSync(downloadPath, Buffer.from(buffer));

          const stats = fs.statSync(downloadPath);
          if (stats.size > 1000000) {
            console.error(`[apkmirror] Downloaded via fetch with cookies: ${downloadPath} (${stats.size} bytes)`);

            // Copy to output dir
            const finalPath = path.join(outputDir, filename);
            fs.copyFileSync(downloadPath, finalPath);

            await browser.close();
            const cachePath = saveToCache(packageId, version, finalPath);
            return { success: true, path: finalPath, filename };
          } else {
            console.error(`[apkmirror] Downloaded file too small (${stats.size} bytes)`);
          }
        } else {
          console.error(`[apkmirror] Fetch failed: ${response.status} ${response.statusText}`);
        }
      } catch (e) {
        console.error(`[apkmirror] Fetch with cookies failed: ${e.message}`);
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
      console.error(`[apkmirror] Download event timed out, trying to extract download URL...`);

      // First check if we captured a download URL via network interception
      if (downloadUrlFromNetwork) {
        console.error(`[apkmirror] Using download URL from network interception: ${downloadUrlFromNetwork}`);
        try {
          const filename = `${packageId.replace(/\./g, "_")}_v${version}.apk`;
          const downloadPath = path.join(outputDir, filename);

          await new Promise((resolve, reject) => {
            const curl = execFile("curl", [
              "-L",
              "-o", downloadPath,
              "-A", UA,
              "-H", "Accept: */*",
              "-H", "Referer: " + url,
              downloadUrlFromNetwork
            ], { timeout: 300000 }, (error) => {
              if (error) reject(error);
              else resolve();
            });
          });

          if (fs.existsSync(downloadPath)) {
            const stats = fs.statSync(downloadPath);
            if (stats.size > 1000000) { // At least 1MB
              console.error(`[apkmirror] Downloaded via network interception: ${downloadPath} (${stats.size} bytes)`);
              await browser.close();
              return { success: true, path: downloadPath, filename };
            }
          }
        } catch (e) {
          console.error(`[apkmirror] Network interception download failed: ${e.message}`);
        }
      }

      // Try to extract the download URL directly from the page
      try {
        // Look for the actual download link in the page
        const downloadLink = await page.$('a[href*="/download/"]');
        if (downloadLink) {
          const href = await downloadLink.getAttribute('href');
          console.error(`[apkmirror] Found download URL in page: ${href}`);

          // Download using curl instead
          const filename = `${path.basename(outputDir)}_download.apk`;
          const downloadPath = path.join(outputDir, filename);

          await new Promise((resolve, reject) => {
            const curl = execFile("curl", [
              "-L",
              "-o", downloadPath,
              "-A", UA,
              "-H", "Accept: */*",
              "-H", "Referer: " + page.url(),
              href
            ], { timeout: 300000 }, (error) => {
              if (error) reject(error);
              else resolve();
            });
          });

          if (fs.existsSync(downloadPath)) {
            const stats = fs.statSync(downloadPath);
            console.error(`[apkmirror] Downloaded via extracted URL: ${downloadPath} (${stats.size} bytes)`);
            return { success: true, path: downloadPath, filename: path.basename(downloadPath) };
          }
        }
      } catch (extractError) {
        console.error(`[apkmirror] Failed to extract URL: ${extractError.message}`);
      }

      // Fallback: try to find countdown and wait
      try {
        const pageContent = await page.content();
        if (pageContent.includes("countdown") || pageContent.includes("seconds")) {
          console.error(`[apkmirror] Countdown detected, waiting...`);
          await page.waitForTimeout(30000);
          const retryBtn = await page.$("a.downloadButton, a:has-text('Download')");
          if (retryBtn) {
            const newDownloadPromise = context.waitForEvent("download", { timeout: 120000 });
            await retryBtn.click();
            download = await newDownloadPromise;
          }
        }
      } catch (e) {
        // Ignore
      }

      if (!download) {
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
/**
 * Main download function with improved reliability:
 * 1. Check URL cache -> if valid, use directly
 * 2. Check patches.json -> if has URL, verify and use
 * 3. Parallel resolution -> first valid URL wins
 * 4. Download from URL
 * 5. Save to cache on success
 * 6. Fallback to sequential on all parallel fail
 */
async function download(packageId, version, outputDir) {
  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Step 1: Check URL cache
  const cachedUrl = getCachedUrl(packageId, version);
  if (cachedUrl) {
    console.error(`[download] Trying cache for ${packageId} v${version}`);
    try {
      const isValid = await verifyUrl(cachedUrl.url);
      if (isValid) {
        const result = await downloadWithUrl(cachedUrl.url, outputDir, packageId, version);
        // Update cache with incremented download count
        saveCachedUrl(packageId, version, cachedUrl.url, cachedUrl.source);
        return result;
      }
    } catch (e) {
      console.error(`[download] Cache URL invalid: ${e.message}`);
    }
  }

  // Step 2: Check patches.json for existing URL
  const existingUrl = loadExistingUrl(packageId, version);
  if (existingUrl) {
    console.error(`[download] Trying patches.json URL for ${packageId} v${version}`);
    try {
      const isValid = await verifyUrl(existingUrl);
      if (isValid) {
        const result = await downloadWithUrl(existingUrl, outputDir, packageId, version);
        // Save to our URL cache
        saveCachedUrl(packageId, version, existingUrl, 'patches.json');
        return result;
      }
    } catch (e) {
      console.error(`[download] patches.json URL invalid: ${e.message}`);
    }
  }

  // Step 3: Try parallel resolution
  console.error(`[download] Starting parallel resolution for ${packageId} v${version}`);
  try {
    const resolved = await parallelResolveSources(packageId, version);
    const result = await downloadWithUrl(resolved.url, outputDir, packageId, version);
    // Save to URL cache
    saveCachedUrl(packageId, version, resolved.url, resolved.source);
    return result;
  } catch (e) {
    console.error(`[download] Parallel resolution failed: ${e.message}`);
  }

  // Step 4: Fallback to sequential (existing behavior)
  console.error(`[download] Falling back to sequential resolution`);

  // Try apkeep
  console.error(`[apkeep] Attempting download for ${packageId} v${version}`);
  try {
    const result = await downloadWithApkeep(packageId, version, outputDir);
    const url = result.url || `apkeep:${packageId}@${version}`;
    saveCachedUrl(packageId, version, url, 'apkeep');
    return result;
  } catch (e) {
    console.error(`[apkeep] Failed: ${e.message}`);
  }

  // Try APKMirror API
  console.error(`[apkmirror-api] Attempting download for ${packageId} v${version} via API`);
  try {
    const result = await downloadWithApkmirrorApi(packageId, version, outputDir);
    saveCachedUrl(packageId, version, result.url, 'apkmirror-api');
    return result;
  } catch (e) {
    console.error(`[apkmirror-api] Failed: ${e.message}`);
  }

  // Try APKMirror Playwright - last resort
  console.error(`[apkmirror] Starting APKMirror Playwright fallback...`);
  try {
    const result = await downloadWithApkmirror(packageId, version, outputDir);
    saveCachedUrl(packageId, version, result.url, 'apkmirror');
    return result;
  } catch (e) {
    console.error(`[apkmirror] Failed: ${e.message}`);
    throw e;
  }
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

// Guard: only run main() when executed directly, not when require()'d by tests
if (require.main === module) {
  main();
}

// Export helpers for testing and external use
module.exports = {
  buildReleasePageUrl,
  buildVariantPriorities,
  selectVariant,
  collectCookies,
  resolveApkmirrorUrl,
};
