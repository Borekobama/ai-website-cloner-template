import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PNG } from 'pngjs';
import { captureVisualRegions, normalizeVisualRegionConfig, visualRegionConfigHash } from './visual-regions.mjs';

function png() {
  const image = new PNG({ width: 2, height: 2 });
  image.data.fill(255);
  return PNG.sync.write(image);
}

function fakeBrowser({ statePath = '/home' } = {}) {
  const calls = [];
  const locator = (owner, selector) => ({
    count: async () => 1,
    screenshot: async (options) => {
      calls.push({ owner, action: 'screenshot', selector, mask: options.mask?.length ?? 0, maskColor: options.maskColor ?? null });
      return png();
    },
    evaluate: async () => ({ role: 'button', name: 'More', controlClass: 'menu' }),
    click: async () => calls.push({ owner, action: 'click', selector }),
    hover: async () => calls.push({ owner, action: 'hover', selector }),
    focus: async () => calls.push({ owner, action: 'focus', selector }),
  });
  const statePage = {
    goto: async () => calls.push({ owner: 'state', action: 'goto' }),
    waitForLoadState: async () => {},
    url: () => `http://fixture.test${statePath}`,
    locator: (selector) => locator('state', selector),
    close: async () => calls.push({ owner: 'state', action: 'close' }),
  };
  const page = {
    url: () => 'http://fixture.test/home',
    viewportSize: () => ({ width: 2, height: 2 }),
    locator: (selector) => locator('main', selector),
    context: () => ({ newPage: async () => statePage }),
  };
  return { page, calls };
}

const viewport = { width: 2, height: 2 };

test('masks are painted on both captures and change the configuration hash', async () => {
  const config = { schemaVersion: 1, regions: [{ route: '/home', viewport, id: 'panel', selector: '#panel', mask: ['#clock', '.avatar'] }] };
  const { page, calls } = fakeBrowser();
  const result = await captureVisualRegions(page, { config, target: 'clone', route: '/home' });
  assert.equal(result.regions[0].status, 'captured');
  assert.deepEqual(result.regions[0].mask, ['#clock', '.avatar']);
  assert.deepEqual(calls, [{ owner: 'main', action: 'screenshot', selector: '#panel', mask: 2, maskColor: '#FF00FF' }]);
  const unmasked = { schemaVersion: 1, regions: [{ route: '/home', viewport, id: 'panel', selector: '#panel' }] };
  assert.notEqual(visualRegionConfigHash(config), visualRegionConfigHash(unmasked));
  assert.throws(() => normalizeVisualRegionConfig({ regions: [{ route: '/home', viewport, id: 'bad', selector: '#x', mask: [] }] }), /mask must be/);
  assert.throws(() => normalizeVisualRegionConfig({ regions: [{ route: '/home', viewport, id: 'bad', selector: '#x', state: { action: 'drag', selector: '#y' } }] }), /state\.action/);
});

test('state regions interact on a fresh page only after safe-action policy allows it', async () => {
  const config = { schemaVersion: 1, regions: [{ route: '/home', viewport, id: 'menu', selector: '#menu', state: { action: 'click', selector: '#more' } }] };
  const blocked = fakeBrowser();
  const blockedResult = await captureVisualRegions(blocked.page, { config, target: 'source', route: '/home', policy: {} });
  assert.equal(blockedResult.regions[0].status, 'incomplete');
  assert.equal(blockedResult.regions[0].reason, 'blocked-by-policy');
  assert.equal(blocked.calls.some((call) => call.action === 'click'), false, 'a blocked source action must never run');
  assert.equal(blocked.calls.at(-1).action, 'close');

  const allowed = fakeBrowser();
  const policy = { version: 1, actions: [{ id: 'menu', match: { route: '/home', role: 'button', name: 'More' }, source: 'allow' }] };
  const allowedResult = await captureVisualRegions(allowed.page, { config, target: 'source', route: '/home', policy });
  assert.equal(allowedResult.regions[0].status, 'captured');
  assert.equal(allowedResult.regions[0].policy.outcome, 'allowed');
  assert.deepEqual(allowed.calls.map((call) => `${call.owner}:${call.action}`), ['state:goto', 'state:click', 'state:screenshot', 'state:close']);

  const moved = fakeBrowser({ statePath: '/login' });
  const movedResult = await captureVisualRegions(moved.page, { config, target: 'clone', route: '/home' });
  assert.equal(movedResult.regions[0].reason, 'state-page-mismatch');
});
