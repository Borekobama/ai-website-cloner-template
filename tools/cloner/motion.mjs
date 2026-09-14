import { canonicalJson, sha256 } from './run-store.mjs';
import { redactForPersistence } from './redact.mjs';

export const MOTION_SCHEMA_VERSION = 1;

const ANIMATION_FIELDS = [
  'animationName',
  'animationDuration',
  'animationDelay',
  'animationTimingFunction',
  'animationFillMode',
  'animationDirection',
  'animationIterationCount',
];
const TRANSITION_FIELDS = [
  'transitionProperty',
  'transitionDuration',
  'transitionDelay',
  'transitionTimingFunction',
];
function motionKey(observation) {
  const identity = observation.identity;
  return `${observation.route}|${identity.role}|${identity.name}|${identity.motionId ?? ''}|${identity.occurrence}`;
}

export function canonicalMotionKey(observation) {
  return motionKey(observation);
}

export async function captureMotion(page, { route, sample = false } = {}) {
  const observations = await page.evaluate(({ sampleAnimations, animationFields, transitionFields }) => {
    const stateAttributes = ['data-state', 'data-side', 'aria-expanded', 'aria-selected', 'aria-pressed', 'aria-checked', 'aria-disabled'];
    const semanticOccurrences = new Map();

    const domPath = (element) => {
      const parts = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        let index = 1;
        let sibling = current;
        while ((sibling = sibling.previousElementSibling)) index += 1;
        parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);
        current = current.parentElement;
      }
      return parts.join('>');
    };

    const role = (element) => element.getAttribute('role') || element.tagName.toLowerCase();
    const name = (element) => (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').replace(/\s+/gu, ' ').trim().slice(0, 160);
    const angleInDegrees = (value) => {
      if (!value || value === 'none') return 0;
      const match = /^(-?[\d.]+)(deg|rad|turn)$/u.exec(value.trim());
      if (!match) return 0;
      const amount = Number(match[1]);
      return match[2] === 'rad' ? amount * 180 / Math.PI : match[2] === 'turn' ? amount * 360 : amount;
    };
    const length = (value) => Number.parseFloat(value) || 0;
    const canonicalTransform = (style) => {
      try {
        let matrix = new DOMMatrix();
        if (style.translate && style.translate !== 'none') {
          const values = style.translate.trim().split(/\s+/u);
          matrix = matrix.translate(length(values[0]), length(values[1]), length(values[2]));
        }
        if (style.rotate && style.rotate !== 'none') {
          const values = style.rotate.trim().split(/\s+/u);
          if (values.length === 1) matrix = matrix.rotate(angleInDegrees(values[0]));
          else if (values.length === 2 && ['x', 'y', 'z'].includes(values[0].toLowerCase())) {
            const axis = values[0].toLowerCase();
            matrix = matrix.rotateAxisAngle(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0, angleInDegrees(values[1]));
          }
          else if (values.length === 4) matrix = matrix.rotateAxisAngle(Number(values[0]), Number(values[1]), Number(values[2]), angleInDegrees(values[3]));
        }
        if (style.scale && style.scale !== 'none') {
          const values = style.scale.trim().split(/\s+/u).map(Number);
          matrix = matrix.scale(values[0] ?? 1, values[1] ?? values[0] ?? 1, values[2] ?? 1);
        }
        if (style.transform && style.transform !== 'none') matrix = matrix.multiply(new DOMMatrix(style.transform));
        return [matrix.m11, matrix.m12, matrix.m13, matrix.m14, matrix.m21, matrix.m22, matrix.m23, matrix.m24, matrix.m31, matrix.m32, matrix.m33, matrix.m34, matrix.m41, matrix.m42, matrix.m43, matrix.m44]
          .map((value) => Number(value.toFixed(6))).join(',');
      } catch {
        return style.transform || 'none';
      }
    };
    const rect = (element) => {
      const box = element.getBoundingClientRect();
      return {
        x: Number(box.x.toFixed(3)),
        y: Number(box.y.toFixed(3)),
        width: Number(box.width.toFixed(3)),
        height: Number(box.height.toFixed(3)),
      };
    };
    const readSamples = (element) => {
      if (!sampleAnimations || typeof element.getAnimations !== 'function') return [];
      const animations = element.getAnimations({ subtree: false }).filter((animation) => !animation.pending && animation.playState !== 'idle');
      const snapshots = animations.map((animation) => ({
        animation,
        currentTime: animation.currentTime,
        playState: animation.playState,
        playbackRate: animation.playbackRate,
      }));
      try {
        animations.forEach((animation) => animation.pause());
        return snapshots.flatMap(({ animation }) => {
          const effect = animation.effect;
          const timing = effect?.getComputedTiming?.();
          const duration = Number(timing?.duration);
          if (!effect || !Number.isFinite(duration) || duration <= 0) return [];
          const samples = [0, 0.5, 1].map((progress) => {
            animation.currentTime = duration * progress;
            const style = getComputedStyle(element);
            return { progress, transform: canonicalTransform(style), opacity: style.opacity, rect: rect(element) };
          });
          return [{ name: animation.animationName || null, duration, samples }];
        });
      } finally {
        for (const { animation, currentTime, playState, playbackRate } of snapshots) {
          try {
            animation.playbackRate = playbackRate;
            animation.currentTime = currentTime;
            if (playState === 'running') animation.play();
            else if (playState === 'paused') animation.pause();
            else if (playState === 'finished') animation.finish();
          } catch {
            // A discarded animation cannot be restored.
          }
        }
      }
    };

    return [...document.querySelectorAll('*')].flatMap((element) => {
      const style = getComputedStyle(element);
      const hasAnimation = style.animationName !== 'none'
        || style.animationDuration !== '0s'
        || style.animationDelay !== '0s'
        || style.animationTimingFunction !== 'ease'
        || style.animationFillMode !== 'none'
        || style.animationDirection !== 'normal'
        || style.animationIterationCount !== '1';
      const hasTransition = style.transitionProperty !== 'all'
        || style.transitionDuration !== '0s'
        || style.transitionDelay !== '0s'
        || style.transitionTimingFunction !== 'ease';
      const state = Object.fromEntries(stateAttributes.map((attribute) => [attribute, element.getAttribute(attribute)]));
      const hasState = Object.values(state).some((value) => value !== null);
      if (!hasAnimation && !hasTransition && !hasState) return [];
      const semanticKey = `${role(element)}|${name(element)}|${element.getAttribute('data-motion-id') ?? ''}`;
      const occurrence = semanticOccurrences.get(semanticKey) ?? 0;
      semanticOccurrences.set(semanticKey, occurrence + 1);
      const declared = Object.fromEntries([...animationFields, ...transitionFields].map((field) => [field, style[field]]));
      return [{
        identity: {
          path: domPath(element),
          tag: element.tagName.toLowerCase(),
          role: role(element),
          name: name(element),
          motionId: element.getAttribute('data-motion-id'),
          occurrence,
        },
        declared,
        state,
        transformLonghands: { translate: style.translate, rotate: style.rotate, scale: style.scale },
        rendered: {
          transform: canonicalTransform(style),
          opacity: style.opacity,
          visibility: style.visibility,
          rect: rect(element),
        },
        samples: readSamples(element),
      }];
    });
  }, { sampleAnimations: sample, animationFields: ANIMATION_FIELDS, transitionFields: TRANSITION_FIELDS });
  return {
    schemaVersion: MOTION_SCHEMA_VERSION,
    kind: 'motion-observation',
    route,
    sampled: sample,
    complete: true,
    observations: observations.map((observation) => {
      const persisted = redactForPersistence({ ...observation, key: motionKey({ route, ...observation }) });
      return { ...persisted, fingerprint: sha256(canonicalJson(persisted)) };
    }),
  };
}

export function motionObservationsByKey(value) {
  const observations = [];
  for (const route of value?.routes ?? []) {
    for (const observation of route.observations ?? []) observations.push({ ...observation, route: route.route, routeComplete: route.complete !== false });
  }
  return new Map(observations.map((observation) => [observation.key ?? motionKey(observation), observation]));
}

export function motionSubject(observation) {
  return {
    route: observation.route,
    path: observation.identity.path,
    role: observation.identity.role,
    name: observation.identity.name,
    motionId: observation.identity.motionId ?? null,
    occurrence: observation.identity.occurrence,
  };
}

export function compareMotionObservations(source, clone, sourceRunId, cloneRunId) {
  if (!source && !clone) return { findings: [], comparatorCoverage: [], coverage: { configured: false, complete: true, observationsCompared: 0 } };
  if (!source || !clone) {
    return {
      findings: [{
        category: 'motion-incomplete',
        status: 'informational',
        policy: { dimension: 'presence', mode: 'informational' },
        comparator: { instrument: 'motion', evidenceClass: 'motion', dimension: 'presence', mode: 'informational' },
        observed: { source: source ? 'captured' : 'missing', clone: clone ? 'captured' : 'missing' },
        evidence: { source: source ? { runId: sourceRunId, artifact: 'measurements/motion.json', locator: '#' } : null, clone: clone ? { runId: cloneRunId, artifact: 'measurements/motion.json', locator: '#' } : null },
      }],
      comparatorCoverage: [{ comparator: { instrument: 'motion', evidenceClass: 'motion', dimension: 'presence', mode: 'informational' }, subject: { route: null }, complete: false }],
      coverage: { configured: true, complete: false, reason: 'one-sided-motion-evidence' },
    };
  }
  const sourceMap = motionObservationsByKey(source);
  const cloneMap = motionObservationsByKey(clone);
  const findings = [];
  const comparatorCoverage = [];
  const subjects = new Set([...sourceMap.keys(), ...cloneMap.keys()]);
  const evidence = (value, runId, observation) => {
    if (!observation) return null;
    for (const [routeIndex, route] of (value?.routes ?? []).entries()) {
      if (route.route !== observation.route) continue;
      const observationIndex = (route.observations ?? []).findIndex((candidate) => (
        candidate.key === observation.key
        || (candidate.identity?.path === observation.identity?.path
          && candidate.identity?.occurrence === observation.identity?.occurrence)
      ));
      if (observationIndex !== -1) {
        return { runId, artifact: 'measurements/motion.json', locator: `#/routes/${routeIndex}/observations/${observationIndex}` };
      }
    }
    return { runId, artifact: 'measurements/motion.json', locator: '#' };
  };
  const compareDimension = (sourceObservation, cloneObservation, dimension, mode, sourceValue, cloneValue) => {
    const subject = motionSubject(sourceObservation ?? cloneObservation);
    const comparator = { instrument: 'motion', evidenceClass: 'motion', dimension, mode };
    const complete = Boolean(sourceObservation && cloneObservation)
      && source?.complete !== false
      && clone?.complete !== false
      && sourceObservation.routeComplete !== false
      && cloneObservation.routeComplete !== false;
    const coverage = { comparator, subject, complete };
    comparatorCoverage.push(coverage);
    if (!sourceObservation || !cloneObservation) return;
    if (canonicalJson(sourceValue) === canonicalJson(cloneValue)) return;
    findings.push({
      category: `motion-${dimension}-mismatch`,
      subject,
      status: mode === 'gate' ? 'open' : 'informational',
      policy: { dimension, mode },
      comparator,
      observed: { source: sourceValue, clone: cloneValue },
      evidence: {
        source: evidence(source, sourceRunId, sourceObservation),
        clone: evidence(clone, cloneRunId, cloneObservation),
      },
    });
  };
  for (const key of subjects) {
    const sourceObservation = sourceMap.get(key);
    const cloneObservation = cloneMap.get(key);
    if (!sourceObservation || !cloneObservation) {
      const subject = motionSubject(sourceObservation ?? cloneObservation);
      const side = sourceObservation ? 'clone' : 'source';
      comparatorCoverage.push({ comparator: { instrument: 'motion', evidenceClass: 'motion', dimension: 'presence', mode: 'gate' }, subject, complete: false });
      findings.push({
        category: `motion-${side}-missing`,
        subject,
        status: 'open',
        policy: { dimension: 'presence', mode: 'gate' },
        comparator: { instrument: 'motion', evidenceClass: 'motion', dimension: 'presence', mode: 'gate' },
        evidence: {
          source: sourceObservation ? evidence(source, sourceRunId, sourceObservation) : null,
          clone: cloneObservation ? evidence(clone, cloneRunId, cloneObservation) : null,
        },
      });
      continue;
    }
    comparatorCoverage.push({ comparator: { instrument: 'motion', evidenceClass: 'motion', dimension: 'presence', mode: 'gate' }, subject: motionSubject(sourceObservation), complete: source?.complete !== false && clone?.complete !== false && sourceObservation.routeComplete !== false && cloneObservation.routeComplete !== false });
    compareDimension(sourceObservation, cloneObservation, 'declared', 'gate', sourceObservation.declared, cloneObservation.declared);
    compareDimension(sourceObservation, cloneObservation, 'state', 'gate', sourceObservation.state, cloneObservation.state);
    compareDimension(sourceObservation, cloneObservation, 'transform', 'gate', sourceObservation.rendered.transform, cloneObservation.rendered.transform);
    compareDimension(sourceObservation, cloneObservation, 'rendered', 'informational', sourceObservation.rendered, cloneObservation.rendered);
    if (sourceObservation.samples?.length || cloneObservation.samples?.length) {
      compareDimension(sourceObservation, cloneObservation, 'samples', 'informational', sourceObservation.samples, cloneObservation.samples);
    }
  }
  return {
    findings,
    comparatorCoverage,
    coverage: {
      configured: true,
      complete: source.complete !== false && clone.complete !== false && comparatorCoverage.every((entry) => entry.complete),
      observationsCompared: [...sourceMap.keys()].filter((key) => cloneMap.has(key)).length,
      sourceObservations: sourceMap.size,
      cloneObservations: cloneMap.size,
    },
  };
}
