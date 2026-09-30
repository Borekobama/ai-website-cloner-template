import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deploymentFingerprint, driftStatus } from './fingerprint.mjs';
import { assertResumeCompatibility } from './measure.mjs';
import { ENGINE_VERSION } from './run-store.mjs';

const origin = 'https://example.test';

test('deployment fingerprints hash same-origin bundles and fall back to validators', () => {
  const requests = [
    { url: `${origin}/_next/static/chunks/main-abc123.js`, status: 200, resourceType: 'script' },
    { url: `${origin}/_next/static/css/app-def456.css`, status: 200, resourceType: 'stylesheet' },
    { url: 'https://analytics.example/collect.js?t=123', status: 200, resourceType: 'script' },
    { url: `${origin}/missing.js`, status: 404, resourceType: 'script' },
  ];
  const first = deploymentFingerprint({ requests, origin });
  const reordered = deploymentFingerprint({ requests: [...requests].reverse(), origin });
  assert.equal(first.basis, 'bundle-urls');
  assert.equal(first.fingerprint, reordered.fingerprint, 'order and third-party scripts must not matter');
  assert.deepEqual([first.scripts, first.stylesheets], [1, 1]);
  const deployed = deploymentFingerprint({ requests: [{ ...requests[0], url: `${origin}/_next/static/chunks/main-999999.js` }, requests[1]], origin });
  assert.notEqual(deployed.fingerprint, first.fingerprint);
  const validators = deploymentFingerprint({ response: { headers: () => ({ etag: 'W/"1"' }) }, requests: [], origin });
  assert.equal(validators.basis, 'document-validators');
  assert.equal(deploymentFingerprint({ requests: [], origin }).fingerprint, null);
  assert.equal(driftStatus(first, reordered), 'unchanged');
  assert.equal(driftStatus(first, deployed), 'changed');
  assert.equal(driftStatus(undefined, first), 'unknown');
});

test('source resume is allowed with a stable profile label and still refuses mismatches', () => {
  const manifest = {
    runId: '20260914T000009Z_source_99999999',
    status: 'failed',
    kind: 'source',
    engine: { version: ENGINE_VERSION },
    target: { kind: 'source', origin: `${origin}/`, profileId: 'primary', tenant: null, role: null, modules: { visual: false }, hydrationSelector: null },
    policySha256: null,
    repository: { commit: 'abc', dirty: false, diffSha256: null },
  };
  const compatible = {
    target: 'source', origin, profileId: 'primary', tenant: null, role: null, policyHash: null, modules: manifest.target.modules,
    viewport: null, deviceScaleFactor: null, visualConfigSha256: null, hydrationSelector: null, repository: manifest.repository,
  };
  assert.doesNotThrow(() => assertResumeCompatibility(manifest, compatible));
  const unlabeled = { ...manifest, target: { ...manifest.target, profileId: null } };
  assert.throws(() => assertResumeCompatibility(unlabeled, { ...compatible, profileId: null }), /Source resume requires --profile-id/);
  assert.throws(() => assertResumeCompatibility(manifest, { ...compatible, profileId: 'other' }), /profile does not match/);
});
