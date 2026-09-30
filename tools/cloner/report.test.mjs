import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyAssetRights } from './asset-rights.mjs';
import { renderReportHtml } from './report-html.mjs';

test('HTML report escapes page-derived values and links private evidence relatively', () => {
  const html = renderReportHtml({
    sourceRunId: '20260914T000001Z_source_11111111',
    cloneRunId: '20260914T000002Z_clone_22222222',
    semantics: { parity: 'Parity findings identify source-vs-clone mismatches.' },
    visualCoverage: { configured: true, complete: true, regionsCompared: 1 },
    findings: [
      {
        category: 'visual-region-mismatch',
        status: 'open',
        subject: { route: '/home', regionId: 'chrome' },
        comparator: { instrument: 'visual-region', dimension: 'pixels', mode: 'gate' },
        observed: { title: '<script>alert(1)</script>' },
        evidence: {
          source: { runId: '20260914T000001Z_source_11111111', artifact: 'measurements/visual-regions/home/chrome.source.png', locator: '#' },
          clone: { runId: '20260914T000002Z_clone_22222222', artifact: 'measurements/visual-regions/home/chrome.clone.png', locator: '#' },
          diff: { runId: '20260914T000003Z_diff_33333333', artifact: 'visual-diffs/home/chrome.diff.png', locator: '#' },
        },
      },
      { category: 'aria-name-mismatch', status: 'informational', subject: { route: '/about' }, comparator: { instrument: 'aria' } },
    ],
  }, { reportRunId: '20260914T000003Z_diff_33333333' });
  assert.doesNotMatch(html, /<script/iu);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(html, /src="\.\.\/20260914T000001Z_source_11111111\/measurements\/visual-regions\/home\/chrome\.source\.png"/u);
  assert.match(html, /src="\.\.\/20260914T000003Z_diff_33333333\/visual-diffs\/home\/chrome\.diff\.png"/u);
  assert.match(html, /1 gate, 1 informational/u);
  assert.ok(html.indexOf('/about') < html.indexOf('/home'), 'routes are grouped in a stable order');
});

test('asset rights classify licence-sensitive assets without judging them', () => {
  const asset = (finalUrl, resourceType, mime) => ({ finalUrl, resourceType, mime, bytes: 10 });
  const rights = classifyAssetRights({
    complete: true,
    routes: [{
      observation: {
        route: '/home',
        assets: [
          asset('https://example.test/logo.svg', 'image', 'image/svg+xml'),
          asset('https://example.test/fonts/brand.woff2', 'font', 'font/woff2'),
          asset('https://fonts.gstatic.com/s/inter/v1/a.woff2', 'font', 'font/woff2'),
          asset('https://use.typekit.net/abc/1.woff2', 'font', 'font/woff2'),
          asset('https://images.cdn.example/photo.jpg', 'image', 'image/jpeg'),
          asset('https://example.test/app.js', 'script', 'text/javascript'),
        ],
      },
    }],
  }, { origin: 'https://example.test/home' });
  assert.deepEqual(rights.summary, { 'adobe-fonts': 1, 'google-fonts': 1, 'source-hosted-font': 1, 'source-owned': 1, 'third-party': 1 });
  assert.equal(rights.informational, true);
  assert.equal(rights.assets.some((entry) => entry.url.endsWith('app.js')), false, 'code is rebuilt, not reused, so it is not listed');
});
