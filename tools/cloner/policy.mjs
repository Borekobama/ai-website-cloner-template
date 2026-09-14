import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { canonicalJson, parityRoot } from './run-store.mjs';
import { redactForPersistence } from './redact.mjs';

export const DEFAULT_POLICY = Object.freeze({
  version: 1,
  actions: [],
  controlClasses: {
    default: {
      dimensions: {
        url: 'gate',
        aria: 'gate',
        structure: 'gate',
        overlay: 'gate',
        dom: 'informational',
        style: 'informational',
        network: 'ignore',
      },
    },
  },
});

const ACTION_OUTCOMES = new Set(['allow', 'block', 'measure']);
const DIMENSION_MODES = new Set(['gate', 'informational', 'ignore']);
const DIMENSIONS = new Set(['url', 'aria', 'structure', 'overlay', 'dom', 'style', 'network']);
const MATCH_KEYS = new Set(['route', 'role', 'name', 'selector', 'controlClass', 'occurrence']);

function matchValue(expected, actual) {
  if (expected === undefined || expected === null) return true;
  if (Array.isArray(expected)) return expected.some((candidate) => matchValue(candidate, actual));
  if (expected instanceof RegExp) return expected.test(String(actual ?? ''));
  if (typeof expected === 'string' && expected.includes('*')) {
    const pattern = new RegExp(`^${expected.split('*').map(escapeRegex).join('.*')}$`, 'u');
    return pattern.test(String(actual ?? ''));
  }
  return String(expected) === String(actual ?? '');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function actionMatches(action, candidate = {}) {
  const match = action?.match ?? {};
  return Object.entries(match).every(([key, expected]) => matchValue(expected, candidate[key]));
}

function validateMatchValue(value, label, key) {
  const values = Array.isArray(value) ? value : [value];
  if (!values.length) throw new Error(`${label} must not be empty`);
  if (key === 'occurrence') {
    if (values.some((entry) => !Number.isInteger(entry) || entry < 0)) {
      throw new Error(`${label} must be a non-negative integer or non-empty array of non-negative integers`);
    }
    return;
  }
  if (values.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be a string or non-empty array of strings`);
  }
}

function normalizeActionOutcome(value, label) {
  if (value === undefined) return undefined;
  const normalized = value === 'allowed' ? 'allow' : value;
  if (!ACTION_OUTCOMES.has(normalized)) throw new Error(`${label} must be one of allow, block, or measure`);
  return normalized;
}

function normalizeAction(action, index) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error(`actions[${index}] must be an object`);
  const allowedFields = new Set(['id', 'match', 'source', 'clone', 'reason']);
  const unknownFields = Object.keys(action).filter((key) => !allowedFields.has(key));
  if (unknownFields.length) throw new Error(`Unsupported actions[${index}] field(s): ${unknownFields.join(', ')}`);
  if (!action.match || typeof action.match !== 'object' || Array.isArray(action.match) || !Object.keys(action.match).length) {
    throw new Error(`actions[${index}].match must be a non-empty object`);
  }
  const match = {};
  for (const [key, value] of Object.entries(action.match)) {
    if (!MATCH_KEYS.has(key)) throw new Error(`actions[${index}].match.${key} is not supported`);
    validateMatchValue(value, `actions[${index}].match.${key}`, key);
    match[key] = value;
  }
  if (action.id !== undefined && (typeof action.id !== 'string' || !action.id.trim())) throw new Error(`actions[${index}].id must be a non-empty string`);
  if (action.reason !== undefined && typeof action.reason !== 'string') throw new Error(`actions[${index}].reason must be a string`);
  return {
    ...(action.id ? { id: action.id } : {}),
    match,
    ...(action.source !== undefined ? { source: normalizeActionOutcome(action.source, `actions[${index}].source`) } : {}),
    ...(action.clone !== undefined ? { clone: normalizeActionOutcome(action.clone, `actions[${index}].clone`) } : {}),
    ...(action.reason ? { reason: action.reason } : {}),
  };
}

function normalizeControlClasses(controlClasses) {
  if (controlClasses === undefined) return structuredClone(DEFAULT_POLICY.controlClasses);
  if (!controlClasses || typeof controlClasses !== 'object' || Array.isArray(controlClasses)) throw new Error('controlClasses must be an object');
  const normalized = structuredClone(DEFAULT_POLICY.controlClasses);
  for (const [name, config] of Object.entries(controlClasses)) {
    if (!name) throw new Error('controlClasses keys must be non-empty strings');
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`controlClasses.${name} must be an object`);
    const unknownFields = Object.keys(config).filter((key) => key !== 'dimensions');
    if (unknownFields.length) throw new Error(`Unsupported controlClasses.${name} field(s): ${unknownFields.join(', ')}`);
    if (config.dimensions !== undefined && (!config.dimensions || typeof config.dimensions !== 'object' || Array.isArray(config.dimensions))) {
      throw new Error(`controlClasses.${name}.dimensions must be an object`);
    }
    const dimensions = {};
    for (const [dimension, mode] of Object.entries(config.dimensions ?? {})) {
      if (!DIMENSIONS.has(dimension)) throw new Error(`Unsupported control parity dimension: ${dimension}`);
      if (!DIMENSION_MODES.has(mode)) throw new Error(`controlClasses.${name}.dimensions.${dimension} must be gate, informational, or ignore`);
      dimensions[dimension] = mode;
    }
    normalized[name] = { dimensions: { ...(normalized[name]?.dimensions ?? {}), ...dimensions } };
  }
  return normalized;
}

export function loadPolicy(policyPath, root = process.cwd(), siteKey = null) {
  const defaultPath = siteKey ? resolve(parityRoot(root, siteKey), 'parity-exceptions.json') : null;
  const absolutePath = resolve(root, policyPath ?? defaultPath ?? 'parity-exceptions.json');
  if (!policyPath && !existsSync(absolutePath)) return structuredClone(DEFAULT_POLICY);
  if (!existsSync(absolutePath)) throw new Error(`Policy file not found: ${policyPath}`);
  const parsed = JSON.parse(readFileSync(absolutePath, 'utf8'));
  return normalizePolicy(parsed);
}

export function normalizePolicy(policy = {}) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('Policy must be a JSON object');
  const safePolicy = redactForPersistence(policy);
  if (safePolicy.version !== undefined && safePolicy.version !== 1) throw new Error(`Unsupported policy version: ${safePolicy.version}`);
  if (safePolicy.actions !== undefined && !Array.isArray(safePolicy.actions)) throw new Error('actions must be an array');
  const allowedTopLevel = new Set(['version', 'actions', 'controlClasses']);
  const unknown = Object.keys(safePolicy).filter((key) => !allowedTopLevel.has(key));
  if (unknown.length) throw new Error(`Unsupported policy field(s): ${unknown.join(', ')}`);
  return {
    version: 1,
    actions: (safePolicy.actions ?? []).map(normalizeAction),
    controlClasses: normalizeControlClasses(safePolicy.controlClasses),
  };
}

export function policySha256(policy) {
  return createHash('sha256').update(canonicalJson(normalizePolicy(policy))).digest('hex');
}

function matchSpecificity(expected, actual) {
  const candidates = Array.isArray(expected) ? expected : [expected];
  return Math.max(0, ...candidates
    .filter((candidate) => matchValue(candidate, actual))
    .map((candidate) => {
      if (typeof candidate !== 'string' || !candidate.includes('*')) return 1000;
      return candidate.replaceAll('*', '').length;
    }));
}

function actionSpecificity(action, candidate) {
  return Object.entries(action.match ?? {})
    .reduce((score, [key, expected]) => score + matchSpecificity(expected, candidate[key]), 0);
}

export function matchingActions(policy, candidate) {
  return normalizePolicy(policy).actions
    .filter((action) => actionMatches(action, candidate))
    .map((action) => ({ action, specificity: actionSpecificity(action, candidate) }))
    .sort((left, right) => right.specificity - left.specificity);
}

export function matchingAction(policy, candidate) {
  return matchingActions(policy, candidate)[0]?.action ?? null;
}

export function evaluateAction({ policy = DEFAULT_POLICY, target = 'clone', action = {} } = {}) {
  if (!['source', 'clone'].includes(target)) throw new Error(`target must be source or clone, received ${target}`);
  const matches = matchingActions(policy, action).filter((entry) => entry.action[target] !== undefined);
  const topSpecificity = matches[0]?.specificity ?? null;
  const mostSpecific = topSpecificity === null ? [] : matches.filter((entry) => entry.specificity === topSpecificity).map((entry) => entry.action);
  const configuredValues = new Set(mostSpecific.map((entry) => entry[target]).filter(Boolean));
  if (configuredValues.size > 1) {
    return {
      allowed: false,
      outcome: 'blocked-by-policy',
      reason: 'Conflicting equally specific safe-action policy matches',
      policyId: null,
      policyIds: mostSpecific.map((entry) => entry.id).filter(Boolean),
      conflict: true,
    };
  }
  const configured = configuredValues.values().next().value;
  const matched = mostSpecific.find((entry) => entry[target] === configured) ?? mostSpecific[0] ?? null;
  if (configured === 'block' || (target === 'source' && configured !== 'measure' && configured !== 'allow' && configured !== 'allowed')) {
    return {
      allowed: false,
      outcome: 'blocked-by-policy',
      reason: matched?.reason ?? (target === 'clone'
        ? 'Clone interaction requires an explicit safe-action policy allowance'
        : 'Source interaction requires an explicit safe-action policy allowance'),
      policyId: matched?.id ?? null,
      policyIds: mostSpecific.map((entry) => entry.id).filter(Boolean),
    };
  }
  return {
    allowed: true,
    outcome: configured === 'measure' ? 'measure-only' : 'allowed',
    reason: matched?.reason ?? null,
    policyId: matched?.id ?? null,
    policyIds: mostSpecific.map((entry) => entry.id).filter(Boolean),
  };
}

export function dimensionsForControl(policy = DEFAULT_POLICY, controlClass = 'default') {
  const normalized = normalizePolicy(policy);
  const configured = normalized.controlClasses[controlClass] ?? normalized.controlClasses.default;
  return {
    ...normalized.controlClasses.default.dimensions,
    ...(configured?.dimensions ?? {}),
  };
}

export function comparatorForDimension(dimension, source, clone) {
  if (dimension === 'ignore') return { status: 'ignored', equal: true };
  const equal = source && clone && typeof source === 'object' && typeof clone === 'object'
    ? canonicalJson(source) === canonicalJson(clone)
    : Object.is(source, clone);
  if (dimension === 'informational') return { status: 'informational', equal };
  return { status: equal ? 'match' : 'mismatch', equal };
}
