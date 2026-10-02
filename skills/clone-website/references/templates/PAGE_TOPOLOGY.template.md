# <Page> — page topology

- Source: `docs/design-references/<site-key>/<page>/source.<ext>`
  (<width> × <height>; frame at x <x0>–<x1>, y <y0>–<y1> → <css width> × <css height>
  at <scale> image px per CSS px; <kind>, <method>, confidence <n>).
- Route: `<route>` → `<path to page file>`.

```
canvas <token>, <n> px gutter
├─ aside  <sidebar> <x0>→<x1> × <y0>→<y1>                     <component file>
└─ main <x0>→<x1>
   ├─ header <y0>→<y1>     <left items> │ <right items>
   ├─ row 1  <y0>→<y1>     <Component> <x0>→<x1> │ <Component> <x0>→<x1>
   └─ row 2  <y0>→<y1>     …
```

Stacking: fixed or sticky parts, overlays (menus, dialogs, toasts) and where
they render. Scroll containers inside the page.

Extrapolated areas: <cropped or covered parts and how they were designed>.
