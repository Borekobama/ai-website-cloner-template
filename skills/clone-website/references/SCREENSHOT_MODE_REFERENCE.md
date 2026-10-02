# Screenshot mode reference

Use this reference when there is no live source to measure: a design shot from
a portfolio site, screenshots from a client, a design-tool export, or states of
an app that the live site cannot show. The screenshots are the source of
truth. Every value in the clone comes from a measurement of their pixels, or
from a design rule that the measurements support.

The cloner keeps screenshot evidence in the same run store as live evidence.
`ingest` creates an image source run; probes, analysers, and font and icon
helpers read it; `measure --anchors` and `diff` compare the clone with it.

## 1. Inputs

| Kind | What it is | How the scale is found |
|---|---|---|
| `presentation` | An app frame placed on a backdrop, often with a shadow, sometimes cropped or zoomed | Frame detection, then `designWidth`, anchors, or a common design size |
| `raw` | A browser or device screenshot, edge to edge | `dpr` (or `scale`), else `designWidth` |
| `design-export` | A frame exported from a design tool | `scale`, else `designWidth` |
| `auto` | Unknown | A frame counts only if it is large, has a clear backdrop margin on all four sides, and has four sharp straight edges; otherwise the screen is raw |

Supported formats: PNG, JPEG, WebP, AVIF, and GIF. Chromium decodes everything
except PNG without a colour profile and converts it to sRGB, as a browser shows
it. Perspective or tilted mock-ups are not supported: ask for a flat
screenshot, or declare the frame of a flat part by hand.

**Mixed mode.** A live site plus screenshots of states it cannot show (a
logged-in view, an error, a future design). Measure the live source as usual,
ingest the screenshots into their own image run under the same site key, and
diff the same clone run against each source run. Record `liveSource` on a
screen to keep the relationship in the evidence.

## 2. screens.json

Start from `templates/screens.example.json`.

- `page` names the artifacts, so each one is unique. Two states of one route
  (a menu open, a dialog) are two pages with the same `route` and a `state`
  label.
- `designWidth` at the top applies to every screen that does not set its own.
- `frame: [x, y, width, height]` (image pixels) overrides frame detection, for
  gradient backdrops or device bezels.
- `frameIndex` picks one of several frames in one image (largest first).

A cropped zoom needs an anchor: a horizontal or vertical distance whose CSS
length you know, such as a 240 px sidebar. Find it in image pixels before
ingest:

```bash
node "$CLONER_LAUNCHER" probe edges --image Permitly4.webp --axis x --at 800 --from 90 --to 700
```

Then add `"anchors": [{ "axis": "x", "native": [132.28, 540.96], "css": 240 }]`.
When `css` is `[start, end]` instead of a length, the anchor also fixes the
origin of a frame whose left or top edge is cropped.

```bash
node "$CLONER_LAUNCHER" ingest --screens screens.json --inventory
```

`ingest` fails before it writes a run when any screen has no scale. Its output
lists, for each screen, the kind, scale, method (`declared`, `anchors`,
`design-width`, `common-size`), confidence, CSS size, cropped sides, and
warnings. Read the warnings. A `common-size` guess with confidence 0.4 means
two common sizes share the aspect ratio: declare the design width.

The run keeps the originals, native frame crops (probes use these), and 1x
references. Readable copies go to `docs/design-references/<site-key>/<page>/`
as `source.*`, `native.png`, and `reference.png`.

## 3. Extraction order

Work from the system to the details, and write each result into `DESIGN.md`
(start from `templates/DESIGN.template.md`) before you build components.

1. **Palette.** `analyze palette` drafts colour tokens: surface colours from
   flat areas and text colours from stroke cores, counted in CSS pixels. Snap
   near-duplicates to one family and name tokens by role.
2. **Layout.** `analyze layout` drafts a skeleton: one-colour panels, the gaps
   between them, the insets inside parents, and corner radii. It is a hint.
   Confirm every spacing value that you use with `probe edges`.
3. **Type.** `fonts fit` identifies the family, weight, and size of sample text
   lines (section 5).
4. **Icons.** `icons match` ranks icons from public sets for each icon box
   (section 6).
5. **Assets.** `assets extract` crops placeholders that nobody can supply
   (section 7).
6. **Specs.** Write `PAGE_TOPOLOGY.md`, `BEHAVIORS.md`, and one spec per
   component from the templates, with measured values.

## 4. Probe recipes

All probes take and return CSS pixels of the normalized frame and measure on
native pixels. Add `--site <key> --page <page>`, or `--image <file>` for image
pixels.

| Question | Probe |
|---|---|
| Where are the edges of a card, a pill, a sidebar? | `probe edges --axis x --at <y> --from <x0> --to <x1>`; move `--at` away from corners and text |
| Where does a line of text or an icon row start and end? Row pitch? | `probe runs --axis x --band <y0,y1> --range <x0,x1>` (`--axis y` for rows) |
| How big is this word or icon? | `probe box --box <x0,y0,x1,y1>`; a `clipped` warning means the box cut the ink, so widen it |
| What colour is this surface or this text? | `probe color --box ...` (`--mode dark` or `light` gives the text core colour) |
| What is the corner radius? | `probe radius --box <shape box from edge probes> --corner tl` |

Precision: edges on flat colour are accurate to about 0.05 image pixels.
Chromium snaps box edges to device pixels and draws a 1 px border across two
of them, so thin borders carry about one device pixel of uncertainty. Radii
below about one image pixel are not resolvable.

## 5. Font fitting protocol

```bash
node "$CLONER_LAUNCHER" fonts fit --site <key> --samples fonts.samples.json
```

Start from `templates/fonts.samples.example.json`.

- Each sample is one line of text in a loose CSS box, transcribed exactly. Pick
  lines with distinctive glyphs: digits (1, 0, 7), G, g, y, R, and a, plus
  long words. Use at least three samples per family that you expect.
- Fitting renders candidates in real Chromium DOM at the screenshot's own
  device scale. Canvas text measurement is not used because it ignores
  optical sizing (Inter's `opsz` axis changes glyph widths with the size).
- Sizes are solved from ink width, not advance width. The score adds the ink
  height error, the shape of the ink profile, and the stroke density, which
  separates weights.
- Set `tracking` (em) on samples with letter spacing, such as uppercase
  overlines. Set `weightHint` when you can see the weight.
- Read the score: in tests with known fonts, resampled and compressed like a
  presentation shot, the right font scored 0.02 to 0.04 at its exact
  whole-pixel size and the runner-up 0.10 or more. When the best score is
  higher, or the fitted sizes are fractional on most samples, the real font is
  probably not a candidate: try installed or commercial fonts with
  `--families local:<name>` or `--font-dir`, and record the closest match as a
  deviation.
- Accept a family when it wins on most samples. Each sample in
  `TYPE_SCALE.md` keeps its own winner, so a sans and a mono on one page both
  appear. Snap fitted sizes to the type scale and check line heights with
  `probe runs --axis y`.
- A sample needs a plain background around its line. A box whose border
  crosses a photo, a pill, or another line gets a warning, and its result is
  not usable.
- Candidate fonts load from Google Fonts. Offline, pass `--font-dir` with font
  files, or `--families` with installed families.

## 6. Icon matching

```bash
node "$CLONER_LAUNCHER" icons match --site <key> --boxes icons.boxes.json --sets lucide,hugeicons,tabler
```

Start from `templates/icons.boxes.example.json`. Give one loose box per
distinct icon. Candidates come from the Iconify API and are cached in
`.cloner-runtime/icon-cache/`. The result ranks five matches per box with a
score. Use one icon set for the whole clone when one set wins most boxes, and
record its licence in `ARTIFACT_MANIFEST.md`. When no candidate scores well,
draw the icon in the style of the chosen set and record it as original.

## 7. Assets and rights

```bash
node "$CLONER_LAUNCHER" assets extract --site <key> --page overview --box 280,88,688,388 \
  --name street.jpg --kind photo --occlude "290,100,360,124;294,203,674,374"
```

- A crop is a placeholder, never the final asset. Every crop is written to
  `ARTIFACT_MANIFEST.md` and `extracted-assets.json` as rights-unverified with
  its source coordinates. `rights --site <key> --run <image-run>` lists them.
- `--occlude` boxes (badges, menus, cursors drawn over the image) are filled by
  diffusion from the surrounding pixels. Keep the occluding UI in the clone at
  the same place, because the filled area has no real detail.
- `--kind logo` and `--kind brand-mark` stop unless the user approved copying
  the mark (`--approved`). Otherwise redraw it as an original mark.
- Never generate a replacement for a distinctive brand asset.

## 8. Hidden, cropped, and contradictory content

- **Extrapolation.** A cropped screen or an area under a menu is designed with
  the measured rules, never invented freely. Mark it `extrapolated` in the
  spec, in `DESIGN.md`, and in the parity report.
- **Data consistency.** Build mock data first and derive every count from it.
  When a screenshot contradicts itself (a header says "8 verified" but its rows
  show 7), the data model wins, and the deviation goes into the known
  deviations of `DESIGN.md`.
- **Text.** Transcribe visible text exactly. Do not invent copy for visible
  elements; write neutral copy only for extrapolated areas.

## 9. Responsive behaviour from one viewport

Screenshots usually show one width. Derive the rest from the system:

- Use container queries on the main content area (`@container`), so that the
  layout follows the space next to the sidebar and not the window.
- Collapse the sidebar into a drawer below the width where the main content
  falls under its smallest measured grid.
- Tables and segmented filters scroll inside their card; the page never
  scrolls horizontally.
- Check 390, 768, 1024, 1280, and 1440 px for horizontal overflow and overlap.
  Record the breakpoints in `DESIGN.md`.

## 10. Image parity

Write `anchors.json` from `templates/anchors.example.json`, then:

```bash
node "$CLONER_LAUNCHER" measure --target clone --url <clone-origin> --site <key> --anchors anchors.json --reference-run <image-run>
node "$CLONER_LAUNCHER" diff --site <key> --source <image-run> --clone <clone-run>
```

- The clone is captured at the reference's own scale, in a fresh context per
  page, after hydration. Routes default to the image run's routes.
- An anchor is a probe plus a `pick` path into its result (`edges.0.position`,
  `edges.-1.position`, `runs.0.start`, `ink.0`, `width`, `radius`, `median`,
  `ink`). Numbers compare in CSS pixels, colours by RGB distance.
- Give each probe window room for the expected error, and stop it before the
  next element. Start and end a window at least 2 image pixels away from any
  edge: an edge at the very start of a window has no plateau before it and is
  skipped. An edge anchor also records the colours on both sides of its edge,
  so landing on a neighbouring edge is a mismatch.
- When neighbouring anchors all fail by the same amount, look for one cause
  above them, such as a row that is taller in the clone than in the
  screenshot.
- `mode: gate` anchors decide parity; `informational` anchors document it. Use
  gates for layout positions and sizes, and informational anchors for colours
  of antialiased text.
- Regions compare a CSS box pixel by pixel after both images are resampled to
  the same grid; `masks` exclude photos and changing content. Regions default
  to informational with a 2 % pixel threshold, because presentation shots are
  resampled and compressed. A region that covers most of the page cannot gate.
- Set `state` on a page to open a menu or a dialog before the capture
  (`click`, `hover`, or `focus` plus a selector). The safe-action policy
  decides first.
- `report.html` shows the reference, the clone, and their difference for each
  page, as a visual aid, plus the anchor table. Cite `report.json` and run IDs.
- Live-only modules (controls, classes, ARIA, head, and others) are reported as
  not applicable. Clone runtime errors still gate, because a screenshot shows a
  working page.

## 11. Audits

Image runs have no live page, so audits run on the clone only. Measure and
audit a production server, because development servers hydrate late:

```bash
node "$CLONER_LAUNCHER" measure --target clone --url http://127.0.0.1:3000 --site <key> --routes <routes> --inventory --server managed --server-command start
node "$CLONER_LAUNCHER" audit dead-controls --site <key> --target clone --run <clone-run> --server managed --server-command start
```

The audit fills text fields, picks select options, and listens for file
choosers, so inputs and upload buttons are classified (`input`,
`file-chooser`) instead of dead. Controls inside closed dialogs are
`inert-overlay`.

## 12. Completion report for screenshot mode

Report, in addition to the general completion report:

- the image run ID, and for each screen its kind, frame, scale, method,
  confidence, and cropped sides;
- the anchor coverage, the largest anchor residual, and every failed gate;
- extrapolated regions and known deviations from the screenshots;
- the font and icon decisions with their scores, and the icon licence;
- every extracted asset with its rights status;
- the `DESIGN.md` path, and the widths checked for responsive behaviour.

Use `templates/PARITY_REPORT.template.md` for the parity report.
