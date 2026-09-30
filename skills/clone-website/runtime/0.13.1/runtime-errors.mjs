import { redactString } from './redact.mjs';

export const RUNTIME_ERROR_SCHEMA_VERSION = 1;

const MESSAGE_LIMIT = 500;
const ENTRY_LIMIT = 50;
const HYDRATION_PATTERN = /hydrat|did not match|server rendered html|minified react error #(?:418|419|421|422|423|425)\b/iu;

function boundedText(value) {
  return redactString(String(value ?? '')).replace(/\s+/gu, ' ').trim().slice(0, MESSAGE_LIMIT);
}

export function runtimeErrorSignature(value) {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s)'"]+/giu, '<url>')
    .replace(/\b[0-9a-f]{8,}\b/giu, '<hex>')
    .replace(/\d+/gu, '<n>')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 200);
}

export function isHydrationError(value) {
  return HYDRATION_PATTERN.test(String(value ?? ''));
}

export function createRuntimeErrorTracker(page) {
  const pageErrors = [];
  const consoleErrors = [];
  let consoleWarnings = 0;
  const onPageError = (error) => {
    if (pageErrors.length >= ENTRY_LIMIT) return;
    const message = boundedText(error?.message ?? error);
    pageErrors.push({ name: String(error?.name ?? 'Error').slice(0, 80), message, signature: runtimeErrorSignature(message) });
  };
  const onConsole = (message) => {
    const type = message.type();
    if (type === 'warning') {
      consoleWarnings += 1;
      return;
    }
    if (type !== 'error' || consoleErrors.length >= ENTRY_LIMIT) return;
    const text = boundedText(message.text());
    consoleErrors.push({ text, signature: runtimeErrorSignature(text) });
  };
  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  return {
    snapshot() {
      const texts = [...pageErrors.map((entry) => entry.message), ...consoleErrors.map((entry) => entry.text)];
      return {
        schemaVersion: RUNTIME_ERROR_SCHEMA_VERSION,
        captured: true,
        pageErrors: [...pageErrors],
        consoleErrors: [...consoleErrors],
        consoleWarnings,
        hydrationErrors: texts.filter(isHydrationError).length,
      };
    },
    stop() {
      page.off('pageerror', onPageError);
      page.off('console', onConsole);
    },
  };
}

function signatures(entries = []) {
  return [...new Set(entries.map((entry) => entry.signature).filter(Boolean))].sort();
}

function routeEntries(value) {
  return new Map((value?.routes ?? []).map((route, index) => [route.route, { route, index }]));
}

const CHECKS = [
  {
    dimension: 'page-errors',
    evidenceClass: 'runtime-page-error',
    mode: 'gate',
    category: 'runtime-page-error-mismatch',
    compare: (source, clone) => {
      const sourceSignatures = new Set(signatures(source.pageErrors));
      const cloneOnly = signatures(clone.pageErrors).filter((signature) => !sourceSignatures.has(signature));
      return cloneOnly.length ? { source: [...sourceSignatures], clone: signatures(clone.pageErrors), cloneOnly } : null;
    },
  },
  {
    dimension: 'hydration',
    evidenceClass: 'runtime-hydration',
    mode: 'gate',
    category: 'runtime-hydration-error',
    compare: (source, clone) => (clone.hydrationErrors > 0 && source.hydrationErrors === 0
      ? { source: source.hydrationErrors, clone: clone.hydrationErrors }
      : null),
  },
  {
    dimension: 'console-errors',
    evidenceClass: 'runtime-console-error',
    mode: 'informational',
    category: 'runtime-console-error-mismatch',
    compare: (source, clone) => {
      const sourceSignatures = new Set(signatures(source.consoleErrors));
      const cloneOnly = signatures(clone.consoleErrors).filter((signature) => !sourceSignatures.has(signature));
      return cloneOnly.length ? { source: [...sourceSignatures], clone: signatures(clone.consoleErrors), cloneOnly } : null;
    },
  },
];

export function compareRuntimeErrors(source, clone, sourceRunId, cloneRunId) {
  const sourceRoutes = routeEntries(source);
  const cloneRoutes = routeEntries(clone);
  const findings = [];
  const comparatorCoverage = [];
  let routesCompared = 0;
  let routesWithoutEvidence = 0;
  for (const [route, cloneEntry] of cloneRoutes) {
    const sourceEntry = sourceRoutes.get(route);
    // Route presence is owned by the route-inventory comparator.
    if (!sourceEntry) continue;
    const sourceErrors = sourceEntry.route.runtimeErrors;
    const cloneErrors = cloneEntry.route.runtimeErrors;
    const complete = sourceErrors?.captured === true && cloneErrors?.captured === true;
    if (complete) routesCompared += 1;
    else routesWithoutEvidence += 1;
    const subject = { route };
    for (const check of CHECKS) {
      const comparator = { instrument: 'runtime-errors', evidenceClass: check.evidenceClass, dimension: check.dimension, mode: check.mode };
      comparatorCoverage.push({ comparator, subject, complete });
      if (!complete) continue;
      const observed = check.compare(sourceErrors, cloneErrors);
      if (!observed) continue;
      findings.push({
        category: check.category,
        subject,
        status: check.mode === 'gate' ? 'open' : 'informational',
        policy: { dimension: check.dimension, mode: check.mode },
        comparator,
        observed,
        evidence: {
          source: { runId: sourceRunId, artifact: 'measurements/routes.json', locator: `#/routes/${sourceEntry.index}/runtimeErrors` },
          clone: { runId: cloneRunId, artifact: 'measurements/routes.json', locator: `#/routes/${cloneEntry.index}/runtimeErrors` },
        },
      });
    }
  }
  return {
    findings,
    comparatorCoverage,
    coverage: {
      configured: true,
      complete: routesWithoutEvidence === 0,
      routesCompared,
      routesWithoutEvidence,
    },
  };
}
