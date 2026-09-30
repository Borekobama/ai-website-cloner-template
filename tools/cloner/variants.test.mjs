import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditDeadRuntimeClasses, deadClassDetail, splitVariantClass } from './audits/dead-classes.mjs';

test('variant splitting keeps arbitrary values intact', () => {
  assert.deepEqual(splitVariantClass('data-[state=open]:bg-red-500'), { variants: ['data-[state=open]'], utility: 'bg-red-500' });
  assert.deepEqual(splitVariantClass('md:hover:!opacity-50'), { variants: ['md', 'hover'], utility: 'opacity-50' });
  assert.deepEqual(splitVariantClass('[&>*]:p-2'), { variants: ['[&>*]'], utility: 'p-2' });
  assert.equal(splitVariantClass('plain'), null);
  assert.equal(splitVariantClass('broken:'), null);
});

test('dead variant classes explain whether the variant or the class is missing', () => {
  const compiled = new Set(['opacity-50', 'bg-red-500', 'hover:underline']);
  assert.deepEqual(deadClassDetail('disabled-state:opacity-50', compiled), { className: 'disabled-state:opacity-50', reason: 'undefined-variant', variants: ['disabled-state'], utility: 'opacity-50' });
  assert.equal(deadClassDetail('hover:bg-red-500', compiled).reason, 'variant-class-not-generated');
  assert.equal(deadClassDetail('phantom', compiled).reason, 'missing-css');
  const audit = auditDeadRuntimeClasses([{ route: '/home', runtimeClasses: ['opacity-50', 'aria-busy:opacity-50'], compiledClasses: ['opacity-50'] }]);
  assert.deepEqual(audit.findings.map((finding) => [finding.subject.className, finding.detail.reason]), [['aria-busy:opacity-50', 'undefined-variant']]);
});
