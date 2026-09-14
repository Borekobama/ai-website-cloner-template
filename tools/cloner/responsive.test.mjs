import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareResponsiveEvidence,
  generateExactPixelProbes,
  normalizeCssCondition,
  parseResponsiveCondition,
  responsiveThresholds,
} from './responsive.mjs';

test('responsive CSS condition normalization is deterministic', () => {
  assert.equal(
    normalizeCssCondition('  SCREEN and ( min-width : 768px ) AND ( prefers-reduced-motion : REDUCE )  '),
    'screen and (min-width:768px) and (prefers-reduced-motion:reduce)',
  );
  assert.equal(
    normalizeCssCondition('sidebar   ( 600px <= width < 1200px )'),
    'sidebar (600px<=width<1200px)',
  );
});

test('responsive threshold parsing captures min/max axes and media preferences', () => {
  const parsed = parseResponsiveCondition('(min-width: 768px) and (max-height: 900px) and (orientation: landscape) and (prefers-reduced-motion: reduce)');
  assert.deepEqual(parsed.thresholds, [
    { axis: 'width', bound: 'min', operator: '>=', pixels: 768 },
    { axis: 'height', bound: 'max', operator: '<=', pixels: 900 },
  ]);
  assert.deepEqual(parsed.orientation, ['landscape']);
  assert.deepEqual(parsed.prefersReducedMotion, ['reduce']);

  const range = parseResponsiveCondition('(600px <= width < 1200px)');
  assert.deepEqual(range.thresholds, [
    { axis: 'width', bound: 'min', operator: '>=', pixels: 600 },
    { axis: 'width', bound: 'max', operator: '<', pixels: 1200 },
  ]);
});

test('responsive probes use threshold minus one, exact threshold, and threshold plus one', () => {
  const conditions = [
    { kind: 'media', condition: '(min-width:768px)', features: parseResponsiveCondition('(min-width:768px)') },
    { kind: 'container', condition: 'sidebar (max-height:600px)', features: parseResponsiveCondition('sidebar (max-height:600px)') },
  ];
  const probes = generateExactPixelProbes(responsiveThresholds(conditions), { width: 1280, height: 720 });
  assert.deepEqual(probes.map((probe) => probe.requestedViewport), [
    { width: 767, height: 720 },
    { width: 768, height: 720 },
    { width: 769, height: 720 },
    { width: 1280, height: 599 },
    { width: 1280, height: 600 },
    { width: 1280, height: 601 },
  ]);
  assert.deepEqual(probes[1].reasons[0], {
    axis: 'width',
    threshold: 768,
    delta: 0,
    kinds: ['media'],
    conditions: ['(min-width:768px)'],
  });
});

function responsiveBundle({ artifactPath, media = ['(min-width:768px)'], container = [], matches = [false, true, true], visibleControlCount = 1, complete = true }) {
  const requestedWidths = [767, 768, 769];
  return {
    complete,
    routes: [{
      route: '/home',
      artifactPath,
      observation: {
        route: '/home',
        complete,
        discoveryComplete: true,
        stylesheetCoverage: { total: 1, readable: 1, unreadable: 0, nestedRuleFailures: 0 },
        probeCoverage: { expected: 3, captured: 3, failed: 0 },
        conditions: {
          media: media.map((condition) => ({ condition })),
          container: container.map((condition) => ({ condition })),
        },
        probes: requestedWidths.map((width, index) => ({
          status: 'captured',
          requestedViewport: { width, height: 720 },
          actualViewport: { width, height: 720, devicePixelRatio: 1 },
          mediaMatches: media.map((condition) => ({ condition, matches: matches[index] })),
          summary: {
            visibleControlCount,
            controls: Array.from({ length: visibleControlCount }, (_, controlIndex) => ({ tag: 'button', role: 'button', name: `Control ${controlIndex}`, rect: { x: 0, y: controlIndex * 20, width: 80, height: 20 } })),
            visibleLandmarkCount: 1,
            landmarks: [{ tag: 'main', role: 'main', id: 'main', rect: { x: 0, y: 0, width: 1280, height: 720 }, display: 'block', position: 'static', flexDirection: 'row', gridTemplateColumns: 'none' }],
            document: { scrollWidth: 1280, scrollHeight: 720, bodyWidth: 1280, bodyHeight: 720 },
          },
        })),
      },
    }],
  };
}

test('responsive comparison gates media mismatches and keeps unmatched container conditions informational', () => {
  const sourceRunId = '20260914T010000Z_source_11111111';
  const cloneRunId = '20260914T010100Z_clone_22222222';
  const source = responsiveBundle({
    artifactPath: 'measurements/responsive/0001-source.json',
    container: ['sidebar (min-width:300px)'],
  });
  const clone = responsiveBundle({
    artifactPath: 'measurements/responsive/0001-clone.json',
    container: ['sidebar (min-width:320px)'],
    matches: [false, false, true],
  });
  const report = compareResponsiveEvidence(source, clone, sourceRunId, cloneRunId);
  const probeMismatch = report.findings.find((finding) => finding.category === 'responsive-media-probe-mismatch');
  const containerMismatch = report.findings.find((finding) => finding.category === 'responsive-container-condition-mismatch');

  assert.equal(report.coverage.complete, true);
  assert.equal(report.coverage.mediaProbesCompared, 3);
  assert.equal(probeMismatch.status, 'open');
  assert.deepEqual(probeMismatch.subject.viewport, { width: 768, height: 720 });
  assert.equal(probeMismatch.evidence.source.runId, sourceRunId);
  assert.equal(probeMismatch.evidence.source.artifact, 'measurements/responsive/0001-source.json');
  assert.match(probeMismatch.evidence.source.locator, /^#\/probes\/1\/mediaMatches\/0$/u);
  assert.equal(containerMismatch.status, 'informational');
  assert.equal(containerMismatch.policy.reason, 'no-direct-container-query-match');
});

test('responsive comparison emits a provenance-backed media condition set finding', () => {
  const source = responsiveBundle({ artifactPath: 'measurements/responsive/source.json' });
  const clone = responsiveBundle({ artifactPath: 'measurements/responsive/clone.json', media: ['(min-width:800px)'] });
  const report = compareResponsiveEvidence(source, clone, '20260914T020000Z_source_33333333', '20260914T020100Z_clone_44444444');
  const finding = report.findings.find((entry) => entry.category === 'responsive-media-condition-mismatch');
  assert.equal(finding.status, 'open');
  assert.equal(finding.policy.mode, 'gate');
  assert.equal(finding.evidence.clone.artifact, 'measurements/responsive/clone.json');
  assert.equal(finding.evidence.clone.locator, '#/conditions/media');
});

test('responsive comparison catches layout changes under matching media conditions', () => {
  const source = responsiveBundle({ artifactPath: 'measurements/responsive/source.json' });
  const clone = responsiveBundle({ artifactPath: 'measurements/responsive/clone.json', visibleControlCount: 2 });
  const report = compareResponsiveEvidence(source, clone, '20260914T030000Z_source_55555555', '20260914T030100Z_clone_66666666');
  const finding = report.findings.find((entry) => entry.category === 'responsive-layout-mismatch');
  assert.equal(finding.status, 'open');
  assert.deepEqual(finding.subject.viewport, { width: 767, height: 720 });
  assert.equal(report.coverage.layoutProbesCompared, 3);
  assert.equal(finding.evidence.source.locator, '#/probes/0/summary');
});
