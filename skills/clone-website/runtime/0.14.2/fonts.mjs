import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { launchBrowser } from './browser.mjs';
import { colorAt, luminance, median, rasterFromPng } from './image.mjs';
import { probeInkBox } from './probes.mjs';

// Fits font family, weight, and size to one-line text samples of a screenshot.
// Candidates render as DOM text in Chromium at the reference's device scale
// factor, so antialiasing and optical sizing match; canvas text ignores
// optical sizing. The result is a builder draft, not evidence.

const PROFILE_COLUMNS = 48;
const PROFILE_ROWS = 16;
// Ink height as a fraction of the font size. Only the first render uses it;
// the width fit then sets the size.
const HEIGHT_PER_SIZE = 0.72;
const SIZE_STEPS = 2;
const MIN_SIZE = 1;
const MAX_SIZE = 1000;
const LOAD_TIMEOUT_MS = 20000;
// -webkit-font-smoothing values. Only macOS applies them, and there
// `antialiased` draws thinner strokes than `auto`, so a fitted weight holds
// only for the smoothing it was fitted with.
const SMOOTHING = ['auto', 'antialiased'];
const PLATFORM_NAMES = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };
const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong']);
const FONT_FILE_TYPES = { '.woff2': ['font/woff2', 'woff2'], '.woff': ['font/woff', 'woff'], '.ttf': ['font/ttf', 'truetype'], '.otf': ['font/otf', 'opentype'] };
// Compound words come first, so SemiBold is not read as Bold.
const WEIGHT_WORDS = [
  [/(?:extra|ultra)[\s_-]?light/iu, 200],
  [/(?:semi|demi)[\s_-]?bold/iu, 600],
  [/(?:extra|ultra)[\s_-]?bold/iu, 800],
  [/thin|hairline/iu, 100],
  [/light/iu, 300],
  [/medium/iu, 500],
  [/bold/iu, 700],
  [/black|heavy/iu, 900],
];
const SPECIMEN_PAGE = '<!doctype html><html><head><meta charset="utf-8"><style>body { margin: 0; } #specimen { position: absolute; margin: 0; padding: 0; white-space: pre; line-height: normal; }</style></head><body><div id="specimen"></div></body></html>';

export const DEFAULT_FONT_CANDIDATES = Object.freeze([
  'Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Source Sans 3', 'Nunito Sans', 'Work Sans', 'DM Sans',
  'Manrope', 'Plus Jakarta Sans', 'IBM Plex Sans', 'Outfit', 'Figtree', 'Rubik', 'Noto Sans', 'Space Grotesk', 'Geist', 'Geist Mono',
  'JetBrains Mono', 'IBM Plex Mono', 'Roboto Mono', 'Urbanist', 'Sora', 'Lexend', 'Archivo', 'Public Sans', 'Mulish', 'Karla',
].map((family) => Object.freeze({
  family,
  weights: Object.freeze(family === 'Lato' ? [300, 400, 700] : [300, 400, 500, 600, 700]),
  // Inter loads its optical size axis; Chromium sets it from the font size.
  ...(family === 'Inter' ? { axes: 'opsz,wght@14..32,300..700' } : {}),
})));

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const metric = (value) => Number(value.toFixed(4));
const clampSize = (size) => Math.min(MAX_SIZE, Math.max(MIN_SIZE, size));
const byScore = (left, right) => left.score - right.score || left.family.localeCompare(right.family) || left.weight - right.weight;

function normalizeSamples(samples, smoothing) {
  if (!Array.isArray(samples) || !samples.length) throw new Error('fitFonts needs at least one sample');
  const ids = new Set();
  return samples.map((sample, index) => {
    const label = `Font sample ${index + 1}`;
    const id = typeof sample?.id === 'string' ? sample.id.trim() : '';
    if (!id || ids.has(id)) throw new Error(`${label} needs a unique id`);
    ids.add(id);
    if (typeof sample.text !== 'string' || !sample.text.trim() || /[\r\n]/u.test(sample.text)) throw new Error(`${label} needs the text of exactly one line`);
    const { raster, geometry } = sample;
    if (!Number.isInteger(raster?.width) || !Number.isInteger(raster?.height) || !(raster.data?.length >= raster.width * raster.height * 4)) throw new Error(`${label} needs an RGBA raster`);
    if (!finite(geometry?.origin?.x) || !finite(geometry?.origin?.y) || !finite(geometry?.scale) || geometry.scale <= 0) throw new Error(`${label} needs geometry { origin: { x, y }, scale }`);
    if (!Array.isArray(sample.box) || sample.box.length !== 4 || !sample.box.every(finite)) throw new Error(`${label} box must be [x0, y0, x1, y1] in CSS pixels`);
    const mode = sample.mode ?? 'dark';
    if (!['dark', 'light'].includes(mode)) throw new Error(`${label} mode must be dark or light`);
    const tracking = sample.tracking ?? 0;
    if (!finite(tracking)) throw new Error(`${label} tracking must be a letter-spacing in em`);
    const weightHint = sample.weightHint ?? null;
    if (weightHint !== null && !finite(weightHint)) throw new Error(`${label} weightHint must be a number`);
    const sampleSmoothing = sample.smoothing ?? smoothing;
    if (!SMOOTHING.includes(sampleSmoothing)) throw new Error(`${label} smoothing must be auto or antialiased`);
    return { id, text: sample.text, raster, geometry, box: [...sample.box], mode, tracking, weightHint, smoothing: sampleSmoothing };
  });
}

function normalizeCandidates(candidates) {
  if (!Array.isArray(candidates)) throw new Error('Font candidates must be an array');
  return candidates.map((entry, index) => {
    const label = `Font candidate ${index + 1}`;
    const family = typeof entry?.family === 'string' ? entry.family.trim() : '';
    // The name goes into CSS strings and a URL, so quotes and control characters are refused.
    if (!family || /["'\\\p{Cc}]/u.test(family)) throw new Error(`${label} needs a family name without quotes, backslashes, or control characters`);
    const weights = [...new Set(Array.isArray(entry.weights) ? entry.weights : [])].sort((left, right) => left - right);
    if (!weights.length || !weights.every((weight) => Number.isInteger(weight) && weight >= 1 && weight <= 1000)) throw new Error(`${label} needs integer weights from 1 to 1000`);
    const source = entry.source ?? 'google';
    if (source === 'local') {
      const generic = GENERIC_FAMILIES.has(family.toLowerCase());
      return { family, weights, source, generic, css: generic ? family.toLowerCase() : `"${family}"` };
    }
    if (source !== 'google') throw new Error(`${label} source must be google or local`);
    const axes = entry.axes ?? `wght@${weights.join(';')}`;
    if (typeof axes !== 'string' || !/^[a-z0-9,.;@]+$/iu.test(axes)) throw new Error(`${label} axes must be a Google Fonts axis list such as wght@400;700`);
    const query = `${encodeURIComponent(family).replace(/%20/gu, '+')}:${axes}`;
    return { family, weights, source, css: `"${family}"`, url: `https://fonts.googleapis.com/css2?family=${query}&display=block` };
  });
}

function fileWeight(name) {
  const number = /(?<![0-9])([1-9]00)(?![0-9])/u.exec(name);
  if (number) return Number(number[1]);
  return WEIGHT_WORDS.find(([pattern]) => pattern.test(name))?.[1] ?? 400;
}

// Every font file becomes a one-weight candidate. Its @font-face uses a private
// alias, so a file named like a Google or installed family cannot merge with it.
function fileCandidates(fontDir) {
  let names;
  try {
    names = readdirSync(fontDir).sort();
  } catch (error) {
    throw new Error(`The font directory cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const candidates = [];
  for (const name of names) {
    const extension = extname(name).toLowerCase();
    if (!FONT_FILE_TYPES[extension]) continue;
    const family = name.slice(0, -extension.length);
    const weight = fileWeight(family);
    const alias = `cloner-font-file-${candidates.length + 1}`;
    let rule = null;
    try {
      const [mime, format] = FONT_FILE_TYPES[extension];
      const data = readFileSync(join(fontDir, name)).toString('base64');
      rule = `@font-face { font-family: "${alias}"; src: url("data:${mime};base64,${data}") format("${format}"); font-weight: ${weight}; font-style: normal; font-display: block; }`;
    } catch {
      rule = null;
    }
    candidates.push({ family, weights: [weight], source: 'file', css: `"${alias}"`, rule });
  }
  return candidates;
}

// Adds every candidate to the page and returns the weights that render with
// the real font. document.fonts.check() is true for any unknown local name, so
// an installed font is detected by its width against three generic fallbacks.
function loadCandidates(page, candidates, text) {
  return page.evaluate(async ({ entries, text: sampleText, timeout }) => {
    const settle = (promise) => Promise.race([promise, new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('timed out')), timeout);
    })]);
    const rules = entries.filter((entry) => entry.rule).map((entry) => entry.rule).join('\n');
    if (rules) {
      const style = document.createElement('style');
      style.textContent = rules;
      document.head.append(style);
    }
    const sheets = await Promise.all(entries.map((entry) => (entry.url ? settle(new Promise((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = entry.url;
      link.onload = () => resolve(true);
      link.onerror = () => resolve(false);
      document.head.append(link);
    })).catch(() => false) : true)));
    const probe = document.createElement('span');
    probe.style.cssText = 'position: absolute; left: 0; top: 0; visibility: hidden; white-space: pre; font-size: 72px';
    probe.textContent = `${sampleText} mmmmmmmmmmlli WQ@`;
    document.body.append(probe);
    const width = (family) => {
      probe.style.fontFamily = family;
      return probe.getBoundingClientRect().width;
    };
    const installed = (family) => ['monospace', 'serif', 'sans-serif'].some((generic) => width(`${family}, ${generic}`) !== width(generic));
    const results = await Promise.all(entries.map(async (entry, index) => {
      if (entry.source === 'file' && !entry.rule) return { loaded: [], reason: 'the font file could not be read' };
      if (!sheets[index]) return { loaded: [], reason: 'the Google Fonts stylesheet did not load' };
      if (entry.source === 'local') return entry.generic || installed(entry.css) ? { loaded: entry.weights } : { loaded: [], reason: 'the font is not installed' };
      const loaded = await Promise.all(entry.weights.map(async (weight) => {
        const font = `${weight} 32px ${entry.css}`;
        const faces = await settle(document.fonts.load(font, sampleText)).catch(() => []);
        return faces.length > 0 && document.fonts.check(font, sampleText) ? weight : null;
      }));
      return { loaded: loaded.filter((weight) => weight !== null), reason: entry.source === 'file' ? 'Chromium could not load the font file' : 'the font file did not load' };
    }));
    probe.remove();
    return results;
  }, {
    entries: candidates.map(({ source, generic = false, css, url = null, rule = null, weights }) => ({ source, generic, css, url, rule, weights })),
    text,
    timeout: LOAD_TIMEOUT_MS,
  });
}

// One line of text in the specimen element, screenshotted with enough padding
// that the border ring probeInkBox reads as background is free of ink.
async function renderLine(page, line) {
  const clip = await page.evaluate(({ css, weight, size, tracking, text, mode, smoothing }) => {
    const element = document.getElementById('specimen');
    const pad = Math.ceil(size * 0.25) + 4;
    document.body.style.background = mode === 'light' ? '#000' : '#fff';
    Object.assign(element.style, {
      fontFamily: css,
      fontWeight: String(weight),
      fontSize: `${size}px`,
      letterSpacing: `${tracking}em`,
      color: mode === 'light' ? '#fff' : '#000',
      left: `${pad}px`,
      top: `${pad}px`,
    });
    element.style.setProperty('-webkit-font-smoothing', smoothing);
    element.textContent = text;
    const rect = element.getBoundingClientRect();
    return { x: 0, y: 0, width: Math.ceil(rect.right + pad), height: Math.ceil(rect.bottom + pad) };
  }, line);
  // Screenshots are trimmed to the viewport, so long or large lines grow it.
  const viewport = page.viewportSize();
  if (clip.width > viewport.width || clip.height > viewport.height) {
    await page.setViewportSize({ width: Math.max(viewport.width, clip.width), height: Math.max(viewport.height, clip.height) });
  }
  return rasterFromPng(await page.screenshot({ clip }));
}

// Overlap of each of `count` equal bins over [from, to) with the pixels in
// [lower, upper). Weights are fractions of the bin, so a bin is an area mean
// and pixels outside the box count as background.
function binWeights(from, to, count, lower, upper) {
  const step = (to - from) / count;
  return Array.from({ length: count }, (_, index) => {
    const start = from + index * step;
    const end = start + step;
    const weights = [];
    for (let pixel = Math.max(lower, Math.floor(start)); pixel < Math.min(upper, Math.ceil(end)); pixel += 1) {
      const overlap = Math.min(end, pixel + 1) - Math.max(start, pixel);
      if (overlap > 0) weights.push([pixel, overlap / step]);
    }
    return weights;
  });
}

// Coverage profiles inside the ink box, with the ink definition of
// probeInkBox: luminance difference from the median of the box border ring, as
// a fraction of the strongest ink in the box. The ink box is resampled to a
// fixed grid, so lines of different sizes compare bin by bin.
function inkProfile(raster, geometry, box, ink, mode) {
  const toNative = (value, axis) => geometry.origin[axis] + value * geometry.scale;
  const left = Math.max(0, Math.floor(toNative(Math.min(box[0], box[2]), 'x')));
  const right = Math.min(raster.width, Math.ceil(toNative(Math.max(box[0], box[2]), 'x')));
  const top = Math.max(0, Math.floor(toNative(Math.min(box[1], box[3]), 'y')));
  const bottom = Math.min(raster.height, Math.ceil(toNative(Math.max(box[1], box[3]), 'y')));
  const ring = [];
  for (let x = left; x < right; x += 1) ring.push(luminance(colorAt(raster, x, top)), luminance(colorAt(raster, x, bottom - 1)));
  for (let y = top + 1; y < bottom - 1; y += 1) ring.push(luminance(colorAt(raster, left, y)), luminance(colorAt(raster, right - 1, y)));
  const background = median(ring);
  const sign = mode === 'light' ? 1 : -1;
  const width = right - left;
  const strengths = new Float64Array(width * (bottom - top));
  let core = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const strength = sign * (luminance(colorAt(raster, x, y)) - background);
      strengths[(y - top) * width + x - left] = strength;
      core = Math.max(core, strength);
    }
  }
  const columnBins = binWeights(toNative(ink[0], 'x'), toNative(ink[2], 'x'), PROFILE_COLUMNS, left, right);
  const rowBins = binWeights(toNative(ink[1], 'y'), toNative(ink[3], 'y'), PROFILE_ROWS, top, bottom);
  const grid = rowBins.map((rowWeights) => columnBins.map((columnWeights) => {
    let sum = 0;
    for (const [y, rowWeight] of rowWeights) {
      for (const [x, columnWeight] of columnWeights) sum += Math.min(1, Math.max(0, strengths[(y - top) * width + x - left] / core)) * rowWeight * columnWeight;
    }
    return sum;
  }));
  return {
    columns: columnBins.map((_, column) => grid.reduce((sum, row) => sum + row[column], 0) / PROFILE_ROWS),
    rows: grid.map((row) => row.reduce((sum, value) => sum + value, 0) / PROFILE_COLUMNS),
    density: grid.flat().reduce((sum, value) => sum + value, 0) / (PROFILE_COLUMNS * PROFILE_ROWS),
  };
}

// Ink box and coverage profiles of one line, or null when there is no ink.
function measureLine(raster, geometry, box, mode) {
  const probe = probeInkBox(raster, geometry, { box, mode });
  if (!probe.ink) return { probe, measured: null };
  if (probe.width <= 0 || probe.height <= 0) return { probe: { ...probe, warnings: [...probe.warnings, 'The ink box has no width or height'] }, measured: null };
  return { probe, measured: { ink: probe.ink, width: probe.width, height: probe.height, ...inkProfile(raster, geometry, box, probe.ink, mode) } };
}

function correlation(left, right) {
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const leftMean = mean(left);
  const rightMean = mean(right);
  let product = 0;
  let leftSquares = 0;
  let rightSquares = 0;
  left.forEach((value, index) => {
    const a = value - leftMean;
    const b = right[index] - rightMean;
    product += a * b;
    leftSquares += a * a;
    rightSquares += b * b;
  });
  // A flat profile has no shape to compare; two flat profiles agree.
  if (leftSquares === 0 || rightSquares === 0) return leftSquares === rightSquares ? 1 : 0;
  return product / Math.sqrt(leftSquares * rightSquares);
}

// The candidate height is scaled to the reference ink width first, so a
// candidate rendered at the wrong size is still compared by its proportions.
function compare(reference, measured) {
  const heightError = Math.abs((measured.height * reference.width) / measured.width - reference.height) / reference.height;
  const columnCorrelation = correlation(reference.columns, measured.columns);
  const rowCorrelation = correlation(reference.rows, measured.rows);
  const densityError = Math.abs(measured.density - reference.density) / reference.density;
  const score = 2 * heightError + (1 - columnCorrelation) + 0.5 * (1 - rowCorrelation) + 0.5 * densityError;
  return { score, heightError, columnCorrelation, rowCorrelation, densityError };
}

// Screens every candidate at a guessed size by its predicted height error,
// then fits the size of the best `keep` to the reference ink width. Trials
// outside `keep` keep their screening score and a one-step size estimate.
async function fitSample(page, sample, reference, candidates, keep) {
  const geometry = { origin: { x: 0, y: 0 }, scale: sample.geometry.scale };
  const measureAt = async (candidate, weight, size) => {
    const raster = await renderLine(page, { css: candidate.css, weight, size, tracking: sample.tracking, text: sample.text, mode: sample.mode, smoothing: sample.smoothing });
    const { measured } = measureLine(raster, geometry, [0, 0, raster.width / geometry.scale, raster.height / geometry.scale], sample.mode);
    return measured && { ...measured, size };
  };
  const eligible = (weight) => sample.weightHint === null || Math.abs(weight - sample.weightHint) <= 100;
  // Ink height / 0.72 is up to a third off for lines with descenders or no
  // capitals, and Inter screened that far from its size has the proportions
  // of another optical size. One width fit of the first candidate brings the
  // shared screening size close; this is why Inter is first by default.
  let guess = clampSize(reference.height / HEIGHT_PER_SIZE);
  const calibrator = candidates.find((candidate) => candidate.weights.some(eligible));
  if (calibrator) {
    const target = sample.weightHint ?? 400;
    const weight = calibrator.weights.filter(eligible).reduce((best, value) => (Math.abs(value - target) < Math.abs(best - target) ? value : best));
    const measured = await measureAt(calibrator, weight, guess);
    if (measured) guess = clampSize((guess * reference.width) / measured.width);
  }
  const trials = [];
  for (const candidate of candidates) {
    for (const weight of candidate.weights) {
      if (!eligible(weight)) continue;
      const measured = await measureAt(candidate, weight, guess);
      if (measured) trials.push({ family: candidate.family, candidate, weight, measured, fitted: false, size: (guess * reference.width) / measured.width, ...compare(reference, measured) });
    }
  }
  trials.sort((left, right) => left.heightError - right.heightError);
  for (const trial of trials.slice(0, keep)) {
    let { measured } = trial;
    for (let step = 0; step < SIZE_STEPS; step += 1) {
      const next = await measureAt(trial.candidate, trial.weight, clampSize((measured.size * reference.width) / measured.width));
      if (!next) break;
      measured = next;
    }
    Object.assign(trial, { measured, fitted: true, size: measured.size }, compare(reference, measured));
  }
  return trials;
}

// Each family's best fitted score per sample, averaged over samples. Screening
// scores come from an unfitted size, so they never rank a family. A family
// fitted on fewer samples ranks after those fitted on more.
function rankFamilies(trialsBySample) {
  const scores = new Map();
  for (const trials of trialsBySample) {
    const best = new Map();
    for (const trial of trials) if (trial.fitted && (!best.has(trial.family) || trial.score < best.get(trial.family))) best.set(trial.family, trial.score);
    for (const [family, score] of best) scores.set(family, [...(scores.get(family) ?? []), score]);
  }
  return [...scores]
    .map(([family, values]) => ({ family, score: values.reduce((sum, value) => sum + value, 0) / values.length, samples: values.length }))
    .sort((left, right) => right.samples - left.samples || left.score - right.score || left.family.localeCompare(right.family));
}

// Each family that fits at least one sample best, with the sizes and weights
// at which it wins, largest text first. Designs often set large text in one
// family and interface text in another; the ranking averages that split away.
function summarizeWinners(typeScale) {
  const winners = new Map();
  for (const entry of typeScale) {
    const winner = winners.get(entry.family) ?? { family: entry.family, samples: [], sizes: [entry.size, entry.size], weights: [] };
    winner.samples.push(entry.id);
    winner.sizes = [Math.min(winner.sizes[0], entry.size), Math.max(winner.sizes[1], entry.size)];
    if (!winner.weights.includes(entry.weight)) winner.weights.push(entry.weight);
    winners.set(entry.family, winner);
  }
  return [...winners.values()]
    .map((winner) => ({ ...winner, weights: winner.weights.sort((left, right) => left - right) }))
    .sort((left, right) => right.sizes[1] - left.sizes[1] || left.family.localeCompare(right.family));
}

const formatTrial = (trial) => ({
  family: trial.family,
  weight: trial.weight,
  size: Number(trial.size.toFixed(1)),
  score: metric(trial.score),
  heightError: metric(trial.heightError),
  columnCorrelation: metric(trial.columnCorrelation),
  rowCorrelation: metric(trial.rowCorrelation),
  densityError: metric(trial.densityError),
});

// Identifies the font family, weight, and size of one-line text samples.
// Unavailable fonts are reported, never thrown. A browser passed in stays open.
export async function fitFonts({ samples, candidates = DEFAULT_FONT_CANDIDATES, fontDir = null, browser = null, keep = 24, top = 5, smoothing = 'auto' } = {}) {
  if (!SMOOTHING.includes(smoothing)) throw new Error('smoothing must be auto or antialiased');
  const lines = normalizeSamples(samples, smoothing);
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be a positive integer');
  if (!Number.isInteger(top) || top < 1) throw new Error('top must be a positive integer');
  const pool = [...normalizeCandidates(candidates), ...(fontDir === null ? [] : fileCandidates(fontDir))];
  // References are measured before Chromium starts, so a bad box fails fast.
  const references = lines.map((line) => measureLine(line.raster, line.geometry, line.box, line.mode));
  const trialsBySample = lines.map(() => []);
  const unavailable = new Map();
  const warnings = [];
  const fittable = references.some((reference) => reference.measured);
  const ownBrowser = browser || !fittable ? null : await launchBrowser({ headless: true });
  try {
    for (const scale of new Set(lines.map((line) => line.geometry.scale))) {
      const indexes = lines.flatMap((line, index) => (line.geometry.scale === scale && references[index].measured ? [index] : []));
      if (!indexes.length) continue;
      const context = await (browser ?? ownBrowser).newContext({ viewport: { width: 1280, height: 400 }, deviceScaleFactor: scale });
      try {
        const page = await context.newPage();
        await page.setContent(SPECIMEN_PAGE);
        const loads = await loadCandidates(page, pool, indexes.map((index) => lines[index].text).join(' '));
        const available = [];
        pool.forEach((candidate, index) => {
          const { loaded, reason } = loads[index];
          const failed = candidate.weights.filter((weight) => !loaded.includes(weight));
          if (failed.length) {
            const key = `${candidate.source}|${candidate.family}|${reason}`;
            const entry = unavailable.get(key) ?? { family: candidate.family, weights: [], reason };
            entry.weights = [...new Set([...entry.weights, ...failed])].sort((left, right) => left - right);
            unavailable.set(key, entry);
          }
          if (loaded.length) available.push({ ...candidate, weights: loaded });
        });
        if (!available.length) warnings.push(`No candidate font is available at scale ${scale}; Google Fonts needs network access, or pass source: 'local' candidates`);
        for (const index of indexes) trialsBySample[index] = await fitSample(page, lines[index], references[index].measured, available, keep);
      } finally {
        await context.close().catch(() => {});
      }
    }
  } finally {
    await ownBrowser?.close().catch(() => {});
  }
  const families = rankFamilies(trialsBySample);
  // Each sample keeps its own winner: a page often mixes a sans and a mono.
  const typeScale = [];
  lines.forEach((line, index) => {
    const best = trialsBySample[index].filter((trial) => trial.fitted).sort(byScore)[0];
    if (!best) return;
    if (best.columnCorrelation < 0.8) {
      warnings.push(`No candidate matches the shape of sample ${line.id} well (best column correlation ${metric(best.columnCorrelation)}); check that the text is exact and that the box holds only this line on a plain background`);
    }
    typeScale.push({ id: line.id, family: best.family, weight: best.weight, size: Math.round(best.size * 2) / 2, smoothing: line.smoothing });
  });
  return {
    samples: lines.map((line, index) => {
      const { probe, measured } = references[index];
      return {
        id: line.id,
        text: line.text,
        smoothing: line.smoothing,
        reference: measured && { ink: measured.ink, width: measured.width, height: measured.height, density: metric(measured.density) },
        candidates: trialsBySample[index].filter((trial) => trial.fitted).sort(byScore).slice(0, top).map(formatTrial),
        warnings: [...probe.warnings],
      };
    }),
    families: families.map((entry) => ({ ...entry, score: metric(entry.score) })),
    winners: summarizeWinners(typeScale),
    typeScale,
    rendering: { platform: process.platform, smoothing },
    unavailable: [...unavailable.values()].sort((left, right) => left.family.localeCompare(right.family)),
    warnings,
  };
}

const cell = (value) => String(value ?? '').replace(/\s+/gu, ' ').replace(/[\\|]/gu, (character) => `\\${character}`).trim();

// A short Markdown summary of fitFonts output for the builder.
export function renderTypeScaleMarkdown(result) {
  const families = result?.families ?? [];
  const typeScale = result?.typeScale ?? [];
  const winners = result?.winners ?? summarizeWinners(typeScale);
  const texts = new Map((result?.samples ?? []).map((sample) => [sample.id, sample.text]));
  const lines = [
    '# Type scale draft',
    '',
    'This is a builder draft fitted from rendered font candidates, not evidence. Confirm the family, weights, and sizes against source CSS or a measured run.',
  ];
  const rendering = result?.rendering;
  if (rendering) {
    const platform = PLATFORM_NAMES[rendering.platform] ?? rendering.platform;
    lines.push('', rendering.platform === 'darwin'
      ? `Candidates were rendered in Chromium on ${platform} with \`-webkit-font-smoothing: ${rendering.smoothing}\`, except samples that set their own. On macOS, \`antialiased\` draws thinner strokes than \`auto\`, so give fitted text the smoothing it was fitted with.`
      : `Candidates were rendered in Chromium on ${platform}, which ignores \`-webkit-font-smoothing\`. On macOS, \`antialiased\` draws thinner strokes than \`auto\`, so fit on macOS when the clone sets \`antialiased\`.`);
  }
  lines.push('', '## Winners by size', '');
  if (winners.length) {
    lines.push('Each family that fits at least one sample best, with the sizes and weights at which it wins. Designs often set large text in one family and interface text in another, so choose a family for each size range from this table.', '', '| Family | Samples | Sizes (px) | Weights |', '| --- | ---: | --- | --- |');
    for (const winner of winners) {
      const sizes = winner.sizes[0] === winner.sizes[1] ? `${winner.sizes[0]}` : `${winner.sizes[0]}–${winner.sizes[1]}`;
      lines.push(`| ${cell(winner.family)} | ${winner.samples.length} | ${sizes} | ${winner.weights.join(', ')} |`);
    }
  } else {
    lines.push('No sample was fitted.');
  }
  lines.push('', '## Family ranking', '');
  if (families.length) {
    lines.push('Lower scores fit better. Each score is the mean of the best fitted score of the family on each sample, so it hides a family that wins only the large or only the small samples.', '', '| Rank | Family | Mean score | Samples |', '| ---: | --- | ---: | ---: |');
    families.slice(0, 10).forEach((entry, index) => lines.push(`| ${index + 1} | ${cell(entry.family)} | ${entry.score} | ${entry.samples} |`));
  } else {
    lines.push('No candidate font was fitted.');
  }
  lines.push('', '## Type scale', '');
  if (typeScale.length) {
    lines.push('Each sample with its best fitted font. Sizes are rounded to 0.5 px.', '', '| Sample | Text | Family | Weight | Size (px) | Smoothing |', '| --- | --- | --- | ---: | ---: | --- |');
    for (const entry of typeScale) lines.push(`| ${cell(entry.id)} | ${cell(texts.get(entry.id))} | ${cell(entry.family)} | ${entry.weight} | ${entry.size} | ${cell(entry.smoothing)} |`);
  } else {
    lines.push('No type scale.');
  }
  const unavailable = result?.unavailable ?? [];
  if (unavailable.length) lines.push('', `Unavailable: ${unavailable.map((entry) => `${entry.family} ${entry.weights.join(', ')} (${entry.reason})`).join('; ')}.`);
  const warnings = [
    ...(result?.samples ?? []).flatMap((sample) => (sample.warnings ?? []).map((warning) => `${sample.id}: ${warning}`)),
    ...(result?.warnings ?? []),
  ];
  if (warnings.length) lines.push('', '## Warnings', '', ...warnings.map((warning) => `- ${warning}`));
  return `${lines.join('\n')}\n`;
}
