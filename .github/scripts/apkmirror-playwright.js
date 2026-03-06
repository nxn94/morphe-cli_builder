#!/usr/bin/env node

/**
 * APKMirror Downloader using Playwright
 * Downloads APK files from APKMirror using Playwright to bypass Cloudflare
 */

const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
if (args.length < 4) {
  console.error("Usage: apkmirror-playwright.js <download_url> <browser_path> <meta_file> <output_file>");
  console.error("Example: apkmirror-playwright.js https://www.apkmirror.com/apk/... /usr/bin/chromium meta.json output.apk");
  process.exit(2);
}

const [downloadUrl, browserPath, metaFile, outputFile] = args;

// User agent for Playwright
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function waitForCloudflare(page, timeout = 30000) {
  console.error("Waiting for Cloudflare to pass...");
  
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const title = await page.title();
    
    // Check if we're past Cloudflare
    if (!title.includes("Just a moment") && !title.includes("cloudflare") && !title.includes("Checking your browser")) {
      await page.waitForTimeout(3000);
      console.error("Cloudflare challenge passed");
      return true;
    }
    
    console.error(`Still on Cloudflare page: ${title}`);
    await page.waitForTimeout(2000);
  }
  
  return false;
}

async function downloadWithPlaywright(url, browserPath) {
  console.error(`Downloading APK from: ${url}`);
  
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
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
    
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
    
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
    console.error(`Navigating to: ${url}`);
    
    // Navigate to the download page
    const response = await page.goto(url, { 
      timeout: 90000,
      waitUntil: 'domcontentloaded'
    });
    
    console.error(`Initial response status: ${response?.status()}`);
    
    // Wait for Cloudflare challenge
    await waitForCloudflare(page, 60000);
    
    const pageTitle = await page.title();
    console.error(`Page title: ${pageTitle}`);
    
    if (pageTitle.includes('Just a moment')) {
      throw new Error("Cloudflare challenge failed");
    }
    
    let downloadStarted = false;
    let finalUrl = url;
    let filename = "app.apk";
    
    // Check if we're on a redirect page with download button
    const downloadButtonSelectors = [
      'a.btn.btn-flat.download-btn',
      'a[data-track="Download"]', 
      'a.download-button',
      'a[class*="download"]',
      'a[href*="download"]'
    ];
    
    for (const selector of downloadButtonSelectors) {
      const downloadButton = await page.$(selector);
      if (downloadButton) {
        console.error(`Found download button with selector: ${selector}, clicking...`);
        await downloadButton.click();
        
        // Wait for redirect
        await page.waitForTimeout(5000);
        finalUrl = page.url();
        console.error(`Redirected to: ${finalUrl}`);
        break;
      }
    }
    
    // Try to find the actual APK download link
    const apkLinkSelectors = [
      'a[href*="android-apkdownload"]',
      'a[href$=".apk"]',
      'a[class*="download"]'
    ];
    
    for (const selector of apkLinkSelectors) {
      const apkLink = await page.$(selector);
      if (apkLink) {
        const href = await apkLink.getAttribute('href');
        if (href && (href.startsWith('http') || href.includes('apk'))) {
          finalUrl = href.startsWith('http') ? href : new URL(href, url).href;
          console.error(`Found direct APK link: ${finalUrl}`);
          break;
        }
      }
    }
    
    // Extract filename from URL or page
    try {
      const urlParts = finalUrl.split('/');
      for (let i = urlParts.length - 1; i >= 0; i--) {
        if (urlParts[i] && urlParts[i].includes('.apk')) {
          filename = urlParts[i];
          break;
        }
      }
    } catch (e) {
      console.error(`Could not extract filename: ${e.message}`);
    }
    
    // If we have a direct URL, try to download it
    if (finalUrl && (finalUrl.includes('.apk') || finalUrl.includes('download'))) {
      try {
        console.error(`Attempting to download from: ${finalUrl}`);
        
        const downloadResponse = await page.request.get(finalUrl, { 
          timeout: 120000,
          headers: {
            'User-Agent': UA,
            'Accept': '*/*',
            'Referer': url
          }
        });
        
        if (downloadResponse.ok()) {
          const buffer = await downloadResponse.body();
          fs.writeFileSync(outputFile, buffer);
          console.error(`Downloaded ${buffer.length} bytes to ${outputFile}`);
          downloadStarted = true;
        } else {
          console.error(`Download failed with status: ${downloadResponse.status()}`);
        }
      } catch (e) {
        console.error(`Direct download failed: ${e.message}`);
      }
    }
    
    // Write metadata
    const meta = {
      url: url,
      final_url: finalUrl,
      filename: filename,
      downloaded: downloadStarted,
      via: "playwright-stealth"
    };
    
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    
    if (!downloadStarted) {
      throw new Error("Failed to download APK - Cloudflare may be blocking requests");
    }
    
    return { success: true, filename, path: outputFile };
  } finally {
    await browser.close();
  }
}

downloadWithPlaywright(downloadUrl, browserPath)
  .then(result => {
    console.error(`Download complete: ${result.filename}`);
    process.exit(0);
  })
  .catch(err => {
    console.error(`Download failed: ${err.message}`);
    // Write error metadata
    fs.writeFileSync(metaFile, JSON.stringify({ error: err.message, downloaded: false }, null, 2));
    process.exit(1);
  });
