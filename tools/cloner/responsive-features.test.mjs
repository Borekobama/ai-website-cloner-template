import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareResponsiveEvidence, generateMediaFeatureProbes, parseResponsiveCondition } from './responsive.mjs';

test('media feature parsing covers colour scheme and input capabilities', () => {
  const parsed = parseResponsiveCondition('(prefers-color-scheme: dark) and (hover: none) and (any-pointer: coarse)');
  assert.deepEqual(parsed.prefersColorScheme, ['dark']);
  assert.deepEqual(parsed.hover, ['none']);
  assert.deepEqual(parsed.pointer, ['coarse']);
});

test('media feature probes capture both values of each discovered feature', () => {
  const conditions = ['(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)', '(pointer: coarse)']
    .map((condition) => ({ kind: 'media', condition: parseResponsiveCondition(condition).condition }));
  const probes = generateMediaFeatureProbes([...conditions, { kind: 'container', condition: '(prefers-color-scheme:dark)' }]);
  assert.deepEqual(probes.map((probe) => probe.features), [
    { colorScheme: 'light' }, { colorScheme: 'dark' },
    { reducedMotion: 'no-preference' }, { reducedMotion: 'reduce' },
    { touch: false }, { touch: true },
  ]);
  assert.ok(probes.every((probe) => probe.requestedViewport.width === 1280 && probe.requestedViewport.height === 720));
  assert.deepEqual(generateMediaFeatureProbes([{ kind: 'media', condition: '(min-width:768px)' }]), []);
});

test('feature probes compare separately from pixel probes at the same viewport', () => {
  const viewport = { width: 1280, height: 720 };
  const summary = (color) => ({ visibleControlCount: 0, controls: [], visibleLandmarkCount: 0, landmarks: [], document: {}, ...(color ? { colors: { body: { color } } } : {}) });
  const observation = (darkColor) => ({
    route: '/home',
    complete: true,
    discoveryComplete: true,
    conditions: { media: [{ condition: '(prefers-color-scheme:dark)' }], container: [] },
    probes: [
      { requestedViewport: viewport, status: 'captured', actualViewport: viewport, mediaMatches: [], summary: summary(null) },
      { requestedViewport: viewport, features: { colorScheme: 'dark' }, status: 'captured', actualViewport: viewport, mediaMatches: [], summary: summary(darkColor) },
    ],
  });
  const index = (value) => ({ complete: true, routes: [{ route: '/home', artifactPath: 'measurements/responsive/0001.json', observation: value }] });
  const report = compareResponsiveEvidence(index(observation('rgb(255, 255, 255)')), index(observation('rgb(0, 0, 0)')), '20260914T000001Z_source_11111111', '20260914T000002Z_clone_22222222');
  assert.deepEqual(report.findings.map((finding) => finding.category), ['responsive-feature-mismatch']);
  assert.deepEqual(report.findings[0].subject, { route: '/home', viewport, features: { colorScheme: 'dark' } });
  assert.equal(report.coverage.layoutProbesCompared, 2);
});
