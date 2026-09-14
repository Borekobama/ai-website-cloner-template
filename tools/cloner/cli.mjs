#!/usr/bin/env node

import { chromium } from 'playwright';
import { auditDeadControls } from './audits/dead-controls.mjs';
import { auditDeadRuntimeClasses } from './audits/dead-classes.mjs';
import { compareRuns, findingCanClose, findingEventsFromReport } from './diff.mjs';
import {
  auditFindingCanClose,
  readLedger,
  recordFindingStatus,
  recordReportFindings,
  stableFindingId,
  summarizeFindings,
} from './ledger.mjs';
import { measureTarget, runtimeHealth, sourceIdentity } from './measure.mjs';
import { loadPolicy, policySha256 } from './policy.mjs';
import { runSelfTests } from './selftest.mjs';
import { normalizeVisualRegionConfig } from './visual-regions.mjs';
import {
  closeRun,
  createRun,
  createRunId,
  failRun,
  freezeFixture,
  parityRoot,
  readArtifact,
  readManifest,
  resolveRunId,
  sha256,
  updateRun,
  writeArtifact,
} from './run-store.mjs';

const HELP = `
AI Website Cloner parity CLI v0.10.0

Usage:
  npm run cloner -- <command> [options]

Commands:
  measure                         Capture a source or clone into a new immutable run
  diff                            Compare two immutable runs with explicit policies
  audit dead-controls             Audit controls with Playwright actionability checks
  audit dead-classes               Audit route-scoped runtime classes against compiled CSS
  findings                        Read the append-only findings ledger
  fixture freeze                  Freeze a run as golden evidence for self-tests
  selftest                        Run instrument regression tests
  help                            Show this command authority

Common options:
  --root <path>                  Repository root (default: current directory)
  --site <site-key>              Site namespace (derived from --url for measure)
  --policy <path>                Target-specific parity-exceptions.json
  --json                         Emit JSON only

Measure options:
  --target source|clone          Measurement target (required)
  --url <url>                    Source or clone origin
  --routes <route,...>           Requested routes (default: URL pathname)
  --profile <path>               Persistent source browser profile
  --tenant <id>                  Expected source tenant/workspace identity
  --role <name>                  Expected source role identity
  --profile-id <id>              Non-secret profile label for the manifest
  --inventory-run <run-id|current>  Existing immutable inventory for a subset measurement
  --inventory                     Declare this requested route set as the authoritative inventory
  --server existing|managed      Clone server mode (default: existing)
  --hydration-selector <css>     Optional explicit clone hydration marker
  --visual-regions <path>        Versioned region-scoped visual measurement config
  --motion                      Capture declared motion/state evidence
  --motion-sample               Capture deterministic Web Animations API samples with --motion
  --dom-snapshot                Capture Chromium CDP DOMSnapshot evidence
  --responsive                  Discover responsive CSS conditions and probe px thresholds
  --assets                      Capture network assets and DOM/CSS asset associations

Diff options:
  --source <run-id|current>      Concrete source run or source-current ref
  --clone <run-id|current>       Concrete clone run or clone-current ref
  --source-target source|clone   Target kind for --source (historical comparisons)
  --clone-target source|clone    Target kind for --clone (historical comparisons)
  --source-audit <run-id>        Explicit compatible source dead-controls audit
  --clone-audit <run-id>         Explicit compatible clone dead-controls audit

Audit options:
  --run <run-id|current>          Existing measurement run to audit
  --target source|clone          Resolve current ref and action target
  --route <path>                 Restrict a browser audit to one route
  --profile <path>               Persistent source profile when auditing source

Findings options:
  --status verified|closed       Append status event for --finding
  --finding <id>                 Stable finding ID for status event
  --run <run-id>                 Concrete run ID for status event

Fixture options:
  --public                       Explicitly promote frozen evidence into tracked tools/cloner/fixtures
`;

const LOGIN_PATH = /(?:^|\/)(?:login|signin|sign-in|auth)(?:\/|$)/iu;

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const options = { command, _: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      options._.push(token);
      continue;
    }
    const [key, inline] = token.slice(2).split('=', 2);
    if (inline !== undefined) {
      options[key] = inline;
    } else if (rest[index + 1] && !rest[index + 1].startsWith('--')) {
      options[key] = rest[index + 1];
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function required(options, key) {
  if (!options[key]) throw new Error(`Missing required option --${key}`);
  return options[key];
}

function routesFrom(options) {
  const values = options.routes ? String(options.routes).split(',') : [];
  return values.map((route) => route.trim()).filter(Boolean).map((route) => route.startsWith('/') ? route : `/${route}`);
}

function siteKeyFromUrl(url) {
  const parsed = new URL(url);
  const readable = parsed.host.toLowerCase().replace(/[^a-z0-9.-]+/gu, '-').replace(/^-|-$/gu, '') || 'site';
  const hash = sha256(parsed.origin).slice(0, 8);
  return `${readable}-${hash}`;
}

function jsonOutput(value) {
  console.log(JSON.stringify(value, null, 2));
}

function pathForRunArtifact(root, siteKey, runId, artifactPath) {
  return `${parityRoot(root, siteKey)}/runs/${runId}/${artifactPath}`;
}

function normalizedPathname(value, origin) {
  const pathname = new URL(value, origin).pathname || '/';
  return pathname.length > 1 ? pathname.replace(/\/$/u, '') : pathname;
}

function auditRouteIdentity(sourceManifest, parentRoutes, route) {
  const parent = parentRoutes.routes?.find((entry) => entry.route === route);
  if (!parent) throw new Error(`Audit route ${route} is not present in parent measurement ${sourceManifest.runId}`);
  return {
    route,
    pathname: normalizedPathname(parent.finalUrl ?? route, sourceManifest.target.origin),
  };
}

function cloneHealthAuditContext({ auditName, target, siteKey, parentManifest, parentRunId, audit, findings }) {
  const evidenceClass = auditName === 'dead-controls' ? 'dead-control' : 'dead-runtime-class';
  const inventoryRunId = parentManifest.scope?.inventoryRunId ?? null;
  const targetContext = {
    kind: target,
    tenant: parentManifest.target?.tenant ?? null,
    role: parentManifest.target?.role ?? null,
    profileId: parentManifest.target?.profileId ?? null,
  };
  const coveredRoutes = auditName === 'dead-controls'
    ? (audit.routes ?? [])
        .filter((entry) => entry.classifiedCount === entry.controlCount)
        .map((entry) => entry.route)
    : (audit.routes ?? [])
        .filter((entry) => entry.cssCoverageComplete)
        .map((entry) => entry.route);
  return {
    auditName,
    target,
    siteKey,
    targetContext,
    evidenceClass,
    parentRunId,
    inventoryRunId,
    provenanceRunId: inventoryRunId ?? parentRunId,
    coveredRoutes,
    routesRequested: (audit.routes ?? []).map((entry) => entry.route).filter(Boolean),
    routesFailed: [],
    routes: audit.routes ?? [],
    findings,
  };
}

function recordCloneHealthAuditFindings({
  root,
  siteKey,
  auditName,
  target,
  parentManifest,
  parentRunId,
  auditRunId,
  audit,
  findingEntries,
  artifact,
}) {
  if (target !== 'clone') return [];
  const baseContext = cloneHealthAuditContext({ auditName, target, siteKey, parentManifest, parentRunId, audit, findings: [] });
  const enrichedFindings = findingEntries.map(({ finding, locator }) => ({
    ...finding,
    domain: 'clone-health',
    target: 'clone',
    siteKey,
    targetContext: baseContext.targetContext,
    audit: {
      name: auditName,
      evidenceClass: baseContext.evidenceClass,
      siteKey,
      targetContext: baseContext.targetContext,
      parentRunId,
      inventoryRunId: baseContext.inventoryRunId,
      provenanceRunId: baseContext.provenanceRunId,
    },
    evidence: {
      clone: { runId: auditRunId, artifact, locator },
    },
  }));
  const current = { ...baseContext, findings: enrichedFindings };
  const previous = new Map(summarizeFindings(readLedger(root, siteKey)).map((finding) => [finding.findingId, finding]));
  const events = enrichedFindings.map((finding) => {
    const findingId = stableFindingId(finding);
    const prior = previous.get(findingId);
    return {
      type: prior && prior.status !== 'closed' ? 'finding.verified' : 'finding.opened',
      findingId,
      runId: auditRunId,
      finding,
    };
  });
  const currentIds = new Set(events.map((event) => event.findingId));
  for (const prior of previous.values()) {
    if (prior.status === 'closed' || currentIds.has(prior.findingId)) continue;
    if (!auditFindingCanClose(prior, current)) continue;
    events.push({
      type: 'finding.closed',
      findingId: prior.findingId,
      runId: auditRunId,
      evidence: { runId: auditRunId, artifact, locator: '#/findings' },
    });
  }
  recordReportFindings(root, siteKey, events);
  return events;
}

async function validateSourceAuditPage(page, expected) {
  const observedUrl = new URL(page.url());
  const expectedOrigin = new URL(expected.origin).origin;
  if (observedUrl.origin !== expectedOrigin) {
    return { valid: false, reason: `Source trial origin ${observedUrl.origin} does not match ${expectedOrigin}` };
  }
  const pathname = normalizedPathname(observedUrl.href, expectedOrigin);
  if (LOGIN_PATH.test(pathname)) return { valid: false, reason: 'Source trial is redirected to an authentication route' };
  if (pathname !== expected.pathname) {
    return { valid: false, reason: `Source trial pathname ${pathname} does not match expected ${expected.pathname}` };
  }
  const health = await runtimeHealth(page, 'source');
  if (health.loginForm) return { valid: false, reason: 'Source trial exposes an authentication form' };
  const identity = await sourceIdentity(page, { tenant: expected.tenant, role: expected.role });
  if (expected.tenant !== undefined && identity.tenantStatus !== 'matched') {
    return { valid: false, reason: `Source trial tenant identity is ${identity.tenantStatus}` };
  }
  if (expected.role !== undefined && identity.roleStatus !== 'matched') {
    return { valid: false, reason: `Source trial role identity is ${identity.roleStatus}` };
  }
  return { valid: true };
}

async function commandMeasure(options) {
  const url = required(options, 'url');
  const target = required(options, 'target');
  const root = options.root ? String(options.root) : process.cwd();
  const siteKey = options.site ? String(options.site) : siteKeyFromUrl(url);
  const policy = loadPolicy(options.policy, root, siteKey);
  const visualConfig = options['visual-regions'] ? normalizeVisualRegionConfig(String(options['visual-regions'])) : null;
  const inventoryRunId = options['inventory-run']
    ? resolveRunId(root, siteKey, String(options['inventory-run']), target)
    : null;
  const result = await measureTarget({
    root,
    siteKey,
    target,
    url,
    routes: routesFrom(options),
    profileDir: options.profile ? String(options.profile) : undefined,
    tenant: options.tenant,
    role: options.role,
    profileId: options['profile-id'],
    policy,
    hydrationSelector: options['hydration-selector'] ?? null,
    server: options.server ?? 'existing',
    inventoryRunId,
    authoritativeInventory: Boolean(options.inventory),
    visualConfig,
    motion: Boolean(options.motion || options['motion-sample']),
    motionSample: Boolean(options['motion-sample']),
    domSnapshot: Boolean(options['dom-snapshot']),
    responsive: Boolean(options.responsive),
    assets: Boolean(options.assets),
  });
  jsonOutput({ runId: result.manifest.runId, status: result.manifest.status, siteKey, target, coverage: result.coverage });
}

function resolveMeasurementRun(options, root, siteKey) {
  const target = options.target ?? 'clone';
  const reference = required(options, 'run');
  return resolveRunId(root, siteKey, reference, target);
}

async function commandAudit(options, auditName) {
  await runSelfTests();
  const root = options.root ? String(options.root) : process.cwd();
  const siteKey = required(options, 'site');
  const target = options.target ?? 'clone';
  const runId = resolveMeasurementRun(options, root, siteKey);
  const sourceManifest = readManifest(root, siteKey, runId);
  const policy = loadPolicy(options.policy, root, siteKey);
  const sourceCoverage = JSON.parse(readArtifact(root, siteKey, runId, 'coverage.json').toString('utf8'));
  const parentRoutes = JSON.parse(readArtifact(root, siteKey, runId, 'measurements/routes.json').toString('utf8'));
  const routes = auditName === 'dead-controls' && options.route ? [String(options.route)] : sourceManifest.scope.routesRequested;
  const expectedRoutes = routes.map((route) => auditRouteIdentity(sourceManifest, parentRoutes, route));
  const auditTarget = {
    kind: target,
    origin: sourceManifest.target.origin,
    profileId: sourceManifest.target.profileId ?? null,
    tenant: sourceManifest.target.tenant ?? null,
    role: sourceManifest.target.role ?? null,
    expectedRoutes,
  };
  if (auditName === 'dead-classes') {
    const measurement = JSON.parse(readArtifact(root, siteKey, runId, 'measurements/classes.json').toString('utf8'));
    const audit = auditDeadRuntimeClasses(measurement.routes, { runId, scope: sourceCoverage.scope ?? 'requested-routes' });
    const auditRunId = createRunId('audit-classes');
    createRun({ root, siteKey, runId: auditRunId, kind: 'audit', target: auditTarget, scope: { parentRunId: runId, inventoryRunId: sourceManifest.scope.inventoryRunId ?? null, routesRequested: sourceManifest.scope.routesRequested, routesCompleted: sourceManifest.scope.routesCompleted, routesFailed: [] }, policySha256: policySha256(policy) });
    writeArtifact(root, siteKey, auditRunId, 'policy.json', policy, { kind: 'policy-snapshot' });
    writeArtifact(root, siteKey, auditRunId, 'audits/dead-classes.json', audit, { kind: 'dead-class-audit' });
    writeArtifact(root, siteKey, auditRunId, 'coverage.json', { inventory: sourceCoverage.inventory, measurement: { routesRequested: audit.routeCount, routesCompleted: audit.routeCount, controlsDiscovered: 0, controlsClassified: 0, stylesheetsTotal: audit.stylesheetsTotal, stylesheetsReadable: audit.stylesheetsReadable, stylesheetsUnreadable: audit.stylesheetsUnreadable, cssCoverageComplete: audit.cssCoverageComplete }, scope: sourceCoverage.scope ?? 'requested-scope', parentRunId: runId }, { kind: 'coverage' });
    const closed = closeRun(root, siteKey, auditRunId, { runtime: { serverHealthy: true, hydrated: true } });
    recordCloneHealthAuditFindings({
      root,
      siteKey,
      auditName,
      target,
      parentManifest: sourceManifest,
      parentRunId: runId,
      auditRunId,
      audit,
      findingEntries: audit.findings.map((finding, index) => ({ finding, locator: `#/findings/${index}` })),
      artifact: 'audits/dead-classes.json',
    });
    jsonOutput({ runId: closed.runId, status: closed.status, audit });
    return;
  }
  const auditRunId = createRunId('audit-controls');
  createRun({ root, siteKey, runId: auditRunId, kind: 'audit', target: auditTarget, scope: { parentRunId: runId, inventoryRunId: sourceManifest.scope.inventoryRunId ?? null, routesRequested: routes, routesCompleted: [], routesFailed: [] }, policySha256: policySha256(policy) });
  writeArtifact(root, siteKey, auditRunId, 'policy.json', policy, { kind: 'policy-snapshot' });
  let context;
  try {
    if (target === 'source' && !options.profile) throw new Error('Source control audits require --profile and a policy-reviewed persistent context');
    context = options.profile
      ? await chromium.launchPersistentContext(String(options.profile), { headless: true })
      : await (async () => {
        const browser = await chromium.launch({ headless: true });
        const newContext = await browser.newContext();
        newContext.__clonerBrowser = browser;
        return newContext;
      })();
    const page = await context.newPage();
    const audits = [];
    const failedRoutes = [];
    for (const [routeIndex, route] of routes.entries()) {
      const artifactKey = `${String(routeIndex + 1).padStart(4, '0')}-${sha256(route).slice(0, 12)}`;
      const expectedRoute = expectedRoutes.find((entry) => entry.route === route);
      try {
        const response = await page.goto(new URL(route, sourceManifest.target.origin).toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (!response || response.status() >= 400) throw new Error(`Route ${route} returned ${response?.status() ?? 'no response'}`);
        const health = await runtimeHealth(page, target);
        if (target === 'clone' && (!health.clientJsLoaded || !health.hydrated)) throw new Error(`Clone runtime is not hydrated on ${route}`);
        if (target === 'source') {
          const validation = await validateSourceAuditPage(page, {
            origin: sourceManifest.target.origin,
            pathname: expectedRoute.pathname,
            tenant: sourceManifest.target.tenant,
            role: sourceManifest.target.role,
          });
          if (!validation.valid) throw new Error(`${validation.reason} at ${route}`);
        }
        const audit = await auditDeadControls(page, {
          policy,
          target,
          route,
          validateTrial: target === 'source'
            ? (trialPage) => validateSourceAuditPage(trialPage, {
              origin: sourceManifest.target.origin,
              pathname: expectedRoute.pathname,
              tenant: sourceManifest.target.tenant,
              role: sourceManifest.target.role,
            })
            : null,
        });
        audits.push(audit);
        writeArtifact(root, siteKey, auditRunId, `audits/dead-controls/routes/${artifactKey}.json`, audit, { kind: 'dead-control-route-audit' });
        updateRun(root, siteKey, auditRunId, { scope: { parentRunId: runId, inventoryRunId: sourceManifest.scope.inventoryRunId ?? null, routesRequested: routes, routesCompleted: audits.map((entry) => entry.route), routesFailed: [...failedRoutes] } });
      } catch (error) {
        failedRoutes.push(route);
        try {
          writeArtifact(root, siteKey, auditRunId, `audits/dead-controls/failures/${artifactKey}.json`, { route, message: error instanceof Error ? error.message : String(error) }, { kind: 'route-failure' });
          updateRun(root, siteKey, auditRunId, { scope: { parentRunId: runId, inventoryRunId: sourceManifest.scope.inventoryRunId ?? null, routesRequested: routes, routesCompleted: audits.map((entry) => entry.route), routesFailed: [...failedRoutes] } });
        } catch {
          // Preserve the original route failure if partial evidence cannot be appended.
        }
        throw error;
      }
    }
    const completedRoutes = audits.map((audit) => audit.route);
    updateRun(root, siteKey, auditRunId, { scope: { parentRunId: runId, inventoryRunId: sourceManifest.scope.inventoryRunId ?? null, routesRequested: routes, routesCompleted: completedRoutes, routesFailed: [] } });
    writeArtifact(root, siteKey, auditRunId, 'audits/dead-controls.json', { schemaVersion: 1, kind: 'dead-control-audit', runId: auditRunId, routes: audits }, { kind: 'dead-control-audit' });
    const sameRouteScope = routes.length === sourceManifest.scope.routesRequested.length && routes.every((route) => sourceManifest.scope.routesRequested.includes(route));
    writeArtifact(root, siteKey, auditRunId, 'coverage.json', { inventory: sourceCoverage.inventory, measurement: { routesRequested: routes.length, routesCompleted: audits.length, controlsDiscovered: audits.reduce((sum, audit) => sum + audit.controlCount, 0), controlsClassified: audits.reduce((sum, audit) => sum + audit.classifiedCount, 0) }, scope: sameRouteScope ? sourceCoverage.scope : 'subset', parentRunId: runId }, { kind: 'coverage' });
    const closed = closeRun(root, siteKey, auditRunId, { runtime: { serverHealthy: true, hydrated: target === 'clone' ? true : null, authenticated: target === 'source' ? true : null } });
    recordCloneHealthAuditFindings({
      root,
      siteKey,
      auditName,
      target,
      parentManifest: sourceManifest,
      parentRunId: runId,
      auditRunId,
      audit: { routes: audits },
      findingEntries: audits.flatMap((audit, auditIndex) => audit.findings.map((finding, index) => ({ finding, locator: `#/routes/${auditIndex}/findings/${index}` }))),
      artifact: 'audits/dead-controls.json',
    });
    jsonOutput({ runId: closed.runId, status: closed.status, audits });
  } catch (error) {
    try {
      if (readManifest(root, siteKey, auditRunId).status === 'open') failRun(root, siteKey, auditRunId, error);
    } catch {
      // Preserve the original audit failure if finalization also fails.
    }
    throw error;
  } finally {
    if (context) {
      const browser = context.__clonerBrowser;
      await context.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }
}

function commandDiff(options) {
  const root = options.root ? String(options.root) : process.cwd();
  const siteKey = required(options, 'site');
  const sourceTarget = options['source-target'] ?? 'source';
  const cloneTarget = options['clone-target'] ?? 'clone';
  const sourceRunId = resolveRunId(root, siteKey, options.source ?? 'current', sourceTarget);
  const cloneRunId = resolveRunId(root, siteKey, options.clone ?? 'current', cloneTarget);
  const policy = loadPolicy(options.policy, root, siteKey);
  const reportRunId = createRunId('diff');
  const report = compareRuns({ root, siteKey, sourceRunId, cloneRunId, reportRunId, policy, sourceAuditRunId: options['source-audit'] ?? null, cloneAuditRunId: options['clone-audit'] ?? null });
  createRun({ root, siteKey, runId: reportRunId, kind: 'diff', target: { kind: 'comparison', sourceRunId, cloneRunId }, scope: { sourceRunId, cloneRunId, routesRequested: [], routesCompleted: [] }, policySha256: policySha256(policy) });
  writeArtifact(root, siteKey, reportRunId, 'policy.json', policy, { kind: 'policy-snapshot' });
  for (const visualArtifact of report.visualArtifacts ?? []) {
    writeArtifact(root, siteKey, reportRunId, visualArtifact.path, visualArtifact.image, { kind: 'visual-region-diff-png', visibility: visualArtifact.visibility ?? 'private' });
  }
  const visualArtifacts = (report.visualArtifacts ?? []).map(({ path, visibility }) => ({ path, visibility }));
  const reportData = { ...report, visualArtifacts };
  delete reportData.visualArtifacts;
  writeArtifact(root, siteKey, reportRunId, 'report.json', { ...reportData, reportRunId }, { kind: 'report' });
  writeArtifact(root, siteKey, reportRunId, 'coverage.json', {
    inventory: { source: report.coverage.sourceDetails?.inventory ?? null, clone: report.coverage.cloneDetails?.inventory ?? null },
    measurement: {
      routesRequested: report.coverage.source,
      routesCompleted: report.coverage.clone,
      ...(report.responsiveCoverage?.configured ? {
        responsiveRoutesCompared: report.responsiveCoverage.routesCompared ?? 0,
        responsiveMediaProbesCompared: report.responsiveCoverage.mediaProbesCompared ?? 0,
        responsiveCoverageComplete: report.responsiveCoverage.complete === true,
      } : {}),
    },
      ...(report.responsiveCoverage?.configured ? { responsive: report.responsiveCoverage } : {}),
    ...(report.assetCoverage?.configured ? { assets: report.assetCoverage } : {}),
    scope: 'comparison',
  }, { kind: 'coverage' });
  const closed = closeRun(root, siteKey, reportRunId);
  const previous = new Map(summarizeFindings(readLedger(root, siteKey)).map((finding) => [finding.findingId, finding]));
  const currentEvents = findingEventsFromReport(report).map((event) => {
    const prior = previous.get(event.findingId);
    return {
      ...event,
      type: prior && prior.status !== 'closed' ? 'finding.verified' : 'finding.opened',
      runId: reportRunId,
    };
  });
  const currentIds = new Set(currentEvents.map((event) => event.findingId));
  const currentComparison = currentEvents[0]?.finding?.comparison ?? {
    sourceKind: report.source?.target?.kind ?? null,
    cloneKind: report.clone?.target?.kind ?? null,
  };
  for (const finding of previous.values()) {
    if (finding.status === 'closed' || currentIds.has(finding.findingId)) continue;
    if (!finding.sourceRunId || !finding.cloneRunId) continue;
    const previousComparison = finding.finding?.comparison ?? null;
    if (JSON.stringify(previousComparison) !== JSON.stringify(currentComparison)) continue;
    if (!findingCanClose(finding, report)) continue;
    currentEvents.push({ type: 'finding.closed', findingId: finding.findingId, runId: reportRunId, sourceRunId, cloneRunId, evidence: { runId: reportRunId, artifact: 'report.json', locator: '#/findings' } });
  }
  recordReportFindings(root, siteKey, currentEvents);
  jsonOutput({ ...reportData, visualArtifacts, reportRunId: closed.runId, reportPath: pathForRunArtifact(root, siteKey, reportRunId, 'report.json') });
}

function commandFindings(options) {
  const root = options.root ? String(options.root) : process.cwd();
  const siteKey = required(options, 'site');
  if (options.status) {
    jsonOutput(recordFindingStatus(root, siteKey, required(options, 'finding'), String(options.status), required(options, 'run')));
    return;
  }
  jsonOutput({ siteKey, findings: summarizeFindings(readLedger(root, siteKey)) });
}

function commandFixture(options) {
  const root = options.root ? String(options.root) : process.cwd();
  const siteKey = required(options, 'site');
  const runId = resolveRunId(root, siteKey, required(options, 'run'), options.target ?? 'clone');
  const name = required(options, 'name');
  jsonOutput(freezeFixture(root, siteKey, runId, name, { publicFixture: Boolean(options.public) }));
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'help' || options.help) {
    console.log(HELP.trim());
    return;
  }
  if (options.command === 'selftest') {
    await runSelfTests();
    console.log('cloner self-test: ok');
    return;
  }
  if (options.command === 'measure') return commandMeasure(options);
  if (options.command === 'diff') return commandDiff(options);
  if (options.command === 'findings') return commandFindings(options);
  if (options.command === 'fixture' && options._[0] === 'freeze') return commandFixture(options);
  if (options.command === 'audit' && ['dead-controls', 'dead-classes'].includes(options._[0])) return commandAudit(options, options._[0]);
  throw new Error(`Unknown command: ${options.command} ${options._.join(' ')}`);
}

try {
  await main();
} catch (error) {
  console.error(`cloner: ${error.message}`);
  if (error.runId) console.error(`failed run: ${error.runId}`);
  process.exitCode = 1;
}
