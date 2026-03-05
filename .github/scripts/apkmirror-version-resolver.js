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

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

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
  
  const versionSlug = targetVersion.replace(/\./g, "-");
  
  const launchOptions = {
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
  };
  if (browserBin) {
    launchOptions.executablePath = browserBin;
  }
  
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    userAgent: UA,
    locale: "en-US",
    extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" }
  });
  const page = await context.newPage();
  
  console.error(`Navigating to ${appUrl}`);
  await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);
  
  const versionLinkSelector = `a[href*="/${versionSlug}-release/"]`;
  let versionLink = await page.$(versionLinkSelector);
  
  if (!versionLink) {
    const allLinks = await page.evaluate(() => {
      const links = [];
      document.querySelectorAll("a[href]").forEach(a => {
        links.push(a.getAttribute("href"));
      });
      return links;
    });
    
    const versionRegex = new RegExp(`/${versionSlug}[-/]`, "i");
    for (const link of allLinks) {
      if (versionRegex.test(link)) {
        const fullUrl = absUrl(link, baseUrl);
        if (fullUrl.includes("-release/") || fullUrl.includes("/" + versionSlug)) {
          versionLink = fullUrl;
          break;
        }
      }
    }
  }
  
  let versionUrl = "";
  if (versionLink) {
    versionUrl = typeof versionLink === "string" ? versionLink : await versionLink.getAttribute("href");
    versionUrl = absUrl(versionUrl, baseUrl);
  }
  
  if (!versionUrl) {
    await browser.close();
    throw new Error(`Could not find version ${targetVersion} on APKMirror`);
  }
  
  console.error(`Found version page: ${versionUrl}`);
  await page.goto(versionUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);
  
  const variants = await page.evaluate(() => {
    const results = [];
    
    const variantRows = document.querySelectorAll(".variant-row, .apkm-variant-row, table tr[data-href]");
    
    if (variantRows.length === 0) {
      const allLinks = document.querySelectorAll("a[href*='variant']");
      allLinks.forEach(a => {
        const href = a.getAttribute("href");
        const text = a.textContent || "";
        if (href && (text.includes("arm") || text.includes("dpi"))) {
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
  
  let bestVariant = null;
  let bestScore = -1;
  let bestUrl = "";
  
  for (const v of variants) {
    const text = v.text.toLowerCase();
    const href = absUrl(v.href, baseUrl);
    
    let arch = "unknown";
    let dpi = "unknown";
    
    if (text.includes("arm64-v8a")) arch = "arm64-v8a";
    else if (text.includes("armv7") || text.includes("armeabi-v7a")) arch = "armeabi-v7a";
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
  
  console.error(`Best variant: ${bestVariant.arch} ${bestVariant.dpi} (score: ${bestScore})`);
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
