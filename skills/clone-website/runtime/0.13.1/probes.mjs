import { averageColor, colorAt, colorDistance, hexColor, luminance, median, medianColor, stepEdgePosition } from './image.mjs';

// Every probe takes and returns CSS pixels of the normalized frame and
// measures on native pixels: native = origin + css * scale.

const round = (value, digits = 2) => (value === null || value === undefined ? value : Number(value.toFixed(digits)));

function maxOf(values) {
  let maximum = -Infinity;
  for (const value of values) if (value > maximum) maximum = value;
  return maximum;
}

function toNative(geometry, value, axis) {
  return geometry.origin[axis] + value * geometry.scale;
}

function toCss(geometry, value, axis) {
  return (value - geometry.origin[axis]) / geometry.scale;
}

// Integer pixel range [start, end) that covers a CSS interval.
function pixelRange(geometry, from, to, axis, limit) {
  const start = Math.max(0, Math.floor(toNative(geometry, Math.min(from, to), axis)));
  const end = Math.min(limit, Math.ceil(toNative(geometry, Math.max(from, to), axis)));
  if (end <= start) throw new Error(`The probe range ${from}..${to} on ${axis} is outside the image`);
  return [start, end];
}

function nativeBox(raster, geometry, box) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) throw new Error('A probe box must be [x0, y0, x1, y1] in CSS pixels');
  const [left, right] = pixelRange(geometry, box[0], box[2], 'x', raster.width);
  const [top, bottom] = pixelRange(geometry, box[1], box[3], 'y', raster.height);
  return { left, top, right, bottom };
}

// Colours along a line. `band` CSS pixels across the line are averaged.
function lineProfile(raster, geometry, { axis, at, from, to, band }) {
  const across = axis === 'x' ? 'y' : 'x';
  const [start, end] = pixelRange(geometry, from, to, axis, axis === 'x' ? raster.width : raster.height);
  const center = toNative(geometry, at, across);
  const half = Math.max(0, Math.round((band * geometry.scale - 1) / 2));
  const acrossLimit = axis === 'x' ? raster.height : raster.width;
  const acrossPixels = [];
  for (let offset = -half; offset <= half; offset += 1) {
    const pixel = Math.floor(center) + offset;
    if (pixel >= 0 && pixel < acrossLimit) acrossPixels.push(pixel);
  }
  if (!acrossPixels.length) throw new Error(`The probe line at ${across}=${at} is outside the image`);
  const profile = [];
  for (let pixel = start; pixel < end; pixel += 1) {
    profile.push(averageColor(acrossPixels.map((other) => (axis === 'x' ? colorAt(raster, pixel, other) : colorAt(raster, other, pixel)))));
  }
  return { start, profile };
}

function plateaus(profile, flatTolerance, minLength) {
  const runs = [];
  let start = 0;
  for (let index = 1; index <= profile.length; index += 1) {
    if (index < profile.length && colorDistance(profile[index], profile[index - 1]) <= flatTolerance) continue;
    if (index - start >= minLength) runs.push({ start, end: index - 1 });
    start = index;
  }
  return runs;
}

// Edges along a line: plateaus of flat colour, and the sub-pixel step between
// neighbouring plateaus that differ by at least `minContrast`.
export function probeEdges(raster, geometry, { axis = 'x', at, from, to, band = 1, flatTolerance = 6, minContrast = 12, minPlateau = 2 } = {}) {
  if (!['x', 'y'].includes(axis) || ![at, from, to].every(Number.isFinite)) throw new Error('Edges need axis x|y and numeric at, from, and to in CSS pixels');
  const { start, profile } = lineProfile(raster, geometry, { axis, at, from, to, band });
  const runs = plateaus(profile, flatTolerance, minPlateau);
  const edges = [];
  for (let index = 1; index < runs.length; index += 1) {
    const before = runs[index - 1];
    const after = runs[index];
    // Colours next to the step, not whole-plateau means, so slow gradients
    // inside a plateau do not shift the edge.
    const outside = averageColor(profile.slice(Math.max(before.start, before.end - 2), before.end + 1));
    const inside = averageColor(profile.slice(after.start, Math.min(after.end, after.start + 2) + 1));
    const contrast = colorDistance(outside, inside);
    if (contrast < minContrast) continue;
    const position = start + stepEdgePosition(profile, before.end, after.start, outside, inside);
    edges.push({ position: round(toCss(geometry, position, axis)), native: round(position), from: hexColor(outside), to: hexColor(inside), contrast: round(contrast, 1) });
  }
  return { axis, at, from, to, edges };
}

function backgroundLuminance(raster, box) {
  // The outer ring of the box: robust while ink covers less than half of it.
  const values = [];
  for (let x = box.left; x < box.right; x += 1) values.push(luminance(colorAt(raster, x, box.top)), luminance(colorAt(raster, x, box.bottom - 1)));
  for (let y = box.top + 1; y < box.bottom - 1; y += 1) values.push(luminance(colorAt(raster, box.left, y)), luminance(colorAt(raster, box.right - 1, y)));
  return median(values);
}

function inkStrength(color, background, mode) {
  const difference = luminance(color) - background;
  return mode === 'light' ? difference : -difference;
}

// Ink coverage of one line of pixels: the strongest ink in it, as a fraction
// of the strongest ink in the whole area.
function coverage(strengths, core) {
  return core > 0 ? Math.min(1, Math.max(0, maxOf(strengths) / core)) : 0;
}

// Words, icons, and lines along an axis. Columns (or rows) with ink inside the
// cross band form runs; runs closer than `gap` CSS pixels merge. Run ends are
// sub-pixel from the coverage of the first and last ink column.
export function probeInkRuns(raster, geometry, { axis = 'x', band, range, mode = 'dark', threshold = 40, gap = 2 } = {}) {
  if (!['x', 'y'].includes(axis) || !['dark', 'light'].includes(mode)) throw new Error('Ink runs need axis x|y and mode dark|light');
  if (!Array.isArray(band) || !Array.isArray(range)) throw new Error('Ink runs need band [from, to] across the axis and range [from, to] along it');
  const box = nativeBox(raster, geometry, axis === 'x' ? [range[0], band[0], range[1], band[1]] : [band[0], range[0], band[1], range[1]]);
  const background = backgroundLuminance(raster, box);
  const [alongStart, alongEnd] = axis === 'x' ? [box.left, box.right] : [box.top, box.bottom];
  const [acrossStart, acrossEnd] = axis === 'x' ? [box.top, box.bottom] : [box.left, box.right];
  const lines = [];
  for (let along = alongStart; along < alongEnd; along += 1) {
    const strengths = [];
    for (let across = acrossStart; across < acrossEnd; across += 1) {
      strengths.push(inkStrength(axis === 'x' ? colorAt(raster, along, across) : colorAt(raster, across, along), background, mode));
    }
    lines.push(strengths);
  }
  const core = Math.max(0, maxOf(lines.map(maxOf)));
  const gapPixels = gap * geometry.scale;
  const runs = [];
  let current = null;
  lines.forEach((strengths, index) => {
    if (maxOf(strengths) <= threshold) return;
    if (current && index - current.last - 1 <= gapPixels) current.last = index;
    else runs.push((current = { first: index, last: index }));
  });
  // Area method: faint antialiased lines next to a run, below the threshold,
  // still hold part of its coverage.
  const lineCoverage = (index) => (index < 0 || index >= lines.length ? 0 : coverage(lines[index], core));
  return {
    axis,
    mode,
    background: round(background, 1),
    runs: runs.map(({ first, last }) => {
      const start = alongStart + first + 1 - lineCoverage(first) - lineCoverage(first - 1) - lineCoverage(first - 2);
      const end = alongStart + last + lineCoverage(last) + lineCoverage(last + 1) + lineCoverage(last + 2);
      const startCss = toCss(geometry, start, axis);
      const endCss = toCss(geometry, end, axis);
      return { start: round(startCss), end: round(endCss), length: round(endCss - startCss) };
    }),
  };
}

// The ink bounding box inside a CSS box. Ink that touches the box edge means
// the box clipped it, so the size is a lower bound: widen the box and retry.
export function probeInkBox(raster, geometry, { box, mode = 'dark', threshold = 40 } = {}) {
  if (!['dark', 'light'].includes(mode)) throw new Error('Ink box mode must be dark or light');
  const area = nativeBox(raster, geometry, box);
  const background = backgroundLuminance(raster, area);
  let left = Infinity;
  let top = Infinity;
  let right = -1;
  let bottom = -1;
  let core = 0;
  for (let y = area.top; y < area.bottom; y += 1) {
    for (let x = area.left; x < area.right; x += 1) {
      const strength = inkStrength(colorAt(raster, x, y), background, mode);
      core = Math.max(core, strength);
      if (strength <= threshold) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) return { box, ink: null, warnings: ['No ink above the threshold in this box'] };
  const columnCoverage = (x) => (x < area.left || x >= area.right ? 0
    : coverage(Array.from({ length: bottom - top + 1 }, (_, index) => inkStrength(colorAt(raster, x, top + index), background, mode)), core));
  const rowCoverage = (y) => (y < area.top || y >= area.bottom ? 0
    : coverage(Array.from({ length: right - left + 1 }, (_, index) => inkStrength(colorAt(raster, left + index, y), background, mode)), core));
  const edges = {
    left: left + 1 - columnCoverage(left) - columnCoverage(left - 1) - columnCoverage(left - 2),
    right: right + columnCoverage(right) + columnCoverage(right + 1) + columnCoverage(right + 2),
    top: top + 1 - rowCoverage(top) - rowCoverage(top - 1) - rowCoverage(top - 2),
    bottom: bottom + rowCoverage(bottom) + rowCoverage(bottom + 1) + rowCoverage(bottom + 2),
  };
  const clipped = { left: left === area.left, top: top === area.top, right: right === area.right - 1, bottom: bottom === area.bottom - 1 };
  const ink = [toCss(geometry, edges.left, 'x'), toCss(geometry, edges.top, 'y'), toCss(geometry, edges.right, 'x'), toCss(geometry, edges.bottom, 'y')];
  return {
    box,
    ink: ink.map((value) => round(value)),
    width: round(ink[2] - ink[0]),
    height: round(ink[3] - ink[1]),
    background: round(background, 1),
    clipped,
    warnings: Object.values(clipped).some(Boolean)
      ? [`Ink touches the box edge (${Object.entries(clipped).filter(([, value]) => value).map(([side]) => side).join(', ')}); widen the box, this size is a lower bound`]
      : [],
  };
}

function colorKey(color) {
  return ((color[0] >> 3) << 10) | ((color[1] >> 3) << 5) | (color[2] >> 3);
}

// Colour of a flat area (median and mode), or of text: the median of the
// strongest 12 % of ink pixels, which are the stroke cores.
export function probeColor(raster, geometry, { box, mode = 'flat', threshold = 40 } = {}) {
  if (!['flat', 'dark', 'light'].includes(mode)) throw new Error('Colour mode must be flat, dark, or light');
  const area = nativeBox(raster, geometry, box);
  const colors = [];
  for (let y = area.top; y < area.bottom; y += 1) for (let x = area.left; x < area.right; x += 1) colors.push(colorAt(raster, x, y));
  if (mode === 'flat') {
    const value = medianColor(colors);
    const bins = new Map();
    for (const color of colors) {
      const key = colorKey(color);
      const entry = bins.get(key) ?? { count: 0, colors: [] };
      entry.count += 1;
      entry.colors.push(color);
      bins.set(key, entry);
    }
    const modeEntry = [...bins.values()].reduce((best, entry) => (entry.count > best.count ? entry : best));
    const spread = colors.map((color) => colorDistance(color, value)).sort((a, b) => a - b)[Math.floor(colors.length * 0.9)];
    return { box, mode, median: hexColor(value), modeColor: hexColor(averageColor(modeEntry.colors)), modeShare: round(modeEntry.count / colors.length, 3), spread90: round(spread, 1), pixels: colors.length };
  }
  const background = backgroundLuminance(raster, area);
  const ink = colors
    .map((color) => ({ color, strength: inkStrength(color, background, mode) }))
    .filter((entry) => entry.strength > threshold)
    .sort((a, b) => b.strength - a.strength);
  if (!ink.length) return { box, mode, ink: null, warnings: ['No ink above the threshold in this box'] };
  const cores = ink.slice(0, Math.max(1, Math.round(ink.length * 0.12))).map((entry) => entry.color);
  return { box, mode, ink: hexColor(medianColor(cores)), inkPixels: ink.length, corePixels: cores.length, background: round(background, 1) };
}

const CORNERS = {
  tl: { x: 'start', y: 'start' },
  tr: { x: 'end', y: 'start' },
  bl: { x: 'start', y: 'end' },
  br: { x: 'end', y: 'end' },
};

// Corner radius of a shape whose straight edges are `box` (CSS pixels, from
// edge probes). Each row near the corner gives the inset of the boundary from
// the straight edge; a circle of radius r predicts r - sqrt(r^2 - dy^2).
export function probeRadius(raster, geometry, { box, corner = 'tl', maxRadius = null } = {}) {
  const orientation = CORNERS[corner];
  if (!orientation) throw new Error('Corner must be tl, tr, bl, or br');
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) throw new Error('A radius probe needs the shape box [x0, y0, x1, y1] in CSS pixels');
  const scale = geometry.scale;
  const edge = {
    x: toNative(geometry, orientation.x === 'start' ? box[0] : box[2], 'x'),
    y: toNative(geometry, orientation.y === 'start' ? box[1] : box[3], 'y'),
  };
  const width = (box[2] - box[0]) * scale;
  const height = (box[3] - box[1]) * scale;
  const limit = Math.min(width, height) / 2;
  const maximum = Math.min(limit, maxRadius === null ? limit : maxRadius * scale);
  // Local coordinates grow into the shape from the corner. A local pixel u
  // covers [u, u + 1); `origin` is the image pixel at local 0.
  const originX = orientation.x === 'start' ? Math.floor(edge.x) - 2 : Math.ceil(edge.x) + 1;
  const originY = orientation.y === 'start' ? Math.floor(edge.y) - 2 : Math.ceil(edge.y) + 1;
  const signX = orientation.x === 'start' ? 1 : -1;
  const signY = orientation.y === 'start' ? 1 : -1;
  const localEdgeX = orientation.x === 'start' ? edge.x - originX : originX + 1 - edge.x;
  const localEdgeY = orientation.y === 'start' ? edge.y - originY : originY + 1 - edge.y;
  const pixel = (u, v) => {
    const x = originX + signX * u;
    const y = originY + signY * v;
    return x >= 0 && y >= 0 && x < raster.width && y < raster.height ? colorAt(raster, x, y) : null;
  };
  // Inside and outside colours from the middle of the side, far from corners.
  const middleY = Math.floor(toNative(geometry, (box[1] + box[3]) / 2, 'y'));
  const sideX = orientation.x === 'start' ? toNative(geometry, box[0], 'x') : toNative(geometry, box[2], 'x');
  const inside = colorAt(raster, Math.round(sideX + signX * 3 * scale), middleY);
  const outside = colorAt(raster, Math.round(sideX - signX * 3 * scale), middleY);
  if (colorDistance(inside, outside) < 12) return { box, corner, radius: null, warnings: ['Inside and outside colours are too close to fit a radius'] };
  const span = Math.ceil(localEdgeX + maximum + 3);
  const samples = [];
  // Rows start below the straight edge: a row that straddles it is only
  // partly inside, so its coverage would misplace the boundary.
  for (let v = Math.ceil(localEdgeY); v < localEdgeY + maximum + 1; v += 1) {
    const profile = Array.from({ length: span }, (_, u) => pixel(u, v));
    if (profile.some((color) => color === null)) continue;
    if (colorDistance(profile[span - 1], inside) > colorDistance(inside, outside) * 0.1) continue;
    const boundary = stepEdgePosition(profile, 0, span - 1, outside, inside);
    if (boundary === null || boundary >= span - 1) continue;
    samples.push({ center: v + 0.5, inset: boundary - localEdgeX });
  }
  if (samples.length < 3) return { box, corner, radius: null, warnings: ['Too few rows near the corner to fit a radius'] };
  const model = (radius, center) => {
    const dy = localEdgeY + radius - center;
    return dy > 0 ? radius - Math.sqrt(Math.max(0, radius * radius - dy * dy)) : 0;
  };
  let best = { radius: 0, error: Infinity };
  for (let radius = 0; radius <= maximum; radius += 0.05) {
    const error = samples.reduce((sum, sample) => sum + (sample.inset - model(radius, sample.center)) ** 2, 0);
    if (error < best.error) best = { radius, error };
  }
  return {
    box,
    corner,
    radius: round(best.radius / scale),
    residual: round(Math.sqrt(best.error / samples.length) / scale, 3),
    samples: samples.length,
    warnings: best.radius >= maximum - 0.05 ? ['The fit reached the largest radius tried; check the box and maxRadius'] : [],
  };
}
