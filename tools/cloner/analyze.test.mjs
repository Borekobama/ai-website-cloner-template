import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeLayout, analyzePalette, renderLayoutMarkdown } from './analyze.mjs';
import { createRaster } from './image.mjs';
import { renderDesignTokensMarkdown } from './tokens.mjs';
import { paintRect, paintRoundedRect } from './test-app/rasters.mjs';

// A 1x dashboard: a canvas, a sidebar, two cards, a badge, and dark text.
function dashboard() {
  const raster = createRaster(600, 400, [239, 238, 243, 255]);
  paintRoundedRect(raster, [16, 16, 256, 384], 24, [255, 255, 255]);
  paintRoundedRect(raster, [272, 16, 584, 200], 24, [255, 255, 255]);
  paintRoundedRect(raster, [272, 216, 584, 384], 24, [255, 255, 255]);
  paintRect(raster, [32, 32, 112, 56], [201, 242, 76]);
  for (let line = 0; line < 6; line += 1) paintRect(raster, [300, 40 + line * 20, 520, 41.5 + line * 20], [17, 17, 22]);
  return raster;
}

test('the palette separates flat surfaces from text stroke cores', () => {
  const tokens = analyzePalette([{ page: 'home', raster: dashboard(), geometry: { origin: { x: 0, y: 0 }, scale: 1 } }], { runId: '20261002T000000Z_source_00000000', siteKey: 'fixture' });
  const surfaces = tokens.colors.surface.map((entry) => entry.value);
  assert.deepEqual(surfaces.slice(0, 2).sort(), ['#efeef3', '#ffffff']);
  assert.ok(surfaces.includes('#c9f24c'));
  assert.equal(tokens.colors.text[0].value, '#111116');
  assert.equal(tokens.evidence, 'image');
  const markdown = renderDesignTokensMarkdown(tokens);
  assert.match(markdown, /screenshot pixels/u);
  assert.match(markdown, /\| Surface colors \| Pixels \|/u);
});

test('the layout skeleton finds panels, gaps, insets, and radii', () => {
  const layout = analyzeLayout(dashboard());
  const boxes = layout.panels.map((panel) => panel.box.join(','));
  assert.ok(boxes.includes('16,16,256,384'), boxes.join(' '));
  assert.ok(boxes.includes('32,32,112,56'));
  assert.equal(layout.gaps[0].value, 16);
  assert.ok(layout.insets.some((entry) => entry.value === 16));
  assert.ok(layout.radii.some((entry) => Math.abs(entry.value - 24) <= 1), JSON.stringify(layout.radii));
  const badge = layout.panels.find((panel) => panel.box.join(',') === '32,32,112,56');
  assert.equal(layout.panels[badge.parent].box.join(','), '16,16,256,384');
  assert.match(renderLayoutMarkdown([{ page: 'home', route: '/', layout }], { runId: 'run' }), /## home/u);
});
