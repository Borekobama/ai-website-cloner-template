import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertExtractionAllowed, extractAsset, inpaint, recordExtractedAsset } from './extract.mjs';
import { colorAt, createRaster, rasterFromPng } from './image.mjs';
import { paintRect } from './test-app/rasters.mjs';

// A smooth horizontal gradient, like out-of-focus photo background.
function gradient(width = 80, height = 40) {
  const raster = createRaster(width, height);
  for (let x = 0; x < width; x += 1) paintRect(raster, [x, 0, x + 1, height], [40 + 2 * x, 120, 200 - x]);
  return raster;
}

test('inpainting fills a hole from its surroundings and keeps known pixels', () => {
  const truth = gradient();
  const damaged = gradient();
  const mask = new Uint8Array(truth.width * truth.height);
  paintRect(damaged, [30, 10, 50, 30], [255, 0, 255]);
  for (let y = 10; y < 30; y += 1) for (let x = 30; x < 50; x += 1) mask[y * truth.width + x] = 1;
  const filled = inpaint(damaged, mask);
  assert.deepEqual(colorAt(filled, 5, 5), colorAt(truth, 5, 5));
  for (const [x, y] of [[31, 11], [40, 20], [48, 28]]) {
    const actual = colorAt(filled, x, y);
    const expected = colorAt(truth, x, y);
    assert.ok(actual.every((value, channel) => Math.abs(value - expected[channel]) <= 8), `${x},${y}: ${actual} vs ${expected}`);
  }
  assert.throws(() => inpaint(damaged, new Uint8Array(damaged.width * damaged.height).fill(1)), /Nothing outside/u);
});

test('an extracted crop is filled, written, and recorded as unverified', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloner-extract-'));
  try {
    const raster = gradient(160, 80);
    paintRect(raster, [60, 20, 90, 40], [255, 0, 255]);
    const geometry = { origin: { x: 0, y: 0 }, scale: 2 };
    const output = join(root, 'public/sites/fixture/home/street.png');
    const result = await extractAsset({ raster, geometry, box: [10, 5, 70, 35], occlude: [[30, 10, 45, 20]], output });
    assert.deepEqual([result.width, result.height], [120, 60]);
    assert.ok(result.occludedPixels > 0);
    const written = rasterFromPng(readFileSync(output));
    assert.notDeepEqual(colorAt(written, 50, 25), [255, 0, 255], 'the occluder must be filled');
    const recorded = recordExtractedAsset({ root, siteKey: 'fixture', record: { name: 'street.png', kind: 'photo', page: 'home', image: 'home.webp', box: [10, 5, 70, 35], occlude: [[30, 10, 45, 20]], output, width: 120, height: 60, approved: false, sourceRunId: 'run', rights: 'unverified' } });
    assert.match(readFileSync(recorded.manifestPath, 'utf8'), /\| street\.png \(photo\) \| `public\/sites\/fixture\/home\/street\.png` .*\*\*Unverified\.\*\*/u);
    assert.equal(JSON.parse(readFileSync(recorded.recordsPath, 'utf8'))[0].output, 'public/sites/fixture/home/street.png');
    recordExtractedAsset({ root, siteKey: 'fixture', record: { ...recorded.entry, output, width: 121 } });
    assert.equal(JSON.parse(readFileSync(recorded.recordsPath, 'utf8')).length, 1, 'extracting the same output again replaces its record');
    assert.ok(existsSync(output));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('brand marks need approval and kinds are checked', () => {
  assert.throws(() => assertExtractionAllowed('logo', false), /approval/u);
  assert.doesNotThrow(() => assertExtractionAllowed('logo', true));
  assert.throws(() => assertExtractionAllowed('wallpaper', false), /--kind/u);
  assert.doesNotThrow(() => assertExtractionAllowed('photo', false));
});
