import { mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  closeRun,
  canonicalJson,
  createRun,
  createRunId,
  ENGINE_VERSION,
  failRun,
  readArtifact,
  readManifest,
  repositoryIdentity,
  setRef,
  sha256,
  updateRun,
  writeArtifact,
} from './run-store.mjs';
import { auditDeadRuntimeClasses } from './audits/dead-classes.mjs';
import { redactForPersistence, safeUrl } from './redact.mjs';
import { normalizePolicy, policySha256 } from './policy.mjs';
import { runSelfTests } from './selftest.mjs';
import { captureMotion } from './motion.mjs';
import { captureDomSnapshot } from './dom-snapshot.mjs';
import { captureVisualRegions, normalizeVisualRegionConfig, visualRegionConfigHash } from './visual-regions.mjs';
import { captureResponsive, responsiveIndexEntry } from './responsive.mjs';
import { assetIndexEntry, captureAssetManifest, createAssetTracker } from './assets.mjs';

const LOGIN_PATH = /(?:^|\/)(?:login|signin|sign-in|auth)(?:\/|$)/iu;

function routePath(url) {
  try {
    const pathname = new URL(url).pathname || '/';
    return pathname.length > 1 ? pathname.replace(/\/$/u, '') : pathname;
  } catch {
    return '/';
  }
}

function assertTargetUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Target URL is invalid: ${value}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Target URL must use http or https');
  return url;
}

export function sourceIdentity(page, expected = {}) {
  return page.evaluate((requested) => {
    const values = {
      tenant: [
        document.querySelector('[data-tenant]')?.getAttribute('data-tenant'),
        document.querySelector('[data-workspace]')?.getAttribute('data-workspace'),
        document.querySelector('meta[name="tenant"]')?.getAttribute('content'),
      ].find(Boolean) ?? null,
      role: [
        document.querySelector('[data-role]')?.getAttribute('data-role'),
        document.querySelector('meta[name="role"]')?.getAttribute('content'),
      ].find(Boolean) ?? null,
    };
    const status = (requestedValue, observedValue) => {
      if (requestedValue === undefined) return 'not-requested';
      if (observedValue === null) return 'unverified';
      return String(observedValue) === String(requestedValue) ? 'matched' : 'mismatched';
    };
    return {
      tenant: values.tenant,
      role: values.role,
      requestedTenant: requested.tenant ?? null,
      requestedRole: requested.role ?? null,
      tenantStatus: status(requested.tenant, values.tenant),
      roleStatus: status(requested.role, values.role),
      tenantMatched: requested.tenant === undefined || values.tenant === requested.tenant,
      roleMatched: requested.role === undefined || values.role === requested.role,
    };
  }, expected);
}

function assertProfileId(profileId) {
  if (profileId !== undefined && profileId !== null && (!/^[a-z0-9][a-z0-9._-]*$/iu.test(String(profileId)) || /[\\/]/u.test(String(profileId)))) {
    throw new Error('profileId must be a non-secret label, not a filesystem path');
  }
}

export async function collectControls(page, route) {
  return page.evaluate((currentRoute) => {
    const selector = 'button, a, input, select, textarea, [role="button"], [role="tab"], [role="menuitem"], [role="switch"]';
    const occurrences = new Map();
    return [...document.querySelectorAll(selector)].map((element, index) => {
      const role = element.getAttribute('role') || element.tagName.toLowerCase();
      const name = (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || element.getAttribute('placeholder') || element.getAttribute('name') || '').replace(/\s+/gu, ' ').trim().slice(0, 240);
      const controlClass = element.getAttribute('data-control-class') || 'default';
      const href = element.getAttribute('href');
      const duplicateKey = JSON.stringify([role, name, controlClass]);
      const occurrence = occurrences.get(duplicateKey) ?? 0;
      occurrences.set(duplicateKey, occurrence + 1);
      const parent = element.parentElement;
      return {
        route: currentRoute,
        index,
        occurrence,
        role,
        name,
        visible: Boolean(element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden'),
        enabled: !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true',
        controlClass,
        href,
        state: element.getAttribute('aria-pressed') || element.getAttribute('aria-selected') || element.getAttribute('data-state'),
        ariaState: {
          pressed: element.getAttribute('aria-pressed'),
          selected: element.getAttribute('aria-selected'),
          expanded: element.getAttribute('aria-expanded'),
          checked: element.getAttribute('aria-checked'),
          hidden: element.getAttribute('aria-hidden'),
          disabled: element.getAttribute('aria-disabled'),
        },
        structure: {
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute('type'),
          parentTag: parent?.tagName.toLowerCase() ?? null,
          parentRole: parent?.getAttribute('role') ?? null,
          childElementCount: element.children.length,
        },
      };
    });
  }, route);
}

export async function collectClasses(page, route) {
  return page.evaluate((currentRoute) => {
    const runtimeClasses = [...new Set([...document.querySelectorAll('[class]')].flatMap((element) => String(element.className || '').split(/\s+/u).filter(Boolean)))].sort();
    const compiledClasses = new Set();
    const stylesheetSources = [];
    let stylesheetsReadable = 0;
    let stylesheetsUnreadable = 0;
    const classPattern = /\.((?:\\.|[A-Za-z_-])(?:\\.|[A-Za-z0-9_-])*)/gu;
    const collectRules = (rules) => {
      for (const rule of [...rules]) {
        const text = rule.cssText || '';
        for (const match of text.matchAll(classPattern)) {
          compiledClasses.add(match[1].replace(/\\([0-9a-f]{1,6})\s?/giu, (_, codePoint) => String.fromCodePoint(Number.parseInt(codePoint, 16))).replace(/\\([^\n])/gu, '$1'));
        }
        if (rule.cssRules) collectRules(rule.cssRules);
      }
    };
    for (const sheet of [...document.styleSheets]) {
      stylesheetSources.push(sheet.href || 'inline');
      try {
        collectRules(sheet.cssRules);
        stylesheetsReadable += 1;
      } catch {
        // Cross-origin CSSOM access is unavailable; the source is kept as a
        // provenance marker and the route remains valid for other sheets.
        stylesheetsUnreadable += 1;
      }
    }
    return {
      route: currentRoute,
      runtimeClasses,
      compiledClasses: [...compiledClasses].sort(),
      stylesheetSources,
      stylesheetsTotal: stylesheetSources.length,
      stylesheetsReadable,
      stylesheetsUnreadable,
      cssCoverageComplete: stylesheetsUnreadable === 0,
    };
  }, route);
}

export async function runtimeHealth(page, kind, options = {}) {
  const result = await page.evaluate((config) => {
    const scripts = [...document.scripts].filter((script) => script.src || script.textContent?.trim());
    const explicit = config.hydrationSelector ? Boolean(document.querySelector(config.hydrationSelector)) : null;
    const explicitMarker = document.documentElement.getAttribute('data-hydrated');
    const explicitFailure = explicitMarker === 'false' || Boolean(document.querySelector('[data-next-error], [data-hydration-error]'));
    const nextRuntime = scripts.some((script) => /\/_next\//u.test(script.src) || /__next_f\.push/u.test(script.textContent ?? ''));
    const reactAttached = [...document.querySelectorAll('html, body, #__next, [data-nextjs-scroll-focus-boundary], [data-reactroot], body *')]
      .slice(0, 250)
      .some((element) => Object.getOwnPropertyNames(element).some((key) => /^__react(?:Container|Fiber|Props)/u.test(key)));
    const hydrationEvidence = explicit !== null
      ? (explicit ? 'selector' : 'selector-missing')
      : explicitMarker === 'true'
        ? 'marker'
        : reactAttached && nextRuntime
          ? 'react-next-runtime'
          : 'unverified';
    const loginForm = [...document.querySelectorAll('input[type="password"], [autocomplete="current-password"]')]
      .some((element) => Boolean(element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden'));
    return {
      serverHealthy: true,
      clientJsLoaded: nextRuntime,
      hydrated: !explicitFailure && ['selector', 'marker', 'react-next-runtime'].includes(hydrationEvidence),
      hydrationEvidence,
      explicitHydrationSelector: config.hydrationSelector ?? null,
      reactAttached,
      nextRuntime,
      title: document.title,
      bodyBytes: document.body?.innerHTML.length ?? 0,
      framework: nextRuntime ? 'next' : reactAttached ? 'react' : null,
      loginForm: loginForm || Boolean(document.querySelector('form[action*="login" i], form[action*="signin" i]')),
      kind: config.kind,
    };
  }, { ...options, kind });
  return result;
}

function createRequestTracker(page) {
  const statuses = [];
  const failures = [];
  const onResponse = (response) => {
    const request = response.request();
    statuses.push({ url: safeUrl(response.url()), status: response.status(), resourceType: request.resourceType(), method: request.method() });
  };
  const onRequestFailed = (request) => {
    failures.push({ url: safeUrl(request.url()), resourceType: request.resourceType(), error: request.failure()?.errorText ?? 'request failed' });
  };
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  return {
    statuses,
    failures,
    stop() {
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
    },
  };
}

async function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) return;
      lastError = new Error(`Server returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Managed clone server did not become healthy: ${lastError?.message ?? 'timeout'}`);
}

export async function startManagedCloneServer({ root = process.cwd(), port, command = 'dev', timeoutMs = 30000, cleanNext = true } = {}) {
  const actualPort = port ?? await findFreePort();
  if (cleanNext) rmSync(resolve(root, '.next'), { recursive: true, force: true });
  const child = spawn('npm', ['run', command, '--', '--hostname', '127.0.0.1', '--port', String(actualPort)], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none' },
  });
  let output = '';
  child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { output += chunk.toString(); });
  const url = `http://127.0.0.1:${actualPort}`;
  try {
    await waitForServer(url, timeoutMs);
  } catch (error) {
    child.kill('SIGTERM');
    throw new Error(`${error.message}${output ? `\n${output.slice(-1000)}` : ''}`);
  }
  return {
    url,
    process: child,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise((resolveStop) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolveStop(); }, 5000);
        child.once('exit', () => { clearTimeout(timer); resolveStop(); });
      });
    },
  };
}

function routeUrl(baseUrl, route) {
  const target = new URL(route, baseUrl);
  if (target.origin !== new URL(baseUrl).origin) throw new Error(`Route must stay on target origin: ${route}`);
  return target.toString();
}

function preconditionError(message, runId) {
  const error = new Error(message);
  error.runId = runId;
  return error;
}

function readInventoryContext(root, siteKey, inventoryRunId, target, requestedRoutes) {
  const manifest = readManifest(root, siteKey, inventoryRunId);
  if (manifest.status !== 'closed') throw new Error(`Inventory run must be closed: ${inventoryRunId}`);
  if (manifest.target?.kind && manifest.target.kind !== target) {
    throw new Error(`Inventory run ${inventoryRunId} is a ${manifest.target.kind} run, not a ${target} run`);
  }
  if (manifest.scope?.inventoryRunId !== inventoryRunId || manifest.scope?.authoritativeInventory !== true) {
    throw new Error(`Inventory run must be an explicit authoritative inventory: ${inventoryRunId}`);
  }
  const inventory = JSON.parse(readArtifact(root, siteKey, inventoryRunId, 'inventory.json').toString('utf8'));
  const coverage = JSON.parse(readArtifact(root, siteKey, inventoryRunId, 'coverage.json').toString('utf8'));
  if (inventory.runId !== inventoryRunId || coverage.inventory?.runId !== inventoryRunId || coverage.inventory?.authoritative !== true || coverage.scope !== 'full') {
    throw new Error(`Inventory provenance is inconsistent for run ${inventoryRunId}`);
  }
  const routePaths = (inventory.routes ?? []).map((entry) => routePath(entry.route));
  const inventoryRoutes = new Set(routePaths);
  const missingRoutes = requestedRoutes.filter((route) => !inventoryRoutes.has(routePath(route)));
  if (missingRoutes.length) {
    throw new Error(`Requested routes are not present in inventory ${inventoryRunId}: ${missingRoutes.join(', ')}`);
  }
  return {
    runId: inventoryRunId,
    routes: inventory.routes.length,
    routePaths,
    authoritative: true,
    ...(coverage.inventory?.controls !== undefined ? { controls: coverage.inventory.controls } : {}),
  };
}

function routeArtifactKey(route, index) {
  return `${String(index + 1).padStart(4, '0')}-${sha256(route).slice(0, 12)}`;
}

function routeVisualKey(route) {
  return route.replace(/[^a-z0-9]+/giu, '-').replace(/^-|-$/gu, '') || 'root';
}

function measurementModules({ normalizedVisualConfig, motion, motionSample, domSnapshot, responsive, assets }) {
  return { visual: Boolean(normalizedVisualConfig), motion: Boolean(motion), motionSample: Boolean(motionSample), domSnapshot: Boolean(domSnapshot), responsive: Boolean(responsive), assets: Boolean(assets) };
}

export function assertResumeCompatibility(manifest, { target, origin, profileId, tenant, role, policyHash, modules, viewport, deviceScaleFactor, visualConfigSha256, hydrationSelector, repository }) {
  if (manifest.status !== 'failed') throw new Error(`Resume source must be a failed run: ${manifest.runId}`);
  if (manifest.kind !== target || manifest.target?.kind !== target) throw new Error(`Resume run target does not match ${target}: ${manifest.runId}`);
  if (manifest.engine?.version !== ENGINE_VERSION) throw new Error(`Resume run engine version does not match ${ENGINE_VERSION}: ${manifest.runId}`);
  let persistedOrigin;
  try {
    persistedOrigin = new URL(manifest.target?.origin).origin;
  } catch {
    persistedOrigin = null;
  }
  if (persistedOrigin !== origin) throw new Error(`Resume run origin does not match ${origin}: ${manifest.runId}`);
  if ((manifest.target?.profileId ?? null) !== (profileId ?? null)) throw new Error(`Resume run profile does not match: ${manifest.runId}`);
  if (target === 'source' && (profileId === undefined || profileId === null)) throw new Error(`Source resume requires --profile-id: ${manifest.runId}`);
  if ((manifest.target?.tenant ?? null) !== (tenant ?? null) || (manifest.target?.role ?? null) !== (role ?? null)) throw new Error(`Resume run identity context does not match: ${manifest.runId}`);
  if ((manifest.policySha256 ?? null) !== (policyHash ?? null)) throw new Error(`Resume run policy does not match: ${manifest.runId}`);
  if (JSON.stringify(manifest.target?.modules ?? null) !== JSON.stringify(modules)) throw new Error(`Resume run measurement modules do not match: ${manifest.runId}`);
  if (JSON.stringify(manifest.target?.viewport ?? null) !== JSON.stringify(viewport ?? null)) throw new Error(`Resume run viewport does not match: ${manifest.runId}`);
  if ((manifest.target?.deviceScaleFactor ?? null) !== (deviceScaleFactor ?? null)) throw new Error(`Resume run device scale factor does not match: ${manifest.runId}`);
  if ((manifest.target?.visualConfigSha256 ?? null) !== (visualConfigSha256 ?? null)) throw new Error(`Resume run visual configuration does not match: ${manifest.runId}`);
  if ((manifest.target?.hydrationSelector ?? null) !== (hydrationSelector ?? null)) throw new Error(`Resume run hydration selector does not match: ${manifest.runId}`);
  if (canonicalJson(manifest.repository ?? null) !== canonicalJson(repository ?? null)) throw new Error(`Resume run repository identity does not match: ${manifest.runId}`);
}

function readOptionalRouteJson(root, siteKey, manifest, path) {
  if (!manifest.artifacts.some((artifact) => artifact.path === path)) return null;
  return JSON.parse(readArtifact(root, siteKey, manifest.runId, path).toString('utf8'));
}

function loadReusableRouteEvidence(root, siteKey, manifest, requestedRoutes, { modules, visualRoutes = new Set() } = {}) {
  const entries = [];
  for (const artifact of manifest.artifacts ?? []) {
    if (!artifact.path.startsWith('measurements/routes/') || !artifact.path.endsWith('.json')) continue;
    try {
      const routeRecord = JSON.parse(readArtifact(root, siteKey, manifest.runId, artifact.path).toString('utf8'));
      if (!requestedRoutes.includes(routeRecord.route)) continue;
      const oldKey = artifact.path.split('/').at(-1).replace(/\.json$/u, '');
      const required = ['controls', 'classes', 'requests'].map((kind) => `measurements/${kind}/${oldKey}.json`);
      if (!required.every((path) => manifest.artifacts.some((candidate) => candidate.path === path))) continue;
      const optional = [
        modules?.motion ? `measurements/motion/${oldKey}.json` : null,
        modules?.domSnapshot ? `measurements/dom-snapshots/${oldKey}.json` : null,
        modules?.responsive ? `measurements/responsive/${oldKey}.json` : null,
        modules?.assets ? `measurements/assets/${oldKey}.json` : null,
        modules?.visual && visualRoutes.has(routeRecord.route) ? `measurements/visual-regions/${oldKey}.json` : null,
      ].filter(Boolean);
      if (!optional.every((path) => manifest.artifacts.some((candidate) => candidate.path === path))) continue;
      for (const path of [...required, ...optional]) JSON.parse(readArtifact(root, siteKey, manifest.runId, path).toString('utf8'));
      const visualPath = optional.find((path) => path.startsWith('measurements/visual-regions/'));
      if (visualPath) {
        const visual = JSON.parse(readArtifact(root, siteKey, manifest.runId, visualPath).toString('utf8'));
        for (const region of visual.regions ?? []) {
          if (region.artifactPath) readArtifact(root, siteKey, manifest.runId, region.artifactPath);
        }
      }
      entries.push({ route: routeRecord.route, oldKey, routeRecord, required, optional });
    } catch {
      // Invalid partial evidence is measured again.
    }
  }
  return new Map(entries.map((entry) => [entry.route, entry]));
}

function copyReusableRoute(root, siteKey, sourceManifest, targetRunId, entry, newKey, modules) {
  const paths = [entry.routeRecord, ...entry.required].map((value) => typeof value === 'string' ? value : `measurements/routes/${entry.oldKey}.json`);
  for (const moduleName of ['visual', 'motion', 'dom-snapshots', 'responsive', 'assets']) {
    if (moduleName === 'visual' ? !modules.visual : moduleName === 'motion' ? !modules.motion : moduleName === 'dom-snapshots' ? !modules.domSnapshot : !modules[moduleName]) continue;
    paths.push(`measurements/${moduleName === 'dom-snapshots' ? 'dom-snapshots' : moduleName === 'visual' ? 'visual-regions' : moduleName}/${entry.oldKey}.json`);
  }
  const visualPrefix = `measurements/visual-regions/${routeVisualKey(entry.route)}/`;
  for (const artifact of sourceManifest.artifacts ?? []) if (artifact.path.startsWith(visualPrefix)) paths.push(artifact.path);
  for (const sourcePath of [...new Set(paths)]) {
    if (!sourceManifest.artifacts.some((artifact) => artifact.path === sourcePath)) continue;
    const targetPath = sourcePath.includes(`/${entry.oldKey}.json`) ? sourcePath.replace(`/${entry.oldKey}.json`, `/${newKey}.json`) : sourcePath;
    const record = sourceManifest.artifacts.find((artifact) => artifact.path === sourcePath);
    writeArtifact(root, siteKey, targetRunId, targetPath, readArtifact(root, siteKey, sourceManifest.runId, sourcePath), { kind: record.kind, visibility: record.visibility });
  }
  return {
    routeRecord: entry.routeRecord,
    controls: JSON.parse(readArtifact(root, siteKey, sourceManifest.runId, entry.required[0]).toString('utf8')),
    classes: JSON.parse(readArtifact(root, siteKey, sourceManifest.runId, entry.required[1]).toString('utf8')),
    requests: JSON.parse(readArtifact(root, siteKey, sourceManifest.runId, entry.required[2]).toString('utf8')),
    visual: modules.visual ? readOptionalRouteJson(root, siteKey, sourceManifest, `measurements/visual-regions/${entry.oldKey}.json`) : null,
    motion: modules.motion ? readOptionalRouteJson(root, siteKey, sourceManifest, `measurements/motion/${entry.oldKey}.json`) : null,
    domSnapshot: modules.domSnapshot ? readOptionalRouteJson(root, siteKey, sourceManifest, `measurements/dom-snapshots/${entry.oldKey}.json`) : null,
    responsive: modules.responsive ? readOptionalRouteJson(root, siteKey, sourceManifest, `measurements/responsive/${entry.oldKey}.json`) : null,
    assets: modules.assets ? readOptionalRouteJson(root, siteKey, sourceManifest, `measurements/assets/${entry.oldKey}.json`) : null,
  };
}

function identityFailure(identity) {
  if (!identity) return null;
  if (identity.tenantStatus === 'unverified') return 'tenant identity could not be verified from an explicit marker';
  if (identity.tenantStatus === 'mismatched') return 'tenant identity does not match';
  if (identity.roleStatus === 'unverified') return 'role identity could not be verified from an explicit marker';
  if (identity.roleStatus === 'mismatched') return 'role identity does not match';
  return null;
}

function criticalAuthFailures(statuses) {
  return statuses.filter((entry) => (entry.status === 401 || entry.status === 403)
    && ['document', 'script', 'stylesheet'].includes(entry.resourceType));
}

export async function measureTarget({
  root = process.cwd(),
  siteKey,
  target = 'clone',
  url,
  routes = [],
  profileDir,
  tenant,
  role,
  profileId,
  policy = {},
  hydrationSelector = null,
  allowUnauthenticated = false,
  browserOptions = {},
  server = null,
  inventoryRunId = null,
  authoritativeInventory = false,
  visualConfig = null,
  motion = false,
  motionSample = false,
  domSnapshot = false,
  responsive = false,
  assets = false,
  resumeRunId = null,
} = {}) {
  await runSelfTests();
  if (!siteKey) throw new Error('siteKey is required');
  assertProfileId(profileId);
  const base = assertTargetUrl(url);
  if (!['source', 'clone'].includes(target)) throw new Error(`target must be source or clone, received ${target}`);
  if (authoritativeInventory && inventoryRunId) throw new Error('authoritativeInventory cannot be combined with inventoryRunId');
  const normalizedVisualConfig = visualConfig ? normalizeVisualRegionConfig(visualConfig) : null;
  const modules = measurementModules({ normalizedVisualConfig, motion, motionSample, domSnapshot, responsive, assets });
  const visualConfigSha256 = normalizedVisualConfig ? visualRegionConfigHash(normalizedVisualConfig) : null;
  const visualViewports = normalizedVisualConfig
    ? [...new Map(normalizedVisualConfig.regions.map((region) => [JSON.stringify(region.viewport), region.viewport])).values()]
    : [];
  const measurementViewport = normalizedVisualConfig ? visualViewports[0] : browserOptions.viewport ?? null;
  const measurementDeviceScaleFactor = normalizedVisualConfig
    ? visualViewports[0].deviceScaleFactor
    : browserOptions.deviceScaleFactor ?? null;
  if (visualViewports.length > 1) throw new Error('A visual measurement run supports one viewport; create separate runs for other viewports');
  const requestedRoutes = routes.length ? routes : [base.pathname || '/'];
  const runId = createRunId(target);
  const resumeManifest = resumeRunId ? readManifest(root, siteKey, resumeRunId) : null;
  if (resumeManifest) {
    assertResumeCompatibility(resumeManifest, {
      target,
      origin: base.origin,
      profileId,
      tenant,
      role,
      policyHash: policySha256(policy),
      modules,
      viewport: measurementViewport,
      deviceScaleFactor: measurementDeviceScaleFactor,
      visualConfigSha256,
      hydrationSelector,
      repository: repositoryIdentity(root),
    });
    if (server === 'managed') throw new Error('Managed clone server cannot resume prior browser evidence');
  }
  const inventoryContext = inventoryRunId
    ? readInventoryContext(root, siteKey, inventoryRunId, target, requestedRoutes)
    : null;
  const scope = {
    inventoryRunId: authoritativeInventory ? runId : inventoryRunId,
    authoritativeInventory: Boolean(authoritativeInventory),
    routesRequested: requestedRoutes,
    routesCompleted: [],
    routesFailed: [],
    ...(resumeManifest ? { resumeRunId: resumeManifest.runId, routesReused: [] } : {}),
  };
  createRun({
    root,
    siteKey,
    runId,
    kind: target,
    target: { kind: target, origin: base.origin, profileId, tenant, role, modules, hydrationSelector: hydrationSelector ?? null, ...(measurementViewport ? { viewport: measurementViewport } : {}), ...(measurementDeviceScaleFactor !== null ? { deviceScaleFactor: measurementDeviceScaleFactor } : {}), ...(visualConfigSha256 ? { visualConfigSha256 } : {}) },
    scope,
    policySha256: policySha256(policy),
  });
  writeArtifact(root, siteKey, runId, 'policy.json', normalizePolicy(policy), { kind: 'policy-snapshot' });
  if (normalizedVisualConfig) writeArtifact(root, siteKey, runId, 'visual-regions.json', normalizedVisualConfig, { kind: 'visual-region-config' });
  let managedServer = null;
  let context = null;
  try {
    let baseUrl = base.origin;
    if (target === 'clone' && server === 'managed') {
      managedServer = await startManagedCloneServer({ root });
      baseUrl = managedServer.url;
      updateRun(root, siteKey, runId, { target: { kind: target, origin: new URL(baseUrl).origin, profileId, tenant, role, modules, hydrationSelector: hydrationSelector ?? null, ...(measurementViewport ? { viewport: measurementViewport } : {}), ...(measurementDeviceScaleFactor !== null ? { deviceScaleFactor: measurementDeviceScaleFactor } : {}), ...(visualConfigSha256 ? { visualConfigSha256 } : {}) } });
    }
    if (target === 'source' && !profileDir) {
      throw preconditionError('Source measurement requires a persistent browser profile', runId);
    }
    const contextOptions = normalizedVisualConfig
      ? { ...browserOptions, viewport: { width: visualViewports[0].width, height: visualViewports[0].height }, deviceScaleFactor: visualViewports[0].deviceScaleFactor }
      : browserOptions;
    if (profileDir) {
      const profilePath = resolve(profileDir);
      mkdirSync(profilePath, { recursive: true, mode: 0o700 });
      context = await chromium.launchPersistentContext(profilePath, { headless: true, ...contextOptions });
    } else {
      const browser = await chromium.launch({ headless: true, ...browserOptions });
      context = await browser.newContext(contextOptions);
      context.__clonerBrowser = browser;
    }
    const page = await context.newPage();
    const routeRecords = [];
    const controls = [];
    const classObservations = [];
    const requestsByRoute = [];
    const visualObservations = [];
    const motionObservations = [];
    const domSnapshotObservations = [];
    const responsiveObservations = [];
    const assetObservations = [];
    const reusableRoutes = resumeManifest ? loadReusableRouteEvidence(root, siteKey, resumeManifest, requestedRoutes, { modules, visualRoutes: new Set(normalizedVisualConfig?.regions.map((region) => region.route) ?? []) }) : new Map();
    const visualRoutes = normalizedVisualConfig ? new Set(normalizedVisualConfig.regions.map((region) => region.route)) : new Set();
    for (const [routeIndex, route] of requestedRoutes.entries()) {
      const artifactKey = routeArtifactKey(route, routeIndex);
      const reusable = reusableRoutes.get(route);
      if (reusable) {
        const restored = copyReusableRoute(root, siteKey, resumeManifest, runId, reusable, artifactKey, modules);
        routeRecords.push({ ...restored.routeRecord });
        controls.push(...(restored.controls.observations ?? []));
        classObservations.push(restored.classes);
        requestsByRoute.push(restored.requests);
        if (restored.visual) visualObservations.push(restored.visual);
        if (restored.motion) motionObservations.push(restored.motion);
        if (restored.domSnapshot) domSnapshotObservations.push({
          route: restored.domSnapshot.route,
          url: restored.domSnapshot.url,
          summary: restored.domSnapshot.summary,
          structure: restored.domSnapshot.structure,
          fingerprint: restored.domSnapshot.fingerprint,
          artifactPath: `measurements/dom-snapshots/${artifactKey}.json`,
        });
        if (restored.responsive) responsiveObservations.push({ observation: restored.responsive, artifactPath: `measurements/responsive/${artifactKey}.json` });
        if (restored.assets) assetObservations.push({ observation: restored.assets, artifactPath: `measurements/assets/${artifactKey}.json` });
        scope.routesCompleted.push(route);
        scope.routesReused.push(route);
        updateRun(root, siteKey, runId, { scope: { ...scope, routesCompleted: [...scope.routesCompleted], routesFailed: [...scope.routesFailed], routesReused: [...scope.routesReused] } });
        continue;
      }
      const tracker = createRequestTracker(page);
      const assetTracker = assets ? createAssetTracker(page) : null;
      try {
        let response;
        try {
          response = await page.goto(routeUrl(baseUrl, route), { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (error) {
          throw preconditionError(`Route ${route} is unreachable: ${error instanceof Error ? error.message : String(error)}`, runId);
        }
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        const finalUrl = page.url();
        const pathname = routePath(finalUrl);
        const expectedPath = routePath(routeUrl(baseUrl, route));
        if (!response || response.status() >= 400) throw preconditionError(`Route ${route} returned ${response?.status() ?? 'no response'}`, runId);
        if (target === 'source' && !allowUnauthenticated && LOGIN_PATH.test(pathname)) {
          throw preconditionError(`Source session is expired or redirected to login at ${route}`, runId);
        }
        if (target === 'source' && !allowUnauthenticated && expectedPath !== pathname) {
          throw preconditionError(`Source route ${route} resolved to unexpected state ${pathname}`, runId);
        }
        const health = await runtimeHealth(page, target, { hydrationSelector });
        if (target === 'source' && !allowUnauthenticated && health.loginForm) {
          throw preconditionError(`Source session is not authenticated on ${route}`, runId);
        }
        const chunkFailures = tracker.statuses.filter((entry) => entry.status >= 400 && /\/_next\/static\/chunks\//iu.test(entry.url));
        const failedScripts = tracker.failures.filter((entry) => entry.resourceType === 'script' || /\/_next\/static\//iu.test(entry.url));
        if (target === 'clone' && (!health.clientJsLoaded || !health.hydrated || chunkFailures.length || failedScripts.length)) {
          throw preconditionError(`Clone runtime is not hydrated on ${route}; evidence=${health.hydrationEvidence}`, runId);
        }
        const identity = target === 'source' ? await sourceIdentity(page, { tenant, role }) : null;
        const identityProblem = identityFailure(identity);
        if (target === 'source' && !allowUnauthenticated && identityProblem) {
          throw preconditionError(`Source ${identityProblem} on ${route}`, runId);
        }
        const critical = criticalAuthFailures(tracker.statuses);
        if (target === 'source' && !allowUnauthenticated && critical.length) {
          throw preconditionError(`Critical authenticated document/runtime request failed on ${route}`, runId);
        }
        const routeControls = await collectControls(page, route);
        const routeClasses = await collectClasses(page, route);
        const visual = normalizedVisualConfig
          ? await captureVisualRegions(page, { config: normalizedVisualConfig, target, route })
          : null;
        const motionObservation = motion
          ? await captureMotion(page, { route, sample: motionSample })
          : null;
        const domSnapshotObservation = domSnapshot
          ? await captureDomSnapshot(page, { route })
          : null;
        const responsiveObservation = responsive
          ? await captureResponsive(page, { route })
          : null;
        const assetObservation = assets
          ? await captureAssetManifest(page, { route, tracker: assetTracker })
          : null;
        const requestRecord = { route, requests: [...tracker.statuses], failures: [...tracker.failures] };
        const routeRecord = {
          route,
          finalUrl: safeUrl(finalUrl),
          status: response.status(),
          title: health.title,
          health,
          identity,
        };
        writeArtifact(root, siteKey, runId, `measurements/routes/${artifactKey}.json`, routeRecord, { kind: 'route-observation' });
        writeArtifact(root, siteKey, runId, `measurements/controls/${artifactKey}.json`, { route, observations: routeControls }, { kind: 'control-observation' });
        writeArtifact(root, siteKey, runId, `measurements/classes/${artifactKey}.json`, routeClasses, { kind: 'runtime-class-observation' });
        writeArtifact(root, siteKey, runId, `measurements/requests/${artifactKey}.json`, requestRecord, { kind: 'request-observation' });
        if (visual) {
          const visualRecord = {
            ...visual,
            regions: visual.regions.map((region) => {
              const persistedRegion = { ...region };
              delete persistedRegion.image;
              return persistedRegion;
            }),
          };
          for (const region of visual.regions) {
            if (region.image) writeArtifact(root, siteKey, runId, region.artifactPath, region.image, { kind: 'visual-region-png', visibility: 'private' });
          }
          writeArtifact(root, siteKey, runId, `measurements/visual-regions/${artifactKey}.json`, visualRecord, { kind: 'visual-region-observation', visibility: 'private' });
          visualObservations.push(visualRecord);
        }
        if (motionObservation) {
          writeArtifact(root, siteKey, runId, `measurements/motion/${artifactKey}.json`, motionObservation, { kind: 'motion-observation' });
          motionObservations.push(motionObservation);
        }
        if (domSnapshotObservation) {
          const artifactPath = `measurements/dom-snapshots/${artifactKey}.json`;
          writeArtifact(root, siteKey, runId, artifactPath, domSnapshotObservation, { kind: 'dom-snapshot-observation', visibility: 'private' });
          domSnapshotObservations.push({
            route: domSnapshotObservation.route,
            url: domSnapshotObservation.url,
            summary: domSnapshotObservation.summary,
            structure: domSnapshotObservation.structure,
            fingerprint: domSnapshotObservation.fingerprint,
            artifactPath,
          });
        }
        if (responsiveObservation) {
          const artifactPath = `measurements/responsive/${artifactKey}.json`;
          writeArtifact(root, siteKey, runId, artifactPath, responsiveObservation, { kind: 'responsive-observation', visibility: 'private' });
          responsiveObservations.push({ observation: responsiveObservation, artifactPath });
        }
        if (assetObservation) {
          const artifactPath = `measurements/assets/${artifactKey}.json`;
          writeArtifact(root, siteKey, runId, artifactPath, assetObservation, { kind: 'asset-observation', visibility: 'private' });
          assetObservations.push({ observation: assetObservation, artifactPath });
        }
        controls.push(...routeControls);
        classObservations.push(routeClasses);
        requestsByRoute.push(requestRecord);
        routeRecords.push(routeRecord);
        scope.routesCompleted.push(route);
        updateRun(root, siteKey, runId, { scope: { ...scope, routesCompleted: [...scope.routesCompleted], routesFailed: [...scope.routesFailed] } });
      } catch (error) {
        scope.routesFailed.push(route);
        const failure = {
          route,
          message: error instanceof Error ? error.message : String(error),
          requests: [...tracker.statuses],
          requestFailures: [...tracker.failures],
        };
        try {
          writeArtifact(root, siteKey, runId, `measurements/failures/${artifactKey}.json`, failure, { kind: 'route-failure' });
          updateRun(root, siteKey, runId, { scope: { ...scope, routesCompleted: [...scope.routesCompleted], routesFailed: [...scope.routesFailed] } });
        } catch {
          // The original route failure remains decisive if partial evidence cannot be appended.
        }
        throw error;
      } finally {
        tracker.stop();
        assetTracker?.stop();
      }
    }
    const audit = auditDeadRuntimeClasses(classObservations, { runId, scope: 'requested-routes' });
    const completedScope = { ...scope, routesCompleted: [...scope.routesCompleted], routesFailed: [...scope.routesFailed] };
    updateRun(root, siteKey, runId, { scope: completedScope });
    writeArtifact(root, siteKey, runId, 'measurements/routes.json', {
      schemaVersion: 1,
      runId,
      kind: 'route-inventory',
      capturedAt: new Date().toISOString(),
      routes: routeRecords,
    }, { kind: 'route-inventory' });
    if (authoritativeInventory) {
      writeArtifact(root, siteKey, runId, 'inventory.json', {
        schemaVersion: 1,
        runId,
        kind: 'route-inventory',
        authoritative: true,
        capturedAt: new Date().toISOString(),
        routes: routeRecords.map(({ route, finalUrl, status, title }) => ({ route, finalUrl, status, title })),
      }, { kind: 'route-inventory' });
    }
    writeArtifact(root, siteKey, runId, 'measurements/controls.json', {
      schemaVersion: 1,
      runId,
      kind: 'control-observation',
      capturedAt: new Date().toISOString(),
      observations: controls,
    }, { kind: 'control-observation' });
    writeArtifact(root, siteKey, runId, 'measurements/classes.json', {
      schemaVersion: 1,
      runId,
      kind: 'runtime-class-observation',
      capturedAt: new Date().toISOString(),
      routes: classObservations,
      audit,
    }, { kind: 'runtime-class-observation' });
    writeArtifact(root, siteKey, runId, 'measurements/requests.json', {
      schemaVersion: 1,
      runId,
      kind: 'request-observation',
      routes: requestsByRoute,
    }, { kind: 'request-observation' });
    if (normalizedVisualConfig) {
      writeArtifact(root, siteKey, runId, 'measurements/visual-regions.json', {
        schemaVersion: 1,
        kind: 'visual-region-observation',
        config: normalizedVisualConfig,
        configSha256: visualConfigSha256,
        routes: visualObservations,
        complete: visualObservations.length === visualRoutes.size && visualObservations.every((entry) => entry.complete),
      }, { kind: 'visual-region-observation', visibility: 'private' });
    }
    if (motion) {
      writeArtifact(root, siteKey, runId, 'measurements/motion.json', {
        schemaVersion: 1,
        kind: 'motion-observation',
        sampled: motionSample,
        routes: motionObservations,
        complete: motionObservations.length === routeRecords.length,
      }, { kind: 'motion-observation' });
    }
    if (domSnapshot) {
      writeArtifact(root, siteKey, runId, 'measurements/dom-snapshots.json', {
        schemaVersion: 1,
        kind: 'dom-snapshot-observation',
        routes: domSnapshotObservations,
        complete: domSnapshotObservations.length === routeRecords.length,
      }, { kind: 'dom-snapshot-observation', visibility: 'private' });
    }
    if (responsive) {
      const responsiveIndex = {
        schemaVersion: 1,
        kind: 'responsive-observation-index',
        routes: responsiveObservations.map(({ observation, artifactPath }) => responsiveIndexEntry(observation, artifactPath)),
        complete: responsiveObservations.length === routeRecords.length
          && responsiveObservations.every(({ observation }) => observation.complete === true),
      };
      writeArtifact(root, siteKey, runId, 'measurements/responsive.json', responsiveIndex, { kind: 'responsive-observation-index' });
    }
    if (assets) {
      const assetIndex = {
        schemaVersion: 1,
        kind: 'asset-observation-index',
        routes: assetObservations.map(({ observation, artifactPath }) => assetIndexEntry(observation, artifactPath)),
        complete: assetObservations.length === routeRecords.length
          && assetObservations.every(({ observation }) => observation.complete === true),
      };
      writeArtifact(root, siteKey, runId, 'measurements/assets.json', assetIndex, { kind: 'asset-observation-index' });
    }
    const inventory = inventoryContext
      ? { runId: inventoryContext.runId, routes: inventoryContext.routes, ...(inventoryContext.controls !== undefined ? { controls: inventoryContext.controls } : {}), authoritative: true }
      : authoritativeInventory
        ? { runId, routes: requestedRoutes.length, controls: controls.length, authoritative: true }
        : { runId: null, routes: requestedRoutes.length, controls: controls.length, authoritative: false, source: 'requested-routes' };
    const inventoryScope = inventoryContext
      ? (requestedRoutes.length === inventoryContext.routePaths.length && requestedRoutes.every((route) => inventoryContext.routePaths.includes(routePath(route))) ? 'inventory-scope' : 'subset')
      : authoritativeInventory ? 'full' : 'ad-hoc';
    const coverage = {
      schemaVersion: 1,
      inventory,
      measurement: {
        routesRequested: requestedRoutes.length,
        routesCompleted: routeRecords.length,
        controlsDiscovered: controls.length,
        controlsClassified: 0,
        stylesheetsTotal: classObservations.reduce((sum, entry) => sum + (entry.stylesheetsTotal ?? 0), 0),
        stylesheetsReadable: classObservations.reduce((sum, entry) => sum + (entry.stylesheetsReadable ?? 0), 0),
        stylesheetsUnreadable: classObservations.reduce((sum, entry) => sum + (entry.stylesheetsUnreadable ?? 0), 0),
        cssCoverageComplete: classObservations.every((entry) => entry.cssCoverageComplete !== false),
        ...(normalizedVisualConfig ? {
          visualRegionsConfigured: normalizedVisualConfig.regions.length,
          visualRoutesCaptured: visualObservations.length,
          visualCoverageComplete: visualObservations.length === visualRoutes.size && visualObservations.every((entry) => entry.complete),
        } : {}),
        ...(motion ? {
          motionRoutesCaptured: motionObservations.length,
          motionCoverageComplete: motionObservations.length === routeRecords.length,
          motionSampled: motionSample,
        } : {}),
        ...(domSnapshot ? {
          domSnapshotRoutesCaptured: domSnapshotObservations.length,
          domSnapshotCoverageComplete: domSnapshotObservations.length === routeRecords.length,
        } : {}),
        ...(responsive ? {
          responsiveRoutesCaptured: responsiveObservations.length,
          responsiveRoutesComplete: responsiveObservations.filter(({ observation }) => observation.complete === true).length,
          responsiveProbesExpected: responsiveObservations.reduce((sum, { observation }) => sum + (observation.probeCoverage?.expected ?? 0), 0),
          responsiveProbesCaptured: responsiveObservations.reduce((sum, { observation }) => sum + (observation.probeCoverage?.captured ?? 0), 0),
          responsiveProbeFailures: responsiveObservations.reduce((sum, { observation }) => sum + (observation.probeCoverage?.failed ?? 0), 0),
          responsiveStylesheetsTotal: responsiveObservations.reduce((sum, { observation }) => sum + (observation.stylesheetCoverage?.total ?? 0), 0),
          responsiveStylesheetsReadable: responsiveObservations.reduce((sum, { observation }) => sum + (observation.stylesheetCoverage?.readable ?? 0), 0),
          responsiveStylesheetsUnreadable: responsiveObservations.reduce((sum, { observation }) => sum + (observation.stylesheetCoverage?.unreadable ?? 0), 0),
          responsiveCoverageComplete: responsiveObservations.length === routeRecords.length
            && responsiveObservations.every(({ observation }) => observation.complete === true),
        } : {}),
        ...(assets ? {
          assetRoutesCaptured: assetObservations.length,
          assetRoutesComplete: assetObservations.filter(({ observation }) => observation.complete === true).length,
          assetResponsesObserved: assetObservations.reduce((sum, { observation }) => sum + (observation.responseCoverage?.observed ?? 0), 0),
          assetResponsesHashed: assetObservations.reduce((sum, { observation }) => sum + (observation.responseCoverage?.hashed ?? 0), 0),
          assetBodyFailures: assetObservations.reduce((sum, { observation }) => sum + (observation.responseCoverage?.bodyFailures ?? 0), 0),
          assetHttpFailures: assetObservations.reduce((sum, { observation }) => sum + (observation.responseCoverage?.httpFailures ?? 0), 0),
          assetRequestFailures: assetObservations.reduce((sum, { observation }) => sum + (observation.responseCoverage?.requestFailures ?? 0), 0),
          assetCoverageComplete: assetObservations.length === routeRecords.length
            && assetObservations.every(({ observation }) => observation.complete === true),
        } : {}),
      },
      scope: inventoryScope,
      ...(resumeManifest ? { resume: { runId: resumeManifest.runId, routesReused: [...scope.routesReused] } } : {}),
    };
    writeArtifact(root, siteKey, runId, 'coverage.json', coverage, { kind: 'coverage' });
    const closed = closeRun(root, siteKey, runId, { runtime: { serverHealthy: true, hydrated: target === 'clone' ? routeRecords.every((entry) => entry.health.hydrated) : null, authenticated: target === 'source' } });
    if (authoritativeInventory) setRef(root, siteKey, `${target}-current`, runId);
    return redactForPersistence({ manifest: closed, routes: routeRecords, audit, coverage });
  } catch (error) {
    try {
      failRun(root, siteKey, runId, error);
    } catch {
      // Preserve the original precondition error if a partial run could not be finalized.
    }
    if (error && typeof error === 'object' && !error.runId) error.runId = runId;
    throw error;
  } finally {
    if (context) {
      const browser = context.__clonerBrowser;
      await context.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
    await managedServer?.stop().catch(() => {});
  }
}
