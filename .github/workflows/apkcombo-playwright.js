#!/usr/bin/env node

const fs = require("node:fs");
const { chromium } = require("playwright-core");

const [pkg, ver, browserBin, metaPath, binPath] = process.argv.slice(2);

if (!pkg || !ver || !browserBin || !metaPath || !binPath) {
  console.error(
    "Usage: apkcombo-playwright.js <package> <version> <browser_bin> <meta_path> <bin_path>"
  );
  process.exit(2);
}

const ua =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

// APKCombo Downloader URL
const sourceUrl = `https://apkcombo.com/downloader/#package=${pkg}&version=${ver}`;

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserBin,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  const context = await browser.newContext({
    userAgent: ua,
    locale: "en-US"
  });

  const page = await context.newPage();
  
  try {
    console.log(`Navigating to ${sourceUrl}`);
    await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Wait for the file list to appear (or error)
    // .file-list contains the variants
    await page.waitForSelector('ul.file-list, .alert-danger', { timeout: 30000 });

    const errorText = await page.$eval('.alert-danger', el => el.innerText).catch(() => "");
    if (errorText) {
      throw new Error(`APKCombo returned error: ${errorText}`);
    }

    // Parse variants
    const variants = await page.$$eval('ul.file-list li', (lis) => {
      return lis.map(li => {
        const a = li.querySelector('a');
        if (!a) return null;
        return {
          href: a.href,
          text: li.innerText.toLowerCase(),
          filename: li.querySelector('.name')?.innerText || "download.apk"
        };
      }).filter(Boolean);
    });

    if (variants.length === 0) {
      throw new Error("No download variants found on APKCombo.");
    }

    // Score variants to find the best one (arm64 > universal, apk > xapk)
    variants.sort((a, b) => {
      const score = (v) => {
        let s = 0;
        if (v.text.includes('arm64')) s += 100;
        else if (v.text.includes('universal')) s += 50;
        else if (v.text.includes('x86')) s -= 50;
        
        if (v.text.includes('apk')) s += 20;
        else if (v.text.includes('xapk')) s += 10;
        
        if (v.text.includes('nodpi')) s += 5;
        return s;
      };
      return score(b) - score(a);
    });

    const best = variants[0];
    console.log(`Selected variant: ${best.filename}`);

    // Handle download
    const downloadPromise = page.waitForEvent("download", { timeout: 120000 });
    
    // Trigger download by navigating to the href (APKCombo links usually trigger download immediately)
    await page.evaluate((url) => {
      const a = document.createElement('a');
      a.href = url;
      a.click();
    }, best.href);

    const download = await downloadPromise;
    const tmpPath = await download.path();
    
    if (!tmpPath) throw new Error("Download failed (no path).");

    const suggestedFilename = download.suggestedFilename() || best.filename;
    const payload = fs.readFileSync(tmpPath);

    fs.writeFileSync(binPath, payload);
    fs.writeFileSync(
      metaPath,
      JSON.stringify(
        {
          filename: suggestedFilename,
          direct_url: best.href,
          content_type: "application/vnd.android.package-archive", // Assumed
          bytes: payload.length,
          via: "apkcombo"
        },
        null,
        2
      )
    );

    await browser.close();

  } catch (err) {
    await browser.close();
    console.error(err);
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});