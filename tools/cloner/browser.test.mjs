import assert from 'node:assert/strict';
import test from 'node:test';
import { launchBrowser } from './browser.mjs';

test('browser launch falls back to installed Chrome when bundled ICU data is inaccessible', async () => {
  const calls = [];
  const browser = { version: async () => 'mock-chrome', close: async () => {} };
  const runtime = {
    launch: async (options) => {
      calls.push(options);
      if (calls.length === 1) throw new Error('icudtl.dat not found in bundle');
      return browser;
    },
  };
  const result = await launchBrowser({ headless: true, executablePath: '/broken/chromium' }, runtime);
  assert.equal(result, browser);
  assert.deepEqual(calls, [
    { headless: true, executablePath: '/broken/chromium' },
    { headless: true, channel: 'chrome' },
  ]);
});
