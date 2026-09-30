import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { canonicalJson, sha256 } from './run-store.mjs';
import { redactForPersistence, safeUrl } from './redact.mjs';

export const HEAD_SCHEMA_VERSION = 1;

// Fields that change search indexing or document semantics gate parity.
// Social previews, icons, and presentation hints stay informational.
export const HEAD_DIMENSIONS = Object.freeze([
  { field: 'title', mode: 'gate' },
  { field: 'description', mode: 'gate' },
  { field: 'robots', mode: 'gate' },
  { field: 'canonical', mode: 'gate' },
  { field: 'lang', mode: 'gate' },
  { field: 'hreflang', mode: 'gate' },
  { field: 'structuredData', mode: 'gate' },
  { field: 'social', mode: 'informational' },
  { field: 'icons', mode: 'informational' },
  { field: 'viewport', mode: 'informational' },
  { field: 'themeColor', mode: 'informational' },
]);

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function kebab(value) {
  return value.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

export function urlPath(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.pathname}${url.search}`;
  } catch {
    return String(value);
  }
}

function normalizedSocialValue(value) {
  return /^https?:\/\//iu.test(value) ? urlPath(value) : String(value).replace(/\s+/gu, ' ').trim();
}

function structuredDataTypes(value, types = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) structuredDataTypes(entry, types);
  } else if (value && typeof value === 'object') {
    const type = value['@type'];
    for (const entry of Array.isArray(type) ? type : [type]) if (typeof entry === 'string') types.add(entry);
    for (const [key, entry] of Object.entries(value)) if (key !== '@type' && entry && typeof entry === 'object') structuredDataTypes(entry, types);
  }
  return types;
}

export function normalizeHeadObservation(raw) {
  const jsonLd = (raw.jsonLd ?? []).map((text) => {
    try {
      const parsed = JSON.parse(text);
      return { valid: true, types: [...structuredDataTypes(parsed)].sort(), sha256: sha256(canonicalJson(parsed)) };
    } catch {
      return { valid: false, types: [], sha256: sha256(String(text)) };
    }
  });
  const social = {};
  for (const [key, values] of Object.entries({ ...(raw.og ?? {}), ...(raw.twitter ?? {}) }).sort(([left], [right]) => left.localeCompare(right))) {
    social[key] = values.map(normalizedSocialValue);
  }
  return {
    fields: {
      title: raw.title ? String(raw.title).replace(/\s+/gu, ' ').trim() : null,
      description: raw.description ? String(raw.description).replace(/\s+/gu, ' ').trim() : null,
      robots: raw.robots ? String(raw.robots).toLowerCase().replace(/\s+/gu, '') : null,
      canonical: urlPath(raw.canonical),
      lang: raw.lang ? String(raw.lang).toLowerCase() : null,
      hreflang: [...new Set((raw.alternates ?? []).map((entry) => `${entry.hreflang}→${urlPath(entry.href)}`))].sort(),
      structuredData: [...new Set(jsonLd.flatMap((entry) => (entry.valid ? entry.types : ['<invalid-json-ld>'])))].sort(),
      social,
      icons: [...new Set((raw.icons ?? []).map((icon) => canonicalJson({ rel: icon.rel, path: urlPath(icon.href), sizes: icon.sizes ?? null, type: icon.type ?? null })))].sort().map((value) => JSON.parse(value)),
      viewport: raw.viewport ? String(raw.viewport).replace(/\s+/gu, '') : null,
      themeColor: raw.themeColor ?? null,
    },
    jsonLd,
    urls: {
      canonical: raw.canonical ? safeUrl(raw.canonical) : null,
      alternates: (raw.alternates ?? []).map((entry) => ({ hreflang: entry.hreflang, href: safeUrl(entry.href) })),
    },
  };
}

export async function captureHead(page, { route } = {}) {
  try {
    const raw = await page.evaluate(() => {
      const meta = (selector) => document.querySelector(selector)?.getAttribute('content') ?? null;
      const metaMap = (attribute, prefix) => {
        const values = {};
        for (const element of document.querySelectorAll(`meta[${attribute}]`)) {
          const key = String(element.getAttribute(attribute)).toLowerCase();
          if (!key.startsWith(prefix)) continue;
          (values[key] ??= []).push(element.getAttribute('content') ?? '');
        }
        return values;
      };
      const links = (pattern) => [...document.querySelectorAll('link[rel]')].filter((link) => pattern.test(link.getAttribute('rel') ?? ''));
      return {
        lang: document.documentElement.getAttribute('lang'),
        title: document.title,
        description: meta('meta[name="description" i]'),
        robots: meta('meta[name="robots" i]'),
        viewport: meta('meta[name="viewport" i]'),
        themeColor: meta('meta[name="theme-color" i]'),
        canonical: links(/(?:^|\s)canonical(?:\s|$)/iu)[0]?.href ?? null,
        alternates: links(/(?:^|\s)alternate(?:\s|$)/iu)
          .filter((link) => link.hasAttribute('hreflang'))
          .map((link) => ({ hreflang: String(link.getAttribute('hreflang')).toLowerCase(), href: link.href })),
        og: metaMap('property', 'og:'),
        twitter: metaMap('name', 'twitter:'),
        jsonLd: [...document.querySelectorAll('script[type="application/ld+json" i]')].map((script) => script.textContent ?? ''),
        icons: links(/(?:^|\s)(?:icon|apple-touch-icon|mask-icon|manifest)(?:\s|$)/iu).map((link) => ({
          rel: String(link.getAttribute('rel')).toLowerCase(),
          href: link.href,
          sizes: link.getAttribute('sizes'),
          type: link.getAttribute('type'),
        })),
      };
    });
    const evidence = redactForPersistence({
      schemaVersion: HEAD_SCHEMA_VERSION,
      kind: 'head-observation',
      route,
      capturedAt: new Date().toISOString(),
      ...normalizeHeadObservation(raw),
      complete: true,
    });
    return { ...evidence, fingerprint: sha256(canonicalJson(evidence.fields)) };
  } catch (error) {
    return redactForPersistence({
      schemaVersion: HEAD_SCHEMA_VERSION,
      kind: 'head-observation',
      route,
      capturedAt: new Date().toISOString(),
      fields: null,
      jsonLd: [],
      urls: null,
      complete: false,
      failure: error instanceof Error ? error.message : String(error),
    });
  }
}

export function headIndexEntry(observation, artifactPath) {
  return {
    route: observation.route,
    artifactPath,
    fingerprint: observation.fingerprint ?? null,
    complete: observation.complete === true,
    fields: observation.fields ?? null,
  };
}

function routeMap(value) {
  return new Map((value?.routes ?? []).map((entry, index) => [entry.route, { entry, index }]));
}

export function compareHeadEvidence(source, clone, sourceRunId, cloneRunId) {
  if (!source && !clone) return { findings: [], comparatorCoverage: [], coverage: { configured: false, complete: true, routesCompared: 0 } };
  const presenceComparator = { instrument: 'head', evidenceClass: 'head-presence', dimension: 'presence', mode: 'informational' };
  if (!source || !clone) {
    const indexEvidence = (runId, value) => (value ? { runId, artifact: 'measurements/head.json', locator: '#' } : null);
    return {
      findings: [{
        category: 'head-incomplete',
        subject: { route: null },
        status: 'informational',
        policy: { dimension: 'presence', mode: 'informational' },
        comparator: presenceComparator,
        observed: { source: source ? 'captured' : 'missing', clone: clone ? 'captured' : 'missing' },
        evidence: { source: indexEvidence(sourceRunId, source), clone: indexEvidence(cloneRunId, clone) },
      }],
      comparatorCoverage: [{ comparator: presenceComparator, subject: { route: null }, complete: false }],
      coverage: { configured: true, complete: false, reason: 'one-sided-head-evidence', routesCompared: 0 },
    };
  }
  const sourceRoutes = routeMap(source);
  const cloneRoutes = routeMap(clone);
  const routes = [...new Set([...sourceRoutes.keys(), ...cloneRoutes.keys()])];
  const findings = [];
  const comparatorCoverage = [];
  let routesCompared = 0;
  for (const route of routes) {
    const sourceRoute = sourceRoutes.get(route);
    const cloneRoute = cloneRoutes.get(route);
    const subject = { route };
    const complete = Boolean(sourceRoute?.entry.complete && cloneRoute?.entry.complete && sourceRoute.entry.fields && cloneRoute.entry.fields);
    comparatorCoverage.push({ comparator: presenceComparator, subject, complete });
    if (!complete) {
      const state = (value) => (value ? (value.entry.complete ? 'captured' : 'incomplete') : 'missing');
      findings.push({
        category: 'head-incomplete',
        subject,
        status: 'informational',
        policy: { dimension: 'presence', mode: 'informational' },
        comparator: presenceComparator,
        observed: { source: state(sourceRoute), clone: state(cloneRoute) },
        evidence: {
          source: sourceRoute ? { runId: sourceRunId, artifact: 'measurements/head.json', locator: `#/routes/${sourceRoute.index}` } : null,
          clone: cloneRoute ? { runId: cloneRunId, artifact: 'measurements/head.json', locator: `#/routes/${cloneRoute.index}` } : null,
        },
      });
      for (const { field, mode } of HEAD_DIMENSIONS) {
        comparatorCoverage.push({ comparator: { instrument: 'head', evidenceClass: 'head-metadata', dimension: field, mode }, subject, complete: false });
      }
      continue;
    }
    routesCompared += 1;
    for (const { field, mode } of HEAD_DIMENSIONS) {
      const comparator = { instrument: 'head', evidenceClass: 'head-metadata', dimension: field, mode };
      comparatorCoverage.push({ comparator, subject, complete: true });
      const sourceValue = sourceRoute.entry.fields[field] ?? null;
      const cloneValue = cloneRoute.entry.fields[field] ?? null;
      if (canonicalJson(sourceValue) === canonicalJson(cloneValue)) continue;
      findings.push({
        category: `head-${kebab(field)}-mismatch`,
        subject,
        status: mode === 'gate' ? 'open' : 'informational',
        policy: { dimension: field, mode },
        comparator,
        observed: { source: sourceValue, clone: cloneValue },
        evidence: {
          source: { runId: sourceRunId, artifact: 'measurements/head.json', locator: `#/routes/${sourceRoute.index}/fields/${field}` },
          clone: { runId: cloneRunId, artifact: 'measurements/head.json', locator: `#/routes/${cloneRoute.index}/fields/${field}` },
        },
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

function decodeXml(value) {
  return value.replace(/&(amp|lt|gt|quot|apos);/gu, (_, entity) => XML_ENTITIES[entity]);
}

// Reads an explicit route list from the target's own sitemap. This is an
// inventory source with fixed bounds, not a crawler: nothing is discovered by
// following page links.
export async function routesFromSitemap(targetUrl, {
  sitemapUrl = null,
  fetchImpl = fetch,
  maxRoutes = 500,
  maxSitemaps = 10,
  maxBytes = 5 * 1024 * 1024,
  timeoutMs = 15000,
} = {}) {
  const origin = new URL(targetUrl).origin;
  const first = new URL(sitemapUrl ?? '/sitemap.xml', origin);
  if (first.origin !== origin) throw new Error('Sitemap must be served from the target origin');
  const queue = [first.toString()];
  const fetched = new Set();
  const routes = [];
  const seenRoutes = new Set();
  const digest = createHash('sha256');
  let truncated = false;
  while (queue.length) {
    const next = queue.shift();
    if (fetched.has(next)) continue;
    if (fetched.size >= maxSitemaps) {
      truncated = true;
      break;
    }
    fetched.add(next);
    const response = await fetchImpl(next, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Sitemap ${safeUrl(next)} returned ${response.status}`);
    if (response.url && new URL(response.url).origin !== origin) throw new Error(`Sitemap ${safeUrl(next)} redirected off the target origin`);
    let bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`Sitemap ${safeUrl(next)} exceeds ${maxBytes} bytes`);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes, { maxOutputLength: maxBytes });
    const xml = bytes.toString('utf8');
    digest.update(xml);
    const isIndex = /<sitemapindex[\s>]/iu.test(xml);
    for (const match of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/giu)) {
      let url;
      try {
        url = new URL(decodeXml(match[1]), next);
      } catch {
        continue;
      }
      if (url.origin !== origin) continue;
      if (isIndex) {
        queue.push(url.toString());
        continue;
      }
      const route = `${url.pathname}${url.search}`;
      if (seenRoutes.has(route)) continue;
      if (routes.length >= maxRoutes) {
        truncated = true;
        continue;
      }
      seenRoutes.add(route);
      routes.push(route);
    }
  }
  if (!routes.length) throw new Error(`Sitemap ${safeUrl(first.toString())} contained no same-origin routes`);
  return {
    routes,
    source: {
      kind: 'sitemap',
      url: safeUrl(first.toString()),
      sitemaps: fetched.size,
      routes: routes.length,
      truncated,
      sha256: digest.digest('hex'),
    },
  };
}
