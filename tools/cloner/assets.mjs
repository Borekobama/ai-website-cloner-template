import { canonicalJson, readArtifact, sha256 } from './run-store.mjs';
import { redactForPersistence, safeUrl } from './redact.mjs';

export const ASSET_SCHEMA_VERSION = 1;
export const MAX_ASSET_HASH_BYTES = 8 * 1024 * 1024;

const ASSET_RESOURCE_TYPES = new Set(['image', 'stylesheet', 'font', 'media', 'manifest', 'script']);
const ASSET_MIME_TYPES = /^(?:image|audio|video|font)\//iu;
const ASSET_MIME_EXACT = new Set(['text/css', 'application/manifest+json', 'application/vnd.apple.mpegurl', 'application/dash+xml']);
const URL_PATTERN = /url\(\s*(['"]?)(.*?)\1\s*\)/giu;
const SOURCE_ATTRIBUTES = [
  ['src', 'source'],
  ['currentSrc', 'source'],
  ['poster', 'poster'],
  ['data-src', 'lazy-source'],
  ['data-lazy-src', 'lazy-source'],
  ['data-background-image', 'background'],
  ['data-lottie', 'lottie'],
];

function mimeType(headers = {}) {
  return String(headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() || null;
}

function responseBytes(headers = {}) {
  const value = Number.parseInt(headers['content-length'] ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function firstRedirectUrl(request) {
  let current = request;
  let first = null;
  while (current) {
    first = current.url();
    current = current.redirectedFrom();
  }
  return first;
}

function isUsefulAsset(resourceType, mime) {
  return ASSET_RESOURCE_TYPES.has(resourceType)
    || ASSET_MIME_TYPES.test(mime ?? '')
    || ASSET_MIME_EXACT.has(mime);
}

function normalizeAssetUrl(value, baseUrl = null) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('javascript:')) return null;
  try {
    return new URL(raw, baseUrl || undefined).toString();
  } catch {
    return raw;
  }
}

function assetReferenceKey(reference) {
  return [reference.kind, reference.locator, reference.attribute, reference.index ?? 0].join('|');
}

function responseAssetKey(asset) {
  return [asset.finalUrl ?? asset.requestUrl ?? asset.url, asset.status, asset.mime, asset.resourceType].join('|');
}

function parseReferences(raw = []) {
  const references = new Map();
  for (const reference of raw) {
    const url = normalizeAssetUrl(reference.url, reference.baseUrl);
    if (!url) continue;
    const normalized = {
      kind: reference.kind || 'asset',
      url,
      locator: reference.locator || '#',
      attribute: reference.attribute || null,
      descriptor: reference.descriptor || null,
      index: reference.index ?? 0,
    };
    references.set(assetReferenceKey(normalized), normalized);
  }
  return [...references.values()].sort((left, right) => assetReferenceKey(left).localeCompare(assetReferenceKey(right)));
}

export async function collectAssetReferences(page) {
  const raw = await page.evaluate(({ sourceAttributes, urlPattern }) => {
    const references = [];
    const add = (kind, url, element, attribute, index = 0, descriptor = null) => {
      if (!url || typeof url !== 'string') return;
      references.push({ kind, url, baseUrl: document.baseURI, locator: selectorFor(element), attribute, index, descriptor });
    };
    const selectorFor = (element) => {
      if (element.id) return `#${element.id.slice(0, 120)}`;
      const testId = element.getAttribute('data-testid');
      if (testId) return `[data-testid="${testId.slice(0, 120)}"]`;
      return element.tagName.toLowerCase();
    };
    const srcset = (value, element, attribute) => String(value || '').split(',').map((candidate) => candidate.trim()).filter(Boolean).forEach((candidate, index) => {
      const parts = candidate.split(/\s+/u);
      add('image', parts[0], element, attribute, index, parts.slice(1).join(' ') || null);
    });
    for (const element of [...document.querySelectorAll('*')]) {
      for (const [attribute, kind] of sourceAttributes) {
        if (attribute === 'currentSrc') {
          if (element.currentSrc) add(kind, element.currentSrc, element, attribute);
        } else if (element.hasAttribute(attribute)) {
          add(kind, element.getAttribute(attribute), element, attribute);
        }
      }
      for (const attribute of ['srcset', 'data-srcset', 'data-lazy-srcset']) {
        if (element.hasAttribute(attribute)) srcset(element.getAttribute(attribute), element, attribute);
      }
      if (element.tagName === 'LINK' && /(?:^|\s)(?:icon|apple-touch-icon|mask-icon|preload)(?:\s|$)/iu.test(element.getAttribute('rel') || '')) {
        add('link', element.getAttribute('href'), element, 'href');
      }
      const inlineStyle = element.getAttribute('style') || '';
      for (const match of inlineStyle.matchAll(new RegExp(urlPattern, 'giu'))) add('css-url', match[2], element, 'style');
      const computed = getComputedStyle(element);
      for (const property of ['backgroundImage', 'maskImage', 'listStyleImage', 'content']) {
        for (const match of computed[property].matchAll(new RegExp(urlPattern, 'giu'))) add('css-url', match[2], element, property);
      }
    }
    const stylesheets = [];
    let unreadable = 0;
    const visitRules = (rules, stylesheetIndex) => {
      for (const rule of [...rules]) {
        for (const match of String(rule.cssText || '').matchAll(new RegExp(urlPattern, 'giu'))) {
          references.push({ kind: 'css-url', url: match[2], baseUrl: document.baseURI, locator: `stylesheet:${stylesheetIndex}`, attribute: 'cssText', index: references.length });
        }
        try {
          if (rule.cssRules) visitRules(rule.cssRules, stylesheetIndex);
        } catch {
          unreadable += 1;
        }
      }
    };
    for (const [stylesheetIndex, sheet] of [...document.styleSheets].entries()) {
      try {
        stylesheets.push({ stylesheetIndex, source: sheet.href || 'inline', readable: true, ruleCount: sheet.cssRules.length });
        visitRules(sheet.cssRules, stylesheetIndex);
      } catch (error) {
        stylesheets.push({ stylesheetIndex, source: sheet.href || 'inline', readable: false, ruleCount: null, error: error?.name || 'unreadable-stylesheet' });
      }
    }
    return { references, stylesheets, nestedRuleFailures: unreadable };
  }, { sourceAttributes: SOURCE_ATTRIBUTES, urlPattern: URL_PATTERN.source });
  return {
    references: parseReferences(raw.references),
    stylesheets: raw.stylesheets.map((sheet) => ({ ...sheet, source: safeUrl(sheet.source) })),
    stylesheetCoverage: {
      total: raw.stylesheets.length,
      readable: raw.stylesheets.filter((sheet) => sheet.readable).length,
      unreadable: raw.stylesheets.filter((sheet) => !sheet.readable).length,
      nestedRuleFailures: raw.nestedRuleFailures,
    },
  };
}

export function createAssetTracker(page) {
  const responses = [];
  const requestFailures = [];
  const onResponse = (response) => responses.push(response);
  const onRequestFailed = (request) => {
    if (ASSET_RESOURCE_TYPES.has(request.resourceType())) {
      requestFailures.push({ requestUrl: safeUrl(firstRedirectUrl(request) || request.url()), resourceType: request.resourceType(), error: request.failure()?.errorText ?? 'request failed' });
    }
  };
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  return {
    async snapshot() {
      const assets = [];
      const failures = [];
      for (const response of responses) {
        const request = response.request();
        const headers = response.headers();
        const mime = mimeType(headers);
        const resourceType = request.resourceType();
        if (!isUsefulAsset(resourceType, mime)) continue;
        const requestUrl = firstRedirectUrl(request) || request.url();
        const finalUrl = response.url();
        const contentLength = responseBytes(headers);
        const asset = {
          requestUrl: safeUrl(requestUrl),
          finalUrl: safeUrl(finalUrl),
          status: response.status(),
          mime,
          bytes: contentLength,
          resourceType,
          initiator: {
            resourceType,
            frameUrl: safeUrl(request.frame()?.url() || null),
          },
          hashStatus: 'not-attempted',
          sha256: null,
        };
        if (response.status() >= 400) {
          asset.hashStatus = 'http-error';
        } else if (contentLength !== null && contentLength > MAX_ASSET_HASH_BYTES) {
          asset.hashStatus = 'skipped-size';
        } else {
          try {
            const body = await response.body();
            asset.bytes = body.byteLength;
            if (body.byteLength > MAX_ASSET_HASH_BYTES) asset.hashStatus = 'skipped-size';
            else {
              asset.sha256 = sha256(body);
              asset.hashStatus = 'hashed';
            }
          } catch (error) {
            asset.hashStatus = 'body-unreadable';
            asset.error = error?.name || 'body-read-failed';
            failures.push({ url: asset.finalUrl, error: asset.error });
          }
        }
        assets.push(asset);
      }
      const unique = new Map(assets.map((asset) => [responseAssetKey(asset), asset]));
      return { assets: [...unique.values()], failures, requestFailures };
    },
    stop() {
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
    },
  };
}

function linkReferences(references, assets) {
  const byUrl = new Map();
  for (const asset of assets) {
    for (const url of [asset.requestUrl, asset.finalUrl]) if (url) byUrl.set(url, asset);
  }
  return references.map((reference) => {
    const asset = byUrl.get(safeUrl(reference.url));
    return { ...reference, response: asset ? { status: asset.status, mime: asset.mime, bytes: asset.bytes, sha256: asset.sha256, hashStatus: asset.hashStatus } : null };
  });
}

export async function captureAssetManifest(page, { route, tracker } = {}) {
  try {
    const [referencesResult, responseResult] = await Promise.all([
      collectAssetReferences(page),
      tracker?.snapshot() ?? Promise.resolve({ assets: [], failures: [], requestFailures: [] }),
    ]);
    const references = linkReferences(referencesResult.references, responseResult.assets);
    const hashedResponses = responseResult.assets.filter((asset) => asset.hashStatus === 'hashed').length;
    const bodyFailures = responseResult.assets.filter((asset) => asset.hashStatus === 'body-unreadable').length;
    const stylesheetCoverage = referencesResult.stylesheetCoverage;
    const evidence = redactForPersistence({
      schemaVersion: ASSET_SCHEMA_VERSION,
      kind: 'asset-observation',
      route,
      capturedAt: new Date().toISOString(),
      assets: responseResult.assets,
      references,
      stylesheets: referencesResult.stylesheets,
      stylesheetCoverage,
      responseCoverage: {
        observed: responseResult.assets.length,
        hashed: hashedResponses,
        bodyFailures,
        httpFailures: responseResult.assets.filter((asset) => asset.status >= 400).length,
        requestFailures: responseResult.requestFailures.length,
        failedRequests: responseResult.failures.length,
      },
      complete: stylesheetCoverage.unreadable === 0 && stylesheetCoverage.nestedRuleFailures === 0 && bodyFailures === 0
        && responseResult.assets.every((asset) => asset.status < 400)
        && responseResult.requestFailures.length === 0,
    });
    return { ...evidence, fingerprint: sha256(canonicalJson(evidence)) };
  } catch (error) {
    return redactForPersistence({
      schemaVersion: ASSET_SCHEMA_VERSION,
      kind: 'asset-observation',
      route,
      capturedAt: new Date().toISOString(),
      assets: [],
      references: [],
      stylesheets: [],
      stylesheetCoverage: { total: 0, readable: 0, unreadable: 0, nestedRuleFailures: 0 },
      responseCoverage: { observed: 0, hashed: 0, bodyFailures: 0, httpFailures: 0, requestFailures: 0, failedRequests: 0 },
      complete: false,
      failure: error instanceof Error ? error.message : String(error),
    });
  }
}

export function assetIndexEntry(observation, artifactPath) {
  return {
    route: observation.route,
    artifactPath,
    fingerprint: observation.fingerprint ?? null,
    complete: observation.complete === true,
    stylesheets: observation.stylesheetCoverage ?? { total: 0, readable: 0, unreadable: 0, nestedRuleFailures: 0 },
    responses: observation.responseCoverage ?? { observed: 0, hashed: 0, bodyFailures: 0, httpFailures: 0, requestFailures: 0, failedRequests: 0 },
    references: observation.references?.length ?? 0,
  };
}

export function hydrateAssetEvidence({ root = process.cwd(), siteKey, runId, index }) {
  if (!index) return null;
  return {
    ...index,
    routes: (index.routes ?? []).map((entry) => ({
      ...entry,
      observation: JSON.parse(readArtifact(root, siteKey, runId, entry.artifactPath).toString('utf8')),
    })),
  };
}

function assetRouteMap(value) {
  return new Map((value?.routes ?? []).map((entry) => {
    const observation = entry.observation ?? entry;
    return [observation.route ?? entry.route, { entry, observation }];
  }));
}

function assetSignatures(observation) {
  return [...new Set((observation?.assets ?? [])
    .filter((asset) => asset.sha256)
    .map((asset) => `${asset.mime ?? ''}|${asset.sha256}`))].sort();
}

export function compareAssetEvidence(source, clone, sourceRunId, cloneRunId) {
  if (!source && !clone) return { findings: [], comparatorCoverage: [], coverage: { configured: false, complete: true, routesCompared: 0 } };
  if (!source || !clone) {
    const comparator = { instrument: 'assets', evidenceClass: 'asset-presence', dimension: 'presence', mode: 'informational' };
    return {
      findings: [{
        category: 'asset-manifest-incomplete',
        subject: { route: null },
        status: 'informational',
        policy: { dimension: 'presence', mode: 'informational' },
        comparator,
        observed: { source: source ? 'captured' : 'missing', clone: clone ? 'captured' : 'missing' },
        evidence: { source: source ? { runId: sourceRunId, artifact: 'measurements/assets.json', locator: '#' } : null, clone: clone ? { runId: cloneRunId, artifact: 'measurements/assets.json', locator: '#' } : null },
      }],
      comparatorCoverage: [{ comparator, subject: { route: null }, complete: false }],
      coverage: { configured: true, complete: false, routesCompared: 0 },
    };
  }
  const sourceRoutes = assetRouteMap(source);
  const cloneRoutes = assetRouteMap(clone);
  const routes = new Set([...sourceRoutes.keys(), ...cloneRoutes.keys()]);
  const findings = [];
  const comparatorCoverage = [];
  let routesCompared = 0;
  for (const route of routes) {
    const sourceRoute = sourceRoutes.get(route);
    const cloneRoute = cloneRoutes.get(route);
    const subject = { route };
    const presenceComparator = { instrument: 'assets', evidenceClass: 'asset-presence', dimension: 'presence', mode: 'informational' };
    if (!sourceRoute || !cloneRoute) {
      comparatorCoverage.push({ comparator: presenceComparator, subject, complete: false });
      findings.push({ category: 'asset-manifest-incomplete', subject, status: 'informational', policy: { dimension: 'presence', mode: 'informational' }, comparator: presenceComparator, observed: { source: sourceRoute ? 'captured' : 'missing', clone: cloneRoute ? 'captured' : 'missing' }, evidence: { source: sourceRoute ? { runId: sourceRunId, artifact: sourceRoute.entry.artifactPath, locator: '#' } : null, clone: cloneRoute ? { runId: cloneRunId, artifact: cloneRoute.entry.artifactPath, locator: '#' } : null } });
      continue;
    }
    routesCompared += 1;
    const sourceObservation = sourceRoute.observation;
    const cloneObservation = cloneRoute.observation;
    comparatorCoverage.push({ comparator: presenceComparator, subject, complete: sourceObservation.complete === true && cloneObservation.complete === true });
    if (sourceObservation.complete !== true || cloneObservation.complete !== true) {
      findings.push({ category: 'asset-manifest-incomplete', subject, status: 'informational', policy: { dimension: 'coverage', mode: 'informational' }, comparator: { instrument: 'assets', evidenceClass: 'asset-coverage', dimension: 'coverage', mode: 'informational' }, observed: { source: sourceObservation.responseCoverage, clone: cloneObservation.responseCoverage }, evidence: { source: { runId: sourceRunId, artifact: sourceRoute.entry.artifactPath, locator: '#/responseCoverage' }, clone: { runId: cloneRunId, artifact: cloneRoute.entry.artifactPath, locator: '#/responseCoverage' } } });
    }
    const sourceSignatures = assetSignatures(sourceObservation);
    const cloneSignatures = assetSignatures(cloneObservation);
    const comparator = { instrument: 'assets', evidenceClass: 'asset-content', dimension: 'hash', mode: 'informational' };
    comparatorCoverage.push({ comparator, subject, complete: sourceObservation.complete === true && cloneObservation.complete === true });
    if (canonicalJson(sourceSignatures) !== canonicalJson(cloneSignatures)) {
      findings.push({ category: 'asset-content-mismatch', subject, status: 'informational', policy: { dimension: 'hash', mode: 'informational' }, comparator, observed: { source: sourceSignatures, clone: cloneSignatures }, evidence: { source: { runId: sourceRunId, artifact: sourceRoute.entry.artifactPath, locator: '#/assets' }, clone: { runId: cloneRunId, artifact: cloneRoute.entry.artifactPath, locator: '#/assets' } } });
    }
  }
  return {
    findings,
    comparatorCoverage,
    coverage: {
      configured: true,
      complete: source.complete === true && clone.complete === true && routesCompared === routes.size && comparatorCoverage.every((entry) => entry.complete !== false || entry.comparator.mode === 'informational'),
      sourceRoutes: sourceRoutes.size,
      cloneRoutes: cloneRoutes.size,
      routesCompared,
    },
  };
}
