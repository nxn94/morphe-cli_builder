#!/usr/bin/env node

const fs = require("node:fs");
const { chromium } = require("playwright-core");

const args = process.argv.slice(2);
if (args.length !== 3 && args.length !== 4) {
  console.error(
    "Usage: apkmirror-playwright.js <source_url> [browser_bin] <meta_path> <bin_path>"
  );
  process.exit(2);
}
const [sourceUrl, arg2, arg3, arg4] = args;
const browserBin = args.length === 4 ? arg2 : "";
const metaPath = args.length === 4 ? arg3 : arg2;
const binPath = args.length === 4 ? arg4 : arg3;
if (!sourceUrl || !metaPath || !binPath) {
  console.error(
    "Usage: apkmirror-playwright.js <source_url> [browser_bin] <meta_path> <bin_path>"
  );
  process.exit(2);
}

const ua =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const CHALLENGE_RE = /cannot be loaded without javascript and cookies enabled|verify you are human|just a moment/i;
const DIRECT_RE = /\/wp-content\/themes\/APKMirror\/download\.php\?id=[^"' ]+/i;
const INTERMEDIATE_RE = /\/apk\/.+\/download\/[^"' ]*/i;

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

function looksLikeHtml(buf) {
  if (!buf || buf.length === 0) return false;
  const head = buf.slice(0, 2048).toString("utf8").toLowerCase();
  return head.includes("<html") || head.includes("<!doctype html");
}

function absUrl(href, base) {
  try {
    return new URL(href, base).toString();
  } catch (_) {
    return "";
  }
}

function findFirst(hrefs, re) {
  for (const href of hrefs) {
    if (re.test(href)) return href;
  }
  return "";
}

async function collectCandidateLinks(page) {
  return page.evaluate(() => {
    const out = new Set();

    for (const a of document.querySelectorAll("a[href]")) {
      const h = a.getAttribute("href");
      if (h) out.add(h);
    }

    for (const e of document.querySelectorAll("[data-href]")) {
      const h = e.getAttribute("data-href");
      if (h) out.add(h);
    }

    for (const e of document.querySelectorAll("[onclick]")) {
      const o = e.getAttribute("onclick") || "";
      const m = o.match(/(?:location\.href|window\.location)\s*=\s*['"]([^'"]+)['"]/i);
      if (m && m[1]) out.add(m[1]);
    }

    return Array.from(out);
  });
}

(async () => {
  const launchOptions = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled"
    ]
  };
  if (browserBin) launchOptions.executablePath = browserBin;

  const browser = await chromium.launch(launchOptions);

  const context = await browser.newContext({
    userAgent: ua,
    locale: "en-US",
    extraHTTPHeaders: {
      "accept-language": "en-US,en;q=0.9"
    }
  });

  const page = await context.newPage();
  const visited = new Set();
  let currentUrl = sourceUrl;
  let directUrl = "";
  let challengeSeen = false;
  let sourceStatus = 0;

  // Walk up to two "download" page hops and allow challenge pages to settle.
  for (let step = 0; step < 16; step += 1) {
    if (!visited.has(currentUrl)) {
      const resp = await page.goto(currentUrl, {
        waitUntil: "domcontentloaded",
        timeout: 120000
      });
      sourceStatus = resp ? resp.status() : sourceStatus;
      visited.add(currentUrl);
    }

    await page.waitForTimeout(3000);
    const html = await page.content();
    if (CHALLENGE_RE.test(html)) challengeSeen = true;

    const rawLinks = await collectCandidateLinks(page);
    const links = rawLinks
      .map((h) => absUrl(h, page.url()))
      .filter(Boolean);

    directUrl = findFirst(links, DIRECT_RE);
    if (directUrl) break;

    const intermediate = findFirst(links, INTERMEDIATE_RE);
    if (intermediate && !visited.has(intermediate)) {
      currentUrl = intermediate;
      continue;
    }

    // Keep waiting a bit on challenge pages in case cookies get issued.
    if (challengeSeen) continue;

    // No candidate links and no challenge detected: stop early.
    break;
  }

  if (!directUrl) {
    const title = await page.title().catch(() => "");
    const url = page.url();
    await browser.close();
    throw new Error(
      `Playwright could not find APKMirror direct download URL (status=${sourceStatus}, title=${title}, url=${url}, challenge=${challengeSeen})`
    );
  }

  // First try real browser download flow (less likely to be blocked than API request).
  try {
    const downloadPromise = page.waitForEvent("download", { timeout: 120000 });
    await page.evaluate((u) => {
      const a = document.createElement("a");
      a.href = u;
      a.target = "_self";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
    }, directUrl);

    const download = await downloadPromise;
    const tmpPath = await download.path();
    if (tmpPath) {
      const payload = fs.readFileSync(tmpPath);
      if (!looksLikeHtml(payload)) {
        let dlFilename = download.suggestedFilename() || "";
        if (!dlFilename) dlFilename = "download.apk";
        fs.writeFileSync(binPath, payload);
        fs.writeFileSync(
          metaPath,
          JSON.stringify(
            {
              filename: dlFilename,
              direct_url: directUrl,
              content_type: "",
              bytes: payload.length,
              via: "browser-download"
            },
            null,
            2
          )
        );
        await browser.close();
        return;
      }
    }
  } catch (_) {
    // Fall through to API request fallback.
  }

  const response = await context.request.get(directUrl, {
    timeout: 120000,
    maxRedirects: 5,
    headers: { referer: page.url() || sourceUrl }
  });

  const status = response.status();
  const headers = response.headers();
  const contentType = (headers["content-type"] || "").toLowerCase();
  const body = await response.body();

  if (status < 200 || status >= 300) {
    await browser.close();
    throw new Error(`Playwright download request failed with HTTP ${status}`);
  }

  if (contentType.startsWith("text/")) {
    const text = body.toString("utf8");
    const fallbackDirect = text.match(DIRECT_RE)?.[0] || "";
    if (fallbackDirect) {
      const retryResp = await context.request.get(fallbackDirect, {
        timeout: 120000,
        maxRedirects: 5,
        headers: { referer: directUrl }
      });
      const retryType = (retryResp.headers()["content-type"] || "").toLowerCase();
      const retryBody = await retryResp.body();
      if (
        retryResp.status() >= 200 &&
        retryResp.status() < 300 &&
        !retryType.startsWith("text/")
      ) {
        const retryHeaders = retryResp.headers();
        let retryFilename = filenameFromDisposition(
          retryHeaders["content-disposition"] || ""
        );
        if (!retryFilename) retryFilename = "download.apk";
        fs.writeFileSync(binPath, retryBody);
        fs.writeFileSync(
          metaPath,
          JSON.stringify(
            {
              filename: retryFilename,
              direct_url: fallbackDirect,
              content_type: retryType,
              bytes: retryBody.length,
              via: "api-retry"
            },
            null,
            2
          )
        );
        await browser.close();
        return;
      }
    }

    await browser.close();
    if (CHALLENGE_RE.test(text)) {
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
        bytes: body.length,
        via: "api"
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
