import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { launchBrowser } from './browser.mjs';
import { analyzeScreen, normalizeAnchors } from './frames.mjs';
import { cropRaster, decodeImage, resampleRegion, toPng } from './image.mjs';
import { closeRun, createRun, createRunId, setRef, sha256, writeArtifact } from './run-store.mjs';

export const SCREENS_SCHEMA_VERSION = 1;
const KINDS = new Set(['auto', 'presentation', 'raw', 'design-export']);
const PAGE_KEY = /^[a-z0-9][a-z0-9-]*$/u;

function positiveNumber(value, label) {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number`);
  return value;
}

// screens.json lists the screenshots and what each one shows. Image paths
// are relative to the file. Page keys name artifacts, so each one is unique;
// two states of one route (a menu open, a dialog) are two pages.
export function normalizeScreensConfig(value, baseDirectory = process.cwd()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('screens.json must be an object');
  const schemaVersion = value.schemaVersion ?? SCREENS_SCHEMA_VERSION;
  if (schemaVersion !== SCREENS_SCHEMA_VERSION) throw new Error(`Unsupported screens schema version: ${schemaVersion}`);
  if (!Array.isArray(value.screens) || !value.screens.length) throw new Error('screens.json needs a non-empty screens array');
  const site = value.site === undefined ? 'screens' : String(value.site).toLowerCase();
  if (!PAGE_KEY.test(site)) throw new Error('site must be a lowercase slug such as "permitly"');
  const designWidth = positiveNumber(value.designWidth, 'designWidth');
  const pages = new Set();
  const screens = value.screens.map((screen, index) => {
    const label = `Screen ${index + 1}`;
    if (!screen || typeof screen !== 'object') throw new Error(`${label} must be an object`);
    if (typeof screen.image !== 'string' || !screen.image) throw new Error(`${label} needs an image path`);
    const page = String(screen.page ?? '');
    if (!PAGE_KEY.test(page)) throw new Error(`${label} needs a page key of lowercase letters, digits, and hyphens`);
    if (pages.has(page)) throw new Error(`${label} repeats page key ${page}; give each route state its own key`);
    pages.add(page);
    const route = String(screen.route ?? '');
    if (!route.startsWith('/')) throw new Error(`${label} needs a route that starts with /`);
    const kind = screen.kind ?? 'auto';
    if (!KINDS.has(kind)) throw new Error(`${label} kind must be auto, presentation, raw, or design-export`);
    if (screen.frame !== undefined && (!Array.isArray(screen.frame) || screen.frame.length !== 4 || !screen.frame.every(Number.isFinite))) {
      throw new Error(`${label} frame must be [x, y, width, height] in image pixels`);
    }
    if (screen.liveSource !== undefined) {
      const live = new URL(String(screen.liveSource));
      if (!['http:', 'https:'].includes(live.protocol)) throw new Error(`${label} liveSource must be an http or https URL`);
    }
    return {
      image: resolve(baseDirectory, screen.image),
      imageName: screen.image,
      page,
      route,
      kind,
      ...(screen.state ? { state: String(screen.state) } : {}),
      ...(screen.liveSource ? { liveSource: new URL(String(screen.liveSource)).origin } : {}),
      dpr: positiveNumber(screen.dpr, `${label} dpr`),
      scale: positiveNumber(screen.scale, `${label} scale`),
      designWidth: positiveNumber(screen.designWidth, `${label} designWidth`) ?? designWidth,
      frame: screen.frame ?? null,
      frameIndex: Number.isInteger(screen.frameIndex) && screen.frameIndex >= 0 ? screen.frameIndex : 0,
      anchors: normalizeAnchors(screen.anchors ?? []),
    };
  });
  return { schemaVersion, site, designWidth, screens };
}

// Without --site the key comes from the image content, so new screenshots get
// a new namespace and the same screenshots always land in the same one.
export function screensSiteKey(config, imageHashes) {
  return `${config.site}-screens-${sha256([...imageHashes].sort().join('\n')).slice(0, 8)}`;
}

function crop(geometry, frame, raster) {
  const left = Math.max(0, Math.floor(Math.min(frame.x, geometry.origin.x)));
  const top = Math.max(0, Math.floor(Math.min(frame.y, geometry.origin.y)));
  const right = Math.min(raster.width, Math.ceil(frame.x + frame.width));
  const bottom = Math.min(raster.height, Math.ceil(frame.y + frame.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

// Decodes and measures every screen, then writes one closed source run with
// image evidence: originals, native crops, normalized 1x references, frames,
// and a route inventory. The run fails before it starts if any screen cannot
// be resolved, so a partial ingest never exists.
export async function ingestScreens({ root = process.cwd(), screensPath, siteKey = null, inventory = false, browser = null } = {}) {
  const configPath = resolve(root, screensPath);
  const config = normalizeScreensConfig(JSON.parse(readFileSync(configPath, 'utf8')), dirname(configPath));
  let ownBrowser = null;
  const sharedBrowser = async () => browser ?? (ownBrowser ??= await launchBrowser({ headless: true }));
  const analyzed = [];
  try {
    const problems = [];
    for (const screen of config.screens) {
      const bytes = readFileSync(screen.image);
      const decoded = await decodeImage(bytes, { browser: /\.png$/iu.test(screen.image) ? browser : await sharedBrowser() });
      const analysis = analyzeScreen(decoded.raster, screen);
      if (!analysis.geometry) {
        problems.push(`${screen.page} (${screen.imageName}): ${analysis.scale.reason}`);
        continue;
      }
      analyzed.push({ screen, bytes, decoded, analysis });
    }
    if (problems.length) throw new Error(`Some screens have no scale:\n${problems.join('\n')}`);
  } finally {
    await ownBrowser?.close().catch(() => {});
  }
  const key = siteKey ?? screensSiteKey(config, analyzed.map(({ bytes }) => sha256(bytes)));
  const runId = createRunId('source');
  const routes = [...new Set(analyzed.map(({ screen }) => screen.route))];
  createRun({
    root,
    siteKey: key,
    runId,
    kind: 'source',
    target: { kind: 'source', evidence: 'image', origin: null, screens: analyzed.length },
    scope: {
      inventoryRunId: inventory ? runId : null,
      authoritativeInventory: Boolean(inventory),
      routesRequested: routes,
      routesCompleted: routes,
      routesFailed: [],
    },
  });
  writeArtifact(root, key, runId, 'screens.json', {
    ...config,
    // Absolute image paths stay out of the evidence; the names remain.
    screens: config.screens.map((screen) => Object.fromEntries(Object.entries(screen).filter(([key]) => key !== 'image'))),
  }, { kind: 'screen-config' });
  const referencesRoot = resolve(root, 'docs', 'design-references', key);
  const records = [];
  for (const { screen, bytes, decoded, analysis } of analyzed) {
    const extension = extname(screen.imageName).toLowerCase() || `.${decoded.format}`;
    const box = crop(analysis.geometry, analysis.frame, decoded.raster);
    const native = cropRaster(decoded.raster, box);
    const { geometry } = analysis;
    const reference = resampleRegion(decoded.raster, {
      x: geometry.origin.x,
      y: geometry.origin.y,
      width: geometry.css.width * geometry.scale,
      height: geometry.css.height * geometry.scale,
    }, Math.max(1, Math.round(geometry.css.width)), Math.max(1, Math.round(geometry.css.height)));
    const paths = {
      original: `images/${screen.page}${extension}`,
      native: `references/${screen.page}.native.png`,
      reference: `references/${screen.page}.png`,
    };
    const nativePng = toPng(native);
    const referencePng = toPng(reference);
    writeArtifact(root, key, runId, paths.original, bytes, { kind: 'screen-image', visibility: 'private' });
    writeArtifact(root, key, runId, paths.native, nativePng, { kind: 'screen-native', visibility: 'private' });
    writeArtifact(root, key, runId, paths.reference, referencePng, { kind: 'screen-reference', visibility: 'private' });
    // Readable copies for people and builders; the run keeps the evidence.
    const pageDirectory = join(referencesRoot, screen.page);
    mkdirSync(pageDirectory, { recursive: true });
    writeFileSync(join(pageDirectory, `source${extension}`), bytes);
    writeFileSync(join(pageDirectory, 'native.png'), nativePng);
    writeFileSync(join(pageDirectory, 'reference.png'), referencePng);
    records.push({
      page: screen.page,
      route: screen.route,
      ...(screen.state ? { state: screen.state } : {}),
      ...(screen.liveSource ? { liveSource: screen.liveSource } : {}),
      image: { name: screen.imageName, path: paths.original, sha256: sha256(bytes), width: decoded.raster.width, height: decoded.raster.height, format: decoded.format, colorManaged: decoded.colorManaged },
      ...analysis,
      crop: box,
      // Probes run on the native crop: native = origin + css * scale.
      cropGeometry: {
        origin: { x: geometry.origin.x - box.x, y: geometry.origin.y - box.y },
        scale: geometry.scale,
        css: geometry.css,
      },
      references: paths,
    });
  }
  writeArtifact(root, key, runId, 'measurements/frames.json', { schemaVersion: 1, kind: 'screen-frames', runId, screens: records }, { kind: 'screen-frames' });
  writeArtifact(root, key, runId, 'measurements/routes.json', {
    schemaVersion: 1,
    runId,
    kind: 'route-inventory',
    evidence: 'image',
    capturedAt: new Date().toISOString(),
    // A route shown in a screenshot exists and rendered; status and final URL
    // are what a clone of it must reproduce.
    routes: routes.map((route) => ({ route, finalUrl: route, status: 200, title: null, evidence: 'image', pages: records.filter((record) => record.route === route).map((record) => record.page) })),
  }, { kind: 'route-inventory' });
  if (inventory) {
    writeArtifact(root, key, runId, 'inventory.json', {
      schemaVersion: 1,
      runId,
      kind: 'route-inventory',
      authoritative: true,
      evidence: 'image',
      capturedAt: new Date().toISOString(),
      routes: routes.map((route) => ({ route, finalUrl: route, status: 200, title: null })),
    }, { kind: 'route-inventory' });
  }
  const cropped = records.filter((record) => Object.values(record.frame.cropped).some(Boolean)).map((record) => record.page);
  const coverage = {
    schemaVersion: 1,
    evidence: 'image',
    inventory: inventory
      ? { runId, routes: routes.length, authoritative: true }
      : { runId: null, routes: routes.length, authoritative: false, source: 'screens' },
    measurement: {
      screens: records.length,
      routesRequested: routes.length,
      routesCompleted: routes.length,
      croppedScreens: cropped,
      lowConfidenceScreens: records.filter((record) => record.scale.confidence < 0.75).map((record) => record.page),
      warnings: records.reduce((sum, record) => sum + record.warnings.length, 0),
    },
    scope: inventory ? 'full' : 'ad-hoc',
  };
  writeArtifact(root, key, runId, 'coverage.json', coverage, { kind: 'coverage' });
  const closed = closeRun(root, key, runId, { runtime: { evidence: 'image' } });
  if (inventory) setRef(root, key, 'source-current', runId);
  return { manifest: closed, siteKey: key, screens: records, coverage, referencesRoot };
}
