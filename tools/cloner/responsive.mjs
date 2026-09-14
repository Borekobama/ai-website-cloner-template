import { canonicalJson, readArtifact, sha256 } from './run-store.mjs';
import { redactForPersistence, safeUrl } from './redact.mjs';

export const RESPONSIVE_SCHEMA_VERSION = 1;
export const RESPONSIVE_PROBE_BASELINE = Object.freeze({ width: 1280, height: 720 });

const CONTROL_LIMIT = 32;
const LANDMARK_LIMIT = 24;
const AXIS_ORDER = new Map([['width', 0], ['height', 1]]);

export function normalizeCssCondition(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(/\(\s*/gu, '(')
    .replace(/\s*\)/gu, ')')
    .replace(/\s*([:,])\s*/gu, '$1')
    .replace(/\s*(<=|>=|=|<|>)\s*/gu, '$1')
    .replace(/\b(and|or|not)\b/gu, ' $1 ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function thresholdBound(operator) {
  if (operator === '>' || operator === '>=') return 'min';
  if (operator === '<' || operator === '<=') return 'max';
  return 'exact';
}

function invertOperator(operator) {
  if (operator === '<') return '>';
  if (operator === '<=') return '>=';
  if (operator === '>') return '<';
  if (operator === '>=') return '<=';
  return operator;
}

function pushThreshold(target, seen, axis, operator, pixels) {
  if (!Number.isFinite(pixels) || pixels < 0) return;
  const key = `${axis}|${operator}|${pixels}`;
  if (seen.has(key)) return;
  seen.add(key);
  target.push({ axis, bound: thresholdBound(operator), operator, pixels });
}

export function parseResponsiveCondition(value) {
  const condition = normalizeCssCondition(value);
  const thresholds = [];
  const seen = new Set();

  for (const match of condition.matchAll(/\((min|max)-(width|height):(-?(?:\d+\.?\d*|\.\d+))px\)/gu)) {
    const operator = match[1] === 'min' ? '>=' : '<=';
    pushThreshold(thresholds, seen, match[2], operator, Number(match[3]));
  }
  for (const match of condition.matchAll(/\((width|height):(-?(?:\d+\.?\d*|\.\d+))px\)/gu)) {
    pushThreshold(thresholds, seen, match[1], '=', Number(match[2]));
  }
  for (const match of condition.matchAll(/\b(width|height)(<=|>=|<|>)(-?(?:\d+\.?\d*|\.\d+))px\b/gu)) {
    pushThreshold(thresholds, seen, match[1], match[2], Number(match[3]));
  }
  for (const match of condition.matchAll(/\b(-?(?:\d+\.?\d*|\.\d+))px(<=|>=|<|>)(width|height)\b/gu)) {
    pushThreshold(thresholds, seen, match[3], invertOperator(match[2]), Number(match[1]));
  }

  const orientation = [...new Set([...condition.matchAll(/orientation:(portrait|landscape)/gu)].map((match) => match[1]))].sort();
  const prefersReducedMotion = [...new Set([...condition.matchAll(/prefers-reduced-motion:(reduce|no-preference)/gu)].map((match) => match[1]))].sort();

  return {
    condition,
    thresholds: thresholds.sort((left, right) => (
      (AXIS_ORDER.get(left.axis) ?? 99) - (AXIS_ORDER.get(right.axis) ?? 99)
      || left.pixels - right.pixels
      || left.operator.localeCompare(right.operator)
    )),
    orientation,
    prefersReducedMotion,
  };
}

export function responsiveThresholds(conditions = []) {
  const byKey = new Map();
  for (const record of conditions) {
    const parsed = record.features ?? parseResponsiveCondition(record.condition);
    for (const threshold of parsed.thresholds ?? []) {
      const key = `${threshold.axis}|${threshold.pixels}`;
      const current = byKey.get(key) ?? {
        axis: threshold.axis,
        pixels: threshold.pixels,
        bounds: new Set(),
        kinds: new Set(),
        conditions: new Set(),
      };
      current.bounds.add(threshold.bound);
      if (record.kind) current.kinds.add(record.kind);
      if (record.condition) current.conditions.add(record.condition);
      byKey.set(key, current);
    }
  }
  return [...byKey.values()]
    .map((entry) => ({
      axis: entry.axis,
      pixels: entry.pixels,
      bounds: [...entry.bounds].sort(),
      kinds: [...entry.kinds].sort(),
      conditions: [...entry.conditions].sort(),
    }))
    .sort((left, right) => (
      (AXIS_ORDER.get(left.axis) ?? 99) - (AXIS_ORDER.get(right.axis) ?? 99)
      || left.pixels - right.pixels
    ));
}

export function generateExactPixelProbes(thresholds = [], baselineViewport = RESPONSIVE_PROBE_BASELINE) {
  const baseline = {
    width: Number(baselineViewport?.width ?? RESPONSIVE_PROBE_BASELINE.width),
    height: Number(baselineViewport?.height ?? RESPONSIVE_PROBE_BASELINE.height),
  };
  const probes = new Map();
  for (const threshold of [...thresholds].sort((left, right) => (
    (AXIS_ORDER.get(left.axis) ?? 99) - (AXIS_ORDER.get(right.axis) ?? 99)
    || left.pixels - right.pixels
  ))) {
    if (!['width', 'height'].includes(threshold.axis) || !Number.isFinite(threshold.pixels)) continue;
    for (const delta of [-1, 0, 1]) {
      const value = threshold.pixels + delta;
      if (value <= 0) continue;
      const requestedViewport = { ...baseline, [threshold.axis]: value };
      const key = `${requestedViewport.width}x${requestedViewport.height}`;
      const entry = probes.get(key) ?? { requestedViewport, reasons: [] };
      entry.reasons.push({
        axis: threshold.axis,
        threshold: threshold.pixels,
        delta,
        kinds: [...(threshold.kinds ?? [])],
        conditions: [...(threshold.conditions ?? [])],
      });
      probes.set(key, entry);
    }
  }
  return [...probes.values()];
}

function conditionRecordKey(record) {
  return `${record.kind}|${record.condition}`;
}

function normalizeDiscoveredConditions(rawConditions = []) {
  const conditions = new Map();
  for (const raw of rawConditions) {
    const condition = normalizeCssCondition(raw.condition);
    if (!condition) continue;
    const record = {
      kind: raw.kind,
      condition,
      features: parseResponsiveCondition(condition),
      occurrences: [{ stylesheetIndex: raw.stylesheetIndex }],
    };
    const key = conditionRecordKey(record);
    const existing = conditions.get(key);
    if (existing) existing.occurrences.push({ stylesheetIndex: raw.stylesheetIndex });
    else conditions.set(key, record);
  }
  return [...conditions.values()].sort((left, right) => (
    left.kind.localeCompare(right.kind) || left.condition.localeCompare(right.condition)
  ));
}

async function inspectResponsiveCss(page) {
  return page.evaluate(() => {
    const stylesheets = [];
    const conditions = [];
    let nestedRuleFailures = 0;

    const recordCondition = (rule, stylesheetIndex) => {
      const constructorName = rule?.constructor?.name ?? '';
      const cssText = String(rule?.cssText ?? '');
      if (constructorName === 'CSSMediaRule' || rule?.type === globalThis.CSSRule?.MEDIA_RULE) {
        const condition = String(rule.conditionText || rule.media?.mediaText || '').trim();
        if (condition) conditions.push({ kind: 'media', condition, stylesheetIndex });
      } else if (constructorName === 'CSSContainerRule' || /^@container\b/iu.test(cssText)) {
        const header = cssText.slice(0, cssText.indexOf('{') >= 0 ? cssText.indexOf('{') : cssText.length).replace(/^@container\s*/iu, '').trim();
        const conditionText = String(rule.conditionText || '').trim();
        const containerName = String(rule.containerName || '').trim();
        const condition = containerName && conditionText
          ? `${containerName} ${conditionText}`
          : conditionText || header;
        if (condition) conditions.push({ kind: 'container', condition, stylesheetIndex });
      }
    };

    const visitRules = (rules, stylesheetIndex) => {
      for (const rule of [...rules]) {
        recordCondition(rule, stylesheetIndex);
        try {
          if (rule.cssRules) visitRules(rule.cssRules, stylesheetIndex);
        } catch {
          nestedRuleFailures += 1;
        }
      }
    };

    for (const [stylesheetIndex, sheet] of [...document.styleSheets].entries()) {
      const source = sheet.href || 'inline';
      try {
        const rules = sheet.cssRules;
        stylesheets.push({ stylesheetIndex, source, readable: true, ruleCount: rules.length });
        visitRules(rules, stylesheetIndex);
      } catch (error) {
        stylesheets.push({
          stylesheetIndex,
          source,
          readable: false,
          ruleCount: null,
          error: error?.name || 'unreadable-stylesheet',
        });
      }
    }
    return { stylesheets, conditions, nestedRuleFailures };
  });
}

async function actualViewport(page) {
  try {
    return await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    }));
  } catch {
    return null;
  }
}

async function captureProbe(page, probe, mediaConditions) {
  try {
    await page.setViewportSize(probe.requestedViewport);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const observation = await page.evaluate(({ conditions, controlLimit, landmarkLimit }) => {
      const round = (value) => Math.round(value * 100) / 100;
      const rect = (element) => {
        const box = element.getBoundingClientRect();
        return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) };
      };
      const visible = (element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
      };
      const controls = [...document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="tab"], [role="menuitem"], [role="switch"]')]
        .filter(visible);
      const controlSummary = controls.slice(0, controlLimit).map((element) => ({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') || element.tagName.toLowerCase(),
        name: (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || element.getAttribute('placeholder') || element.getAttribute('name') || '').replace(/\s+/gu, ' ').trim().slice(0, 160),
        rect: rect(element),
      }));
      const landmarks = [...document.querySelectorAll('header, nav, main, aside, footer, [role="banner"], [role="navigation"], [role="main"], [role="complementary"], [role="contentinfo"]')]
        .filter(visible);
      const landmarkSummary = landmarks.slice(0, landmarkLimit).map((element) => {
        const style = getComputedStyle(element);
        return {
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role'),
          id: element.id ? element.id.slice(0, 120) : null,
          rect: rect(element),
          display: style.display,
          position: style.position,
          flexDirection: style.flexDirection,
          gridTemplateColumns: style.gridTemplateColumns,
        };
      });
      return {
        actualViewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
        mediaMatches: conditions.map((condition) => {
          try {
            return { condition, matches: matchMedia(condition).matches };
          } catch (error) {
            return { condition, matches: null, error: error?.name || 'match-media-failed' };
          }
        }),
        summary: {
          visibleControlCount: controls.length,
          controls: controlSummary,
          visibleLandmarkCount: landmarks.length,
          landmarks: landmarkSummary,
          document: {
            scrollWidth: document.documentElement.scrollWidth,
            scrollHeight: document.documentElement.scrollHeight,
            bodyWidth: document.body?.getBoundingClientRect().width ?? null,
            bodyHeight: document.body?.getBoundingClientRect().height ?? null,
          },
        },
      };
    }, { conditions: mediaConditions, controlLimit: CONTROL_LIMIT, landmarkLimit: LANDMARK_LIMIT });
    return { ...probe, status: 'captured', ...observation };
  } catch (error) {
    return {
      ...probe,
      status: 'failed',
      actualViewport: await actualViewport(page),
      mediaMatches: [],
      summary: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function failedResponsiveObservation(route, error) {
  return redactForPersistence({
    schemaVersion: RESPONSIVE_SCHEMA_VERSION,
    kind: 'responsive-observation',
    route,
    capturedAt: new Date().toISOString(),
    baselineViewport: { ...RESPONSIVE_PROBE_BASELINE },
    stylesheets: [],
    stylesheetCoverage: { total: 0, readable: 0, unreadable: 0, nestedRuleFailures: 0 },
    conditions: { media: [], container: [] },
    thresholds: [],
    probes: [],
    discoveryComplete: false,
    probeCoverage: { expected: 0, captured: 0, failed: 0 },
    complete: false,
    failure: error instanceof Error ? error.message : String(error),
  });
}

export async function captureResponsive(page, { route } = {}) {
  const originalViewport = page.viewportSize?.() ?? await actualViewport(page);
  try {
    const raw = await inspectResponsiveCss(page);
    const stylesheets = raw.stylesheets.map((sheet) => ({ ...sheet, source: sheet.source === 'inline' ? 'inline' : safeUrl(sheet.source) }));
    const allConditions = normalizeDiscoveredConditions(raw.conditions);
    const media = allConditions.filter((condition) => condition.kind === 'media');
    const container = allConditions.filter((condition) => condition.kind === 'container');
    const thresholds = responsiveThresholds(allConditions);
    const probeRequests = generateExactPixelProbes(thresholds);
    const probes = [];
    for (const probe of probeRequests) {
      probes.push(await captureProbe(page, probe, media.map((condition) => condition.condition)));
    }

    let restoreFailure = null;
    if (originalViewport?.width && originalViewport?.height) {
      try {
        await page.setViewportSize({ width: originalViewport.width, height: originalViewport.height });
      } catch (error) {
        restoreFailure = error instanceof Error ? error.message : String(error);
      }
    }

    const stylesheetCoverage = {
      total: stylesheets.length,
      readable: stylesheets.filter((sheet) => sheet.readable).length,
      unreadable: stylesheets.filter((sheet) => !sheet.readable).length,
      nestedRuleFailures: raw.nestedRuleFailures,
    };
    const discoveryComplete = stylesheetCoverage.unreadable === 0 && stylesheetCoverage.nestedRuleFailures === 0;
    const probeCoverage = {
      expected: probes.length,
      captured: probes.filter((probe) => probe.status === 'captured').length,
      failed: probes.filter((probe) => probe.status === 'failed').length,
    };
    const evidence = redactForPersistence({
      schemaVersion: RESPONSIVE_SCHEMA_VERSION,
      kind: 'responsive-observation',
      route,
      capturedAt: new Date().toISOString(),
      baselineViewport: { ...RESPONSIVE_PROBE_BASELINE },
      originalViewport,
      stylesheets,
      stylesheetCoverage,
      conditions: { media, container },
      thresholds,
      probes,
      discoveryComplete,
      probeCoverage,
      restoreFailure,
      complete: discoveryComplete && probeCoverage.failed === 0 && restoreFailure === null,
    });
    return { ...evidence, fingerprint: sha256(canonicalJson(evidence)) };
  } catch (error) {
    return failedResponsiveObservation(route, error);
  } finally {
    if (originalViewport?.width && originalViewport?.height) {
      await page.setViewportSize({ width: originalViewport.width, height: originalViewport.height }).catch(() => {});
    }
  }
}

export function responsiveIndexEntry(observation, artifactPath) {
  const mediaConditions = observation.conditions?.media ?? [];
  const containerConditions = observation.conditions?.container ?? [];
  return {
    route: observation.route,
    artifactPath,
    fingerprint: observation.fingerprint ?? null,
    complete: observation.complete === true,
    discoveryComplete: observation.discoveryComplete === true,
    stylesheets: observation.stylesheetCoverage ?? { total: 0, readable: 0, unreadable: 0, nestedRuleFailures: 0 },
    mediaConditionCount: mediaConditions.length,
    containerConditionCount: containerConditions.length,
    thresholdCount: observation.thresholds?.length ?? 0,
    probesExpected: observation.probeCoverage?.expected ?? 0,
    probesCaptured: observation.probeCoverage?.captured ?? 0,
    probeFailures: observation.probeCoverage?.failed ?? 0,
  };
}

export function hydrateResponsiveEvidence({ root = process.cwd(), siteKey, runId, index }) {
  if (!index) return null;
  return {
    ...index,
    routes: (index.routes ?? []).map((entry) => ({
      ...entry,
      observation: JSON.parse(readArtifact(root, siteKey, runId, entry.artifactPath).toString('utf8')),
    })),
  };
}

function responsiveRouteMap(value) {
  return new Map((value?.routes ?? []).map((entry) => {
    const observation = entry.observation ?? entry;
    return [observation.route ?? entry.route, { entry, observation }];
  }));
}

function routeEvidence(routeValue, runId, locator = '#') {
  if (!routeValue) return null;
  return {
    runId,
    artifact: routeValue.entry.artifactPath ?? 'measurements/responsive.json',
    locator,
  };
}

function conditionSet(observation, kind) {
  return [...new Set((observation?.conditions?.[kind] ?? []).map((entry) => entry.condition).filter(Boolean))].sort();
}

function probeKey(probe) {
  const viewport = probe?.requestedViewport ?? {};
  return `${viewport.width}x${viewport.height}`;
}

function probeMap(observation) {
  return new Map((observation?.probes ?? []).map((probe, index) => [probeKey(probe), { probe, index }]));
}

function mediaMatch(probe, condition) {
  const matches = probe?.mediaMatches ?? [];
  const index = matches.findIndex((entry) => entry.condition === condition);
  return index === -1 ? null : { entry: matches[index], index };
}

function responsiveComparator(evidenceClass, dimension, mode) {
  return { instrument: 'responsive', evidenceClass, dimension, mode };
}

export function compareResponsiveEvidence(source, clone, sourceRunId, cloneRunId) {
  if (!source && !clone) {
    return { findings: [], comparatorCoverage: [], coverage: { configured: false, complete: true, routesCompared: 0, mediaProbesCompared: 0 } };
  }
  if (!source || !clone) {
    const comparator = responsiveComparator('responsive-presence', 'presence', 'informational');
    return {
      findings: [{
        category: 'responsive-incomplete',
        subject: { route: null },
        status: 'informational',
        policy: { dimension: 'presence', mode: 'informational' },
        comparator,
        observed: { source: source ? 'captured' : 'missing', clone: clone ? 'captured' : 'missing' },
        evidence: {
          source: source ? { runId: sourceRunId, artifact: 'measurements/responsive.json', locator: '#' } : null,
          clone: clone ? { runId: cloneRunId, artifact: 'measurements/responsive.json', locator: '#' } : null,
        },
      }],
      comparatorCoverage: [{ comparator, subject: { route: null }, complete: false }],
      coverage: { configured: true, complete: false, reason: 'one-sided-responsive-evidence', routesCompared: 0, mediaProbesCompared: 0 },
    };
  }

  const sourceRoutes = responsiveRouteMap(source);
  const cloneRoutes = responsiveRouteMap(clone);
  const routes = new Set([...sourceRoutes.keys(), ...cloneRoutes.keys()]);
  const findings = [];
  const comparatorCoverage = [{
    comparator: responsiveComparator('responsive-presence', 'presence', 'informational'),
    subject: { route: null },
    complete: true,
  }];
  let routesCompared = 0;
  let mediaConditionsCompared = 0;
  let containerConditionsCompared = 0;
  let mediaProbesCompared = 0;

  for (const route of routes) {
    const sourceRoute = sourceRoutes.get(route);
    const cloneRoute = cloneRoutes.get(route);
    const routePresenceComparator = responsiveComparator('responsive-presence', 'presence', 'informational');
    if (!sourceRoute || !cloneRoute) {
      comparatorCoverage.push({ comparator: routePresenceComparator, subject: { route }, complete: false });
      findings.push({
        category: 'responsive-incomplete',
        subject: { route },
        status: 'informational',
        policy: { dimension: 'presence', mode: 'informational' },
        comparator: routePresenceComparator,
        observed: { source: sourceRoute ? 'captured' : 'missing', clone: cloneRoute ? 'captured' : 'missing' },
        evidence: { source: routeEvidence(sourceRoute, sourceRunId), clone: routeEvidence(cloneRoute, cloneRunId) },
      });
      continue;
    }
    comparatorCoverage.push({ comparator: routePresenceComparator, subject: { route }, complete: true });
    routesCompared += 1;
    const sourceObservation = sourceRoute.observation;
    const cloneObservation = cloneRoute.observation;
    const discoveryComplete = sourceObservation.discoveryComplete === true && cloneObservation.discoveryComplete === true;

    const sourceMedia = conditionSet(sourceObservation, 'media');
    const cloneMedia = conditionSet(cloneObservation, 'media');
    const mediaComparator = responsiveComparator('responsive-media-conditions', 'conditions', 'gate');
    comparatorCoverage.push({ comparator: mediaComparator, subject: { route }, complete: discoveryComplete });
    if (discoveryComplete) {
      mediaConditionsCompared += 1;
      if (canonicalJson(sourceMedia) !== canonicalJson(cloneMedia)) {
        findings.push({
          category: 'responsive-media-condition-mismatch',
          subject: { route },
          status: 'open',
          policy: { dimension: 'conditions', mode: 'gate' },
          comparator: mediaComparator,
          observed: { source: sourceMedia, clone: cloneMedia },
          evidence: {
            source: routeEvidence(sourceRoute, sourceRunId, '#/conditions/media'),
            clone: routeEvidence(cloneRoute, cloneRunId, '#/conditions/media'),
          },
        });
      }
    }

    const sourceContainer = conditionSet(sourceObservation, 'container');
    const cloneContainer = conditionSet(cloneObservation, 'container');
    const containerComparator = responsiveComparator('responsive-container-conditions', 'conditions', 'informational');
    comparatorCoverage.push({ comparator: containerComparator, subject: { route }, complete: discoveryComplete });
    if (discoveryComplete) {
      containerConditionsCompared += 1;
      if (canonicalJson(sourceContainer) !== canonicalJson(cloneContainer)) {
        findings.push({
          category: 'responsive-container-condition-mismatch',
          subject: { route },
          status: 'informational',
          policy: { dimension: 'conditions', mode: 'informational', reason: 'no-direct-container-query-match' },
          comparator: containerComparator,
          observed: { source: sourceContainer, clone: cloneContainer },
          evidence: {
            source: routeEvidence(sourceRoute, sourceRunId, '#/conditions/container'),
            clone: routeEvidence(cloneRoute, cloneRunId, '#/conditions/container'),
          },
        });
      }
    }

    const commonMedia = sourceMedia.filter((condition) => cloneMedia.includes(condition));
    const sourceProbes = probeMap(sourceObservation);
    const cloneProbes = probeMap(cloneObservation);
    const commonProbeKeys = [...sourceProbes.keys()].filter((key) => cloneProbes.has(key)).sort();
    for (const condition of commonMedia) {
      for (const key of commonProbeKeys) {
        const sourceProbe = sourceProbes.get(key);
        const cloneProbe = cloneProbes.get(key);
        const sourceMatch = mediaMatch(sourceProbe.probe, condition);
        const cloneMatch = mediaMatch(cloneProbe.probe, condition);
        const subject = { route, condition, viewport: sourceProbe.probe.requestedViewport };
        const comparator = responsiveComparator('responsive-media-probe', 'matches', 'gate');
        const complete = sourceProbe.probe.status === 'captured'
          && cloneProbe.probe.status === 'captured'
          && Boolean(sourceMatch && cloneMatch)
          && sourceMatch.entry.matches !== null
          && cloneMatch.entry.matches !== null;
        comparatorCoverage.push({ comparator, subject, complete });
        if (!complete) continue;
        mediaProbesCompared += 1;
        const actualViewportEqual = canonicalJson(sourceProbe.probe.actualViewport) === canonicalJson(cloneProbe.probe.actualViewport);
        if (sourceMatch.entry.matches !== cloneMatch.entry.matches || !actualViewportEqual) {
          findings.push({
            category: 'responsive-media-probe-mismatch',
            subject,
            status: 'open',
            policy: { dimension: 'matches', mode: 'gate' },
            comparator,
            observed: {
              source: { matches: sourceMatch.entry.matches, actualViewport: sourceProbe.probe.actualViewport },
              clone: { matches: cloneMatch.entry.matches, actualViewport: cloneProbe.probe.actualViewport },
            },
            evidence: {
              source: routeEvidence(sourceRoute, sourceRunId, `#/probes/${sourceProbe.index}/mediaMatches/${sourceMatch.index}`),
              clone: routeEvidence(cloneRoute, cloneRunId, `#/probes/${cloneProbe.index}/mediaMatches/${cloneMatch.index}`),
            },
          });
        }
      }
    }

    const coverageComparator = responsiveComparator('responsive-coverage', 'complete', 'informational');
    const routeComplete = sourceObservation.complete === true && cloneObservation.complete === true;
    comparatorCoverage.push({ comparator: coverageComparator, subject: { route }, complete: routeComplete });
    if (!routeComplete) {
      findings.push({
        category: 'responsive-incomplete',
        subject: { route },
        status: 'informational',
        policy: { dimension: 'complete', mode: 'informational' },
        comparator: coverageComparator,
        observed: {
          source: { complete: sourceObservation.complete === true, probeFailures: sourceObservation.probeCoverage?.failed ?? 0, unreadableStylesheets: sourceObservation.stylesheetCoverage?.unreadable ?? 0 },
          clone: { complete: cloneObservation.complete === true, probeFailures: cloneObservation.probeCoverage?.failed ?? 0, unreadableStylesheets: cloneObservation.stylesheetCoverage?.unreadable ?? 0 },
        },
        evidence: { source: routeEvidence(sourceRoute, sourceRunId), clone: routeEvidence(cloneRoute, cloneRunId) },
      });
    }
  }

  return {
    findings,
    comparatorCoverage,
    coverage: {
      configured: true,
      complete: source.complete === true
        && clone.complete === true
        && routesCompared === routes.size
        && comparatorCoverage.every((entry) => entry.complete !== false || entry.comparator.mode === 'informational'),
      sourceRoutes: sourceRoutes.size,
      cloneRoutes: cloneRoutes.size,
      routesCompared,
      mediaConditionsCompared,
      containerConditionsCompared,
      mediaProbesCompared,
    },
  };
}
