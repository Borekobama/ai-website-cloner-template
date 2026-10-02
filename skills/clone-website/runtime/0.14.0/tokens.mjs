import { COMPUTED_STYLES } from './dom-snapshot.mjs';

export const TOKENS_SCHEMA_VERSION = 1;

const LIMITS = Object.freeze({ colors: 16, fontFamilies: 6, fontSizes: 16, fontWeights: 8, lineHeights: 12, letterSpacings: 8, radii: 10, shadows: 8, spacing: 24 });
const TRANSPARENT = new Set(['transparent', 'rgba(0, 0, 0, 0)']);
const RADIUS_PROPERTIES = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'];
const SPACING_PROPERTIES = [
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'row-gap', 'column-gap',
];

function* layoutStyles(observation) {
  // Older evidence recorded a prefix of the current list, so positional
  // decoding stays valid when the property list is absent.
  const properties = observation.computedStyles ?? COMPUTED_STYLES;
  const strings = observation.snapshot?.strings ?? [];
  for (const document of observation.snapshot?.documents ?? []) {
    for (const indices of document.layout?.styles ?? []) {
      const style = {};
      properties.forEach((property, position) => {
        const index = indices?.[position];
        if (Number.isInteger(index) && index >= 0 && index < strings.length) style[property] = strings[index];
      });
      yield style;
    }
  }
}

function counter() {
  const counts = new Map();
  return {
    add(value) {
      if (value === undefined || value === null || value === '') return;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    },
    top(limit) {
      return [...counts.entries()]
        .sort(([leftValue, leftCount], [rightValue, rightCount]) => rightCount - leftCount || String(leftValue).localeCompare(String(rightValue)))
        .slice(0, limit)
        .map(([value, count]) => ({ value, count }));
    },
    get size() {
      return counts.size;
    },
  };
}

function positivePixels(value) {
  const match = /^(-?\d+(?:\.\d+)?)px$/u.exec(String(value ?? ''));
  return match && Number(match[1]) > 0 ? value : null;
}

export function extractDesignTokens(observations = [], { runId = null, siteKey = null } = {}) {
  const text = counter();
  const surface = counter();
  const border = counter();
  const fontFamilies = counter();
  const fontSizes = counter();
  const fontWeights = counter();
  const lineHeights = counter();
  const letterSpacings = counter();
  const radii = counter();
  const shadows = counter();
  const spacing = counter();
  let nodesAnalyzed = 0;
  const routes = [];
  for (const observation of observations) {
    routes.push(observation.route ?? null);
    for (const style of layoutStyles(observation)) {
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      nodesAnalyzed += 1;
      if (!TRANSPARENT.has(style.color)) text.add(style.color);
      if (!TRANSPARENT.has(style['background-color'])) surface.add(style['background-color']);
      if (positivePixels(style['border-top-width']) && !TRANSPARENT.has(style['border-top-color'])) border.add(style['border-top-color']);
      fontFamilies.add(style['font-family']);
      fontSizes.add(style['font-size']);
      fontWeights.add(style['font-weight']);
      if (style['line-height'] !== 'normal') lineHeights.add(style['line-height']);
      if (style['letter-spacing'] !== 'normal' && style['letter-spacing'] !== '0px') letterSpacings.add(style['letter-spacing']);
      for (const property of RADIUS_PROPERTIES) radii.add(positivePixels(style[property]));
      if (style['box-shadow'] !== 'none') shadows.add(style['box-shadow']);
      for (const property of SPACING_PROPERTIES) spacing.add(positivePixels(style[property]));
    }
  }
  return {
    schemaVersion: TOKENS_SCHEMA_VERSION,
    kind: 'design-tokens',
    derived: true,
    sourceRunId: runId,
    siteKey,
    routes,
    nodesAnalyzed,
    colors: { text: text.top(LIMITS.colors), surface: surface.top(LIMITS.colors), border: border.top(LIMITS.colors) },
    typography: {
      fontFamilies: fontFamilies.top(LIMITS.fontFamilies),
      fontSizes: fontSizes.top(LIMITS.fontSizes),
      fontWeights: fontWeights.top(LIMITS.fontWeights),
      lineHeights: lineHeights.top(LIMITS.lineHeights),
      letterSpacings: letterSpacings.top(LIMITS.letterSpacings),
    },
    radii: radii.top(LIMITS.radii),
    shadows: shadows.top(LIMITS.shadows),
    spacing: spacing.top(LIMITS.spacing),
  };
}

function table(rows, heading, countLabel = 'Nodes') {
  if (!rows.length) return `_No ${heading.toLowerCase()} observed._\n`;
  return `| ${heading} | ${countLabel} |\n| --- | ---: |\n${rows.map((row) => `| \`${String(row.value).replace(/\|/gu, '\\|')}\` | ${row.count} |`).join('\n')}\n`;
}

export function renderDesignTokensMarkdown(tokens) {
  const image = tokens.evidence === 'image';
  const sections = [
    ['Text colors', tokens.colors.text],
    ['Surface colors', tokens.colors.surface],
    ['Border colors', tokens.colors.border],
    ['Font families', tokens.typography.fontFamilies],
    ['Font sizes', tokens.typography.fontSizes],
    ['Font weights', tokens.typography.fontWeights],
    ['Line heights', tokens.typography.lineHeights],
    ['Letter spacing', tokens.typography.letterSpacings],
    ['Corner radii', tokens.radii],
    ['Shadows', tokens.shadows],
    ['Spacing', tokens.spacing],
  ];
  return [
    '# Design tokens',
    '',
    image
      ? `Derived from screenshot pixels in image run \`${tokens.sourceRunId}\` for ${tokens.routes.length} page(s); counts are CSS pixels.`
      : `Derived from DOMSnapshot evidence in run \`${tokens.sourceRunId}\` for ${tokens.routes.length} route(s) and ${tokens.nodesAnalyzed} rendered nodes.`,
    image
      ? 'This is a builder contract, not measurement evidence. Surface colours come from flat areas and text colours from stroke cores; type, radii, and spacing come from `fonts fit` and `analyze layout`.'
      : 'This is a builder contract, not measurement evidence. Values are ranked by how many rendered nodes use them.',
    'Rename tokens by role before use, and re-check the source when a value looks wrong.',
    '',
    ...sections.flatMap(([heading, rows]) => [`## ${heading}`, '', table(rows, heading, image ? 'Pixels' : 'Nodes')]),
  ].join('\n');
}

function themeVariables(prefix, rows) {
  return rows.map((row, index) => `  --${prefix}-${index + 1}: ${row.value};`);
}

export function renderThemeCss(tokens) {
  const lines = [
    ...themeVariables('color-text', tokens.colors.text),
    ...themeVariables('color-surface', tokens.colors.surface),
    ...themeVariables('color-border', tokens.colors.border),
    ...themeVariables('font', tokens.typography.fontFamilies),
    ...themeVariables('text', tokens.typography.fontSizes),
    ...themeVariables('font-weight', tokens.typography.fontWeights),
    ...themeVariables('leading', tokens.typography.lineHeights),
    ...themeVariables('tracking', tokens.typography.letterSpacings),
    ...themeVariables('radius', tokens.radii),
    ...themeVariables('shadow', tokens.shadows),
    ...themeVariables('spacing', tokens.spacing),
  ];
  return `/* Draft Tailwind v4 theme derived from run ${tokens.sourceRunId}.
   Tokens are numbered by frequency; rename them by role before use. */
@theme {
${lines.join('\n')}
}
`;
}
