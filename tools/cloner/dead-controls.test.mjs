import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditDeadControls, mapWithConcurrency } from './audits/dead-controls.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function description(control) {
  return {
    role: control.role,
    name: control.name,
    id: null,
    selector: null,
    controlClass: control.controlClass ?? 'default',
    href: control.href ?? null,
    alreadyActive: false,
    structure: { tag: control.role === 'link' ? 'a' : 'button', type: null, parentTag: 'div', parentRole: null, childElementCount: 0 },
  };
}

// A minimal stand-in for the Playwright objects the audit touches. Each page
// answers the audit's in-page functions by recognising them from their source.
function fakeBrowser(controls, { gotoDelayMs = 0 } = {}) {
  const stats = { contexts: 0, open: 0, maxOpen: 0, lookupsWithoutTimeout: 0 };
  const makePage = () => {
    const state = { url: 'http://fixture.test/home', gone: false, clicks: 0 };
    const element = (index) => ({
      evaluate: (fn, _arg, options) => {
        if (state.gone) {
          // Playwright waits for a missing element until the timeout; its default is 30 s.
          if (!options?.timeout) {
            stats.lookupsWithoutTimeout += 1;
            return new Promise(() => {});
          }
          return wait(options.timeout).then(() => { throw new Error('Timeout exceeded'); });
        }
        const source = String(fn);
        if (source.includes('alreadyActive')) return Promise.resolve(description(controls[index]));
        if (source.includes('dataState')) return Promise.resolve({ ariaState: {}, className: null, dataState: null });
        if (source.includes('fieldset[disabled]')) return Promise.resolve(false);
        if (source.includes('data-control-region')) {
          return Promise.resolve({
            control: { dom: 'control', aria: '', style: '', structure: '' },
            region: { dom: `region-${state.clicks}`, aria: '', style: '', structure: '' },
          });
        }
        return Promise.reject(new Error('Unexpected in-page function'));
      },
      isVisible: async () => !state.gone,
      getAttribute: async () => null,
      isEnabled: async () => true,
      click: async (options = {}) => {
        if (options.trial) return;
        state.clicks += 1;
        if (controls[index].navigates) {
          state.url = 'http://fixture.test/elsewhere';
          state.gone = true;
        }
      },
    });
    return {
      url: () => state.url,
      viewportSize: () => ({ width: 800, height: 600 }),
      evaluate: async (fn) => (String(fn).includes('sessionStorage')
        ? {}
        : { url: state.url, dom: `page-${state.clicks}`, aria: '', style: '', structure: '', overlayCount: 0, overlays: [] }),
      locator: () => ({ count: async () => (state.gone ? 0 : controls.length), nth: (index) => element(index) }),
      on: () => {},
      off: () => {},
      waitForTimeout: wait,
      goto: async () => {
        await wait(gotoDelayMs);
        return { status: () => 200 };
      },
      waitForLoadState: async () => {},
    };
  };
  const browser = {
    newContext: async () => {
      stats.contexts += 1;
      stats.open += 1;
      stats.maxOpen = Math.max(stats.maxOpen, stats.open);
      return {
        addInitScript: async () => {},
        newPage: async () => makePage(),
        close: async () => { stats.open -= 1; },
      };
    },
  };
  const page = makePage();
  page.context = () => ({ browser: () => browser, storageState: async () => ({ cookies: [], origins: [] }) });
  return { page, stats };
}

const buttons = (count) => Array.from({ length: count }, (_, index) => ({ role: 'button', name: `Action ${index}` }));
const allowSource = { version: 1, actions: [{ id: 'fixture', match: { route: '/home' }, source: 'allow' }] };

test('concurrency helper keeps input order and respects its limit', async () => {
  let running = 0;
  let peak = 0;
  const results = await mapWithConcurrency([30, 5, 20, 1, 10], 2, async (delay, index) => {
    running += 1;
    peak = Math.max(peak, running);
    await wait(delay);
    running -= 1;
    return index;
  });
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
});

test('blocked controls are recorded from the baseline without opening a trial', async () => {
  const { page, stats } = fakeBrowser(buttons(3));
  const audit = await auditDeadControls(page, { target: 'source', route: '/home', policy: {} });
  assert.equal(stats.contexts, 0);
  assert.deepEqual(audit.observations.map((observation) => observation.category), ['blocked-by-policy', 'blocked-by-policy', 'blocked-by-policy']);
  assert.ok(audit.observations.every((observation) => observation.trialSkipped && observation.visible && observation.enabled && !observation.actionExecuted));
  assert.equal(audit.classifiedCount, 3);
});

test('clone trials overlap up to the limit while source trials stay sequential', async () => {
  const clone = fakeBrowser(buttons(6), { gotoDelayMs: 20 });
  const cloneAudit = await auditDeadControls(clone.page, { target: 'clone', route: '/home', concurrency: 3, effectWaitMs: 1 });
  assert.equal(clone.stats.maxOpen, 3);
  assert.equal(cloneAudit.trialConcurrency, 3);
  assert.deepEqual(cloneAudit.observations.map((observation) => observation.index), [0, 1, 2, 3, 4, 5]);
  assert.ok(cloneAudit.observations.every((observation) => observation.actionExecuted));

  const source = fakeBrowser(buttons(4), { gotoDelayMs: 20 });
  const sourceAudit = await auditDeadControls(source.page, { target: 'source', route: '/home', policy: allowSource, concurrency: 4, effectWaitMs: 1 });
  assert.equal(source.stats.maxOpen, 1);
  assert.equal(sourceAudit.trialConcurrency, 1);
});

test('a control that navigates away does not stall the audit', { timeout: 5000 }, async () => {
  const { page, stats } = fakeBrowser([{ role: 'link', name: 'Go elsewhere', href: '/elsewhere', controlClass: 'navigation', navigates: true }]);
  const started = Date.now();
  const audit = await auditDeadControls(page, { target: 'clone', route: '/home', actionTimeout: 50, effectWaitMs: 1 });
  assert.equal(stats.lookupsWithoutTimeout, 0, 'every lookup after the action must be bounded');
  assert.ok(Date.now() - started < 2000);
  assert.equal(audit.observations[0].category, 'link/navigation');
  assert.equal(audit.observations[0].evidence.controlAfter, null);
});
