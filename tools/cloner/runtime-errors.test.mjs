import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { compareRuntimeErrors, createRuntimeErrorTracker, runtimeErrorSignature } from './runtime-errors.mjs';

const consoleMessage = (type, text) => ({ type: () => type, text: () => text });

test('runtime error tracker records page errors, console errors, and hydration failures', () => {
  const page = new EventEmitter();
  const tracker = createRuntimeErrorTracker(page);
  page.emit('pageerror', new TypeError('Cannot read properties of undefined (reading 42) at https://example.test/app.js?token=abc'));
  page.emit('console', consoleMessage('error', 'Hydration failed because the server rendered HTML did not match the client.'));
  page.emit('console', consoleMessage('warning', 'Deprecated API'));
  page.emit('console', consoleMessage('log', 'hello'));
  const snapshot = tracker.snapshot();
  tracker.stop();
  assert.equal(snapshot.captured, true);
  assert.equal(snapshot.pageErrors[0].name, 'TypeError');
  assert.equal(snapshot.pageErrors[0].message.includes('token=abc'), false, 'messages are redacted');
  assert.equal(snapshot.consoleErrors.length, 1);
  assert.equal(snapshot.consoleWarnings, 1);
  assert.equal(snapshot.hydrationErrors, 1);
  assert.equal(page.listenerCount('pageerror') + page.listenerCount('console'), 0);
  assert.equal(runtimeErrorSignature('Failed at line 12 in https://a.test/x.js'), runtimeErrorSignature('Failed at line 99 in https://b.test/y.js'));
});

test('runtime comparison flags clone-only errors and tolerates shared source defects', () => {
  const errors = (overrides = {}) => ({ schemaVersion: 1, captured: true, pageErrors: [], consoleErrors: [], consoleWarnings: 0, hydrationErrors: 0, ...overrides });
  const routes = (runtimeErrors) => ({ routes: [{ route: '/home', runtimeErrors }] });
  const crash = { name: 'Error', message: 'Boom', signature: 'Boom' };
  const noisy = { text: 'Failed to load resource', signature: 'Failed to load resource' };
  const report = compareRuntimeErrors(
    routes(errors({ consoleErrors: [noisy] })),
    routes(errors({ pageErrors: [crash], consoleErrors: [noisy, { text: 'Other', signature: 'Other' }], hydrationErrors: 1 })),
    '20260914T000001Z_source_11111111',
    '20260914T000002Z_clone_22222222',
  );
  assert.deepEqual(report.findings.map((finding) => [finding.category, finding.status]), [
    ['runtime-page-error-mismatch', 'open'],
    ['runtime-hydration-error', 'open'],
    ['runtime-console-error-mismatch', 'informational'],
  ]);
  assert.deepEqual(report.findings[2].observed.cloneOnly, ['Other']);
  const shared = compareRuntimeErrors(routes(errors({ pageErrors: [crash] })), routes(errors({ pageErrors: [crash] })), '20260914T000001Z_source_11111111', '20260914T000002Z_clone_22222222');
  assert.deepEqual(shared.findings, []);
  const legacy = compareRuntimeErrors(routes(undefined), routes(errors()), '20260914T000001Z_source_11111111', '20260914T000002Z_clone_22222222');
  assert.deepEqual(legacy.findings, []);
  assert.equal(legacy.coverage.complete, false);
});
