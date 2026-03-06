#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error("Usage: apkmirror-version-resolver.js <package_id> <target_version> <arch> [browser_bin]");
  console.error("Example: apkmirror-version-resolver.js com.google.android.youtube 21.09.266 arm64-v8a /usr/bin/chromium");
  process.exit(2);
}

const [packageId, targetVersion, preferredArch, browserBin] = args;

// More realistic user agent to bypass Cloudflare
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

async function waitForCloudflare(page, timeout = 30000) {
  try {
    // Wait for Cloudflare challenge to complete
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const title = await page.title();
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
      
      // Check if we're on a Cloudflare challenge page
      if (title.includes("Cloudflare") || bodyText.includes("Just a moment")) {
        console.error("Cloudflare challenge detected, waiting...");
        await page.waitForTimeout(2000);
        continue;
      }
      
      // Check if we have actual content
      if (title.includes("APKMirror") || title.includes("YouTube") || bodyText.length > 100) {
        console.error("Cloudflare challenge passed!");
        break;
      }
      
      await page.waitForTimeout(1000);
    }
  } catch (e) {
    console.error("Error waiting for Cloudflare:", e.message);
  }
}

function absUrl(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return "";
  }
}

function scoreVariant(arch, dpi, preferredArch) {
  let archScore = 0;
  const archLower = arch.toLowerCase();
  
  if (archLower === preferredArch) {
    archScore = 1000;
  } else if (archLower.includes(preferredArch)) {
    archScore = 800;
  } else if (archLower === "arm64-v8a" && preferredArch === "armeabi-v7a") {
    archScore = 500;
  } else if (archLower.includes("arm64-v8a")) {
    archScore = 400;
  } else if (archLower.includes("armeabi-v7a")) {
    archScore = 300;
  } else if (archLower.includes("arm")) {
    archScore = 100;
  } else {
    archScore = 10;
  }
  
  let dpiScore = 0;
  const dpiLower = dpi.toLowerCase();
  
  if (dpiLower === "nodpi") {
    dpiScore = 500;
  } else if (dpiLower.match(/^(\d+)$/)) {
    const dpiNum = parseInt(dpiLower);
    dpiScore = dpiNum;
  } else if (dpiLower.includes("-")) {
    const match = dpiLower.match(/(\d+)-(\d+)/);
    if (match) {
      const max = parseInt(match[2]);
      dpiScore = max;
    }
  }
  
  return archScore + dpiScore;
}

async function resolveApkUrl(packageId, targetVersion, preferredArch) {
  const configPath = path.join(process.cwd(), "patches.json");
  let apkmirrorPaths = {};
  
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    apkmirrorPaths = config.__morphe?.apkmirror_paths || {};
  } catch (e) {
    console.error(`Warning: Could not read patches.json: ${e.message}`);
  }
  
  const appPath = apkmirrorPaths[packageId];
  if (!appPath) {
    throw new Error(`No APKMirror path configured for ${packageId}`);
  }
  
  const baseUrl = "https://www.apkmirror.com";
  const appUrl = `${baseUrl}/apk/${appPath}/`;
  
  // Convert version to various slug formats (e.g., 20.31.42 -> 20-31-42, 20-31-420, etc.)
  const versionParts = targetVersion.split(".");
  const versionSlugBase = versionParts.join("-");
  const versionSlugs = [
    versionSlugBase,
    versionSlugBase + "0", // 20.31.42 -> 20-31-420
    versionSlugBase.replace(/-(\d+)$/, "-$10"), // Handle trailing zeros
    // Also handle cases like 20.44.38 -> 20-44-38 (common APKMirror format)
    targetVersion.replace(/\./g, "-"),
    // Handle version with trailing zero: 20.44.38 -> 20-44-380
    versionSlugBase + "0",
  ];
  
  const launchOptions = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-setuid-sandbox",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process"
    ]
  };
  if (browserBin) {
    launchOptions.executablePath = browserBin;
  }
  
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    userAgent: UA,
    locale: "en-US",
    viewport: { width: 1920, height: 1080 },
    timezoneId: "America/New_York",
    extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" }
  });
  const page = await context.newPage();
  
  // Add stealth scripts to avoid detection
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });
  
  console.error(`Navigating to ${appUrl}`);
  await page.goto(appUrl, { waitUntil: "networkidle", timeout: 90000 });
  
  // Try to click through any Cloudflare challenge
  try {
    const challengeBtn = await page.$("#challenge-run");
    if (challengeBtn) {
      console.error("Clicking Cloudflare challenge button...");
      await challengeBtn.click();
      await page.waitForTimeout(5000);
    }
  } catch (e) {
    // Ignore if no challenge button
  }
  
  // Wait for Cloudflare to pass
  await waitForCloudflare(page);

  
  // Wait for Cloudflare challenge to complete
  await waitForCloudflare(page);
  await page.waitForTimeout(3000);
  
  // Try to find the version link using multiple slug variations

  let versionUrl = "";
  
  for (const slug of versionSlugs) {
    const versionLinkSelector = `a[href*="/${slug}-release/"]`;
    let versionLink = await page.$(versionLinkSelector);
    
    if (versionLink) {
      versionUrl = await versionLink.getAttribute("href");
      versionUrl = absUrl(versionUrl, baseUrl);
      if (versionUrl) break;
    }
  }
  
  // If selector didn't work, try scanning all links on the page
  if (!versionUrl) {
    const allLinks = await page.evaluate(() => {
      const links = [];
      document.querySelectorAll("a[href]").forEach(a => {
        links.push(a.getAttribute("href"));
      });
      return links;
    });
    
    // Try each slug variant
    for (const slug of versionSlugs) {
      const versionRegex = new RegExp(`/${slug}[-/]`, "i");
      for (const link of allLinks) {
        if (versionRegex.test(link)) {
          const fullUrl = absUrl(link, baseUrl);
          if (fullUrl && (fullUrl.includes("-release/") || fullUrl.includes("/" + slug))) {
            versionUrl = fullUrl;
            break;
          }
        }
      }
      if (versionUrl) break;
    }
  }
  
  // Last resort: try to find any link that contains the version number (with dots or dashes)
  if (!versionUrl) {
    const allLinks = await page.evaluate(() => {
      const links = [];
      document.querySelectorAll("a[href]").forEach(a => {
        links.push({ href: a.getAttribute("href"), text: a.textContent });
      });
      return links;
    });
    
    const versionWithDots = targetVersion;
    const versionWithDashes = targetVersion.replace(/\./g, "-");
    
    for (const link of allLinks) {
      const href = link.href || "";
      const text = link.text || "";
      // Check both href and text content for the version
      if ((href.includes(versionWithDots) || href.includes(versionWithDashes) ||
           text.includes(versionWithDots) || text.includes(versionWithDashes)) &&
          (href.includes("-release/") || href.includes("/download"))) {
        versionUrl = absUrl(href, baseUrl);
        if (versionUrl) break;
      }
    }
  }
  
  // If exact version not found, find the closest available version
  if (!versionUrl) {
    console.error(`Exact version ${targetVersion} not found, searching for closest version...`);
    
    const allLinks = await page.evaluate((appPath) => {
      const results = [];
      document.querySelectorAll("a[href]").forEach(a => {
        const href = a.getAttribute("href") || "";
        const text = a.textContent || "";
        // Look for version links (ending in -release)
        if (href.includes("-release") && href.includes(appPath)) {
          // Extract version from URL: youtube-20-47-45-release -> 20.47.45
          const match = href.match(/([\d]+)-(\d+)-(\d+)-release/);
          if (match) {
            results.push({
              href: href,
              version: `${match[1]}.${match[2]}.${match[3]}`
            });
          }
        }
      });
      return results;
    }, appPath);
    
    if (allLinks.length > 0) {
      // Sort by version (newest first)
      const targetParts = targetVersion.split(".").map(Number);
      allLinks.sort((a, b) => {
        const aParts = a.version.split(".").map(Number);
        const bParts = b.version.split(".").map(Number);
        // Compare versions numerically
        for (let i = 0; i < 3; i++) {
          if (aParts[i] !== bParts[i]) {
            return bParts[i] - aParts[i]; // Descending (newest first)
          }
        }
        return 0;
      });
      
      // Find the closest version - prefer newest that's close to target, or just newest if none close
      let bestMatch = null;
      
      // First try to find a version <= targetVersion
      for (const v of allLinks) {
        const vParts = v.version.split(".").map(Number);
        let isValid = true;
        for (let i = 0; i < 3; i++) {
          if (vParts[i] > targetParts[i]) {
            isValid = false;
            break;
          }
        }
        if (isValid) {
          bestMatch = v;
          break; // Since sorted newest first, first valid is best
        }
      }
      
      // If no version <= target, use the newest available version
      if (!bestMatch && allLinks.length > 0) {
        bestMatch = allLinks[0];
        console.error(`Warning: No version <= ${targetVersion}, using newest available: ${bestMatch.version}`);
      }
      
      if (bestMatch) {
        versionUrl = absUrl(bestMatch.href, baseUrl);
        console.error(`Found version: ${bestMatch.version} (requested: ${targetVersion})`);
      }
    }
  }
  
  if (!versionUrl) {
    await browser.close();
    throw new Error(`Could not find version ${targetVersion} or any close version on APKMirror`);
  }

  
  console.error(`Found version page: ${versionUrl}`);
  await page.goto(versionUrl, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(3000);
  
  // First try the standard variant selector
  let variants = await page.evaluate(() => {
    const results = [];
    
    const variantRows = document.querySelectorAll(".variant-row, .apkm-variant-row, table tr[data-href]");
    
    if (variantRows.length === 0) {
      // Try alternative selectors
      const allLinks = document.querySelectorAll("a[href*='download']");
      allLinks.forEach(a => {
        const href = a.getAttribute("href");
        const text = a.textContent || "";
        if (href) {
          results.push({ href, text });
        }
      });
    } else {
      variantRows.forEach(row => {
        const link = row.querySelector("a[href*='download']") || row.querySelector("a");
        const href = link ? link.getAttribute("href") : "";
        const text = row.textContent || "";
        results.push({ href, text });
      });
    }
    
    return results;
  });
  
  console.error(`Found ${variants.length} variant entries`);
  
  // If no variants found, try to get download link directly from the page
  if (variants.length === 0) {
    console.error("No variants found, looking for direct download link...");
    
    // Look for any download link on the page
    const downloadLinks = await page.evaluate(() => {
      const results = [];
      const allLinks = document.querySelectorAll("a[href]");
      allLinks.forEach(a => {
        const href = a.getAttribute("href") || "";
        const text = a.textContent || "";
        // Look for download links
        if (href.includes("download") || text.toLowerCase().includes("download") || href.includes(".apk")) {
          results.push({ href, text });
        }
      });
      return results;
    });
    
    if (downloadLinks.length > 0) {
      variants = downloadLinks;
      console.error(`Found ${variants.length} direct download links`);
    }
  }
  
  let bestVariant = null;
  let bestScore = -1;
  let bestUrl = "";
  
  for (const v of variants) {
    const text = v.text.toLowerCase();
    const href = absUrl(v.href, baseUrl);
    
    if (!href) continue;
    
    let arch = "unknown";
    let dpi = "unknown";
    
    if (text.includes("arm64-v8a") || text.includes("arm64")) arch = "arm64-v8a";
    else if (text.includes("armv7") || text.includes("armeabi-v7a") || text.includes("arm v7")) arch = "armeabi-v7a";
    else if (text.includes("armeabi")) arch = "armeabi";
    else if (text.includes("x86_64")) arch = "x86_64";
    else if (text.includes("x86")) arch = "x86";
    
    if (text.includes("nodpi")) dpi = "nodpi";
    else if (text.match(/(\d+)-(\d+)/)) {
      const match = text.match(/(\d+)-(\d+)/);
      dpi = match[0];
    } else if (text.match(/(\d+)dpi/)) {
      dpi = text.match(/(\d+)dpi/)[1];
    }
    
    const score = scoreVariant(arch, dpi, preferredArch);
    
    if (score > bestScore && href) {
      bestScore = score;
      bestVariant = { arch, dpi, text: v.text };
      bestUrl = href;
    }
  }
  
  if (!bestUrl) {
    await browser.close();
    throw new Error(`No suitable variant found for ${targetVersion}`);
  }
  
  console.error(`Best variant: ${bestVariant?.arch || 'unknown'} ${bestVariant?.dpi || 'unknown'} (score: ${bestScore})`);
  console.error(`Variant URL: ${bestUrl}`);
  
  await page.goto(bestUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  
  const downloadBtnSelector = "a[data-giturl], a[href*='download.php'], a.downloadBtn";
  let downloadPageUrl = await page.$eval(downloadBtnSelector, el => el.getAttribute("href")).catch(() => "");
  
  if (!downloadPageUrl) {
    const links = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("a[href]").forEach(a => {
        const h = a.getAttribute("href");
        if (h && (h.includes("download") || h.includes(".apk"))) {
          out.push(h);
        }
      });
      return out;
    });
    
    for (const link of links) {
      if (link.includes("download.php") || link.includes("/download/")) {
        downloadPageUrl = link;
        break;
      }
    }
  }
  
  downloadPageUrl = absUrl(downloadPageUrl, baseUrl);
  
  if (!downloadPageUrl) {
    await browser.close();
    throw new Error("Could not find download page");
  }
  
  console.error(`Download page: ${downloadPageUrl}`);
  await page.goto(downloadPageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  
  let finalDownloadUrl = "";
  
  const directDownloadRe = /\/download\.php\?id=\d+/i;
  const downloadLinks = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("a[href]").forEach(a => {
      const h = a.getAttribute("href");
      if (h) out.push(h);
    });
    return out;
  });
  
  for (const link of downloadLinks) {
    if (directDownloadRe.test(link)) {
      finalDownloadUrl = absUrl(link, baseUrl);
      break;
    }
  }
  
  if (!finalDownloadUrl) {
    const greenButton = await page.$("a.green-btn, .green-btn a, a[class*='green'], #downloadButton");
    if (greenButton) {
      const btnHref = await greenButton.getAttribute("href");
      if (btnHref) {
        finalDownloadUrl = absUrl(btnHref, baseUrl);
      }
    }
  }
  
  await browser.close();
  
  if (!finalDownloadUrl) {
    throw new Error("Could not extract final download URL");
  }
  
  return {
    download_url: finalDownloadUrl,
    version: targetVersion,
    arch: bestVariant.arch,
    dpi: bestVariant.dpi
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
