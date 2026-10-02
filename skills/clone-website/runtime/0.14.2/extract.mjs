import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { launchBrowser } from './browser.mjs';
import { cropRaster, toPng } from './image.mjs';

// Crops of screenshots are placeholders for assets nobody has supplied. Every
// crop is recorded with its source coordinates and an unverified rights
// status; brand marks need an explicit approval from the user.

export const ASSET_KINDS = Object.freeze({
  photo: 'Likely stock or client photography. Replace it with a licensed image before publishing.',
  avatar: "A person's likeness. Replace it with your own image or initials.",
  illustration: 'Artwork from the mock-up. Confirm its licence or redraw it.',
  texture: 'A background or pattern from the mock-up. Confirm its licence.',
  logo: 'A brand mark of the reference. Rename and re-mark it before shipping a product.',
  'brand-mark': 'A brand mark of the reference. Rename and re-mark it before shipping a product.',
});
const BRAND_KINDS = new Set(['logo', 'brand-mark']);
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

function downsample(level) {
  const width = Math.ceil(level.width / 2);
  const height = Math.ceil(level.height / 2);
  const data = new Float32Array(width * height * 3);
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sum = [0, 0, 0];
      let known = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const sourceX = 2 * x + dx;
        const sourceY = 2 * y + dy;
        if (sourceX >= level.width || sourceY >= level.height) continue;
        const index = sourceY * level.width + sourceX;
        if (level.mask[index]) continue;
        for (let channel = 0; channel < 3; channel += 1) sum[channel] += level.data[index * 3 + channel];
        known += 1;
      }
      const index = y * width + x;
      if (known) for (let channel = 0; channel < 3; channel += 1) data[index * 3 + channel] = sum[channel] / known;
      else mask[index] = 1;
    }
  }
  return { width, height, data, mask };
}

// Gauss-Seidel sweeps: each unknown pixel becomes the mean of its neighbours.
function relax(level, unknown, iterations) {
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let index = 0; index < unknown.length; index += 1) {
      if (!unknown[index]) continue;
      const x = index % level.width;
      const y = (index - x) / level.width;
      const sum = [0, 0, 0];
      let count = 0;
      for (const neighbour of [x > 0 ? index - 1 : -1, x < level.width - 1 ? index + 1 : -1, y > 0 ? index - level.width : -1, y < level.height - 1 ? index + level.width : -1]) {
        if (neighbour < 0) continue;
        for (let channel = 0; channel < 3; channel += 1) sum[channel] += level.data[neighbour * 3 + channel];
        count += 1;
      }
      for (let channel = 0; channel < 3; channel += 1) level.data[index * 3 + channel] = sum[channel] / count;
    }
  }
}

// Fills masked pixels from their known surroundings, coarse to fine, like a
// repeated blur that never changes a known pixel. Good for smooth photo
// background behind a badge; it cannot invent detail.
export function inpaint(raster, mask) {
  if (mask.length !== raster.width * raster.height) throw new Error('The mask must have one entry per pixel');
  const base = { width: raster.width, height: raster.height, data: new Float32Array(raster.width * raster.height * 3), mask: Uint8Array.from(mask) };
  for (let index = 0; index < mask.length; index += 1) {
    for (let channel = 0; channel < 3; channel += 1) base.data[index * 3 + channel] = raster.data[index * 4 + channel];
  }
  if (base.mask.every(Boolean)) throw new Error('Nothing outside the occluded areas is left to fill from');
  const levels = [base];
  while (levels.at(-1).mask.some(Boolean) && Math.max(levels.at(-1).width, levels.at(-1).height) > 4) levels.push(downsample(levels.at(-1)));
  const coarsest = levels.at(-1);
  if (coarsest.mask.some(Boolean)) {
    const mean = [0, 0, 0];
    let known = 0;
    for (let index = 0; index < coarsest.mask.length; index += 1) {
      if (coarsest.mask[index]) continue;
      for (let channel = 0; channel < 3; channel += 1) mean[channel] += coarsest.data[index * 3 + channel];
      known += 1;
    }
    for (let index = 0; index < coarsest.mask.length; index += 1) {
      if (coarsest.mask[index]) for (let channel = 0; channel < 3; channel += 1) coarsest.data[index * 3 + channel] = mean[channel] / known;
    }
    relax(coarsest, coarsest.mask, 50);
  }
  for (let levelIndex = levels.length - 2; levelIndex >= 0; levelIndex -= 1) {
    const fine = levels[levelIndex];
    const coarse = levels[levelIndex + 1];
    for (let index = 0; index < fine.mask.length; index += 1) {
      if (!fine.mask[index]) continue;
      const x = index % fine.width;
      const y = (index - x) / fine.width;
      const coarseIndex = Math.min(coarse.height - 1, y >> 1) * coarse.width + Math.min(coarse.width - 1, x >> 1);
      for (let channel = 0; channel < 3; channel += 1) fine.data[index * 3 + channel] = coarse.data[coarseIndex * 3 + channel];
    }
    relax(fine, fine.mask, 20);
  }
  const output = { width: raster.width, height: raster.height, data: Buffer.from(raster.data) };
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    for (let channel = 0; channel < 3; channel += 1) output.data[index * 4 + channel] = Math.round(Math.min(255, Math.max(0, base.data[index * 3 + channel])));
    output.data[index * 4 + 3] = 255;
  }
  return output;
}

async function encode(raster, mime, browser) {
  if (mime === 'image/png') return toPng(raster);
  const ownBrowser = browser ? null : await launchBrowser({ headless: true });
  const page = await (browser ?? ownBrowser).newPage();
  try {
    const bytes = await page.evaluate(async ({ base64, type }) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      return [...new Uint8Array(await (await canvas.convertToBlob({ type, quality: 0.92 })).arrayBuffer())];
    }, { base64: toPng(raster).toString('base64'), type: mime });
    return Buffer.from(bytes);
  } finally {
    await page.close().catch(() => {});
    await ownBrowser?.close().catch(() => {});
  }
}

function nativeRect(geometry, box) {
  const left = Math.floor(geometry.origin.x + box[0] * geometry.scale);
  const top = Math.floor(geometry.origin.y + box[1] * geometry.scale);
  return { x: left, y: top, width: Math.ceil(geometry.origin.x + box[2] * geometry.scale) - left, height: Math.ceil(geometry.origin.y + box[3] * geometry.scale) - top };
}

// Crops a CSS box from the native screenshot at full resolution and fills the
// occluded boxes (badges, menus, cursors drawn over a photo) by diffusion.
export async function extractAsset({ raster, geometry, box, occlude = [], output, browser = null }) {
  const mime = MIME[extname(output).toLowerCase()];
  if (!mime) throw new Error('The output must end in .png, .jpg, .jpeg, or .webp');
  const rect = nativeRect(geometry, box);
  const crop = cropRaster(raster, rect);
  const mask = new Uint8Array(crop.width * crop.height);
  for (const occluder of occlude) {
    // One extra pixel covers the occluder's antialiased edge.
    const area = nativeRect(geometry, occluder);
    for (let y = Math.max(0, area.y - rect.y - 1); y < Math.min(crop.height, area.y - rect.y + area.height + 1); y += 1) {
      for (let x = Math.max(0, area.x - rect.x - 1); x < Math.min(crop.width, area.x - rect.x + area.width + 1); x += 1) mask[y * crop.width + x] = 1;
    }
  }
  const occludedPixels = mask.reduce((sum, value) => sum + value, 0);
  const filled = occludedPixels ? inpaint(crop, mask) : crop;
  const bytes = await encode(filled, mime, browser);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, bytes);
  return { output, width: filled.width, height: filled.height, nativeRect: rect, occludedPixels, bytes: bytes.byteLength };
}

const MANIFEST_HEADER = `# Artifact manifest

Assets cropped from the reference screenshots. Every row needs a licence check
or a replacement before publishing.

| Asset | Path | Origin | Rights status |
|---|---|---|---|
`;

// Appends the crop to ARTIFACT_MANIFEST.md and extracted-assets.json in the
// site research folder. `rights` lists the JSON records.
export function recordExtractedAsset({ root, siteKey, record }) {
  const directory = resolve(root, 'docs', 'research', siteKey);
  mkdirSync(directory, { recursive: true });
  const manifestPath = resolve(directory, 'ARTIFACT_MANIFEST.md');
  const recordsPath = resolve(directory, 'extracted-assets.json');
  const records = existsSync(recordsPath) ? JSON.parse(readFileSync(recordsPath, 'utf8')) : [];
  const path = relative(root, record.output);
  const entry = { ...record, output: path };
  writeFileSync(recordsPath, `${JSON.stringify([...records.filter((existing) => existing.output !== path), entry], null, 2)}\n`);
  const occluders = record.occlude.length ? ` ${record.occlude.length} occluded area(s) filled by diffusion.` : '';
  const approval = record.approved ? ' Extraction approved by the user.' : '';
  const row = `| ${record.name} (${record.kind}) | \`${path}\` (${record.width} × ${record.height}) | Crop of \`${record.image}\` (page ${record.page}, CSS ${record.box.join(', ')}).${occluders} | **Unverified.** ${ASSET_KINDS[record.kind]}${approval} |\n`;
  writeFileSync(manifestPath, `${existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : MANIFEST_HEADER}${row}`);
  return { manifestPath, recordsPath, entry };
}

export function assertExtractionAllowed(kind, approved) {
  if (!ASSET_KINDS[kind]) throw new Error(`--kind must be one of ${Object.keys(ASSET_KINDS).join(', ')}`);
  if (BRAND_KINDS.has(kind) && !approved) throw new Error('Brand marks are not copied without approval. Ask the user, then pass --approved, or redraw the mark');
}
