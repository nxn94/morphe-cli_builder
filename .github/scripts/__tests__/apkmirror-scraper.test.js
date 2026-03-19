// .github/scripts/__tests__/apkmirror-scraper.test.js
'use strict';

// We'll import helpers once they're exported from unified-downloader.js
const {
  buildReleasePageUrl,
  buildVariantPriorities,
  selectVariant,
  collectCookies,
} = require('../unified-downloader');

const cheerio = require('cheerio');

describe('buildReleasePageUrl', () => {
  test('constructs correct URL with slug prefix', () => {
    const url = buildReleasePageUrl('google-inc/youtube', '20.44.38');
    expect(url).toBe(
      'https://www.apkmirror.com/apk/google-inc/youtube/youtube-20-44-38-release/'
    );
  });

  test('constructs correct URL for youtube music', () => {
    const url = buildReleasePageUrl('google-inc/youtube-music', '8.44.54');
    expect(url).toBe(
      'https://www.apkmirror.com/apk/google-inc/youtube-music/youtube-music-8-44-54-release/'
    );
  });
});

describe('buildVariantPriorities', () => {
  test('preferred_arch is first priority as APK', () => {
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(priorities[0]).toEqual({ arch: 'arm64-v8a', dpi: 'nodpi', type: 'APK' });
  });

  test('universal APK is third priority', () => {
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(priorities[2]).toEqual({ arch: 'universal', dpi: 'nodpi', type: 'APK' });
  });

  test('noarch APK is fifth priority', () => {
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(priorities[4]).toEqual({ arch: 'noarch', dpi: 'nodpi', type: 'APK' });
  });

  test('returns 5 priorities total', () => {
    expect(buildVariantPriorities('arm64-v8a')).toHaveLength(5);
  });
});

describe('selectVariant', () => {
  const makeHtml = (rows) => `
    <div class="variants-table">
      ${rows.map(r => `
        <div class="table-row">
          <div class="table-cell">${r.version}</div>
          <div class="table-cell">${r.dpi}</div>
          <div class="table-cell">${r.arch}</div>
          <div class="table-cell">${r.type}</div>
          <div class="table-cell"><a href="${r.href}">Download</a></div>
        </div>
      `).join('')}
    </div>
  `;

  test('selects arm64-v8a APK nodpi as first priority', () => {
    const html = makeHtml([
      { version: '20.44.38', dpi: 'nodpi', arch: 'arm64-v8a', type: 'APK', href: '/apk/arm64' },
      { version: '20.44.38', dpi: 'nodpi', arch: 'universal', type: 'APK', href: '/apk/universal' },
    ]);
    const $ = cheerio.load(html);
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(selectVariant($, priorities)).toBe('/apk/arm64');
  });

  test('falls back to universal when preferred_arch not found', () => {
    const html = makeHtml([
      { version: '20.44.38', dpi: 'nodpi', arch: 'universal', type: 'APK', href: '/apk/universal' },
    ]);
    const $ = cheerio.load(html);
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(selectVariant($, priorities)).toBe('/apk/universal');
  });

  test('throws with list of available variants when nothing matches', () => {
    const html = makeHtml([
      { version: '20.44.38', dpi: '320dpi', arch: 'x86_64', type: 'APK', href: '/apk/x86' },
    ]);
    const $ = cheerio.load(html);
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(() => selectVariant($, priorities)).toThrow(/No matching variant/);
  });

  test('prefers APK over BUNDLE for same arch', () => {
    const html = makeHtml([
      { version: '20.44.38', dpi: 'nodpi', arch: 'arm64-v8a', type: 'BUNDLE', href: '/apk/bundle' },
      { version: '20.44.38', dpi: 'nodpi', arch: 'arm64-v8a', type: 'APK', href: '/apk/apk' },
    ]);
    const $ = cheerio.load(html);
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(selectVariant($, priorities)).toBe('/apk/apk');
  });
});

describe('collectCookies', () => {
  // Mock uses getSetCookie() returning string[] — matches the Headers API
  const makeResponse = (cookieStrings) => ({
    headers: { getSetCookie: () => cookieStrings }
  });

  test('collects a single cookie', () => {
    const resp = makeResponse(['session=abc123; Path=/']);
    const cookies = collectCookies(resp, {});
    expect(cookies).toEqual({ session: 'abc123' });
  });

  test('collects multiple cookies from separate Set-Cookie headers', () => {
    const resp = makeResponse(['session=abc123; Path=/', 'token=xyz; HttpOnly']);
    const cookies = collectCookies(resp, {});
    expect(cookies).toEqual({ session: 'abc123', token: 'xyz' });
  });

  test('merges with existing cookies', () => {
    const resp = makeResponse(['new=val; Path=/']);
    const cookies = collectCookies(resp, { existing: 'keep' });
    expect(cookies).toEqual({ existing: 'keep', new: 'val' });
  });

  test('returns existing when no Set-Cookie headers', () => {
    const resp = makeResponse([]);
    const cookies = collectCookies(resp, { keep: 'me' });
    expect(cookies).toEqual({ keep: 'me' });
  });
});
