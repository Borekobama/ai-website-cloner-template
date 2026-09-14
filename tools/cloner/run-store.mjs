import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redactForPersistence } from './redact.mjs';

export const RUN_SCHEMA_VERSION = 1;
export const ENGINE_VERSION = '0.8.0';

const CONCRETE_RUN_ID = /^[0-9]{8}T[0-9]{6}Z_[a-z0-9-]+_[a-f0-9]{8}$/;
const REF_NAME = /^(source|clone)-current$/;

function assertSiteKey(siteKey) {
  if (!siteKey || !/^[a-z0-9][a-z0-9._-]*$/i.test(siteKey) || siteKey.includes('..')) {
    throw new Error(`Invalid site key: ${siteKey ?? '(missing)'}`);
  }
}

function assertRunId(runId) {
  if (typeof runId !== 'string' || !CONCRETE_RUN_ID.test(runId)) {
    throw new Error(`Expected a concrete run ID, received: ${runId}`);
  }
}

function assertRelativeArtifactPath(artifactPath) {
  if (
    typeof artifactPath !== 'string' ||
    !artifactPath ||
    isAbsolute(artifactPath) ||
    artifactPath.split(/[\\/]/u).some((part) => part === '..' || part === '') ||
    artifactPath === 'manifest.json'
  ) {
    throw new Error(`Invalid artifact path: ${artifactPath}`);
  }
}

export function parityRoot(root = process.cwd(), siteKey) {
  assertSiteKey(siteKey);
  return resolve(root, 'docs', 'research', siteKey, '_parity');
}

export function runDirectory(root = process.cwd(), siteKey, runId) {
  assertRunId(runId);
  return join(parityRoot(root, siteKey), 'runs', runId);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return createHash('sha256').update(input).digest('hex');
}

export function hashJson(value) {
  return sha256(canonicalJson(value));
}

function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function untrackedContentDigest(root, status) {
  const paths = git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean);
  const entries = paths.map((path) => {
    try {
      return `${path}\0${sha256(readFileSync(resolve(root, path)))}`;
    } catch {
      return `${path}\0[unreadable]`;
    }
  });
  return `${status}\n${entries.join('\n')}`;
}

export function repositoryIdentity(root = process.cwd()) {
  const commit = git(root, ['rev-parse', 'HEAD']) || null;
  const diff = git(root, ['diff', '--binary', 'HEAD', '--']) || '';
  const untracked = git(root, ['status', '--porcelain=v1', '--untracked-files=all']) || '';
  const dirty = Boolean(diff || untracked);
  return {
    commit,
    dirty,
    diffSha256: dirty ? sha256(`${diff}\n${untrackedContentDigest(root, untracked)}`) : null,
  };
}

function nowIso() {
  return new Date().toISOString();
}

export function createRunId(kind = 'measure') {
  const stamp = nowIso().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  const slug = String(kind).toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-|-$/gu, '') || 'run';
  return `${stamp}_${slug}_${randomBytes(4).toString('hex')}`;
}

function writeManifest(directory, manifest) {
  const manifestPath = join(directory, 'manifest.json');
  const temporaryPath = join(directory, `.manifest.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, manifestPath);
}

export function createRun({
  root = process.cwd(),
  siteKey,
  runId = createRunId('measure'),
  target = {},
  scope = {},
  runtime = {},
  policySha256 = null,
  kind = 'measure',
  engineVersion = ENGINE_VERSION,
} = {}) {
  assertSiteKey(siteKey);
  assertRunId(runId);
  if (scope.inventoryRunId !== undefined && scope.inventoryRunId !== null) {
    assertRunId(scope.inventoryRunId);
  }
  if (scope.parentRunId !== undefined && scope.parentRunId !== null) {
    assertRunId(scope.parentRunId);
  }
  const directory = runDirectory(root, siteKey, runId);
  if (existsSync(directory)) throw new Error(`Run already exists: ${runId}`);
  mkdirSync(join(directory, 'measurements'), { recursive: true, mode: 0o700 });
  const createdAt = nowIso();
  const manifest = redactForPersistence({
    schemaVersion: RUN_SCHEMA_VERSION,
    runId,
    status: 'open',
    createdAt,
    engine: { version: engineVersion },
    kind,
    target,
    repository: repositoryIdentity(root),
    scope,
    runtime,
    policySha256,
    artifacts: [],
  });
  writeManifest(directory, manifest);
  return manifest;
}

export function readManifest(root = process.cwd(), siteKey, runId) {
  const path = join(runDirectory(root, siteKey, runId), 'manifest.json');
  if (!existsSync(path)) throw new Error(`Run manifest not found: ${runId}`);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.runId !== runId || manifest.schemaVersion !== RUN_SCHEMA_VERSION) {
    throw new Error(`Invalid run manifest: ${runId}`);
  }
  return manifest;
}

function assertOpen(manifest) {
  if (manifest.status !== 'open') {
    throw new Error(`Run ${manifest.runId} is ${manifest.status}; historical runs are immutable`);
  }
}

export function updateRun(root = process.cwd(), siteKey, runId, patch = {}) {
  const manifest = readManifest(root, siteKey, runId);
  assertOpen(manifest);
  const updated = redactForPersistence({ ...manifest, ...patch, runId: manifest.runId, status: manifest.status, artifacts: manifest.artifacts });
  writeManifest(runDirectory(root, siteKey, runId), updated);
  return updated;
}

function artifactRecord(manifest, artifactPath, bytes) {
  return {
    kind: artifactPath.endsWith('.json') ? 'json' : artifactPath.endsWith('.png') ? 'image/png' : 'text',
    path: artifactPath,
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
  };
}

export function writeArtifact(root = process.cwd(), siteKey, runId, artifactPath, value, options = {}) {
  assertRelativeArtifactPath(artifactPath);
  const manifest = readManifest(root, siteKey, runId);
  assertOpen(manifest);
  if (manifest.artifacts.some((artifact) => artifact.path === artifactPath)) {
    throw new Error(`Open-run artifacts are append-only; artifact already exists: ${artifactPath}`);
  }
  const directory = runDirectory(root, siteKey, runId);
  const targetPath = resolve(directory, artifactPath);
  const rel = relative(directory, targetPath);
  if (rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Artifact escapes run directory: ${artifactPath}`);
  if (existsSync(targetPath)) {
    throw new Error(`Open-run artifacts are append-only; artifact already exists on disk: ${artifactPath}`);
  }
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === 'string'
      ? redactForPersistence(value)
      : `${JSON.stringify(redactForPersistence(value), null, 2)}\n`, 'utf8');
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  writeFileSync(targetPath, bytes, { mode: 0o600 });
  manifest.artifacts.push({
    ...artifactRecord(manifest, artifactPath, bytes),
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.visibility ? { visibility: options.visibility } : {}),
  });
  writeManifest(directory, manifest);
  return manifest.artifacts.at(-1);
}

export function readArtifact(root = process.cwd(), siteKey, runId, artifactPath) {
  assertRelativeArtifactPath(artifactPath);
  const manifest = readManifest(root, siteKey, runId);
  const record = manifest.artifacts.find((artifact) => artifact.path === artifactPath);
  if (!record) throw new Error(`Artifact is not listed in manifest: ${artifactPath}`);
  const bytes = readFileSync(join(runDirectory(root, siteKey, runId), artifactPath));
  if (sha256(bytes) !== record.sha256) throw new Error(`Artifact hash mismatch: ${artifactPath}`);
  return bytes;
}

function coverageInventoryId(manifest, coverage) {
  const manifestInventoryId = manifest.scope?.inventoryRunId;
  const coverageInventoryId = coverage?.inventory?.runId;
  if (manifestInventoryId && coverageInventoryId && manifestInventoryId !== coverageInventoryId) return null;
  return coverageInventoryId ?? manifestInventoryId ?? null;
}

function authoritativeInventoryIsValid(root, siteKey, manifest, coverage) {
  const inventoryId = coverageInventoryId(manifest, coverage);
  if (typeof inventoryId !== 'string' || !CONCRETE_RUN_ID.test(inventoryId)) return false;
  if (inventoryId === manifest.runId) {
    if (manifest.scope?.authoritativeInventory !== true || coverage?.inventory?.authoritative !== true || coverage?.scope !== 'full') return false;
    const inventoryRecord = manifest.artifacts.find((artifact) => artifact.path === 'inventory.json');
    if (!inventoryRecord) return false;
    try {
      const inventory = JSON.parse(readArtifact(root, siteKey, manifest.runId, 'inventory.json').toString('utf8'));
      return inventory.runId === manifest.runId && Array.isArray(inventory.routes);
    } catch {
      return false;
    }
  }
  try {
    const inventoryManifest = readManifest(root, siteKey, inventoryId);
    if (inventoryManifest.status !== 'closed') return false;
    if (inventoryManifest.scope?.authoritativeInventory !== true || inventoryManifest.scope?.inventoryRunId !== inventoryId) return false;
    const inventory = JSON.parse(readArtifact(root, siteKey, inventoryId, 'inventory.json').toString('utf8'));
    return inventory.runId === inventoryId && Array.isArray(inventory.routes) && coverage?.inventory?.authoritative === true;
  } catch {
    return false;
  }
}

function measurementCoverageIsValid(root, siteKey, manifest, coverage) {
  if (!['source', 'clone'].includes(manifest.kind)) return true;
  if (coverage?.scope === 'ad-hoc') {
    return manifest.scope?.inventoryRunId == null
      && manifest.scope?.authoritativeInventory !== true
      && coverage?.inventory?.runId == null
      && coverage?.inventory?.authoritative === false;
  }
  return authoritativeInventoryIsValid(root, siteKey, manifest, coverage);
}

export function closeRun(root = process.cwd(), siteKey, runId, { runtime = {}, closedAt = nowIso() } = {}) {
  const manifest = readManifest(root, siteKey, runId);
  assertOpen(manifest);
  const coverageArtifact = manifest.artifacts.find((artifact) => artifact.path === 'coverage.json');
  if (!coverageArtifact) {
    throw new Error('Cannot close run without coverage.json');
  }
  const coverage = JSON.parse(readArtifact(root, siteKey, runId, 'coverage.json').toString('utf8'));
  if (!measurementCoverageIsValid(root, siteKey, manifest, coverage)) {
    throw new Error('Measurement coverage has invalid inventory provenance');
  }
  manifest.status = 'closed';
  manifest.closedAt = closedAt;
  manifest.runtime = redactForPersistence({ ...manifest.runtime, ...runtime });
  writeManifest(runDirectory(root, siteKey, runId), manifest);
  return manifest;
}

export function failRun(root = process.cwd(), siteKey, runId, error, { failedAt = nowIso() } = {}) {
  const manifest = readManifest(root, siteKey, runId);
  assertOpen(manifest);
  const failure = redactForPersistence({
    message: error instanceof Error ? error.message : String(error),
    failedAt,
  });
  writeArtifact(root, siteKey, runId, 'failure.json', failure, { kind: 'failure' });
  const failedManifest = readManifest(root, siteKey, runId);
  failedManifest.status = 'failed';
  failedManifest.failedAt = failedAt;
  writeManifest(runDirectory(root, siteKey, runId), failedManifest);
  return failedManifest;
}

export function setRef(root = process.cwd(), siteKey, refName, runId) {
  assertSiteKey(siteKey);
  if (!REF_NAME.test(refName)) throw new Error(`Invalid ref name: ${refName}`);
  assertRunId(runId);
  const manifest = readManifest(root, siteKey, runId);
  if (manifest.status !== 'closed') throw new Error('Only closed runs may be promoted to a ref');
  const targetKind = refName.slice(0, -'-current'.length);
  if (manifest.target?.kind && manifest.target.kind !== targetKind) {
    throw new Error(`Run ${runId} is a ${manifest.target.kind} run and cannot become ${refName}`);
  }
  if (manifest.scope?.authoritativeInventory !== true || manifest.scope?.inventoryRunId !== runId) {
    throw new Error(`Run ${runId} is not an explicit authoritative inventory and cannot become ${refName}`);
  }
  const coverage = JSON.parse(readArtifact(root, siteKey, runId, 'coverage.json').toString('utf8'));
  if (!authoritativeInventoryIsValid(root, siteKey, manifest, coverage)) {
    throw new Error(`Run ${runId} does not have authoritative full-inventory coverage`);
  }
  const refPath = join(parityRoot(root, siteKey), 'refs', refName);
  if (existsSync(refPath)) {
    const previousRunId = readFileSync(refPath, 'utf8').trim();
    if (previousRunId && CONCRETE_RUN_ID.test(previousRunId)) {
      const previousManifest = readManifest(root, siteKey, previousRunId);
      const previousIsBroad = !previousManifest.scope?.inventoryRunId || previousManifest.scope.inventoryRunId === previousManifest.runId;
      const nextIsSubset = Boolean(manifest.scope?.inventoryRunId && manifest.scope.inventoryRunId !== manifest.runId);
      if (previousIsBroad && nextIsSubset) {
        throw new Error(`Subset run ${runId} cannot replace broader ref ${previousRunId}`);
      }
    }
  }
  mkdirSync(dirname(refPath), { recursive: true, mode: 0o700 });
  writeFileSync(refPath, `${runId}\n`, { mode: 0o600 });
  return runId;
}

export function resolveRunId(root = process.cwd(), siteKey, reference, targetKind) {
  if (reference === 'current') {
    if (targetKind !== 'source' && targetKind !== 'clone') throw new Error('current requires --kind source or --kind clone');
    const refPath = join(parityRoot(root, siteKey), 'refs', `${targetKind}-current`);
    if (!existsSync(refPath)) throw new Error(`No ${targetKind}-current ref exists`);
    reference = readFileSync(refPath, 'utf8').trim();
  }
  if (reference === 'latest' || reference?.startsWith('refs/')) {
    throw new Error('mutable evidence aliases are not accepted; use a concrete run ID or resolve current first');
  }
  assertRunId(reference);
  const manifest = readManifest(root, siteKey, reference);
  if (targetKind && manifest.target?.kind && manifest.target.kind !== targetKind) {
    throw new Error(`Run ${reference} is a ${manifest.target.kind} run, not a ${targetKind} run`);
  }
  return reference;
}

export function listRuns(root = process.cwd(), siteKey) {
  const runsPath = join(parityRoot(root, siteKey), 'runs');
  if (!existsSync(runsPath)) return [];
  return readdirSync(runsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && CONCRETE_RUN_ID.test(entry.name))
    .map((entry) => readManifest(root, siteKey, entry.name))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function freezeFixture(root = process.cwd(), siteKey, runId, name, { publicFixture = false } = {}) {
  assertRunId(runId);
  if (!name || !/^[a-z0-9][a-z0-9._-]*$/i.test(name) || name.includes('..')) throw new Error(`Invalid fixture name: ${name}`);
  const manifest = readManifest(root, siteKey, runId);
  if (!['closed', 'failed'].includes(manifest.status)) {
    throw new Error('Only closed or failed runs may be frozen as evidence');
  }
  const fixturePath = publicFixture
    ? resolve(root, 'tools', 'cloner', 'fixtures', name)
    : resolve(root, '.cloner-runtime', 'fixtures', name);
  if (existsSync(fixturePath)) throw new Error(`Fixture already exists: ${name}`);
  mkdirSync(dirname(fixturePath), { recursive: true, mode: 0o700 });
  cpSync(runDirectory(root, siteKey, runId), fixturePath, { recursive: true, errorOnExist: true });
  const fixtureManifest = {
    fixtureSchemaVersion: 1,
    fixtureName: name,
    sourceRunId: manifest.runId,
    frozenAt: nowIso(),
    taxonomy: 'golden evidence',
    visibility: publicFixture ? 'public' : 'private',
  };
  writeFileSync(join(fixturePath, 'fixture.json'), `${JSON.stringify(fixtureManifest, null, 2)}\n`, { mode: 0o600 });
  return fixtureManifest;
}

export { CONCRETE_RUN_ID };
