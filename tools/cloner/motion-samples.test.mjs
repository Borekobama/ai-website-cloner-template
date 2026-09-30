import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareMotionObservations, relativeMotionSamples } from './motion.mjs';

const identity = '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1';

function run(offsetY, movement = 0) {
  const samples = [0, 0.5, 1].map((progress) => ({
    progress,
    transform: identity,
    opacity: String(0.6 + progress * 0.4),
    rect: { x: 10, y: 100 + offsetY + progress * movement, width: 60, height: 30 },
  }));
  const animations = [{ name: 'pulse', duration: 1000, samples }];
  return {
    complete: true,
    routes: [{
      route: '/home',
      observations: [{
        key: '/home|button|Toggle||0',
        identity: { path: 'main>button', role: 'button', name: 'Toggle', motionId: null, occurrence: 0 },
        declared: { animationName: 'pulse' },
        state: {},
        transformGate: animations,
        transformGateComplete: true,
        rendered: { transform: identity, opacity: '0.6', visibility: 'visible', rect: samples[0].rect },
        samples: animations,
      }],
    }],
  };
}

test('motion samples compare positions relative to the first frame', () => {
  const shifted = compareMotionObservations(run(0), run(22), '20260914T000001Z_source_11111111', '20260914T000002Z_clone_22222222');
  const categories = shifted.findings.map((finding) => finding.category);
  assert.equal(categories.includes('motion-transform-mismatch'), false, 'a page-level layout shift is not different motion');
  assert.equal(categories.includes('motion-samples-mismatch'), false);
  assert.deepEqual(categories, ['motion-rendered-mismatch'], 'absolute position stays informational');

  const moving = compareMotionObservations(run(0), run(0, 40), '20260914T000001Z_source_11111111', '20260914T000002Z_clone_22222222');
  assert.ok(moving.findings.some((finding) => finding.category === 'motion-transform-mismatch'), 'motion that moves the element is still gated');
  assert.deepEqual(relativeMotionSamples(run(0, 40).routes[0].observations[0].samples)[0].samples[2].rectDelta, { x: 0, y: 40, width: 0, height: 0 });
  assert.equal(relativeMotionSamples(identity), identity);
});
