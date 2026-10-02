import { PNG } from 'pngjs';
import { launchBrowser } from './browser.mjs';
import { readPng } from './visual-regions.mjs';

// A raster is RGBA, row-major, eight bits per channel.

const FORMATS = [
  ['png', 'image/png', (bytes) => bytes.length > 8 && bytes.readUInt32BE(0) === 0x89504e47],
  ['jpeg', 'image/jpeg', (bytes) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
  ['webp', 'image/webp', (bytes) => bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'],
  ['avif', 'image/avif', (bytes) => bytes.length > 12 && bytes.toString('ascii', 4, 8) === 'ftyp' && /^avi[fs]$/u.test(bytes.toString('ascii', 8, 12))],
  ['gif', 'image/gif', (bytes) => bytes.length > 6 && bytes.toString('ascii', 0, 3) === 'GIF'],
];

export function imageFormat(bytes) {
  const match = FORMATS.find(([, , test]) => test(bytes));
  return match ? { format: match[0], mime: match[1] } : null;
}

// Chunks that make a browser colour-manage a PNG. Without them the stored
// values are already what a browser displays.
function pngHasColorProfile(bytes) {
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'iCCP' || type === 'cICP') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    offset += 12 + length;
  }
  return false;
}

export function createRaster(width, height, fill = [0, 0, 0, 255]) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error(`Invalid raster size ${width}x${height}`);
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < data.length; index += 4) data.set(fill, index);
  return { width, height, data };
}

export function rasterFromPng(bytes, label = 'image') {
  const png = readPng(bytes, label);
  return { width: png.width, height: png.height, data: png.data };
}

export function toPng(raster) {
  const png = new PNG({ width: raster.width, height: raster.height });
  raster.data.copy(png.data);
  return PNG.sync.write(png);
}

export function colorAt(raster, x, y) {
  const offset = (y * raster.width + x) * 4;
  return [raster.data[offset], raster.data[offset + 1], raster.data[offset + 2]];
}

export function colorDistance(left, right) {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

export function luminance(color) {
  return 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
}

export function median(values) {
  if (!values.length) return null;
  const sorted = Float64Array.from(values).sort();
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function medianColor(colors) {
  return [0, 1, 2].map((channel) => median(colors.map((color) => color[channel])));
}

export function averageColor(colors) {
  return [0, 1, 2].map((channel) => colors.reduce((sum, color) => sum + color[channel], 0) / colors.length);
}

export function hexColor(color) {
  return `#${color.map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, '0')).join('')}`;
}

// Sub-pixel position of a step edge by the area method: across a window that
// starts on the outside plateau and ends on the inside plateau, the summed
// inside coverage equals the distance from the edge to the window end. It is
// exact for antialiased edges and for any symmetric blur. Pixel k covers
// [k, k + 1) in profile units.
export function stepEdgePosition(profile, start, end, outside, inside) {
  const axis = [inside[0] - outside[0], inside[1] - outside[1], inside[2] - outside[2]];
  const length2 = axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2;
  if (length2 === 0) return null;
  let covered = 0;
  for (let index = start; index <= end; index += 1) {
    const color = profile[index];
    const t = ((color[0] - outside[0]) * axis[0] + (color[1] - outside[1]) * axis[1] + (color[2] - outside[2]) * axis[2]) / length2;
    covered += Math.min(1, Math.max(0, t));
  }
  return end + 1 - covered;
}

// Integer crop, clamped to the raster.
export function cropRaster(raster, { x, y, width, height }) {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(raster.width, Math.floor(x) + Math.round(width));
  const bottom = Math.min(raster.height, Math.floor(y) + Math.round(height));
  if (right <= left || bottom <= top) throw new Error('Crop is outside the image');
  const output = { width: right - left, height: bottom - top, data: Buffer.alloc((right - left) * (bottom - top) * 4) };
  for (let row = top; row < bottom; row += 1) {
    raster.data.copy(output.data, (row - top) * output.width * 4, (row * raster.width + left) * 4, (row * raster.width + right) * 4);
  }
  return output;
}

// Overlap weights of each output cell with the source pixels it covers.
function axisWeights(start, length, outputLength, limit) {
  const step = length / outputLength;
  return Array.from({ length: outputLength }, (_, index) => {
    const from = start + index * step;
    const to = from + step;
    const weights = [];
    for (let pixel = Math.max(0, Math.floor(from)); pixel < Math.min(limit, Math.ceil(to)); pixel += 1) {
      const overlap = Math.min(to, pixel + 1) - Math.max(from, pixel);
      if (overlap > 0) weights.push([pixel, overlap]);
    }
    const total = weights.reduce((sum, [, weight]) => sum + weight, 0) || 1;
    return weights.map(([pixel, weight]) => [pixel, weight / total]);
  });
}

// Area-average resampling of a continuous source rectangle. The normalized
// 1x references use it; all measurements run on native pixels instead.
export function resampleRegion(raster, { x, y, width, height }, outputWidth, outputHeight) {
  const columns = axisWeights(x, width, outputWidth, raster.width);
  const rows = axisWeights(y, height, outputHeight, raster.height);
  const horizontal = new Float32Array(outputWidth * raster.height * 4);
  for (let row = 0; row < raster.height; row += 1) {
    for (let column = 0; column < outputWidth; column += 1) {
      const target = (row * outputWidth + column) * 4;
      for (const [pixel, weight] of columns[column]) {
        const source = (row * raster.width + pixel) * 4;
        for (let channel = 0; channel < 4; channel += 1) horizontal[target + channel] += raster.data[source + channel] * weight;
      }
    }
  }
  const output = { width: outputWidth, height: outputHeight, data: Buffer.alloc(outputWidth * outputHeight * 4) };
  for (let row = 0; row < outputHeight; row += 1) {
    for (let column = 0; column < outputWidth; column += 1) {
      const target = (row * outputWidth + column) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        let value = 0;
        for (const [pixel, weight] of rows[row]) value += horizontal[(pixel * outputWidth + column) * 4 + channel] * weight;
        output.data[target + channel] = Math.round(Math.min(255, Math.max(0, value)));
      }
    }
  }
  return output;
}

async function browserDecodeToPng(browser, bytes, mime) {
  const page = await browser.newPage();
  try {
    // Chromium decodes the image and converts it to sRGB, as a browser shows it.
    const dataUrl = await page.evaluate(async ({ base64, type }) => {
      const blob = await (await fetch(`data:${type};base64,${base64}`)).blob();
      const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none' });
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext('2d', { colorSpace: 'srgb' }).drawImage(bitmap, 0, 0);
      const png = await canvas.convertToBlob({ type: 'image/png' });
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(png);
      });
    }, { base64: bytes.toString('base64'), type: mime });
    return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  } finally {
    await page.close().catch(() => {});
  }
}

// PNGs without a colour profile are read directly. Other formats, and PNGs
// with a profile, are decoded by Chromium. Pass `browser` to reuse one.
export async function decodeImage(bytes, { browser = null } = {}) {
  const detected = imageFormat(bytes);
  if (!detected) throw new Error('Unsupported image format; use PNG, JPEG, WebP, AVIF, or GIF');
  if (detected.format === 'png' && !pngHasColorProfile(bytes)) {
    return { raster: rasterFromPng(bytes), format: 'png', colorManaged: false };
  }
  const ownBrowser = browser ? null : await launchBrowser({ headless: true });
  try {
    const png = await browserDecodeToPng(browser ?? ownBrowser, bytes, detected.mime);
    return { raster: rasterFromPng(png), format: detected.format, colorManaged: true };
  } finally {
    await ownBrowser?.close().catch(() => {});
  }
}
