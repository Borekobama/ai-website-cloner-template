#!/usr/bin/env node

/**
 * Generates clone-website command/skill files for all supported AI coding platforms.
 * Source of truth: .claude/skills/clone-website/SKILL.md
 *
 * Usage: node scripts/sync-skills.mjs
 */

import { readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, '.claude', 'skills', 'clone-website', 'SKILL.md');

// --- Parse source skill ---

let raw;
try {
  raw = readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');
} catch {
  console.error(`Error: Source skill not found at .claude/skills/clone-website/SKILL.md`);
  process.exit(1);
}

const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
if (!match) {
  console.error('Error: Could not parse SKILL.md frontmatter');
  process.exit(1);
}

const body = match[2];
const shortDesc = 'Reverse-engineer and clone one or more websites as pixel-perfect replicas';

// --- Helpers ---

function write(relPath, content) {
  const full = join(ROOT, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
  console.log(`  \u2713 ${relPath}`);
}

const HEADER =
  '<!-- AUTO-GENERATED from .claude/skills/clone-website/SKILL.md \u2014 do not edit directly.\n' +
  '     Run `node scripts/sync-skills.mjs` to regenerate. -->\n\n';

const noArgs = (text) => text.replace(/\$ARGUMENTS/g, 'the target URL or URLs provided by the user');

const agentSkill = (text) =>
  `---\nname: clone-website\ndescription: "${shortDesc}"\n---\n${noArgs(text)}`;

// --- Generate ---

console.log('Syncing clone-website skill to all platforms...');
console.log(`  Source: .claude/skills/clone-website/SKILL.md\n`);

// 1. Codex CLI — same SKILL.md format, same $ARGUMENTS syntax
write('.codex/skills/clone-website/SKILL.md', raw);

// 2. GitHub Copilot — same SKILL.md format
write('.github/skills/clone-website/SKILL.md', raw);

// 3. Kiro — same SKILL.md format and $ARGUMENTS syntax
write('.kiro/skills/clone-website/SKILL.md', raw);

// 4. Cline — Agent Skills format without Claude-only frontmatter/placeholders
write('.cline/skills/clone-website/SKILL.md', agentSkill(body));

// 5. Roo Code — standards-compliant Agent Skill plus a slash-command entry point
write('.roo/skills/clone-website/SKILL.md', agentSkill(body));
write(
  '.roo/commands/clone-website.md',
  `---\ndescription: "${shortDesc}"\nargument-hint: "<url1> [<url2> ...]"\n---\n` +
    HEADER +
    'Use the `clone-website` skill for the target URL or URLs provided by the user. ' +
    'Load that skill and follow its workflow exactly.\n'
);

// 6. Cursor — plain markdown, no argument substitution support
write('.cursor/commands/clone-website.md', HEADER + noArgs(body));

// 7. Windsurf — markdown workflow
write('.windsurf/workflows/clone-website.md', HEADER + noArgs(body));

// 8. Gemini CLI — TOML format, {{args}} for arguments
const geminiBody = body.replace(/\$ARGUMENTS/g, '{{args}}');
write(
  '.gemini/commands/clone-website.toml',
  `# AUTO-GENERATED from .claude/skills/clone-website/SKILL.md\n` +
    `# Run \`node scripts/sync-skills.mjs\` to regenerate.\n\n` +
    `description = "${shortDesc}"\n` +
    `name = "clone-website"\n\n` +
    `prompt = '''\n${geminiBody}\n'''\n`
);

// 9. OpenCode — markdown + YAML frontmatter, $ARGUMENTS works natively
write(
  '.opencode/commands/clone-website.md',
  `---\ndescription: "${shortDesc}"\n---\n${HEADER}${body}`
);

// 10. Augment Code — markdown + YAML frontmatter
write(
  '.augment/commands/clone-website.md',
  `---\ndescription: "${shortDesc}"\nargument-hint: "<url1> [<url2> ...]"\n---\n${HEADER}${body}`
);

// 11. Continue — prompt file with invokable: true
write(
  '.continue/commands/clone-website.md',
  `---\nname: clone-website\ndescription: "${shortDesc}"\ninvokable: true\n---\n${HEADER}${body}`
);

// 12. Amazon Q — JSON agent definition
write(
  '.amazonq/cli-agents/clone-website.json',
  JSON.stringify(
    {
      name: 'clone-website',
      description: shortDesc,
      prompt: noArgs(body),
      fileContext: ['AGENTS.md', 'docs/research/**'],
    },
    null,
    2
  ) + '\n'
);

// 13. Portable skill — a self-contained launcher plus the version-matched cloner
//     runtime, for global skill managers that install skills outside this repo.
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const LOCK = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
const RUNTIME_DEPENDENCIES = ['pixelmatch', 'playwright', 'pngjs'];
const PORTABLE_DIR = 'skills/clone-website';
const RUNTIME_DIR = `${PORTABLE_DIR}/runtime/${PACKAGE.version}`;
const RUNTIME_NAME = '@borekobama/clone-website-runtime';

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function replaceOnce(text, find, replacement) {
  const count = text.split(find).length - 1;
  if (count !== 1) fail(`portable skill anchor must match exactly once (found ${count}): ${find.split('\n')[0]}`);
  return text.replace(find, () => replacement);
}

// The portable skill runs the bundled launcher instead of the repository's
// npm script. Every anchor must still exist in the source skill, so editing one
// of these paragraphs fails the sync (and CI) until this mapping is updated.
function portableSkill(text, version) {
  const rules = [
    ['modes, with an automatic capability check:\n', 'modes:\n'],
    [
      'If the current repository has the cloner CLI, run the full parity workflow. If\nit does not, continue bootstrap or extraction work without pretending that\nparity evidence exists. Report the result as `extraction-only`.\n',
      'This skill bundles a versioned cloner runtime. Its launcher installs pinned Node\ndependencies and Chromium once in the shared Skills Manager cache, then reuses\nthat runtime from every repository while writing evidence into the current\nrepository.\n',
    ],
    [
      'For **Bootstrap**, also read `docs/research/CLONE_BOOTSTRAP_REFERENCE.md` before\n',
      'For **Bootstrap**, also read\n`references/CLONE_BOOTSTRAP_REFERENCE.md` relative to this skill before\n',
    ],
    [
      "- Detect the repository-owned parity CLI before measurement:\n  `npm run cloner -- help`. Use it as the authoritative measurement path when\n  available. If the script or `tools/cloner/` is missing, do not install or\n  copy a large runtime silently. Use Browser MCP or the repository's existing\n  Playwright tests for reconnaissance/build verification, and label the result\n  `extraction-only` with parity evidence unavailable.\n",
      "- Use this skill's bundled `scripts/cloner.mjs` launcher for authoritative\n  measurements. Resolve the launcher relative to the loaded `SKILL.md`; do not\n  require or copy `tools/cloner/` into the target repository.\n",
    ],
    ['- Run `npm run cloner -- selftest` before trusting a new instrument.', '- Run the bundled launcher with `selftest` before trusting a new instrument.'],
    [
      'The installed CLI help is the version-matched command contract. Read it before\nusing a command or guessing an option:\n\n```bash\nnpm run cloner -- help\nnpm run cloner -- selftest\n```\n',
      `Resolve \`<skill-root>\` from this loaded \`SKILL.md\`, then use the shared launcher.\nThe launcher installs runtime v${version} once under\n\`~/.skills-manager/runtime-cache/clone-website/${version}/\`. The installed CLI help\nis the version-matched command contract:\n\n\`\`\`bash\nCLONER_LAUNCHER="<skill-root>/scripts/cloner.mjs"\nnode "$CLONER_LAUNCHER" help\nnode "$CLONER_LAUNCHER" selftest\n\`\`\`\n`,
    ],
    [
      '### Capability detection\n\nRun this before parity commands:\n\n```bash\nnode -e \'const p=require("./package.json"); if (!p.scripts?.cloner) process.exit(1)\'\ntest -f tools/cloner/cli.mjs\n```\n\nWhen either check fails, skip `measure`, `audit`, `diff`, and `findings` CLI\ncommands. Do not add `tools/cloner/` or change package scripts unless the user\nexplicitly requests full parity support in that repository. Continue the\nrequested clone using available browser and test tooling, then report:\n\n```text\nmode: extraction-only\nparity CLI: unavailable\nimmutable parity evidence: not produced\n```\n\n',
      'If first-use dependency installation fails, report its exact command and error.\nContinue as `extraction-only` only when the requested clone can still be safely\ncompleted with available browser/test tooling. Never claim immutable parity\nevidence when the launcher did not run.\n\n',
    ],
    ['in `docs/research/CLONE_BOOTSTRAP_REFERENCE.md`. Follow its', "in this skill's `references/CLONE_BOOTSTRAP_REFERENCE.md`. Follow its"],
    ['When capability detection passes, after bootstrap assembly or during every\nrevisit:\n', 'After bootstrap assembly, or during every revisit:\n'],
    ['When capability detection fails, do not run these commands. Complete the clone\nor component extraction with available browser/test tooling and include the\nextraction-only status in the completion report.\n\n', ''],
  ];
  let output = text;
  for (const [find, replacement] of rules) output = replaceOnce(output, find, replacement);
  return portableReference(output)
    .replaceAll('`docs/research/SCREENSHOT_MODE_REFERENCE.md`', "this skill's `references/SCREENSHOT_MODE_REFERENCE.md`")
    .replaceAll('`docs/research/templates/`', "this skill's `references/templates/`");
}

// Commands in portable documents run through the bundled launcher.
function portableReference(text) {
  return text.replaceAll('npm run cloner -- ', 'node "$CLONER_LAUNCHER" ');
}

// Runtime modules only: tests, fixtures, the integration harness, and the
// launcher source stay in the repository.
function runtimeFiles(directory = join(ROOT, 'tools', 'cloner'), prefix = '') {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const relativePath = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        return ['fixtures', 'portable', 'test-app'].includes(entry.name) ? [] : runtimeFiles(join(directory, entry.name), `${relativePath}/`);
      }
      return entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs') && entry.name !== 'integration.mjs' ? [relativePath] : [];
    });
}

// Pins the runtime to the exact versions this repository tested, copied from
// its lockfile so generation needs no network access.
function runtimePackage() {
  const dependencies = Object.fromEntries(RUNTIME_DEPENDENCIES.map((name) => {
    const entry = LOCK.packages[`node_modules/${name}`];
    if (!entry) fail(`${name} is missing from package-lock.json`);
    return [name, entry.version];
  }));
  const manifest = { name: RUNTIME_NAME, version: PACKAGE.version, private: true, type: 'module', engines: { node: '>=24' }, dependencies };
  const packages = {};
  const visit = (name) => {
    const key = `node_modules/${name}`;
    if (packages[key]) return;
    const entry = { ...LOCK.packages[key] };
    if (!LOCK.packages[key]) fail(`${name} is missing from package-lock.json`);
    delete entry.dev;
    delete entry.devOptional;
    packages[key] = entry;
    for (const child of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) visit(child);
  };
  RUNTIME_DEPENDENCIES.forEach(visit);
  const lockfile = {
    name: RUNTIME_NAME,
    version: PACKAGE.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: RUNTIME_NAME, version: PACKAGE.version, dependencies, engines: { node: '>=24' } },
      ...Object.fromEntries(Object.entries(packages).sort(([left], [right]) => left.localeCompare(right))),
    },
  };
  return { manifest, lockfile };
}

rmSync(join(ROOT, PORTABLE_DIR), { recursive: true, force: true });
write(`${PORTABLE_DIR}/SKILL.md`, portableSkill(raw, PACKAGE.version));
write(`${PORTABLE_DIR}/references/CLONE_BOOTSTRAP_REFERENCE.md`, readFileSync(join(ROOT, 'docs', 'research', 'CLONE_BOOTSTRAP_REFERENCE.md'), 'utf8'));
write(`${PORTABLE_DIR}/references/SCREENSHOT_MODE_REFERENCE.md`, portableReference(readFileSync(join(ROOT, 'docs', 'research', 'SCREENSHOT_MODE_REFERENCE.md'), 'utf8')));
for (const template of readdirSync(join(ROOT, 'docs', 'research', 'templates')).sort()) {
  write(`${PORTABLE_DIR}/references/templates/${template}`, portableReference(readFileSync(join(ROOT, 'docs', 'research', 'templates', template), 'utf8')));
}
write(`${PORTABLE_DIR}/scripts/cloner.mjs`, readFileSync(join(ROOT, 'tools', 'cloner', 'portable', 'launcher.mjs'), 'utf8'));
const runtime = runtimePackage();
const modules = runtimeFiles();
for (const file of modules) {
  const target = join(ROOT, RUNTIME_DIR, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(join(ROOT, 'tools', 'cloner', file), 'utf8'), 'utf8');
}
writeFileSync(join(ROOT, RUNTIME_DIR, 'package.json'), `${JSON.stringify(runtime.manifest, null, 2)}\n`, 'utf8');
writeFileSync(join(ROOT, RUNTIME_DIR, 'package-lock.json'), `${JSON.stringify(runtime.lockfile, null, 2)}\n`, 'utf8');
console.log(`  ✓ ${RUNTIME_DIR}/ (${modules.length} modules, package.json, package-lock.json)`);

console.log('\nDone! 13 platform command/skill files and the portable skill generated from source skill.');
