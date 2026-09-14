<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Website Reverse-Engineer Template

## What This Is
A reusable template for reverse-engineering any website into a clean, modern Next.js codebase using AI coding agents. The Next.js + shadcn/ui + Tailwind v4 base is pre-scaffolded — just run `/clone-website <url1> [<url2> ...]`.

## Tech Stack
- **Framework:** Next.js 16 (App Router, React 19, TypeScript strict)
- **UI:** shadcn/ui (Base UI primitives, Tailwind CSS v4, `cn()` utility)
- **Icons:** Lucide React (default — will be replaced/supplemented by extracted SVGs)
- **Styling:** Tailwind CSS v4 with oklch design tokens
- **Deployment:** Vercel

## Commands
- `npm run dev` — Start dev server
- `npm run build` — Production build
- `npm run lint` — ESLint check
- `npm run typecheck` — TypeScript check
- `npm run check` — Run lint + typecheck + build

## Code Style
- TypeScript strict mode, no `any`
- Named exports, PascalCase components, camelCase utils
- Tailwind utility classes, no inline styles
- 2-space indentation
- Responsive: mobile-first

## Design Principles
- **Pixel-perfect emulation** — match the target's spacing, colors, typography exactly
- **No personal aesthetic changes during emulation phase** — match 1:1 first, customize later
- **Real content** — use actual text and assets from the target site, not placeholders
- **Beauty-first** — every pixel matters

## Project Structure
```
src/
  app/              # Next.js routes
  components/       # React components
    sites/<site-key>/
      shared/        # Shared same-site reconstructed UI
      <page-key>/    # Page-specific reconstructed UI
    ui/             # shadcn/ui primitives
    icons.tsx       # Extracted SVG icons as React components
  lib/
    utils.ts        # cn() utility (shadcn)
  types/            # TypeScript interfaces
  hooks/            # Custom React hooks
public/
  sites/<site-key>/
    shared/          # Shared same-site assets
    <page-key>/      # Page-specific assets
docs/
  research/<site-key>/<page-key>/ # Namespaced inspection output and component specs
  research/<site-key>/_parity/    # Immutable runs, reports, and findings ledger
  design-references/<site-key>/<page-key>/ # Namespaced screenshots and visual references
scripts/            # Asset download scripts
```

## MOST IMPORTANT NOTES
- When launching Claude Code agent teams, ALWAYS have each teammate work in their own worktree branch and merge everyone's work at the end, resolving any merge conflicts smartly since you are basically serving the orchestrator role and have full context to our goals, work given, work achieved, and desired outcomes.
- After editing `AGENTS.md`, run `bash scripts/sync-agent-rules.sh` to regenerate platform-specific instruction files.
- After editing `.claude/skills/clone-website/SKILL.md`, run `node scripts/sync-skills.mjs` to regenerate the skill for all platforms.

## Parity workflow (v0.12.1)

The repository-owned parity spine lives under `tools/cloner/` and is invoked
with `npm run cloner -- <command>`. Use `npm run cloner -- help` as the exact,
installed command reference. The normal flow is:

```text
measure → immutable run → audit dead-controls/dead-classes → diff → repair → measure again
```

Each measurement creates a new run under
`docs/research/<site-key>/_parity/runs/<run-id>/`. Closed and failed runs are
immutable. `current` is only a convenience ref; findings and reports must
always store the resolved concrete run ID. A subset run must identify its
inventory provenance and must not replace a broader run. Only an explicit
`measure --inventory` run defines an authoritative denominator and may advance
`source-current` or `clone-current`; ordinary measurements remain `ad-hoc`, and
`--inventory-run` measurements retain that inventory's denominator without
promoting themselves.

Source interactions require an explicit safe-action policy in
`parity-exceptions.json`; blocked controls may be inventoried but must not be
executed. Browser observations are redacted before serialization and hashing.
Keep authenticated profiles in `.cloner-profiles/` and never commit them.

For durable revisit commands, resolve and preserve concrete immutable IDs from
the measurement output instead of leaving `current` in reports:

```bash
SOURCE_RUN=20260914T120000Z_source_0123abcd
CLONE_RUN=20260914T120100Z_clone_89abcdef
npm run cloner -- audit dead-controls --site example.test-01234567 --target source --run "$SOURCE_RUN" --profile .cloner-profiles/primary
SOURCE_AUDIT=20260914T120200Z_audit-controls_2345bcde
npm run cloner -- audit dead-controls --site example.test-01234567 --target clone --run "$CLONE_RUN"
CLONE_AUDIT=20260914T120300Z_audit-controls_3456cdef
npm run cloner -- diff --site example.test-01234567 --source "$SOURCE_RUN" --clone "$CLONE_RUN" --source-audit "$SOURCE_AUDIT" --clone-audit "$CLONE_AUDIT"
```

Machine measurements are evidence. Component specifications remain derived
builder contracts for the reconstruction workflow and do not override an
immutable measurement. Region-scoped visual evidence compares configured
regions only. Motion/state evidence compares declared motion, state, and
canonical transforms. DOMSnapshot evidence is Chromium-only and private by
default. Screenshot artifacts stay private by default. A clone is reported
with a parity milestone, run IDs, coverage, findings, exceptions and known gaps
so it can be revisited later.

Parity findings identify source-vs-clone mismatches. Clone-health findings
identify clone implementation-quality observations. Clone-health findings do
not automatically block a parity milestone when source and clone intentionally
share a defect.

@docs/research/INSPECTION_GUIDE.md
