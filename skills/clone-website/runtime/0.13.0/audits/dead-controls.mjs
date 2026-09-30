import { sha256 } from '../run-store.mjs';
import { evaluateAction } from '../policy.mjs';
import { redactForPersistence, safeUrl } from '../redact.mjs';

const CONTROL_SELECTOR = 'button, a, input, select, textarea, [role="button"], [role="tab"], [role="menuitem"], [role="switch"]';

function safeText(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, 240);
}

function hasEffect(effect) {
  return Boolean(effect.urlChanged || effect.domChanged || effect.ariaChanged || effect.styleChanged || effect.structureChanged || effect.overlayOpened || effect.networkObserved);
}

function fingerprintChanged(before, after, key) {
  if (!before || !after || before[key] === undefined || after[key] === undefined) return false;
  return before[key] !== after[key];
}

function requestKey(request = {}) {
  return JSON.stringify([request.method ?? null, request.resourceType ?? null, request.url ?? null]);
}

function hasNetworkBeyondAmbient(action = {}, ambient = {}) {
  const ambientCounts = new Map();
  for (const request of ambient.requests ?? []) {
    const key = requestKey(request);
    ambientCounts.set(key, (ambientCounts.get(key) ?? 0) + 1);
  }
  for (const request of action.requests ?? []) {
    const key = requestKey(request);
    const remaining = ambientCounts.get(key) ?? 0;
    if (remaining > 0) ambientCounts.set(key, remaining - 1);
    else return true;
  }
  return (action.count ?? 0) > (ambient.count ?? 0);
}

function rawEffectChanges(before, after) {
  return {
    urlChanged: before.url !== after.url,
    domChanged: before.domFingerprint !== after.domFingerprint,
    ariaChanged: before.ariaFingerprint !== after.ariaFingerprint,
    styleChanged: before.styleFingerprint !== after.styleFingerprint,
    structureChanged: before.structureFingerprint !== after.structureFingerprint,
    overlayOpened: before.overlayCount < after.overlayCount,
    networkObserved: (after.network?.count ?? 0) > 0,
  };
}

function localChange(before, after, ambientBefore, ambientAfter, key, wholePageChanged, ambientWholePageChanged) {
  const actionControlChanged = fingerprintChanged(before.local?.control, after.local?.control, key);
  const ambientControlChanged = fingerprintChanged(ambientBefore?.local?.control, ambientAfter?.local?.control, key);
  if (actionControlChanged && !ambientControlChanged) return true;

  const actionRegionChanged = fingerprintChanged(before.local?.region, after.local?.region, key);
  const ambientRegionChanged = fingerprintChanged(ambientBefore?.local?.region, ambientAfter?.local?.region, key);
  if (actionRegionChanged && !ambientRegionChanged) return true;

  if (ambientControlChanged || ambientRegionChanged) return false;
  return wholePageChanged && !ambientWholePageChanged;
}

export function classifyControl({ actionability = 'reachable', disabled = false, policyOutcome = 'allowed', after = {}, alreadyActive = false } = {}) {
  if (policyOutcome === 'blocked-by-policy') return 'blocked-by-policy';
  if (disabled) return 'disabled';
  if (actionability !== 'reachable') return 'unreachable';
  if (alreadyActive) return 'already-active';
  if (hasEffect(after)) {
    if (after.urlChanged) return 'link/navigation';
    if (after.overlayOpened) return 'overlay';
    if (after.ariaChanged && !after.domChanged && !after.styleChanged) return 'state change';
    if (after.domChanged) return 'DOM change';
    if (after.styleChanged) return 'style/class change';
    if (after.networkObserved) return 'network';
    return 'state change';
  }
  return 'dead';
}

export function compareEffectSignatures(before, after, { ambientBefore = null, ambientAfter = null } = {}) {
  const action = rawEffectChanges(before, after);
  const ambient = ambientBefore && ambientAfter
    ? rawEffectChanges(ambientBefore, ambientAfter)
    : {
        urlChanged: false,
        domChanged: false,
        ariaChanged: false,
        styleChanged: false,
        structureChanged: false,
        overlayOpened: false,
        networkObserved: false,
      };
  const ambientOverlayDelta = ambientBefore && ambientAfter
    ? Math.max(0, ambientAfter.overlayCount - ambientBefore.overlayCount)
    : 0;
  const actionOverlayDelta = Math.max(0, after.overlayCount - before.overlayCount);
  return {
    urlChanged: action.urlChanged && !ambient.urlChanged,
    domChanged: localChange(before, after, ambientBefore, ambientAfter, 'domFingerprint', action.domChanged, ambient.domChanged),
    ariaChanged: localChange(before, after, ambientBefore, ambientAfter, 'ariaFingerprint', action.ariaChanged, ambient.ariaChanged),
    styleChanged: localChange(before, after, ambientBefore, ambientAfter, 'styleFingerprint', action.styleChanged, ambient.styleChanged),
    structureChanged: localChange(before, after, ambientBefore, ambientAfter, 'structureFingerprint', action.structureChanged, ambient.structureChanged),
    overlayOpened: actionOverlayDelta > ambientOverlayDelta,
    networkObserved: hasNetworkBeyondAmbient(after.network, ambientAfter?.network),
    wholePage: {
      action,
      ambient,
    },
  };
}

async function localEffectSignature(locator) {
  if (!locator) return null;
  const snapshot = await locator.evaluate((element) => {
    const explicitRegion = element.closest('[data-control-region]');
    const parentRegion = element.parentElement && !['BODY', 'HTML'].includes(element.parentElement.tagName)
      ? element.parentElement
      : null;
    const semanticRegion = element.closest('main, section, article, form, nav, header, footer');
    const region = explicitRegion || parentRegion || semanticRegion || element;
    const roots = { control: element, region };
    const signature = (root) => {
      const descendants = [root, ...root.querySelectorAll('*')];
      const aria = descendants
        .filter((entry) => ['aria-expanded', 'aria-pressed', 'aria-selected', 'aria-checked', 'aria-hidden', 'aria-disabled', 'role'].some((name) => entry.hasAttribute?.(name)))
        .map((entry) => `${entry.tagName}:${entry.getAttribute('id') ?? ''}:${entry.getAttribute('role') ?? ''}:${entry.getAttribute('aria-expanded') ?? ''}:${entry.getAttribute('aria-pressed') ?? ''}:${entry.getAttribute('aria-selected') ?? ''}:${entry.getAttribute('aria-checked') ?? ''}:${entry.getAttribute('aria-hidden') ?? ''}:${entry.getAttribute('aria-disabled') ?? ''}`)
        .join('|');
      const style = descendants
        .filter((entry) => entry.hasAttribute?.('class') || entry.hasAttribute?.('style'))
        .map((entry) => `${entry.tagName}:${entry.getAttribute('class') ?? ''}:${entry.getAttribute('style') ?? ''}`)
        .join('|');
      const structure = descendants
        .filter((entry) => entry.matches?.('button, a, input, select, textarea, [role]'))
        .map((entry) => `${entry.tagName}:${entry.getAttribute('role') ?? ''}:${entry.getAttribute('aria-label') ?? ''}:${entry.children.length}`)
        .join('|');
      return {
        dom: root === element ? element.outerHTML : region.innerHTML,
        aria,
        style,
        structure,
      };
    };
    return {
      control: signature(roots.control),
      region: signature(roots.region),
    };
  }).catch(() => null);
  if (!snapshot) return null;
  const fingerprint = (entry) => ({
    domFingerprint: sha256(redactForPersistence(entry.dom)),
    ariaFingerprint: sha256(redactForPersistence(entry.aria)),
    styleFingerprint: sha256(redactForPersistence(entry.style)),
    structureFingerprint: sha256(redactForPersistence(entry.structure)),
  });
  return {
    control: fingerprint(snapshot.control),
    region: fingerprint(snapshot.region),
  };
}

export async function pageEffectSignature(page, network = { count: 0, requests: [] }, locator = null) {
  const snapshot = await page.evaluate(() => {
    const body = document.body;
    const html = body?.innerHTML ?? '';
    const aria = [...document.querySelectorAll('[aria-expanded], [aria-pressed], [aria-selected], [aria-hidden], [role="dialog"], [role="menu"]')]
      .map((element) => `${element.tagName}:${element.getAttribute('id') ?? ''}:${element.getAttribute('role') ?? ''}:${element.getAttribute('aria-expanded') ?? ''}:${element.getAttribute('aria-pressed') ?? ''}:${element.getAttribute('aria-selected') ?? ''}:${element.getAttribute('aria-hidden') ?? ''}`)
      .join('|');
    const style = [...document.querySelectorAll('[class], [style]')]
      .map((element) => `${element.tagName}:${element.className?.toString() ?? ''}:${element.getAttribute('style') ?? ''}`)
      .join('|');
    const structure = [...document.querySelectorAll('button, a, input, select, textarea, [role]')]
      .map((element) => `${element.tagName}:${element.getAttribute('role') ?? ''}:${element.getAttribute('aria-label') ?? ''}:${element.textContent?.trim() ?? ''}`)
      .join('|');
    return {
      url: location.href,
      dom: html,
      aria,
      style,
      structure,
      overlayCount: document.querySelectorAll('[role="dialog"], [role="menu"], dialog, [data-overlay="true"]').length,
      overlays: [...document.querySelectorAll('[role="dialog"], [role="menu"], dialog, [data-overlay="true"]')].map((element) => ({
        role: element.getAttribute('role') || element.tagName.toLowerCase(),
        name: (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').replace(/\s+/gu, ' ').trim().slice(0, 160),
        id: element.getAttribute('id'),
        testId: element.getAttribute('data-testid'),
      })),
    };
  });
  const local = await localEffectSignature(locator);
  return {
    url: safeUrl(snapshot.url),
    domFingerprint: sha256(redactForPersistence(snapshot.dom)),
    ariaFingerprint: sha256(redactForPersistence(snapshot.aria)),
    styleFingerprint: sha256(redactForPersistence(snapshot.style)),
    structureFingerprint: sha256(redactForPersistence(snapshot.structure)),
    overlayCount: snapshot.overlayCount,
    overlays: redactForPersistence(snapshot.overlays),
    network,
    local,
  };
}

async function describeControl(locator) {
  return locator.evaluate((element) => {
    const tag = element.tagName.toLowerCase();
    const explicitRole = element.getAttribute('role');
    const role = explicitRole || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag);
    const name = element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || element.getAttribute('placeholder') || element.getAttribute('name') || '';
    return {
      role,
      name: name.replace(/\s+/gu, ' ').trim().slice(0, 240),
      id: element.getAttribute('id'),
      selector: element.getAttribute('data-testid') ? `[data-testid="${element.getAttribute('data-testid')}"]` : null,
      controlClass: element.getAttribute('data-control-class') || 'default',
      href: element.getAttribute('href'),
      alreadyActive: element.getAttribute('aria-pressed') === 'true' || element.getAttribute('aria-selected') === 'true' || element.getAttribute('data-state') === 'active',
      structure: {
        tag,
        type: element.getAttribute('type'),
        parentTag: element.parentElement?.tagName.toLowerCase() ?? null,
        parentRole: element.parentElement?.getAttribute('role') ?? null,
        childElementCount: element.children.length,
      },
    };
  });
}

function semanticControlKey(description) {
  return JSON.stringify([
    description.role ?? 'unknown',
    safeText(description.name),
    description.controlClass ?? 'default',
  ]);
}

async function describeControls(page, selector) {
  const controls = page.locator(selector);
  const count = await controls.count();
  const occurrences = new Map();
  const descriptions = [];
  for (let index = 0; index < count; index += 1) {
    const locator = controls.nth(index);
    const description = await describeControl(locator).catch(() => ({ role: 'unknown', name: '', controlClass: 'default', href: null, selector: null, structure: null }));
    const key = semanticControlKey(description);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    descriptions.push({ ...description, index, occurrence, semanticKey: key });
  }
  return descriptions;
}

async function relocateControl(page, selector, expected) {
  const descriptions = await describeControls(page, selector);
  const match = descriptions.find((description) => description.semanticKey === expected.semanticKey && description.occurrence === expected.occurrence);
  if (!match) return null;
  return { locator: page.locator(selector).nth(match.index), description: match };
}

async function controlState(locator) {
  return locator.evaluate((element) => ({
    ariaState: {
      pressed: element.getAttribute('aria-pressed'),
      selected: element.getAttribute('aria-selected'),
      expanded: element.getAttribute('aria-expanded'),
      checked: element.getAttribute('aria-checked'),
      hidden: element.getAttribute('aria-hidden'),
      disabled: element.getAttribute('aria-disabled'),
    },
    className: element.getAttribute('class'),
    dataState: element.getAttribute('data-state'),
  }));
}

async function isDisabled(locator) {
  const ariaDisabled = await locator.getAttribute('aria-disabled').catch(() => null);
  if (ariaDisabled === 'true') return true;
  const nativeDisabled = await locator.evaluate((element) => {
    if ('disabled' in element && Boolean(element.disabled)) return true;
    return Boolean(element.closest('fieldset[disabled]'));
  }).catch(() => true);
  return nativeDisabled || !(await locator.isEnabled().catch(() => false));
}

async function storageStateWithIndexedDb(context) {
  try {
    return await context.storageState({ indexedDB: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/indexeddb|unknown option|unexpected option/iu.test(message)) throw error;
    return context.storageState();
  }
}

export async function auditDeadControls(page, {
  policy = {},
  target = 'clone',
  route = new URL(page.url()).pathname,
  selector = CONTROL_SELECTOR,
  effectWaitMs = 100,
  actionTimeout = 1500,
  validateTrial = null,
} = {}) {
  const baselineUrl = page.url();
  const browser = page.context().browser();
  if (!browser) throw new Error('Dead-control isolation requires a browser-backed Playwright context');
  const baselineStorageState = await storageStateWithIndexedDb(page.context());
  const baselineSessionStorage = await page.evaluate(() => Object.fromEntries(
    Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
      .filter(Boolean)
      .map((key) => [key, sessionStorage.getItem(key)]),
  ));
  const baselineOrigin = new URL(baselineUrl).origin;
  const baselineViewport = page.viewportSize();
  const descriptions = await describeControls(page, selector);
  const observations = [];
  for (const expected of descriptions) {
    const trialContext = await browser.newContext({
      storageState: baselineStorageState,
      ...(baselineViewport ? { viewport: baselineViewport } : {}),
    });
    try {
      await trialContext.addInitScript(({ origin, entries }) => {
        if (location.origin !== origin) return;
        for (const [key, value] of Object.entries(entries)) {
          if (value !== null) sessionStorage.setItem(key, value);
        }
      }, { origin: baselineOrigin, entries: baselineSessionStorage });
      const trialPage = await trialContext.newPage();
      const response = await trialPage.goto(baselineUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await trialPage.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      if (validateTrial) {
        let invalidReason = response && [401, 403].includes(response.status())
          ? `Source trial returned authentication status ${response.status()}`
          : null;
        if (!invalidReason) {
          try {
            const validation = await validateTrial(trialPage, { route, expected });
            if (typeof validation === 'string') invalidReason = validation;
            else if (validation && validation.valid === false) invalidReason = validation.reason ?? 'Source trial identity validation failed';
          } catch (error) {
            invalidReason = error instanceof Error ? error.message : String(error);
          }
        }
        if (invalidReason) {
          observations.push({
            route,
            index: expected.index,
            occurrence: expected.occurrence,
            role: expected.role,
            name: safeText(expected.name),
            controlClass: expected.controlClass,
            href: expected.href,
            structure: expected.structure,
            visible: false,
            enabled: false,
            category: 'trial-invalid',
            actionExecuted: false,
            trialInvalidReason: safeText(invalidReason),
          });
          continue;
        }
      }
      if (!response || response.status() >= 400) throw new Error(`Baseline route returned ${response?.status() ?? 'no response'}`);
      const relocated = await relocateControl(trialPage, selector, expected);
      const action = { route, role: expected.role, name: safeText(expected.name), selector: expected.selector, controlClass: expected.controlClass, occurrence: expected.occurrence };
      const decision = evaluateAction({ policy, target, action });
      if (!relocated) {
        observations.push({ route, index: expected.index, occurrence: expected.occurrence, role: expected.role, name: safeText(expected.name), controlClass: expected.controlClass, href: expected.href, structure: expected.structure, policy: decision, visible: false, enabled: false, category: 'unreachable', actionExecuted: false, actionabilityError: 'Exact control occurrence could not be re-located from the fresh baseline' });
        continue;
      }
      const { locator, description } = relocated;
      const visible = await locator.isVisible().catch(() => false);
      const disabled = await isDisabled(locator);
      const initialState = await controlState(locator).catch(() => null);
      const base = {
        route,
        index: expected.index,
        occurrence: expected.occurrence,
        role: description.role,
        name: safeText(description.name),
        controlClass: description.controlClass,
        href: description.href,
        structure: description.structure,
        ariaState: initialState?.ariaState ?? null,
        policy: decision,
        visible,
        enabled: !disabled,
      };
      if (!decision.allowed) {
        observations.push({ ...base, category: 'blocked-by-policy', actionExecuted: false });
        continue;
      }
      if (!visible) {
        observations.push({ ...base, category: 'unreachable', actionExecuted: false });
        continue;
      }
      if (disabled) {
        observations.push({ ...base, category: 'disabled', actionExecuted: false });
        continue;
      }
      if (description.alreadyActive) {
        observations.push({ ...base, category: 'already-active', actionExecuted: false });
        continue;
      }
      const ambientBefore = await pageEffectSignature(trialPage, { count: 0, requests: [] }, locator);
      const ambientRequests = [];
      const onAmbientRequest = (request) => {
        ambientRequests.push({ url: safeUrl(request.url()), method: request.method(), resourceType: request.resourceType() });
      };
      trialPage.on('request', onAmbientRequest);
      await trialPage.waitForTimeout(effectWaitMs);
      trialPage.off('request', onAmbientRequest);
      const ambientNetwork = { count: ambientRequests.length, requests: ambientRequests };
      const ambientAfter = await pageEffectSignature(trialPage, ambientNetwork, locator);
      const before = await pageEffectSignature(trialPage, { count: 0, requests: [] }, locator);
      try {
        await locator.click({ trial: true, timeout: actionTimeout });
      } catch (error) {
        observations.push({ ...base, category: 'unreachable', actionExecuted: false, actionabilityError: safeText(error.message) });
        continue;
      }
      const requests = [];
      const onRequest = (request) => {
        requests.push({ url: safeUrl(request.url()), method: request.method(), resourceType: request.resourceType() });
      };
      trialPage.on('request', onRequest);
      let clickError = null;
      try {
        await locator.click({ timeout: actionTimeout });
        await trialPage.waitForTimeout(effectWaitMs);
      } catch (error) {
        clickError = safeText(error.message);
      } finally {
        trialPage.off('request', onRequest);
      }
      const network = { count: requests.length, requests };
      const after = await pageEffectSignature(trialPage, network, locator).catch(() => ({ ...before, network, local: null }));
      const finalState = await controlState(locator).catch(() => null);
      const effect = compareEffectSignatures(before, after, { ambientBefore, ambientAfter });
      const category = clickError
        ? 'unreachable'
        : classifyControl({ actionability: 'reachable', disabled: false, policyOutcome: decision.outcome, after: effect, alreadyActive: description.alreadyActive });
      observations.push({ ...base, category, actionExecuted: !clickError, effect, ...(clickError ? { actionabilityError: clickError } : {}), evidence: { ambientBefore, ambientAfter, before, after, controlBefore: initialState, controlAfter: finalState } });
    } finally {
      await trialContext.close().catch(() => {});
    }
  }
  return {
    schemaVersion: 1,
    kind: 'dead-control-audit',
    route,
    controlCount: observations.length,
    classifiedCount: observations.filter((observation) => observation.category !== 'trial-invalid').length,
    trialInvalidCount: observations.filter((observation) => observation.category === 'trial-invalid').length,
    observations,
    findings: observations.filter((observation) => observation.category === 'dead').map((observation) => ({
      category: 'dead-control',
      subject: {
        route: observation.route,
        role: observation.role,
        name: observation.name,
        controlClass: observation.controlClass,
        occurrence: observation.occurrence,
      },
      route: observation.route,
      role: observation.role,
      name: observation.name,
      index: observation.index,
      occurrence: observation.occurrence,
      status: 'open',
    })),
  };
}
