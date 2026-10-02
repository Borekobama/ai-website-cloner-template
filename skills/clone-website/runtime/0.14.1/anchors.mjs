import { readFileSync } from 'node:fs';
import { colorDistance, rasterFromPng, resampleRegion, toPng } from './image.mjs';
import { evaluateAction } from './policy.mjs';
import { probeColor, probeEdges, probeInkBox, probeInkRuns, probeRadius } from './probes.mjs';
import { hashJson, readArtifact, readManifest } from './run-store.mjs';
import { compareVisualRegionImages } from './visual-regions.mjs';

// Image parity compares a clone with screenshot evidence. Anchors are named
// probes that run the same way on the reference and on a clone capture taken
// at the reference's own scale; regions are CSS boxes compared pixel by pixel.
// There is no whole-page score: a region that covers most of the page must
// stay informational.

export const ANCHORS_SCHEMA_VERSION = 1;
const PROBES = { edges: probeEdges, runs: probeInkRuns, box: probeInkBox, color: probeColor, radius: probeRadius };
const DEFAULT_PICK = { edges: 'edges.0.position', runs: 'runs.0.start', box: 'width', radius: 'radius' };
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/iu;
const STATE_ACTIONS = new Set(['click', 'hover', 'focus']);
const MASK_COLOR = [255, 0, 255];

function cssBox(value, label) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite) || value[2] <= value[0] || value[3] <= value[1]) {
    throw new Error(`${label} must be [x0, y0, x1, y1] in CSS pixels with x1 > x0 and y1 > y0`);
  }
  return [...value];
}

function unitInterval(value, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1`);
  return value;
}

function normalizeAnchor(anchor, label) {
  const id = String(anchor?.id ?? '');
  if (!SAFE_ID.test(id)) throw new Error(`${label} needs a safe id`);
  const { type, ...parameters } = anchor.probe ?? {};
  if (!PROBES[type]) throw new Error(`${label} probe type must be edges, runs, box, color, or radius`);
  const pick = String(anchor.pick ?? DEFAULT_PICK[type] ?? (parameters.mode && parameters.mode !== 'flat' ? 'ink' : 'median'));
  const mode = anchor.mode ?? 'gate';
  if (!['gate', 'informational'].includes(mode)) throw new Error(`${label} mode must be gate or informational`);
  const colour = type === 'color';
  const tolerance = anchor.tolerance ?? (colour ? 6 : 1);
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error(`${label} tolerance must be a non-negative number`);
  return { id, probe: { type, ...parameters }, pick, tolerance, mode };
}

function normalizeRegion(region, label, pageArea) {
  const id = String(region?.id ?? '');
  if (!SAFE_ID.test(id)) throw new Error(`${label} needs a safe id`);
  const box = cssBox(region.box, `${label} box`);
  const mode = region.mode ?? 'informational';
  if (!['gate', 'informational'].includes(mode)) throw new Error(`${label} mode must be gate or informational`);
  const area = (box[2] - box[0]) * (box[3] - box[1]);
  if (mode === 'gate' && pageArea && area >= 0.9 * pageArea) throw new Error(`${label} covers most of the page; a whole-page region can only be informational`);
  const masks = (region.masks ?? []).map((mask, index) => cssBox(mask, `${label} mask ${index + 1}`));
  return {
    id,
    box,
    mode,
    // Presentation shots are resampled and compressed, so the defaults are looser
    // than for live visual regions.
    threshold: unitInterval(region.threshold, 0.02, `${label} threshold`),
    pixelThreshold: unitInterval(region.pixelThreshold, 0.2, `${label} pixelThreshold`),
    ...(masks.length ? { masks } : {}),
  };
}

export function normalizeAnchorsConfig(value) {
  const config = typeof value === 'string' ? JSON.parse(readFileSync(value, 'utf8')) : value;
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('The anchors config must be an object');
  const schemaVersion = config.schemaVersion ?? ANCHORS_SCHEMA_VERSION;
  if (schemaVersion !== ANCHORS_SCHEMA_VERSION) throw new Error(`Unsupported anchors schema version: ${schemaVersion}`);
  if (!Array.isArray(config.pages) || !config.pages.length) throw new Error('The anchors config needs a non-empty pages array');
  const seen = new Set();
  const pages = config.pages.map((entry, index) => {
    const label = `Anchors page ${index + 1}`;
    const page = String(entry?.page ?? '');
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(page)) throw new Error(`${label} needs the page key from screens.json`);
    if (seen.has(page)) throw new Error(`${label} repeats page ${page}`);
    seen.add(page);
    let viewport = null;
    if (entry.viewport !== undefined) {
      if (!Number.isInteger(entry.viewport?.width) || !Number.isInteger(entry.viewport?.height) || entry.viewport.width < 1 || entry.viewport.height < 1) {
        throw new Error(`${label} viewport needs integer width and height`);
      }
      viewport = { width: entry.viewport.width, height: entry.viewport.height };
    }
    let state = null;
    if (entry.state !== undefined) {
      if (!STATE_ACTIONS.has(entry.state?.action) || typeof entry.state?.selector !== 'string' || !entry.state.selector) {
        throw new Error(`${label} state needs action click, hover, or focus and a selector`);
      }
      state = { action: entry.state.action, selector: entry.state.selector };
    }
    const anchors = (entry.anchors ?? []).map((anchor, anchorIndex) => normalizeAnchor(anchor, `${label} anchor ${anchorIndex + 1}`));
    const pageArea = viewport ? viewport.width * viewport.height : null;
    const regions = (entry.regions ?? []).map((region, regionIndex) => normalizeRegion(region, `${label} region ${regionIndex + 1}`, pageArea));
    if (!anchors.length && !regions.length) throw new Error(`${label} needs at least one anchor or region`);
    const ids = [...anchors, ...regions].map((item) => item.id);
    if (new Set(ids).size !== ids.length) throw new Error(`${label} repeats an anchor or region id`);
    return { page, ...(viewport ? { viewport } : {}), ...(state ? { state } : {}), anchors, regions };
  });
  return { schemaVersion, pages };
}

export function anchorsConfigHash(config) {
  return hashJson(normalizeAnchorsConfig(config));
}

// The image source run a clone is measured against: its frames and the design
// width each screen declared.
export function loadAnchorReference(root, siteKey, runId) {
  const manifest = readManifest(root, siteKey, runId);
  if (manifest.status !== 'closed' || manifest.target?.evidence !== 'image') throw new Error(`Reference run ${runId} must be a closed image source run from ingest`);
  const readJson = (path) => JSON.parse(readArtifact(root, siteKey, runId, path).toString('utf8'));
  const screensConfig = readJson('screens.json');
  return {
    runId,
    screens: readJson('measurements/frames.json').screens,
    routes: readJson('measurements/routes.json').routes.map((entry) => entry.route),
    designWidths: Object.fromEntries(screensConfig.screens.map((screen) => [screen.page, screen.designWidth ?? null])),
  };
}

function pickValue(result, path) {
  let value = result;
  for (const part of path.split('.')) {
    if (value === null || value === undefined) return null;
    value = Array.isArray(value) && /^-?\d+$/u.test(part) ? value.at(Number(part)) : value[part];
  }
  return value ?? null;
}

export function evaluateAnchors(raster, geometry, anchors) {
  return anchors.map((anchor) => {
    const { type, ...parameters } = anchor.probe;
    try {
      const result = PROBES[type](raster, geometry, parameters);
      const value = pickValue(result, anchor.pick);
      // The colours on both sides of a picked edge say which edge it is.
      const edge = type === 'edges' && anchor.pick.endsWith('.position') ? pickValue(result, anchor.pick.slice(0, -'.position'.length)) : null;
      return {
        id: anchor.id,
        value: typeof value === 'number' ? Number(value.toFixed(3)) : value,
        ...(edge?.from ? { edge: { from: edge.from, to: edge.to } } : {}),
      };
    } catch (error) {
      return { id: anchor.id, value: null, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

function hexToRgb(value) {
  const match = /^#([0-9a-f]{6})$/iu.exec(String(value));
  return match ? [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16)) : null;
}

// A shifted clone can push the intended edge out of the probe window, so a
// neighbouring edge lands within tolerance. Edge colours catch that.
export function anchorEdgesMatch(reference, clone, tolerance = 24) {
  if (!reference?.edge || !clone?.edge) return true;
  return colorDistance(hexToRgb(reference.edge.from), hexToRgb(clone.edge.from)) <= tolerance
    && colorDistance(hexToRgb(reference.edge.to), hexToRgb(clone.edge.to)) <= tolerance;
}

// Numbers compare as CSS pixels; colours as RGB distance.
export function compareAnchorValues(reference, clone, tolerance) {
  if (reference === null || clone === null) return { comparable: false };
  const referenceColor = hexToRgb(reference);
  const cloneColor = hexToRgb(clone);
  if (referenceColor && cloneColor) {
    const delta = colorDistance(referenceColor, cloneColor);
    return { comparable: true, delta: Number(delta.toFixed(2)), within: delta <= tolerance };
  }
  if (typeof reference === 'number' && typeof clone === 'number') {
    const delta = clone - reference;
    return { comparable: true, delta: Number(delta.toFixed(3)), within: Math.abs(delta) <= tolerance };
  }
  return { comparable: true, delta: null, within: reference === clone };
}

// The viewport a page was designed at. A cropped screenshot shows only part
// of it, so its page entry should declare the viewport.
export function captureViewport(pageConfig, screen, designWidth) {
  if (pageConfig.viewport) return { viewport: pageConfig.viewport, assumed: false };
  const cropped = Object.values(screen.frame.cropped).some(Boolean);
  return {
    viewport: { width: Math.round(designWidth ?? screen.geometry.css.width), height: Math.round(screen.geometry.css.height) },
    assumed: cropped,
  };
}

async function applyState(page, state, { route, target, policy, timeout }) {
  const trigger = page.locator(state.selector);
  const count = await trigger.count().catch(() => 0);
  if (count !== 1) return { applied: false, reason: count === 0 ? 'missing-state-trigger' : 'ambiguous-state-trigger' };
  const description = await trigger.evaluate((element) => ({
    role: element.getAttribute('role') || (element.tagName === 'A' ? 'link' : element.tagName.toLowerCase()),
    name: (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').replace(/\s+/gu, ' ').trim().slice(0, 240),
    controlClass: element.getAttribute('data-control-class') || 'default',
  }));
  const decision = evaluateAction({ policy: policy ?? {}, target, action: { route, role: description.role, name: description.name, selector: state.selector, controlClass: description.controlClass, occurrence: 0 } });
  if (!decision.allowed) return { applied: false, reason: 'blocked-by-policy', policy: decision };
  if (state.action === 'hover') await trigger.hover({ timeout });
  else if (state.action === 'focus') await trigger.focus({ timeout });
  else await trigger.click({ timeout });
  await page.waitForTimeout(150);
  return { applied: true, policy: decision };
}

// Captures each configured page of the clone at the reference's scale and
// evaluates its anchors. `prepare` waits for hydration on each page.
export async function captureAnchorPages(browser, { baseUrl, config, reference, target = 'clone', policy = {}, prepare = async () => {}, timeout = 5000 }) {
  const pages = [];
  for (const pageConfig of config.pages) {
    const screen = reference.screens.find((entry) => entry.page === pageConfig.page);
    if (!screen) {
      pages.push({ page: pageConfig.page, status: 'incomplete', reason: 'page-not-in-reference' });
      continue;
    }
    const { viewport, assumed } = captureViewport(pageConfig, screen, reference.designWidths?.[pageConfig.page] ?? null);
    const deviceScaleFactor = screen.geometry.scale;
    const context = await browser.newContext({ viewport, deviceScaleFactor });
    const base = { page: pageConfig.page, route: screen.route, viewport, viewportAssumed: assumed, deviceScaleFactor };
    try {
      const page = await context.newPage();
      const response = await page.goto(new URL(screen.route, baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!response || response.status() >= 400) {
        pages.push({ ...base, status: 'incomplete', reason: `route returned ${response?.status() ?? 'no response'}` });
        continue;
      }
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await prepare(page);
      let state = null;
      if (pageConfig.state) {
        state = await applyState(page, pageConfig.state, { route: screen.route, target, policy, timeout });
        if (!state.applied) {
          pages.push({ ...base, status: 'incomplete', reason: state.reason, ...(state.policy ? { policy: state.policy } : {}) });
          continue;
        }
      }
      await page.evaluate(() => document.fonts.ready.then(() => true));
      const image = await page.screenshot({ animations: 'disabled', caret: 'hide' });
      const raster = rasterFromPng(image);
      pages.push({
        ...base,
        status: 'captured',
        ...(state ? { state: { action: pageConfig.state.action, selector: pageConfig.state.selector, policy: state.policy } } : {}),
        width: raster.width,
        height: raster.height,
        artifactPath: `measurements/anchors/${pageConfig.page}.png`,
        image,
        anchors: evaluateAnchors(raster, { origin: { x: 0, y: 0 }, scale: deviceScaleFactor }, pageConfig.anchors),
      });
    } catch (error) {
      pages.push({ ...base, status: 'incomplete', reason: 'capture-failed', error: error instanceof Error ? error.message : String(error) });
    } finally {
      await context.close().catch(() => {});
    }
  }
  return pages;
}

// Cuts a CSS box out of a raster as a continuous region, so a reference with a
// fractional origin and a clone capture land on the same pixel grid.
function cutRegion(raster, geometry, box, width, height, masks = []) {
  const cut = resampleRegion(raster, {
    x: geometry.origin.x + box[0] * geometry.scale,
    y: geometry.origin.y + box[1] * geometry.scale,
    width: (box[2] - box[0]) * geometry.scale,
    height: (box[3] - box[1]) * geometry.scale,
  }, width, height);
  for (const mask of masks) {
    const left = Math.max(0, Math.floor((mask[0] - box[0]) * geometry.scale));
    const top = Math.max(0, Math.floor((mask[1] - box[1]) * geometry.scale));
    const right = Math.min(width, Math.ceil((mask[2] - box[0]) * geometry.scale));
    const bottom = Math.min(height, Math.ceil((mask[3] - box[1]) * geometry.scale));
    for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) cut.data.set([...MASK_COLOR, 255], (y * width + x) * 4);
  }
  return cut;
}

function fitsInside(box, css) {
  return box[0] >= 0 && box[1] >= 0 && box[2] <= css.width + 0.5 && box[3] <= css.height + 0.5;
}

// Compares a clone run's anchor captures with the image source run they were
// measured against. Reference values are computed here from the stored native
// crops, so the evidence is the same images and the same config.
export function compareImageParity({ root, siteKey, sourceRunId, cloneRunId, cloneManifest, reportRunId = null }) {
  const hasArtifact = (path) => cloneManifest.artifacts.some((artifact) => artifact.path === path);
  if (!hasArtifact('measurements/anchors.json')) {
    return { findings: [], comparatorCoverage: [], visualArtifacts: [], pages: [], coverage: { configured: false, complete: false, reason: 'anchor-evidence-missing' } };
  }
  const readJson = (runId, path) => JSON.parse(readArtifact(root, siteKey, runId, path).toString('utf8'));
  const observation = readJson(cloneRunId, 'measurements/anchors.json');
  const config = normalizeAnchorsConfig(readJson(cloneRunId, 'anchors.json'));
  const findings = [];
  const comparatorCoverage = [];
  const visualArtifacts = [];
  const pages = [];
  const referenceMismatch = observation.referenceRunId !== sourceRunId;
  const frames = readJson(sourceRunId, 'measurements/frames.json');
  for (const pageConfig of config.pages) {
    const captured = observation.pages.find((entry) => entry.page === pageConfig.page);
    const screen = frames.screens.find((entry) => entry.page === pageConfig.page);
    const route = screen?.route ?? captured?.route ?? null;
    const complete = !referenceMismatch && captured?.status === 'captured' && Boolean(screen);
    const pageSummary = { page: pageConfig.page, route, complete, anchors: [], regions: [] };
    pages.push(pageSummary);
    // Each image is decoded once per page.
    let referenceRaster = null;
    let cloneRaster = null;
    const reference = () => (referenceRaster ??= rasterFromPng(readArtifact(root, siteKey, sourceRunId, screen.references.native)));
    const clone = () => (cloneRaster ??= rasterFromPng(readArtifact(root, siteKey, cloneRunId, captured.artifactPath)));
    for (const item of [...pageConfig.anchors.map((anchor) => ({ ...anchor, kind: 'anchor' })), ...pageConfig.regions.map((region) => ({ ...region, kind: 'region' }))]) {
      const instrument = item.kind === 'anchor' ? 'image-anchor' : 'image-region';
      const subject = { route, page: pageConfig.page, [item.kind === 'anchor' ? 'anchorId' : 'regionId']: item.id };
      const policy = item.kind === 'anchor'
        ? { mode: item.mode, tolerance: item.tolerance, probe: item.probe, pick: item.pick }
        : { mode: item.mode, threshold: item.threshold, pixelThreshold: item.pixelThreshold, box: item.box, masks: item.masks ?? null };
      const comparator = { instrument, evidenceClass: instrument, dimension: item.kind === 'anchor' ? 'value' : 'pixels', mode: item.mode, policy };
      if (!complete) {
        comparatorCoverage.push({ comparator, subject, complete: false });
        findings.push({
          category: `${instrument}-incomplete`,
          subject,
          status: 'informational',
          comparator,
          policy,
          observed: { reason: referenceMismatch ? `clone anchors were measured against ${observation.referenceRunId}` : (captured?.reason ?? (screen ? 'not-captured' : 'page-not-in-reference')) },
          evidence: { source: null, clone: { runId: cloneRunId, artifact: 'measurements/anchors.json', locator: '#/pages' } },
        });
        continue;
      }
      if (item.kind === 'anchor') {
        const [referenceResult] = evaluateAnchors(reference(), screen.cropGeometry, [item]);
        const cloneResult = captured.anchors.find((entry) => entry.id === item.id) ?? { value: null };
        const comparison = compareAnchorValues(referenceResult.value, cloneResult.value, item.tolerance);
        const sameEdge = anchorEdgesMatch(referenceResult, cloneResult);
        const row = {
          id: item.id,
          mode: item.mode,
          reference: referenceResult.value,
          clone: cloneResult.value,
          delta: comparison.delta ?? null,
          tolerance: item.tolerance,
          within: Boolean(comparison.within && sameEdge),
          ...(sameEdge ? {} : { reason: 'The clone value comes from a different edge', referenceEdge: referenceResult.edge, cloneEdge: cloneResult.edge }),
        };
        pageSummary.anchors.push(row);
        const anchorComplete = referenceResult.value !== null;
        comparatorCoverage.push({ comparator, subject, complete: anchorComplete });
        if (!anchorComplete) {
          findings.push({ category: 'image-anchor-incomplete', subject, status: 'informational', comparator, policy, observed: { reason: referenceResult.error ?? 'The probe found nothing on the reference; check the anchor' }, evidence: { source: { runId: sourceRunId, artifact: screen.references.native, locator: '#' }, clone: null } });
          continue;
        }
        if (row.within) continue;
        findings.push({
          category: cloneResult.value === null ? 'image-anchor-missing' : 'image-anchor-mismatch',
          subject,
          status: item.mode === 'gate' ? 'open' : 'informational',
          comparator,
          policy,
          observed: row,
          evidence: {
            source: { runId: sourceRunId, artifact: screen.references.native, locator: '#' },
            clone: { runId: cloneRunId, artifact: captured.artifactPath, locator: '#' },
          },
        });
        continue;
      }
      // Regions.
      const cloneGeometry = { origin: { x: 0, y: 0 }, scale: captured.deviceScaleFactor };
      const cloneCss = { width: captured.width / captured.deviceScaleFactor, height: captured.height / captured.deviceScaleFactor };
      if (!fitsInside(item.box, screen.geometry.css) || !fitsInside(item.box, cloneCss)) {
        comparatorCoverage.push({ comparator, subject, complete: false });
        findings.push({ category: 'image-region-incomplete', subject, status: 'informational', comparator, policy, observed: { reason: 'The region lies outside the visible reference or the clone capture' }, evidence: { source: null, clone: null } });
        continue;
      }
      const width = Math.max(1, Math.round((item.box[2] - item.box[0]) * screen.geometry.scale));
      const height = Math.max(1, Math.round((item.box[3] - item.box[1]) * screen.geometry.scale));
      const referenceCut = toPng(cutRegion(reference(), screen.cropGeometry, item.box, width, height, item.masks));
      const cloneCut = toPng(cutRegion(clone(), cloneGeometry, item.box, width, height, item.masks));
      const comparison = compareVisualRegionImages(referenceCut, cloneCut, { threshold: item.threshold, pixelThreshold: item.pixelThreshold });
      comparatorCoverage.push({ comparator, subject, complete: comparison.complete });
      const base = `image-regions/${pageConfig.page}/${item.id}`;
      pageSummary.regions.push({ id: item.id, mode: item.mode, diffRatio: comparison.diffRatio, equal: comparison.equal, ...(comparison.equal ? {} : { artifacts: { reference: `${base}.reference.png`, clone: `${base}.clone.png`, diff: `${base}.diff.png` } }) });
      if (comparison.equal) continue;
      visualArtifacts.push({ path: `${base}.reference.png`, image: referenceCut }, { path: `${base}.clone.png`, image: cloneCut }, { path: `${base}.diff.png`, image: comparison.diff });
      findings.push({
        category: 'image-region-mismatch',
        subject,
        status: item.mode === 'gate' ? 'open' : 'informational',
        comparator,
        policy,
        observed: { diffPixels: comparison.diffPixels, diffRatio: comparison.diffRatio, width, height },
        evidence: reportRunId ? {
          source: { runId: reportRunId, artifact: `${base}.reference.png`, locator: '#' },
          clone: { runId: reportRunId, artifact: `${base}.clone.png`, locator: '#' },
          diff: { runId: reportRunId, artifact: `${base}.diff.png`, locator: '#' },
        } : { source: null, clone: null },
      });
    }
    if (complete) {
      // A visual aid for people: the overlapping area of reference and clone
      // side by side with its difference. It is never a score or a finding.
      const cloneGeometry = { origin: { x: 0, y: 0 }, scale: captured.deviceScaleFactor };
      const overlap = [0, 0, Math.min(screen.geometry.css.width, captured.width / captured.deviceScaleFactor), Math.min(screen.geometry.css.height, captured.height / captured.deviceScaleFactor)];
      const width = Math.max(1, Math.round(overlap[2]));
      const height = Math.max(1, Math.round(overlap[3]));
      const referenceView = cutRegion(reference(), screen.cropGeometry, overlap, width, height);
      const cloneView = cutRegion(clone(), cloneGeometry, overlap, width, height);
      const view = compareVisualRegionImages(toPng(referenceView), toPng(cloneView), { pixelThreshold: 0.2 });
      const base = `image-parity/${pageConfig.page}`;
      visualArtifacts.push({ path: `${base}.reference.png`, image: toPng(referenceView) }, { path: `${base}.clone.png`, image: toPng(cloneView) }, { path: `${base}.diff.png`, image: view.diff });
      pageSummary.views = { reference: `${base}.reference.png`, clone: `${base}.clone.png`, diff: `${base}.diff.png` };
    }
  }
  const anchorsCompared = pages.flatMap((page) => page.anchors).filter((anchor) => anchor.reference !== null && anchor.clone !== null);
  return {
    findings,
    comparatorCoverage,
    visualArtifacts,
    pages,
    coverage: {
      configured: true,
      complete: !referenceMismatch && comparatorCoverage.every((entry) => entry.complete),
      ...(referenceMismatch ? { reason: 'reference-run-mismatch' } : {}),
      pagesConfigured: config.pages.length,
      pagesCompared: pages.filter((page) => page.complete).length,
      anchorsCompared: anchorsCompared.length,
      anchorsWithinTolerance: anchorsCompared.filter((anchor) => anchor.within).length,
      maxAnchorDelta: anchorsCompared.reduce((max, anchor) => (typeof anchor.delta === 'number' && Math.abs(anchor.delta) > max ? Math.abs(anchor.delta) : max), 0),
      regionsCompared: pages.flatMap((page) => page.regions).length,
    },
  };
}

