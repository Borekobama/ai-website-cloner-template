# Artifact manifest

Where every asset in the clone comes from and what its rights status is.
`assets extract` appends crop rows automatically; add the other rows by hand.
Replace every unverified asset before publishing.

| Asset | Path | Origin | Rights status |
|---|---|---|---|
| <Photo> (photo) | `public/sites/<site-key>/<page>/<file>` (<w> × <h>) | Crop of `<image>` (page <page>, CSS <box>). <n> occluded area(s) filled by diffusion. | **Unverified.** Replace with a licensed image before publishing. |
| <Logo mark> | `<path>` (SVG) | Redrawn from the screenshot: <description>. | Brand mark of the reference. Rename and re-mark before shipping a product. |
| UI icons | `<package>` <version> | Matched with `icons match` (best score <n>). | <licence> |
| <Font family> | `<loader>` | Identified with `fonts fit` (score <n>). | <licence> |
| Favicon | `<path>` | <origin> | <status> |

Missing or not recoverable: <originals at full resolution, brand assets beyond
what is visible, …>.
