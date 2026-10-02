import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRaster } from './image.mjs';
import { probeColor, probeEdges, probeInkBox, probeInkRuns, probeRadius } from './probes.mjs';
import { paintRect, paintRoundedRect } from './test-app/rasters.mjs';

// A fractional origin and scale, like a presentation shot of a 1x design.
const geometry = { origin: { x: 10.3, y: 20.7 }, scale: 1.5 };
const native = (value, axis) => geometry.origin[axis] + value * geometry.scale;
const nativeBox = ([x0, y0, x1, y1]) => [native(x0, 'x'), native(y0, 'y'), native(x1, 'x'), native(y1, 'y')];
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
const white = () => createRaster(420, 320, [255, 255, 255, 255]);

test('edges are found at sub-pixel CSS positions on both axes', () => {
  const raster = white();
  paintRect(raster, nativeBox([40.25, 30, 200.6, 120.4]), [51, 51, 85]);
  const horizontal = probeEdges(raster, geometry, { axis: 'x', at: 75, from: 0, to: 250 });
  assert.equal(horizontal.edges.length, 2);
  near(horizontal.edges[0].position, 40.25, 0.03, 'left');
  near(horizontal.edges[1].position, 200.6, 0.03, 'right');
  assert.equal(horizontal.edges[0].to, '#333355');
  const vertical = probeEdges(raster, geometry, { axis: 'y', at: 100, from: 0, to: 180, band: 3 });
  near(vertical.edges[0].position, 30, 0.03, 'top');
  near(vertical.edges[1].position, 120.4, 0.03, 'bottom');
  assert.throws(() => probeEdges(raster, geometry, { axis: 'z', at: 1, from: 0, to: 2 }), /axis x\|y/u);
});

test('corner radius is fitted from the boundary near each corner', () => {
  const raster = createRaster(420, 320, [239, 238, 243, 255]);
  const box = [40, 30, 200, 150];
  paintRoundedRect(raster, nativeBox(box), 24 * geometry.scale, [255, 255, 255]);
  for (const corner of ['tl', 'tr', 'bl', 'br']) {
    const result = probeRadius(raster, geometry, { box, corner });
    near(result.radius, 24, 0.4, corner);
  }
  const square = createRaster(420, 320, [239, 238, 243, 255]);
  paintRect(square, nativeBox(box), [255, 255, 255]);
  // Radii below about one image pixel are not resolvable from row insets.
  assert.ok(probeRadius(square, geometry, { box, corner: 'tl' }).radius < 1, 'square corner');
});

test('ink runs merge close glyphs and report sub-pixel ends', () => {
  const raster = white();
  for (const [x0, x1] of [[20.4, 50.2], [51.5, 80], [120, 160.7]]) paintRect(raster, nativeBox([x0, 40, x1, 52]), [34, 34, 40]);
  const { runs } = probeInkRuns(raster, geometry, { axis: 'x', band: [36, 56], range: [0, 200], gap: 2 });
  assert.equal(runs.length, 2);
  near(runs[0].start, 20.4, 0.05, 'first start');
  near(runs[0].end, 80, 0.05, 'first end');
  near(runs[1].start, 120, 0.05, 'second start');
  near(runs[1].end, 160.7, 0.05, 'second end');
  const rows = probeInkRuns(raster, geometry, { axis: 'y', band: [0, 200], range: [30, 70] });
  near(rows.runs[0].start, 40, 0.05, 'row start');
  near(rows.runs[0].end, 52, 0.05, 'row end');
  const light = createRaster(420, 320, [20, 20, 30, 255]);
  paintRect(light, nativeBox([30, 40, 60, 50]), [250, 250, 250]);
  near(probeInkRuns(light, geometry, { axis: 'x', band: [36, 56], range: [0, 100], mode: 'light' }).runs[0].start, 30, 0.05, 'light ink');
});

test('ink box is exact inside a wide box and warns when the box clips it', () => {
  const raster = white();
  paintRect(raster, nativeBox([60.3, 80.2, 140.8, 96.5]), [20, 20, 30]);
  const full = probeInkBox(raster, geometry, { box: [50, 70, 160, 110] });
  assert.deepEqual(full.warnings, []);
  [60.3, 80.2, 140.8, 96.5].forEach((value, index) => near(full.ink[index], value, 0.05, `ink ${index}`));
  const clipped = probeInkBox(raster, geometry, { box: [50, 70, 120, 110] });
  assert.equal(clipped.clipped.right, true);
  assert.match(clipped.warnings[0], /lower bound/u);
  assert.match(probeInkBox(white(), geometry, { box: [10, 10, 40, 40] }).warnings[0], /No ink/u);
  // A box whose border runs over a dark panel cannot tell ink from background.
  const mixed = white();
  paintRect(mixed, nativeBox([0, 60, 100, 120]), [30, 30, 40]);
  paintRect(mixed, nativeBox([120, 80, 160, 90]), [20, 20, 30]);
  assert.match(probeInkBox(mixed, geometry, { box: [80, 70, 170, 100] }).warnings.join(' '), /not plain background/u);
});

test('flat colours are medians and text colour comes from stroke cores', () => {
  const raster = white();
  paintRect(raster, nativeBox([10, 10, 100, 60]), [239, 238, 243]);
  // Symmetric noise leaves the median where it was.
  for (let y = Math.ceil(native(10, 'y')); y < Math.floor(native(60, 'y')); y += 1) {
    for (let x = Math.ceil(native(10, 'x')); x < Math.floor(native(100, 'x')); x += 1) {
      const offset = (y * raster.width + x) * 4;
      const noise = ((x * 7 + y * 13) % 5) - 2;
      for (let channel = 0; channel < 3; channel += 1) raster.data[offset + channel] += noise;
    }
  }
  const flat = probeColor(raster, geometry, { box: [20, 20, 90, 50] });
  assert.equal(flat.median, '#efeef3');
  assert.ok(flat.spread90 <= 4);
  paintRect(raster, nativeBox([120.3, 20.3, 121.9, 40.6]), [17, 17, 22]);
  paintRect(raster, nativeBox([125.1, 20.3, 140.2, 22]), [17, 17, 22]);
  assert.equal(probeColor(raster, geometry, { box: [115, 15, 145, 45], mode: 'dark' }).ink, '#111116');
});
