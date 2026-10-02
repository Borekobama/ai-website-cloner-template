import { canonicalJson, sha256 } from './run-store.mjs';
import { redactForPersistence } from './redact.mjs';

export const ARIA_SCHEMA_VERSION = 1;

const LANDMARK_ROLES = new Set(['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'region', 'form', 'search']);
// Accessible values of editable controls can hold typed user data.
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
const NAME_LIMIT = 160;
const TEXT_LIMIT = 160;
const NODE_LIMIT = 5000;
const OUTLINE_LIMIT = 200;
const LINE_PATTERN = /^(\s*)- (.*)$/u;
const QUOTED_LINE = /^'((?:[^']|'')*)'(:?)$/u;
const NODE_PATTERN = /^([a-z][a-z0-9-]*)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(?::(?: (.*))?)?$/u;

function unwrapYamlQuotes(content) {
  // Playwright single-quotes entries that contain YAML-significant characters.
  const quoted = QUOTED_LINE.exec(content);
  return quoted ? `${quoted[1].replace(/''/gu, "'")}${quoted[2]}` : content;
}

export function parseAriaSnapshot(text) {
  const nodes = [];
  for (const line of String(text ?? '').split('\n')) {
    const lineMatch = LINE_PATTERN.exec(line);
    if (!lineMatch) continue;
    const content = unwrapYamlQuotes(lineMatch[2]);
    // Properties such as /url and /placeholder describe the parent node.
    if (content.startsWith('/')) continue;
    const match = NODE_PATTERN.exec(content);
    if (!match) continue;
    const attributes = {};
    for (const attribute of match[3].matchAll(/\[([^\]=]+)(?:=([^\]]*))?\]/gu)) {
      attributes[attribute[1]] = attribute[2] ?? true;
    }
    const role = match[1];
    nodes.push({
      depth: lineMatch[1].length / 2,
      role,
      name: match[2] === undefined ? null : match[2].replace(/\\(.)/gu, '$1').slice(0, NAME_LIMIT),
      attributes,
      text: VALUE_ROLES.has(role) || match[4] === undefined ? null : match[4].slice(0, TEXT_LIMIT),
    });
  }
  return nodes;
}

export function ariaOutline(nodes) {
  return nodes
    .filter((node) => LANDMARK_ROLES.has(node.role) || node.role === 'heading')
    .slice(0, OUTLINE_LIMIT)
    .map((node) => ({
      role: node.role,
      ...(node.role === 'heading' ? { level: Number(node.attributes.level) || null } : {}),
      name: node.name,
    }));
}

export function ariaRoleCounts(nodes) {
  const counts = new Map();
  for (const node of nodes) {
    if (node.role === 'text') continue;
    counts.set(node.role, (counts.get(node.role) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export async function captureAria(page, { route, timeout = 10000 } = {}) {
  try {
    const snapshot = await page.locator('body').ariaSnapshot({ timeout });
    const nodes = parseAriaSnapshot(snapshot);
    const outline = ariaOutline(nodes);
    const roleCounts = ariaRoleCounts(nodes);
    const evidence = redactForPersistence({
      schemaVersion: ARIA_SCHEMA_VERSION,
      kind: 'aria-observation',
      route,
      capturedAt: new Date().toISOString(),
      nodeCount: nodes.length,
      truncated: nodes.length > NODE_LIMIT,
      nodes: nodes.slice(0, NODE_LIMIT),
      outline,
      roleCounts,
      complete: true,
    });
    return { ...evidence, fingerprint: sha256(canonicalJson({ nodes: evidence.nodes, outline: evidence.outline, roleCounts: evidence.roleCounts })) };
  } catch (error) {
    return redactForPersistence({
      schemaVersion: ARIA_SCHEMA_VERSION,
      kind: 'aria-observation',
      route,
      capturedAt: new Date().toISOString(),
      nodeCount: 0,
      truncated: false,
      nodes: [],
      outline: [],
      roleCounts: {},
      complete: false,
      failure: error instanceof Error ? error.message : String(error),
    });
  }
}

export function ariaIndexEntry(observation, artifactPath) {
  return {
    route: observation.route,
    artifactPath,
    fingerprint: observation.fingerprint ?? null,
    complete: observation.complete === true,
    nodeCount: observation.nodeCount ?? 0,
    outline: observation.outline ?? [],
    roleCounts: observation.roleCounts ?? {},
  };
}

function routeMap(value) {
  return new Map((value?.routes ?? []).map((entry, index) => [entry.route, { entry, index }]));
}

function outlineShape(outline = []) {
  return outline.map((entry) => (entry.role === 'heading' ? `heading:${entry.level ?? ''}` : entry.role));
}

const PRESENCE_COMPARATOR = { instrument: 'aria', evidenceClass: 'aria-presence', dimension: 'presence', mode: 'informational' };
const OUTLINE_COMPARATOR = { instrument: 'aria', evidenceClass: 'aria-outline', dimension: 'outline', mode: 'gate' };
const NAMES_COMPARATOR = { instrument: 'aria', evidenceClass: 'aria-names', dimension: 'names', mode: 'informational' };
const ROLES_COMPARATOR = { instrument: 'aria', evidenceClass: 'aria-roles', dimension: 'roles', mode: 'informational' };

function presenceState(value) {
  if (!value) return 'missing';
  return value.entry.complete ? 'captured' : 'incomplete';
}

export function compareAriaEvidence(source, clone, sourceRunId, cloneRunId) {
  if (!source && !clone) return { findings: [], comparatorCoverage: [], coverage: { configured: false, complete: true, routesCompared: 0 } };
  if (!source || !clone) {
    const indexEvidence = (runId, value) => (value ? { runId, artifact: 'measurements/aria.json', locator: '#' } : null);
    return {
      findings: [{
        category: 'aria-incomplete',
        subject: { route: null },
        status: 'informational',
        policy: { dimension: 'presence', mode: 'informational' },
        comparator: PRESENCE_COMPARATOR,
        observed: { source: source ? 'captured' : 'missing', clone: clone ? 'captured' : 'missing' },
        evidence: { source: indexEvidence(sourceRunId, source), clone: indexEvidence(cloneRunId, clone) },
      }],
      comparatorCoverage: [{ comparator: PRESENCE_COMPARATOR, subject: { route: null }, complete: false }],
      coverage: { configured: true, complete: false, reason: 'one-sided-aria-evidence', routesCompared: 0 },
    };
  }
  const findings = [];
  const comparatorCoverage = [];
  const routeEvidence = (runId, value, locator) => (value ? { runId, artifact: 'measurements/aria.json', locator: `#/routes/${value.index}${locator}` } : null);
  const sourceRoutes = routeMap(source);
  const cloneRoutes = routeMap(clone);
  const routes = [...new Set([...sourceRoutes.keys(), ...cloneRoutes.keys()])];
  let routesCompared = 0;
  for (const route of routes) {
    const sourceRoute = sourceRoutes.get(route);
    const cloneRoute = cloneRoutes.get(route);
    const subject = { route };
    const complete = Boolean(sourceRoute?.entry.complete && cloneRoute?.entry.complete);
    for (const comparator of [PRESENCE_COMPARATOR, OUTLINE_COMPARATOR, NAMES_COMPARATOR, ROLES_COMPARATOR]) comparatorCoverage.push({ comparator, subject, complete });
    if (!complete) {
      findings.push({
        category: 'aria-incomplete',
        subject,
        status: 'informational',
        policy: { dimension: 'presence', mode: 'informational' },
        comparator: PRESENCE_COMPARATOR,
        observed: { source: presenceState(sourceRoute), clone: presenceState(cloneRoute) },
        evidence: { source: routeEvidence(sourceRunId, sourceRoute, ''), clone: routeEvidence(cloneRunId, cloneRoute, '') },
      });
      continue;
    }
    routesCompared += 1;
    const sourceOutline = sourceRoute.entry.outline ?? [];
    const cloneOutline = cloneRoute.entry.outline ?? [];
    const sourceShape = outlineShape(sourceOutline);
    const cloneShape = outlineShape(cloneOutline);
    if (canonicalJson(sourceShape) !== canonicalJson(cloneShape)) {
      findings.push({
        category: 'aria-outline-mismatch',
        subject,
        status: 'open',
        policy: { dimension: 'outline', mode: 'gate' },
        comparator: OUTLINE_COMPARATOR,
        observed: { source: sourceShape, clone: cloneShape },
        evidence: { source: routeEvidence(sourceRunId, sourceRoute, '/outline'), clone: routeEvidence(cloneRunId, cloneRoute, '/outline') },
      });
    } else if (canonicalJson(sourceOutline) !== canonicalJson(cloneOutline)) {
      findings.push({
        category: 'aria-name-mismatch',
        subject,
        status: 'informational',
        policy: { dimension: 'names', mode: 'informational' },
        comparator: NAMES_COMPARATOR,
        observed: { source: sourceOutline, clone: cloneOutline },
        evidence: { source: routeEvidence(sourceRunId, sourceRoute, '/outline'), clone: routeEvidence(cloneRunId, cloneRoute, '/outline') },
      });
    }
    if (canonicalJson(sourceRoute.entry.roleCounts ?? {}) !== canonicalJson(cloneRoute.entry.roleCounts ?? {})) {
      findings.push({
        category: 'aria-role-count-mismatch',
        subject,
        status: 'informational',
        policy: { dimension: 'roles', mode: 'informational' },
        comparator: ROLES_COMPARATOR,
        observed: { source: sourceRoute.entry.roleCounts, clone: cloneRoute.entry.roleCounts },
        evidence: { source: routeEvidence(sourceRunId, sourceRoute, '/roleCounts'), clone: routeEvidence(cloneRunId, cloneRoute, '/roleCounts') },
      });
    }
  }
  return {
    findings,
    comparatorCoverage,
    coverage: {
      configured: true,
      complete: source.complete === true && clone.complete === true && routesCompared === routes.length,
      sourceRoutes: sourceRoutes.size,
      cloneRoutes: cloneRoutes.size,
      routesCompared,
    },
  };
}
