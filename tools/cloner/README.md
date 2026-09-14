# Cloner parity CLI v0.7.0

The cloner CLI is the repository-owned v0.7.0 measurement spine. It keeps source
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
npm run cloner -- audit dead-classes --site example.test-01234567 --target clone --run current
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

Capture declared motion and state evidence with both measurement runs:

```bash
npm run cloner -- measure --target source --url https://example.test --site example.test-01234567 --routes /home,/billing --profile .cloner-profiles/primary --inventory --motion
npm run cloner -- measure --target clone --url http://127.0.0.1:3000 --site example.test-01234567 --routes /home,/billing --inventory --motion
```

Add `--motion-sample` when deterministic Web Animations API samples are needed.
Declared motion/state mismatches are parity gates. Samples remain informational.

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
`tools/cloner/fixtures/`.

Measurements are intentionally small and explicit. The supported parity spine
is route inventory, control inventory, route-scoped runtime/compiled classes,
coverage, motion/state evidence, two audits, region-scoped visual evidence,
policy-aware comparison, and an append-only JSONL findings ledger. Optional
modules, such as DOM snapshots, require immutable evidence, coverage, comparison
semantics, focused self-tests, and no universal completion gate.
Broad crawler abstractions remain outside this parity spine.

Class observations record total/readable/unreadable stylesheet counts and
`cssCoverageComplete`. An unreadable relevant stylesheet keeps dead-class
candidates visible in route evidence but suppresses authoritative dead-class
findings for that route.

Playwright's browser binaries are installed separately when needed:

```bash
npx playwright install chromium
```

The browser-backed fixture integration is credential-free and runs the real
measure → audit → diff → ledger flow, including a repaired clone re-measurement:

```bash
npm run test:cloner:integration
```
