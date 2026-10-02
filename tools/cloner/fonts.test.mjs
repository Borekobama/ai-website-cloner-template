import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { launchBrowser } from './browser.mjs';
import { DEFAULT_FONT_CANDIDATES, fitFonts, renderTypeScaleMarkdown } from './fonts.mjs';
import { createRaster, rasterFromPng } from './image.mjs';

const chromiumAvailable = existsSync(chromium.executablePath());
const needsChromium = { skip: !chromiumAvailable && 'Chromium is not installed' };
// A font file that ships with the installed Next.js; the font directory test
// skips without it.
const FONT_FILE = fileURLToPath(new URL('../../node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf', import.meta.url));
// Generic families need no network.
const LOCAL = [
  { family: 'serif', weights: [400], source: 'local' },
  { family: 'sans-serif', weights: [400, 700], source: 'local' },
  { family: 'monospace', weights: [400], source: 'local' },
];
const SCALE = 1.5;
const geometry = { origin: { x: 0, y: 0 }, scale: SCALE };
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);

// Renders each line as DOM text at a fractional position, like a real page,
// and returns the screenshot with a loose CSS box around every line.
async function referenceShot(browser, lines, css = '') {
  const context = await browser.newContext({ viewport: { width: 560, height: 70 * lines.length }, deviceScaleFactor: SCALE });
  try {
    const page = await context.newPage();
    await page.setContent(`<style>${css} body { margin: 0; background: #fff; } div { position: absolute; white-space: pre; color: #111; }</style>`);
    const boxes = await page.evaluate(async (specs) => {
      await Promise.all(specs.map((spec) => document.fonts.load(spec.font, spec.text)));
      return specs.map((spec, index) => {
        const element = document.createElement('div');
        Object.assign(element.style, { left: `${20.4 + index * 3.3}px`, top: `${18.6 + index * 70}px`, font: spec.font });
        element.textContent = spec.text;
        document.body.append(element);
        const rect = element.getBoundingClientRect();
        return [rect.left - 8, rect.top - 6, rect.right + 8, rect.bottom + 6];
      });
    }, lines);
    return { raster: rasterFromPng(await page.screenshot()), boxes };
  } finally {
    await context.close();
  }
}

test('a monospace line and a bold sans-serif line are fitted to family, weight, and size', needsChromium, async () => {
  const browser = await launchBrowser({ headless: true });
  try {
    const { raster, boxes } = await referenceShot(browser, [
      { text: 'Quartz 1907 gym', font: '400 23px monospace' },
      { text: 'Bright vixens jump', font: '700 19px sans-serif' },
    ]);
    const result = await fitFonts({
      samples: [
        { id: 'code', text: 'Quartz 1907 gym', raster, geometry, box: boxes[0] },
        { id: 'label', text: 'Bright vixens jump', raster, geometry, box: boxes[1] },
      ],
      candidates: LOCAL,
      browser,
    });
    const [code, label] = result.samples;
    assert.deepEqual(code.warnings, []);
    assert.equal(code.candidates[0].family, 'monospace');
    near(code.candidates[0].size, 23, 0.75, 'monospace size');
    const bold = label.candidates[0];
    const regular = label.candidates.find((entry) => entry.family === 'sans-serif' && entry.weight === 400);
    assert.deepEqual([bold.family, bold.weight], ['sans-serif', 700]);
    assert.ok(bold.score < regular.score, `700 scores ${bold.score}, 400 scores ${regular.score}`);
    near(bold.size, 19, 0.75, 'bold size');
    assert.deepEqual(result.unavailable, []);
    assert.deepEqual(result.typeScale.map((entry) => entry.id), ['code', 'label']);
    assert.ok(browser.isConnected(), 'a browser passed in stays open');
  } finally {
    await browser.close();
  }
});

test('font files become candidates and fonts that cannot load are reported, not thrown', {
  skip: (!chromiumAvailable && 'Chromium is not installed') || (!existsSync(FONT_FILE) && 'No font file to test with'),
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloner-fonts-'));
  const browser = await launchBrowser({ headless: true });
  try {
    copyFileSync(FONT_FILE, join(directory, 'Specimen.ttf'));
    writeFileSync(join(directory, 'Broken-SemiBold.woff2'), 'not a font');
    writeFileSync(join(directory, 'notes.txt'), 'not a font file either');
    const face = `@font-face { font-family: "Reference"; src: url("data:font/ttf;base64,${readFileSync(FONT_FILE).toString('base64')}"); }`;
    const text = 'Hamburgefonts 2048';
    const { raster, boxes } = await referenceShot(browser, [{ text, font: '400 21px "Reference"' }, { text, font: '400 21px "Reference"' }], face);
    const result = await fitFonts({
      samples: [
        { id: 'body', text, raster, geometry, box: boxes[0] },
        // This box cuts off the last glyph.
        { id: 'cut', text, raster, geometry, box: [boxes[1][0], boxes[1][1], boxes[1][2] - 16, boxes[1][3]] },
      ],
      candidates: [...LOCAL, { family: 'No Such Font Cloner Test', weights: [400], source: 'local' }],
      fontDir: directory,
      browser,
    });
    const [body, cut] = result.samples;
    assert.deepEqual([body.candidates[0].family, body.candidates[0].weight], ['Specimen', 400]);
    near(body.candidates[0].size, 21, 0.75, 'file font size');
    assert.match(cut.warnings.join(' '), /lower bound/u);
    assert.deepEqual(result.unavailable.map(({ family, weights }) => ({ family, weights })), [
      { family: 'Broken-SemiBold', weights: [600] },
      { family: 'No Such Font Cloner Test', weights: [400] },
    ]);
    assert.match(renderTypeScaleMarkdown(result), /Broken-SemiBold 600/u);
  } finally {
    await browser.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid input is rejected before a browser starts', async () => {
  const sample = { id: 'a', text: 'Hi', raster: createRaster(40, 20, [255, 255, 255, 255]), geometry, box: [0, 0, 20, 10] };
  await assert.rejects(fitFonts({ samples: [] }), /at least one sample/u);
  await assert.rejects(fitFonts({ samples: [sample, sample] }), /unique id/u);
  await assert.rejects(fitFonts({ samples: [{ ...sample, text: 'two\nlines' }] }), /one line/u);
  await assert.rejects(fitFonts({ samples: [{ ...sample, mode: 'grey' }] }), /dark or light/u);
  await assert.rejects(fitFonts({ samples: [sample], keep: 0 }), /keep/u);
  await assert.rejects(fitFonts({ samples: [sample], candidates: [{ family: 'Bad"Name', weights: [400] }] }), /family name/u);
  await assert.rejects(fitFonts({ samples: [sample], candidates: [{ family: 'Inter', weights: [] }] }), /weights/u);
  await assert.rejects(fitFonts({ samples: [{ ...sample, box: [100, 100, 120, 120] }] }), /outside the image/u);
});

test('a sample without ink is reported without starting a browser', async () => {
  const result = await fitFonts({ samples: [{ id: 'blank', text: 'Hi', raster: createRaster(40, 20, [255, 255, 255, 255]), geometry, box: [0, 0, 20, 10] }] });
  assert.equal(result.samples[0].reference, null);
  assert.match(result.samples[0].warnings[0], /No ink/u);
  assert.deepEqual([result.families, result.typeScale], [[], []]);
});

test('default candidates are frozen and Inter keeps its optical size axis', () => {
  assert.ok(Object.isFrozen(DEFAULT_FONT_CANDIDATES) && DEFAULT_FONT_CANDIDATES.every(Object.isFrozen));
  assert.equal(DEFAULT_FONT_CANDIDATES.length, 30);
  assert.equal(DEFAULT_FONT_CANDIDATES[0].axes, 'opsz,wght@14..32,300..700');
  assert.deepEqual(DEFAULT_FONT_CANDIDATES.find((entry) => entry.family === 'Lato').weights, [300, 400, 700]);
});

test('the type scale markdown is a short builder draft', () => {
  const markdown = renderTypeScaleMarkdown({
    samples: [{ id: 'title', text: 'Plans | pricing', candidates: [], warnings: ['Ink touches the box edge (right); widen the box, this size is a lower bound'] }],
    families: [{ family: 'Inter', score: 0.0812, samples: 1 }, { family: 'Roboto', score: 0.2, samples: 1 }],
    typeScale: [{ id: 'title', family: 'Inter', weight: 600, size: 28.5 }],
    unavailable: [{ family: 'Lato', weights: [300, 400, 700], reason: 'the Google Fonts stylesheet did not load' }],
    warnings: [],
  });
  assert.match(markdown, /builder draft .*not evidence/u);
  assert.match(markdown, /\| 1 \| Inter \| 0\.0812 \| 1 \|/u);
  assert.match(markdown, /## Type scale\n/u);
  assert.match(markdown, /\| title \| Plans \\\| pricing \| Inter \| 600 \| 28\.5 \|/u);
  assert.match(markdown, /Unavailable: Lato 300, 400, 700 \(the Google Fonts stylesheet did not load\)/u);
  assert.match(markdown, /- title: Ink touches the box edge/u);
});
