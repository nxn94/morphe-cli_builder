#!/usr/bin/env node

/**
 * APKMirror Version Resolver using Playwright
 * Finds the download URL for a specific app version on APKMirror
 * Uses stealth settings to bypass Cloudflare protection
 */

const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error("Usage: apkmirror-version-resolver.js <package_id> <target_version> <arch>");
  console.error("Example: apkmirror-version-resolver.js com.google.android.youtube 21.09.266 arm64-v8a");
  process.exit(2);
}

const [packageId, targetVersion, preferredArch, browserPath] = args;

// User agent for Playwright - use a real browser UA
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function waitForCloudflare(page, timeout = 30000) {
  console.error("Waiting for Cloudflare to pass...");
  
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const title = await page.title();
    const url = page.url();
    
    // Check if we're past Cloudflare
    if (!title.includes("Just a moment") && !title.includes("cloudflare") && !title.includes("Checking your browser")) {
      // Wait a bit more for content to load
      await page.waitForTimeout(3000);
      console.error("Cloudflare challenge passed");
      return true;
    }
    
    console.error(`Still on Cloudflare page: ${title}`);
    await page.waitForTimeout(2000);
  }
  
  return false;
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
  
  // Launch browser with stealth settings
  const browserOptions = {
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox', 
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--allow-running-insecure-content',
      '--ignore-certificate-errors',
      '--ignore-ssl-errors',
      '--ignore-certificate-errors-spki-list'
    ]
  };
  if (browserPath) {
    browserOptions.executablePath = browserPath;
  }
  
  const browser = await chromium.launch(browserOptions);
  
  // Create context with stealth settings
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: [],
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    }
  });
  
  // Add stealth script to hide automation
  await context.addInitScript(() => {
    // Overwrite webdriver property
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
    
    // Overwrite plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    
    // Overwrite languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
    
    // Add chrome runtime
    window.chrome = { runtime: {} };
  });
  
  const page = await context.newPage();
  
  // Enable console logging from the page
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.error(`Page error: ${msg.text()}`);
    }
  });
  
  try {
    console.error(`Navigating to version page: ${versionPageUrl}`);
    
    // Navigate and wait for Cloudflare
    const response = await page.goto(versionPageUrl, { 
      timeout: 90000,
      waitUntil: 'networkidle'
    });
    
    console.error(`Initial page status: ${response?.status()}`);
    
    // Wait for Cloudflare challenge
    const cloudflarePassed = await waitForCloudflare(page, 60000);
    
    if (!cloudflarePassed) {
      throw new Error("Cloudflare challenge failed to pass");
    }
    
    // Check page status after Cloudflare
    const pageTitle = await page.title();
    console.error(`Page title after Cloudflare: ${pageTitle}`);
    
    // If we got a 404 or error page, the version doesn't exist
    if (pageTitle.includes('404') || pageTitle.includes('Not Found') || pageTitle.includes('error404')) {
      throw new Error(`Version ${targetVersion} not found on APKMirror (404)`);
    }
    
    // Try variant numbers 1-15 to find a working APK
    const variantNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    
    let downloadUrl = null;
    let foundVariant = null;
    
    for (const variantNum of variantNumbers) {
      const variantUrl = `${versionPageUrl}${appName}-${versionSlug}-${variantNum}-android-apk-download/`;
      console.error(`Trying variant ${variantNum}: ${variantUrl}`);
      
      try {
        // Navigate to the variant URL in browser
        const variantResponse = await page.goto(variantUrl, {
          timeout: 60000,
          waitUntil: 'networkidle'
        });
        
        // Wait for Cloudflare on variant page
        await waitForCloudflare(page, 30000);
        
        const variantStatus = variantResponse?.status();
        const variantTitle = await page.title();
        
        console.error(`  Variant ${variantNum} status: ${variantStatus}, title: ${variantTitle.substring(0, 50)}`);
        
        // Check if we got a valid page (not 404 or Cloudflare)
        if (variantStatus === 200 && 
            !variantTitle.includes('404') && 
            !variantTitle.includes('Not Found') &&
            !variantTitle.includes('Just a moment')) {
          downloadUrl = variantUrl;
          foundVariant = variantNum;
          console.error(`Found working variant: ${variantNum}`);
          break;
        }
      } catch (e) {
        console.error(`Variant ${variantNum} failed: ${e.message}`);
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
  } finally {
    await browser.close();
  }
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
