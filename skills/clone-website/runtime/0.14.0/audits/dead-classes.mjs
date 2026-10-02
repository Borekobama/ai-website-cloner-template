function unescapeCssIdentifier(value) {
  return value
    .replace(/\\([0-9a-f]{1,6})\s?/giu, (_, codePoint) => String.fromCodePoint(Number.parseInt(codePoint, 16)))
    .replace(/\\([^\n])/gu, '$1');
}

// A CSS escape is a hex code point with one optional trailing whitespace
// character (`.\32 xl\:p-4` is the class "2xl:p-4"), or any other escaped
// character. Non-ASCII characters are name characters without escaping.
const CSS_ESCAPE = String.raw`\\[0-9a-fA-F]{1,6}[ \t\n\r\f]?|\\[^\n\r\f0-9a-fA-F]`;
const CLASS_PATTERN = new RegExp(String.raw`\.((?:--|-?(?:${CSS_ESCAPE}|[A-Za-z_]|[^\x00-\x7F]))(?:${CSS_ESCAPE}|[A-Za-z0-9_-]|[^\x00-\x7F])*)`, 'gu');

export function classNamesFromCss(cssText) {
  if (typeof cssText !== 'string') return [];
  const classes = new Set();
  // A colon that is escaped belongs to the class name (for example a
  // Tailwind variant); an unescaped colon starts a pseudo-class and must not
  // become part of the runtime class name.
  for (const match of cssText.matchAll(CLASS_PATTERN)) {
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

// Splits a Tailwind-style class into variants and utility on top-level colons;
// colons inside arbitrary values such as data-[state=open] stay intact.
export function splitVariantClass(className) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const character of String(className)) {
    if (character === '[' || character === '(') depth += 1;
    else if ((character === ']' || character === ')') && depth > 0) depth -= 1;
    if (character === ':' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  if (parts.length < 2 || parts.some((part) => !part)) return null;
  return { variants: parts.slice(0, -1), utility: parts.at(-1).replace(/^!|!$/gu, '') };
}

// A space inside an arbitrary value (for example a data-URI in bg-[url(...)])
// splits one class into several tokens: one with an unclosed bracket and others
// with markup or URL-encoded quotes outside any bracket.
export function isSplitArbitraryValue(className) {
  let depth = 0;
  let outside = '';
  for (const character of String(className)) {
    if (character === '[' || character === '(') depth += 1;
    else if (character === ']' || character === ')') depth -= 1;
    else if (depth === 0) outside += character;
    if (depth < 0) return true;
  }
  return depth !== 0 || /%22|%27|[<>="']/u.test(outside);
}

// A dead variant class whose utility compiles elsewhere on the route points at
// the variant. When no compiled class uses that variant at all, the variant is
// most likely never defined; otherwise this class was likely built dynamically.
export function deadClassDetail(className, compiledClasses) {
  if (isSplitArbitraryValue(className)) {
    return {
      className,
      reason: 'split-arbitrary-value',
      hint: 'A space inside an arbitrary value split it into several classes. Use underscores instead of spaces, or move the value into CSS.',
    };
  }
  const parsed = splitVariantClass(className);
  if (!parsed || !compiledClasses.has(parsed.utility)) return { className, reason: 'missing-css' };
  const compiledVariants = new Set();
  for (const compiled of compiledClasses) {
    for (const variant of splitVariantClass(compiled)?.variants ?? []) compiledVariants.add(variant);
  }
  const undefinedVariants = parsed.variants.filter((variant) => !compiledVariants.has(variant));
  return undefinedVariants.length
    ? { className, reason: 'undefined-variant', variants: undefinedVariants, utility: parsed.utility }
    : { className, reason: 'variant-class-not-generated', variants: parsed.variants, utility: parsed.utility };
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
      deadClassDetails: deadClasses.map((className) => deadClassDetail(className, compiledSet)),
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
    detail: route.deadClassDetails?.[classIndex] ?? null,
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
