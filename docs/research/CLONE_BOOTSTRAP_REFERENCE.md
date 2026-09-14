# Clone Bootstrap Reference

Read this file during `/clone-website` **bootstrap** work before extraction or
asset download. It preserves detailed reconstruction contracts that are kept out
of the shorter parity-oriented skill. Revisit-only parity work does not need to
repeat these steps unless source drift requires new reconstruction.

## Default fidelity and scope

Unless the user says otherwise, clone the page that each target URL resolves to
with these defaults:

- Fidelity: pixel-perfect visual and behavioral emulation, including exact
  colors, spacing, typography, responsive behavior, and observed animations.
- In scope: visual layout/styling, component structure and interactions,
  responsive design, and mock/demo data needed to reproduce the visible product.
- Out of scope: a real backend/database, real authentication, real-time product
  infrastructure, SEO optimization, and an accessibility audit.
- Customization: none during emulation. Match first; customize only when the
  user explicitly asks for it.

User instructions override these defaults.

## App Router path characters

Preserve every normalized source pathname as its App Router URL. For example,
`/docs/intro` maps to `src/app/docs/intro/page.tsx` unless an existing route
requires an explicit user-approved decision.

Literal source path segments can accidentally invoke App Router filesystem
syntax. Encode segment folder spellings that would otherwise mean something to
Next.js: a leading `_` or `@`, and literal parentheses or square brackets. Use
percent-encoded folder spellings instead of accidentally creating private
folders, parallel-route slots, route groups, or dynamic segments. After build,
open the exact normalized URL and verify that it resolves there.

## Asset discovery contract

Real source assets are the default. Inspect the rendered page and its relevant
DOM/CSS/network evidence before building. At minimum enumerate:

- every rendered `<img>` using `currentSrc`/`src`, alt text, natural dimensions,
  position/z-index, and sibling images that reveal layered compositions;
- every `<video>` and nested `<source>`, including poster, autoplay, loop, and
  muted state;
- computed `background-image` values across rendered elements, including
  absolutely positioned overlays and decorative layers;
- inline SVGs and external SVG/image references;
- font families actually used by representative rendered elements, then their
  corresponding linked/self-hosted font assets and weights;
- favicon/icon links and route/site metadata assets.

A section that appears to be one image may be a stack of background art,
foreground product imagery, and overlays. Inspect the full container tree rather
than downloading only the visually largest image.

Download into the planned namespaced asset root with the page's unique download
script. Batch downloads conservatively (the upstream default is four at a time),
handle failures explicitly, validate downloaded media, and never overwrite
another page's asset namespace. Record unrecoverable assets rather than silently
inventing replacements.

## Optional Atlas Cloud fallback

Atlas is an exception path for an unrecoverable non-distinctive visual asset. It
is never a default source of clone imagery. Use it only when **all** conditions
below hold:

1. Bounded download attempts plus inspection of the rendered page, HTML, CSS,
   source maps, network responses, and same-site asset paths still cannot recover
   the original.
2. No lawful local or same-site equivalent is available.
3. The asset is not a logo, trademark, product screenshot, legal/certification
   mark, or other distinctive brand artwork. Those stay exact or are reported
   missing.
4. The user explicitly approves a generated substitute and understands it will
   not be pixel-identical source material.
5. `ATLASCLOUD_API_KEY` is available from the environment. Never print it, put it
   in a URL, persist it in research output, or forward it to an output CDN.

When those conditions are satisfied, use the live Atlas contract rather than a
hard-coded model assumption:

1. `GET https://api.atlascloud.ai/api/v1/models` and select a currently
   available Image model appropriate to the required output.
2. Fetch the selected model's `schema` URL and validate all current required
   fields before submitting. A previously known model ID is only an example.
3. Send exactly one authenticated `POST
   https://api.atlascloud.ai/api/v1/model/generateImage`. Do not automatically
   retry an ambiguous generation submission.
4. Persist the returned prediction ID in the page research artifacts, then poll
   `GET https://api.atlascloud.ai/api/v1/model/prediction/<id>` with bounded
   backoff (for example, every three seconds for at most 40 attempts), stopping
   immediately on `completed` or `failed`.
5. Accept only HTTPS output URLs. Download output without the Atlas authorization
   header, validate media type and dimensions, and save it under the planned
   namespaced asset root.
6. Record model ID, prompt, prediction ID, output path, and the user's approval in
   `<artifact-root>/ARTIFACT_MANIFEST.md`. Label it generated fallback material
   so builders never treat it as an exact original.

If any condition fails, keep a missing-asset finding in the artifact manifest and
continue without fabricating the source site's identity.
