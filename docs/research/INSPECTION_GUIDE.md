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
