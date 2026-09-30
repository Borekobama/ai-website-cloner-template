import { redactForPersistence } from './redact.mjs';

export const PERFORMANCE_SCHEMA_VERSION = 1;

// Load metrics are noisy and depend on server mode, so every comparison stays
// informational. These bounds only decide when a difference is worth reporting.
export const PERFORMANCE_THRESHOLDS = Object.freeze({
  clsDelta: 0.05,
  clsFloor: 0.1,
  lcpRatio: 1.5,
  lcpDeltaMs: 500,
  weightRatio: 2,
  weightDeltaBytes: 100 * 1024,
});

const round = (value, digits = 0) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

// Largest session window: shifts less than 1 s apart, at most 5 s per window.
export function cumulativeLayoutShift(shifts = []) {
  let largest = 0;
  let current = 0;
  let windowStart = null;
  let previous = null;
  for (const shift of [...shifts].sort((left, right) => left.startTime - right.startTime)) {
    if (windowStart === null || shift.startTime - previous > 1000 || shift.startTime - windowStart > 5000) {
      current = 0;
      windowStart = shift.startTime;
    }
    current += shift.value;
    previous = shift.startTime;
    largest = Math.max(largest, current);
  }
  return largest;
}

export async function capturePerformance(page, { route, settleMs = 100 } = {}) {
  try {
    const raw = await page.evaluate((wait) => new Promise((resolve) => {
      const largestPaints = [];
      const shifts = [];
      const observe = (type, sink) => {
        try {
          new PerformanceObserver((list) => sink.push(...list.getEntries())).observe({ type, buffered: true });
          return true;
        } catch {
          return false;
        }
      };
      const lcpSupported = observe('largest-contentful-paint', largestPaints);
      const clsSupported = observe('layout-shift', shifts);
      setTimeout(() => {
        const navigation = performance.getEntriesByType('navigation')[0] ?? null;
        const resources = performance.getEntriesByType('resource');
        resolve({
          lcpSupported,
          clsSupported,
          lcpMs: largestPaints.length ? largestPaints.at(-1).startTime : null,
          shifts: shifts.filter((entry) => !entry.hadRecentInput).map((entry) => ({ startTime: entry.startTime, value: entry.value })),
          navigation: navigation ? {
            domContentLoadedMs: navigation.domContentLoadedEventEnd,
            loadMs: navigation.loadEventEnd,
            transferBytes: navigation.transferSize,
            encodedBytes: navigation.encodedBodySize,
          } : null,
          resources: {
            count: resources.length,
            transferBytes: resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
            encodedBytes: resources.reduce((sum, entry) => sum + (entry.encodedBodySize || 0), 0),
          },
        });
      }, wait);
    }), settleMs);
    return redactForPersistence({
      schemaVersion: PERFORMANCE_SCHEMA_VERSION,
      kind: 'performance-observation',
      route,
      capturedAt: new Date().toISOString(),
      metrics: {
        lcpMs: round(raw.lcpMs),
        cls: round(cumulativeLayoutShift(raw.shifts), 4),
        layoutShifts: raw.shifts.length,
        domContentLoadedMs: round(raw.navigation?.domContentLoadedMs) || null,
        loadMs: round(raw.navigation?.loadMs) || null,
        // Transfer sizes are lower bounds: cached and cross-origin resources
        // without Timing-Allow-Origin report 0 bytes.
        transferBytes: (raw.navigation?.transferBytes ?? 0) + raw.resources.transferBytes,
        encodedBytes: (raw.navigation?.encodedBytes ?? 0) + raw.resources.encodedBytes,
        resourceCount: raw.resources.count,
      },
      support: { lcp: raw.lcpSupported, cls: raw.clsSupported },
      complete: raw.lcpSupported && raw.clsSupported && raw.navigation !== null,
    });
  } catch (error) {
    return redactForPersistence({
      schemaVersion: PERFORMANCE_SCHEMA_VERSION,
      kind: 'performance-observation',
      route,
      capturedAt: new Date().toISOString(),
      metrics: null,
      support: null,
      complete: false,
      failure: error instanceof Error ? error.message : String(error),
    });
  }
}

export function performanceIndexEntry(observation, artifactPath) {
  return {
    route: observation.route,
    artifactPath,
    complete: observation.complete === true,
    metrics: observation.metrics ?? null,
  };
}

const CHECKS = [
  {
    dimension: 'cls',
    category: 'performance-cls-regression',
    regressed: (source, clone, limits) => clone.cls !== null && source.cls !== null
      && clone.cls >= limits.clsFloor && clone.cls > source.cls + limits.clsDelta,
    observed: (source, clone) => ({ source: source.cls, clone: clone.cls }),
  },
  {
    dimension: 'lcp',
    category: 'performance-lcp-regression',
    regressed: (source, clone, limits) => clone.lcpMs !== null && source.lcpMs !== null
      && clone.lcpMs > source.lcpMs * limits.lcpRatio && clone.lcpMs - source.lcpMs > limits.lcpDeltaMs,
    observed: (source, clone) => ({ source: source.lcpMs, clone: clone.lcpMs }),
  },
  {
    dimension: 'weight',
    category: 'performance-weight-regression',
    regressed: (source, clone, limits) => clone.transferBytes > source.transferBytes * limits.weightRatio
      && clone.transferBytes - source.transferBytes > limits.weightDeltaBytes,
    observed: (source, clone) => ({ source: source.transferBytes, clone: clone.transferBytes }),
  },
];

export function comparePerformanceEvidence(source, clone, sourceRunId, cloneRunId, limits = PERFORMANCE_THRESHOLDS) {
  if (!source && !clone) return { findings: [], comparatorCoverage: [], coverage: { configured: false, complete: true, routesCompared: 0 } };
  const sourceRoutes = new Map((source?.routes ?? []).map((entry, index) => [entry.route, { entry, index }]));
  const cloneRoutes = new Map((clone?.routes ?? []).map((entry, index) => [entry.route, { entry, index }]));
  const routes = [...new Set([...sourceRoutes.keys(), ...cloneRoutes.keys()])];
  const findings = [];
  const comparatorCoverage = [];
  let routesCompared = 0;
  for (const route of routes) {
    const sourceRoute = sourceRoutes.get(route);
    const cloneRoute = cloneRoutes.get(route);
    const subject = { route };
    const complete = Boolean(sourceRoute?.entry.complete && cloneRoute?.entry.complete && sourceRoute.entry.metrics && cloneRoute.entry.metrics);
    if (complete) routesCompared += 1;
    for (const check of CHECKS) {
      const comparator = { instrument: 'performance', evidenceClass: `performance-${check.dimension}`, dimension: check.dimension, mode: 'informational' };
      comparatorCoverage.push({ comparator, subject, complete });
      if (!complete || !check.regressed(sourceRoute.entry.metrics, cloneRoute.entry.metrics, limits)) continue;
      findings.push({
        category: check.category,
        subject,
        status: 'informational',
        policy: { dimension: check.dimension, mode: 'informational' },
        comparator,
        observed: { ...check.observed(sourceRoute.entry.metrics, cloneRoute.entry.metrics), thresholds: limits },
        evidence: {
          source: { runId: sourceRunId, artifact: 'measurements/performance.json', locator: `#/routes/${sourceRoute.index}/metrics` },
          clone: { runId: cloneRunId, artifact: 'measurements/performance.json', locator: `#/routes/${cloneRoute.index}/metrics` },
        },
      });
    }
  }
  return {
    findings,
    comparatorCoverage,
    coverage: {
      configured: true,
      complete: Boolean(source?.complete && clone?.complete) && routesCompared === routes.length,
      routesCompared,
      thresholds: limits,
    },
  };
}
