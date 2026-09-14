import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareAssetEvidence } from './assets.mjs';

function bundle(artifactPath, hash, complete = true) {
  return {
    complete,
    routes: [{
      route: '/home',
      artifactPath,
      observation: {
        route: '/home',
        complete,
        assets: [{ mime: 'image/webp', sha256: hash }],
        responseCoverage: { observed: 1, hashed: hash ? 1 : 0, bodyFailures: hash ? 0 : 1 },
      },
    }],
  };
}

test('asset comparison preserves route provenance and reports informational hash differences', () => {
  const report = compareAssetEvidence(
    bundle('measurements/assets/source.json', 'source-hash'),
    bundle('measurements/assets/clone.json', 'clone-hash'),
    '20260914T030000Z_source_11111111',
    '20260914T030100Z_clone_22222222',
  );
  const finding = report.findings.find((entry) => entry.category === 'asset-content-mismatch');
  assert.equal(finding.status, 'informational');
  assert.equal(finding.evidence.source.runId, '20260914T030000Z_source_11111111');
  assert.equal(finding.evidence.clone.artifact, 'measurements/assets/clone.json');
  assert.equal(report.coverage.complete, true);
});

test('incomplete asset body coverage stays informational and incomplete', () => {
  const report = compareAssetEvidence(
    bundle('measurements/assets/source.json', 'source-hash'),
    bundle('measurements/assets/clone.json', null, false),
    '20260914T040000Z_source_33333333',
    '20260914T040100Z_clone_44444444',
  );
  assert.equal(report.coverage.complete, false);
  assert.ok(report.findings.some((entry) => entry.category === 'asset-manifest-incomplete'));
  assert.ok(report.findings.every((entry) => entry.status === 'informational'));
});
