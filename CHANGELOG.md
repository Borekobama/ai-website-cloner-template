# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.14.0] - 2026-10-02

Screenshot mode: a clone can now be built and measured from screenshots alone,
or from a live site plus screenshots, with the same immutable runs, diffs,
reports, and ledger as a live clone.

### Added
- Screenshot-mode reference (`docs/research/SCREENSHOT_MODE_REFERENCE.md`) and templates in `docs/research/templates/`: DESIGN, component spec, page topology, behaviours, artifact manifest, parity report, and examples of screens, anchors, font samples, and icon boxes. The portable skill ships both as references, and the skill gains an evidence-modes section (live, screenshots, mixed)
- `fonts fit` identifies the family, weight, and size of one-line text samples by rendering candidates in real Chromium DOM at the screenshot's own device scale, so optical sizing matches. Candidates are 30 common Google Fonts (Inter with its optical-size axis), installed fonts (`--families local:<name>`), and font files (`--font-dir`). Known fonts, resampled and compressed like a presentation shot, are recovered at their exact size. Each sample keeps its own winner in `fonts.json` and `TYPE_SCALE.md`
- `icons match` ranks icons from Iconify sets (lucide, hugeicons, tabler, heroicons, and ph by default; cached in `.cloner-runtime/icon-cache/`) by shape for each icon box, and records each set's licence. Icon markup is sanitized and rendered with JavaScript disabled and all network requests blocked
- `analyze palette` drafts colour tokens from flat surfaces and text stroke cores through the existing token renderers; `analyze layout` drafts a skeleton of one-colour panels with their gaps, insets, and radii in CSS pixels. Both are builder drafts, not evidence
- `assets extract` crops a CSS box from the native screenshot, fills occluded boxes by coarse-to-fine diffusion, writes PNG, JPEG, or WebP, and records the crop as rights-unverified in `ARTIFACT_MANIFEST.md` and `extracted-assets.json`. Logos and brand marks need `--approved`. `rights` lists these crops for an image run
- `probe box` (and every tool built on it) warns when the box border is not plain background
- Image parity: `measure --target clone --anchors anchors.json --reference-run <image-run>` captures each configured page at the reference's own (often fractional) device scale and evaluates anchors, named probes with a tolerance. `diff` against an image source run computes the reference values from the stored native crops and reports `image-anchor-mismatch`, `image-anchor-missing`, and `image-region-mismatch` findings; an edge anchor that lands on a different edge is a mismatch even when its position is within tolerance. Regions compare CSS boxes pixel by pixel with masks and default to informational; a region that covers most of the page cannot gate. Controls, classes, and other live-only modules are reported as not applicable, and clone runtime errors still gate. `report.html` gains an Image parity section with reference, clone, and difference views and an anchor table
- `ingest --screens screens.json` turns screenshots into a closed source run with image evidence: originals, native frame crops, normalized 1x references, `measurements/frames.json` (kind, backdrop, frame, scale and its method and confidence, CSS geometry, warnings), and a route inventory. Presentation shots, raw screenshots, design exports, and cropped zooms with anchors are supported; `--inventory` sets `source-current`. Readable copies go to `docs/design-references/<site>/<page>/`. A screen without a resolvable scale stops ingest before any run exists
- `probe edges|runs|box|color|radius` measures an ingested screen in CSS pixels, or an image file in image pixels (`--image`) to find anchors before ingest
- Image core for screenshot cloning, with no new dependencies: `image.mjs` decodes PNG directly and WebP, JPEG, AVIF, GIF, and colour-profiled PNG through the bundled Chromium (converted to sRGB); `frames.mjs` finds the backdrop, one or more app frames at sub-pixel accuracy (drop shadows tolerated, cropped sides flagged), and the scale from a declared scale, anchors of known CSS length, a design width, or a common design size; `probes.mjs` measures edges, ink runs, ink boxes (with a clipped-box warning), flat and text colours, and corner radii in CSS pixels of the normalized frame
- Typed control trials: the dead-controls audit fills text fields with a valid probe value, picks another option in a select, and listens for a file chooser around each click. New categories `input` (a value, selection, or checked state that sticks) and `file-chooser`
- Category `inert-overlay` for controls inside a closed `<dialog>` or popover. It does not close an earlier dead-control finding
- `--hydration-timeout <ms>` for `measure` and `audit dead-controls` (default 10000)
- `--server-command dev|start` for managed clone servers; `start` runs `npm run build` first. `audit dead-controls` accepts `--server managed` and records the origin it actually used
- Dead runtime-class reason `split-arbitrary-value`, with a fix hint, for classes that a space inside an arbitrary value split apart

### Changed
- `audit` and `drift` refuse image source runs with a clear message; they need a live target
- `measure --anchors` resolves its path against `--root`, like `ingest --screens`
- The unit tests that need Chromium skip when it is not installed; the integration job runs them

### Fixed
- The clone hydration gate waits for `networkidle` and polls for hydration evidence, in measurement, in the audit baseline, and in every clone trial. Development servers that hydrate late no longer fail the audit or produce dead controls
- A hydration marker or selector is enough evidence for a clone that does not use Next.js
- SVG elements report their class attribute instead of `[object SVGAnimatedString]`
- Compiled classes with CSS escapes, such as `.\32 xl\:p-4` (`2xl:p-4`), and non-ASCII class names are parsed in full. One escape-aware tokenizer now serves the measurement and the audit
- The overlay count includes only open dialogs, open popovers, and visible dialog or menu roles, so opening a mounted `<dialog>` is detected as an overlay
- Current-page links (`aria-current`), checked radios (`aria-checked` on radio roles, native checked radios), and Radix radio items (`data-state="checked"` or `"on"`) are classified as `already-active`. Control evidence records `aria-current`

## [0.13.1] - 2026-09-30

### Changed
- The dead-controls audit decides safe-action policy before it opens a trial. Blocked controls are recorded from the baseline page without a page load, which speeds up source audits where most controls are blocked
- Clone control trials run up to four at a time in separate browser contexts (`--trial-concurrency <n>`, 1-16); source trials still run one at a time

### Fixed
- Element lookups after a control action are bounded by the action timeout. A control that navigated away or re-rendered held the audit for two 30-second Playwright timeouts

## [0.13.0] - 2026-09-30

### Added
- `--aria` accessibility-tree evidence: landmark and heading outline changes gate parity; accessible names and role counts stay informational
- `--head` metadata evidence: title, description, robots, canonical path, language, hreflang, and JSON-LD types gate parity; social previews, icons, viewport, and theme colour stay informational
- `--sitemap [url]` reads a bounded, same-origin route list from the target sitemap and records its provenance in the run scope
- `--performance` informational load metrics: largest contentful paint, cumulative layout shift, and transfer bytes
- Runtime error evidence on every measured route: clone-only uncaught page errors and hydration failures gate parity; clone-only console errors stay informational
- Responsive media-feature probes for `prefers-color-scheme`, `prefers-reduced-motion`, and hover/pointer (touch) conditions, including colour summaries
- Visual region masks (`mask`, `sourceMask`, `cloneMask`) and state regions (`state` with `hover`, `focus`, or `click`) captured on a fresh page after safe-action policy approval
- Per-route deployment fingerprints, source resume that reuses a route only when its fingerprint still matches, and the `drift` command for targeted re-measurement
- `tokens` command: draft design tokens, `DESIGN_TOKENS.md`, and a Tailwind v4 `@theme` derived from DOMSnapshot evidence
- `audit clone-code`: clone-health findings for React state that is set but never read and for typed registries that disagree over the same key domain
- Dead runtime-class findings now say whether a variant is undefined or a variant class was never generated
- `report.html` beside every diff report, with source, clone, and difference captures side by side
- `rights` command: informational licence hints for source images, fonts, and media
- Portable skill bundle in `skills/clone-website/`, generated by `scripts/sync-skills.mjs`, with a launcher that installs the version-matched runtime once

### Changed
- DOMSnapshot evidence records corner radii, box shadow, border, and gap styles plus the style list it used
- Run manifests record the bundled runtime hash when the portable launcher runs the CLI

### Fixed
- `--option=value` arguments no longer truncate values that contain `=`
- Motion sampling waits for running animations to start and samples each animation once. Before, samples were silently empty after a visual screenshot, and the separate `samples` field was always empty
- Motion capture holds running animations at their first frame while reading rendered values, so rendered opacity and transforms no longer depend on capture timing
- Motion transform gates compare sampled positions relative to each animation's first frame, so a layout shift elsewhere on the page no longer fails them; absolute positions stay informational
- `fixture freeze --public` refuses evidence that still contains credential-like material, email addresses, JWTs, or phone numbers, and leaves screenshots out unless `--include-screenshots` is given

### Security
- Update Next.js and eslint-config-next to 16.3.5 with exact pins and refresh vulnerable transitive dependencies, matching the upstream fix in JCodesMore/ai-website-cloner-template#119

## [0.12.1] - 2026-09-14

### Fixed
- Hardened source-action occurrence identity, DOMSnapshot redaction, authenticated inventory and parity provenance, resumable optional evidence, motion transforms, compiled CSS selector discovery, asset associations, and manual ledger status transitions
- Added browser coverage for duplicate safe-action controls, declaration-text CSS false positives, repeated asset references, and repaired evidence continuity

## [0.12.0] - 2026-09-14

### Added
- Bounded structural/component summaries derived from CDP DOMSnapshot evidence
- Route-scoped source/clone structural comparison with explicit structure coverage
- Informational geometry comparison without a global fidelity score

## [0.11.0] - 2026-09-14

### Added
- Compatible `--resume-run` support for reusing completed route evidence from failed measurements
- Resume provenance, reused-route coverage, module compatibility checks, and browser-backed partial-run recovery coverage

## [0.10.0] - 2026-09-14

### Added
- Opt-in network and asset manifest evidence for response metadata, bounded content hashes, DOM/CSS associations, lazy sources, media, fonts, icons, and animation assets
- Per-route private asset evidence with stylesheet/body-read coverage and informational source-vs-clone asset comparisons

## [0.9.0] - 2026-09-14

### Added
- Opt-in responsive CSS discovery for media and container conditions, including stylesheet readability, parsed width/height thresholds, orientation, and reduced-motion preferences
- Exact pixel probes at each discovered px threshold minus one, at the threshold, and plus one, with viewport, media-match, visible-control, and bounded layout evidence
- Responsive coverage and source-vs-clone findings for media condition sets and matching media probes, with container-only differences reported informationally when no direct browser match exists

## [0.8.0] - 2026-09-14

### Added
- Chromium CDP DOMSnapshot evidence with flattened DOM, layout, paint order, and selected computed styles persisted per route

## [0.7.0] - 2026-09-14

### Added
- Motion and state parity evidence for declared animation/transition fields, state attributes, canonical transforms, and optional deterministic Web Animations API samples

## [0.6.0] - 2026-09-14

### Added
- Region-scoped visual parity evidence with deterministic Playwright screenshots, pixel comparison, private PNG artifacts, coverage, and ledger-aware findings

## [0.4.0] - 2026-08-10

### Added
- Docker workflows for local development and multi-stage production builds
- Kiro support through a generated workspace `/clone-website` skill
- Complete generated workspace skills for Cline and Roo Code, including a Roo slash-command bridge
- Simplified Chinese and Japanese READMEs with the same onboarding and workflow guidance as the English documentation
- Contributor and security policies, including a private vulnerability-reporting path
- CI enforcement that generated agent rules and skills remain synchronized with their source files
- Compact pipeline diagrams and a static Star History chart in every README

### Changed
- Raised the project Node.js baseline to 24 across local development, CI, Docker, and contributor-facing documentation
- Refreshed Next.js to 16.3, React to 19.2.4, and related dependencies
- Updated `/clone-website` so later runs preserve existing pages and isolate routes, research, components, assets, and downloaders for each target
- Improved multi-origin and query/fragment planning with collision-resistant output namespaces and explicit route verification
- Redesigned README onboarding around the template workflow, Opus 5 recommendation, supported platforms, and community links
- Hardened the rule and skill generators for current platform schemas and deterministic output

### Fixed
- Gemini CLI command validation by adding the required name and flattening the prompt schema
- Cline and Roo Code invocation, frontmatter, and argument handling
- Next.js documentation resolution in generated agent rules
- Vulnerable framework dependencies and generated-file consistency checks

### Removed
- Aider from the officially supported-platform list because its current capabilities cannot run the complete browser and subagent workflow reliably; `.aider.conf.yml` remains available for loading general project context

### Security
- Documented responsible vulnerability disclosure through GitHub private vulnerability reporting
- Updated vulnerable dependencies to patched releases

## [0.3.1] - 2026-03-29

### Fixed
- `sync-agent-rules.sh` failing to resolve `@file` imports on Windows due to CRLF line endings — platform instruction files now correctly inline the Inspection Guide content

## [0.3.0] - 2026-03-29

### Added
- Multi-URL support for `/clone-website` — clone multiple sites in a single command with parallel processing and isolated output
- CI quality gates via GitHub Actions — automated lint, typecheck, and build on every push and PR
- `npm run typecheck` and `npm run check` scripts for local quality validation
- `.gitattributes` for cross-platform line ending normalization
- `.nvmrc` to pin Node.js 20 for contributor consistency

### Changed
- Streamlined PR template — removed redundant checklist items and screenshots section
- Improved project description and README — clearer use cases, limitations, and modern wording
- Refined documentation and agent rules across all platforms for clarity and consistency
- Fixed CRLF handling in `sync-skills.mjs` for reliable Windows operation

### Removed
- Outdated use case from README documentation

## [0.2.0] - 2026-03-28

### Added
- Multi-platform AI agent support: Claude Code, Codex CLI, OpenCode, GitHub Copilot, Cursor, Windsurf, Gemini CLI, Cline/Roo Code, Continue, Amazon Q, Augment Code, Aider
- Platform-specific instruction files and `/clone-website` skill for each supported agent
- `scripts/sync-agent-rules.sh` to regenerate platform instruction files from AGENTS.md
- `scripts/sync-skills.mjs` to regenerate `/clone-website` skill across all platforms
- GEMINI.md for Gemini CLI configuration
- Supported Platforms table in README
- "Updating for Other Platforms" documentation section in README

### Changed
- README now describes the project as multi-agent (Claude Code recommended, not required)
- AGENTS.md updated with sync script reminders

## [0.1.1] - 2026-03-28

### Added
- Bug report and feature request issue templates
- Pull request template with checklist
- CHANGELOG.md following Keep a Changelog format
- Package.json metadata (description, repository, homepage, keywords, engines)

### Fixed
- LICENSE copyright holder now attributed to JCodesMore

## [0.1.0] - 2026-03-28

### Added
- Initial template scaffold for website reverse-engineering with Claude Code
- `/clone-website` skill for full-site cloning pipeline
- `/build-from-spec` and `/customize` skills
- Parallel builder agents with git worktree isolation
- Chrome MCP integration for design token extraction
- Comprehensive inspection guide and project structure documentation
- Next.js 16 + shadcn/ui + Tailwind CSS v4 base scaffold
- MIT license
- README with badges, demo section, quick start, and star history

[Unreleased]: https://github.com/JCodesMore/ai-website-cloner-template/compare/v0.13.1...HEAD
[0.13.1]: https://github.com/JCodesMore/ai-website-cloner-template/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/JCodesMore/ai-website-cloner-template/compare/v0.12.1...v0.13.0
[0.12.1]: https://github.com/JCodesMore/ai-website-cloner-template/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/JCodesMore/ai-website-cloner-template/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/JCodesMore/ai-website-cloner-template/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/JCodesMore/ai-website-cloner-template/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/JCodesMore/ai-website-cloner-template/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/JCodesMore/ai-website-cloner-template/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/JCodesMore/ai-website-cloner-template/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/JCodesMore/ai-website-cloner-template/compare/v0.4.0...v0.6.0
[0.4.0]: https://github.com/JCodesMore/ai-website-cloner-template/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/JCodesMore/ai-website-cloner-template/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/JCodesMore/ai-website-cloner-template/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/JCodesMore/ai-website-cloner-template/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/JCodesMore/ai-website-cloner-template/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/JCodesMore/ai-website-cloner-template/releases/tag/v0.1.0
