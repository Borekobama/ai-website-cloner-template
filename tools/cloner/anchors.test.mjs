import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { anchorEdgesMatch, captureViewport, compareAnchorValues, compareImageParity, evaluateAnchors, normalizeAnchorsConfig } from './anchors.mjs';
import { compareRuns, findingCanClose } from './diff.mjs';
import { createRaster, rasterFromPng, toPng } from './image.mjs';
import { ingestScreens } from './ingest.mjs';
import { closeRun, createRun, readManifest, writeArtifact } from './run-store.mjs';
import { paintRect } from './test-app/rasters.mjs';

const SCALE = 1.5;
const page = (shift = 0) => {
  const raster = createRaster(Math.round(480 * SCALE), Math.round(300 * SCALE), [255, 255, 255, 255]);
  paintRect(raster, [(100.25 + shift) * SCALE, 50 * SCALE, (300.5 + shift) * SCALE, 120 * SCALE], [32, 32, 48]);
  paintRect(raster, [(20 + shift) * SCALE, 200 * SCALE, (180 + shift) * SCALE, 216 * SCALE], [201, 242, 76]);
  return raster;
};
const CONFIG = {
  schemaVersion: 1,
  pages: [{
    page: 'home',
    viewport: { width: 480, height: 300 },
    anchors: [
      { id: 'panel-left', probe: { type: 'edges', axis: 'x', at: 80, from: 60, to: 200 } },
      { id: 'panel-right', probe: { type: 'edges', axis: 'x', at: 80, from: 200, to: 400 }, pick: 'edges.-1.position' },
      { id: 'badge-colour', probe: { type: 'color', box: [40, 204, 160, 212] } },
    ],
    // A 2 px shift changes about 1.4 % of this region, below the 2 % default.
    regions: [{ id: 'panel', box: [90, 40, 320, 130], mode: 'gate', threshold: 0.005 }],
  }],
};

test('the anchors config is validated and filled with defaults', () => {
  const config = normalizeAnchorsConfig(CONFIG);
  assert.equal(config.pages[0].anchors[0].pick, 'edges.0.position');
  assert.equal(config.pages[0].anchors[0].tolerance, 1);
  assert.equal(config.pages[0].anchors[2].pick, 'median');
  assert.equal(config.pages[0].anchors[2].tolerance, 6);
  assert.equal(config.pages[0].regions[0].pixelThreshold, 0.2);
  const pageWith = (entry) => ({ pages: [{ page: 'home', ...entry }] });
  assert.throws(() => normalizeAnchorsConfig(pageWith({ anchors: [{ id: 'a', probe: { type: 'magic' } }] })), /probe type/u);
  assert.throws(() => normalizeAnchorsConfig(pageWith({ anchors: [{ id: 'a', probe: { type: 'box', box: [0, 0, 1, 1] } }, { id: 'a', probe: { type: 'box', box: [0, 0, 1, 1] } }] })), /repeats/u);
  assert.throws(() => normalizeAnchorsConfig(pageWith({ viewport: { width: 100, height: 100 }, regions: [{ id: 'all', box: [0, 0, 100, 100], mode: 'gate' }] })), /whole-page region/u);
  assert.equal(normalizeAnchorsConfig(pageWith({ viewport: { width: 100, height: 100 }, regions: [{ id: 'all', box: [0, 0, 100, 100] }] })).pages[0].regions[0].mode, 'informational');
  assert.throws(() => normalizeAnchorsConfig(pageWith({})), /at least one anchor or region/u);
  assert.throws(() => normalizeAnchorsConfig(pageWith({ state: { action: 'drag', selector: '#x' }, anchors: [{ id: 'a', probe: { type: 'radius', box: [0, 0, 9, 9] } }] })), /state/u);
});

test('anchors evaluate probes and compare numbers as pixels and colours as RGB distance', () => {
  const config = normalizeAnchorsConfig(CONFIG);
  const values = evaluateAnchors(page(), { origin: { x: 0, y: 0 }, scale: SCALE }, config.pages[0].anchors);
  assert.ok(Math.abs(values[0].value - 100.25) < 0.05);
  assert.ok(Math.abs(values[1].value - 300.5) < 0.05);
  assert.equal(values[2].value, '#c9f24c');
  assert.deepEqual(compareAnchorValues(100.25, 101.5, 1), { comparable: true, delta: 1.25, within: false });
  assert.equal(compareAnchorValues('#c9f24c', '#c9f04c', 6).within, true);
  assert.equal(compareAnchorValues(null, 3, 1).comparable, false);
  const missing = evaluateAnchors(page(), { origin: { x: 0, y: 0 }, scale: SCALE }, [{ id: 'none', probe: { type: 'edges', axis: 'x', at: 280, from: 0, to: 400 }, pick: 'edges.0.position' }]);
  assert.equal(missing[0].value, null);
  assert.deepEqual(captureViewport({}, { frame: { cropped: { right: true } }, geometry: { css: { width: 900, height: 600 } } }, 1440), { viewport: { width: 1440, height: 600 }, assumed: true });
});

test('an edge anchor that lands on a different edge is not within tolerance', () => {
  const geometry = { origin: { x: 0, y: 0 }, scale: SCALE };
  const banded = (band) => {
    const raster = createRaster(300, 60, [255, 255, 255, 255]);
    if (band) paintRect(raster, [100 * SCALE, 0, 102 * SCALE, 60], [220, 40, 40]);
    paintRect(raster, [(band ? 102 : 101) * SCALE, 0, 190 * SCALE, 60], [40, 40, 220]);
    return raster;
  };
  const [anchor] = normalizeAnchorsConfig({ pages: [{ page: 'home', anchors: [{ id: 'blue-start', probe: { type: 'edges', axis: 'x', at: 20, from: 96, to: 106 }, pick: 'edges.-1.position', tolerance: 3 }] }] }).pages[0].anchors;
  const [reference] = evaluateAnchors(banded(true), geometry, [anchor]);
  const [clone] = evaluateAnchors(banded(false), geometry, [anchor]);
  assert.ok(Math.abs(reference.value - 102) < 0.05 && Math.abs(clone.value - 101) < 0.05);
  assert.equal(compareAnchorValues(reference.value, clone.value, 3).within, true, 'the position alone is within tolerance');
  assert.equal(anchorEdgesMatch(reference, clone), false, 'but the edge starts from white, not red');
  assert.equal(anchorEdgesMatch(reference, reference), true);
});

// An image source run from a raw 1.5x screenshot, and clone runs that hold an
// anchors capture as `measure --anchors` writes it.
async function imageParityFixture(root) {
  writeFileSync(join(root, 'home.png'), toPng(page()));
  writeFileSync(join(root, 'screens.json'), JSON.stringify({ site: 'anchors', screens: [{ image: 'home.png', page: 'home', route: '/', kind: 'raw', scale: SCALE }] }));
  const source = await ingestScreens({ root, screensPath: 'screens.json', siteKey: 'anchors-fixture' });
  const siteKey = source.siteKey;
  const sourceRunId = source.manifest.runId;
  const config = normalizeAnchorsConfig(CONFIG);
  let sequence = 0;
  const cloneRun = (raster, { referenceRunId = sourceRunId } = {}) => {
    sequence += 1;
    const runId = `20261002T10000${sequence}Z_clone_0000000${sequence}`;
    createRun({ root, siteKey, runId, kind: 'clone', target: { kind: 'clone', origin: 'http://127.0.0.1:3000' }, scope: { inventoryRunId: null, authoritativeInventory: false, routesRequested: ['/'], routesCompleted: ['/'] } });
    writeArtifact(root, siteKey, runId, 'anchors.json', config, { kind: 'anchor-config' });
    const image = toPng(raster);
    writeArtifact(root, siteKey, runId, 'measurements/anchors/home.png', image, { kind: 'anchor-capture-png', visibility: 'private' });
    writeArtifact(root, siteKey, runId, 'measurements/anchors.json', {
      schemaVersion: 1,
      kind: 'anchor-observation',
      referenceRunId,
      pages: [{ page: 'home', route: '/', status: 'captured', viewport: { width: 480, height: 300 }, deviceScaleFactor: SCALE, width: raster.width, height: raster.height, artifactPath: 'measurements/anchors/home.png', anchors: evaluateAnchors(rasterFromPng(image), { origin: { x: 0, y: 0 }, scale: SCALE }, config.pages[0].anchors) }],
      complete: true,
    }, { kind: 'anchor-observation', visibility: 'private' });
    writeArtifact(root, siteKey, runId, 'measurements/routes.json', { routes: [{ route: '/', finalUrl: 'http://127.0.0.1:3000/', status: 200, runtimeErrors: { captured: true, pageErrors: [], consoleErrors: [], consoleWarnings: 0, hydrationErrors: 0 } }] });
    writeArtifact(root, siteKey, runId, 'coverage.json', { inventory: { runId: null, authoritative: false }, measurement: {}, scope: 'ad-hoc' });
    closeRun(root, siteKey, runId);
    return runId;
  };
  return { siteKey, sourceRunId, cloneRun };
}

test('image parity passes a faithful clone and flags a shifted one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloner-anchors-'));
  try {
    const { siteKey, sourceRunId, cloneRun } = await imageParityFixture(root);
    const faithful = cloneRun(page());
    const report = compareRuns({ root, siteKey, sourceRunId, cloneRunId: faithful, reportRunId: '20261002T110000Z_diff_aaaaaaaa' });
    assert.equal(report.evidence, 'image');
    assert.deepEqual(report.findings, []);
    assert.equal(report.imageParityCoverage.complete, true);
    assert.equal(report.imageParityCoverage.anchorsWithinTolerance, 3);
    assert.ok(report.notApplicable.includes('controls'));
    assert.ok(report.imageParity.pages[0].views.diff.endsWith('.diff.png'));

    const shifted = cloneRun(page(2));
    const mismatch = compareImageParity({ root, siteKey, sourceRunId, cloneRunId: shifted, cloneManifest: readManifest(root, siteKey, shifted), reportRunId: '20261002T110001Z_diff_bbbbbbbb' });
    const anchors = mismatch.findings.filter((finding) => finding.category === 'image-anchor-mismatch');
    assert.deepEqual(anchors.map((finding) => finding.subject.anchorId), ['panel-left', 'panel-right']);
    assert.ok(anchors.every((finding) => Math.abs(finding.observed.delta - 2) < 0.05 && finding.status === 'open'));
    const region = mismatch.findings.find((finding) => finding.category === 'image-region-mismatch');
    assert.equal(region.status, 'open');
    assert.ok(mismatch.visualArtifacts.some((artifact) => artifact.path === 'image-regions/home/panel.diff.png'));

    // The repaired clone closes the finding under the same definition only.
    const repairedReport = compareRuns({ root, siteKey, sourceRunId, cloneRunId: cloneRun(page()) });
    assert.equal(findingCanClose({ finding: anchors[0] }, repairedReport), true);
    assert.equal(findingCanClose({ finding: { ...anchors[0], policy: { ...anchors[0].policy, tolerance: 5 } } }, repairedReport), false);

    const stale = cloneRun(page(), { referenceRunId: '20260101T000000Z_source_cccccccc' });
    const staleReport = compareImageParity({ root, siteKey, sourceRunId, cloneRunId: stale, cloneManifest: readManifest(root, siteKey, stale) });
    assert.equal(staleReport.coverage.complete, false);
    assert.ok(staleReport.findings.every((finding) => finding.status === 'informational' && finding.category.endsWith('-incomplete')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
