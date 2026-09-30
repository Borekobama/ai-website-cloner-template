import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from './args.mjs';

test('inline option values keep every character after the first equals sign', () => {
  const options = parseArgs(['measure', '--url=https://example.test/home?tab=a&view=b', '--hydration-selector=[data-state="open"]']);
  assert.equal(options.command, 'measure');
  assert.equal(options.url, 'https://example.test/home?tab=a&view=b');
  assert.equal(options['hydration-selector'], '[data-state="open"]');
});

test('space-separated values, boolean flags, and positionals parse as before', () => {
  const options = parseArgs(['audit', 'dead-controls', '--run', '20260914T120000Z_clone_89abcdef', '--inventory', '--sitemap', '--target', 'clone']);
  assert.deepEqual(options._, ['dead-controls']);
  assert.equal(options.run, '20260914T120000Z_clone_89abcdef');
  assert.equal(options.inventory, true);
  assert.equal(options.sitemap, true);
  assert.equal(options.target, 'clone');
  assert.equal(parseArgs([]).command, 'help');
});
