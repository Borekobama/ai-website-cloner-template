import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ariaOutline, ariaRoleCounts, compareAriaEvidence, parseAriaSnapshot } from './aria.mjs';

const SNAPSHOT = `- banner:
  - navigation "Main":
    - link "A link":
      - /url: /a
- main:
  - 'heading "Price: $5 \\"quoted\\" it''s" [level=1]'
  - heading "Sub" [level=2]
  - button "Toggle" [pressed]
  - 'link "Link #1 - test"':
    - /url: /x?y=1
  - textbox "Search here": typed secret
  - list:
    - listitem: One
    - listitem: Two
- contentinfo: Foot`;

test('aria snapshot parsing handles YAML quoting, attributes, and editable values', () => {
  const nodes = parseAriaSnapshot(SNAPSHOT);
  const heading = nodes.find((node) => node.role === 'heading' && node.attributes.level === '1');
  assert.equal(heading.name, 'Price: $5 "quoted" it\'s');
  assert.equal(nodes.find((node) => node.role === 'button').attributes.pressed, true);
  assert.equal(nodes.find((node) => node.role === 'link' && node.name === 'Link #1 - test').depth, 1);
  assert.equal(nodes.find((node) => node.role === 'textbox').text, null, 'editable values must not be persisted');
  assert.equal(nodes.find((node) => node.role === 'contentinfo').text, 'Foot');
  assert.equal(nodes.some((node) => node.role.startsWith('/')), false);
  assert.deepEqual(ariaOutline(nodes).map((entry) => (entry.role === 'heading' ? `h${entry.level}` : entry.role)), ['banner', 'navigation', 'main', 'h1', 'h2', 'contentinfo']);
  assert.equal(ariaRoleCounts(nodes).listitem, 2);
});

function index(route, outline, roleCounts = { main: 1 }) {
  return { complete: true, routes: [{ route, complete: true, outline, roleCounts }] };
}

test('aria comparison gates outline shape and keeps names and role counts informational', () => {
  const source = index('/home', [{ role: 'main', name: null }, { role: 'heading', level: 1, name: 'Home' }]);
  const reordered = index('/home', [{ role: 'heading', level: 1, name: 'Home' }, { role: 'main', name: null }]);
  const renamed = index('/home', [{ role: 'main', name: null }, { role: 'heading', level: 1, name: 'Start' }], { main: 1, button: 2 });
  const outline = compareAriaEvidence(source, reordered, '20260914T000001Z_source_11111111', '20260914T000002Z_clone_22222222');
  assert.deepEqual(outline.findings.map((finding) => [finding.category, finding.status]), [['aria-outline-mismatch', 'open']]);
  const names = compareAriaEvidence(source, renamed, '20260914T000001Z_source_11111111', '20260914T000002Z_clone_22222222');
  assert.deepEqual(names.findings.map((finding) => [finding.category, finding.status]), [['aria-name-mismatch', 'informational'], ['aria-role-count-mismatch', 'informational']]);
  assert.equal(names.coverage.complete, true);
  const oneSided = compareAriaEvidence(source, null, '20260914T000001Z_source_11111111', '20260914T000002Z_clone_22222222');
  assert.equal(oneSided.findings[0].category, 'aria-incomplete');
  assert.equal(oneSided.coverage.complete, false);
});
