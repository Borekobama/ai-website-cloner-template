import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PNG } from 'pngjs';
import { classNamesFromCss, auditDeadRuntimeClasses } from './audits/dead-classes.mjs';
import { classifyControl, compareEffectSignatures } from './audits/dead-controls.mjs';
import { compareMeasurementData, findingCanClose, selectControlAudit } from './diff.mjs';
import { assertResumeCompatibility } from './measure.mjs';
import { compareMotionObservations } from './motion.mjs';
import { appendLedgerEvent, auditFindingCanClose, readLedger, recordFindingStatus, stableFindingId, summarizeFindings } from './ledger.mjs';
import { evaluateAction, normalizePolicy, policySha256 } from './policy.mjs';
import { containsSensitiveMaterial, redactForPersistence } from './redact.mjs';
import { captureDomSnapshot } from './dom-snapshot.mjs';
import { closeRun, createRun, failRun, freezeFixture, readArtifact, readManifest, resolveRunId, setRef, updateRun, writeArtifact } from './run-store.mjs';
import { startFixtureServer } from './test-app/server.mjs';
import { captureVisualRegions, compareVisualRegionImages, normalizeVisualRegionConfig, visualRegionConfigHash } from './visual-regions.mjs';

function createAuthoritativeInventory(root, siteKey, runId, routes = ['/home', '/billing'], target = 'clone') {
  const run = createRun({
    root,
    siteKey,
    runId,
    kind: target,
    target: { kind: target },
    scope: {
      inventoryRunId: runId,
      authoritativeInventory: true,
      routesRequested: routes,
      routesCompleted: routes,
      routesFailed: [],
    },
  });
  writeArtifact(root, siteKey, runId, 'inventory.json', { runId, authoritative: true, routes: routes.map((route) => ({ route })) });
  writeArtifact(root, siteKey, runId, 'coverage.json', {
    inventory: { runId, routes: routes.length, authoritative: true },
    measurement: { routesRequested: routes.length, routesCompleted: routes.length },
    scope: 'full',
  });
  closeRun(root, siteKey, runId);
  return run;
}

test('redaction happens before persistence and removes credential-bearing URLs', () => {
  const safe = redactForPersistence({
    authorization: 'Bearer abc',
    cookie: 'session=abc',
    url: 'https://example.test/home?session=abc&view=full',
    profileDir: '/tmp/.cloner-profiles/primary',
  });
  assert.equal(safe.authorization, '[REDACTED]');
  assert.equal(safe.cookie, '[REDACTED]');
  assert.equal(safe.url, 'https://example.test/home?session=%5BREDACTED%5D&view=full');
  assert.equal(safe.profileDir, '[REDACTED]');
  assert.equal(containsSensitiveMaterial(safe), false);
  const header = redactForPersistence('Authorization: Bearer secret Cookie: session=secret');
  assert.equal(containsSensitiveMaterial(header), false);
});

test('DOMSnapshot redaction removes sensitive metadata and script text', async () => {
  const snapshot = await captureDomSnapshot({
    url: () => 'https://fixture.test/home',
    context: () => ({
      newCDPSession: async () => ({
        send: async () => ({
          strings: ['META', 'name', 'csrf-token', 'content', 'fixture-secret', 'SCRIPT', '#text', 'script-secret'],
          documents: [{
            nodes: {
              nodeName: [0, 5, 6],
              parentIndex: [-1, -1, 1],
              attributes: [[1, 2, 3, 4], [], []],
              textValue: { index: [2], value: [7] },
            },
          }],
        }),
        detach: async () => {},
      }),
    }),
  }, { route: '/home' });
  assert.equal(snapshot.snapshot.strings[4], '[REDACTED]');
  assert.equal(snapshot.snapshot.strings[7], '[REDACTED]');
  assert.equal(JSON.stringify(snapshot).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(snapshot).includes('script-secret'), false);
});

function visualPng(color) {
  const png = new PNG({ width: 2, height: 2 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = color[0];
    png.data[index + 1] = color[1];
    png.data[index + 2] = color[2];
    png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}

test('visual region config and pixel comparison preserve explicit semantics', () => {
  const config = normalizeVisualRegionConfig({
    schemaVersion: 1,
    regions: [{ route: '/home', viewport: { width: 1440, height: 900, deviceScaleFactor: 1 }, id: 'sidebar', selector: '[data-region="sidebar"]', classification: 'invariant', mode: 'gate', threshold: 0.001, pixelThreshold: 0.1 }],
  });
  assert.equal(config.regions[0].classification, 'invariant');
  assert.equal(visualRegionConfigHash(config).length, 64);
  const equal = compareVisualRegionImages(visualPng([20, 20, 20]), visualPng([20, 20, 20]));
  assert.equal(equal.equal, true);
  assert.equal(equal.complete, true);
  assert.equal(equal.diffPixels, 0);
  assert.equal(equal.diffRatio, 0);
  assert.deepEqual([...equal.diff.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const mismatch = compareVisualRegionImages(visualPng([20, 20, 20]), visualPng([220, 20, 20]));
  assert.equal(mismatch.equal, false);
  assert.equal(mismatch.diffPixels, 4);
  assert.equal(mismatch.diffRatio, 1);
  assert.throws(() => normalizeVisualRegionConfig({ regions: [{ route: '/home', viewport: { width: 1, height: 1 }, id: 'bad', selector: '#x', classification: 'weird', mode: 'informational' }] }), /unsupported classification/);
  assert.throws(() => normalizeVisualRegionConfig({ regions: [{ route: '/home', viewport: { width: 1, height: 1 }, id: 'bad', selector: '#x', threshold: 2 }] }), /threshold.*between/);
  assert.throws(() => normalizeVisualRegionConfig({ regions: [{ route: '/home', viewport: { width: 1, height: 1 }, id: 'bad', selector: '#x', threshold: -1 }] }), /threshold.*between/);
  assert.throws(() => normalizeVisualRegionConfig({ regions: [{ route: '/home', viewport: { width: 1, height: 1 }, id: 'bad', selector: '#x', pixelThreshold: 2 }] }), /pixelThreshold.*between/);
  assert.throws(() => normalizeVisualRegionConfig({ regions: [{ route: '/home', viewport: { width: 1, height: 1 }, id: 'bad', selector: '#x', maxDiffPixels: 1.5 }] }), /maxDiffPixels must be/);
  assert.throws(() => normalizeVisualRegionConfig({ regions: [{ route: '/home', viewport: { width: 1, height: 1 }, id: 'bad', selector: '#x', maxDiffPixels: '4' }] }), /maxDiffPixels must be/);
  assert.throws(() => compareVisualRegionImages(visualPng([20, 20, 20]), visualPng([20, 20, 20]), { threshold: -0.1 }), /threshold.*between/);
  assert.throws(() => compareVisualRegionImages(visualPng([20, 20, 20]), visualPng([20, 20, 20]), { pixelThreshold: 2 }), /pixelThreshold.*between/);
  assert.throws(() => compareVisualRegionImages(visualPng([20, 20, 20]), visualPng([20, 20, 20]), { maxDiffPixels: -1 }), /maxDiffPixels must be/);
});

test('visual comparator emits mismatch and preserves complete coverage for repair', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloner-visual-test-'));
  const siteKey = 'visual.example';
  const sourceRunId = '20260914T000001Z_source_11111111';
  const cloneRunId = '20260914T000002Z_clone_22222222';
  const makeRun = (runId, target, image) => {
    createRun({ root, siteKey, runId, kind: target, target: { kind: target }, scope: { inventoryRunId: null, authoritativeInventory: false } });
    writeArtifact(root, siteKey, runId, 'coverage.json', { inventory: { runId: null, authoritative: false }, measurement: {}, scope: 'ad-hoc' });
    writeArtifact(root, siteKey, runId, 'measurements/visual-regions/home/chrome.png', image, { kind: 'visual-region-png', visibility: 'private' });
    closeRun(root, siteKey, runId);
  };
  const region = { route: '/home', id: 'chrome', status: 'captured', artifactPath: 'measurements/visual-regions/home/chrome.png', viewport: { width: 2, height: 2, deviceScaleFactor: 1 }, mode: 'gate', threshold: 0, pixelThreshold: 0.1 };
  try {
    makeRun(sourceRunId, 'source', visualPng([20, 20, 20]));
    makeRun(cloneRunId, 'clone', visualPng([220, 20, 20]));
    const sourceVisual = { routes: [{ route: '/home', regions: [region] }] };
    const cloneVisual = { routes: [{ route: '/home', regions: [region] }] };
    const mismatch = compareMeasurementData({ root, siteKey, sourceRoutes: { routes: [] }, cloneRoutes: { routes: [] }, sourceControls: { observations: [] }, cloneControls: { observations: [] }, sourceClasses: { routes: [] }, cloneClasses: { routes: [] }, sourceVisual, cloneVisual, sourceRunId, cloneRunId });
    assert.equal(mismatch.findings[0].category, 'visual-region-mismatch');
    assert.equal(mismatch.comparatorCoverage.at(-1).complete, true);
    makeRun(cloneRunId.replace('000002', '000003').replace('22222222', '33333333'), 'clone', visualPng([20, 20, 20]));
    const repairedCloneRunId = '20260914T000003Z_clone_33333333';
    const repaired = compareMeasurementData({ root, siteKey, sourceRoutes: { routes: [] }, cloneRoutes: { routes: [] }, sourceControls: { observations: [] }, cloneControls: { observations: [] }, sourceClasses: { routes: [] }, cloneClasses: { routes: [] }, sourceVisual, cloneVisual: { routes: [{ route: '/home', regions: [{ ...region, artifactPath: region.artifactPath }] }] }, sourceRunId, cloneRunId: repairedCloneRunId });
    assert.equal(repaired.findings.length, 0);
    assert.equal(repaired.visualCoverage.complete, true);
    assert.equal(findingCanClose({ finding: mismatch.findings[0] }, {
      ...repaired,
      source: { target: { kind: 'source' }, scope: { routesCompleted: ['/home'] } },
      clone: { target: { kind: 'clone' }, scope: { routesCompleted: ['/home'] } },
    }), true);
    const priorPolicy = { routes: [{ route: '/home', regions: [{ ...region, classification: 'invariant', mode: 'informational' }] }] };
    const currentPolicy = { routes: [{ route: '/home', regions: [{ ...region, classification: 'data-dependent', mode: 'informational' }] }] };
    const priorPolicyReport = compareMeasurementData({ root, siteKey, sourceRoutes: { routes: [] }, cloneRoutes: { routes: [] }, sourceControls: { observations: [] }, cloneControls: { observations: [] }, sourceClasses: { routes: [] }, cloneClasses: { routes: [] }, sourceVisual: priorPolicy, cloneVisual: priorPolicy, sourceRunId, cloneRunId });
    const currentPolicyReport = compareMeasurementData({ root, siteKey, sourceRoutes: { routes: [] }, cloneRoutes: { routes: [] }, sourceControls: { observations: [] }, cloneControls: { observations: [] }, sourceClasses: { routes: [] }, cloneClasses: { routes: [] }, sourceVisual: currentPolicy, cloneVisual: currentPolicy, sourceRunId, cloneRunId: repairedCloneRunId });
    assert.equal(findingCanClose({ finding: priorPolicyReport.findings[0] }, {
      ...currentPolicyReport,
      source: { target: { kind: 'source' }, scope: { routesCompleted: ['/home'] } },
      clone: { target: { kind: 'clone' }, scope: { routesCompleted: ['/home'] } },
    }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('visual coverage uses configured regions and rejects dimension mismatch as incomplete', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloner-visual-coverage-test-'));
  const siteKey = 'visual-coverage.example';
  const sourceRunId = '20260914T000004Z_source_44444444';
  const cloneRunId = '20260914T000005Z_clone_55555555';
  const config = { schemaVersion: 1, regions: [{ route: '/home', viewport: { width: 2, height: 2, deviceScaleFactor: 1 }, id: 'chrome', selector: '#chrome', classification: 'invariant', mode: 'gate', threshold: 0 }] };
  const makeRun = (runId, target, image) => {
    createRun({ root, siteKey, runId, kind: target, target: { kind: target }, scope: { inventoryRunId: null, authoritativeInventory: false } });
    writeArtifact(root, siteKey, runId, 'coverage.json', { inventory: { runId: null, authoritative: false }, measurement: {}, scope: 'ad-hoc' });
    writeArtifact(root, siteKey, runId, 'measurements/visual-regions/home/chrome.png', image, { kind: 'visual-region-png', visibility: 'private' });
    closeRun(root, siteKey, runId);
  };
  try {
    makeRun(sourceRunId, 'source', visualPng([20, 20, 20]));
    const onePixel = new PNG({ width: 1, height: 1 });
    onePixel.data[3] = 255;
    makeRun(cloneRunId, 'clone', PNG.sync.write(onePixel));
    const base = { root, siteKey, sourceRoutes: { routes: [] }, cloneRoutes: { routes: [] }, sourceControls: { observations: [] }, cloneControls: { observations: [] }, sourceClasses: { routes: [] }, cloneClasses: { routes: [] }, sourceRunId, cloneRunId };
    const omitted = compareMeasurementData({ ...base, sourceVisual: { config, routes: [] }, cloneVisual: { config, routes: [] } });
    assert.equal(omitted.visualCoverage.complete, false);
    assert.equal(omitted.visualCoverage.regionsConfigured, 1);
    assert.equal(omitted.findings[0].category, 'visual-region-incomplete');

    const informational = { ...config, regions: [{ ...config.regions[0], mode: 'informational', classification: 'data-dependent' }] };
    const oneSided = compareMeasurementData({ ...base, sourceVisual: { config: informational, routes: [] }, cloneVisual: null });
    assert.equal(oneSided.comparatorCoverage[0].comparator.mode, 'informational');
    assert.equal(oneSided.findings[0].policy.mode, 'informational');

    const mismatchedConfig = compareMeasurementData({
      ...base,
      sourceVisual: { config, configSha256: 'source-config', routes: [] },
      cloneVisual: { config: { ...config, regions: [{ ...config.regions[0], mode: 'ignore' }] }, configSha256: 'clone-config', routes: [] },
    });
    assert.equal(mismatchedConfig.visualCoverage.complete, false);
    assert.equal(mismatchedConfig.findings[0].category, 'visual-region-incomplete');
    assert.equal(mismatchedConfig.comparatorCoverage[0].comparator.mode, 'gate');

    const dimensionSource = { ...config, routes: [{ route: '/home', regions: [{ id: 'chrome', route: '/home', status: 'captured', artifactPath: 'measurements/visual-regions/home/chrome.png', viewport: { width: 2, height: 2, deviceScaleFactor: 1 }, mode: 'gate', threshold: 0 }] }] };
    const dimensionClone = { ...dimensionSource, routes: [{ route: '/home', regions: [{ ...dimensionSource.routes[0].regions[0], viewport: { width: 1, height: 1, deviceScaleFactor: 1 } }] }] };
    const dimension = compareMeasurementData({ ...base, sourceVisual: dimensionSource, cloneVisual: dimensionClone });
    assert.equal(dimension.visualCoverage.complete, false);
    assert.equal(dimension.comparatorCoverage.at(-1).complete, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('visual capture fails invariant missing and ambiguous selectors', async () => {
  const page = (count) => ({
    url: () => 'http://fixture.test/home',
    viewportSize: () => ({ width: 2, height: 2 }),
    locator: () => ({
      count: async () => count,
      screenshot: async () => visualPng([20, 20, 20]),
    }),
  });
  const config = { schemaVersion: 1, regions: [{ route: '/home', viewport: { width: 2, height: 2 }, id: 'chrome', selector: '#chrome' }] };
  await assert.rejects(() => captureVisualRegions(page(0), { config, target: 'clone', route: '/home' }), /requires exactly one match/);
  await assert.rejects(() => captureVisualRegions(page(2), { config, target: 'clone', route: '/home' }), /requires exactly one match/);
  const informational = await captureVisualRegions(page(0), { config: { ...config, regions: [{ ...config.regions[0], classification: 'data-dependent', mode: 'informational' }] }, target: 'clone', route: '/home' });
  assert.equal(informational.complete, false);
  assert.equal(informational.regions[0].reason, 'missing-selector');
});

test('motion comparison preserves duplicate-aware state and transform evidence', () => {
  const source = {
    routes: [{ route: '/home', observations: [{
      key: '/home|button:nth-child(1)|0',
      identity: { path: 'main>button:nth-child(1)', role: 'button', name: 'Open', occurrence: 0 },
      declared: { animationName: 'none', transitionProperty: 'transform' },
      state: { 'data-state': 'closed' },
      rendered: { transform: 'matrix(1,0,0,1,0,0)', opacity: '1', visibility: 'visible' },
    }] }],
  };
  const clone = {
    routes: [{ route: '/home', observations: [{
      key: '/home|button:nth-child(1)|0',
      identity: { path: 'main>button:nth-child(1)', role: 'button', name: 'Open', occurrence: 0 },
      declared: { animationName: 'none', transitionProperty: 'transform' },
      state: { 'data-state': 'open' },
      rendered: { transform: 'matrix(0,-1,1,0,0,0)', opacity: '1', visibility: 'visible' },
    }] }],
  };
  const report = compareMotionObservations(source, clone, '20260914T000040Z_source_40404040', '20260914T000041Z_clone_41414141');
  assert.equal(report.coverage.complete, true);
  assert.equal(report.findings.some((finding) => finding.category === 'motion-state-mismatch'), true);
  assert.equal(report.findings.some((finding) => finding.category === 'motion-transform-mismatch'), true);
  assert.equal(report.findings[0].evidence.source.runId, '20260914T000040Z_source_40404040');
  assert.equal(report.findings[0].evidence.source.locator, '#/routes/0/observations/0');
});

test('motion presence coverage supports missing-subject repair', () => {
  const source = { routes: [{ route: '/home', observations: [{ key: 'toggle', identity: { path: 'main>button:nth-child(1)', role: 'button', name: 'Toggle', occurrence: 0 }, declared: {}, state: {}, rendered: {} }] }] };
  const missing = compareMotionObservations(source, { routes: [{ route: '/home', observations: [] }] }, '20260914T000050Z_source_50505050', '20260914T000051Z_clone_51515151');
  assert.equal(missing.coverage.complete, false);
  const repaired = compareMotionObservations(source, source, '20260914T000050Z_source_50505050', '20260914T000052Z_clone_52525252');
  assert.ok(repaired.comparatorCoverage.some((entry) => entry.comparator.dimension === 'presence' && entry.complete));
});

test('motion evidence locators preserve route identity', () => {
  const observation = (key, transitionProperty) => ({ key, identity: { path: 'main>button:nth-child(1)', role: 'button', name: 'Toggle', occurrence: 0 }, declared: { transitionProperty }, state: {}, rendered: {} });
  const source = { routes: [{ route: '/one', observations: [observation('/one|button|Toggle||0', 'transform')] }, { route: '/two', observations: [observation('/two|button|Toggle||0', 'transform')] }] };
  const clone = { routes: [{ route: '/one', observations: [observation('/one|button|Toggle||0', 'transform')] }, { route: '/two', observations: [observation('/two|button|Toggle||0', 'opacity')] }] };
  const report = compareMotionObservations(source, clone, '20260914T000060Z_source_60606060', '20260914T000061Z_clone_61616161');
  const finding = report.findings.find((entry) => entry.category === 'motion-declared-mismatch');
  assert.equal(finding.evidence.source.locator, '#/routes/1/observations/0');
  assert.equal(finding.evidence.clone.locator, '#/routes/1/observations/0');
});

test('motion finding identity ignores diagnostic path changes', () => {
  const finding = {
    category: 'motion-declared-mismatch',
    comparator: { instrument: 'motion', evidenceClass: 'motion', dimension: 'declared', mode: 'gate' },
    subject: { route: '/home', path: 'main>button:nth-child(1)', role: 'button', name: 'Toggle', motionId: 'toggle', occurrence: 0 },
    policy: { dimension: 'declared', mode: 'gate' },
    comparison: { sourceKind: 'source', cloneKind: 'clone' },
  };
  assert.equal(stableFindingId(finding), stableFindingId({ ...finding, subject: { ...finding.subject, path: 'main>section:nth-child(2)>button:nth-child(1)' } }));
});

test('source actions require an explicit policy allowance', () => {
  assert.equal(evaluateAction({ target: 'source', action: { route: '/billing', role: 'button', name: 'Pay' } }).outcome, 'blocked-by-policy');
  assert.equal(evaluateAction({ target: 'clone', action: { route: '/billing', role: 'button', name: 'Pay' } }).allowed, true);
  assert.equal(evaluateAction({ target: 'source', policy: { actions: [{ match: { name: 'Pay' }, clone: 'measure' }] }, action: { name: 'Pay' } }).outcome, 'blocked-by-policy');
  assert.equal(classifyControl({ policyOutcome: 'blocked-by-policy' }), 'blocked-by-policy');
  assert.equal(classifyControl({ actionability: 'unreachable' }), 'unreachable');
});

test('blocked clone actions use a clone-specific fallback reason', () => {
  const action = { route: '/fixture', role: 'button', name: 'Delete account' };
  const clone = evaluateAction({ target: 'clone', policy: { actions: [{ match: action, clone: 'block' }] }, action });
  const source = evaluateAction({ target: 'source', policy: { actions: [{ match: action, clone: 'block' }] }, action });
  assert.equal(clone.outcome, 'blocked-by-policy');
  assert.equal(clone.reason, 'Clone interaction requires an explicit safe-action policy allowance');
  assert.equal(source.reason, 'Source interaction requires an explicit safe-action policy allowance');
});

test('policy validation is strict and the most specific safe-action rule wins', () => {
  assert.throws(() => normalizePolicy({ version: 2 }), /Unsupported policy version/);
  assert.throws(() => normalizePolicy({ actions: {} }), /actions must be an array/);
  assert.throws(() => normalizePolicy({ actions: [{ match: {}, source: 'allow' }] }), /non-empty object/);
  assert.throws(() => normalizePolicy({ actions: [{ match: { name: 'Pay' }, source: 'click' }] }), /allow, block, or measure/);
  assert.throws(() => normalizePolicy({ actions: [{ match: { occurrence: 'first' }, source: 'allow' }] }), /non-negative integer/);
  assert.throws(() => normalizePolicy({ actions: [{ match: { name: 'Pay' }, source: 'allow', typo: true }] }), /Unsupported actions\[0\] field/);
  assert.throws(() => normalizePolicy({ controlClasses: { default: { dimensions: { url: 'sometimes' } } } }), /gate, informational, or ignore/);
  assert.throws(() => normalizePolicy({ controlClasses: { default: { dimension: { url: 'gate' } } } }), /Unsupported controlClasses.default field/);

  const specificBlock = evaluateAction({
    target: 'source',
    policy: {
      actions: [
        { id: 'broad-allow', match: { route: '*', role: '*', name: '*' }, source: 'allow' },
        { id: 'billing-block', match: { route: '/billing', name: 'Pay' }, source: 'block' },
      ],
    },
    action: { route: '/billing', role: 'button', name: 'Pay' },
  });
  assert.equal(specificBlock.outcome, 'blocked-by-policy');
  assert.equal(specificBlock.policyId, 'billing-block');

  const wildcardBlock = evaluateAction({
    target: 'source',
    policy: {
      actions: [
        { id: 'broad-star-allow', match: { route: '*', name: '*' }, source: 'allow' },
        { id: 'alpha-pattern-block', match: { name: 'Alpha*' }, source: 'block' },
      ],
    },
    action: { route: '/home', name: 'Alpha account' },
  });
  assert.equal(wildcardBlock.outcome, 'blocked-by-policy');
  assert.equal(wildcardBlock.policyId, 'alpha-pattern-block');

  const conflict = evaluateAction({
    target: 'source',
    policy: {
      actions: [
        { id: 'allow-one', match: { route: '/billing' }, source: 'allow' },
        { id: 'block-one', match: { route: '/billing' }, source: 'block' },
      ],
    },
    action: { route: '/billing' },
  });
  assert.equal(conflict.allowed, false);
  assert.equal(conflict.conflict, true);
  assert.deepEqual(conflict.policyIds, ['allow-one', 'block-one']);

  const targetAware = evaluateAction({
    target: 'clone',
    policy: {
      actions: [
        { id: 'broad-clone-block', match: { route: '*' }, clone: 'block' },
        { id: 'source-only-specific-allow', match: { route: '/billing', name: 'Pay' }, source: 'allow' },
      ],
    },
    action: { route: '/billing', role: 'button', name: 'Pay' },
  });
  assert.equal(targetAware.outcome, 'blocked-by-policy');
  assert.equal(targetAware.policyId, 'broad-clone-block');
});

test('dead class audit preserves route provenance and does not borrow CSS between routes', () => {
  assert.deepEqual(classNamesFromCss('.text-sm\\:hover, .bg-\\[\\#fff\\] { color: red }'), ['bg-[#fff]', 'text-sm:hover']);
  assert.deepEqual(classNamesFromCss('.-mt-4:hover, .foo:is(.bar) { color: red }'), ['-mt-4', 'bar', 'foo']);
  const audit = auditDeadRuntimeClasses([
    { route: '/first', runtimeClasses: ['shared', 'first-missing'], compiledClasses: ['shared'] },
    { route: '/second', runtimeClasses: ['shared', 'second-missing'], compiledClasses: ['shared', 'first-missing'] },
  ]);
  assert.deepEqual(audit.routes.map((route) => route.deadClasses), [['first-missing'], ['second-missing']]);
  assert.deepEqual(audit.deadClasses, ['first-missing', 'second-missing']);

  const incomplete = auditDeadRuntimeClasses([
    { route: '/private', runtimeClasses: ['possibly-missing'], compiledClasses: [], stylesheetSources: ['https://cdn.example/private.css'], stylesheetsTotal: 1, stylesheetsReadable: 0, stylesheetsUnreadable: 1, cssCoverageComplete: false },
  ]);
  assert.equal(incomplete.cssCoverageComplete, false);
  assert.equal(incomplete.stylesheetsTotal, 1);
  assert.equal(incomplete.stylesheetsReadable, 0);
  assert.equal(incomplete.stylesheetsUnreadable, 1);
  assert.deepEqual(incomplete.routes[0].deadClasses, ['possibly-missing']);
  assert.deepEqual(incomplete.findings, []);
});

test('run store is immutable after close or failure and refs resolve to concrete IDs', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloner-run-test-'));
  const siteKey = 'test.example';
  try {
    const closedRun = createAuthoritativeInventory(root, siteKey, '20260913T000001Z_controls_11111111');
    assert.throws(() => writeArtifact(root, siteKey, closedRun.runId, 'report.json', { changed: true }), /immutable/);
    setRef(root, siteKey, 'clone-current', closedRun.runId);
    assert.equal(resolveRunId(root, siteKey, 'current', 'clone'), closedRun.runId);
    assert.throws(() => resolveRunId(root, siteKey, 'latest', 'clone'), /mutable/);
    assert.equal(JSON.parse(readArtifact(root, siteKey, closedRun.runId, 'coverage.json')).inventory.runId, closedRun.runId);

    const subsetRun = createRun({ root, siteKey, runId: '20260913T000007Z_clone_77777777', kind: 'clone', target: { kind: 'clone' }, scope: { inventoryRunId: closedRun.runId, authoritativeInventory: false } });
    writeArtifact(root, siteKey, subsetRun.runId, 'coverage.json', { inventory: { runId: closedRun.runId, routes: 2, authoritative: true }, measurement: { routesRequested: 1, routesCompleted: 1 }, scope: 'subset' });
    closeRun(root, siteKey, subsetRun.runId);
    const subsetCoverage = JSON.parse(readArtifact(root, siteKey, subsetRun.runId, 'coverage.json'));
    assert.equal(subsetCoverage.scope, 'subset');
    assert.equal(subsetCoverage.inventory.routes, 2);
    assert.equal(subsetCoverage.measurement.routesRequested, 1);
    assert.throws(() => setRef(root, siteKey, 'clone-current', subsetRun.runId), /not an explicit authoritative inventory/);

    const adHocRun = createRun({ root, siteKey, runId: '20260913T000012Z_clone_cccccccc', kind: 'clone', target: { kind: 'clone' }, scope: { inventoryRunId: null, authoritativeInventory: false } });
    writeArtifact(root, siteKey, adHocRun.runId, 'coverage.json', { inventory: { runId: null, routes: 1, authoritative: false, source: 'requested-routes' }, measurement: { routesRequested: 1, routesCompleted: 1 }, scope: 'ad-hoc' });
    closeRun(root, siteKey, adHocRun.runId);
    assert.throws(() => setRef(root, siteKey, 'clone-current', adHocRun.runId), /not an explicit authoritative inventory/);
    assert.equal(resolveRunId(root, siteKey, 'current', 'clone'), closedRun.runId);

    const failedRun = createRun({ root, siteKey, runId: '20260913T000002Z_controls_22222222' });
    failRun(root, siteKey, failedRun.runId, new Error('expired session'));
    assert.throws(() => closeRun(root, siteKey, failedRun.runId), /failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resume accepts redacted origins and rejects changed repository identity', () => {
  const manifest = {
    runId: '20260914T000009Z_clone_99999999',
    status: 'failed',
    kind: 'clone',
    engine: { version: '0.12.1' },
    target: {
      kind: 'clone',
      origin: 'http://127.0.0.1:3000/',
      profileId: null,
      tenant: null,
      role: null,
      modules: { visual: false, motion: false, motionSample: false, domSnapshot: false, responsive: false, assets: false },
      hydrationSelector: null,
    },
    policySha256: null,
    repository: { commit: 'abc', dirty: false, diffSha256: null },
  };
  const compatible = {
    target: 'clone',
    origin: 'http://127.0.0.1:3000',
    profileId: null,
    tenant: null,
    role: null,
    policyHash: null,
    modules: manifest.target.modules,
    viewport: null,
    deviceScaleFactor: null,
    visualConfigSha256: null,
    hydrationSelector: null,
    repository: manifest.repository,
  };
  assert.doesNotThrow(() => assertResumeCompatibility(manifest, compatible));
  assert.throws(() => assertResumeCompatibility(manifest, { ...compatible, repository: { ...manifest.repository, commit: 'def' } }), /repository identity/);
  assert.throws(() => assertResumeCompatibility({ ...manifest, kind: 'source', target: { ...manifest.target, kind: 'source', profileId: 'profile-a' } }, { ...compatible, target: 'source', profileId: 'profile-a' }), /Source resume is disabled/);
});

test('coverage cannot close without inventory provenance', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloner-coverage-test-'));
  const siteKey = 'coverage.example';
  try {
    const run = createRun({ root, siteKey, runId: '20260913T000003Z_measure_33333333', kind: 'clone', target: { kind: 'clone' } });
    writeArtifact(root, siteKey, run.runId, 'coverage.json', { measurement: {} });
    assert.throws(() => closeRun(root, siteKey, run.runId), /invalid inventory provenance/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('self-referenced coverage requires a persisted inventory artifact', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloner-inventory-test-'));
  const siteKey = 'inventory.example';
  try {
    const run = createRun({ root, siteKey, runId: '20260913T000008Z_measure_88888888', kind: 'clone', target: { kind: 'clone' }, scope: { inventoryRunId: '20260913T000008Z_measure_88888888', authoritativeInventory: true } });
    writeArtifact(root, siteKey, run.runId, 'coverage.json', { inventory: { runId: run.runId, authoritative: true }, measurement: {}, scope: 'full' });
    assert.throws(() => closeRun(root, siteKey, run.runId), /invalid inventory provenance/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('open-run artifacts are append-only and completed route evidence survives later failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloner-failed-evidence-test-'));
  const siteKey = 'failed-evidence.example';
  const runId = '20260913T000013Z_clone_dddddddd';
  try {
    createRun({ root, siteKey, runId, kind: 'clone', target: { kind: 'clone' }, scope: { inventoryRunId: null, authoritativeInventory: false, routesRequested: ['/ok', '/broken'], routesCompleted: [], routesFailed: [] } });
    writeArtifact(root, siteKey, runId, 'measurements/routes/0001-ok.json', { route: '/ok', status: 200 });
    assert.throws(() => writeArtifact(root, siteKey, runId, 'measurements/routes/0001-ok.json', { route: '/ok', status: 201 }), /append-only/);
    updateRun(root, siteKey, runId, { scope: { inventoryRunId: null, authoritativeInventory: false, routesRequested: ['/ok', '/broken'], routesCompleted: ['/ok'], routesFailed: ['/broken'] } });
    writeArtifact(root, siteKey, runId, 'measurements/failures/0002-broken.json', { route: '/broken', message: 'boom' });
    failRun(root, siteKey, runId, new Error('boom'));
    const manifest = readManifest(root, siteKey, runId);
    assert.equal(manifest.status, 'failed');
    assert.deepEqual(manifest.scope.routesCompleted, ['/ok']);
    assert.deepEqual(manifest.scope.routesFailed, ['/broken']);
    assert.equal(JSON.parse(readArtifact(root, siteKey, runId, 'measurements/routes/0001-ok.json')).status, 200);
    assert.equal(JSON.parse(readArtifact(root, siteKey, runId, 'measurements/failures/0002-broken.json')).route, '/broken');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ledger remains append-only and reconstructs finding status from events', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloner-ledger-test-'));
  const siteKey = 'ledger.example';
  const runId = '20260913T000004Z_measure_44444444';
  try {
    appendLedgerEvent(root, siteKey, { type: 'finding.opened', findingId: 'F-1', runId, finding: { category: 'dead-control', evidence: { clone: { runId, artifact: 'audits/dead-controls.json', locator: '#/findings/0' } } } });
    appendLedgerEvent(root, siteKey, { type: 'finding.verified', findingId: 'F-1', runId, finding: { category: 'dead-control', evidence: { clone: { runId, artifact: 'audits/dead-controls.json', locator: '#/findings/1' } } } });
    const lines = readFileSync(join(root, 'docs/research/ledger.example/_parity/ledger.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const summary = summarizeFindings(readLedger(root, siteKey))[0];
    assert.equal(summary.status, 'verified');
    assert.equal(summary.finding.evidence.clone.locator, '#/findings/1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manual finding status requires existing finding and closed evidence run', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloner-ledger-status-test-'));
  const siteKey = 'ledger-status.example';
  const runId = '20260914T000004Z_measure_44444444';
  try {
    createRun({ root, siteKey, runId });
    writeArtifact(root, siteKey, runId, 'coverage.json', { scope: 'comparison' });
    closeRun(root, siteKey, runId);
    appendLedgerEvent(root, siteKey, { type: 'finding.opened', findingId: 'F-existing', runId, finding: { category: 'dead-control' } });
    assert.throws(() => recordFindingStatus(root, siteKey, 'F-missing', 'closed', runId), /Finding does not exist/);
    assert.throws(() => recordFindingStatus(root, siteKey, 'F-existing', 'closed', '20260914T000005Z_measure_55555555'), /Run manifest not found/);
    assert.equal(recordFindingStatus(root, siteKey, 'F-existing', 'closed', runId).type, 'finding.closed');
    assert.throws(() => recordFindingStatus(root, siteKey, 'F-existing', 'verified', runId), /already closed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stable finding IDs distinguish flat dead-control subjects', () => {
  const first = stableFindingId({ category: 'dead-control', route: '/home', role: 'button', name: 'New chat' });
  const second = stableFindingId({ category: 'dead-control', route: '/billing', role: 'button', name: 'Manage billing info' });
  assert.notEqual(first, second);
  assert.notEqual(
    stableFindingId({ category: 'dead-control', subject: { route: '/home', role: 'button', name: 'Duplicate', occurrence: 0 } }),
    stableFindingId({ category: 'dead-control', subject: { route: '/home', role: 'button', name: 'Duplicate', occurrence: 1 } }),
  );
});

test('clone-health finding IDs preserve stable identity across inventory revisions', () => {
  const base = {
    domain: 'clone-health',
    siteKey: 'example.test-01234567',
    category: 'dead-control',
    subject: { route: '/home', role: 'button', name: 'Save', controlClass: 'default', occurrence: 0 },
    targetContext: { kind: 'clone', tenant: 'tenant-a', role: 'admin', profileId: 'clone-profile' },
    audit: {
      name: 'dead-controls',
      evidenceClass: 'dead-control',
      parentRunId: '20260913T000030Z_clone_30303030',
      inventoryRunId: '20260913T000030Z_clone_30303030',
      provenanceRunId: '20260913T000030Z_clone_30303030',
    },
  };
  assert.notEqual(
    stableFindingId({ ...base, target: 'source' }),
    stableFindingId({ ...base, target: 'clone' }),
  );
  assert.notEqual(
    stableFindingId({ ...base, target: 'clone' }),
    stableFindingId({ ...base, domain: 'parity', target: 'clone' }),
  );
  assert.equal(
    stableFindingId({ ...base, target: 'clone' }),
    stableFindingId({
      ...base,
      target: 'clone',
      audit: {
        ...base.audit,
        parentRunId: '20260913T000031Z_clone_31313131',
        inventoryRunId: '20260913T000031Z_clone_31313131',
        provenanceRunId: '20260913T000031Z_clone_31313131',
      },
    }),
  );
  assert.notEqual(
    stableFindingId({ ...base, targetContext: { ...base.targetContext, tenant: 'tenant-b' } }),
    stableFindingId(base),
  );
  assert.notEqual(
    stableFindingId({ ...base, audit: { ...base.audit, evidenceClass: 'dead-runtime-class' } }),
    stableFindingId(base),
  );
});

test('parity finding IDs preserve authenticated comparison context', () => {
  const base = {
    domain: 'parity',
    target: 'comparison',
    category: 'control-aria-mismatch',
    subject: { route: '/home', role: 'button', name: 'Save', controlClass: 'default', occurrence: 0 },
    comparison: {
      sourceKind: 'source',
      cloneKind: 'clone',
      sourceContext: { kind: 'source', origin: 'https://app.test', tenant: 'tenant-a', role: 'admin', profileId: 'source-admin' },
      cloneContext: { kind: 'clone', origin: 'https://clone.test', tenant: 'tenant-a', role: 'admin', profileId: 'clone-admin' },
    },
  };
  assert.notEqual(
    stableFindingId(base),
    stableFindingId({ ...base, comparison: { ...base.comparison, sourceContext: { ...base.comparison.sourceContext, role: 'viewer' } } }),
  );
});

test('clone-health re-audit closes stale findings only with compatible coverage', () => {
  const subject = { route: '/home', role: 'button', name: 'Save', controlClass: 'default', occurrence: 0 };
  const previous = {
    finding: {
      domain: 'clone-health',
      target: 'clone',
      siteKey: 'example.test-01234567',
      category: 'dead-control',
      subject,
      targetContext: { kind: 'clone', tenant: 'tenant-a', role: 'admin', profileId: 'clone-profile' },
      audit: {
        name: 'dead-controls',
        evidenceClass: 'dead-control',
        targetContext: { kind: 'clone', tenant: 'tenant-a', role: 'admin', profileId: 'clone-profile' },
        parentRunId: '20260913T000030Z_clone_30303030',
        inventoryRunId: '20260913T000030Z_clone_30303030',
        provenanceRunId: '20260913T000030Z_clone_30303030',
      },
    },
  };
  const current = {
    auditName: 'dead-controls',
    target: 'clone',
    siteKey: 'example.test-01234567',
    targetContext: { kind: 'clone', tenant: 'tenant-a', role: 'admin', profileId: 'clone-profile' },
    evidenceClass: 'dead-control',
    parentRunId: '20260913T000032Z_clone_32323232',
    inventoryRunId: '20260913T000032Z_clone_32323232',
    coveredRoutes: ['/home'],
    routes: [{
      route: '/home',
      controlCount: 1,
      classifiedCount: 1,
      observations: [{ ...subject, category: 'DOM change', actionExecuted: true }],
    }],
    findings: [],
  };
  assert.equal(auditFindingCanClose(previous, current), true);
  assert.equal(auditFindingCanClose(previous, { ...current, inventoryRunId: '20260913T000033Z_clone_33333333', parentRunId: '20260913T000033Z_clone_33333333' }), true);
  assert.equal(auditFindingCanClose(previous, {
    ...current,
    routes: [{ route: '/home', controlCount: 1, classifiedCount: 1, observations: [{ ...subject, category: 'blocked-by-policy', actionExecuted: false }] }],
  }), false);
  assert.equal(auditFindingCanClose(previous, {
    ...current,
    routes: [{ route: '/home', controlCount: 1, classifiedCount: 1, observations: [{ ...subject, category: 'trial-invalid', actionExecuted: false }] }],
  }), false);
  assert.equal(auditFindingCanClose(previous, {
    ...current,
    routes: [{ route: '/home', controlCount: 0, classifiedCount: 0, observations: [] }],
  }), true);
  assert.equal(auditFindingCanClose(previous, {
    ...current,
    coveredRoutes: [],
    routes: [{ route: '/home', controlCount: 0, classifiedCount: 0, observations: [] }],
  }), false);
  assert.equal(auditFindingCanClose(previous, {
    ...current,
    routes: [{ route: '/home', controlCount: 1, classifiedCount: 0, observations: [] }],
  }), false);
  assert.equal(auditFindingCanClose(previous, { ...current, routesFailed: ['/home'] }), false);
  assert.equal(auditFindingCanClose(previous, { ...current, findings: [{ category: 'dead-control', subject }] }), false);
});

test('ambient whole-page mutations do not make a dead control active', () => {
  const signature = ({ dom, aria = 'same-aria', localDom, localAria = 'same-local-aria' }) => ({
    url: 'https://example.test/noise',
    domFingerprint: dom,
    ariaFingerprint: aria,
    styleFingerprint: 'same-style',
    structureFingerprint: 'same-structure',
    overlayCount: 0,
    network: { count: 0, requests: [] },
    local: {
      control: {
        domFingerprint: 'same-control-dom',
        ariaFingerprint: localAria,
        styleFingerprint: 'same-control-style',
        structureFingerprint: 'same-control-structure',
      },
      region: {
        domFingerprint: localDom,
        ariaFingerprint: 'same-region-aria',
        styleFingerprint: 'same-region-style',
        structureFingerprint: 'same-region-structure',
      },
    },
  });
  const ambientBefore = signature({ dom: 'page-0', localDom: 'region-0' });
  const ambientAfter = signature({ dom: 'page-1', localDom: 'region-1' });
  const before = signature({ dom: 'page-1', localDom: 'region-1' });
  const after = signature({ dom: 'page-2', localDom: 'region-2' });
  const effect = compareEffectSignatures(before, after, { ambientBefore, ambientAfter });
  assert.equal(effect.domChanged, false);
  assert.equal(classifyControl({ after: effect }), 'dead');

  const activeAfter = signature({ dom: 'page-2', localDom: 'region-2', localAria: 'pressed' });
  const activeEffect = compareEffectSignatures(before, activeAfter, { ambientBefore, ambientAfter });
  assert.equal(activeEffect.ariaChanged, true);
  assert.equal(classifyControl({ after: activeEffect }), 'state change');
});

test('fixture freeze preserves an immutable run as named golden evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloner-fixture-test-'));
  const siteKey = 'fixture.example';
  try {
    const run = createAuthoritativeInventory(root, siteKey, '20260913T000009Z_fixture_99999999', []);
    const frozen = freezeFixture(root, siteKey, run.runId, 'known-good');
    assert.equal(frozen.sourceRunId, run.runId);
    assert.equal(frozen.visibility, 'private');
    assert.equal(JSON.parse(readFileSync(join(root, '.cloner-runtime/fixtures/known-good/manifest.json'), 'utf8')).status, 'closed');
    assert.throws(() => freezeFixture(root, siteKey, run.runId, 'known-good'), /already exists/);
    const promoted = freezeFixture(root, siteKey, run.runId, 'known-good-public', { publicFixture: true });
    assert.equal(promoted.visibility, 'public');
    assert.equal(JSON.parse(readFileSync(join(root, 'tools/cloner/fixtures/known-good-public/manifest.json'), 'utf8')).status, 'closed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fixture servers expose deterministic browser harness markers for each mode', async () => {
  const fixtures = [];
  const readRoute = async (fixture, route) => {
    const response = await fetch(`${fixture.url}${route}`);
    assert.equal(response.status, 200, `${fixture.mode} ${route} should be available`);
    return response.text();
  };
  try {
    const source = await startFixtureServer({ mode: 'source' });
    fixtures.push(source);
    const initialClone = await startFixtureServer({ mode: 'clone' });
    fixtures.push(initialClone);
    const repairedClone = await startFixtureServer({ mode: 'clone', repaired: true });
    fixtures.push(repairedClone);

    assert.equal(source.mode, 'source');
    assert.equal(source.repaired, false);
    assert.equal(initialClone.mode, 'clone');
    assert.equal(initialClone.repaired, false);
    assert.equal(repairedClone.mode, 'clone');
    assert.equal(repairedClone.repaired, true);

    const sourceHome = await readRoute(source, '/home');
    const initialCloneHome = await readRoute(initialClone, '/home');
    const repairedCloneHome = await readRoute(repairedClone, '/home');
    const countMoreControls = (html) => (html.match(/<button\b[^>]*data-action="more"/gu) ?? []).length;
    assert.equal(countMoreControls(sourceHome), 2);
    assert.equal(countMoreControls(initialCloneHome), 1);
    assert.equal(countMoreControls(repairedCloneHome), 2);
    assert.match(initialCloneHome, /clone-only-runtime/);
    assert.doesNotMatch(repairedCloneHome, /clone-only-runtime/);

    const brokenHydration = await readRoute(initialClone, '/broken-hydration');
    assert.match(brokenHydration, /<html data-hydrated="false">/u);
    assert.match(brokenHydration, /data-hydration-error="true"/u);

    const unverifiedHydration = await readRoute(initialClone, '/unverified-hydration');
    assert.match(unverifiedHydration, /<html>/u);
    assert.match(unverifiedHydration, /__next_f\.push/u);
    assert.doesNotMatch(unverifiedHydration, /data-hydrated=/u);
    assert.doesNotMatch(unverifiedHydration, /data-hydration-error=/u);

    const incompleteCss = await readRoute(initialClone, '/incomplete-css');
    assert.match(incompleteCss, /<h1>Incomplete CSS<\/h1>/u);
    assert.match(incompleteCss, new RegExp(`href="http://localhost:${initialClone.port}/fixture-incomplete\\.css"`, 'u'));
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close().catch(() => {})));
  }
});

test('control diff preserves duplicate occurrences instead of collapsing them', () => {
  const report = compareMeasurementData({
    sourceRunId: '20260913T000014Z_source_eeeeeeee',
    cloneRunId: '20260913T000015Z_clone_ffffffff',
    sourceRoutes: { routes: [{ route: '/home', status: 200 }] },
    cloneRoutes: { routes: [{ route: '/home', status: 200 }] },
    sourceControls: { observations: [
      { route: '/home', index: 0, role: 'button', name: 'Duplicate', href: null, visible: true },
      { route: '/home', index: 1, role: 'button', name: 'Duplicate', href: null, visible: true },
    ] },
    cloneControls: { observations: [
      { route: '/home', index: 0, role: 'button', name: 'Duplicate', href: null, visible: true },
    ] },
    sourceClasses: { routes: [] },
    cloneClasses: { routes: [] },
  });
  const missing = report.findings.find((finding) => finding.category === 'missing-control');
  assert.equal(missing.subject.occurrence, 1);
  assert.equal(missing.evidence.source.locator, '#/observations/1');
});

test('control presence coverage remains available after a missing duplicate is repaired', () => {
  const report = compareMeasurementData({
    sourceRunId: '20260913T000028Z_source_28282828',
    cloneRunId: '20260913T000029Z_clone_29292929',
    sourceRoutes: { routes: [{ route: '/home', status: 200 }] },
    cloneRoutes: { routes: [{ route: '/home', status: 200 }] },
    sourceControls: { observations: [{ route: '/home', index: 0, role: 'button', name: 'More', controlClass: 'menu', occurrence: 0 }] },
    cloneControls: { observations: [{ route: '/home', index: 0, role: 'button', name: 'More', controlClass: 'menu', occurrence: 0 }] },
    sourceClasses: { routes: [] },
    cloneClasses: { routes: [] },
  });
  assert.equal(report.comparatorCoverage.some((entry) => entry.comparator.evidenceClass === 'control-presence'), true);
});

test('route diff gates unexpected final destinations', () => {
  const report = compareMeasurementData({
    sourceRunId: '20260913T000030Z_source_30303030',
    cloneRunId: '20260913T000031Z_clone_31313131',
    sourceRoutes: { routes: [{ route: '/home', finalUrl: 'https://source.test/home', status: 200 }] },
    cloneRoutes: { routes: [{ route: '/home', finalUrl: 'https://clone.test/other', status: 200 }] },
    sourceControls: { observations: [] },
    cloneControls: { observations: [] },
    sourceClasses: { routes: [] },
    cloneClasses: { routes: [] },
  });
  const finding = report.findings.find((entry) => entry.category === 'route-destination-mismatch');
  assert.equal(finding.status, 'open');
  assert.deepEqual(finding.observed, { source: '/home', clone: '/other' });
  assert.equal(finding.evidence.clone.locator, '#/routes/0/finalUrl');
});

test('control diff uses richer audit effects under policy and cites the audit runs', () => {
  const sourceAuditRunId = '20260913T000016Z_audit-controls_12121212';
  const cloneAuditRunId = '20260913T000017Z_audit-controls_34343434';
  const report = compareMeasurementData({
    sourceRunId: '20260913T000018Z_source_56565656',
    cloneRunId: '20260913T000019Z_clone_78787878',
    sourceRoutes: { routes: [{ route: '/home', status: 200 }] },
    cloneRoutes: { routes: [{ route: '/home', status: 200 }] },
    sourceControls: { observations: [{ route: '/home', index: 0, role: 'button', name: 'Open', href: null, visible: true, controlClass: 'menu', structure: { tag: 'button', childElementCount: 1 } }] },
    cloneControls: { observations: [{ route: '/home', index: 0, role: 'button', name: 'Open', href: null, visible: true, controlClass: 'menu', structure: { tag: 'button', childElementCount: 1 } }] },
    sourceClasses: { routes: [] },
    cloneClasses: { routes: [] },
    sourceControlAudit: { runId: sourceAuditRunId, routes: [{ route: '/home', observations: [{ route: '/home', index: 0, role: 'button', name: 'Open', controlClass: 'menu', occurrence: 0, actionExecuted: true, effect: { overlayOpened: true, domChanged: true }, evidence: { after: { url: 'https://source.test/home', overlays: [{ role: 'menu', name: 'Actions' }], domFingerprint: 'source-dom', network: { count: 2, requests: [{ url: 'https://source.test/api', method: 'GET', resourceType: 'fetch' }] } }, controlAfter: { ariaState: { expanded: 'true' }, className: 'open', dataState: 'open' } } }] }] },
    cloneControlAudit: { runId: cloneAuditRunId, routes: [{ route: '/home', observations: [{ route: '/home', index: 0, role: 'button', name: 'Open', controlClass: 'menu', occurrence: 0, actionExecuted: true, effect: { overlayOpened: false, domChanged: true }, evidence: { after: { url: 'https://clone.test/home', overlays: [], domFingerprint: 'clone-dom', network: { count: 0, requests: [] } }, controlAfter: { ariaState: { expanded: 'true' }, className: 'open', dataState: 'open' } } }] }] },
    policy: { controlClasses: { menu: { dimensions: { url: 'ignore', aria: 'gate', structure: 'gate', overlay: 'gate', dom: 'informational', style: 'informational', network: 'ignore' } } } },
  });
  const overlay = report.findings.find((finding) => finding.category === 'control-overlay-mismatch');
  const dom = report.findings.find((finding) => finding.category === 'control-dom-mismatch');
  assert.equal(overlay.status, 'open');
  assert.equal(overlay.evidence.source.runId, sourceAuditRunId);
  assert.equal(overlay.evidence.clone.runId, cloneAuditRunId);
  assert.equal(dom.status, 'informational');
  assert.equal(report.findings.some((finding) => finding.category === 'control-network-mismatch'), false);
  assert.equal(report.comparatorCoverage.some((entry) => entry.comparator.instrument === 'dead-controls' && entry.comparator.dimension === 'overlay'), true);
});

test('control-effect finding cannot close after only static measurement', () => {
  const base = {
    sourceRunId: '20260913T000020Z_source_20202020',
    cloneRunId: '20260913T000021Z_clone_21212121',
    sourceRoutes: { routes: [{ route: '/home', status: 200 }] },
    cloneRoutes: { routes: [{ route: '/home', status: 200 }] },
    sourceControls: { observations: [{ route: '/home', index: 0, role: 'button', name: 'Open', href: null, visible: true, controlClass: 'menu', structure: { tag: 'button' } }] },
    cloneControls: { observations: [{ route: '/home', index: 0, role: 'button', name: 'Open', href: null, visible: true, controlClass: 'menu', structure: { tag: 'button' } }] },
    sourceClasses: { routes: [] },
    cloneClasses: { routes: [] },
    policy: { controlClasses: { menu: { dimensions: { overlay: 'gate' } } } },
  };
  const withScope = (report) => ({
    ...report,
    source: { target: { kind: 'source' }, scope: { routesCompleted: ['/home'] } },
    clone: { target: { kind: 'clone' }, scope: { routesCompleted: ['/home'] } },
    coverage: {
      sourceDetails: { scope: 'full', inventory: { runId: '20260913T000020Z_source_20202020' } },
      cloneDetails: { scope: 'full', inventory: { runId: '20260913T000021Z_clone_21212121' } },
    },
  });
  const previous = {
    finding: {
      category: 'control-overlay-mismatch',
      subject: { route: '/home', role: 'button', name: 'Open', controlClass: 'menu', occurrence: 0 },
      policy: { controlClass: 'menu', dimension: 'overlay', mode: 'gate' },
      evidence: {
        source: { runId: '20260913T000016Z_audit-controls_12121212', artifact: 'audits/dead-controls.json', locator: '#/routes/0/observations/0' },
        clone: { runId: '20260913T000017Z_audit-controls_34343434', artifact: 'audits/dead-controls.json', locator: '#/routes/0/observations/0' },
      },
      comparisonScope: {
        source: { targetKind: 'source', inventoryBacked: true },
        clone: { targetKind: 'clone', inventoryBacked: true },
      },
    },
  };
  const staticReport = withScope(compareMeasurementData(base));
  assert.equal(staticReport.comparatorCoverage.some((entry) => entry.comparator.instrument === 'static-control' && entry.comparator.dimension === 'overlay'), true);
  assert.equal(findingCanClose(previous, staticReport), false);

  const actionReport = withScope(compareMeasurementData({
    ...base,
    sourceControlAudit: { runId: '20260913T000022Z_audit-controls_22222222', routes: [{ route: '/home', observations: [{ route: '/home', index: 0, role: 'button', name: 'Open', controlClass: 'menu', occurrence: 0, actionExecuted: true, evidence: { after: { overlays: [] }, controlAfter: {} } }] }] },
    cloneControlAudit: { runId: '20260913T000023Z_audit-controls_23232323', routes: [{ route: '/home', observations: [{ route: '/home', index: 0, role: 'button', name: 'Open', controlClass: 'menu', occurrence: 0, actionExecuted: true, evidence: { after: { overlays: [] }, controlAfter: {} } }] }] },
  }));
  assert.equal(actionReport.comparatorCoverage.some((entry) => entry.comparator.instrument === 'dead-controls' && entry.comparator.dimension === 'overlay'), true);
  assert.equal(findingCanClose(previous, actionReport), true);
});

test('control audit auto-selection requires matching policy and complete route coverage', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloner-audit-selection-test-'));
  const siteKey = 'audit-selection.example';
  const measurementRunId = '20260913T000024Z_clone_24242424';
  const policy = { actions: [{ match: { route: '*' }, clone: 'measure' }] };
  const makeAudit = (runId, routes, auditPolicy = policy) => {
    createRun({
      root,
      siteKey,
      runId,
      kind: 'audit',
      target: { kind: 'clone' },
      scope: { parentRunId: measurementRunId, inventoryRunId: measurementRunId, routesRequested: routes, routesCompleted: routes, routesFailed: [] },
      policySha256: policySha256(auditPolicy),
    });
    writeArtifact(root, siteKey, runId, 'audits/dead-controls.json', { schemaVersion: 1, routes: routes.map((route) => ({ route, controlCount: 1, classifiedCount: 1, observations: [] })) }, { kind: 'dead-control-audit' });
    writeArtifact(root, siteKey, runId, 'coverage.json', { measurement: { routesRequested: routes.length, routesCompleted: routes.length }, scope: routes.length === 2 ? 'full' : 'subset' }, { kind: 'coverage' });
    closeRun(root, siteKey, runId);
  };
  try {
    createAuthoritativeInventory(root, siteKey, measurementRunId, ['/home', '/billing']);
    makeAudit('20260913T000025Z_audit-controls_25252525', ['/home', '/billing']);
    makeAudit('20260913T000026Z_audit-controls_26262626', ['/home']);
    makeAudit('20260913T000027Z_audit-controls_27272727', ['/home', '/billing'], { actions: [{ match: { route: '*' }, clone: 'block' }] });

    const automatic = selectControlAudit({ root, siteKey, measurementRunId, policy });
    assert.equal(automatic.selection.runId, '20260913T000025Z_audit-controls_25252525');
    assert.equal(automatic.selection.mode, 'auto');
    assert.deepEqual(automatic.selection.coveredRoutes, ['/home', '/billing']);

    const explicit = selectControlAudit({ root, siteKey, measurementRunId, auditRunId: '20260913T000026Z_audit-controls_26262626', policy });
    assert.equal(explicit.selection.mode, 'explicit');
    assert.deepEqual(explicit.selection.coveredRoutes, ['/home']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('diff reports gate mismatches while ignoring network and retaining evidence run IDs', () => {
  const report = compareMeasurementData({
    sourceRunId: '20260913T000005Z_source_55555555',
    cloneRunId: '20260913T000006Z_clone_66666666',
    sourceRoutes: { routes: [{ route: '/home', status: 200 }] },
    cloneRoutes: { routes: [{ route: '/home', status: 200 }] },
    sourceControls: { observations: [{ route: '/home', role: 'button', name: 'Toggle', state: 'on', href: null, visible: true, controlClass: 'local-toggle' }] },
    cloneControls: { observations: [{ route: '/home', role: 'button', name: 'Toggle', state: 'off', href: null, visible: true, controlClass: 'local-toggle' }] },
    sourceClasses: { routes: [] },
    cloneClasses: { routes: [] },
    policy: { controlClasses: { 'local-toggle': { dimensions: { aria: 'gate', structure: 'gate', network: 'ignore' } } } },
  });
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].category, 'control-aria-mismatch');
  assert.equal(report.findings[0].evidence.source.runId, '20260913T000005Z_source_55555555');
  assert.match(report.semantics.parity, /source-vs-clone mismatches/u);
  assert.match(report.semantics.cloneHealth, /clone implementation-quality observations/u);
  assert.match(report.semantics.milestone, /do not automatically block/u);
});

test('class diff evidence locators address the persisted audit payload', () => {
  const report = compareMeasurementData({
    sourceRunId: '20260913T000010Z_source_aaaaaaaa',
    cloneRunId: '20260913T000011Z_clone_bbbbbbbb',
    sourceRoutes: { routes: [{ route: '/home', status: 200 }] },
    cloneRoutes: { routes: [{ route: '/home', status: 200 }] },
    sourceControls: { observations: [] },
    cloneControls: { observations: [] },
    sourceClasses: { routes: [{ route: '/home', deadClasses: [] }] },
    cloneClasses: { routes: [{ route: '/home', deadClasses: ['missing-class'] }] },
  });
  assert.equal(report.findings[0].evidence.clone.locator, '#/audit/routes/0/deadClasses/0');
});
