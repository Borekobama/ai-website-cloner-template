import { canonicalJson, sha256 } from './run-store.mjs';

export const FINGERPRINT_SCHEMA_VERSION = 1;

function sameOriginPaths(requests, origin, resourceType) {
  return [...new Set(requests
    .filter((entry) => entry.resourceType === resourceType && entry.status < 400)
    .map((entry) => {
      try {
        const url = new URL(entry.url);
        return url.origin === origin ? `${url.pathname}${url.search}` : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean))].sort();
}

// A deployment fingerprint identifies the shipped code bundle, not page content.
// Hashed script and stylesheet URLs change on every deploy of modern frameworks;
// HTML validators are the fallback for pages without same-origin bundles.
export function deploymentFingerprint({ response = null, requests = [], origin } = {}) {
  const base = new URL(origin).origin;
  const scripts = sameOriginPaths(requests, base, 'script');
  const stylesheets = sameOriginPaths(requests, base, 'stylesheet');
  const headers = typeof response?.headers === 'function' ? response.headers() : {};
  const etag = headers.etag ?? null;
  const lastModified = headers['last-modified'] ?? null;
  const components = scripts.length || stylesheets.length
    ? { scripts, stylesheets }
    : etag || lastModified
      ? { etag, lastModified }
      : null;
  return {
    schemaVersion: FINGERPRINT_SCHEMA_VERSION,
    basis: components ? (components.scripts ? 'bundle-urls' : 'document-validators') : 'unavailable',
    fingerprint: components ? sha256(canonicalJson(components)) : null,
    scripts: scripts.length,
    stylesheets: stylesheets.length,
  };
}

export function driftStatus(previous, current) {
  if (!previous?.fingerprint || !current?.fingerprint) return 'unknown';
  return previous.fingerprint === current.fingerprint ? 'unchanged' : 'changed';
}
