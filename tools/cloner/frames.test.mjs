import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeScreen, detectBackdrop, detectFrames, inferScale } from './frames.mjs';
import { createRaster } from './image.mjs';
import { paintPresentationFrame, paintRect } from './test-app/rasters.mjs';

const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);

// The Permitly overview shot: a 1440 x 1024 design at 1.3583 image pixels per
// CSS pixel, placed at a fractional offset on a grey backdrop.
function presentationShot({ scale = 1.3583, origin = [45.25, 73.5], css = [1440, 1024], size = [2048, 1536] } = {}) {
  const raster = createRaster(size[0], size[1], [228, 228, 233, 255]);
  const frameBox = [origin[0], origin[1], origin[0] + css[0] * scale, origin[1] + css[1] * scale];
  paintPresentationFrame(raster, frameBox);
  // A white sidebar 16 CSS pixels inside the frame must not be taken as its edge.
  paintRect(raster, [origin[0] + 16 * scale, origin[1] + 16 * scale, origin[0] + 256 * scale, frameBox[3] - 16 * scale], [255, 255, 255]);
  return { raster, frameBox };
}

test('the backdrop is the dominant border colour', () => {
  const { raster } = presentationShot();
  const backdrop = detectBackdrop(raster);
  assert.deepEqual(backdrop.color, [228, 228, 233]);
  assert.ok(backdrop.share > 0.99);
});

test('a presentation frame is found at sub-pixel accuracy despite a drop shadow', () => {
  const { raster, frameBox } = presentationShot();
  const [frame, ...others] = detectFrames(raster);
  assert.equal(others.length, 0);
  near(frame.x, frameBox[0], 0.3, 'x');
  near(frame.y, frameBox[1], 0.3, 'y');
  near(frame.width, frameBox[2] - frameBox[0], 0.5, 'width');
  near(frame.height, frameBox[3] - frameBox[1], 0.5, 'height');
  near(inferScale(frame, { designWidth: 1440 }).scale, 1.3583, 1.3583 * 0.002, 'design-width scale');
  const common = inferScale(frame);
  assert.equal(common.method, 'common-size');
  assert.deepEqual(common.size, { width: 1440, height: 1024 });
  near(common.scale, 1.3583, 1.3583 * 0.002, 'common-size scale');
});

test('auto mode accepts a clear presentation frame and keeps a plain page raw', () => {
  const { raster } = presentationShot();
  const screen = analyzeScreen(raster);
  assert.equal(screen.kind, 'presentation');
  near(screen.geometry.css.width, 1440, 1, 'css width');
  near(screen.geometry.css.height, 1024, 1, 'css height');
  assert.match(screen.warnings.join(' '), /detected automatically/u);
  const page = createRaster(1440, 900, [255, 255, 255, 255]);
  paintRect(page, [100, 100, 700, 400], [240, 240, 240]);
  const raw = analyzeScreen(page, { designWidth: 1440 });
  assert.equal(raw.kind, 'raw');
  assert.equal(raw.geometry.scale, 1);
});

test('several frames in one image are ordered by area', () => {
  const raster = createRaster(2400, 1200, [32, 32, 40, 255]);
  paintRect(raster, [60, 100, 1500, 1000], [250, 250, 250]);
  paintRect(raster, [1700.5, 150.25, 2090.5, 994.25], [250, 250, 250]);
  const frames = detectFrames(raster);
  assert.equal(frames.length, 2);
  near(frames[0].x, 60, 0.3, 'desktop x');
  near(frames[1].x, 1700.5, 0.3, 'phone x');
  near(frames[1].width, 390, 0.5, 'phone width');
  near(inferScale(frames[1]).scale, 1, 0.01, 'phone scale');
});

test('a cropped zoom takes its scale from an anchor of known CSS length', () => {
  // The Permitly requirements shot: 1.7025 scale, cut off right and bottom.
  const scale = 1.7025;
  const origin = [105.4, 132.6];
  const raster = createRaster(1200, 800, [228, 228, 233, 255]);
  paintPresentationFrame(raster, [origin[0], origin[1], 1300, 900], { shadow: false });
  paintRect(raster, [origin[0] + 16 * scale, origin[1] + 16 * scale, origin[0] + 256 * scale, 900], [255, 255, 255]);
  assert.equal(analyzeScreen(raster, { kind: 'presentation' }).scale.method, 'unresolved');
  const screen = analyzeScreen(raster, { kind: 'presentation', anchors: [{ axis: 'x', native: [origin[0] + 16 * scale, origin[0] + 256 * scale], css: 240 }] });
  assert.deepEqual(screen.frame.cropped, { left: false, top: false, right: true, bottom: true });
  near(screen.geometry.scale, scale, 0.0005, 'scale');
  near(screen.geometry.origin.x, origin[0], 0.3, 'origin x');
  near(screen.geometry.origin.y, origin[1], 0.3, 'origin y');
  near(screen.geometry.css.width, (1200 - origin[0]) / scale, 0.2, 'visible css width');
  assert.throws(() => analyzeScreen(raster, { kind: 'presentation', anchors: [{ axis: 'x', native: [1, 1], css: 10 }] }), /Anchor 1/u);
});

test('raw screenshots and design exports use the whole image with a declared scale', () => {
  const raster = createRaster(2880, 1800, [255, 255, 255, 255]);
  const screen = analyzeScreen(raster, { kind: 'raw', dpr: 2 });
  assert.deepEqual(screen.geometry.origin, { x: 0, y: 0 });
  assert.equal(screen.geometry.scale, 2);
  assert.deepEqual(screen.geometry.css, { width: 1440, height: 900 });
  const exported = analyzeScreen(raster, { kind: 'design-export', designWidth: 1440 });
  assert.equal(exported.scale.method, 'design-width');
  assert.equal(exported.geometry.scale, 2);
  const declared = analyzeScreen(raster, { frame: [100, 50, 1440, 900], scale: 1 });
  assert.equal(declared.kind, 'presentation');
  assert.deepEqual(declared.geometry.origin, { x: 100, y: 50 });
  // 1440 x 900 and 1280 x 800 share the aspect, so the guess has low confidence.
  const guessed = analyzeScreen(raster, { kind: 'raw' }).scale;
  assert.equal(guessed.method, 'common-size');
  assert.equal(guessed.confidence, 0.4);
  assert.equal(analyzeScreen(createRaster(1000, 3000), { kind: 'raw' }).scale.method, 'unresolved');
});
