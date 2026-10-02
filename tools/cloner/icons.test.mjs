import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { launchBrowser } from './browser.mjs';
import { loadIconSet, matchIcons } from './icons.mjs';
import { createRaster, rasterFromPng } from './image.mjs';

const stroke = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  circle: { body: `<circle cx="12" cy="12" r="9" ${stroke}/>` },
  square: { body: `<rect x="4" y="4" width="16" height="16" rx="1" ${stroke}/>` },
  // A 20x20 icon overrides the default 24x24 view box.
  plus: { body: `<path d="M10 3v14M3 10h14" ${stroke}/>`, width: 20, height: 20 },
  'arrow-right': { body: `<path d="M5 12h14m-6-6l6 6l-6 6" ${stroke}/>` },
};
// Bodies that try to run code, leave their <svg> element, or swallow the
// markup after it.
const HOSTILE = {
  handler: { body: `<script>alert(1)</script><path d="M4 12h16" onload="alert(2)" ${stroke}/>` },
  escape: { body: `<path d="M4 12h16" ${stroke}/></svg><p style="position:fixed;inset:0;background:#000">` },
  truncated: { body: '<path d="M4 12h16"' },
};
const MIT = { title: 'MIT', spdx: 'MIT', url: 'https://opensource.org/licenses/MIT' };

// A stand-in for the Iconify API with the collections `test` and `hostile`.
// Unknown names get a filled square, so a hidden name that was requested
// would show up in the set.
function fakeIconify() {
  const calls = [];
  const collections = { test: ICONS, hostile: HOSTILE };
  const fetchImpl = async (url) => {
    calls.push(url);
    const { pathname, searchParams } = new URL(url);
    const prefix = searchParams.get('prefix') ?? searchParams.get('prefixes') ?? pathname.slice(1, -'.json'.length);
    const icons = collections[prefix];
    if (!icons) return new Response('Not found', { status: 404 });
    const names = Object.keys(icons);
    if (pathname === '/collection') return Response.json({ prefix, uncategorized: names.slice(0, 2), categories: { Shapes: names.slice(2), Retired: ['old-plus'] }, hidden: ['old-plus'] });
    if (pathname === '/collections') return Response.json({ [prefix]: { name: `${prefix} icons`, total: names.length, author: { name: 'Tests' }, license: MIT } });
    return Response.json({ prefix, icons: Object.fromEntries(searchParams.get('icons').split(',').map((name) => [name, icons[name] ?? { body: '<path d="M0 0h24v24H0z"/>' }])) });
  };
  return { calls, fetchImpl };
}

test('an icon set is downloaded once and then read from the cache', async () => {
  const cacheDirectory = mkdtempSync(join(tmpdir(), 'cloner-icons-'));
  try {
    const iconify = fakeIconify();
    const set = await loadIconSet('test', { cacheDirectory, fetchImpl: iconify.fetchImpl });
    assert.deepEqual(Object.keys(set.icons).sort(), ['arrow-right', 'circle', 'plus', 'square']);
    assert.deepEqual(set.icons.plus, { body: ICONS.plus.body, width: 20, height: 20 });
    assert.deepEqual([set.icons.circle.width, set.icons.circle.height], [24, 24]);
    assert.deepEqual(set.info.license, MIT);
    assert.deepEqual(JSON.parse(readFileSync(join(cacheDirectory, 'test.json'), 'utf8')), set);
    const requests = iconify.calls.length;
    assert.deepEqual(await loadIconSet('test', { cacheDirectory, fetchImpl: iconify.fetchImpl }), set);
    assert.equal(iconify.calls.length, requests, 'the second load must not fetch');
    await assert.rejects(loadIconSet('../test', { cacheDirectory, fetchImpl: iconify.fetchImpl }), /Invalid icon set prefix/u);
  } finally {
    rmSync(cacheDirectory, { recursive: true, force: true });
  }
});

test('sets that fail to load, unsafe icon bodies, and boxes without ink become warnings', async () => {
  const cacheDirectory = mkdtempSync(join(tmpdir(), 'cloner-icons-'));
  try {
    const result = await matchIcons({
      boxes: [{ id: 'blank', raster: createRaster(40, 40, [255, 255, 255, 255]), geometry: { origin: { x: 0, y: 0 }, scale: 1 }, box: [5, 5, 35, 35] }],
      sets: ['test', 'hostile', 'missing', 'Not a prefix'],
      cacheDirectory,
      fetchImpl: fakeIconify().fetchImpl,
    });
    assert.deepEqual(result.boxes, [{ id: 'blank', reference: { ink: null, width: null, height: null, warnings: ['No ink above the threshold in this box'] }, matches: [] }]);
    assert.deepEqual(result.sets.map((set) => set.prefix), ['test', 'hostile']);
    assert.equal(result.warnings.length, 3);
    assert.match(result.warnings[0], /missing.*HTTP 404/u);
    assert.match(result.warnings[1], /Invalid icon set prefix/u);
    // The body whose script and handler can be stripped is kept.
    assert.match(result.warnings[2], /^2 of 3 hostile icons were skipped/u);
  } finally {
    rmSync(cacheDirectory, { recursive: true, force: true });
  }
});

// The unit-test job in CI has no browser; the integration job covers this path.
const chromiumAvailable = existsSync(chromium.executablePath());

test('each icon drawn at another size, scale, colour, and position ranks its source first', { skip: !chromiumAvailable && 'Chromium is not installed' }, async () => {
  const browser = await launchBrowser({ headless: true });
  const cacheDirectory = mkdtempSync(join(tmpdir(), 'cloner-icons-'));
  try {
    const names = Object.keys(ICONS);
    const context = await browser.newContext({ viewport: { width: 200, height: 60 }, deviceScaleFactor: 1.5 });
    const page = await context.newPage();
    await page.setContent(`<body style="margin:0;background:#fafafa">${names.map((name, index) => {
      const { body, width = 24, height = 24 } = ICONS[name];
      return `<svg viewBox="0 0 ${width} ${height}" width="21" height="21" style="position:absolute;left:${13.3 + index * 45}px;top:17.6px;color:#2a2a3a">${body}</svg>`;
    }).join('')}</body>`);
    const raster = rasterFromPng(await page.screenshot());
    await context.close();
    const geometry = { origin: { x: 0, y: 0 }, scale: 1.5 };
    const result = await matchIcons({
      boxes: names.map((name, index) => ({ id: name, raster, geometry, box: [5 + index * 45, 8, 45 + index * 45, 50] })),
      sets: ['test'],
      cacheDirectory,
      browser,
      fetchImpl: fakeIconify().fetchImpl,
    });
    for (const entry of result.boxes) {
      assert.equal(entry.matches[0].icon, `test:${entry.id}`, JSON.stringify(entry.matches));
      assert.ok(entry.matches[0].score > entry.matches[1].score, JSON.stringify(entry.matches));
    }
    // The arrow spans 16 of 24 view-box units: 14 CSS pixels at 21 pixels.
    assert.ok(Math.abs(result.boxes[3].reference.width - 14) < 0.3, `arrow width ${result.boxes[3].reference.width}`);
    assert.deepEqual(result.sets, [{ prefix: 'test', title: 'test icons', total: 4, license: MIT }]);
    assert.deepEqual(result.warnings, []);
    assert.ok(browser.isConnected(), 'a browser that is passed in stays open');
  } finally {
    await browser.close();
    rmSync(cacheDirectory, { recursive: true, force: true });
  }
});
