#!/usr/bin/env node

/**
 * APKMirror URL Resolver using Playwright
 * Actually searches APKMirror to find the correct download URL for a specific version
 */

const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
if (args.length < 4) {
  console.error("Usage: apkmirror-url-resolver.js <package_id> <target_version> <arch> <browser_path>");
  console.error("Example: apkmirror-url-resolver.js com.google.android.youtube 20.44.38 arm64-v8a /usr/bin/chromium");
  process.exit(2);
}

const [packageId, targetVersion, preferredArch, browserPath] = args;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// APKMirror paths for supported apps
const APK_MIRROR_PATHS = {
  "com.google.android.youtube": "google-inc/youtube",
  "com.google.android.apps.youtube.music": "google-inc/youtube-music",
  "com.reddit.frontpage": "redditinc/reddit"
};

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

async function resolveUrl(packageId, targetVersion, preferredArch, browserPath) {
  const appPath = APK_MIRROR_PATHS[packageId];
  if (!appPath) {
    throw new Error(`No APKMirror path configured for ${packageId}`);
  }

  console.error(`Resolving APKMirror URL for ${packageId} ${targetVersion} (${preferredArch})`);

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

  try {
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

    // Convert version to APKMirror slug format (20.44.38 -> 20-44-38)
    const versionSlug = targetVersion.replace(/\./g, "-");
    const appName = appPath.split("/").pop();

    // Try multiple variant numbers (APKMirror uses variants 1-15 for different arch/dpi combos)
    const variantsToTry = [];

    // Preferred architecture variants
    if (preferredArch === "arm64-v8a") {
      // arm64-v8a typically uses variant 2 or 3
      variantsToTry.push(2, 3, 4, 5, 1);
    } else if (preferredArch === "armeabi-v7a") {
      variantsToTry.push(4, 5, 6, 7, 1);
    } else if (preferredArch === "x86") {
      variantsToTry.push(8, 9, 10, 1);
    } else if (preferredArch === "x86_64") {
      variantsToTry.push(10, 11, 12, 1);
    } else {
      // Default order
      variantsToTry.push(2, 3, 1, 4, 5, 6, 7, 8, 9, 10);
    }

    let downloadUrl = null;

    for (const variant of variantsToTry) {
      const testUrl = `https://www.apkmirror.com/apk/${appPath}/${appName}-${versionSlug}-release/${appName}-${versionSlug}-${variant}-android-apk-download/`;
      console.error(`Trying URL: ${testUrl}`);

      try {
        await page.goto(testUrl, { timeout: 15000, waitUntil: 'domcontentloaded' });
        await waitForCloudflare(page, 15000);
        await dismissConsentPopup(page);

        const pageTitle = await page.title();

        // Check if this is a valid download page (not a 404 or "File not found")
        if (!pageTitle.includes("Not Found") && !pageTitle.includes("404") && !pageTitle.includes("File not found")) {
          // Look for the actual download button or link
          const downloadButton = await page.$('a.downloadButton, a[class*="downloadButton"], a.btn.btn-flat.downloadButton');
          if (downloadButton) {
            // Get the href of the download button
            const href = await downloadButton.getAttribute('href');
            if (href && href.includes('/download/')) {
              downloadUrl = "https://www.apkmirror.com" + href;
              console.error(`Found valid download URL: ${downloadUrl}`);
              break;
            }
          }

          // Also check for any link that looks like a download
          const allLinks = await page.$$eval('a[href*="/download/"]', links => links.map(l => l.href));
          if (allLinks.length > 0) {
            downloadUrl = allLinks[0];
            console.error(`Found download link: ${downloadUrl}`);
            break;
          }
        }
      } catch (e) {
        console.error(`Variant ${variant} failed: ${e.message}`);
        continue;
      }
    }

    if (downloadUrl) {
      return {
        download_url: downloadUrl,
        version: targetVersion,
        arch: preferredArch,
        dpi: "nodpi",
        file_type: "apk"
      };
    }

    // If Playwright resolution failed, try the fallback URL construction
    console.error(`Could not resolve via browsing, using fallback URL construction`);
    const fallbackUrl = `https://www.apkmirror.com/apk/${appPath}/${appName}-${versionSlug}-release/${appName}-${versionSlug}-2-android-apk-download/`;

    return {
      download_url: fallbackUrl,
      version: targetVersion,
      arch: preferredArch,
      dpi: "nodpi",
      file_type: "apk"
    };

  } finally {
    await browser.close();
  }
}

resolveUrl(packageId, targetVersion, preferredArch, browserPath)
  .then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch(err => {
    console.error(JSON.stringify({ error: err.message }, null, 2));
    process.exit(1);
  });
