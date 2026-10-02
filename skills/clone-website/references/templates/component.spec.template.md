# <Component name> (`<path to component file>`)

- Source: page `<page>` of image run `<run-id>`, CSS box `<x0, y0, x1, y1>`.
  State shown: <default | menu open | …>.
- Box: x <x0>→<x1>, y <y0>→<y1>, fill `<token>`, radius <n>, inset <n>
  (from `probe edges` and `probe radius`).
- Children, top to bottom, with measured sizes, gaps, and tokens:
  - <Title> "<exact text>" <size> / <line height> / <weight>, `<colour token>`.
  - <Meta> …
- Icons: `<set:name>` <size> px (from `icons match`, score <n>).
- Assets: `<path>` (extracted, rights unverified; see `ARTIFACT_MANIFEST.md`).
- Interaction: <static | click → … | hover → …>. States: default, hover,
  pressed, focus, disabled.
- Responsive: <what changes at each breakpoint>.
- Extrapolated: <parts not visible in the reference, or "none">.
