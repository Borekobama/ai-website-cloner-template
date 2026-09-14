<!-- AUTO-GENERATED from AGENTS.md — do not edit directly.
     Run `bash scripts/sync-agent-rules.sh` to regenerate. -->

---
description: Project conventions for AI Website Clone Template
alwaysApply: true
---
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

## Parity workflow (v0.5.1)

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
immutable measurement. Initial visual QA is an additional signal; a clone is
reported with a parity milestone, run IDs, coverage, findings, exceptions and
known gaps so it can be revisited later.

Parity findings identify source-vs-clone mismatches. Clone-health findings
identify clone implementation-quality observations. Clone-health findings do
not automatically block a parity milestone when source and clone intentionally
share a defect.

# Website Inspection Guide

This guide covers the visual/bootstrap side of cloning. For repeatable source
and clone parity, use the repository-owned Playwright CLI first:

```bash
npm run cloner -- help
npm run cloner -- selftest
```

The CLI's immutable run manifests and machine measurements are evidence. The
Markdown documents below are builder guidance and derived research; they do
not replace a run artifact. Keep the source/clone relationship, route scope,
inventory run ID, and known exceptions visible when recording findings.

Parity findings identify source-vs-clone mismatches. Clone-health findings
identify clone implementation-quality observations. Clone-health findings do
not automatically block a parity milestone when source and clone intentionally
share a defect.

## How to Reverse-Engineer Any Website

Use Chrome MCP or browser DevTools for exploratory visual inspection. Use
Playwright through `tools/cloner` for authoritative measurements and automated
interactions. Do not interact with an authenticated source until the
safe-action policy classifies the control.

## Phase 1: Visual Audit

### Screenshots to Capture
- [ ] Every distinct page — desktop, tablet, mobile
- [ ] Dark mode variants (if applicable)
- [ ] Light mode variants (if applicable)
- [ ] Key interaction states (hover, active, open menus, modals)
- [ ] Loading/skeleton states
- [ ] Empty states
- [ ] Error states

### Design Tokens to Extract
- [ ] **Colors** — background, text (primary/secondary/muted), accent, border, hover, error, success, warning
- [ ] **Typography** — font family, sizes (h1-h6, body, caption, label), weights, line heights, letter spacing
- [ ] **Spacing** — padding/margin patterns (look for a scale: 4px, 8px, 12px, 16px, 24px, 32px, etc.)
- [ ] **Border radius** — buttons, cards, avatars, inputs
- [ ] **Shadows/elevation** — card shadows, dropdown shadows, modal overlay
- [ ] **Breakpoints** — when does the layout shift? (inspect with DevTools responsive mode)
- [ ] **Icons** — which icon library? custom SVGs? sizes?
- [ ] **Avatars** — sizes, shapes, fallback behavior
- [ ] **Buttons** — all variants (primary, secondary, ghost, icon-only, danger)
- [ ] **Inputs** — text fields, textareas, selects, checkboxes, toggles

## Phase 2: Component Inventory

For each distinct UI component, document:
1. **Name** — what would you call this component?
2. **Structure** — what HTML elements / child components does it contain?
3. **Variants** — does it have different sizes, colors, or states?
4. **States** — default, hover, active, disabled, loading, error, empty
5. **Responsive behavior** — how does it change at different breakpoints?
6. **Interactions** — click, hover, focus, keyboard navigation
7. **Animations** — transitions, entrance/exit animations, micro-interactions

### Common Components to Look For
- Navigation (top bar, sidebar, bottom bar)
- Cards / list items
- Buttons and links
- Forms and inputs
- Modals and dialogs
- Dropdowns and menus
- Tabs and segmented controls
- Avatars and user badges
- Loading skeletons
- Toast notifications
- Tooltips and popovers

## Phase 3: Layout Architecture

- [ ] **Grid system** — CSS Grid? Flexbox? Fixed widths?
- [ ] **Column layout** — how many columns at each breakpoint?
- [ ] **Max-width** — main content area max-width
- [ ] **Sticky elements** — header, sidebar, floating buttons
- [ ] **Z-index layers** — navigation, modals, tooltips, overlays
- [ ] **Scroll behavior** — infinite scroll, pagination, virtual scrolling

## Phase 4: Technical Stack Analysis

- [ ] **Framework** — React? Vue? Angular? Check `__NEXT_DATA__`, `__NUXT__`, `ng-version`
- [ ] **CSS approach** — Tailwind (utility classes), CSS Modules, Styled Components, Emotion, vanilla CSS
- [ ] **State management** — Redux (check DevTools), React Query, Zustand, Pinia
- [ ] **API patterns** — REST, GraphQL (check network tab for `/graphql` requests)
- [ ] **Font loading** — Google Fonts, self-hosted, system fonts
- [ ] **Image strategy** — CDN, lazy loading, srcset, WebP/AVIF
- [ ] **Animation library** — Framer Motion, GSAP, CSS transitions only

## Phase 5: Documentation Output

After inspection, create these files in `docs/research/`:
1. `DESIGN_TOKENS.md` — All extracted colors, typography, spacing
2. `COMPONENT_INVENTORY.md` — Every component with structure notes
3. `LAYOUT_ARCHITECTURE.md` — Page layouts, grid system, responsive behavior
4. `INTERACTION_PATTERNS.md` — Animations, transitions, hover states
5. `TECH_STACK_ANALYSIS.md` — What the site uses and our chosen equivalents

## Parity measurement checklist

Before accepting a parity milestone:

- [ ] `npm run cloner -- selftest` passes
- [ ] Source measurement has a healthy session, expected tenant/workspace and role when configured
- [ ] Clone measurement has a healthy server, loaded client JavaScript, and a hydrated route
- [ ] Source and clone each have a new immutable run with exact commit/dirty-state identity
- [ ] Authoritative baselines were explicitly measured with `--inventory`; ad-hoc/subset runs did not advance `current`
- [ ] Requested route scope and authoritative inventory denominator/provenance are recorded in `coverage.json`
- [ ] `audit dead-controls` uses actionability/trial checks, re-verifies source identity before every isolated source trial, and reports blocked, disabled, unreachable, trial-invalid, already-active and dead separately
- [ ] Clone-health dead-control closure requires an exercised non-dead observation or a fully completed compatible route audit with the control absent; blocked-by-policy, trial-invalid, partial, and failed coverage cannot close it
- [ ] Dead-class evidence records stylesheet readability counts and suppresses authoritative findings when `cssCoverageComplete` is false
- [ ] Diff reports record comparator coverage plus selected control-audit IDs/covered routes; finding closure requires compatible reproducing evidence
- [ ] Each dead-control occurrence is exercised from a fresh baseline context and the exact occurrence is re-located before policy/action
- [ ] `audit dead-classes` preserves route provenance and aggregates only after the requested sweep
- [ ] `diff` preserves duplicate control occurrences, cites concrete run IDs, and uses gate/informational/ignore policies for richer action effects; network behavior is not a universal gate
- [ ] Every run stores its normalized policy snapshot; conflicting equally specific source-action rules fail closed
- [ ] Failed runs retain incrementally persisted completed-route evidence and accurately name failed routes
- [ ] Findings are appended to `docs/research/<site-key>/_parity/ledger.jsonl`
- [ ] Visual QA is reported as an additional signal, not as permanent completion

Never use historical prose counts as fixture expectations. Freeze a failing
instrument result with `fixture freeze` before repairing the instrument.
