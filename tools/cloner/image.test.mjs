import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchBrowser } from './browser.mjs';
import { colorAt, createRaster, cropRaster, decodeImage, imageFormat, rasterFromPng, resampleRegion, stepEdgePosition, toPng } from './image.mjs';
import { paintRect } from './test-app/rasters.mjs';

test('rasters round-trip through PNG and crop to integer boxes', () => {
  const raster = createRaster(8, 6, [10, 20, 30, 255]);
  paintRect(raster, [2, 1, 5, 4], [200, 100, 50]);
  const decoded = rasterFromPng(toPng(raster));
  assert.deepEqual(decoded.data, raster.data);
  const crop = cropRaster(raster, { x: 2, y: 1, width: 3, height: 3 });
  assert.equal(crop.width, 3);
  assert.deepEqual(colorAt(crop, 0, 0), [200, 100, 50]);
  assert.throws(() => cropRaster(raster, { x: 9, y: 0, width: 2, height: 2 }), /outside the image/u);
  assert.equal(imageFormat(toPng(raster)).format, 'png');
  assert.equal(imageFormat(Buffer.from('not an image')), null);
});

test('area resampling averages fractional source rectangles', () => {
  const raster = createRaster(4, 1);
  [0, 100, 200, 255].forEach((value, x) => paintRect(raster, [x, 0, x + 1, 1], [value, value, value]));
  assert.deepEqual([...resampleRegion(raster, { x: 0, y: 0, width: 4, height: 1 }, 2, 1).data].filter((_, index) => index % 4 === 0), [50, 228]);
  assert.equal(resampleRegion(raster, { x: 0.5, y: 0, width: 2, height: 1 }, 1, 1).data[0], 100);
});

test('the area method places antialiased and blurred edges exactly', () => {
  const outside = [255, 255, 255];
  const inside = [0, 0, 0];
  // Edge at 10.3: pixel 10 is 70 % inside.
  const profile = Array.from({ length: 16 }, (_, index) => (index < 10 ? outside : index === 10 ? [77, 77, 77] : inside));
  assert.ok(Math.abs(stepEdgePosition(profile, 7, 13, outside, inside) - 10.3) < 0.01);
  // A symmetric blur keeps the edge in place.
  const blurred = [outside, outside, [230, 230, 230], [128, 128, 128], [25, 25, 25], inside, inside];
  assert.ok(Math.abs(stepEdgePosition(blurred, 0, 6, outside, inside) - 3.5) < 0.01);
});

test('PNG without a colour profile is read directly', async () => {
  const raster = createRaster(4, 4, [1, 2, 3, 255]);
  const decoded = await decodeImage(toPng(raster));
  assert.equal(decoded.format, 'png');
  assert.equal(decoded.colorManaged, false);
  assert.deepEqual(colorAt(decoded.raster, 1, 1), [1, 2, 3]);
});

test('Chromium decodes WebP and JPEG screenshots to sRGB pixels', async () => {
  const browser = await launchBrowser({ headless: true });
  try {
    const raster = createRaster(64, 48, [239, 238, 243, 255]);
    paintRect(raster, [8.5, 8, 40, 30], [30, 40, 200]);
    const page = await browser.newPage();
    const encode = async (type) => Buffer.from(await page.evaluate(async ({ base64, mime }) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      const blob = await canvas.convertToBlob({ type: mime, quality: 1 });
      return [...new Uint8Array(await blob.arrayBuffer())];
    }, { base64: toPng(raster).toString('base64'), mime: type }));
    for (const [type, format, tolerance] of [['image/webp', 'webp', 6], ['image/jpeg', 'jpeg', 12]]) {
      const decoded = await decodeImage(await encode(type), { browser });
      assert.equal(decoded.format, format);
      assert.equal(decoded.colorManaged, true);
      assert.equal(decoded.raster.width, 64);
      for (const [x, y, expected] of [[20, 20, [30, 40, 200]], [55, 40, [239, 238, 243]]]) {
        const actual = colorAt(decoded.raster, x, y);
        assert.ok(actual.every((value, channel) => Math.abs(value - expected[channel]) <= tolerance), `${format} ${actual} vs ${expected}`);
      }
    }
  } finally {
    await browser.close();
  }
});
