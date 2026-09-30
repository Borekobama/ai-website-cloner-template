import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findPersonalData } from './redact.mjs';
import { closeRun, createRun, freezeFixture, writeArtifact } from './run-store.mjs';

function closedRun(root, siteKey, runId, artifacts) {
  createRun({ root, siteKey, runId, kind: 'clone', target: { kind: 'clone' }, scope: { inventoryRunId: null, authoritativeInventory: false } });
  for (const [path, value, options] of artifacts) writeArtifact(root, siteKey, runId, path, value, options);
  writeArtifact(root, siteKey, runId, 'coverage.json', { inventory: { runId: null, authoritative: false }, measurement: {}, scope: 'ad-hoc' });
  closeRun(root, siteKey, runId);
}

test('personal data detection finds addresses, tokens, and phone numbers without echoing them', () => {
  const kinds = (value) => findPersonalData(value).map((match) => match.kind);
  assert.deepEqual(kinds('Contact jane.doe@example.com for access'), ['email']);
  assert.deepEqual(kinds('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk'), ['jwt']);
  assert.deepEqual(kinds('Call +1 (555) 123-4567 today'), ['phone']);
  assert.ok(kinds('<a href="tel:+49 170 1234567">').includes('phone'));
  assert.equal(findPersonalData('jane.doe@example.com')[0].preview.includes('example.com'), false);
  for (const safe of ['/img/logo@2x.png', 'next@16.3.5', 'sha512-+7ziBLidS4NaNCdt57SUDT+1234567890abc', '2026-09-14T12:00:00+02:00', 'matrix(1, 0, 0, 1, 0, 0)']) {
    assert.deepEqual(findPersonalData(safe), [], `${safe} must not be treated as personal data`);
  }
});

test('public fixture promotion blocks personal data and keeps screenshots out by default', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloner-privacy-test-'));
  const siteKey = 'privacy.example';
  const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  try {
    closedRun(root, siteKey, '20260914T000001Z_clone_11111111', [['measurements/controls.json', { observations: [{ name: 'Email jane.doe@example.com' }] }]]);
    assert.throws(() => freezeFixture(root, siteKey, '20260914T000001Z_clone_11111111', 'leaky', { publicFixture: true }), /Public fixture promotion blocked[\s\S]*measurements\/controls\.json: email/);
    assert.equal(existsSync(join(root, 'tools/cloner/fixtures/leaky')), false);
    assert.equal(freezeFixture(root, siteKey, '20260914T000001Z_clone_11111111', 'leaky-private').visibility, 'private');

    closedRun(root, siteKey, '20260914T000002Z_clone_22222222', [
      ['measurements/controls.json', { observations: [{ name: 'Save' }] }],
      ['measurements/visual-regions/home/chrome.clone.png', pngHeader, { kind: 'visual-region-png', visibility: 'private' }],
    ]);
    const promoted = freezeFixture(root, siteKey, '20260914T000002Z_clone_22222222', 'clean', { publicFixture: true });
    assert.deepEqual(promoted.excludedArtifacts, ['measurements/visual-regions/home/chrome.clone.png']);
    assert.equal(existsSync(join(root, 'tools/cloner/fixtures/clean/measurements/visual-regions/home/chrome.clone.png')), false);
    assert.equal(JSON.parse(readFileSync(join(root, 'tools/cloner/fixtures/clean/fixture.json'), 'utf8')).visibility, 'public');
    const withScreenshots = freezeFixture(root, siteKey, '20260914T000002Z_clone_22222222', 'clean-screens', { publicFixture: true, includeScreenshots: true });
    assert.deepEqual(withScreenshots.excludedArtifacts, []);
    assert.equal(existsSync(join(root, 'tools/cloner/fixtures/clean-screens/measurements/visual-regions/home/chrome.clone.png')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
