import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { canonicalJson, hashJson, sha256 } from './run-store.mjs';

export const VISUAL_SCHEMA_VERSION = 1;
const CLASSIFICATIONS = new Set(['invariant', 'data-dependent', 'transient']);
const MODES = new Set(['gate', 'informational', 'ignore']);

export function visualRoutePath(value) {
  try {
    const pathname = new URL(value, 'http://cloner.invalid').pathname || '/';
    return pathname.length > 1 ? pathname.replace(/\/$/u, '') : pathname;
  } catch {
    return value || '/';
  }
}

const boundedValue = (value, fallback, label) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a number between 0 and 1`);
  }
  return value;
};

function assertViewport(viewport, index) {
  if (!viewport || !Number.isInteger(viewport.width) || viewport.width < 1 || !Number.isInteger(viewport.height) || viewport.height < 1) {
    throw new Error(`Visual region ${index + 1} requires a positive integer viewport width and height`);
  }
  if (viewport.deviceScaleFactor !== undefined && (!Number.isFinite(viewport.deviceScaleFactor) || viewport.deviceScaleFactor <= 0)) {
    throw new Error(`Visual region ${index + 1} has invalid deviceScaleFactor`);
  }
  return {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
  };
}

function normalizeRegion(region, index) {
  if (!region || typeof region !== 'object' || Array.isArray(region)) throw new Error(`Visual region ${index + 1} must be an object`);
  const id = String(region.id ?? '');
  const route = visualRoutePath(String(region.route ?? ''));
  const selector = String(region.selector ?? '');
  const classification = String(region.classification ?? 'invariant');
  const mode = String(region.mode ?? (classification === 'invariant' ? 'gate' : 'informational'));
  if (!id || !/^[a-z0-9][a-z0-9._-]*$/iu.test(id)) throw new Error(`Visual region ${index + 1} requires a safe id`);
  if (!route.startsWith('/')) throw new Error(`Visual region ${id} requires a route`);
  if (!selector) throw new Error(`Visual region ${id} requires a selector`);
  if (!CLASSIFICATIONS.has(classification)) throw new Error(`Visual region ${id} has unsupported classification: ${classification}`);
  if (!MODES.has(mode)) throw new Error(`Visual region ${id} has unsupported policy mode: ${mode}`);
  if (mode === 'gate' && classification !== 'invariant') throw new Error(`Visual region ${id} can use gate mode only when classification is invariant`);
  const threshold = boundedValue(region.threshold, 0.001, `Visual region ${id} threshold`);
  const pixelThreshold = boundedValue(region.pixelThreshold, 0.1, `Visual region ${id} pixelThreshold`);
  let maxDiffPixels;
  if (region.maxDiffPixels !== undefined) {
    maxDiffPixels = region.maxDiffPixels;
    if (typeof maxDiffPixels !== 'number' || !Number.isInteger(maxDiffPixels) || maxDiffPixels < 0) throw new Error(`Visual region ${id} maxDiffPixels must be a non-negative integer`);
  }
  return {
    route,
    viewport: assertViewport(region.viewport, index),
    id,
    selector,
    ...(region.sourceSelector ? { sourceSelector: String(region.sourceSelector) } : {}),
    ...(region.cloneSelector ? { cloneSelector: String(region.cloneSelector) } : {}),
    classification,
    mode,
    threshold,
    pixelThreshold,
    ...(maxDiffPixels !== undefined ? { maxDiffPixels } : {}),
  };
}

export function normalizeVisualRegionConfig(value) {
  const config = typeof value === 'string' ? JSON.parse(readFileSync(value, 'utf8')) : value;
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Visual region config must be an object');
  const schemaVersion = config.schemaVersion ?? VISUAL_SCHEMA_VERSION;
  if (schemaVersion !== VISUAL_SCHEMA_VERSION) throw new Error(`Unsupported visual region schema version: ${schemaVersion}`);
  if (!Array.isArray(config.regions) || config.regions.length === 0) throw new Error('Visual region config requires a non-empty regions array');
  const regions = config.regions.map(normalizeRegion);
  const seen = new Set();
  for (const region of regions) {
    const key = `${region.route}|${region.viewport.width}|${region.viewport.height}|${region.viewport.deviceScaleFactor}|${region.id}`;
    if (seen.has(key)) throw new Error(`Duplicate visual region: ${key}`);
    seen.add(key);
  }
  return { schemaVersion, regions };
}

export function visualRegionConfigHash(config) {
  return hashJson(normalizeVisualRegionConfig(config));
}

function regionSelector(region, target) {
  return target === 'source' ? region.sourceSelector ?? region.selector : region.cloneSelector ?? region.selector;
}

function regionPath(route, id, target, suffix = 'png') {
  const routeKey = route.replace(/[^a-z0-9]+/giu, '-').replace(/^-|-$/gu, '') || 'root';
  return `measurements/visual-regions/${routeKey}/${id}.${target}.${suffix}`;
}

export function visualRegionArtifactPath(route, id, target, suffix = 'png') {
  return regionPath(route, id, target, suffix);
}

function regionObservation(region, target, extra = {}) {
  return {
    schemaVersion: VISUAL_SCHEMA_VERSION,
    id: region.id,
    route: region.route,
    target,
    classification: region.classification,
    mode: region.mode,
    threshold: region.threshold,
    pixelThreshold: region.pixelThreshold,
    ...(region.maxDiffPixels !== undefined ? { maxDiffPixels: region.maxDiffPixels } : {}),
    selector: regionSelector(region, target),
    viewport: region.viewport,
    ...extra,
  };
}

export async function captureVisualRegions(page, { config, target, route, timeout = 5000 } = {}) {
  const normalized = normalizeVisualRegionConfig(config);
  const currentRoute = visualRoutePath(route ?? new URL(page.url()).pathname);
  const regions = normalized.regions.filter((region) => region.route === currentRoute);
  if (regions.length === 0) return null;
  const pageViewport = page.viewportSize() ?? { width: 0, height: 0 };
  const viewport = { width: pageViewport.width, height: pageViewport.height, deviceScaleFactor: regions[0].viewport.deviceScaleFactor };
  const captures = [];
  for (const region of regions) {
    const selector = regionSelector(region, target);
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    const base = regionObservation(region, target, {
      actualViewport: { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor ?? 1 },
      selectorCount: count,
    });
    if (count !== 1) {
      const observation = { ...base, status: 'incomplete', reason: count === 0 ? 'missing-selector' : 'ambiguous-selector' };
      if (region.classification === 'invariant') throw new Error(`Invariant visual region ${region.id} requires exactly one match for ${selector}; found ${count}`);
      captures.push(observation);
      continue;
    }
    if (viewport.width !== region.viewport.width || viewport.height !== region.viewport.height || (viewport.deviceScaleFactor ?? 1) !== region.viewport.deviceScaleFactor) {
      const observation = { ...base, status: 'incomplete', reason: 'viewport-mismatch' };
      if (region.classification === 'invariant') throw new Error(`Invariant visual region ${region.id} requires viewport ${canonicalJson(region.viewport)}, received ${canonicalJson(base.actualViewport)}`);
      captures.push(observation);
      continue;
    }
    try {
      const image = await locator.screenshot({ animations: 'disabled', caret: 'hide', timeout });
      const decoded = PNG.sync.read(image);
      captures.push({
        ...base,
        status: 'captured',
        width: decoded.width,
        height: decoded.height,
        bytes: image.byteLength,
        sha256: sha256(image),
        artifactPath: regionPath(currentRoute, region.id, target),
        image,
      });
    } catch (error) {
      if (region.classification === 'invariant') throw new Error(`Invariant visual region ${region.id} could not be captured: ${error instanceof Error ? error.message : String(error)}`);
      captures.push({ ...base, status: 'incomplete', reason: 'capture-failed', error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    schemaVersion: VISUAL_SCHEMA_VERSION,
    kind: 'visual-region-observation',
    target,
    route: currentRoute,
    viewport: { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor ?? 1 },
    configSha256: visualRegionConfigHash(normalized),
    complete: regions.length > 0 && captures.every((capture) => capture.status === 'captured'),
    regions: captures,
  };
}

function readPng(bytes, label) {
  try {
    return PNG.sync.read(bytes);
  } catch (error) {
    throw new Error(`Invalid visual region PNG ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function compareVisualRegionImages(sourceBytes, cloneBytes, { threshold = 0.001, pixelThreshold = 0.1, maxDiffPixels = null } = {}) {
  threshold = boundedValue(threshold, 0.001, 'threshold');
  pixelThreshold = boundedValue(pixelThreshold, 0.1, 'pixelThreshold');
  if (maxDiffPixels !== null && (typeof maxDiffPixels !== 'number' || !Number.isInteger(maxDiffPixels) || maxDiffPixels < 0)) {
    throw new Error('maxDiffPixels must be a non-negative integer');
  }
  const source = readPng(sourceBytes, 'source');
  const clone = readPng(cloneBytes, 'clone');
  if (source.width !== clone.width || source.height !== clone.height) {
    return { equal: false, complete: false, reason: 'dimension-mismatch', source: { width: source.width, height: source.height }, clone: { width: clone.width, height: clone.height } };
  }
  const diff = new PNG({ width: source.width, height: source.height });
  const diffPixels = pixelmatch(source.data, clone.data, diff.data, source.width, source.height, { threshold: pixelThreshold });
  const diffRatio = source.width * source.height === 0 ? 0 : diffPixels / (source.width * source.height);
  return {
    equal: diffPixels === 0 || (maxDiffPixels !== null && diffPixels <= maxDiffPixels) || diffRatio <= threshold,
    complete: true,
    width: source.width,
    height: source.height,
    diffPixels,
    diffRatio,
    diff: PNG.sync.write(diff),
  };
}

export function visualFindingIdSubject(region) {
  return { route: region.route, regionId: region.id, viewport: region.viewport };
}
