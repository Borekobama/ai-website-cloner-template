import { colorDistance, hexColor } from './image.mjs';
import { probeRadius } from './probes.mjs';
import { TOKENS_SCHEMA_VERSION } from './tokens.mjs';

// Builder drafts from screenshot pixels. Nothing here is evidence or a gate:
// the palette feeds design tokens, and the layout skeleton suggests panels,
// spacing, and radii for the person or agent writing DESIGN.md.

const MERGE_DISTANCE = 4;
const MAX_CLUSTERS = 256;

function luminanceMap(raster) {
  const values = new Float32Array(raster.width * raster.height);
  for (let index = 0; index < values.length; index += 1) {
    const offset = index * 4;
    values[index] = 0.2126 * raster.data[offset] + 0.7152 * raster.data[offset + 1] + 0.0722 * raster.data[offset + 2];
  }
  return values;
}

function addColor(counts, data, offset, weight) {
  const key = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
  const entry = counts.get(key);
  if (entry) entry.count += weight;
  else counts.set(key, { color: [data[offset], data[offset + 1], data[offset + 2]], count: weight });
}

// Exact colours, most frequent first, merge into clusters within a small RGB
// distance. Compression noise of a screenshot stays inside one cluster.
function clusterColors(counts, { limit = 16, minShare = 0.0005 } = {}) {
  const entries = [...counts.values()].sort((left, right) => right.count - left.count);
  const total = entries.reduce((sum, entry) => sum + entry.count, 0);
  const clusters = [];
  for (const entry of entries) {
    const cluster = clusters.find((candidate) => colorDistance(candidate.color, entry.color) <= MERGE_DISTANCE);
    if (cluster) {
      cluster.count += entry.count;
    } else if (clusters.length < MAX_CLUSTERS) {
      clusters.push({ color: entry.color, count: entry.count });
    }
  }
  return clusters
    .filter((cluster) => total && cluster.count / total >= minShare)
    .sort((left, right) => right.count - left.count)
    .slice(0, limit)
    .map((cluster) => ({ value: hexColor(cluster.color), count: Math.round(cluster.count) }));
}

// Surfaces are flat pixels (equal to all four neighbours within 3 levels).
// Text cores are local luminance extremes that differ by at least 80 levels
// from most of the 5 x 5 pixels around them, so the background next to a thin
// stroke does not count as light text. Counts are CSS pixels.
export function analyzePalette(pages, { runId = null, siteKey = null } = {}) {
  const surfaces = new Map();
  const text = new Map();
  let flatPixels = 0;
  for (const { raster, geometry } of pages) {
    const { width, height, data } = raster;
    const weight = 1 / geometry.scale ** 2;
    const lum = luminanceMap(raster);
    for (let y = 2; y < height - 2; y += 1) {
      for (let x = 2; x < width - 2; x += 1) {
        const index = y * width + x;
        const offset = index * 4;
        let flat = true;
        for (const neighbour of [index - 1, index + 1, index - width, index + width]) {
          const other = neighbour * 4;
          if (Math.abs(data[offset] - data[other]) > 3 || Math.abs(data[offset + 1] - data[other + 1]) > 3 || Math.abs(data[offset + 2] - data[other + 2]) > 3) {
            flat = false;
            break;
          }
        }
        if (flat) {
          addColor(surfaces, data, offset, weight);
          flatPixels += weight;
          continue;
        }
        let brighter = 0;
        let darker = 0;
        let isMinimum = true;
        let isMaximum = true;
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const value = lum[index + dy * width + dx];
            if (value >= lum[index] + 80) brighter += 1;
            if (value <= lum[index] - 80) darker += 1;
            if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && (dx || dy)) {
              if (value < lum[index]) isMinimum = false;
              if (value > lum[index]) isMaximum = false;
            }
          }
        }
        if ((isMinimum && brighter >= 13) || (isMaximum && darker >= 13)) addColor(text, data, offset, weight);
      }
    }
  }
  return {
    schemaVersion: TOKENS_SCHEMA_VERSION,
    kind: 'design-tokens',
    derived: true,
    evidence: 'image',
    sourceRunId: runId,
    siteKey,
    routes: pages.map((page) => page.page),
    pixelsAnalyzed: Math.round(flatPixels),
    colors: { text: clusterColors(text), surface: clusterColors(surfaces), border: [] },
    typography: { fontFamilies: [], fontSizes: [], fontWeights: [], lineHeights: [], letterSpacings: [] },
    radii: [],
    shadows: [],
    spacing: [],
  };
}

function histogram(values, limit = 12) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([leftValue, leftCount], [rightValue, rightCount]) => rightCount - leftCount || leftValue - rightValue)
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

const overlap = (start0, end0, start1, end1) => Math.min(end0, end1) - Math.max(start0, start1);

// Panels are connected regions of one colour: cards, sidebars, inputs, and
// badges. They are found on native pixels and reported in CSS pixels, so the
// fractional origin of a presentation shot does not blur the spacing. Gaps
// between neighbours and insets inside parents suggest the spacing scale. The
// page background is left out.
export function analyzeLayout(raster, { geometry = { origin: { x: 0, y: 0 }, scale: 1 }, tolerance = 3, minArea = 400, limit = 80 } = {}) {
  const { width, height, data } = raster;
  const labels = new Int32Array(width * height).fill(-1);
  const queue = new Int32Array(width * height);
  const components = [];
  for (let start = 0; start < labels.length; start += 1) {
    if (labels[start] !== -1) continue;
    const seed = start * 4;
    const component = { x0: width, y0: height, x1: -1, y1: -1, area: 0, color: [data[seed], data[seed + 1], data[seed + 2]] };
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = components.length;
    while (head < tail) {
      const cell = queue[head++];
      const x = cell % width;
      const y = (cell - x) / width;
      component.x0 = Math.min(component.x0, x);
      component.x1 = Math.max(component.x1, x);
      component.y0 = Math.min(component.y0, y);
      component.y1 = Math.max(component.y1, y);
      component.area += 1;
      for (const next of [x > 0 ? cell - 1 : -1, x < width - 1 ? cell + 1 : -1, y > 0 ? cell - width : -1, y < height - 1 ? cell + width : -1]) {
        if (next < 0 || labels[next] !== -1) continue;
        const offset = next * 4;
        if (Math.abs(data[offset] - data[seed]) > tolerance || Math.abs(data[offset + 1] - data[seed + 1]) > tolerance || Math.abs(data[offset + 2] - data[seed + 2]) > tolerance) continue;
        labels[next] = components.length;
        queue[tail++] = next;
      }
    }
    components.push(component);
  }
  const pageArea = width * height;
  const css = (value, axis) => Math.round(((value - geometry.origin[axis]) / geometry.scale) * 2) / 2;
  const panels = components
    .filter((component) => {
      const boxArea = (component.x1 + 1 - component.x0) * (component.y1 + 1 - component.y0);
      return component.area >= minArea * geometry.scale ** 2 && component.area / boxArea >= 0.5 && boxArea < 0.9 * pageArea;
    })
    .sort((left, right) => right.area - left.area)
    .slice(0, limit)
    .map((component) => {
      const box = [css(component.x0, 'x'), css(component.y0, 'y'), css(component.x1 + 1, 'x'), css(component.y1 + 1, 'y')];
      const radius = probeRadius(raster, geometry, { box, corner: 'tl', maxRadius: Math.min(48, (box[2] - box[0]) / 2, (box[3] - box[1]) / 2) });
      return { box, fill: hexColor(component.color), area: Math.round(component.area / geometry.scale ** 2), radius: radius.radius === null ? null : Math.round(radius.radius) };
    });
  const contains = (outer, inner) => outer !== inner && outer.box[0] <= inner.box[0] + 1 && outer.box[1] <= inner.box[1] + 1 && outer.box[2] >= inner.box[2] - 1 && outer.box[3] >= inner.box[3] - 1;
  for (const panel of panels) {
    panel.parent = panels
      .filter((candidate) => contains(candidate, panel))
      .sort((left, right) => left.area - right.area)[0] ?? null;
  }
  const gaps = [];
  const insets = [];
  for (const panel of panels) {
    const siblings = panels.filter((other) => other !== panel && other.parent === panel.parent);
    const right = siblings
      .filter((other) => other.box[0] >= panel.box[2] && overlap(panel.box[1], panel.box[3], other.box[1], other.box[3]) > 0.5 * Math.min(panel.box[3] - panel.box[1], other.box[3] - other.box[1]))
      .sort((left, other) => left.box[0] - other.box[0])[0];
    if (right && right.box[0] - panel.box[2] <= 96) gaps.push(Math.round(right.box[0] - panel.box[2]));
    const below = siblings
      .filter((other) => other.box[1] >= panel.box[3] && overlap(panel.box[0], panel.box[2], other.box[0], other.box[2]) > 0.5 * Math.min(panel.box[2] - panel.box[0], other.box[2] - other.box[0]))
      .sort((left, other) => left.box[1] - other.box[1])[0];
    if (below && below.box[1] - panel.box[3] <= 96) gaps.push(Math.round(below.box[1] - panel.box[3]));
    if (panel.parent) {
      for (const inset of [panel.box[0] - panel.parent.box[0], panel.box[1] - panel.parent.box[1]]) if (inset > 0 && inset <= 64) insets.push(Math.round(inset));
    }
  }
  return {
    panels: panels.map(({ parent, ...panel }) => ({ ...panel, parent: parent ? panels.indexOf(parent) : null })),
    gaps: histogram(gaps),
    insets: histogram(insets),
    radii: histogram(panels.map((panel) => panel.radius).filter((radius) => radius !== null && radius > 0)),
  };
}

export function renderLayoutMarkdown(pages, { runId = null } = {}) {
  const values = (rows) => (rows.length ? rows.map((row) => `${row.value} px (${row.count})`).join(', ') : 'none found');
  return [
    '# Layout skeleton',
    '',
    `Derived from the native screenshot crops in image run \`${runId}\`, in CSS pixels. This is a builder draft, not evidence: panels are regions of one flat colour, so a card with a gradient or a photo is missing, and two touching panels of the same colour merge.`,
    '',
    ...pages.flatMap(({ page, route, layout }) => [
      `## ${page} (\`${route}\`)`,
      '',
      `- Gaps between neighbouring panels: ${values(layout.gaps)}`,
      `- Insets inside a parent panel: ${values(layout.insets)}`,
      `- Corner radii: ${values(layout.radii)}`,
      '',
      '| # | Box (x0, y0, x1, y1) | Fill | Radius | Parent |',
      '| ---: | --- | --- | ---: | ---: |',
      ...layout.panels.slice(0, 20).map((panel, index) => `| ${index} | ${panel.box.join(', ')} | \`${panel.fill}\` | ${panel.radius ?? '—'} | ${panel.parent ?? '—'} |`),
      '',
    ]),
  ].join('\n');
}
