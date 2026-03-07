#!/usr/bin/env node

/**
 * APKMirror Downloader using Playwright
 * Uses Playwright's built-in download handling to get the APK
 */

const { chromium } = require("playwright");
const fs = require("node:fs");

const args = process.argv.slice(2);
if (args.length < 4) {
  console.error("Usage: apkmirror-playwright.js <download_url> <browser_path> <meta_file> <output_file>");
  process.exit(2);
}

const [downloadUrl, browserPath, metaFile, outputFile] = args;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function waitForCloudflare(page, timeout = 30000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const title = await page.title();
    if (!title.includes("Just a moment") && !title.includes("cloudflare") && !title.includes("Checking your browser")) {
      await page.waitForTimeout(2000);
      return true;
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

async function dismissConsentPopup(page) {
  const selectors = [
    '#qc-cmp2-container button[mode="primary"]',
    '#qc-cmp2-container button:has-text("Accept")',
    '#qc-cmp2-container button:has-text("I Agree")',
    'button:has-text("Accept All")',
    'button:has-text("Agree")'
  ];
  
  for (const selector of selectors) {
    try {
      const btn = await page.$(selector);
      if (btn) {
        console.error(`Dismissing consent popup with: ${selector}`);
        await btn.click();
        await page.waitForTimeout(1000);
        return true;
      }
    } catch (e) {}
  }
  
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  } catch (e) {}
  
  return false;
}

async function downloadWithPlaywright(url, browserPath) {
  console.error(`Downloading APK from: ${url}`);
  
  const browserOptions = {
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security'
    ]
  };
  
  if (browserPath) {
    browserOptions.executablePath = browserPath;
  }
  
  const browser = await chromium.launch(browserOptions);
  
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York'
  });
  
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });
  
  const page = await context.newPage();
  
  // Set up download handler BEFORE navigating
  const downloadPromise = context.waitForEvent('download', { timeout: 60000 });
  
  try {
    console.error(`Navigating to: ${url}`);
    
    await page.goto(url, { timeout: 60000, waitUntil: 'domcontentloaded' });
    await waitForCloudflare(page, 30000);
    
    // Dismiss consent popup
    await dismissConsentPopup(page);
    
    const pageTitle = await page.title();
    console.error(`Page title: ${pageTitle}`);
    
    // Find and click download button
    const downloadButtonSelectors = [
      'a.downloadButton',
      'a[class*="downloadButton"]', 
      'a.btn.btn-flat.downloadButton',
      'a:has-text("Download APK")'
    ];
    
    let downloadStarted = false;
    let filename = "app.apk";
    
    for (const selector of downloadButtonSelectors) {
      try {
        const downloadButton = await page.$(selector);
        if (downloadButton) {
          console.error(`Found download button with selector: ${selector}, clicking...`);
          
          // Click the button to trigger download
          const download = await downloadButton.click();
          
          try {
            const downloadObj = await downloadPromise;
            console.error(`Download started, filename: ${downloadObj.suggestedFilename()}`);
            filename = downloadObj.suggestedFilename() || filename;
            
            // Wait for download to complete
            await downloadObj.path();
            const downloadedPath = await downloadObj.path();
            
            // Copy to output file
            if (downloadedPath) {
              fs.copyFileSync(downloadedPath, outputFile);
              console.error(`Downloaded to: ${outputFile}`);
              downloadStarted = true;
              break;
            }
          } catch (e) {
            console.error(`Download wait failed: ${e.message}`);
          }
        }
      } catch (e) {
        console.error(`Selector ${selector} failed: ${e.message}`);
      }
    }
    
    // Write metadata
    const meta = {
      url: url,
      filename: filename,
      downloaded: downloadStarted,
      via: "playwright-download-event"
    };
    
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    
    if (!downloadStarted) {
      throw new Error("Failed to download APK via Playwright download event");
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
    fs.writeFileSync(metaFile, JSON.stringify({ error: err.message, downloaded: false }, null, 2));
    process.exit(1);
  });
