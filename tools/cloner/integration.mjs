#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findingEventsFromReport } from './diff.mjs';
import { readArtifact } from './run-store.mjs';
import { startFixtureServer } from './test-app/server.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CLI = join(ROOT, 'tools', 'cloner', 'cli.mjs');
const SITE = 'fixture.local-0.9';
const ROUTES = ['/home', '/noise', '/incomplete-css', '/destination'];

function runCli(root, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      const result = { code, stdout, stderr };
      if (code !== 0) {
        resolveResult(result);
        return;
      }
      try {
        resolveResult({ ...result, json: JSON.parse(stdout) });
      } catch (error) {
        reject(new Error(`CLI did not emit JSON for ${args.join(' ')}: ${error.message}\n${stdout}\n${stderr}`));
      }
    });
  });
}

function commonArgs(root, policyPath) {
  return ['--root', root, '--site', SITE, '--policy', policyPath];
}

async function measure(root, policyPath, target, url, extra = []) {
  const args = ['measure', '--target', target, '--url', url, '--routes', ROUTES.join(','), ...commonArgs(root, policyPath), ...extra];
  const result = await runCli(root, args);
  assert.equal(result.code, 0, `${target} measurement failed:\n${result.stderr}`);
  return result.json;
}

async function audit(root, policyPath, target, runId, extra = []) {
  const args = ['audit', 'dead-controls', '--target', target, '--run', runId, ...commonArgs(root, policyPath), ...extra];
  const result = await runCli(root, args);
  assert.equal(result.code, 0, `${target} audit failed:\n${result.stderr}`);
  return result.json;
}

async function main() {
  const parityRoot = mkdtempSync(join(tmpdir(), 'cloner-integration-'));
  const profile = join(parityRoot, 'source-profile');
  const policyPath = 'parity-exceptions.json';
  const visualConfigPath = join(parityRoot, 'visual-regions.json');
  writeFileSync(join(parityRoot, policyPath), `${JSON.stringify({
    version: 1,
    actions: [
      { id: 'fixture-source-allowance', match: { route: '/home' }, source: 'allow' },
      {
        id: 'destructive-fixture-control',
        match: { route: '/home', role: 'button', name: 'Delete account', controlClass: 'destructive' },
        source: 'block',
        clone: 'block',
      },
      {
        id: 'duplicate-destructive-first-only',
        match: { route: '/noise', role: 'button', name: 'Duplicate destructive', controlClass: 'destructive', occurrence: 0 },
        source: 'allow',
      },
      {
        id: 'duplicate-destructive-clone-block',
        match: { route: '/noise', role: 'button', name: 'Duplicate destructive', controlClass: 'destructive' },
        clone: 'block',
      },
    ],
    controlClasses: {
      menu: { dimensions: { overlay: 'gate' } },
      toggle: { dimensions: { aria: 'gate' } },
      'overlay-trigger': { dimensions: { overlay: 'gate' } },
      'dom-trigger': { dimensions: { dom: 'gate' } },
    },
  }, null, 2)}\n`);
  writeFileSync(visualConfigPath, `${JSON.stringify({
    schemaVersion: 1,
    regions: [{
      route: '/home',
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      id: 'chrome',
      selector: '[data-visual-region="chrome"]',
      classification: 'invariant',
      mode: 'gate',
      threshold: 0,
    }, {
      route: '/home',
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      id: 'overlay-open',
      selector: '#overlay-root',
      state: { action: 'click', selector: '[data-action="more"] >> nth=0' },
      classification: 'invariant',
      mode: 'gate',
      threshold: 0,
    }, {
      route: '/noise',
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      id: 'noise-panel',
      selector: 'main',
      mask: '#noise-value',
      classification: 'invariant',
      mode: 'gate',
      threshold: 0,
    }],
  }, null, 2)}\n`);
  let source;
  let clone;
  try {
    source = await startFixtureServer({ mode: 'source' });
    clone = await startFixtureServer({ mode: 'clone' });

    const broken = await runCli(parityRoot, [
      'measure', '--target', 'clone', '--url', `${clone.url}/broken-hydration`, '--routes', '/broken-hydration',
      ...commonArgs(parityRoot, policyPath),
    ]);
    assert.notEqual(broken.code, 0, 'broken hydration route must fail clone measurement');
    assert.match(broken.stderr, /Clone runtime is not hydrated on \/broken-hydration/);

    const unverified = await runCli(parityRoot, [
      'measure', '--target', 'clone', '--url', `${clone.url}/unverified-hydration`, '--routes', '/unverified-hydration',
      ...commonArgs(parityRoot, policyPath),
    ]);
    assert.notEqual(unverified.code, 0, 'unverified hydration route must fail clone measurement');
    assert.match(unverified.stderr, /Clone runtime is not hydrated on \/unverified-hydration; evidence=unverified/);

    // A marker without a Next.js runtime and a marker that turns true late
    // both pass. Typed trials and inert dialogs get their own categories.
    const formsMeasurement = await runCli(parityRoot, [
      'measure', '--target', 'clone', '--url', clone.url, '--routes', '/forms,/plain-hydrated,/late-hydration',
      ...commonArgs(parityRoot, policyPath),
    ]);
    assert.equal(formsMeasurement.code, 0, `marker-only and late hydration must pass:\n${formsMeasurement.stderr}`);
    const formsAudit = await audit(parityRoot, policyPath, 'clone', formsMeasurement.json.runId);
    const formsCategories = new Map(formsAudit.audits.flatMap((entry) => entry.observations).map((observation) => [observation.name, observation.category]));
    const expectedFormCategories = {
      'Forms page': 'already-active',
      'Plain field': 'input',
      'Filter items': 'DOM change',
      'Sort order': 'input',
      'Accept terms': 'input',
      Day: 'already-active',
      Week: 'DOM change',
      'Upload file': 'file-chooser',
      'Open dialog': 'overlay',
      'Dialog action': 'inert-overlay',
      'Late action': 'DOM change',
    };
    assert.deepEqual(Object.fromEntries(Object.keys(expectedFormCategories).map((name) => [name, formsCategories.get(name)])), expectedFormCategories);
    const formsClasses = await runCli(parityRoot, ['audit', 'dead-classes', '--target', 'clone', '--run', formsMeasurement.json.runId, ...commonArgs(parityRoot, policyPath)]);
    assert.equal(formsClasses.code, 0, formsClasses.stderr);
    assert.deepEqual(formsClasses.json.audit.routes.find((entry) => entry.route === '/forms').deadClasses, [], 'SVG and escaped leading-digit classes must resolve');

    const modules = ['--visual-regions', visualConfigPath, '--motion-sample', '--dom-snapshot', '--aria', '--head', '--performance'];
    const sourceMeasurement = await measure(parityRoot, policyPath, 'source', source.url, ['--profile', profile, '--inventory', ...modules]);
    const cloneMeasurement = await measure(parityRoot, policyPath, 'clone', clone.url, ['--inventory', ...modules]);
    const sourceRun = sourceMeasurement.runId;
    const cloneRun = cloneMeasurement.runId;
    assert.match(sourceRun, /^\d{8}T\d{6}Z_source_[a-f0-9]{8}$/);
    assert.match(cloneRun, /^\d{8}T\d{6}Z_clone_[a-f0-9]{8}$/);
    assert.equal(sourceMeasurement.coverage.measurement.domSnapshotCoverageComplete, true);
    assert.equal(cloneMeasurement.coverage.measurement.domSnapshotCoverageComplete, true);
    for (const coverage of [sourceMeasurement.coverage.measurement, cloneMeasurement.coverage.measurement]) {
      assert.equal(coverage.ariaCoverageComplete, true);
      assert.equal(coverage.headCoverageComplete, true);
      assert.equal(coverage.performanceCoverageComplete, true);
      assert.equal(coverage.runtimeErrorRoutesCaptured, ROUTES.length);
    }

    const sourceAudit = await audit(parityRoot, policyPath, 'source', sourceRun, ['--profile', profile]);
    const sourceClasses = await runCli(parityRoot, ['audit', 'dead-classes', '--target', 'source', '--run', sourceRun, ...commonArgs(parityRoot, policyPath)]);
    assert.equal(sourceClasses.code, 0, sourceClasses.stderr);

    const sourceEvidenceOnly = await runCli(parityRoot, ['findings', ...commonArgs(parityRoot, policyPath)]);
    assert.equal(sourceEvidenceOnly.code, 0, sourceEvidenceOnly.stderr);
    assert.deepEqual(sourceEvidenceOnly.json.findings, [], 'source audits must remain evidence-only and not create repair findings');

    const cloneAudit = await audit(parityRoot, policyPath, 'clone', cloneRun);
    const cloneClasses = await runCli(parityRoot, ['audit', 'dead-classes', '--target', 'clone', '--run', cloneRun, ...commonArgs(parityRoot, policyPath)]);
    assert.equal(cloneClasses.code, 0, cloneClasses.stderr);

    const initialDiff = await runCli(parityRoot, [
      'diff', '--source', sourceRun, '--clone', cloneRun, '--source-audit', sourceAudit.runId, '--clone-audit', cloneAudit.runId,
      ...commonArgs(parityRoot, policyPath),
    ]);
    assert.equal(initialDiff.code, 0, initialDiff.stderr);
    assert.equal(initialDiff.json.domSnapshotCoverage.complete, true);
    const initialCategories = new Set(initialDiff.json.findings.map((finding) => finding.category));
    const initialFindingIds = new Set(findingEventsFromReport(initialDiff.json).map((event) => event.findingId));
    for (const category of ['missing-control', 'control-aria-mismatch', 'control-overlay-mismatch', 'control-dom-mismatch', 'new-dead-runtime-class', 'visual-region-mismatch', 'motion-declared-mismatch', 'aria-outline-mismatch', 'head-description-mismatch', 'runtime-page-error-mismatch', 'runtime-hydration-error']) {
      assert.ok(initialCategories.has(category), `expected initial finding ${category}`);
    }
    assert.equal(initialCategories.has('motion-transform-mismatch'), false, 'equivalent transform longhands must compare equal');
    assert.equal(initialCategories.has('motion-samples-mismatch'), false, 'deterministic samples must compare equal');
    assert.equal(initialDiff.json.findings.some((finding) => finding.subject?.regionId === 'noise-panel'), false, 'masked timer text must not create a visual finding');
    const reportHtml = readFileSync(initialDiff.json.reportHtmlPath, 'utf8');
    assert.match(reportHtml, /visual-region-mismatch/u);
    assert.match(reportHtml, /<img loading="lazy"/u);
    assert.doesNotMatch(reportHtml, /<script/iu, 'report HTML must not carry executable content');
    const tokens = await runCli(parityRoot, ['tokens', '--run', sourceRun, '--target', 'source', ...commonArgs(parityRoot, policyPath)]);
    assert.equal(tokens.code, 0, tokens.stderr);
    const derivedTokens = JSON.parse(readFileSync(tokens.json.outputs.tokens, 'utf8'));
    assert.ok(derivedTokens.colors.text.some((entry) => entry.value === 'rgb(46, 139, 87)'), 'fixture text colour must appear in derived tokens');
    assert.ok(existsSync(tokens.json.outputs.theme));

    const cloneObservations = cloneAudit.audits.flatMap((entry) => entry.observations);
    const sourceObservations = sourceAudit.audits.flatMap((entry) => entry.observations);
    const sourceDuplicates = sourceObservations.filter((observation) => observation.name === 'Duplicate destructive');
    assert.deepEqual(sourceDuplicates.map((observation) => [observation.occurrence, observation.category]), [[0, 'dead'], [1, 'blocked-by-policy']]);
    const cloneDuplicates = cloneObservations.filter((observation) => observation.name === 'Duplicate destructive');
    assert.deepEqual(cloneDuplicates.map((observation) => [observation.occurrence, observation.category]), [[0, 'blocked-by-policy'], [1, 'blocked-by-policy']]);
    const dead = cloneObservations.find((observation) => observation.name === 'Dead button');
    assert.equal(dead?.category, 'dead');
    const noisyDead = cloneObservations.find((observation) => observation.name === 'Noisy dead button');
    assert.equal(noisyDead?.category, 'dead', 'ambient timer mutation must not make the noisy dead control active');
    assert.equal(noisyDead?.effect?.wholePage?.ambient?.domChanged, true, 'fixture must keep producing unrelated ambient DOM mutations');
    const blocked = cloneObservations.find((observation) => observation.name === 'Delete account');
    assert.equal(blocked?.category, 'blocked-by-policy');
    assert.equal(blocked?.actionExecuted, false);
    assert.equal(blocked?.policy?.reason, 'Clone interaction requires an explicit safe-action policy allowance');
    const duplicateMores = cloneObservations.filter((observation) => observation.name === 'More');
    assert.equal(duplicateMores.length, 1, 'initial clone should expose one of the duplicate More controls');
    assert.equal(duplicateMores[0].occurrence, 0);

    const incompleteCoverage = cloneMeasurement.coverage.measurement;
    assert.equal(incompleteCoverage.cssCoverageComplete, false);
    assert.ok(incompleteCoverage.stylesheetsUnreadable >= 1, 'incomplete CSS route must be recorded as unreadable');
    const homeClasses = cloneClasses.json.audit.routes.find((entry) => entry.route === '/home');
    assert.ok(homeClasses.compiledClasses.includes('readable-runtime'), 'readable runtime class must be compiled');
    assert.ok(homeClasses.deadClasses.includes('phantom'), 'class text inside declarations must not count as compiled selector');
    assert.equal(homeClasses.deadClasses.includes('readable-runtime'), false, 'readable runtime class must not be dead');
    assert.equal(cloneClasses.json.audit.routes.find((entry) => entry.route === '/incomplete-css').cssCoverageComplete, false);
    assert.equal(cloneClasses.json.audit.findings.some((finding) => finding.subject?.route === '/incomplete-css'), false, 'incomplete CSS must not create authoritative dead-class findings');
    const noiseRoute = cloneMeasurement.coverage.measurement.routesCompleted;
    assert.ok(noiseRoute === ROUTES.length, 'noisy timer route must complete measurement');

    const clonePort = clone.port;
    await clone.close();
    clone = await startFixtureServer({ mode: 'clone', repaired: true, port: clonePort });
    const repairedMeasurement = await measure(parityRoot, policyPath, 'clone', clone.url, ['--inventory-run', cloneRun, ...modules]);
    assert.equal(repairedMeasurement.coverage.measurement.domSnapshotCoverageComplete, true);
    const repairedAudit = await audit(parityRoot, policyPath, 'clone', repairedMeasurement.runId);
    const repairedClasses = await runCli(parityRoot, ['audit', 'dead-classes', '--target', 'clone', '--run', repairedMeasurement.runId, ...commonArgs(parityRoot, policyPath)]);
    assert.equal(repairedClasses.code, 0, repairedClasses.stderr);
    const repairedDiff = await runCli(parityRoot, [
      'diff', '--source', sourceRun, '--clone', repairedMeasurement.runId, '--source-audit', sourceAudit.runId, '--clone-audit', repairedAudit.runId,
      ...commonArgs(parityRoot, policyPath),
    ]);
    assert.equal(repairedDiff.code, 0, repairedDiff.stderr);
    assert.deepEqual(repairedDiff.json.findings, [], 'repaired clone should close all parity findings');

    const responsiveSourceMeasurement = await runCli(parityRoot, [
      'measure', '--target', 'source', '--url', source.url, '--routes', '/responsive', '--profile', profile, '--inventory', '--responsive',
      ...commonArgs(parityRoot, policyPath),
    ]);
    assert.equal(responsiveSourceMeasurement.code, 0, responsiveSourceMeasurement.stderr);
    const responsiveCloneMeasurement = await runCli(parityRoot, [
      'measure', '--target', 'clone', '--url', clone.url, '--routes', '/responsive', '--inventory', '--responsive',
      ...commonArgs(parityRoot, policyPath),
    ]);
    assert.equal(responsiveCloneMeasurement.code, 0, responsiveCloneMeasurement.stderr);
    assert.equal(responsiveSourceMeasurement.json.coverage.measurement.responsiveCoverageComplete, true);
    assert.equal(responsiveCloneMeasurement.json.coverage.measurement.responsiveCoverageComplete, true);
    const responsiveDiff = await runCli(parityRoot, [
      'diff', '--source', responsiveSourceMeasurement.json.runId, '--clone', responsiveCloneMeasurement.json.runId,
      ...commonArgs(parityRoot, policyPath),
    ]);
    assert.equal(responsiveDiff.code, 0, responsiveDiff.stderr);
    assert.equal(responsiveDiff.json.responsiveCoverage.complete, true);
    assert.deepEqual(responsiveDiff.json.findings, [], 'matching responsive fixture should produce no responsive findings');
    const responsiveIndex = JSON.parse(readArtifact(parityRoot, SITE, responsiveSourceMeasurement.json.runId, 'measurements/responsive.json').toString('utf8'));
    const responsiveRoute = JSON.parse(readArtifact(parityRoot, SITE, responsiveSourceMeasurement.json.runId, responsiveIndex.routes[0].artifactPath).toString('utf8'));
    const featureProbes = responsiveRoute.probes.filter((probe) => probe.features);
    assert.deepEqual(featureProbes.map((probe) => probe.features), [{ colorScheme: 'light' }, { colorScheme: 'dark' }, { touch: false }, { touch: true }]);
    assert.equal(featureProbes.find((probe) => probe.features.colorScheme === 'dark').mediaMatches.find((entry) => entry.condition === '(prefers-color-scheme:dark)')?.matches, true);
    assert.equal(featureProbes.find((probe) => probe.features.touch === true).mediaMatches.find((entry) => entry.condition === '(hover:none)')?.matches, true);

    const assetSourceMeasurement = await runCli(parityRoot, [
      'measure', '--target', 'source', '--url', source.url, '--routes', '/assets', '--profile', profile, '--inventory', '--assets',
      ...commonArgs(parityRoot, policyPath),
    ]);
    assert.equal(assetSourceMeasurement.code, 0, assetSourceMeasurement.stderr);
    const assetCloneMeasurement = await runCli(parityRoot, [
      'measure', '--target', 'clone', '--url', clone.url, '--routes', '/assets', '--inventory', '--assets',
      ...commonArgs(parityRoot, policyPath),
    ]);
    assert.equal(assetCloneMeasurement.code, 0, assetCloneMeasurement.stderr);
    assert.equal(assetSourceMeasurement.json.coverage.measurement.assetCoverageComplete, true);
    assert.equal(assetCloneMeasurement.json.coverage.measurement.assetCoverageComplete, true);
    const assetIndex = JSON.parse(readArtifact(parityRoot, SITE, assetCloneMeasurement.json.runId, 'measurements/assets.json').toString('utf8'));
    const assetRoute = assetIndex.routes.find((entry) => entry.route === '/assets');
    const assetObservation = JSON.parse(readArtifact(parityRoot, SITE, assetCloneMeasurement.json.runId, assetRoute.artifactPath).toString('utf8'));
    const repeatedImageReferences = assetObservation.references.filter((reference) => reference.attribute === 'src' && reference.url.endsWith('/fixture.svg'));
    assert.equal(repeatedImageReferences.length, 2, 'repeated images must retain separate DOM associations');
    assert.notEqual(repeatedImageReferences[0].locator, repeatedImageReferences[1].locator, 'repeated image locators must remain unique');
    const assetDiff = await runCli(parityRoot, [
      'diff', '--source', assetSourceMeasurement.json.runId, '--clone', assetCloneMeasurement.json.runId,
      ...commonArgs(parityRoot, policyPath),
    ]);
    assert.equal(assetDiff.code, 0, assetDiff.stderr);
    assert.equal(assetDiff.json.assetCoverage.complete, true);
    assert.deepEqual(assetDiff.json.findings, [], 'matching asset fixture should produce no asset findings');
    const rights = await runCli(parityRoot, ['rights', '--run', assetSourceMeasurement.json.runId, ...commonArgs(parityRoot, policyPath)]);
    assert.equal(rights.code, 0, rights.stderr);
    assert.ok((rights.json.summary['source-owned'] ?? 0) >= 1, 'same-origin fixture assets must be classified as source-owned');

    const sitemapMeasurement = await runCli(parityRoot, ['measure', '--target', 'clone', '--url', clone.url, '--sitemap', '--head', ...commonArgs(parityRoot, policyPath)]);
    assert.equal(sitemapMeasurement.code, 0, sitemapMeasurement.stderr);
    assert.equal(sitemapMeasurement.json.routeSource.kind, 'sitemap');
    assert.equal(sitemapMeasurement.json.coverage.measurement.routesCompleted, 2, 'off-origin sitemap entries must be ignored');

    const partial = await runCli(parityRoot, [
      'measure', '--target', 'clone', '--url', clone.url, '--routes', '/home,/missing',
      ...commonArgs(parityRoot, policyPath),
    ]);
    assert.notEqual(partial.code, 0, 'partial run must fail on missing route');
    const partialRun = /failed run: (\d{8}T\d{6}Z_clone_[a-f0-9]{8})/u.exec(partial.stderr)?.[1];
    assert.match(partialRun ?? '', /^\d{8}T\d{6}Z_clone_[a-f0-9]{8}$/);
    const resumed = await runCli(parityRoot, [
      'measure', '--target', 'clone', '--url', clone.url, '--routes', '/home', '--resume-run', partialRun,
      ...commonArgs(parityRoot, policyPath),
    ]);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.deepEqual(resumed.json.coverage.resume.routesReused, ['/home']);

    const partialSource = await runCli(parityRoot, [
      'measure', '--target', 'source', '--url', source.url, '--routes', '/home,/missing', '--profile', profile, '--profile-id', 'fixture',
      ...commonArgs(parityRoot, policyPath),
    ]);
    assert.notEqual(partialSource.code, 0, 'partial source run must fail on missing route');
    const partialSourceRun = /failed run: (\d{8}T\d{6}Z_source_[a-f0-9]{8})/u.exec(partialSource.stderr)?.[1];
    const resumedSource = await runCli(parityRoot, [
      'measure', '--target', 'source', '--url', source.url, '--routes', '/home', '--profile', profile, '--profile-id', 'fixture', '--resume-run', partialSourceRun,
      ...commonArgs(parityRoot, policyPath),
    ]);
    assert.equal(resumedSource.code, 0, resumedSource.stderr);
    assert.deepEqual(resumedSource.json.coverage.resume.routesReused, ['/home'], 'an unchanged source deployment must allow reuse');

    const unchangedDrift = await runCli(parityRoot, ['drift', '--run', sourceRun, '--profile', profile, ...commonArgs(parityRoot, policyPath)]);
    assert.equal(unchangedDrift.code, 0, unchangedDrift.stderr);
    assert.deepEqual(unchangedDrift.json.unchangedRoutes, ROUTES);
    const sourcePort = source.port;
    await source.close();
    source = await startFixtureServer({ mode: 'source', port: sourcePort, deployVersion: 'b2' });
    const changedDrift = await runCli(parityRoot, ['drift', '--run', sourceRun, '--profile', profile, ...commonArgs(parityRoot, policyPath)]);
    assert.equal(changedDrift.code, 0, changedDrift.stderr);
    assert.deepEqual(changedDrift.json.changedRoutes, ROUTES);
    assert.equal(changedDrift.json.next.routes, ROUTES.join(','));

    const codeRoot = join(parityRoot, 'code');
    mkdirSync(join(codeRoot, 'src'), { recursive: true });
    writeFileSync(join(codeRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: 'esnext', moduleResolution: 'bundler', target: 'es2020', types: [] }, include: ['src/**/*.ts'] }));
    writeFileSync(join(codeRoot, 'src', 'hooks.ts'), 'export function useState<T>(value: T): [T, (next: T) => void] { return [value, () => {}]; }\n');
    const panel = (read) => `import { useState } from './hooks';\nexport function Panel() {\n  const [open, setOpen] = useState(false);\n  setOpen(true);\n  return ${read ? 'open' : 'null'};\n}\n`;
    writeFileSync(join(codeRoot, 'src', 'panel.ts'), panel(false));
    const codeArgs = ['--root', codeRoot, '--site', SITE];
    const codeAudit = await runCli(codeRoot, ['audit', 'clone-code', ...codeArgs]);
    assert.equal(codeAudit.code, 0, codeAudit.stderr);
    assert.deepEqual(codeAudit.json.audit.findings.map((finding) => finding.category), ['state-never-read']);
    writeFileSync(join(codeRoot, 'src', 'panel.ts'), panel(true));
    const repairedCodeAudit = await runCli(codeRoot, ['audit', 'clone-code', ...codeArgs]);
    assert.equal(repairedCodeAudit.code, 0, repairedCodeAudit.stderr);
    assert.deepEqual(repairedCodeAudit.json.audit.findings, []);
    const codeFindings = await runCli(codeRoot, ['findings', ...codeArgs]);
    assert.equal(codeFindings.code, 0, codeFindings.stderr);
    assert.ok(codeFindings.json.findings.length === 1 && codeFindings.json.findings[0].status === 'closed', 'a clean re-audit must close the clone-code finding');

    const findings = await runCli(parityRoot, ['findings', ...commonArgs(parityRoot, policyPath)]);
    assert.equal(findings.code, 0, findings.stderr);
    assert.ok(findings.json.findings.length > 0, 'initial diff must have appended findings');
    const closedParityFindings = findings.json.findings.filter((finding) => initialFindingIds.has(finding.findingId));
    assert.equal(closedParityFindings.length, initialFindingIds.size, 'every initial diff finding must remain in the ledger');
    assert.ok(closedParityFindings.every((finding) => finding.status === 'closed'), 'repaired diff must close every initial diff finding');
    const latestCloneAuditRuns = new Set([repairedAudit.runId, repairedClasses.json.runId]);
    const staleCloneHealth = findings.json.findings.filter((finding) => (
      finding.status !== 'closed'
      && finding.finding?.domain === 'clone-health'
      && !latestCloneAuditRuns.has(finding.events.at(-1)?.runId)
    ));
    assert.deepEqual(staleCloneHealth, [], 'repaired clone audits must leave no stale open clone-health findings');
    console.log(JSON.stringify({
      status: 'ok',
      site: SITE,
      sourceRun,
      cloneRun,
      repairedCloneRun: repairedMeasurement.runId,
      initialFindingCount: initialDiff.json.findings.length,
      closedFindingCount: closedParityFindings.length,
      openCloneHealthCount: findings.json.findings.filter((finding) => finding.status !== 'closed' && finding.finding?.domain === 'clone-health').length,
    }, null, 2));
  } finally {
    await clone?.close().catch(() => {});
    await source?.close().catch(() => {});
    rmSync(parityRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(`cloner integration: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
}
