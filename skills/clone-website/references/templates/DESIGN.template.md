# <Product> design system

Rules for building new <Product> pages that look like the reference screens.
Every value below is implemented in code: tokens in `<path to theme CSS>`,
primitives in `<path to UI primitives>`. Change a value in both places or not
at all.

- **Source of truth:** <n> reference screens in
  `docs/design-references/<site-key>/` (<page> `<route>`, …), rebuilt to within
  <n> px at <width> × <height>.
- **Measured, not guessed:** values come from probes at each screenshot's
  native scale (image run `<run-id>`). Hidden or cropped parts were designed
  with these rules and are marked _extrapolated_.
- Pages that are not in the references were built only from these rules.

---

## 1. Principles

Three to six rules that a new page must follow, each with the measured reason.
Example: "White cards on a grey canvas, one accent colour" or "Pills for every
control, soft rectangles for cards".

## 2. Layout

### 2.1 Frame
Canvas, gutters, sidebar width, main column, sticky parts (measured).

### 2.2 Page anatomy (top to bottom)
Header height, rows, and the gaps between them.

### 2.3 Grid recipes (widths at <design width> px)
The column templates that the reference screens use.

### 2.4 Responsive behaviour
Breakpoints and what changes at each (container queries on the main area,
drawer below a width, tables that scroll inside their card). List the widths
that were checked: 390, 768, 1024, 1280, 1440.

## 3. Colour

### 3.1 Tokens

| Token | Value | Use |
|---|---|---|
| `canvas` | `#…` | page background |
| `surface` | `#…` | cards |
| `ink` | `#…` | primary text and primary action |
| `muted` | `#…` | secondary text |
| `accent` | `#…` | the one accent |

Values come from `analyze palette` and `probe color`; near-duplicates are
snapped to one family.

### 3.2 Text on coloured surfaces
### 3.3 Status language
One mapping from status to colour and label, used everywhere.

## 4. Typography

Family and source (from `fonts fit`, with scores), then the type scale:

| Token | Size / line height / weight | Tracking | Use |
|---|---|---|---|
| `display` | … | … | page titles |
| `body` | … | … | default |
| `caption` | … | … | meta text |

State where tabular or monospaced figures are used.

## 5. Shape, borders, elevation

Radii (cards, panels, tiles, fields, pills), border colours and widths,
shadows. Note concentric radii: outer radius = inner radius + inset.

## 6. Spacing

The spacing scale and where each step is used (between cards, inside cards,
between tiles, inside pills). Confirm each value with `probe edges`.

## 7. Iconography

Icon set (from `icons match`) and its licence, sizes, stroke width, and any
icons drawn for this project.

## 8. Components

Each primitive with its variants, sizes, and states (default, hover, pressed,
focus, disabled, selected). Point to the code.

## 9. Patterns

Page header, card header, tables, lists inside panels, filters, empty states,
feedback (toasts, confirmations).

## 10. Motion

Durations, easings, and which elements animate. Mark inferred motion: a
screenshot shows no movement.

## 11. Content and voice

Tone, capitalisation, number and date formats, and words to avoid.

## 12. Accessibility

Contrast pairs that were checked, focus visibility, keyboard behaviour of
custom controls, and reduced motion.

## 13. Building a new page

Numbered steps from route file to responsive check, a code skeleton, and a
Do / Don't table.

## 14. File map

Where tokens, primitives, shell, pages, icons, and mock data live.

## 15. Known deviations from the screenshots

- Contradictions in the screenshots and how the data model resolved them.
- Extracted assets that must be replaced (see `ARTIFACT_MANIFEST.md`).
- Extrapolated content.
- Values identified by measurement only (fonts, icons).
