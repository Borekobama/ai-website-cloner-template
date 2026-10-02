# Cloner parity CLI v0.14.1

The cloner CLI is the repository-owned v0.14.1 measurement spine. It keeps source
and clone observations in immutable run directories under
`docs/research/<site-key>/_parity/`.

```bash
npm run cloner -- help
npm run cloner -- selftest
npm run cloner -- measure --target source --url https://example.test --site example.test-01234567 --profile .cloner-profiles/primary --routes /home,/billing --inventory
npm run cloner -- measure --target clone --url http://127.0.0.1:3000 --site example.test-01234567 --routes /home,/billing --inventory
SOURCE_RUN=20260914T120000Z_source_0123abcd
CLONE_RUN=20260914T120100Z_clone_89abcdef
npm run cloner -- audit dead-controls --site example.test-01234567 --target source --run "$SOURCE_RUN" --profile .cloner-profiles/primary
SOURCE_AUDIT=20260914T120200Z_audit-controls_2345bcde
npm run cloner -- audit dead-controls --site example.test-01234567 --target clone --run "$CLONE_RUN"
CLONE_AUDIT=20260914T120300Z_audit-controls_3456cdef
npm run cloner -- audit dead-classes --site example.test-01234567 --target clone --run "$CLONE_RUN"
npm run cloner -- diff --site example.test-01234567 --source "$SOURCE_RUN" --clone "$CLONE_RUN" --source-audit "$SOURCE_AUDIT" --clone-audit "$CLONE_AUDIT"
npm run cloner -- findings --site example.test-01234567
npm run cloner -- fixture freeze --site example.test-01234567 --target clone --run "$CLONE_RUN" --name repaired-menu
npm run test:cloner:integration
```

Add region-scoped visual evidence to both measurement runs with a versioned
configuration:

```bash
npm run cloner -- measure --target source --url https://example.test --site example.test-01234567 --routes /home --profile .cloner-profiles/primary --inventory --visual-regions docs/research/example.test-01234567/visual-regions.json
npm run cloner -- measure --target clone --url http://127.0.0.1:3000 --site example.test-01234567 --routes /home --inventory --visual-regions docs/research/example.test-01234567/visual-regions.json
npm run cloner -- diff --site example.test-01234567 --source "$SOURCE_RUN" --clone "$CLONE_RUN"
```

Visual configuration uses `schemaVersion: 1` and explicit route, viewport,
region id, selector, classification, mode, and pixel threshold fields. Only
configured regions are compared. Screenshots and diff PNGs stay private run
artifacts by default. Start from `tools/cloner/visual-regions.example.json`.
No whole-page visual score exists.

Add `mask` (or per-target `sourceMask`/`cloneMask`) selectors to paint changing
children such as clocks, avatars, or counters identically on both captures.
Add `state: { "action": "hover" | "focus" | "click", "selector": "..." }` to
capture a region after an interaction. A state region runs on a fresh page, so
later modules never see the interaction. A source action runs only after a
matching safe-action policy allowance; a blocked action leaves the region
incomplete instead of executing it. Masks and state triggers are part of the
visual policy, so a finding closes only under the same ones.

Capture declared motion and state evidence with both measurement runs:

```bash
npm run cloner -- measure --target source --url https://example.test --site example.test-01234567 --routes /home,/billing --profile .cloner-profiles/primary --inventory --motion
npm run cloner -- measure --target clone --url http://127.0.0.1:3000 --site example.test-01234567 --routes /home,/billing --inventory --motion
```

Add `--motion-sample` when deterministic Web Animations API samples are needed.
Declared motion/state mismatches are parity gates. Samples remain informational.

Capture complete Chromium DOMSnapshot evidence per route:

```bash
npm run cloner -- measure --target source --url https://example.test --site example.test-01234567 --routes /home,/billing --profile .cloner-profiles/primary --inventory --dom-snapshot
npm run cloner -- measure --target clone --url http://127.0.0.1:3000 --site example.test-01234567 --routes /home,/billing --inventory --dom-snapshot
```

DOMSnapshot artifacts include flattened DOM, layout, paint order, selected
computed styles, redacted content, bounded structural summaries, and per-route
fingerprints. Structural mismatches are parity findings. Geometry mismatches
are informational. Evidence stays private by default.

Discover responsive CSS behavior with an explicit responsive measurement on
both sides:

```bash
npm run cloner -- measure --target source --url https://example.test --site example.test-01234567 --routes /home,/billing --profile .cloner-profiles/primary --inventory --responsive
npm run cloner -- measure --target clone --url http://127.0.0.1:3000 --site example.test-01234567 --routes /home,/billing --inventory --responsive
npm run cloner -- diff --site example.test-01234567 --source "$SOURCE_RUN" --clone "$CLONE_RUN"
```

`--responsive` walks every readable stylesheet in `document.styleSheets`,
records media and container conditions plus stylesheet readability, and parses
px width/height thresholds along with orientation and
`prefers-reduced-motion`. Each discovered px threshold is probed at exactly one
pixel below, at the threshold, and one pixel above. Probe evidence records the
actual viewport, matching media conditions, and bounded visible-control/layout
summaries. Full route evidence is a private append-only artifact; the aggregate
`measurements/responsive.json` file contains only route metadata and artifact
references. Unreadable stylesheets or failed probes make responsive coverage
incomplete without failing the ordinary route measurement.

Diffs gate differences in discovered media-condition sets and matching media
probe results. Container-condition differences are informational because the
browser does not expose a direct `matchMedia` equivalent for arbitrary
container queries. Responsive findings retain concrete source/clone run IDs and
private route-artifact locators, and `coverage.json` records responsive capture
and comparison completeness when the module is requested.

`--responsive` also probes media features at the 1280×720 baseline whenever a
stylesheet names them: both `prefers-color-scheme` values, both
`prefers-reduced-motion` values, and touch input, which flips `hover: none` and
`pointer: coarse`. Feature probes add colour summaries for the body, landmarks,
and visible controls. Their differences are `responsive-feature-mismatch` gates.

Capture network assets and page associations with `--assets`:

```bash
npm run cloner -- measure --target source --url https://example.test --site example.test-01234567 --routes /home,/billing --profile .cloner-profiles/primary --inventory --assets
npm run cloner -- measure --target clone --url http://127.0.0.1:3000 --site example.test-01234567 --routes /home,/billing --inventory --assets
npm run cloner -- diff --site example.test-01234567 --source "$SOURCE_RUN" --clone "$CLONE_RUN"
```

Asset evidence records redacted request/final URLs, status, MIME, resource type,
bounded response byte counts and hashes, plus DOM/CSS association locators.
Response bodies, headers, cookies, and credentials are never persisted. Route
artifacts stay private. `measurements/assets.json` contains only metadata and
artifact references. Asset hash differences are informational, not universal
completion gates. Unreadable stylesheets or response bodies make asset coverage
incomplete without failing ordinary route measurement.

Capture accessibility, head metadata, and load metrics with explicit flags:

```bash
npm run cloner -- measure --target source --url https://example.test --site example.test-01234567 --routes /home,/billing --profile .cloner-profiles/primary --inventory --aria --head --performance
npm run cloner -- measure --target clone --url http://127.0.0.1:3000 --site example.test-01234567 --routes /home,/billing --inventory --aria --head --performance
```

`--aria` records Playwright's accessibility snapshot per route. Landmark and
heading outline changes are gates; accessible-name and role-count differences
are informational. Values of editable controls are never persisted.

`--head` records title, description, robots, canonical path, `lang`, hreflang
alternates, and JSON-LD types as gates, and Open Graph/Twitter values, icons,
viewport, and theme colour as informational. URLs compare by path and query, so
source and clone origins may differ. For a migration of a site you own, pass
`--sitemap` (or `--sitemap <url>`) instead of `--routes`. The CLI reads at most
500 same-origin routes from at most 10 sitemap files, ignores other origins, and
records the sitemap URL, hash, and truncation in the run scope. It is an
explicit inventory source, not a crawler.

`--performance` records largest contentful paint, cumulative layout shift, and
transfer bytes after load. Every comparison is informational. It reports a
clone CLS of at least 0.1 that is 0.05 above the source, an LCP that is 1.5×
and 500 ms slower, or a page that is twice as heavy and 100 KB larger. Measure
a production build when load metrics matter; a development server is slower.

Every route records runtime errors without a flag. A clone-only uncaught page
error or hydration failure is a gate. Clone-only console errors are
informational, and an error that the source shares produces no finding.

Resume compatible completed routes after a failed measurement:

```bash
npm run cloner -- measure --target clone --url http://127.0.0.1:3000 --site example.test-01234567 --routes /home,/billing --resume-run "$FAILED_RUN"
```

Resume accepts only failed runs with matching repository identity, target
origin, identity context, policy, engine version, hydration selector, viewport,
and measurement modules. Clone routes are reused directly. Source resume needs
`--profile-id`; each source route is visited and validated again, and its
evidence is reused only when the route's deployment fingerprint still matches.
Profile paths never persist. Reused route artifacts remain immutable copies in
the new run. Routes without valid complete evidence run again. Use
`--inventory` when the resumed run must become authoritative.

Every route records a deployment fingerprint: a hash of its same-origin script
and stylesheet URLs, or of the document's ETag and Last-Modified headers when
the page loads none. It identifies a deployed bundle, not page content. `drift`
visits the routes of an earlier run again and reports which fingerprints
changed:

```bash
npm run cloner -- drift --site example.test-01234567 --run "$SOURCE_RUN" --profile .cloner-profiles/primary
```

The output lists changed, unchanged, unknown, and failed routes, plus the
`--routes` and `--inventory-run` values for a targeted re-measurement. Each
drift check is a closed run of kind `drift` with its own evidence.

Source interactions are blocked unless `parity-exceptions.json` contains an
explicit matching allowance. Blocked controls are still inventoried, but are
never clicked. Authenticated profiles belong in `.cloner-profiles/`, which is
ignored by git and must never be committed.

The CLI performs redaction before serialization and hashing. Run manifests
record the repository commit and, when dirty, a working-tree hash. A closed or
failed run cannot be changed through the normal CLI; reruns always receive a
new run ID. `current` is only a read convenience for a concrete ref and is
never written into evidence.

`--inventory` is an explicit authority declaration: the requested route list is
the denominator for that target and a successful run may advance `current`.
Without it, a measurement is `ad-hoc` and cannot promote. Use
`--inventory-run <run-id|current>` to measure a subset against an existing
authoritative inventory while preserving its denominator. Runs persist the
normalized policy snapshot, and route evidence is appended incrementally so a
later failed route does not erase earlier completed-route evidence.

The dead-controls audit decides safe-action policy before it opens a trial, so
a blocked control is recorded from the baseline page without a page load. Each
allowed control still runs in a fresh browser context. Clone trials run four at
a time by default (`--trial-concurrency <n>`, 1-16); source trials always run
one at a time because they act on a live application. Element lookups after an
action wait at most the action timeout, so a control that navigates away no
longer holds the audit for Playwright's 30-second default.

Control-effect comparisons may auto-select a dead-controls audit only when its
parent measurement, policy snapshot, and route coverage are compatible. The
diff report records the selected source/clone audit IDs and covered routes. Use
`--source-audit <run-id>` or `--clone-audit <run-id>` when an explicit compatible
audit is preferable, including an intentional subset audit. Comparator coverage
is persisted in the report, so an older finding is closed only after the same
evidence class runs again over the relevant route/control occurrence with
compatible scope.

Parity findings identify source-vs-clone mismatches. Clone-health findings
identify clone implementation-quality observations. Clone-health findings do
not automatically block a parity milestone when source and clone intentionally
share a defect.

`fixture freeze` writes to ignored `.cloner-runtime/fixtures/` by default so
authenticated or otherwise private evidence stays local. Add `--public` only
when deliberately promoting reviewed, redacted evidence into tracked
`tools/cloner/fixtures/`. Public promotion refuses evidence that still contains
credential-like material, email addresses, JWTs, or phone numbers, and leaves
PNG screenshots out unless `--include-screenshots` is given. The scan cannot
recognise every name in page text, so review a fixture before committing it.

Measurements are intentionally small and explicit. The supported parity spine
is route inventory, control inventory, route-scoped runtime/compiled classes,
coverage, motion/state evidence, responsive CSS evidence, asset/network evidence, Chromium DOMSnapshot evidence, accessibility-tree evidence, head metadata,
load metrics, runtime errors, deployment fingerprints, three audits, region-scoped
visual evidence, policy-aware comparison, and an append-only JSONL findings
ledger. Optional
modules, such as DOM snapshots, require immutable evidence, coverage, comparison
semantics, focused self-tests, and no universal completion gate.
Broad crawler abstractions remain outside this parity spine.

Class observations record total/readable/unreadable stylesheet counts and
`cssCoverageComplete`. An unreadable relevant stylesheet keeps dead-class
candidates visible in route evidence but suppresses authoritative dead-class
findings for that route.

Derived views never become evidence:

- Every `diff` also writes `report.html` in its run directory. It groups
  findings by route, shows source, clone, and difference captures side by side,
  lists module coverage, and adds source asset rights when the source run has
  asset evidence. Open it from disk; it loads nothing from the network.
- `tokens --site <site-key> --run <run-id>` reads DOMSnapshot evidence and
  writes `docs/research/<site-key>/design-tokens/` with `tokens.json`,
  `DESIGN_TOKENS.md`, and a draft Tailwind v4 `theme.css`. Values are ranked by
  how many rendered nodes use them; rename them by role before use.
- `rights --site <site-key> --run <run-id>` classifies source images, fonts, and
  media as source-owned, source-hosted fonts, known font or photo services, or
  other third parties. The notes are hints for a licence check, not legal
  conclusions.

`audit clone-code --site <site-key> [--run <clone-run-id>]` type-checks the
clone with its own TypeScript and records clone-health findings for React state
that is set but never read and for registries typed over the same mapped key
domain (`Record<Union, T>`, `Partial<...>`) that provide different keys.
Registries without such a type are not compared. A complete re-audit closes a
finding that no longer reproduces. Dead runtime-class findings also carry a
`detail.reason`: `undefined-variant` when no compiled class uses that variant,
`variant-class-not-generated` when the variant exists but this class was never
generated (usually a dynamically built class name), `split-arbitrary-value`
when a space inside an arbitrary value split one class into several, or
`missing-css`.

The dead-controls audit fills text fields with a valid probe value, picks
another option in a select, and listens for a file chooser around each click.
A value, selection, or checked state that sticks is `input`; an opened chooser
is `file-chooser`; a control inside a closed `<dialog>` or popover is
`inert-overlay`. Current-page links (`aria-current`) and checked radios are
`already-active`. Clone pages, the audit baseline, and every clone trial wait
for hydration evidence (`--hydration-timeout <ms>`, default 10000). A
development server hydrates late, so measure and audit a production build:
`--server managed --server-command start` builds the app, starts it on a free
port, and stops it afterwards; `audit dead-controls` accepts the same options.

## Screenshot evidence

When there is no live source, screenshots are the evidence. The workflow and
its rules are in `docs/research/SCREENSHOT_MODE_REFERENCE.md`; templates are in
`docs/research/templates/`.

```bash
npm run cloner -- probe edges --image zoom.webp --axis x --at 800 --from 90 --to 700
npm run cloner -- ingest --screens screens.json --inventory
npm run cloner -- probe box --site permitly-screens-caed4793 --page overview --box 284,24,560,60
npm run cloner -- analyze palette --site permitly-screens-caed4793
npm run cloner -- analyze layout --site permitly-screens-caed4793
npm run cloner -- fonts fit --site permitly-screens-caed4793 --samples fonts.samples.json
npm run cloner -- icons match --site permitly-screens-caed4793 --boxes icons.boxes.json
npm run cloner -- assets extract --site permitly-screens-caed4793 --page overview --box 280,88,688,388 --name street.jpg --kind photo --occlude "294,203,674,374"
npm run cloner -- measure --target clone --url http://127.0.0.1:3000 --site permitly-screens-caed4793 --anchors anchors.json --reference-run "$IMAGE_RUN"
npm run cloner -- diff --site permitly-screens-caed4793 --source "$IMAGE_RUN" --clone "$CLONE_RUN"
```

- `ingest` decodes each screenshot (PNG directly; WebP, JPEG, AVIF, GIF, and
  colour-profiled PNG through Chromium, converted to sRGB), finds the app frame
  and its scale, and writes a closed source run with `target.evidence: "image"`:
  originals, native frame crops, 1x references, `measurements/frames.json`, a
  route inventory, and coverage. A screen without a resolvable scale stops
  ingest before any run exists.
- Probes take and return CSS pixels of the normalized frame and measure on
  native pixels. Edges use the area method, which is exact for antialiased
  edges.
- `analyze`, `fonts`, `icons`, and `assets` write builder drafts beside the
  research docs, never into the run store. Every extracted asset is recorded as
  rights-unverified, and `rights` lists them for an image run.
- `measure --anchors` captures each configured page of the clone at the
  reference's own device scale and evaluates the anchors. `diff` against an
  image run compares anchors and configured regions, reports live-only modules
  as not applicable, and still gates clone runtime errors. There is no
  whole-page score: the page images in `report.html` are a visual aid, and a
  region that covers most of the page cannot gate.

`node scripts/sync-skills.mjs` also generates the portable skill in
`skills/clone-website/`: the portable `SKILL.md`, the bootstrap and screenshot
references with their templates, a launcher, and a copy of these runtime modules pinned to this repository's
lockfile. The launcher installs that runtime once under
`~/.skills-manager/runtime-cache/clone-website/<version>/` and records the
bundle hash in every run manifest. CI fails when the bundle is out of date, so
regenerate it after changing any runtime module.

Playwright's browser binaries are installed separately when needed:

```bash
npx playwright install chromium
```

The browser-backed fixture integration is credential-free and runs the real
measure → audit → diff → ledger flow, including a repaired clone re-measurement:

```bash
npm run test:cloner:integration
```
