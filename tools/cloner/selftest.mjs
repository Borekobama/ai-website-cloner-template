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
import { PNG } from 'pngjs';

let running;

export async function runSelfTests() {
  if (running) return running;
  running = Promise.resolve().then(() => {
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
