import { averageColor, colorAt, colorDistance, median, medianColor, stepEdgePosition } from './image.mjs';

// Common design and viewport sizes, most likely first. A frame whose aspect
// matches one of them closely gets that size when nothing else is declared.
export const COMMON_SIZES = Object.freeze([
  [1440, 1024], [1440, 900], [1920, 1080], [1536, 864], [1366, 768], [1280, 800], [1280, 720],
  [1024, 768], [768, 1024], [430, 932], [393, 852], [390, 844], [375, 812], [360, 800],
]);
const BORDER_BAND = 2;
const SCAN_LINES = 15;

function quantile(sortedValues, q) {
  if (!sortedValues.length) return 0;
  return sortedValues[Math.min(sortedValues.length - 1, Math.floor(q * sortedValues.length))];
}

function colorKey(color) {
  return ((color[0] >> 3) << 10) | ((color[1] >> 3) << 5) | (color[2] >> 3);
}

// The backdrop of a presentation shot is the dominant colour of the image
// border. `share` says how much of the border it explains: a gradient, a photo,
// or a raw screenshot has a low share.
export function detectBackdrop(raster) {
  const samples = [];
  const band = Math.min(BORDER_BAND, raster.width, raster.height);
  for (let offset = 0; offset < band; offset += 1) {
    for (let x = 0; x < raster.width; x += 1) samples.push(colorAt(raster, x, offset), colorAt(raster, x, raster.height - 1 - offset));
    for (let y = band; y < raster.height - band; y += 1) samples.push(colorAt(raster, offset, y), colorAt(raster, raster.width - 1 - offset, y));
  }
  const bins = new Map();
  for (const color of samples) bins.set(colorKey(color), (bins.get(colorKey(color)) ?? 0) + 1);
  const modeKey = [...bins.entries()].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
  const seed = medianColor(samples.filter((color) => colorKey(color) === modeKey));
  const color = medianColor(samples.filter((sample) => colorDistance(sample, seed) <= 10)).map(Math.round);
  // The tolerance follows the noise of the backdrop itself, so a frame colour
  // close to the backdrop, seen where a cropped frame meets the border, cannot
  // widen it.
  const distances = samples.map((sample) => colorDistance(sample, color)).filter((value) => value <= 10).sort((a, b) => a - b);
  const tolerance = Math.max(6, 2 * quantile(distances, 0.9) + 2);
  const share = samples.filter((sample) => colorDistance(sample, color) <= tolerance).length / samples.length;
  return { color, tolerance, share };
}

function profileColor(raster, x, y, vertical) {
  // Average three pixels across the scan direction to damp noise and JPEG blocks.
  const colors = [];
  for (let offset = -1; offset <= 1; offset += 1) {
    const sampleX = vertical ? Math.min(raster.width - 1, Math.max(0, x + offset)) : x;
    const sampleY = vertical ? y : Math.min(raster.height - 1, Math.max(0, y + offset));
    colors.push(colorAt(raster, sampleX, sampleY));
  }
  return averageColor(colors);
}

// Scans from the backdrop inward and returns the first sharp step that leaves
// the backdrop. A soft drop shadow changes too slowly to count as a step.
function frameEdgeInProfile(profile, backdrop) {
  const threshold = Math.max(10, 1.25 * backdrop.tolerance);
  for (let index = 1; index + 2 < profile.length; index += 1) {
    if (colorDistance(profile[index + 2], profile[index - 1]) < threshold) continue;
    if (colorDistance(profile[index + 2], backdrop.color) <= backdrop.tolerance) continue;
    const start = Math.max(0, index - 2);
    const end = Math.min(profile.length - 1, index + 4);
    const outside = averageColor(profile.slice(Math.max(0, start - 1), start + 1));
    const inside = averageColor(profile.slice(end, Math.min(profile.length, end + 2)));
    const contrast = colorDistance(outside, inside);
    if (contrast < threshold) continue;
    return { position: stepEdgePosition(profile, start, end, outside, inside), contrast };
  }
  return null;
}

function refineSide(raster, backdrop, coarse, side, margin) {
  const vertical = side === 'top' || side === 'bottom';
  const along = vertical ? [coarse.left, coarse.right] : [coarse.top, coarse.bottom];
  const extent = vertical ? coarse.bottom - coarse.top : coarse.right - coarse.left;
  const limit = vertical ? raster.height : raster.width;
  const direction = side === 'left' || side === 'top' ? 1 : -1;
  const outer = direction === 1
    ? Math.max(0, (side === 'left' ? coarse.left : coarse.top) - margin)
    : Math.min(limit - 1, (side === 'right' ? coarse.right : coarse.bottom) - 1 + margin);
  const length = Math.min(Math.round(margin * 2 + extent * 0.25), direction === 1 ? limit - outer : outer + 1);
  const positions = [];
  const contrasts = [];
  for (let line = 0; line < SCAN_LINES; line += 1) {
    const at = Math.round(along[0] + (along[1] - along[0]) * (0.2 + 0.6 * (line / (SCAN_LINES - 1))));
    const profile = Array.from({ length }, (_, index) => {
      const position = outer + direction * index;
      return vertical ? profileColor(raster, at, position, true) : profileColor(raster, position, at, false);
    });
    const edge = frameEdgeInProfile(profile, backdrop);
    if (!edge) continue;
    positions.push(direction === 1 ? outer + edge.position : outer + 1 - edge.position);
    contrasts.push(edge.contrast);
  }
  if (positions.length < Math.ceil(SCAN_LINES / 3)) return null;
  const value = median(positions);
  return {
    position: value,
    contrast: median(contrasts),
    agreement: positions.filter((position) => Math.abs(position - value) <= 1).length / SCAN_LINES,
  };
}

function connectedComponents(mask, gridWidth, gridHeight) {
  const labels = new Int32Array(mask.length).fill(-1);
  const queue = new Int32Array(mask.length);
  const components = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start] !== -1) continue;
    const component = { minX: Infinity, minY: Infinity, maxX: -1, maxY: -1, cells: 0 };
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = components.length;
    while (head < tail) {
      const cell = queue[head++];
      const x = cell % gridWidth;
      const y = (cell - x) / gridWidth;
      component.minX = Math.min(component.minX, x);
      component.maxX = Math.max(component.maxX, x);
      component.minY = Math.min(component.minY, y);
      component.maxY = Math.max(component.maxY, y);
      component.cells += 1;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= gridWidth || ny >= gridHeight) continue;
        const next = ny * gridWidth + nx;
        if (!mask[next] || labels[next] !== -1) continue;
        labels[next] = components.length;
        queue[tail++] = next;
      }
    }
    components.push(component);
  }
  return components;
}

// Frames are large connected regions that differ from the backdrop, found on a
// coarse grid and refined to sub-pixel edges on native pixels. A frame that
// touches the image border is cropped on that side.
export function detectFrames(raster, backdrop = detectBackdrop(raster), { minAreaRatio = 0.02 } = {}) {
  const step = Math.max(1, Math.floor(Math.max(raster.width, raster.height) / 640));
  const gridWidth = Math.ceil(raster.width / step);
  const gridHeight = Math.ceil(raster.height / step);
  const mask = new Uint8Array(gridWidth * gridHeight);
  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const color = colorAt(raster, Math.min(raster.width - 1, gx * step + (step >> 1)), Math.min(raster.height - 1, gy * step + (step >> 1)));
      mask[gy * gridWidth + gx] = colorDistance(color, backdrop.color) > backdrop.tolerance ? 1 : 0;
    }
  }
  const imageArea = raster.width * raster.height;
  const margin = 2 * step + 2;
  return connectedComponents(mask, gridWidth, gridHeight)
    .map((component) => ({
      left: component.minX * step,
      top: component.minY * step,
      right: Math.min(raster.width, (component.maxX + 1) * step),
      bottom: Math.min(raster.height, (component.maxY + 1) * step),
      cropped: { left: component.minX === 0, top: component.minY === 0, right: component.maxX === gridWidth - 1, bottom: component.maxY === gridHeight - 1 },
      fill: component.cells / ((component.maxX - component.minX + 1) * (component.maxY - component.minY + 1)),
    }))
    .filter((box) => (box.right - box.left) * (box.bottom - box.top) >= minAreaRatio * imageArea && box.fill >= 0.3)
    .sort((a, b) => (b.right - b.left) * (b.bottom - b.top) - (a.right - a.left) * (a.bottom - a.top))
    .map((coarse) => {
      const sides = {};
      const warnings = [];
      for (const side of ['left', 'top', 'right', 'bottom']) {
        if (coarse.cropped[side]) {
          sides[side] = { position: side === 'right' ? raster.width : side === 'bottom' ? raster.height : 0, cropped: true };
          continue;
        }
        const refined = refineSide(raster, backdrop, coarse, side, margin);
        if (!refined) warnings.push(`No sharp ${side} edge was found; the coarse boundary is used`);
        sides[side] = refined ?? { position: coarse[side], contrast: 0, agreement: 0 };
      }
      return {
        x: sides.left.position,
        y: sides.top.position,
        width: sides.right.position - sides.left.position,
        height: sides.bottom.position - sides.top.position,
        cropped: { ...coarse.cropped },
        sides,
        warnings,
      };
    });
}

function anchorScale(anchor) {
  const nativeLength = Math.abs(anchor.native[1] - anchor.native[0]);
  const cssLength = Array.isArray(anchor.css) ? Math.abs(anchor.css[1] - anchor.css[0]) : anchor.css;
  return nativeLength / cssLength;
}

export function normalizeAnchors(anchors = []) {
  return anchors.map((anchor, index) => {
    const axis = anchor.axis ?? 'x';
    const valid = ['x', 'y'].includes(axis)
      && Array.isArray(anchor.native) && anchor.native.length === 2 && anchor.native.every(Number.isFinite) && anchor.native[0] !== anchor.native[1]
      && (Array.isArray(anchor.css) ? anchor.css.length === 2 && anchor.css.every(Number.isFinite) && anchor.css[0] !== anchor.css[1] : Number.isFinite(anchor.css) && anchor.css > 0);
    if (!valid) throw new Error(`Anchor ${index + 1} needs axis x|y, native [start, end] in image pixels, and css as a length or [start, end]`);
    return { axis, native: [...anchor.native], css: Array.isArray(anchor.css) ? [...anchor.css] : anchor.css };
  });
}

// Scale in image pixels per CSS pixel. A declared scale wins, then anchors
// (known CSS lengths), then a declared design width, then a common design size
// whose aspect matches the uncropped frame.
export function inferScale(frame, { scale = null, dpr = null, designWidth = null, anchors = [] } = {}) {
  const declared = scale ?? dpr;
  if (declared !== null && declared !== undefined) {
    if (!Number.isFinite(declared) || declared <= 0) throw new Error(`Declared scale must be a positive number, received ${declared}`);
    return { scale: declared, method: 'declared', confidence: 1, residuals: {} };
  }
  const fullWidth = !frame.cropped.left && !frame.cropped.right;
  const fullFrame = fullWidth && !frame.cropped.top && !frame.cropped.bottom;
  const normalized = normalizeAnchors(anchors);
  if (normalized.length) {
    const scales = normalized.map(anchorScale);
    const value = median(scales);
    const spread = Math.max(...scales.map((entry) => Math.abs(entry - value) / value));
    const residuals = { anchorSpread: spread };
    if (designWidth && fullWidth) residuals.designWidthDisagreement = Math.abs(frame.width / designWidth - value) / value;
    return { scale: value, method: 'anchors', confidence: spread <= 0.003 ? 0.9 : 0.5, residuals };
  }
  if (designWidth && fullWidth) {
    const value = frame.width / designWidth;
    return { scale: value, method: 'design-width', confidence: 0.9, residuals: { cssHeight: frame.height / value } };
  }
  if (fullFrame) {
    const aspect = frame.width / frame.height;
    const ranked = COMMON_SIZES
      .map(([width, height]) => ({ width, height, error: Math.abs(aspect / (width / height) - 1) }))
      .sort((left, right) => left.error - right.error);
    if (ranked[0].error <= 0.004) {
      return {
        scale: frame.width / ranked[0].width,
        method: 'common-size',
        size: { width: ranked[0].width, height: ranked[0].height },
        confidence: ranked[1].error <= 0.004 ? 0.4 : 0.75,
        residuals: { aspectError: ranked[0].error },
      };
    }
  }
  return { scale: null, method: 'unresolved', confidence: 0, residuals: {}, reason: 'Declare scale, dpr, designWidth, or anchors for this screen' };
}

// Maps CSS pixels of the normalized frame to image pixels:
// native = origin + css * scale. A cropped frame takes its origin from an anchor
// with CSS positions; otherwise the visible edge is assumed to be CSS 0.
export function screenGeometry(frame, scale, anchors = []) {
  const positioned = normalizeAnchors(anchors).filter((anchor) => Array.isArray(anchor.css));
  const origin = {};
  const originAssumed = {};
  for (const [axis, side, start] of [['x', 'left', frame.x], ['y', 'top', frame.y]]) {
    const anchor = positioned.find((entry) => entry.axis === axis);
    if (frame.cropped[side] && anchor) {
      origin[axis] = anchor.native[0] - anchor.css[0] * scale;
      originAssumed[axis] = false;
    } else {
      origin[axis] = start;
      originAssumed[axis] = Boolean(frame.cropped[side]);
    }
  }
  return {
    origin,
    scale,
    css: {
      width: (frame.x + frame.width - origin.x) / scale,
      height: (frame.y + frame.height - origin.y) / scale,
    },
    originAssumed,
  };
}

function wholeImage(raster) {
  return { x: 0, y: 0, width: raster.width, height: raster.height, cropped: { left: false, top: false, right: false, bottom: false }, warnings: [] };
}

// A frame counts as a presentation frame in auto mode only when it is large,
// has a clear backdrop margin on every side, and all four sides are sharp and
// straight. Anything else is treated as a raw screenshot, because content
// blocks on a plain page can look like frames.
function convincingFrame(raster, frame) {
  if (!frame || Object.values(frame.cropped).some(Boolean)) return false;
  if (frame.width * frame.height < 0.4 * raster.width * raster.height) return false;
  const marginX = raster.width * 0.02;
  const marginY = raster.height * 0.02;
  if (frame.x < marginX || frame.y < marginY || raster.width - (frame.x + frame.width) < marginX || raster.height - (frame.y + frame.height) < marginY) return false;
  return Object.values(frame.sides).every((side) => (side.agreement ?? 0) >= 0.8);
}

// Frame, scale, and CSS geometry for one screen. `kind` is presentation (an
// app frame on a backdrop), raw (a screenshot), design-export, or auto.
export function analyzeScreen(raster, { kind = 'auto', frame: declaredFrame = null, frameIndex = 0, scale = null, dpr = null, designWidth = null, anchors = [] } = {}) {
  if (!['auto', 'presentation', 'raw', 'design-export'].includes(kind)) throw new Error(`Unsupported screen kind: ${kind}`);
  const warnings = [];
  let backdrop = null;
  let frames = [];
  let frame;
  let resolvedKind = kind;
  if (declaredFrame) {
    const [x, y, width, height] = declaredFrame;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error('A declared frame must be [x, y, width, height] in image pixels');
    frame = { x, y, width, height, cropped: { left: false, top: false, right: x + width >= raster.width, bottom: y + height >= raster.height }, warnings: [] };
    if (kind === 'auto') resolvedKind = 'presentation';
  } else if (kind === 'raw' || kind === 'design-export') {
    frame = wholeImage(raster);
  } else {
    backdrop = detectBackdrop(raster);
    // A declared presentation frame may be cropped and cover much of the
    // border; auto mode needs a border that is almost all backdrop.
    frames = backdrop.share >= (kind === 'presentation' ? 0.25 : 0.9) ? detectFrames(raster, backdrop) : [];
    const candidate = frames[frameIndex] ?? null;
    if (kind === 'presentation') {
      if (!candidate) throw new Error(backdrop.share < 0.25
        ? 'The image border is not one flat colour; declare the frame as [x, y, width, height]'
        : `Frame ${frameIndex} was not found; ${frames.length} frame(s) detected`);
      frame = candidate;
    } else if (convincingFrame(raster, candidate)) {
      frame = candidate;
      resolvedKind = 'presentation';
      warnings.push('A presentation frame was detected automatically; declare kind to confirm it');
    } else {
      frame = wholeImage(raster);
      resolvedKind = 'raw';
    }
  }
  warnings.push(...(frame.warnings ?? []));
  const scaleResult = inferScale(frame, { scale, dpr, designWidth, anchors });
  const geometry = scaleResult.scale ? screenGeometry(frame, scaleResult.scale, anchors) : null;
  if (geometry?.originAssumed.x || geometry?.originAssumed.y) warnings.push('The frame is cropped and no anchor gives a CSS position; its visible edge is taken as CSS 0');
  return {
    kind: resolvedKind,
    image: { width: raster.width, height: raster.height },
    backdrop,
    framesDetected: frames.length,
    frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height, cropped: frame.cropped, ...(frame.sides ? { sides: frame.sides } : {}) },
    scale: scaleResult,
    geometry,
    warnings,
  };
}
