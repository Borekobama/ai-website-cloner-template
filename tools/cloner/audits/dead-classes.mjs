function unescapeCssIdentifier(value) {
  return value
    .replace(/\\([0-9a-f]{1,6})\s?/giu, (_, codePoint) => String.fromCodePoint(Number.parseInt(codePoint, 16)))
    .replace(/\\([^\n])/gu, '$1');
}

export function classNamesFromCss(cssText) {
  if (typeof cssText !== 'string') return [];
  const classes = new Set();
  // A colon that is escaped belongs to the class name (for example a
  // Tailwind variant); an unescaped colon starts a pseudo-class and must not
  // become part of the runtime class name.
  const classPattern = /\.((?:\\.|[A-Za-z_-])(?:\\.|[A-Za-z0-9_-])*)/gu;
  for (const match of cssText.matchAll(classPattern)) {
    const name = unescapeCssIdentifier(match[1]);
    if (name) classes.add(name);
  }
  return [...classes].sort();
}

export function normalizeClasses(classes) {
  return [...new Set((Array.isArray(classes) ? classes : String(classes ?? '').split(/\s+/u))
    .flatMap((value) => String(value).split(/\s+/u))
    .map((value) => value.trim())
    .filter(Boolean))].sort();
}

function routePayload(observation) {
  return observation?.payload ?? observation ?? {};
}

export function aggregateClassObservations(observations = []) {
  const routes = observations.map((observation, index) => {
    const payload = routePayload(observation);
    const route = observation?.route ?? payload.route ?? `route-${index + 1}`;
    const runtimeClasses = normalizeClasses(payload.runtimeClasses ?? payload.runtime ?? []);
    const compiledClasses = normalizeClasses(payload.compiledClasses ?? payload.compiled ?? []);
    const compiledSet = new Set(compiledClasses);
    const deadClasses = runtimeClasses.filter((name) => !compiledSet.has(name));
    const stylesheetsTotal = Number.isInteger(payload.stylesheetsTotal) ? payload.stylesheetsTotal : (payload.stylesheetSources ?? []).length;
    const stylesheetsUnreadable = Number.isInteger(payload.stylesheetsUnreadable) ? payload.stylesheetsUnreadable : 0;
    const stylesheetsReadable = Number.isInteger(payload.stylesheetsReadable) ? payload.stylesheetsReadable : Math.max(0, stylesheetsTotal - stylesheetsUnreadable);
    const cssCoverageComplete = payload.cssCoverageComplete ?? stylesheetsUnreadable === 0;
    return {
      route,
      runtimeClasses,
      compiledClasses,
      deadClasses,
      stylesheetSources: payload.stylesheetSources ?? [],
      stylesheetsTotal,
      stylesheetsReadable,
      stylesheetsUnreadable,
      cssCoverageComplete,
    };
  });

  const runtimeClassUnion = normalizeClasses(routes.flatMap((route) => route.runtimeClasses));
  const compiledClassUnion = normalizeClasses(routes.flatMap((route) => route.compiledClasses));
  const candidateDeadClasses = normalizeClasses(routes.flatMap((route) => route.deadClasses));
  const routeScopedDeadClasses = normalizeClasses(routes.filter((route) => route.cssCoverageComplete).flatMap((route) => route.deadClasses));
  const cssCoverageComplete = routes.every((route) => route.cssCoverageComplete);
  return {
    scopeComplete: true,
    cssCoverageComplete,
    stylesheetsTotal: routes.reduce((sum, route) => sum + route.stylesheetsTotal, 0),
    stylesheetsReadable: routes.reduce((sum, route) => sum + route.stylesheetsReadable, 0),
    stylesheetsUnreadable: routes.reduce((sum, route) => sum + route.stylesheetsUnreadable, 0),
    routeCount: routes.length,
    routes,
    runtimeClassUnion,
    compiledClassUnion,
    deadClasses: routeScopedDeadClasses,
    candidateDeadClasses,
    // This is intentionally a separate value: route A's CSS is never used as
    // route B's answer, even when the union happens to contain the class.
    unionOnlyDeadClasses: cssCoverageComplete ? runtimeClassUnion.filter((name) => !new Set(compiledClassUnion).has(name)) : [],
  };
}

export function findingsForDeadClasses(audit, { runId, artifact = 'measurements/classes.json' } = {}) {
  return audit.routes.flatMap((route, routeIndex) => route.cssCoverageComplete ? route.deadClasses.map((className, classIndex) => ({
    category: 'dead-runtime-class',
    subject: { route: route.route, className },
    status: 'open',
    evidence: { runId: runId ?? null, artifact, locator: `#/routes/${routeIndex}/deadClasses/${classIndex}` },
  })) : []);
}

export function auditDeadRuntimeClasses(observations, options = {}) {
  const audit = aggregateClassObservations(observations);
  return {
    kind: 'dead-class-audit',
    schemaVersion: 1,
    runId: options.runId ?? null,
    scope: options.scope ?? 'requested-routes',
    ...audit,
    findings: findingsForDeadClasses(audit, options),
  };
}
