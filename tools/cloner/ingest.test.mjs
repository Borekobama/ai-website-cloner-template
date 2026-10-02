import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRaster, rasterFromPng, toPng } from './image.mjs';
import { ingestScreens, normalizeScreensConfig } from './ingest.mjs';
import { probeEdges } from './probes.mjs';
import { readArtifact, readManifest, resolveRunId, writeArtifact } from './run-store.mjs';
import { paintPresentationFrame, paintRect } from './test-app/rasters.mjs';

// Three input kinds: a presentation shot of a 1440 x 1024 design at 1.3583,
// a raw 2x screenshot, and a 1x design export of a mobile state.
function screensFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cloner-ingest-'));
  const scale = 1.3583;
  const origin = [45.25, 73.5];
  const presentation = createRaster(2048, 1536, [228, 228, 233, 255]);
  paintPresentationFrame(presentation, [origin[0], origin[1], origin[0] + 1440 * scale, origin[1] + 1024 * scale]);
  paintRect(presentation, [origin[0] + 16 * scale, origin[1] + 16 * scale, origin[0] + 256 * scale, origin[1] + 1008 * scale], [255, 255, 255]);
  writeFileSync(join(directory, 'overview.png'), toPng(presentation));
  const raw = createRaster(1440, 900, [250, 250, 250, 255]);
  paintRect(raw, [200, 200, 600, 400], [20, 20, 30]);
  writeFileSync(join(directory, 'raw@2x.png'), toPng(raw));
  const exported = createRaster(390, 844, [255, 255, 255, 255]);
  paintRect(exported, [16, 100, 374, 160], [201, 242, 76]);
  writeFileSync(join(directory, 'mobile.png'), toPng(exported));
  writeFileSync(join(directory, 'screens.json'), JSON.stringify({
    schemaVersion: 1,
    site: 'fixture',
    designWidth: 1440,
    screens: [
      { image: 'overview.png', page: 'overview', route: '/', kind: 'presentation' },
      { image: 'raw@2x.png', page: 'pricing', route: '/pricing', kind: 'raw', dpr: 2 },
      { image: 'mobile.png', page: 'mobile-home', route: '/', kind: 'design-export', scale: 1, state: 'mobile' },
    ],
  }));
  return directory;
}

test('screens.json is validated before any run exists', () => {
  const screen = { image: 'a.png', page: 'home', route: '/' };
  assert.throws(() => normalizeScreensConfig({ screens: [] }), /non-empty/u);
  assert.throws(() => normalizeScreensConfig({ screens: [{ ...screen, page: 'Home' }] }), /page key/u);
  assert.throws(() => normalizeScreensConfig({ screens: [screen, { ...screen, route: '/a' }] }), /repeats page key/u);
  assert.throws(() => normalizeScreensConfig({ screens: [{ ...screen, route: 'home' }] }), /route/u);
  assert.throws(() => normalizeScreensConfig({ screens: [{ ...screen, kind: 'mockup' }] }), /kind/u);
  assert.throws(() => normalizeScreensConfig({ screens: [{ ...screen, liveSource: 'ftp://example.test' }] }), /liveSource/u);
  assert.throws(() => normalizeScreensConfig({ screens: [{ ...screen, anchors: [{ native: [1, 2] }] }] }), /Anchor 1/u);
  assert.equal(normalizeScreensConfig({ designWidth: 1440, screens: [screen] }).screens[0].designWidth, 1440);
});

test('ingest writes an immutable image source run with references and routes', async () => {
  const directory = screensFixture();
  try {
    const result = await ingestScreens({ root: directory, screensPath: 'screens.json', inventory: true });
    assert.match(result.siteKey, /^fixture-screens-[a-f0-9]{8}$/u);
    const runId = result.manifest.runId;
    const manifest = readManifest(directory, result.siteKey, runId);
    assert.equal(manifest.status, 'closed');
    assert.equal(manifest.target.evidence, 'image');
    assert.equal(resolveRunId(directory, result.siteKey, 'current', 'source'), runId);
    const [overview, pricing, mobile] = result.screens;
    assert.ok(Math.abs(overview.geometry.scale - 1.3583) < 1.3583 * 0.002);
    assert.equal(pricing.geometry.scale, 2);
    assert.deepEqual(pricing.geometry.css, { width: 720, height: 450 });
    assert.equal(mobile.scale.method, 'declared');
    assert.equal(mobile.state, 'mobile');
    const routes = JSON.parse(readArtifact(directory, result.siteKey, runId, 'measurements/routes.json'));
    assert.deepEqual(routes.routes.map((route) => [route.route, route.pages]), [['/', ['overview', 'mobile-home']], ['/pricing', ['pricing']]]);
    const reference = rasterFromPng(readArtifact(directory, result.siteKey, runId, 'references/overview.png'));
    assert.deepEqual([reference.width, reference.height], [1440, 1024]);
    // Probing the stored native crop gives CSS positions of the design.
    const native = rasterFromPng(readArtifact(directory, result.siteKey, runId, overview.references.native));
    const edges = probeEdges(native, overview.cropGeometry, { axis: 'x', at: 500, from: 0, to: 400 }).edges.map((edge) => edge.position);
    assert.ok(Math.abs(edges[0] - 16) < 0.2 && Math.abs(edges[1] - 256) < 0.2, `sidebar edges ${edges}`);
    assert.ok(existsSync(join(directory, 'docs/design-references', result.siteKey, 'overview/reference.png')));
    assert.ok(existsSync(join(directory, 'docs/design-references', result.siteKey, 'pricing/source.png')));
    assert.throws(() => writeArtifact(directory, result.siteKey, runId, 'measurements/late.json', {}), /immutable/u);
    const adHoc = await ingestScreens({ root: directory, screensPath: 'screens.json', siteKey: 'fixture-ad-hoc' });
    assert.equal(adHoc.coverage.scope, 'ad-hoc');
    assert.throws(() => resolveRunId(directory, 'fixture-ad-hoc', 'current', 'source'), /No source-current ref/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a screen without a resolvable scale stops ingest before a run exists', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloner-ingest-unresolved-'));
  try {
    writeFileSync(join(directory, 'tall.png'), toPng(createRaster(1000, 3000, [255, 255, 255, 255])));
    writeFileSync(join(directory, 'screens.json'), JSON.stringify({ screens: [{ image: 'tall.png', page: 'home', route: '/', kind: 'raw' }] }));
    await assert.rejects(() => ingestScreens({ root: directory, screensPath: 'screens.json' }), /home \(tall\.png\): Declare scale/u);
    assert.equal(existsSync(join(directory, 'docs')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
