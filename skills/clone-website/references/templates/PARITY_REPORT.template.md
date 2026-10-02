# Parity report — <milestone> (<date>)

## Execution mode

- **Source:** screenshots, image run `<run-id>` (<n> screens). <Mixed mode:
  live source run `<run-id>` for <routes>.>
- **Clone:** parity instruments ran (cloner runtime <version>, `selftest: ok`).
- Repository: commit `<sha>`, dirty <yes|no>.

## Screens

| Page | Route | Kind | Scale (method, confidence) | Cropped | Anchors within tolerance | Largest residual |
|---|---|---|---|---|---|---|
| <page> | `<route>` | presentation | <scale> (design-width, 0.9) | none | <n>/<n> | <n> px |

## Runs

| Run | Kind | Target | Result |
|---|---|---|---|
| `<run-id>` | ingest | screenshots | <n> screens, all scales resolved |
| `<run-id>` | measure (anchors, inventory) | production server | <coverage> |
| `<run-id>` | audit dead-controls | ↑ | <category counts>, <n> dead |
| `<run-id>` | audit dead-classes | ↑ | <n> dead classes |
| `<run-id>` | diff | image run ↔ clone | <n> gates, <n> informational; `report.html` |

## Findings and repairs

Each finding with its category, run IDs, and what was changed. Note which
findings came from an instrument limitation rather than the clone.

## Visual and responsive QA

Widths checked (390, 768, 1024, 1280, 1440), horizontal overflow, overlap, and
the states opened for comparison.

## Known gaps

- Extrapolated regions: <list>.
- Contradictions resolved by the data model: <list>.
- Assets pending licensed replacements: see `ARTIFACT_MANIFEST.md`.
- Values identified by measurement only: <fonts, icons>.
