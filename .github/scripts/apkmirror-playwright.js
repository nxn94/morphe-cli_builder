#!/usr/bin/env node

const fs = require("node:fs");
const { chromium } = require("playwright-core");

const [sourceUrl, browserBin, metaPath, binPath] = process.argv.slice(2);

if (!sourceUrl || !browserBin || !metaPath || !binPath) {
  console.error(
    "Usage: apkmirror-playwright.js <source_url> <browser_bin> <meta_path> <bin_path>"
  );
  process.exit(2);
}

const ua =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

function decodeFilename(raw) {
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return raw;
  }
}

function filenameFromDisposition(disposition) {
  if (!disposition) return "";
  const star = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (star && star[1]) return decodeFilename(star[1].trim());
  const normal = disposition.match(/filename="?([^";]+)"?/i);
  if (normal && normal[1]) return normal[1].trim();
  return "";
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserBin,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const context = await browser.newContext({
    userAgent: ua,
    locale: "en-US",
    extraHTTPHeaders: {
      "accept-language": "en-US,en;q=0.9"
    }
  });

  const page = await context.newPage();
  await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(3000);

  const isDirect =
    /download\.php\?id=|\.apk($|\?)|\.xapk($|\?)|\.apkm($|\?)|\.apks($|\?)/i.test(
      sourceUrl
    );
  let directUrl = sourceUrl;
  if (!isDirect) {
    directUrl = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a[href]")).map(
        (a) => a.href
      );
      return (
        links.find((h) =>
          /\/wp-content\/themes\/APKMirror\/download\.php\?id=/i.test(h)
        ) || ""
      );
    });
  }

  if (!directUrl) {
    throw new Error("Playwright could not find APKMirror direct download URL.");
  }

  const response = await context.request.get(directUrl, {
    timeout: 120000,
    maxRedirects: 5,
    headers: { referer: sourceUrl }
  });

  const status = response.status();
  const headers = response.headers();
  const contentType = (headers["content-type"] || "").toLowerCase();
  const body = await response.body();

  if (status < 200 || status >= 300) {
    throw new Error(`Playwright download request failed with HTTP ${status}`);
  }

  if (contentType.startsWith("text/")) {
    const text = body.toString("utf8");
    if (/cannot be loaded without javascript and cookies enabled/i.test(text)) {
      throw new Error("APKMirror anti-bot challenge page returned in download.");
    }
    throw new Error(`Unexpected text response type: ${contentType}`);
  }

  let filename = filenameFromDisposition(headers["content-disposition"] || "");
  if (!filename) {
    try {
      const u = new URL(directUrl);
      filename = u.pathname.split("/").pop() || "";
    } catch (_) {
      filename = "";
    }
  }
  if (!filename) filename = "download.apk";

  fs.writeFileSync(binPath, body);
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        filename,
        direct_url: directUrl,
        content_type: contentType,
        bytes: body.length
      },
      null,
      2
    )
  );

  await browser.close();
})().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
