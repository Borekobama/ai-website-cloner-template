import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { auditCloneCode } from './clone-code.mjs';

function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'cloner-code-test-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, module: 'esnext', moduleResolution: 'bundler', target: 'es2020', types: [] },
    include: ['src/**/*.ts'],
  }));
  writeFileSync(join(root, 'src', 'hooks.ts'), [
    'export function useState<T>(value: T): [T, (next: T) => void] { return [value, () => {}]; }',
    'export function useReducer<S, A>(reducer: (state: S, action: A) => S, initial: S): [S, (action: A) => void] { void reducer; return [initial, () => {}]; }',
    '',
  ].join('\n'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, 'src', name), content);
  return root;
}

test('clone code audit finds state that is set but never read', () => {
  const root = project({
    'panel.ts': [
      "import { useReducer, useState } from './hooks';",
      'export function Panel() {',
      '  const [open, setOpen] = useState(false);',
      "  const [, setMode] = useState('list');",
      '  const [count] = useState(0);',
      '  const [total, dispatch] = useReducer((state: number, step: number) => state + step, 0);',
      "  setOpen(true); setMode('grid'); dispatch(1);",
      '  return count;',
      '}',
      '',
    ].join('\n'),
  });
  try {
    const audit = auditCloneCode({ root });
    assert.equal(audit.complete, true);
    assert.deepEqual(audit.findings.map((finding) => [finding.subject.value, finding.subject.setter, finding.reason]), [
      ['open', 'setOpen', 'value-never-read'],
      [null, 'setMode', 'value-omitted'],
      ['total', 'dispatch', 'value-never-read'],
    ]);
    assert.ok(audit.findings.every((finding) => finding.subject.file === 'src/panel.ts' && finding.subject.component === 'Panel'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clone code audit compares registries only when they share a mapped key domain', () => {
  const root = project({
    'tiles.ts': [
      "type Tile = 'chart' | 'table' | 'note' | 'image';",
      "export const RENDERERS: Record<Tile, string> = { chart: 'C', table: 'T', note: 'N', image: 'I' };",
      'export const ACTIONS: Partial<Record<Tile, () => void>> = { chart: () => {}, table: () => {} };',
      "export const STYLE: { color?: string; margin?: string } = { color: 'red' };",
      "export const OTHER: { color?: string; margin?: string } = { margin: '0' };",
      '',
    ].join('\n'),
  });
  try {
    const audit = auditCloneCode({ root });
    assert.equal(audit.registriesAnalyzed, 2, 'plain object types are not registries');
    assert.equal(audit.findings.length, 1);
    assert.equal(audit.findings[0].category, 'registry-key-mismatch');
    assert.equal(audit.findings[0].subject.registry, 'src/tiles.ts#ACTIONS');
    assert.deepEqual(audit.findings[0].observed.missing, ['image', 'note']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
