import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comparePerformanceEvidence, cumulativeLayoutShift } from './performance.mjs';

test('cumulative layout shift uses the largest session window', () => {
  assert.equal(cumulativeLayoutShift([]), 0);
  // Shifts 0.5 s apart share a window; a 1.5 s gap starts a new one.
  assert.equal(cumulativeLayoutShift([{ startTime: 0, value: 0.1 }, { startTime: 500, value: 0.1 }, { startTime: 2000, value: 0.15 }]), 0.2);
  // A window closes after 5 s even when shifts keep arriving.
  const steady = Array.from({ length: 8 }, (_, index) => ({ startTime: index * 900, value: 0.01 }));
  assert.equal(Number(cumulativeLayoutShift(steady).toFixed(4)), 0.06);
});

test('performance comparison reports only meaningful regressions, always informationally', () => {
  const metrics = (overrides) => ({ lcpMs: 800, cls: 0.02, transferBytes: 200_000, ...overrides });
  const index = (values) => ({ complete: true, routes: [{ route: '/home', complete: true, metrics: metrics(values) }] });
  const quiet = comparePerformanceEvidence(index({}), index({ lcpMs: 1100, cls: 0.06, transferBytes: 390_000 }), '20260914T000001Z_source_11111111', '20260914T000002Z_clone_22222222');
  assert.deepEqual(quiet.findings, []);
  const loud = comparePerformanceEvidence(index({}), index({ lcpMs: 2000, cls: 0.3, transferBytes: 900_000 }), '20260914T000001Z_source_11111111', '20260914T000002Z_clone_22222222');
  assert.deepEqual(loud.findings.map((finding) => finding.category), ['performance-cls-regression', 'performance-lcp-regression', 'performance-weight-regression']);
  assert.ok(loud.findings.every((finding) => finding.status === 'informational' && finding.comparator.mode === 'informational'));
  assert.equal(loud.coverage.complete, true);
});
