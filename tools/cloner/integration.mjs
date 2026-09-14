#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stableFindingId } from './ledger.mjs';
import { startFixtureServer } from './test-app/server.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CLI = join(ROOT, 'tools', 'cloner', 'cli.mjs');
const SITE = 'fixture.local-0.5';
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

    const sourceMeasurement = await measure(parityRoot, policyPath, 'source', source.url, ['--profile', profile, '--inventory', '--visual-regions', visualConfigPath]);
    const cloneMeasurement = await measure(parityRoot, policyPath, 'clone', clone.url, ['--inventory', '--visual-regions', visualConfigPath]);
    const sourceRun = sourceMeasurement.runId;
    const cloneRun = cloneMeasurement.runId;
    assert.match(sourceRun, /^\d{8}T\d{6}Z_source_[a-f0-9]{8}$/);
    assert.match(cloneRun, /^\d{8}T\d{6}Z_clone_[a-f0-9]{8}$/);

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
    const initialCategories = new Set(initialDiff.json.findings.map((finding) => finding.category));
    const initialFindingIds = new Set(initialDiff.json.findings.map((finding) => stableFindingId({
      ...finding,
      domain: 'parity',
      target: 'comparison',
      comparison: { sourceKind: 'source', cloneKind: 'clone' },
    })));
    for (const category of ['missing-control', 'control-aria-mismatch', 'control-overlay-mismatch', 'control-dom-mismatch', 'new-dead-runtime-class', 'visual-region-mismatch']) {
      assert.ok(initialCategories.has(category), `expected initial finding ${category}`);
    }

    const cloneObservations = cloneAudit.json.audits.flatMap((entry) => entry.observations);
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
    assert.equal(homeClasses.deadClasses.includes('readable-runtime'), false, 'readable runtime class must not be dead');
    assert.equal(cloneClasses.json.audit.routes.find((entry) => entry.route === '/incomplete-css').cssCoverageComplete, false);
    assert.equal(cloneClasses.json.audit.findings.some((finding) => finding.subject?.route === '/incomplete-css'), false, 'incomplete CSS must not create authoritative dead-class findings');
    const noiseRoute = cloneMeasurement.coverage.measurement.routesCompleted;
    assert.ok(noiseRoute === ROUTES.length, 'noisy timer route must complete measurement');

    await clone.close();
    clone = await startFixtureServer({ mode: 'clone', repaired: true });
    const repairedMeasurement = await measure(parityRoot, policyPath, 'clone', clone.url, ['--inventory-run', cloneRun, '--visual-regions', visualConfigPath]);
    const repairedAudit = await audit(parityRoot, policyPath, 'clone', repairedMeasurement.runId);
    const repairedClasses = await runCli(parityRoot, ['audit', 'dead-classes', '--target', 'clone', '--run', repairedMeasurement.runId, ...commonArgs(parityRoot, policyPath)]);
    assert.equal(repairedClasses.code, 0, repairedClasses.stderr);
    const repairedDiff = await runCli(parityRoot, [
      'diff', '--source', sourceRun, '--clone', repairedMeasurement.runId, '--source-audit', sourceAudit.runId, '--clone-audit', repairedAudit.runId,
      ...commonArgs(parityRoot, policyPath),
    ]);
    assert.equal(repairedDiff.code, 0, repairedDiff.stderr);
    assert.deepEqual(repairedDiff.json.findings, [], 'repaired clone should close all parity findings');

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
