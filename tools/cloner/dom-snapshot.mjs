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
