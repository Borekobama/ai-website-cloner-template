import { CONCRETE_RUN_ID, canonicalJson, listRuns, readArtifact, readManifest } from './run-store.mjs';
import { comparatorForDimension, dimensionsForControl, policySha256 } from './policy.mjs';
import { stableFindingId } from './ledger.mjs';
import { compareMotionObservations } from './motion.mjs';
import { compareDomSnapshotStructure, domSnapshotCoverage } from './dom-snapshot.mjs';
import { compareVisualRegionImages, visualRoutePath } from './visual-regions.mjs';
import { compareResponsiveEvidence, hydrateResponsiveEvidence } from './responsive.mjs';
import { compareAssetEvidence, hydrateAssetEvidence } from './assets.mjs';

const SUPPORTED_KINDS = new Set(['route-inventory', 'route-observation', 'control-observation', 'runtime-class-observation', 'compiled-css-observation', 'request-observation', 'coverage', 'dead-class-audit', 'dead-control-route-audit', 'visual-region-config', 'visual-region-observation', 'visual-region-png', 'motion-observation', 'dom-snapshot-observation', 'responsive-observation', 'responsive-observation-index', 'asset-observation', 'asset-observation-index']);
const METADATA_KINDS = new Set(['policy-snapshot', 'failure', 'route-failure', 'report']);
const CONTROL_EFFECT_DIMENSIONS = new Set(['url', 'aria', 'overlay', 'dom', 'style', 'network']);
const FINDING_SEMANTICS = {
  parity: 'Parity findings identify source-vs-clone mismatches.',
  cloneHealth: 'Clone-health findings identify clone implementation-quality observations.',
  milestone: 'Clone-health findings do not automatically block a parity milestone when source and clone intentionally share a defect.',
};

function readJson(root, siteKey, runId, path) {
  const bytes = readArtifact(root, siteKey, runId, path);
  return JSON.parse(bytes.toString('utf8'));
}

function readOptionalJson(root, siteKey, manifest, path) {
  if (!manifest.artifacts.some((artifact) => artifact.path === path)) return null;
  return readJson(root, siteKey, manifest.runId, path);
}

function evidence(runId, artifact, locator) {
  return { runId, artifact, locator };
}

function routeMap(value) {
  return new Map((value?.routes ?? []).map((route) => [route.route, route]));
}

function normalizedDestination(value) {
  if (!value) return null;
  try {
    const url = new URL(value, 'http://cloner.invalid');
    return `${url.pathname}${url.search}`;
  } catch {
    return String(value);
  }
}

function controlKey(control) {
  return `${control.route ?? ''}|${control.role ?? ''}|${control.name ?? ''}|${control.controlClass ?? 'default'}`;
}

function indexedControls(value) {
  const occurrences = new Map();
  return (value?.observations ?? []).map((control, index) => {
    const baseKey = controlKey(control);
    const occurrence = occurrences.get(baseKey) ?? 0;
    occurrences.set(baseKey, occurrence + 1);
    return { control, index, baseKey, occurrence, key: `${baseKey}|#${occurrence}` };
  });
}

function controlSubjectKey(control) {
  return `${control.route ?? ''}|${control.role ?? ''}|${control.name ?? ''}|${control.controlClass ?? 'default'}|${control.occurrence ?? 0}`;
}

function auditObservationMap(bundle) {
  const bySubject = new Map();
  if (!bundle?.routes) return bySubject;
  for (const [routeIndex, routeAudit] of bundle.routes.entries()) {
    for (const [observationIndex, observation] of (routeAudit.observations ?? []).entries()) {
      bySubject.set(controlSubjectKey({ ...observation, route: observation.route ?? routeAudit.route }), {
        observation,
        evidence: evidence(bundle.runId, 'audits/dead-controls.json', `#/routes/${routeIndex}/observations/${observationIndex}`),
      });
    }
  }
  return bySubject;
}

function compatibleAuditEntry(control, entry) {
  if (!entry) return null;
  const observation = entry.observation ?? {};
  if (observation.href !== undefined && control.href !== undefined && observation.href !== control.href) return null;
  if (observation.structure !== undefined && control.structure !== undefined
    && canonicalJson(observation.structure) !== canonicalJson(control.structure)) return null;
  return entry;
}

function richerValues(control, actionObservation, useActionEvidence) {
  const after = useActionEvidence ? actionObservation?.evidence?.after : null;
  const controlAfter = useActionEvidence ? actionObservation?.evidence?.controlAfter : null;
  return {
    url: useActionEvidence && actionObservation?.actionExecuted ? normalizedDestination(after?.url) : normalizedDestination(control.href),
    aria: controlAfter?.ariaState ?? control.ariaState ?? control.state ?? null,
    structure: control.structure ?? { role: control.role, name: control.name },
    overlay: useActionEvidence ? { opened: Boolean(actionObservation?.effect?.overlayOpened), overlays: after?.overlays ?? [] } : null,
    dom: useActionEvidence ? { changed: Boolean(actionObservation?.effect?.domChanged), fingerprint: after?.domFingerprint ?? null } : null,
    style: controlAfter ? { visible: control.visible, className: controlAfter.className ?? null, dataState: controlAfter.dataState ?? null } : control.visible,
    network: useActionEvidence ? {
      count: after?.network?.count ?? 0,
      requests: (after?.network?.requests ?? []).map((request) => ({
        url: normalizedDestination(request.url),
        method: request.method ?? null,
        resourceType: request.resourceType ?? null,
      })),
    } : null,
  };
}

function comparator(instrument, evidenceClass, dimension = null, mode = null) {
  return { instrument, evidenceClass, ...(dimension ? { dimension } : {}), ...(mode ? { mode } : {}) };
}

function compareControls(source, clone, sourceRunId, cloneRunId, policy = {}, sourceAudit = null, cloneAudit = null) {
  const sourceControls = indexedControls(source);
  const cloneControls = indexedControls(clone);
  const sourceByKey = new Map(sourceControls.map((entry) => [entry.key, entry]));
  const cloneByKey = new Map(cloneControls.map((entry) => [entry.key, entry]));
  const sourceAuditByIndex = auditObservationMap(sourceAudit);
  const cloneAuditByIndex = auditObservationMap(cloneAudit);
  const findings = [];
  const comparatorCoverage = [];
  const compared = new Set();
  for (const sourceEntry of sourceControls) {
    const cloneEntry = cloneByKey.get(sourceEntry.key);
    const sourceControl = sourceEntry.control;
    const sourceLocator = `#/observations/${sourceEntry.index}`;
    const subject = { route: sourceControl.route, role: sourceControl.role, name: sourceControl.name, controlClass: sourceControl.controlClass ?? 'default', occurrence: sourceEntry.occurrence };
    const presenceComparator = comparator('static-control', 'control-presence', 'presence', 'gate');
    if (!cloneEntry) {
      comparatorCoverage.push({ comparator: presenceComparator, subject });
      findings.push({
        category: 'missing-control',
        subject,
        status: 'open',
        comparator: presenceComparator,
        evidence: { source: evidence(sourceRunId, 'measurements/controls.json', sourceLocator), clone: null },
      });
      continue;
    }
    const cloneControl = cloneEntry.control;
    compared.add(sourceEntry.key);
    const cloneLocator = `#/observations/${cloneEntry.index}`;
    comparatorCoverage.push({ comparator: presenceComparator, subject });
    const dimensions = dimensionsForControl(policy, sourceControl.controlClass ?? 'default');
    const sourceActionEntry = compatibleAuditEntry(sourceControl, sourceAuditByIndex.get(controlSubjectKey({ ...sourceControl, occurrence: sourceEntry.occurrence })));
    const cloneActionEntry = compatibleAuditEntry(cloneControl, cloneAuditByIndex.get(controlSubjectKey({ ...cloneControl, occurrence: cloneEntry.occurrence })));
    const sourceAction = sourceActionEntry?.observation ?? null;
    const cloneAction = cloneActionEntry?.observation ?? null;
    const useActionEvidence = Boolean(sourceAction?.actionExecuted && cloneAction?.actionExecuted);
    const sourceValues = richerValues(sourceControl, sourceAction, useActionEvidence);
    const cloneValues = richerValues(cloneControl, cloneAction, useActionEvidence);
    for (const [dimension, mode] of Object.entries(dimensions)) {
      const sourceValue = sourceValues[dimension] ?? null;
      const cloneValue = cloneValues[dimension] ?? null;
      const comparison = comparatorForDimension(mode, sourceValue, cloneValue);
      const actionDimension = CONTROL_EFFECT_DIMENSIONS.has(dimension) && useActionEvidence;
      const findingComparator = actionDimension
        ? comparator('dead-controls', 'control-effect', dimension, mode)
        : comparator('static-control', 'control-static', dimension, mode);
      comparatorCoverage.push({ comparator: findingComparator, subject });
      if (!comparison.equal && mode !== 'ignore') {
        const sourceActionEvidence = sourceActionEntry?.evidence;
        const cloneActionEvidence = cloneActionEntry?.evidence;
        findings.push({
          category: `control-${dimension}-mismatch`,
          subject,
          status: mode === 'gate' ? 'open' : 'informational',
          policy: { controlClass: sourceControl.controlClass ?? 'default', dimension, mode },
          comparator: findingComparator,
          observed: { source: sourceValue, clone: cloneValue },
          evidence: {
            source: actionDimension && sourceActionEvidence ? sourceActionEvidence : evidence(sourceRunId, 'measurements/controls.json', sourceLocator),
            clone: actionDimension && cloneActionEvidence ? cloneActionEvidence : evidence(cloneRunId, 'measurements/controls.json', cloneLocator),
          },
        });
      }
    }
  }
  for (const cloneEntry of cloneControls) {
    if (!compared.has(cloneEntry.key) && !sourceByKey.has(cloneEntry.key)) {
      const cloneControl = cloneEntry.control;
      const subject = { route: cloneControl.route, role: cloneControl.role, name: cloneControl.name, controlClass: cloneControl.controlClass ?? 'default', occurrence: cloneEntry.occurrence };
      const findingComparator = comparator('static-control', 'control-presence', 'presence', 'informational');
      comparatorCoverage.push({ comparator: findingComparator, subject });
      findings.push({
        category: 'extra-control',
        subject,
        status: 'informational',
        comparator: findingComparator,
        evidence: { source: null, clone: evidence(cloneRunId, 'measurements/controls.json', `#/observations/${cloneEntry.index}`) },
      });
    }
  }
  return { findings, comparatorCoverage };
}

function compareRoutes(source, clone, sourceRunId, cloneRunId) {
  const sourceRoutes = routeMap(source);
  const cloneRoutes = routeMap(clone);
  const findings = [];
  const comparatorCoverage = [];
  for (const route of new Set([...sourceRoutes.keys(), ...cloneRoutes.keys()])) {
    const left = sourceRoutes.get(route);
    const right = cloneRoutes.get(route);
    const subject = { route };
    const findingComparator = comparator('route-inventory', 'route-status', 'status', 'gate');
    comparatorCoverage.push({ comparator: findingComparator, subject });
    if (!left || !right) {
      findings.push({
        category: 'route-missing',
        subject,
        status: 'open',
        comparator: findingComparator,
        evidence: {
          source: left ? evidence(sourceRunId, 'measurements/routes.json', `#/routes/${source.routes.indexOf(left)}`) : null,
          clone: right ? evidence(cloneRunId, 'measurements/routes.json', `#/routes/${clone.routes.indexOf(right)}`) : null,
        },
      });
      continue;
    }
    if (left.status !== right.status) {
      findings.push({
        category: 'route-status-mismatch',
        subject,
        status: 'open',
        comparator: findingComparator,
        observed: { source: left.status, clone: right.status },
        evidence: {
          source: evidence(sourceRunId, 'measurements/routes.json', `#/routes/${source.routes.indexOf(left)}/status`),
          clone: evidence(cloneRunId, 'measurements/routes.json', `#/routes/${clone.routes.indexOf(right)}/status`),
        },
      });
    }
    const leftDestination = normalizedDestination(left.finalUrl);
    const rightDestination = normalizedDestination(right.finalUrl);
    const destinationComparator = comparator('route-inventory', 'route-destination', 'destination', 'gate');
    comparatorCoverage.push({ comparator: destinationComparator, subject });
    if (leftDestination !== rightDestination) {
      findings.push({
        category: 'route-destination-mismatch',
        subject,
        status: 'open',
        policy: { dimension: 'destination', mode: 'gate' },
        comparator: destinationComparator,
        observed: { source: leftDestination, clone: rightDestination },
        evidence: {
          source: evidence(sourceRunId, 'measurements/routes.json', `#/routes/${source.routes.indexOf(left)}/finalUrl`),
          clone: evidence(cloneRunId, 'measurements/routes.json', `#/routes/${clone.routes.indexOf(right)}/finalUrl`),
        },
      });
    }
  }
  return { findings, comparatorCoverage };
}

function compareClassAudits(source, clone, sourceRunId, cloneRunId) {
  const sourceRoutes = routeMap(source);
  const cloneRoutes = routeMap(clone);
  const findings = [];
  const comparatorCoverage = [];
  for (const [route, cloneValue] of cloneRoutes) {
    const sourceValue = sourceRoutes.get(route);
    if (!sourceValue) continue;
    if (sourceValue.cssCoverageComplete === false || cloneValue.cssCoverageComplete === false) continue;
    comparatorCoverage.push({ comparator: comparator('compiled-css', 'dead-runtime-class', 'class-presence', 'gate'), subject: { route } });
    const sourceClasses = new Set(sourceValue.deadClasses ?? []);
    for (const className of cloneValue.deadClasses ?? []) {
      if (!sourceClasses.has(className)) findings.push({
        category: 'new-dead-runtime-class',
        subject: { route, className },
        status: 'open',
        comparator: comparator('compiled-css', 'dead-runtime-class', 'class-presence', 'gate'),
        evidence: {
          source: evidence(sourceRunId, 'measurements/classes.json', `#/audit/routes/${source.routes.indexOf(sourceValue)}/deadClasses`),
          clone: evidence(cloneRunId, 'measurements/classes.json', `#/audit/routes/${clone.routes.indexOf(cloneValue)}/deadClasses/${cloneValue.deadClasses.indexOf(className)}`),
        },
      });
    }
  }
  return { findings, comparatorCoverage };
}

function visualRegionsBySubject(value) {
  const result = new Map();
  for (const route of value?.routes ?? []) {
    for (const region of route.regions ?? []) {
      result.set(`${route.route}|${region.id}`, { ...region, route: route.route });
    }
  }
  return result;
}

function visualSubject(region) {
  return { route: region.route, regionId: region.id, viewport: region.viewport };
}

function compareVisualRegions({ root, siteKey, source, clone, sourceRunId, cloneRunId, reportRunId = null }) {
  if (!source && !clone) return { findings: [], comparatorCoverage: [], visualArtifacts: [], coverage: { configured: false, complete: false, reason: 'visual-evidence-missing' } };
  const configMismatch = Boolean(source?.configSha256 && clone?.configSha256 && source.configSha256 !== clone.configSha256);
  const sourceRegions = visualRegionsBySubject(source);
  const cloneRegions = visualRegionsBySubject(clone);
  const sourceConfiguredRegions = new Map((source?.config?.regions ?? []).map((region) => [`${region.route}|${region.id}`, region]));
  const cloneConfiguredRegions = new Map((clone?.config?.regions ?? []).map((region) => [`${region.route}|${region.id}`, region]));
  const configuredRegions = new Map([...sourceConfiguredRegions, ...cloneConfiguredRegions]);
  const findings = [];
  const comparatorCoverage = [];
  const visualArtifacts = [];
  const subjects = new Set([...configuredRegions.keys(), ...sourceRegions.keys(), ...cloneRegions.keys()]);
  for (const key of subjects) {
    const sourceRegion = sourceRegions.get(key);
    const cloneRegion = cloneRegions.get(key);
    const sourceConfigured = sourceConfiguredRegions.get(key);
    const cloneConfigured = cloneConfiguredRegions.get(key);
    const region = sourceConfigured ?? cloneConfigured ?? sourceRegion ?? cloneRegion;
    const subject = visualSubject(region);
    const mode = sourceConfigured?.mode ?? sourceRegion?.mode ?? cloneConfigured?.mode ?? cloneRegion?.mode ?? region.mode ?? 'gate';
    const visualPolicy = {
      classification: sourceRegion?.classification ?? sourceConfigured?.classification ?? region.classification ?? 'invariant',
      mode,
      threshold: sourceRegion?.threshold ?? region.threshold ?? 0.001,
      pixelThreshold: sourceRegion?.pixelThreshold ?? region.pixelThreshold ?? 0.1,
      maxDiffPixels: sourceRegion?.maxDiffPixels ?? region.maxDiffPixels ?? null,
    };
    const comparator = { instrument: 'visual-region', evidenceClass: 'visual-region', dimension: 'pixels', mode, policy: visualPolicy };
    const complete = !configMismatch && Boolean(sourceRegion?.status === 'captured' && cloneRegion?.status === 'captured');
    const coverageEntry = { comparator, subject, complete };
    comparatorCoverage.push(coverageEntry);
    if (!complete) {
      if (mode !== 'ignore' || configMismatch) findings.push({
        category: 'visual-region-incomplete',
        subject,
        status: 'informational',
        comparator,
        policy: visualPolicy,
        observed: { source: sourceRegion?.status ?? 'missing', clone: cloneRegion?.status ?? 'missing', ...(configMismatch ? { reason: 'config-mismatch' } : {}) },
        evidence: {
          source: sourceRegion ? { runId: sourceRunId, artifact: 'measurements/visual-regions.json', locator: `#/routes/${source.routes.findIndex((entry) => entry.route === region.route)}/regions` } : null,
          clone: cloneRegion ? { runId: cloneRunId, artifact: 'measurements/visual-regions.json', locator: `#/routes/${clone.routes.findIndex((entry) => entry.route === region.route)}/regions` } : null,
        },
      });
      continue;
    }
    if (mode === 'ignore') continue;
    const sourceBytes = readArtifact(root, siteKey, sourceRunId, sourceRegion.artifactPath);
    const cloneBytes = readArtifact(root, siteKey, cloneRunId, cloneRegion.artifactPath);
    const comparison = compareVisualRegionImages(sourceBytes, cloneBytes, {
      threshold: sourceRegion.threshold,
      pixelThreshold: sourceRegion.pixelThreshold,
      maxDiffPixels: sourceRegion.maxDiffPixels ?? null,
    });
    coverageEntry.complete = comparison.complete;
    if (comparison.reason === 'dimension-mismatch') {
      findings.push({ category: 'visual-region-mismatch', subject, status: mode === 'gate' ? 'open' : 'informational', policy: visualPolicy, comparator, observed: comparison, evidence: { source: { runId: sourceRunId, artifact: sourceRegion.artifactPath, locator: '#' }, clone: { runId: cloneRunId, artifact: cloneRegion.artifactPath, locator: '#' } } });
      continue;
    }
    if (!comparison.equal) {
      const routeKey = region.route.replace(/[^a-z0-9]+/giu, '-').replace(/^-|-$/gu, '') || 'root';
      const diffPath = `visual-diffs/${routeKey}/${region.id}.diff.png`;
      visualArtifacts.push({ path: diffPath, image: comparison.diff, visibility: 'private' });
      findings.push({ category: 'visual-region-mismatch', subject, status: mode === 'gate' ? 'open' : 'informational', policy: visualPolicy, comparator, observed: { diffPixels: comparison.diffPixels, diffRatio: comparison.diffRatio, width: comparison.width, height: comparison.height }, evidence: { source: { runId: sourceRunId, artifact: sourceRegion.artifactPath, locator: '#' }, clone: { runId: cloneRunId, artifact: cloneRegion.artifactPath, locator: '#' }, diff: reportRunId ? { runId: reportRunId, artifact: diffPath, locator: '#' } : null } });
    }
  }
  return { findings, comparatorCoverage, visualArtifacts, coverage: { configured: true, complete: !configMismatch && comparatorCoverage.every((entry) => entry.complete || entry.comparator.mode === 'ignore'), ...(configMismatch ? { reason: 'config-mismatch' } : {}), regionsCompared: comparatorCoverage.filter((entry) => entry.complete).length, regionsConfigured: configuredRegions.size || comparatorCoverage.length } };
}

function unsupportedKinds(sourceManifest, cloneManifest) {
  const kinds = [...new Set([...sourceManifest.artifacts, ...cloneManifest.artifacts].map((artifact) => artifact.kind))];
  return kinds.filter((kind) => kind && !SUPPORTED_KINDS.has(kind) && !METADATA_KINDS.has(kind)).map((kind) => ({ kind, status: 'unsupported' }));
}

export function compareMeasurementData({ sourceRoutes, cloneRoutes, sourceControls, cloneControls, sourceClasses, cloneClasses, sourceVisual = null, cloneVisual = null, sourceMotion = null, cloneMotion = null, sourceDomSnapshot = null, cloneDomSnapshot = null, sourceResponsive = null, cloneResponsive = null, sourceAssets = null, cloneAssets = null, sourceRunId, cloneRunId, reportRunId = null, root = process.cwd(), siteKey, policy = {}, sourceControlAudit = null, cloneControlAudit = null }) {
  if (!CONCRETE_RUN_ID.test(sourceRunId) || !CONCRETE_RUN_ID.test(cloneRunId)) {
    throw new Error('Comparisons require concrete source and clone run IDs');
  }
  const routeComparison = compareRoutes(sourceRoutes, cloneRoutes, sourceRunId, cloneRunId);
  const controlComparison = compareControls(sourceControls, cloneControls, sourceRunId, cloneRunId, policy, sourceControlAudit, cloneControlAudit);
  const classComparison = compareClassAudits(sourceClasses, cloneClasses, sourceRunId, cloneRunId);
  const visualComparison = compareVisualRegions({ root, siteKey, source: sourceVisual, clone: cloneVisual, sourceRunId, cloneRunId, reportRunId });
  const motionComparison = compareMotionObservations(sourceMotion, cloneMotion, sourceRunId, cloneRunId);
  const responsiveComparison = compareResponsiveEvidence(sourceResponsive, cloneResponsive, sourceRunId, cloneRunId);
  const assetComparison = compareAssetEvidence(sourceAssets, cloneAssets, sourceRunId, cloneRunId);
  const comparisonRoutes = [...new Set([...(sourceRoutes?.routes ?? []), ...(cloneRoutes?.routes ?? [])].map((route) => route.route).filter(Boolean))];
  const sourceDomCoverage = domSnapshotCoverage(sourceDomSnapshot, comparisonRoutes);
  const cloneDomCoverage = domSnapshotCoverage(cloneDomSnapshot, comparisonRoutes);
  const domSnapshotComparison = {
    configured: Boolean(sourceDomSnapshot || cloneDomSnapshot),
    source: sourceDomCoverage,
    clone: cloneDomCoverage,
    expectedRoutes: comparisonRoutes,
    complete: Boolean(sourceDomCoverage.complete && cloneDomCoverage.complete && sourceDomCoverage.routesMatch && cloneDomCoverage.routesMatch),
  };
  const structureComparison = compareDomSnapshotStructure(sourceDomSnapshot, cloneDomSnapshot, sourceRunId, cloneRunId);
  domSnapshotComparison.structure = structureComparison.coverage;
  const findings = [...routeComparison.findings, ...controlComparison.findings, ...classComparison.findings, ...visualComparison.findings, ...motionComparison.findings, ...responsiveComparison.findings, ...assetComparison.findings, ...structureComparison.findings];
  return {
    schemaVersion: 1,
    semantics: FINDING_SEMANTICS,
    sourceRunId,
    cloneRunId,
    supportedKinds: [...SUPPORTED_KINDS],
    comparatorCoverage: [...routeComparison.comparatorCoverage, ...controlComparison.comparatorCoverage, ...classComparison.comparatorCoverage, ...visualComparison.comparatorCoverage, ...motionComparison.comparatorCoverage, ...responsiveComparison.comparatorCoverage, ...assetComparison.comparatorCoverage, ...structureComparison.comparatorCoverage],
    findings,
    visualCoverage: visualComparison.coverage,
    motionCoverage: motionComparison.coverage,
    domSnapshotCoverage: domSnapshotComparison,
    responsiveCoverage: responsiveComparison.coverage,
    assetCoverage: assetComparison.coverage,
    visualArtifacts: visualComparison.visualArtifacts,
  };
}

function coveredAuditRoutes(manifest, bundle) {
  const hasBundleRoutes = Array.isArray(bundle.routes);
  const auditableRoutes = (bundle.routes ?? [])
    .filter((entry) => entry.classifiedCount === undefined || entry.controlCount === undefined || entry.classifiedCount === entry.controlCount)
    .map((entry) => entry.route)
    .filter(Boolean);
  const routes = hasBundleRoutes
    ? auditableRoutes
    : manifest.scope?.routesCompleted ?? [];
  return [...new Set(routes)];
}

function readCompatibleControlAudit({ root, siteKey, measurementManifest, auditRunId, expectedPolicySha256, requiredRoutes, explicit }) {
  const manifest = readManifest(root, siteKey, auditRunId);
  const invalid = (message) => {
    if (explicit) throw new Error(`Control audit ${auditRunId} is incompatible: ${message}`);
    return null;
  };
  if (manifest.status !== 'closed') return invalid(`status is ${manifest.status}`);
  if (manifest.kind !== 'audit') return invalid(`kind is ${manifest.kind}`);
  if (manifest.scope?.parentRunId !== measurementManifest.runId) return invalid(`parent run is ${manifest.scope?.parentRunId ?? 'missing'}, expected ${measurementManifest.runId}`);
  if (manifest.target?.kind && manifest.target.kind !== measurementManifest.target?.kind) return invalid(`target is ${manifest.target.kind}, expected ${measurementManifest.target?.kind}`);
  if (manifest.policySha256 !== expectedPolicySha256) return invalid('policy snapshot does not match the requested diff policy');
  if (!manifest.artifacts.some((artifact) => artifact.path === 'audits/dead-controls.json')) return invalid('dead-controls artifact is missing');
  const bundle = readJson(root, siteKey, auditRunId, 'audits/dead-controls.json');
  const coveredRoutes = coveredAuditRoutes(manifest, bundle);
  const parentRoutes = new Set(measurementManifest.scope?.routesCompleted ?? measurementManifest.scope?.routesRequested ?? []);
  if (coveredRoutes.some((route) => !parentRoutes.has(route))) return invalid('covered routes escape the parent measurement scope');
  if (!explicit && requiredRoutes.some((route) => !coveredRoutes.includes(route))) return null;
  return {
    bundle: { runId: auditRunId, ...bundle },
    selection: { runId: auditRunId, mode: explicit ? 'explicit' : 'auto', coveredRoutes },
  };
}

export function selectControlAudit({ root = process.cwd(), siteKey, measurementRunId, auditRunId = null, policy = {}, requiredRoutes = null } = {}) {
  const measurementManifest = readManifest(root, siteKey, measurementRunId);
  const expectedPolicySha256 = policySha256(policy);
  const routes = requiredRoutes ?? measurementManifest.scope?.routesCompleted ?? measurementManifest.scope?.routesRequested ?? [];
  if (auditRunId) {
    return readCompatibleControlAudit({ root, siteKey, measurementManifest, auditRunId, expectedPolicySha256, requiredRoutes: routes, explicit: true });
  }
  const candidates = listRuns(root, siteKey)
    .filter((manifest) => manifest.status === 'closed' && manifest.kind === 'audit' && manifest.scope?.parentRunId === measurementRunId)
    .filter((manifest) => manifest.artifacts.some((artifact) => artifact.path === 'audits/dead-controls.json'))
    .reverse();
  for (const candidate of candidates) {
    const selected = readCompatibleControlAudit({
      root,
      siteKey,
      measurementManifest,
      auditRunId: candidate.runId,
      expectedPolicySha256,
      requiredRoutes: routes,
      explicit: false,
    });
    if (selected) return selected;
  }
  return null;
}

export function compareRuns({ root = process.cwd(), siteKey, sourceRunId, cloneRunId, reportRunId = null, policy = {}, sourceAuditRunId = null, cloneAuditRunId = null } = {}) {
  const sourceManifest = readManifest(root, siteKey, sourceRunId);
  const cloneManifest = readManifest(root, siteKey, cloneRunId);
  if (sourceManifest.status !== 'closed' || cloneManifest.status !== 'closed') throw new Error('Only closed runs can be compared');
  const sourceRoutes = readJson(root, siteKey, sourceRunId, 'measurements/routes.json');
  const cloneRoutes = readJson(root, siteKey, cloneRunId, 'measurements/routes.json');
  const sourceControls = readJson(root, siteKey, sourceRunId, 'measurements/controls.json');
  const cloneControls = readJson(root, siteKey, cloneRunId, 'measurements/controls.json');
  const sourceClasses = readJson(root, siteKey, sourceRunId, 'measurements/classes.json');
  const cloneClasses = readJson(root, siteKey, cloneRunId, 'measurements/classes.json');
  const sourceCoverage = readJson(root, siteKey, sourceRunId, 'coverage.json');
  const cloneCoverage = readJson(root, siteKey, cloneRunId, 'coverage.json');
  const sourceVisual = readOptionalJson(root, siteKey, sourceManifest, 'measurements/visual-regions.json');
  const cloneVisual = readOptionalJson(root, siteKey, cloneManifest, 'measurements/visual-regions.json');
  const sourceMotion = readOptionalJson(root, siteKey, sourceManifest, 'measurements/motion.json');
  const cloneMotion = readOptionalJson(root, siteKey, cloneManifest, 'measurements/motion.json');
  const sourceDomSnapshot = readOptionalJson(root, siteKey, sourceManifest, 'measurements/dom-snapshots.json');
  const cloneDomSnapshot = readOptionalJson(root, siteKey, cloneManifest, 'measurements/dom-snapshots.json');
  const sourceResponsiveIndex = readOptionalJson(root, siteKey, sourceManifest, 'measurements/responsive.json');
  const cloneResponsiveIndex = readOptionalJson(root, siteKey, cloneManifest, 'measurements/responsive.json');
  const sourceResponsive = hydrateResponsiveEvidence({ root, siteKey, runId: sourceRunId, index: sourceResponsiveIndex });
  const cloneResponsive = hydrateResponsiveEvidence({ root, siteKey, runId: cloneRunId, index: cloneResponsiveIndex });
  const sourceAssetsIndex = readOptionalJson(root, siteKey, sourceManifest, 'measurements/assets.json');
  const cloneAssetsIndex = readOptionalJson(root, siteKey, cloneManifest, 'measurements/assets.json');
  const sourceAssets = hydrateAssetEvidence({ root, siteKey, runId: sourceRunId, index: sourceAssetsIndex });
  const cloneAssets = hydrateAssetEvidence({ root, siteKey, runId: cloneRunId, index: cloneAssetsIndex });
  const sourceAuditSelection = selectControlAudit({ root, siteKey, measurementRunId: sourceRunId, auditRunId: sourceAuditRunId, policy });
  const cloneAuditSelection = selectControlAudit({ root, siteKey, measurementRunId: cloneRunId, auditRunId: cloneAuditRunId, policy });
  const sourceControlAudit = sourceAuditSelection?.bundle ?? null;
  const cloneControlAudit = cloneAuditSelection?.bundle ?? null;
  const report = compareMeasurementData({ root, siteKey, sourceRoutes, cloneRoutes, sourceControls, cloneControls, sourceClasses: sourceClasses.audit ?? sourceClasses, cloneClasses: cloneClasses.audit ?? cloneClasses, sourceVisual, cloneVisual, sourceMotion, cloneMotion, sourceDomSnapshot, cloneDomSnapshot, sourceResponsive, cloneResponsive, sourceAssets, cloneAssets, sourceRunId, cloneRunId, reportRunId, policy, sourceControlAudit, cloneControlAudit });
  return {
    ...report,
    source: { runId: sourceRunId, target: sourceManifest.target, scope: sourceManifest.scope },
    clone: { runId: cloneRunId, target: cloneManifest.target, scope: cloneManifest.scope },
    controlAudits: {
      sourceRunId: sourceControlAudit?.runId ?? null,
      cloneRunId: cloneControlAudit?.runId ?? null,
      source: sourceAuditSelection?.selection ?? null,
      clone: cloneAuditSelection?.selection ?? null,
    },
    unsupported: unsupportedKinds(sourceManifest, cloneManifest),
    coverage: {
      source: sourceRoutes.routes?.length ?? 0,
      clone: cloneRoutes.routes?.length ?? 0,
      sourceRunId,
      cloneRunId,
      sourceDetails: sourceCoverage,
      cloneDetails: cloneCoverage,
    },
  };
}

function inferFindingComparator(finding) {
  if (finding?.comparator) return finding.comparator;
  const category = finding?.category ?? '';
  if (category === 'missing-control' || category === 'extra-control') return comparator('static-control', 'control-presence', 'presence');
  const controlMatch = /^control-(.+)-mismatch$/u.exec(category);
  if (controlMatch) {
    const actionEvidence = [finding?.evidence?.source, finding?.evidence?.clone]
      .some((entry) => entry?.artifact?.includes('dead-controls'));
    return actionEvidence
      ? comparator('dead-controls', 'control-effect', controlMatch[1], finding?.policy?.mode ?? null)
      : comparator('static-control', 'control-static', controlMatch[1], finding?.policy?.mode ?? null);
  }
  if (category === 'route-missing' || category === 'route-status-mismatch') return comparator('route-inventory', 'route-status', 'status');
  if (category === 'route-destination-mismatch') return comparator('route-inventory', 'route-destination', 'destination', 'gate');
  if (category === 'new-dead-runtime-class') return comparator('compiled-css', 'dead-runtime-class', 'class-presence');
  if (category === 'visual-region-mismatch') return comparator('visual-region', 'visual-region', 'pixels', finding?.policy?.mode ?? finding?.comparator?.mode ?? null);
  if (category === 'visual-region-incomplete') return comparator('visual-region', 'visual-region', 'pixels', finding?.comparator?.mode ?? 'informational');
  if (category.startsWith('motion-')) return comparator('motion', 'motion', category.replace(/^motion-(?:source|clone)-|^motion-/u, '').replace(/-mismatch$/u, ''), finding?.policy?.mode ?? finding?.comparator?.mode ?? null);
  if (category.startsWith('responsive-')) return comparator('responsive', finding?.comparator?.evidenceClass ?? 'responsive', finding?.policy?.dimension ?? finding?.comparator?.dimension ?? null, finding?.policy?.mode ?? finding?.comparator?.mode ?? null);
  if (category.startsWith('asset-')) return comparator('assets', finding?.comparator?.evidenceClass ?? 'asset', finding?.policy?.dimension ?? finding?.comparator?.dimension ?? null, finding?.policy?.mode ?? finding?.comparator?.mode ?? null);
  if (category === 'dom-structure-mismatch') return comparator('dom-snapshot', 'dom-structure', 'structure', 'gate');
  if (category === 'dom-geometry-mismatch') return comparator('dom-snapshot', 'dom-geometry', 'geometry', 'informational');
  return null;
}

function sameControlSubject(left = {}, right = {}) {
  return ['route', 'role', 'name', 'controlClass', 'occurrence'].every((key) => (left[key] ?? null) === (right[key] ?? null));
}

function comparatorSubjectsMatch(instrument, expected = {}, actual = {}) {
  if (instrument === 'dead-controls' || instrument === 'static-control') return sameControlSubject(expected, actual);
  if (instrument === 'visual-region') return (expected.route ?? null) === (actual.route ?? null)
    && (expected.regionId ?? null) === (actual.regionId ?? null)
    && JSON.stringify(expected.viewport ?? null) === JSON.stringify(actual.viewport ?? null);
  if (instrument === 'motion') return (expected.route ?? null) === (actual.route ?? null)
    && (expected.role ?? null) === (actual.role ?? null)
    && (expected.name ?? null) === (actual.name ?? null)
    && (expected.motionId ?? null) === (actual.motionId ?? null)
    && (expected.occurrence ?? null) === (actual.occurrence ?? null);
  if (instrument === 'responsive') return (expected.route ?? null) === (actual.route ?? null)
    && (expected.condition ?? null) === (actual.condition ?? null)
    && canonicalJson(expected.viewport ?? null) === canonicalJson(actual.viewport ?? null);
  if (instrument === 'assets') return (expected.route ?? null) === (actual.route ?? null);
  return (expected.route ?? null) === (actual.route ?? null);
}

function reportComparisonScope(report, route) {
  const targetContext = (target) => target ? {
    kind: target.kind ?? null,
    origin: target.origin ?? null,
    profileId: target.profileId ?? null,
    tenant: target.tenant ?? null,
    role: target.role ?? null,
  } : null;
  const side = (entry, details) => {
    const coveredRoutes = (entry?.scope?.routesCompleted ?? entry?.scope?.routesRequested ?? []).map(visualRoutePath);
    const scope = details?.scope ?? null;
    return {
      targetKind: entry?.target?.kind ?? null,
      targetContext: targetContext(entry?.target),
      scope,
      inventoryBacked: scope !== null && scope !== 'ad-hoc',
      inventoryRunId: details?.inventory?.runId ?? entry?.scope?.inventoryRunId ?? null,
      routeCovered: route ? coveredRoutes.includes(visualRoutePath(route)) : true,
    };
  };
  return {
    source: side(report.source, report.coverage?.sourceDetails),
    clone: side(report.clone, report.coverage?.cloneDetails),
  };
}

function comparisonScopesCompatible(previous, current) {
  if (!previous) return current.source.routeCovered && current.clone.routeCovered;
  for (const side of ['source', 'clone']) {
    if (previous[side]?.targetKind && current[side]?.targetKind && previous[side].targetKind !== current[side].targetKind) return false;
    if (previous[side]?.targetContext && canonicalJson(previous[side].targetContext) !== canonicalJson(current[side]?.targetContext ?? null)) return false;
    if (previous[side]?.inventoryBacked && !current[side]?.inventoryBacked) return false;
    if (!current[side]?.routeCovered) return false;
  }
  return true;
}

function comparisonIdentity(report) {
  const targetContext = (target) => target ? {
    kind: target.kind ?? null,
    origin: target.origin ?? null,
    profileId: target.profileId ?? null,
    tenant: target.tenant ?? null,
    role: target.role ?? null,
  } : null;
  return {
    sourceKind: report.source?.target?.kind ?? null,
    cloneKind: report.clone?.target?.kind ?? null,
    sourceContext: targetContext(report.source?.target),
    cloneContext: targetContext(report.clone?.target),
  };
}

export function findingCanClose(previousSummary, report) {
  const finding = previousSummary?.finding;
  if (!finding) return false;
  const required = inferFindingComparator(finding);
  if (!required) return false;
  const coverage = (report.comparatorCoverage ?? []).find((entry) => {
    const current = entry.comparator ?? {};
    if (current.instrument !== required.instrument || current.evidenceClass !== required.evidenceClass) return false;
    if ((current.dimension ?? null) !== (required.dimension ?? null)) return false;
    if (required.mode && current.mode && required.mode !== current.mode) return false;
    if (required.instrument === 'visual-region') {
      if (canonicalJson(finding.policy ?? null) !== canonicalJson(current.policy ?? null)) return false;
    }
    return comparatorSubjectsMatch(required.instrument, finding.subject ?? finding, entry.subject ?? {});
  });
  if (!coverage || coverage.complete === false) return false;
  return comparisonScopesCompatible(finding.comparisonScope ?? null, reportComparisonScope(report, finding.subject?.route ?? finding.route ?? null));
}

export function findingEventsFromReport(report) {
  const comparison = comparisonIdentity(report);
  return report.findings.map((finding, index) => ({
    type: 'finding.opened',
    findingId: stableFindingId({
      ...finding,
      domain: 'parity',
      target: 'comparison',
      comparison,
    }) || `F-${String(index + 1).padStart(4, '0')}`,
    sourceRunId: report.sourceRunId,
    cloneRunId: report.cloneRunId,
    finding: {
      ...finding,
      domain: 'parity',
      target: 'comparison',
      comparison,
      comparisonScope: reportComparisonScope(report, finding.subject?.route ?? finding.route ?? null),
    },
  }));
}

export { SUPPORTED_KINDS, normalizedDestination };
