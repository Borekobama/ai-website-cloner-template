export const ASSET_RIGHTS_SCHEMA_VERSION = 1;

// Hints, not legal conclusions: they tell a builder which assets need a
// licence check or a replacement before a clone is published.
const KNOWN_HOSTS = [
  { pattern: /(?:^|\.)fonts\.(?:gstatic|googleapis)\.com$/u, rightsClass: 'google-fonts', note: 'Google Fonts families are usually OFL or Apache licensed; confirm the licence of each family.' },
  { pattern: /(?:^|\.)(?:use|p)\.typekit\.net$/u, rightsClass: 'adobe-fonts', note: 'Adobe Fonts are licensed to the source site; reuse needs your own licence and cannot be self-hosted.' },
  { pattern: /(?:^|\.)fast\.fonts\.net$/u, rightsClass: 'monotype-fonts', note: 'Monotype web fonts need your own licence.' },
  { pattern: /(?:^|\.)cloud\.typography\.com$/u, rightsClass: 'hoefler-fonts', note: 'Hoefler&Co web fonts need your own licence.' },
  { pattern: /(?:^|\.)images\.unsplash\.com$/u, rightsClass: 'unsplash', note: 'Unsplash License; check the photo terms and attribution expectations.' },
  { pattern: /(?:^|\.)(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com)$/u, rightsClass: 'package-cdn', note: 'Served from a package CDN; check the licence of the package that ships it.' },
];
const NOTES = {
  'source-owned': 'Served by the source site. Reuse needs ownership or permission; replace it before publishing a clone of a site you do not own.',
  'source-hosted-font': 'Font files served by the source site. Identify the family and its licence before reuse.',
  'third-party': 'Served by a third party. Check its terms before reuse.',
};
const RELEVANT_TYPES = new Set(['image', 'font', 'media', 'manifest']);
const RELEVANT_MIME = /^(?:image|font|audio|video)\/|^application\/(?:font|x-font)/iu;

function isFont(asset) {
  return asset.resourceType === 'font' || /^(?:font\/|application\/(?:font|x-font))/iu.test(asset.mime ?? '') || /\.(?:woff2?|ttf|otf|eot)(?:$|\?)/iu.test(asset.finalUrl ?? '');
}

export function classifyAsset(asset, origin) {
  let url;
  try {
    url = new URL(asset.finalUrl ?? asset.requestUrl);
  } catch {
    return { rightsClass: 'unknown', note: 'The asset URL could not be parsed.' };
  }
  const known = KNOWN_HOSTS.find((entry) => entry.pattern.test(url.hostname));
  if (known) return { rightsClass: known.rightsClass, note: known.note };
  if (url.origin === origin) {
    const rightsClass = isFont(asset) ? 'source-hosted-font' : 'source-owned';
    return { rightsClass, note: NOTES[rightsClass] };
  }
  return { rightsClass: 'third-party', note: NOTES['third-party'] };
}

export function classifyAssetRights(assetEvidence, { origin } = {}) {
  const baseOrigin = origin ? new URL(origin).origin : null;
  const byUrl = new Map();
  for (const route of assetEvidence?.routes ?? []) {
    const observation = route.observation ?? route;
    for (const asset of observation.assets ?? []) {
      if (!RELEVANT_TYPES.has(asset.resourceType) && !RELEVANT_MIME.test(asset.mime ?? '')) continue;
      const url = asset.finalUrl ?? asset.requestUrl;
      if (!url) continue;
      const existing = byUrl.get(url);
      if (existing) {
        if (!existing.routes.includes(observation.route)) existing.routes.push(observation.route);
        continue;
      }
      byUrl.set(url, {
        url,
        mime: asset.mime ?? null,
        resourceType: asset.resourceType ?? null,
        bytes: asset.bytes ?? null,
        routes: [observation.route],
        ...classifyAsset(asset, baseOrigin),
      });
    }
  }
  const assets = [...byUrl.values()].sort((left, right) => left.rightsClass.localeCompare(right.rightsClass) || left.url.localeCompare(right.url));
  const summary = {};
  for (const asset of assets) summary[asset.rightsClass] = (summary[asset.rightsClass] ?? 0) + 1;
  return {
    schemaVersion: ASSET_RIGHTS_SCHEMA_VERSION,
    kind: 'asset-rights',
    informational: true,
    origin: baseOrigin,
    complete: Boolean(assetEvidence?.complete),
    summary,
    assets,
  };
}
