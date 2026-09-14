import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redactForPersistence } from './redact.mjs';
import { canonicalJson, CONCRETE_RUN_ID, parityRoot, sha256 } from './run-store.mjs';

function assertEvidenceRunId(value) {
  if (value !== null && value !== undefined && !CONCRETE_RUN_ID.test(value)) {
    throw new Error(`Ledger evidence must cite a concrete run ID: ${value}`);
  }
}

export function ledgerPath(root = process.cwd(), siteKey) {
  return join(parityRoot(root, siteKey), 'ledger.jsonl');
}

const RUN_ID_KEY = /runid/iu;
const NON_CLOSING_CONTROL_CATEGORIES = new Set([
  'dead',
  'blocked-by-policy',
  'trial-invalid',
  'disabled',
  'unreachable',
  'already-active',
]);

function withoutRunIds(value) {
  if (Array.isArray(value)) return value.map(withoutRunIds);
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' && CONCRETE_RUN_ID.test(value) ? null : value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => !RUN_ID_KEY.test(key) && !(typeof entry === 'string' && CONCRETE_RUN_ID.test(entry)))
      .map(([key, entry]) => [key, withoutRunIds(entry)]),
  );
}

function stableTargetContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value ?? null;
  return withoutRunIds({
    kind: value.kind ?? value.targetKind ?? null,
    tenant: value.tenant ?? null,
    role: value.role ?? null,
    profileId: value.profileId ?? null,
  });
}

function logicalSubject(finding, subject) {
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) return withoutRunIds(subject);
  if (finding?.category === 'dead-control') {
    return withoutRunIds(Object.fromEntries(
      ['route', 'role', 'name', 'controlClass', 'occurrence']
        .filter((key) => subject[key] !== undefined)
        .map((key) => [key, subject[key]]),
    ));
  }
  if (finding?.category === 'new-dead-runtime-class') {
    return withoutRunIds(Object.fromEntries(
      ['route', 'className'].filter((key) => subject[key] !== undefined).map((key) => [key, subject[key]]),
    ));
  }
  return withoutRunIds(subject);
}

export function stableFindingId(finding) {
  const fallbackSubject = Object.fromEntries(
    ['route', 'role', 'name', 'className', 'controlClass', 'occurrence']
      .filter((key) => finding?.[key] !== undefined)
      .map((key) => [key, finding[key]]),
  );
  const subject = finding?.subject ?? (Object.keys(fallbackSubject).length ? fallbackSubject : null);
  const cloneHealth = finding?.domain === 'clone-health';
  const audit = cloneHealth
    ? {
        name: finding.audit?.name ?? finding.auditName ?? null,
        evidenceClass: finding.audit?.evidenceClass ?? finding.evidenceClass ?? null,
        domain: finding.audit?.domain ?? null,
      }
    : null;
  const identity = cloneHealth
    ? {
        domain: finding.domain,
        site: finding.siteKey ?? finding.site ?? finding.audit?.siteKey ?? null,
        target: typeof finding.target === 'object' ? stableTargetContext(finding.target) : finding.target ?? null,
        targetContext: stableTargetContext(finding.targetContext ?? finding.audit?.targetContext),
        audit,
        category: finding.category ?? null,
        subject: logicalSubject(finding, subject),
      }
    : {
        domain: finding?.domain ?? null,
        target: finding?.target ?? null,
        category: finding?.category ?? null,
        subject: withoutRunIds(subject),
        policy: withoutRunIds(finding?.policy ?? null),
        comparison: withoutRunIds(finding?.comparison ?? null),
      };
  return `F-${sha256(canonicalJson(identity)).slice(0, 12)}`;
}

function sameControlSubject(left = {}, right = {}) {
  return ['route', 'role', 'name', 'controlClass', 'occurrence']
    .every((key) => (left[key] ?? null) === (right[key] ?? null));
}

function currentAuditStillFinds(previousFinding, current) {
  return (current.findings ?? []).some((finding) => {
    if ((finding.category ?? null) !== (previousFinding.category ?? null)) return false;
    if (current.evidenceClass === 'dead-control') return sameControlSubject(previousFinding.subject ?? previousFinding, finding.subject ?? finding);
    return JSON.stringify(previousFinding.subject ?? null) === JSON.stringify(finding.subject ?? null);
  });
}

function routeAuditIsComplete(current, subject, routeAudit) {
  if (!(current.coveredRoutes ?? []).includes(subject.route)) return false;
  if ((current.routesFailed ?? []).includes(subject.route)) return false;
  if ((current.failedRoutes ?? []).includes(subject.route)) return false;
  if (!routeAudit) return false;
  if (typeof routeAudit.classifiedCount !== 'number' || typeof routeAudit.controlCount !== 'number'
    || routeAudit.classifiedCount !== routeAudit.controlCount) return false;
  if ((routeAudit.trialInvalidCount ?? 0) > 0) return false;
  if ((routeAudit.observations ?? []).some((observation) => observation.category === 'trial-invalid')) return false;
  return true;
}

function auditSubjectCovered(previousFinding, current) {
  const subject = previousFinding.subject ?? previousFinding;
  if (!subject.route || !(current.coveredRoutes ?? []).includes(subject.route)) return false;
  if (current.evidenceClass === 'dead-control') {
    const routeAudit = (current.routes ?? []).find((entry) => entry.route === subject.route);
    if (!routeAuditIsComplete(current, subject, routeAudit)) return false;
    const observation = (routeAudit.observations ?? []).find((entry) => sameControlSubject(subject, entry));
    if (!observation) return true;
    return observation.actionExecuted === true
      && typeof observation.category === 'string'
      && !NON_CLOSING_CONTROL_CATEGORIES.has(observation.category);
  }
  if (current.evidenceClass === 'dead-runtime-class') {
    const routeAudit = (current.routes ?? []).find((entry) => entry.route === subject.route);
    return Boolean(routeAudit?.cssCoverageComplete);
  }
  return false;
}

export function auditFindingCanClose(previousSummary, current = {}) {
  const finding = previousSummary?.finding;
  if (!finding || finding.domain !== 'clone-health') return false;
  if (finding.target !== current.target) return false;
  if (finding.audit?.name !== current.auditName) return false;
  if (finding.audit?.evidenceClass !== current.evidenceClass) return false;
  if (finding.siteKey && current.siteKey && finding.siteKey !== current.siteKey) return false;
  const previousTargetContext = finding.targetContext ?? finding.audit?.targetContext;
  const currentTargetContext = current.targetContext ?? current.audit?.targetContext;
  if (previousTargetContext && currentTargetContext
    && canonicalJson(stableTargetContext(previousTargetContext)) !== canonicalJson(stableTargetContext(currentTargetContext))) return false;
  if (currentAuditStillFinds(finding, current)) return false;
  return auditSubjectCovered(finding, current);
}

export function appendLedgerEvent(root = process.cwd(), siteKey, event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Ledger event must be an object');
  if (!['finding.opened', 'finding.verified', 'finding.closed'].includes(event.type)) throw new Error(`Unsupported ledger event: ${event.type}`);
  if (!event.findingId || typeof event.findingId !== 'string') throw new Error('Ledger events require a stable findingId');
  assertEvidenceRunId(event.runId);
  assertEvidenceRunId(event.sourceRunId);
  assertEvidenceRunId(event.cloneRunId);
  for (const evidence of [event.finding?.evidence?.source, event.finding?.evidence?.clone, event.evidence]) {
    if (evidence) assertEvidenceRunId(evidence.runId);
  }
  const output = redactForPersistence({ ...event, recordedAt: event.recordedAt ?? new Date().toISOString() });
  const path = ledgerPath(root, siteKey);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(output)}\n`, { mode: 0o600 });
  return output;
}

export function readLedger(root = process.cwd(), siteKey) {
  const path = ledgerPath(root, siteKey);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Invalid ledger JSON on line ${index + 1}`);
    }
  });
}

export function recordReportFindings(root, siteKey, events) {
  return events.map((event) => appendLedgerEvent(root, siteKey, event));
}

export function recordFindingStatus(root, siteKey, findingId, status, runId) {
  if (!['verified', 'closed'].includes(status)) throw new Error(`Unsupported finding status: ${status}`);
  return appendLedgerEvent(root, siteKey, { type: `finding.${status}`, findingId, runId });
}

export function summarizeFindings(events) {
  const findings = new Map();
  for (const event of events) {
    const previous = findings.get(event.findingId) ?? {
      findingId: event.findingId,
      status: 'open',
      firstSeenRun: null,
      lastVerifiedRun: null,
      events: [],
    };
    previous.events.push(event);
    if (event.type === 'finding.opened') {
      previous.status = 'open';
      previous.firstSeenRun ??= event.runId ?? event.cloneRunId ?? null;
      previous.finding = event.finding;
      previous.sourceRunId = event.sourceRunId ?? previous.sourceRunId ?? null;
      previous.cloneRunId = event.cloneRunId ?? previous.cloneRunId ?? null;
    } else if (event.type === 'finding.verified') {
      previous.status = 'verified';
      previous.lastVerifiedRun = event.runId ?? event.cloneRunId ?? null;
      if (event.finding) previous.finding = event.finding;
      previous.sourceRunId = event.sourceRunId ?? previous.sourceRunId ?? null;
      previous.cloneRunId = event.cloneRunId ?? previous.cloneRunId ?? null;
    } else if (event.type === 'finding.closed') {
      previous.status = 'closed';
      previous.lastVerifiedRun = event.runId ?? event.cloneRunId ?? previous.lastVerifiedRun;
    }
    findings.set(event.findingId, previous);
  }
  return [...findings.values()];
}
