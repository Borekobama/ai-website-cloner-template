import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeRun,
  createRun,
  readArtifact,
  setRef,
  writeArtifact,
} from './run-store.mjs';
import { auditDeadRuntimeClasses } from './audits/dead-classes.mjs';
import { classifyControl } from './audits/dead-controls.mjs';
import { evaluateAction, policySha256 } from './policy.mjs';
import { containsSensitiveMaterial, redactForPersistence } from './redact.mjs';
import { compareVisualRegionImages, normalizeVisualRegionConfig } from './visual-regions.mjs';
import { compareMotionObservations } from './motion.mjs';
import { captureDomSnapshot, compareDomSnapshotStructure, domSnapshotCoverage } from './dom-snapshot.mjs';
import { compareResponsiveEvidence, generateExactPixelProbes, normalizeCssCondition, parseResponsiveCondition, responsiveThresholds } from './responsive.mjs';
import { compareAssetEvidence } from './assets.mjs';
import { PNG } from 'pngjs';
import { canonicalJson, sha256 } from './run-store.mjs';

let running;

export async function runSelfTests() {
  if (running) return running;
  running = Promise.resolve().then(async () => {
    assert.equal(redactForPersistence({ Authorization: 'Bearer secret', nested: 'https://example.test/x?access_token=secret' }).Authorization, '[REDACTED]');
    assert.equal(containsSensitiveMaterial(redactForPersistence({ Cookie: 'session=secret' })), false);
    assert.equal(containsSensitiveMaterial(redactForPersistence({ url: 'https://stripe.test/checkout/session?client_secret=secret' })), false);

    const blocked = evaluateAction({ target: 'source', policy: {
      version: 1,
      actions: [{ id: 'billing-portal', match: { route: '/billing', role: 'button', name: 'Change payment methods' }, source: 'block', clone: 'measure', reason: 'External billing portal' }],
    }, action: { route: '/billing', role: 'button', name: 'Change payment methods' } });
    assert.equal(blocked.outcome, 'blocked-by-policy');
    assert.equal(classifyControl({ policyOutcome: blocked.outcome }), 'blocked-by-policy');

    const classAudit = auditDeadRuntimeClasses([
      { route: '/one', runtimeClasses: ['shared', 'missing-one'], compiledClasses: ['shared'] },
      { route: '/two', runtimeClasses: ['shared', 'missing-two'], compiledClasses: ['shared', 'missing-one'] },
    ]);
    assert.deepEqual(classAudit.routes[0].deadClasses, ['missing-one']);
    assert.deepEqual(classAudit.routes[1].deadClasses, ['missing-two']);
    assert.ok(classAudit.deadClasses.includes('missing-two'));

    const root = mkdtempSync(join(tmpdir(), 'cloner-selftest-'));
    try {
      const siteKey = 'selftest.test';
      const run = createRun({ root, siteKey, runId: '20260913T000000Z_selftest_a1b2c3d4', target: { kind: 'source' }, scope: { inventoryRunId: '20260913T000000Z_selftest_a1b2c3d4', authoritativeInventory: true } });
      writeArtifact(root, siteKey, run.runId, 'inventory.json', { runId: run.runId, authoritative: true, routes: [] });
      writeArtifact(root, siteKey, run.runId, 'coverage.json', { inventory: { runId: run.runId, authoritative: true }, measurement: { routesRequested: 0 }, scope: 'full' });
      closeRun(root, siteKey, run.runId);
      assert.throws(() => writeArtifact(root, siteKey, run.runId, 'measurements/after.json', { changed: true }), /immutable/);
      assert.equal(JSON.parse(readArtifact(root, siteKey, run.runId, 'coverage.json')).inventory.runId, run.runId);
      assert.equal(setRef(root, siteKey, 'source-current', run.runId), run.runId);
    assert.equal(policySha256({ version: 1 }), policySha256({ version: 1 }));
    const visualConfig = normalizeVisualRegionConfig({ regions: [{ route: '/home', viewport: { width: 2, height: 2 }, id: 'sidebar', selector: '#sidebar' }] });
    assert.equal(visualConfig.regions[0].mode, 'gate');
    const image = new PNG({ width: 1, height: 1 });
    image.data[3] = 255;
    assert.equal(compareVisualRegionImages(PNG.sync.write(image), PNG.sync.write(image)).equal, true);
    assert.equal(normalizeCssCondition('screen and ( min-width : 768px )'), 'screen and (min-width:768px)');
    const responsiveCondition = parseResponsiveCondition('(min-width:768px) and (orientation:landscape)');
    assert.deepEqual(responsiveCondition.orientation, ['landscape']);
    assert.deepEqual(generateExactPixelProbes(responsiveThresholds([{ kind: 'media', condition: responsiveCondition.condition, features: responsiveCondition }])).map((probe) => probe.requestedViewport.width), [767, 768, 769]);
    const responsiveComparison = compareResponsiveEvidence(
      { complete: true, routes: [{ route: '/home', artifactPath: 'measurements/responsive/source.json', observation: { route: '/home', complete: true, discoveryComplete: true, conditions: { media: [{ condition: '(min-width:768px)' }], container: [] }, probes: [] } }] },
      { complete: true, routes: [{ route: '/home', artifactPath: 'measurements/responsive/clone.json', observation: { route: '/home', complete: true, discoveryComplete: true, conditions: { media: [{ condition: '(min-width:800px)' }], container: [] }, probes: [] } }] },
      '20260913T000003Z_source_c1c2c3c4',
      '20260913T000004Z_clone_d1d2d3d4',
    );
    assert.ok(responsiveComparison.findings.some((finding) => finding.category === 'responsive-media-condition-mismatch'));
    const assetComparison = compareAssetEvidence(
      { complete: true, routes: [{ route: '/home', artifactPath: 'measurements/assets/source.json', observation: { route: '/home', complete: true, assets: [{ mime: 'image/png', sha256: 'source' }], responseCoverage: { observed: 1, hashed: 1, bodyFailures: 0 } } }] },
      { complete: true, routes: [{ route: '/home', artifactPath: 'measurements/assets/clone.json', observation: { route: '/home', complete: true, assets: [{ mime: 'image/png', sha256: 'clone' }], responseCoverage: { observed: 1, hashed: 1, bodyFailures: 0 } } }] },
      '20260913T000005Z_source_e1e2e3e4',
      '20260913T000006Z_clone_f1f2f3f4',
    );
    assert.ok(assetComparison.findings.some((finding) => finding.category === 'asset-content-mismatch'));
    const motion = compareMotionObservations(
      { routes: [{ route: '/home', observations: [{ key: '/home|button:nth-child(1)|0', identity: { path: 'main>button:nth-child(1)', role: 'button', name: 'Toggle', occurrence: 0 }, declared: { transitionProperty: 'transform' }, state: { 'data-state': 'closed' }, rendered: { transform: 'matrix(1, 0, 0, 1, 0, 0)' } }] }] },
      { routes: [{ route: '/home', observations: [{ key: '/home|button:nth-child(1)|0', identity: { path: 'main>button:nth-child(1)', role: 'button', name: 'Toggle', occurrence: 0 }, declared: { transitionProperty: 'opacity' }, state: { 'data-state': 'closed' }, rendered: { transform: 'matrix(1, 0, 0, 1, 0, 0)' } }] }] },
      '20260913T000001Z_source_a1b2c3d4',
      '20260913T000002Z_clone_b1c2d3e4',
    );
    assert.ok(motion.findings.some((finding) => finding.category === 'motion-declared-mismatch'));
    let snapshotCommand;
    const domSnapshot = await captureDomSnapshot({
      url: () => 'https://fixture.test/home?token=secret',
      context: () => ({
        newCDPSession: async () => ({
          send: async (method, params) => {
            snapshotCommand = { method, params };
            return {
              strings: [
                'INPUT', 'password', 'opaque-value', 'type',
                'value', 'visible-secret', '/next?auth=opaque-auth&token=opaque-token&key=opaque-key',
               'https://fixture.test/next?auth=opaque-auth&token=opaque-token&key=opaque-key',
                'next?auth=bare-auth&key=bare-key', '?auth=query-auth&key=query-key', '#auth=hash-auth&key=hash-key',
              ],
              documents: [{
                nodes: {
                  nodeName: [0, 0],
                  inputValue: { index: [0, 1], value: [2, 5] },
                  attributes: [[3, 1, 4, 5, 6, 7], [3, 1, 4, 5, 6, 7]],
                },
                layout: { nodeIndex: [0, 1] },
              }],
            };
          },
          detach: async () => {},
        }),
      }),
    }, { route: '/home' });
    assert.equal(snapshotCommand.method, 'DOMSnapshot.captureSnapshot');
    assert.equal(snapshotCommand.params.includeDOMRects, true);
    assert.equal(domSnapshot.summary.nodes, 2);
    assert.equal(domSnapshot.structure.tagCounts.input, 2);
    assert.equal(domSnapshot.url, 'https://fixture.test/home?token=%5BREDACTED%5D');
    assert.deepEqual(domSnapshot.snapshot.documents[0].nodes.inputValue, { index: [0, 1], value: [2, 5] });
    assert.equal(domSnapshot.snapshot.strings[2], '[REDACTED]');
    assert.equal(domSnapshot.snapshot.strings[5], '[REDACTED]');
    assert.equal(domSnapshot.snapshot.strings[6], '/next?auth=%5BREDACTED%5D&token=%5BREDACTED%5D&key=%5BREDACTED%5D');
   assert.equal(domSnapshot.snapshot.strings[7], 'https://fixture.test/next?auth=%5BREDACTED%5D&token=%5BREDACTED%5D&key=%5BREDACTED%5D');
    assert.equal(domSnapshot.snapshot.strings[8], 'next?auth=%5BREDACTED%5D&key=%5BREDACTED%5D');
    assert.equal(domSnapshot.snapshot.strings[9], '?auth=%5BREDACTED%5D&key=%5BREDACTED%5D');
    assert.equal(domSnapshot.snapshot.strings[10], '#auth=%5BREDACTED%5D&key=%5BREDACTED%5D');
    assert.equal(domSnapshot.snapshot.strings.includes('opaque-value'), false);
    const { capturedAt, fingerprint, ...fingerprintInput } = domSnapshot;
    assert.ok(capturedAt);
    assert.equal(fingerprint, sha256(canonicalJson(fingerprintInput)));
    const incompleteDomCoverage = domSnapshotCoverage({ complete: true, routes: [{ route: '/home' }] }, ['/home', '/billing']);
    assert.equal(incompleteDomCoverage.complete, false);
    assert.deepEqual(incompleteDomCoverage.missingRoutes, ['/billing']);
    const structureComparison = compareDomSnapshotStructure(
      { routes: [{ route: '/home', structure: { elements: 2, maxDepth: 1, layoutNodes: 2, tagCounts: { button: 2 }, roleCounts: {}, componentCounts: {}, repeatedStructures: [], geometryByKind: [] } }] },
      { routes: [{ route: '/home', structure: { elements: 1, maxDepth: 1, layoutNodes: 1, tagCounts: { button: 1 }, roleCounts: {}, componentCounts: {}, repeatedStructures: [], geometryByKind: [] } }] },
      '20260913T000007Z_source_a7b7c7d7',
      '20260913T000008Z_clone_b8c8d8e8',
    );
    assert.ok(structureComparison.findings.some((finding) => finding.category === 'dom-structure-mismatch'));
    assert.equal(structureComparison.coverage.complete, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    return true;
  });
  return running;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runSelfTests();
  console.log('cloner self-test: ok');
}
