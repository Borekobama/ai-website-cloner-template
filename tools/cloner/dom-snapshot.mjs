import { canonicalJson, sha256 } from './run-store.mjs';
import { redactForPersistence, safeUrl } from './redact.mjs';

export const DOM_SNAPSHOT_SCHEMA_VERSION = 1;

const COMPUTED_STYLES = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'width', 'height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'box-sizing', 'overflow', 'z-index', 'opacity', 'visibility', 'transform',
  'transform-origin', 'color', 'background-color', 'font-family', 'font-size',
  'font-weight', 'line-height', 'letter-spacing', 'white-space',
];

const SENSITIVE_FIELD = /(?:auth|credential|csrf|key|pass|secret|session|signature|token)/iu;

function stringAt(strings, index) {
  return Number.isInteger(index) ? strings[index] : index;
}

function markReplacement(index, replacements) {
  if (!Number.isInteger(index)) return '[REDACTED]';
  replacements.add(index);
  return index;
}

function redactSensitiveFields(snapshot) {
  const strings = snapshot.strings ?? [];
  const originalStrings = [...strings];
  const replacements = new Set();
  const sensitiveNodeIndices = new Map();
  for (const document of snapshot.documents ?? []) {
    const nodes = document.nodes ?? {};
    const nodeNames = nodes.nodeName ?? [];
    const attributes = nodes.attributes ?? [];
    for (let index = 0; index < nodeNames.length; index += 1) {
      const nodeName = String(stringAt(originalStrings, nodeNames[index]) ?? '').toLowerCase();
      const pairs = attributes[index] ?? [];
      const fields = new Map();
      const visitPair = (pair, valueIndex) => {
        const name = String(stringAt(originalStrings, pair[0]) ?? '').toLowerCase();
        fields.set(name, stringAt(originalStrings, pair[valueIndex]));
        if ((name === 'value' && (nodeName === 'input' || nodeName === 'textarea')) || SENSITIVE_FIELD.test(name)) {
          pair[valueIndex] = markReplacement(pair[valueIndex], replacements);
        }
      };
      if (Array.isArray(pairs[0])) {
        for (const pair of pairs) {
          if (Array.isArray(pair) && pair.length >= 2) visitPair(pair, 1);
        }
      } else {
        for (let pairIndex = 0; pairIndex + 1 < pairs.length; pairIndex += 2) visitPair(pairs, pairIndex + 1);
      }
      const type = String(fields.get('type') ?? '').toLowerCase();
      const sensitiveInput = nodeName === 'input' || nodeName === 'textarea';
      const hiddenInput = type === 'hidden' || type === 'password' || SENSITIVE_FIELD.test(String(fields.get('name') ?? ''));
      if (sensitiveInput || hiddenInput) sensitiveNodeIndices.set(index, true);
    }
    for (const field of ['inputValue', 'textValue']) {
      const data = nodes[field];
      if (!data) continue;
      if (Array.isArray(data)) {
        for (const [index, value] of data.entries()) {
          if (sensitiveNodeIndices.has(index) && value !== undefined) data[index] = markReplacement(value, replacements);
        }
      } else {
        for (const [valueIndex, nodeIndex] of (data.index ?? []).entries()) {
          if (sensitiveNodeIndices.has(nodeIndex) && data.value?.[valueIndex] !== undefined) {
            data.value[valueIndex] = markReplacement(data.value[valueIndex], replacements);
          }
        }
      }
    }
  }
  for (const index of replacements) {
    if (index >= 0 && index < strings.length) strings[index] = '[REDACTED]';
  }
  return snapshot;
}

function snapshotSummary(snapshot) {
  const documents = snapshot.documents ?? [];
  const nodeCount = documents.reduce((total, document) => total + (document.nodes?.nodeName?.length ?? 0), 0);
  const layoutCount = documents.reduce((total, document) => total + (document.layout?.nodeIndex?.length ?? 0), 0);
  return {
    documents: documents.length,
    nodes: nodeCount,
    layoutNodes: layoutCount,
    strings: snapshot.strings?.length ?? 0,
  };
}

function snapshotString(strings, value) {
  return Number.isInteger(value) ? strings[value] ?? '' : value ?? '';
}

function nodeAttributes(attributes, strings) {
  const result = new Map();
  if (!Array.isArray(attributes)) return result;
  if (Array.isArray(attributes[0])) {
    for (const pair of attributes) {
      if (Array.isArray(pair) && pair.length >= 2) result.set(String(snapshotString(strings, pair[0])).toLowerCase(), snapshotString(strings, pair[1]));
    }
  } else {
    for (let index = 0; index + 1 < attributes.length; index += 2) {
      result.set(String(snapshotString(strings, attributes[index])).toLowerCase(), snapshotString(strings, attributes[index + 1]));
    }
  }
  return result;
}

function sortedCounts(counts) {
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function structureSummary(snapshot) {
  const tagCounts = new Map();
  const roleCounts = new Map();
  const componentCounts = new Map();
  const repeatedStructures = new Map();
  const geometryByKind = new Map();
  let elements = 0;
  let maxDepth = 0;
  let layoutNodes = 0;
  const strings = snapshot.strings ?? [];
  const semanticTags = new Set(['aside', 'dialog', 'form', 'header', 'main', 'nav', 'ol', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'ul']);
  for (const document of snapshot.documents ?? []) {
    const nodes = document.nodes ?? {};
    const names = nodes.nodeName ?? [];
    const parents = nodes.parentIndex ?? [];
    const tags = names.map((value) => String(snapshotString(strings, value)).toLowerCase());
    const included = new Set();
    for (let index = 0; index < names.length; index += 1) {
      let current = index;
      while (Number.isInteger(current) && current >= 0 && current < names.length) {
        if (tags[current] === 'body') {
          included.add(index);
          break;
        }
        current = parents[current];
      }
    }
    if (included.size === 0) names.forEach((_, index) => included.add(index));
    const children = names.map(() => []);
    const depths = names.map(() => 0);
    for (let index = 0; index < names.length; index += 1) {
      const parent = parents[index];
      if (Number.isInteger(parent) && parent >= 0 && parent < names.length) {
        children[parent].push(index);
        depths[index] = depths[parent] + 1;
      }
      if (included.has(index)) maxDepth = Math.max(maxDepth, depths[index]);
    }
    const roles = names.map((_, index) => String(nodeAttributes(nodes.attributes?.[index], strings).get('role') ?? '').toLowerCase());
    for (let index = 0; index < names.length; index += 1) {
      if (!included.has(index)) continue;
      const tag = tags[index];
      if (!tag || tag.startsWith('#')) continue;
      elements += 1;
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      const role = roles[index];
      if (role) roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
      const componentKind = role || (semanticTags.has(tag) ? tag : null);
      if (componentKind) componentCounts.set(componentKind, (componentCounts.get(componentKind) ?? 0) + 1);
      const childTags = children[index].map((child) => tags[child]).filter((child) => child && !child.startsWith('#'));
      if (childTags.length > 0) {
        const key = canonicalJson({ tag, role: role || null, childTags });
        const current = repeatedStructures.get(key) ?? { tag, role: role || null, childTags, count: 0 };
        current.count += 1;
        repeatedStructures.set(key, current);
      }
    }
    const layout = document.layout ?? {};
    for (let index = 0; index < (layout.nodeIndex ?? []).length; index += 1) {
      const nodeIndex = layout.nodeIndex[index];
      if (!included.has(nodeIndex)) continue;
      const tag = tags[nodeIndex];
      if (!tag || tag.startsWith('#')) continue;
      layoutNodes += 1;
      const role = roles[nodeIndex] || null;
      const key = `${tag}|${role ?? ''}`;
      const bounds = layout.bounds?.[index];
      const dimensions = Array.isArray(bounds) && bounds.length >= 4
        ? [Math.round(Number(bounds[2]) || 0), Math.round(Number(bounds[3]) || 0)]
        : null;
      const current = geometryByKind.get(key) ?? { tag, role, count: 0, dimensions: [] };
      current.count += 1;
      if (dimensions) current.dimensions.push(dimensions);
      geometryByKind.set(key, current);
    }
  }
  const repeated = [...repeatedStructures.values()]
    .filter((entry) => entry.count > 1)
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
    .slice(0, 50);
  const geometry = [...geometryByKind.values()]
    .map((entry) => ({ ...entry, dimensions: entry.dimensions.sort(([leftWidth, leftHeight], [rightWidth, rightHeight]) => leftWidth - rightWidth || leftHeight - rightHeight).slice(0, 50) }))
    .sort((left, right) => `${left.tag}|${left.role ?? ''}`.localeCompare(`${right.tag}|${right.role ?? ''}`));
  return {
    schemaVersion: 1,
    elements,
    maxDepth,
    layoutNodes,
    tagCounts: sortedCounts(tagCounts),
    roleCounts: sortedCounts(roleCounts),
    componentCounts: sortedCounts(componentCounts),
    repeatedStructures: repeated,
    geometryByKind: geometry,
  };
}

export async function captureDomSnapshot(page, { route } = {}) {
  let client;
  try {
    client = await page.context().newCDPSession(page);
    const raw = await client.send('DOMSnapshot.captureSnapshot', {
      computedStyles: COMPUTED_STYLES,
      includePaintOrder: true,
      includeDOMRects: true,
      includeBlendedBackgroundColors: true,
      includeTextColorOpacities: true,
    });
    const snapshot = redactSensitiveFields(redactForPersistence(raw));
    const evidence = redactForPersistence({
      schemaVersion: DOM_SNAPSHOT_SCHEMA_VERSION,
      kind: 'dom-snapshot-observation',
      route,
      url: safeUrl(page.url()),
      summary: snapshotSummary(snapshot),
      structure: structureSummary(snapshot),
      snapshot,
    });
    return {
      ...evidence,
      capturedAt: new Date().toISOString(),
      fingerprint: sha256(canonicalJson(evidence)),
    };
  } catch (error) {
    throw new Error(`DOMSnapshot capture failed on ${route}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (client?.detach) await client.detach().catch(() => {});
  }
}

function snapshotRouteMap(value) {
  return new Map((value?.routes ?? []).map((entry) => [entry.route, entry]));
}

function structureValues(structure) {
  return {
    elements: structure?.elements ?? null,
    maxDepth: structure?.maxDepth ?? null,
    layoutNodes: structure?.layoutNodes ?? null,
    tagCounts: structure?.tagCounts ?? null,
    roleCounts: structure?.roleCounts ?? null,
    componentCounts: structure?.componentCounts ?? null,
    repeatedStructures: structure?.repeatedStructures ?? null,
  };
}

export function compareDomSnapshotStructure(source, clone, sourceRunId, cloneRunId) {
  if (!source && !clone) return { findings: [], comparatorCoverage: [], coverage: { configured: false, complete: false, routesCompared: 0 } };
  const sourceRoutes = snapshotRouteMap(source);
  const cloneRoutes = snapshotRouteMap(clone);
  const findings = [];
  const comparatorCoverage = [];
  const structureComparator = { instrument: 'dom-snapshot', evidenceClass: 'dom-structure', dimension: 'structure', mode: 'gate' };
  const geometryComparator = { instrument: 'dom-snapshot', evidenceClass: 'dom-geometry', dimension: 'geometry', mode: 'informational' };
  const routes = [...new Set([...sourceRoutes.keys(), ...cloneRoutes.keys()])];
  for (const route of routes) {
    const sourceRoute = sourceRoutes.get(route);
    const cloneRoute = cloneRoutes.get(route);
    const sourceStructure = sourceRoute?.structure;
    const cloneStructure = cloneRoute?.structure;
    const subject = { route };
    const complete = Boolean(sourceStructure && cloneStructure);
    comparatorCoverage.push({ comparator: structureComparator, subject, complete });
    if (!complete) continue;
    if (canonicalJson(structureValues(sourceStructure)) !== canonicalJson(structureValues(cloneStructure))) {
      findings.push({
        category: 'dom-structure-mismatch',
        subject,
        status: 'open',
        policy: { dimension: 'structure', mode: 'gate' },
        comparator: structureComparator,
        observed: { source: structureValues(sourceStructure), clone: structureValues(cloneStructure) },
        evidence: {
          source: { runId: sourceRunId, artifact: 'measurements/dom-snapshots.json', locator: `#/routes/${source.routes.indexOf(sourceRoute)}/structure` },
          clone: { runId: cloneRunId, artifact: 'measurements/dom-snapshots.json', locator: `#/routes/${clone.routes.indexOf(cloneRoute)}/structure` },
        },
      });
    }
    const sourceGeometry = sourceStructure.geometryByKind ?? [];
    const cloneGeometry = cloneStructure.geometryByKind ?? [];
    const geometryComplete = Array.isArray(sourceGeometry) && Array.isArray(cloneGeometry);
    comparatorCoverage.push({ comparator: geometryComparator, subject, complete: geometryComplete });
    if (geometryComplete && canonicalJson(sourceGeometry) !== canonicalJson(cloneGeometry)) {
      findings.push({
        category: 'dom-geometry-mismatch',
        subject,
        status: 'informational',
        policy: { dimension: 'geometry', mode: 'informational' },
        comparator: geometryComparator,
        observed: { source: sourceGeometry, clone: cloneGeometry },
        evidence: {
          source: { runId: sourceRunId, artifact: 'measurements/dom-snapshots.json', locator: `#/routes/${source.routes.indexOf(sourceRoute)}/structure/geometryByKind` },
          clone: { runId: cloneRunId, artifact: 'measurements/dom-snapshots.json', locator: `#/routes/${clone.routes.indexOf(cloneRoute)}/structure/geometryByKind` },
        },
      });
    }
  }
  return {
    findings,
    comparatorCoverage,
    coverage: {
      configured: true,
      complete: routes.length > 0 && comparatorCoverage.filter((entry) => entry.comparator === structureComparator).every((entry) => entry.complete),
      routesCompared: comparatorCoverage.filter((entry) => entry.comparator === structureComparator && entry.complete).length,
      geometryRoutesCompared: comparatorCoverage.filter((entry) => entry.comparator === geometryComparator && entry.complete).length,
    },
  };
}

export function domSnapshotCoverage(value, expectedRoutes = null) {
  const capturedRoutes = [...new Set((value?.routes ?? []).map((route) => route.route).filter(Boolean))];
  const expected = expectedRoutes ? [...new Set(expectedRoutes.filter(Boolean))] : null;
  const missingRoutes = expected ? expected.filter((route) => !capturedRoutes.includes(route)) : [];
  const unexpectedRoutes = expected ? capturedRoutes.filter((route) => !expected.includes(route)) : [];
  return {
    configured: Boolean(value),
    complete: Boolean(value?.complete && (!expected || (missingRoutes.length === 0 && unexpectedRoutes.length === 0))),
    routesCaptured: capturedRoutes.length,
    capturedRoutes,
    ...(expected ? { expectedRoutes: expected, missingRoutes, unexpectedRoutes, routesMatch: missingRoutes.length === 0 && unexpectedRoutes.length === 0 } : {}),
  };
}

export { COMPUTED_STYLES };
