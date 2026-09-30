import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { compareHeadEvidence, normalizeHeadObservation, routesFromSitemap } from './head.mjs';

const RAW = {
  lang: 'EN',
  title: '  Home  |  Example ',
  description: 'Welcome\n  home',
  robots: 'Index, Follow',
  canonical: 'https://example.test/home?ref=nav',
  alternates: [{ hreflang: 'de', href: 'https://example.test/de/home' }],
  og: { 'og:image': ['https://cdn.example.test/og.png'], 'og:title': ['Home'] },
  twitter: {},
  jsonLd: ['{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":["Organization","Brand"]}]}', '{not json'],
  icons: [{ rel: 'icon', href: 'https://example.test/favicon.ico', sizes: null, type: null }],
  viewport: 'width=device-width, initial-scale=1',
  themeColor: null,
};

test('head metadata normalizes origins away and keeps structured-data types', () => {
  const { fields, jsonLd } = normalizeHeadObservation(RAW);
  assert.equal(fields.title, 'Home | Example');
  assert.equal(fields.description, 'Welcome home');
  assert.equal(fields.robots, 'index,follow');
  assert.equal(fields.canonical, '/home?ref=nav');
  assert.equal(fields.lang, 'en');
  assert.deepEqual(fields.hreflang, ['de→/de/home']);
  assert.deepEqual(fields.structuredData, ['<invalid-json-ld>', 'Brand', 'Organization', 'WebPage']);
  assert.deepEqual(fields.social['og:image'], ['/og.png']);
  assert.equal(jsonLd.filter((entry) => entry.valid).length, 1);
});

test('head comparison gates indexing fields and keeps social previews informational', () => {
  const source = normalizeHeadObservation(RAW).fields;
  const clone = { ...source, description: null, social: { ...source.social, 'og:title': ['Other'] } };
  const index = (fields) => ({ complete: true, routes: [{ route: '/home', complete: true, fields }] });
  const report = compareHeadEvidence(index(source), index(clone), '20260914T000001Z_source_11111111', '20260914T000002Z_clone_22222222');
  assert.deepEqual(report.findings.map((finding) => [finding.category, finding.status]), [['head-description-mismatch', 'open'], ['head-social-mismatch', 'informational']]);
  assert.equal(report.findings[0].evidence.clone.locator, '#/routes/0/fields/description');
  assert.equal(report.coverage.complete, true);
  assert.equal(compareHeadEvidence(index(source), index(source), '20260914T000001Z_source_11111111', '20260914T000002Z_clone_22222222').findings.length, 0);
});

test('sitemap routes follow same-origin indexes, gzip, and route limits', async () => {
  const origin = 'https://example.test';
  const documents = new Map([
    [`${origin}/sitemap.xml`, `<?xml version="1.0"?><sitemapindex><sitemap><loc>${origin}/pages.xml.gz</loc></sitemap><sitemap><loc>https://other.test/x.xml</loc></sitemap></sitemapindex>`],
    [`${origin}/pages.xml.gz`, gzipSync(`<urlset><url><loc>${origin}/home</loc></url><url><loc>${origin}/search?q=a&amp;b=c</loc></url><url><loc>https://other.test/away</loc></url><url><loc>${origin}/home</loc></url><url><loc>${origin}/extra</loc></url></urlset>`)],
  ]);
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    const body = documents.get(url);
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(body, { status: 200 });
  };
  const result = await routesFromSitemap(`${origin}/start`, { fetchImpl, maxRoutes: 2 });
  assert.deepEqual(result.routes, ['/home', '/search?q=a&b=c']);
  assert.equal(result.source.kind, 'sitemap');
  assert.equal(result.source.truncated, true);
  assert.deepEqual(requested, [`${origin}/sitemap.xml`, `${origin}/pages.xml.gz`]);
  await assert.rejects(() => routesFromSitemap(origin, { fetchImpl, sitemapUrl: 'https://other.test/sitemap.xml' }), /target origin/);
});
