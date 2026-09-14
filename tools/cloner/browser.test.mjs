import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser } from './browser.mjs';

test('browser launch falls back to installed Chrome when bundled ICU data is inaccessible', async () => {
  if (process.platform !== 'darwin') return;
  const root = mkdtempSync(join(tmpdir(), 'cloner-browser-'));
  const broken = join(root, 'broken-chromium');
  writeFileSync(broken, '#!/bin/sh\necho "icudtl.dat not found in bundle" >&2\nexit 1\n');
  chmodSync(broken, 0o700);
  try {
    const browser = await launchBrowser({ headless: true, executablePath: broken });
    assert.ok((await browser.version()).length > 0);
    await browser.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
