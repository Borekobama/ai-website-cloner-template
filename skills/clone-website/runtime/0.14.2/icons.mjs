import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchBrowser } from './browser.mjs';
import { colorAt, createRaster, luminance, rasterFromPng, resampleRegion } from './image.mjs';
import { probeInkBox } from './probes.mjs';

// Finds which public icon matches an icon in a screenshot. Candidates come
// from the Iconify API, are drawn by Chromium at the reference's device scale
// and size, and are ranked by shape: a coarse correlation over every
// candidate, then correlation plus chamfer distance for a short list.

// Icon sets that most interfaces use.
export const DEFAULT_ICON_SETS = Object.freeze(['lucide', 'hugeicons', 'tabler', 'heroicons', 'ph']);

const API = 'https://api.iconify.design';
const PREFIX = /^[a-z0-9-]+$/u;
const NAMES_PER_REQUEST = 100;
const COARSE = 16;
const FINE = 32;
const SHORTLIST = 50;
const BINARY_COVERAGE = 0.35;
// Pixels per screenshot side; a page holds at most 20 x 20 cells.
const PAGE_PIXELS = 2048;
const PAGE_COLUMNS = 20;
// A complete tag of an SVG drawing element, with quoted attribute values.
const SVG_TAG = /<\/?(?:a|animate|animateMotion|animateTransform|circle|clipPath|defs|desc|ellipse|fe[a-z]+|filter|g|image|line|linearGradient|marker|mask|metadata|mpath|path|pattern|polygon|polyline|radialGradient|rect|set|stop|switch|symbol|text|textPath|title|tspan|use|view)(?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>/giu;

const round = (value, digits = 3) => Number(value.toFixed(digits));

async function getJson(fetchImpl, url) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.json();
}

// One Iconify set as { prefix, info, icons: { name: { body, width, height } } }.
// The first call downloads it; later calls read <cacheDirectory>/<prefix>.json.
export async function loadIconSet(prefix, { cacheDirectory, fetchImpl = fetch } = {}) {
  if (typeof prefix !== 'string' || !PREFIX.test(prefix)) throw new Error(`Invalid icon set prefix ${JSON.stringify(prefix)}; use lowercase letters, digits, and hyphens`);
  const cacheFile = cacheDirectory ? join(cacheDirectory, `${prefix}.json`) : null;
  if (cacheFile) {
    let cached = null;
    try {
      cached = JSON.parse(await readFile(cacheFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`The icon cache ${cacheFile} is unreadable (${error.message}); delete it to download the set again`);
    }
    if (cached) {
      if (cached.prefix !== prefix || !cached.icons || typeof cached.icons !== 'object') throw new Error(`The icon cache ${cacheFile} is not a ${prefix} icon set; delete it to download the set again`);
      return cached;
    }
  }
  const collection = await getJson(fetchImpl, `${API}/collection?prefix=${prefix}`);
  const info = (await getJson(fetchImpl, `${API}/collections?prefixes=${prefix}`))[prefix] ?? {};
  const hidden = new Set(collection.hidden ?? []);
  const names = [...new Set([...(collection.uncategorized ?? []), ...Object.values(collection.categories ?? {}).flat()])]
    .filter((name) => typeof name === 'string' && !hidden.has(name));
  const icons = {};
  for (let start = 0; start < names.length; start += NAMES_PER_REQUEST) {
    const chunk = names.slice(start, start + NAMES_PER_REQUEST);
    const data = await getJson(fetchImpl, `${API}/${prefix}.json?icons=${chunk.map(encodeURIComponent).join(',')}`);
    for (const [name, icon] of Object.entries(data?.icons ?? {})) {
      if (typeof icon?.body !== 'string') continue;
      icons[name] = { body: icon.body, width: icon.width ?? data.width ?? 24, height: icon.height ?? data.height ?? 24 };
    }
  }
  // An empty answer is an API failure; caching it would hide the set for good.
  if (!Object.keys(icons).length) throw new Error(`Iconify returned no icons for ${prefix}`);
  const set = { prefix, info, icons, fetchedAt: new Date().toISOString() };
  if (cacheFile) {
    await mkdir(cacheDirectory, { recursive: true });
    // Write and rename, so an interrupted run cannot leave half a cache file.
    await writeFile(`${cacheFile}.tmp`, JSON.stringify(set));
    await rename(`${cacheFile}.tmp`, cacheFile);
  }
  return set;
}

const inkStrength = (color, background, mode) => (mode === 'light' ? luminance(color) - background : background - luminance(color));

// The ink box of `box` (probeInkBox) as coverage maps: ink strength relative to
// the strongest ink, clamped 0..1, with the ink box fitted aspect-preserving
// and centred into a square that is resampled to 16x16 and 32x32.
function inkMaps(raster, geometry, box, mode) {
  const measured = probeInkBox(raster, geometry, { box, mode });
  if (!measured.ink) return { measured, maps: null };
  const { origin, scale } = geometry;
  const [x0, y0, x1, y1] = measured.ink.map((value, index) => (index % 2 ? origin.y : origin.x) + value * scale);
  const side = Math.max(x1 - x0, y1 - y0);
  const square = { x: (x0 + x1 - side) / 2, y: (y0 + y1 - side) / 2 };
  // Pixels the ink box touches. The strongest ink of the box is among them.
  const columns = [Math.max(0, Math.floor(x0)), Math.min(raster.width, Math.ceil(x1))];
  const rows = [Math.max(0, Math.floor(y0)), Math.min(raster.height, Math.ceil(y1))];
  // The canvas holds the whole square; cells outside the ink box stay empty.
  const left = Math.min(Math.floor(square.x), columns[0]);
  const top = Math.min(Math.floor(square.y), rows[0]);
  const canvas = createRaster(Math.max(Math.ceil(square.x + side), columns[1]) - left, Math.max(Math.ceil(square.y + side), rows[1]) - top);
  const strengths = new Float32Array(canvas.width * canvas.height);
  let core = 0;
  for (let y = rows[0]; y < rows[1]; y += 1) {
    for (let x = columns[0]; x < columns[1]; x += 1) {
      const strength = inkStrength(colorAt(raster, x, y), measured.background, mode);
      strengths[(y - top) * canvas.width + (x - left)] = strength;
      core = Math.max(core, strength);
    }
  }
  for (let index = 0; index < strengths.length; index += 1) {
    canvas.data[index * 4] = Math.round(255 * Math.min(1, Math.max(0, strengths[index] / core)));
  }
  const region = { x: square.x - left, y: square.y - top, width: side, height: side };
  const map = (size) => {
    const { data } = resampleRegion(canvas, region, size, size);
    const values = new Uint8Array(size * size);
    for (let index = 0; index < values.length; index += 1) values[index] = data[index * 4];
    return values;
  };
  return { measured, maps: { coarse: map(COARSE), fine: map(FINE) } };
}

// Icon bodies are untrusted markup. Script elements and event handler
// attributes are removed. A body that still holds anything but complete SVG
// drawing tags and text is refused: it could close its <svg> element, swallow
// the markup after it, or style the whole page.
function safeBody(body) {
  if (typeof body !== 'string') return null;
  const stripped = body
    .replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/giu, '')
    .replace(/\bon[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/giu, ' ');
  return stripped.replace(SVG_TAG, '').includes('<') ? null : stripped;
}

const viewBoxSide = (value) => (Number.isFinite(value) && value > 0 ? value : 24);

function gridHtml(icons, { size, margin, cell, columns }) {
  const svgs = icons.map((icon, index) => {
    const left = (index % columns) * cell + margin;
    const top = Math.floor(index / columns) * cell + margin;
    return `<svg viewBox="0 0 ${icon.width} ${icon.height}" width="${size}" height="${size}" style="color:#000;left:${left}px;top:${top}px">${icon.body}</svg>`;
  });
  return `<!doctype html><style>body{margin:0;background:#fff}svg{position:absolute;overflow:hidden}</style>${svgs.join('')}`;
}

// Every candidate drawn black on white in a grid of fixed cells, a few
// hundred per screenshot, and turned into the same coverage maps.
async function renderCandidates(browser, candidates, { scale, size }) {
  const margin = Math.max(2, Math.round(size / 8));
  const cell = size + 2 * margin;
  const columns = Math.max(1, Math.min(PAGE_COLUMNS, Math.floor(PAGE_PIXELS / (cell * scale))));
  const perPage = columns * columns;
  const geometry = { origin: { x: 0, y: 0 }, scale };
  // No script runs and no request leaves the page, whatever a body contains.
  const context = await browser.newContext({ deviceScaleFactor: scale, javaScriptEnabled: false, viewport: { width: columns * cell, height: columns * cell } });
  try {
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    const rendered = [];
    for (let start = 0; start < candidates.length; start += perPage) {
      const chunk = candidates.slice(start, start + perPage);
      await page.setViewportSize({ width: columns * cell, height: Math.ceil(chunk.length / columns) * cell });
      await page.setContent(gridHtml(chunk, { size, margin, cell, columns }));
      const raster = rasterFromPng(await page.screenshot({ type: 'png' }));
      chunk.forEach((candidate, index) => {
        const x = (index % columns) * cell;
        const y = Math.floor(index / columns) * cell;
        const { maps } = inkMaps(raster, geometry, [x, y, x + cell, y + cell], 'dark');
        if (maps) rendered.push({ icon: candidate.icon, ...maps });
      });
    }
    return rendered;
  } finally {
    await context.close().catch(() => {});
  }
}

function pearson(left, right) {
  let leftSum = 0;
  let rightSum = 0;
  for (let index = 0; index < left.length; index += 1) {
    leftSum += left[index];
    rightSum += right[index];
  }
  const leftMean = leftSum / left.length;
  const rightMean = rightSum / right.length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] - leftMean;
    const b = right[index] - rightMean;
    covariance += a * b;
    leftVariance += a * a;
    rightVariance += b * b;
  }
  return leftVariance > 0 && rightVariance > 0 ? covariance / Math.sqrt(leftVariance * rightVariance) : 0;
}

// Two-pass 3-4 chamfer distance transform: the distance from every cell to the
// nearest ink cell, in cells. Straight steps cost 3 and diagonal steps 4.
function chamferTransform(mask, size) {
  const distance = Float64Array.from(mask, (ink) => (ink ? 0 : Infinity));
  const relax = (index, x, y, dx, dy, cost) => {
    if (x + dx < 0 || x + dx >= size || y + dy < 0 || y + dy >= size) return;
    distance[index] = Math.min(distance[index], distance[index + dy * size + dx] + cost);
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = y * size + x;
      relax(index, x, y, -1, 0, 3);
      relax(index, x, y, -1, -1, 4);
      relax(index, x, y, 0, -1, 3);
      relax(index, x, y, 1, -1, 4);
    }
  }
  for (let y = size - 1; y >= 0; y -= 1) {
    for (let x = size - 1; x >= 0; x -= 1) {
      const index = y * size + x;
      relax(index, x, y, 1, 0, 3);
      relax(index, x, y, 1, 1, 4);
      relax(index, x, y, 0, 1, 3);
      relax(index, x, y, -1, 1, 4);
    }
  }
  return distance.map((value) => value / 3);
}

// Symmetric chamfer distance of two maps binarized at 0.35 coverage: the mean
// distance from each shape's ink to the other shape's ink, averaged over both
// directions and capped at the map size.
function chamferDistance(left, right) {
  const leftMask = left.map((value) => (value >= BINARY_COVERAGE * 255 ? 1 : 0));
  const rightMask = right.map((value) => (value >= BINARY_COVERAGE * 255 ? 1 : 0));
  const directed = (mask, distance) => {
    let sum = 0;
    let count = 0;
    mask.forEach((ink, index) => {
      if (!ink) return;
      sum += distance[index];
      count += 1;
    });
    return count ? sum / count : Infinity;
  };
  const value = (directed(leftMask, chamferTransform(rightMask, FINE)) + directed(rightMask, chamferTransform(leftMask, FINE))) / 2;
  return Math.min(FINE, value);
}

function rank(reference, rendered, top) {
  return rendered
    .map((candidate) => ({ candidate, coarse: pearson(reference.coarse, candidate.coarse) }))
    .sort((a, b) => b.coarse - a.coarse)
    .slice(0, SHORTLIST)
    .map(({ candidate }) => {
      const correlation = pearson(reference.fine, candidate.fine);
      const chamfer = chamferDistance(reference.fine, candidate.fine);
      return { icon: candidate.icon, score: 0.6 * correlation + 0.4 * (1 - chamfer / FINE), correlation, chamfer };
    })
    .sort((a, b) => b.score - a.score || a.icon.localeCompare(b.icon))
    .slice(0, top)
    .map((match) => ({ icon: match.icon, score: round(match.score), correlation: round(match.correlation), chamfer: round(match.chamfer, 2) }));
}

function measureReference({ id, raster, geometry, box, mode = 'dark' }) {
  try {
    const { measured, maps } = inkMaps(raster, geometry, box, mode);
    return { id, reference: { ink: measured.ink, width: measured.width ?? null, height: measured.height ?? null, warnings: measured.warnings }, maps, scale: geometry.scale };
  } catch (error) {
    return { id, reference: { ink: null, width: null, height: null, warnings: [error.message] }, maps: null };
  }
}

// Ranks icons from `sets` for every reference box: [{ id, raster, geometry,
// box, mode }] with `box` a CSS box around one icon. A set that cannot be
// loaded becomes a warning. A browser that is passed in stays open.
export async function matchIcons({ boxes, sets = DEFAULT_ICON_SETS, cacheDirectory, browser = null, fetchImpl = fetch, top = 5 } = {}) {
  if (!Array.isArray(boxes)) throw new Error('matchIcons needs boxes: [{ id, raster, geometry, box, mode }]');
  const warnings = [];
  const loaded = [];
  for (const prefix of new Set(sets)) {
    try {
      loaded.push(await loadIconSet(prefix, { cacheDirectory, fetchImpl }));
    } catch (error) {
      warnings.push(`Icon set ${prefix} was skipped: ${error.message}`);
    }
  }
  const candidates = [];
  for (const set of loaded) {
    let skipped = 0;
    for (const [name, icon] of Object.entries(set.icons)) {
      const body = safeBody(icon?.body);
      if (body === null) skipped += 1;
      else candidates.push({ icon: `${set.prefix}:${name}`, body, width: viewBoxSide(icon.width), height: viewBoxSide(icon.height) });
    }
    if (skipped) warnings.push(`${skipped} of ${Object.keys(set.icons).length} ${set.prefix} icons were skipped: their markup could leave the SVG element`);
  }
  const references = boxes.map(measureReference);
  // Candidates are drawn once per device scale and size: about 1.2 times the
  // reference ink, so that the ink itself is close to the reference size.
  const groups = new Map();
  for (const entry of references) {
    if (!entry.maps || !candidates.length) continue;
    const size = Math.max(8, Math.round(Math.max(entry.reference.width, entry.reference.height) * 1.2));
    const key = `${entry.scale}:${size}`;
    if (!groups.has(key)) groups.set(key, { scale: entry.scale, size, entries: [] });
    groups.get(key).entries.push(entry);
  }
  const ownBrowser = groups.size && !browser ? await launchBrowser({ headless: true }) : null;
  try {
    for (const group of groups.values()) {
      const rendered = await renderCandidates(browser ?? ownBrowser, candidates, group);
      for (const entry of group.entries) entry.matches = rank(entry.maps, rendered, top);
    }
  } finally {
    await ownBrowser?.close().catch(() => {});
  }
  return {
    boxes: references.map(({ id, reference, matches = [] }) => ({ id, reference, matches })),
    sets: loaded.map((set) => ({ prefix: set.prefix, title: set.info?.name ?? set.prefix, total: set.info?.total ?? Object.keys(set.icons).length, license: set.info?.license ?? null })),
    warnings,
  };
}
