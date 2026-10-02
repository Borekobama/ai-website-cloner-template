import { createServer } from 'node:http';

const COMMON_CSS = `
  body { font-family: sans-serif; margin: 2rem; }
  .page-shell { max-width: 50rem; }
  .toolbar { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .fixture-control { border: 1px solid #777; padding: 0.35rem 0.6rem; }
  .readable-runtime { color: seagreen; }
  .toggle-on { background: lightgreen; }
  .motion-toggle { transition: transform 120ms ease; }
  .motion-toggle { transform: rotate(0deg); }
  .motion-toggle[data-state="open"] { transform: rotate(90deg); }
  @keyframes fixture-pulse { from { opacity: 0.6; } to { opacity: 1; } }
  .motion-sampled { animation: fixture-pulse 1s infinite; }
  .motion-defect { transition-property: opacity; }
  .overlay { border: 2px solid #345; margin-top: 1rem; padding: 1rem; }
  .added-item { color: #345; }
  .noise-value { color: #666; }
  .clone-visual-defect { border: 3px solid crimson; padding: 0.5rem; }
  @media (min-width: 1024px) { .responsive-media-marker { outline: 1px solid seagreen; } }
  @container shell (min-width: 600px) { .responsive-container-marker { color: seagreen; } }
  @media (prefers-color-scheme: dark) { .responsive-media-marker { color: white; background: black; } }
  @media (hover: none) { .responsive-hover-marker { display: none; } }
`;

// Typed controls, a native dialog, an SVG class, and an escaped class name
// that starts with a digit. Source and clone serve the same page.
const FORMS_BODY = `
    <main class="page-shell">
      <h1>Form fixture</h1>
      <nav><a class="fixture-control" href="/forms" aria-current="page" aria-label="Forms page">Forms</a></nav>
      <input class="fixture-control" type="text" aria-label="Plain field">
      <input class="fixture-control" type="search" aria-label="Filter items" data-action="filter">
      <ul id="filter-items"><li>Alpha</li><li>Beta</li></ul>
      <select class="fixture-control" aria-label="Sort order"><option value="newest">Newest</option><option value="oldest">Oldest</option></select>
      <input class="fixture-control" type="checkbox" aria-label="Accept terms">
      <div role="radiogroup" aria-label="Range"><button class="fixture-control" role="radio" aria-checked="true" aria-label="Day">Day</button><button class="fixture-control" role="radio" aria-checked="false" aria-label="Week" data-action="range">Week</button></div>
      <button class="fixture-control" data-action="upload" aria-label="Upload file">Upload file</button>
      <input id="fixture-file" type="file" hidden>
      <button class="fixture-control" data-action="open-dialog" aria-label="Open dialog">Open dialog</button>
      <dialog id="fixture-dialog"><p>Dialog body</p><button class="fixture-control" aria-label="Dialog action">Dialog action</button></dialog>
      <svg class="fixture-icon" viewBox="0 0 16 16" aria-hidden="true"><rect width="16" height="16"></rect></svg>
      <p class="2xl:fixture-wide">Escaped leading-digit class.</p>
      <p><code>ID 2048-77</code></p>
    </main>
`;
const FORMS_CSS = '<style>.fixture-icon { width: 16px; height: 16px; } .\\32 xl\\:fixture-wide { color: teal; }</style>';
const FORMS_SCRIPT = `
    document.querySelector('[data-action="filter"]').addEventListener('input', (event) => {
      const query = event.target.value.toLowerCase();
      document.querySelectorAll('#filter-items li').forEach((item) => { item.hidden = !item.textContent.toLowerCase().includes(query); });
    });
    document.querySelector('[data-action="upload"]').addEventListener('click', () => document.querySelector('#fixture-file').click());
    document.querySelector('[data-action="open-dialog"]').addEventListener('click', () => document.querySelector('#fixture-dialog').showModal());
    document.querySelector('[data-action="range"]').addEventListener('click', (event) => {
      document.querySelectorAll('[role="radio"]').forEach((radio) => radio.setAttribute('aria-checked', String(radio === event.currentTarget)));
    });
`;
// Handlers attach and the hydration marker turns true only after a delay, like
// a development bundle that hydrates after the load events.
const LATE_HYDRATION_SCRIPT = `
    setTimeout(() => {
      document.querySelector('[data-action="late"]').addEventListener('click', () => { document.querySelector('#late-result').textContent = 'Clicked'; });
      document.documentElement.setAttribute('data-hydrated', 'true');
    }, 1200);
`;

// A scroller and a fixed off-canvas drawer reach past a phone viewport without
// widening the page; `.too-wide` widens it below 640 px.
const RESPONSIVE_CSS = '<style>.scroll-strip { overflow-x: auto; } .scroll-strip-content { width: 900px; } .off-canvas { position: fixed; top: 0; left: 100%; width: 320px; } @media (max-width: 639px) { .too-wide { width: 640px; } }</style>';

function pageDocument({ route, mode, repaired, port, deployVersion, shift = 0, overflow = false }) {
  const isClone = mode === 'clone';
  const cloneNeedsRepair = isClone && !repaired;
  const extraCloneClass = cloneNeedsRepair ? ' clone-only-runtime' : '';
  const moreControls = cloneNeedsRepair ? `
    <button class="fixture-control" data-control-class="menu" data-action="more" aria-label="More" aria-expanded="false">More</button>
  ` : `
    <button class="fixture-control" data-control-class="menu" data-action="more" aria-label="More" aria-expanded="false">More</button>
    <button class="fixture-control" data-control-class="menu" data-action="more" aria-label="More" aria-expanded="false">More</button>
  `;
  const actionScript = route === '/home' ? `
    const addOverlay = () => {
      if (document.querySelector('[data-overlay="true"]')) return;
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      overlay.setAttribute('data-overlay', 'true');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', 'Fixture overlay');
      overlay.textContent = 'Overlay opened';
      document.querySelector('#overlay-root').append(overlay);
    };
    document.querySelectorAll('[data-action="more"]').forEach((control) => {
      control.addEventListener('click', () => {
        control.setAttribute('aria-expanded', 'true');
        addOverlay();
      });
    });
    const toggle = document.querySelector('[data-action="toggle"]');
    ${cloneNeedsRepair ? '' : `toggle?.addEventListener('click', () => {
      const active = toggle.getAttribute('aria-pressed') !== 'true';
      toggle.setAttribute('aria-pressed', String(active));
      toggle.setAttribute('data-state', active ? 'open' : 'closed');
      toggle.classList.toggle('toggle-on', active);
    });`}
    const overlayControl = document.querySelector('[data-action="overlay"]');
    ${cloneNeedsRepair ? '' : `overlayControl?.addEventListener('click', addOverlay);`}
    const addItem = document.querySelector('[data-action="dom"]');
    ${cloneNeedsRepair ? '' : `addItem?.addEventListener('click', () => {
      const item = document.createElement('li');
      item.className = 'added-item';
      item.textContent = 'Added item';
      document.querySelector('#items').append(item);
    });`}
  ` : '';
  const body = route === '/home' ? `
    <main class="page-shell${extraCloneClass}">
      <div data-visual-region="chrome" class="${cloneNeedsRepair ? 'clone-visual-defect' : ''}"><h1>Parity fixture</h1></div>
      <p class="readable-runtime">Readable stylesheet runtime class.</p>
      <p class="phantom">Declaration-text class fixture.</p>
      <div class="toolbar">
        ${moreControls}
        <button class="fixture-control motion-toggle motion-sampled${cloneNeedsRepair ? ' motion-defect' : ''}" data-control-class="toggle" data-action="toggle" data-state="closed" aria-label="Toggle" aria-pressed="false">Toggle</button>
        <button class="fixture-control" data-control-class="dead" aria-label="Dead button">Dead button</button>
        <button class="fixture-control" data-control-class="overlay-trigger" data-action="overlay" aria-label="Open overlay">Open overlay</button>
        <button class="fixture-control" data-control-class="dom-trigger" data-action="dom" aria-label="Add item">Add item</button>
        <a class="fixture-control" data-control-class="navigation" aria-label="Go destination" href="/destination">Go destination</a>
        <button class="fixture-control" data-control-class="destructive" aria-label="Delete account">Delete account</button>
      </div>
      ${cloneNeedsRepair ? '<h2>Clone-only heading</h2>' : ''}
      <ul id="items"></ul>
      <div id="overlay-root"></div>
    </main>
  ` : route === '/noise' ? `
    <main class="page-shell"><h1>Noisy timer</h1><p class="noise-value" id="noise-value">0</p><div data-control-region="noise-dead"><button class="fixture-control" data-control-class="dead" aria-label="Noisy dead button">Noisy dead button</button><button data-testid="duplicate-destructive-a" class="fixture-control" data-control-class="destructive" aria-label="Duplicate destructive">Duplicate destructive</button><button data-testid="duplicate-destructive-b" class="fixture-control" data-control-class="destructive" aria-label="Duplicate destructive">Duplicate destructive</button></div></main>
  ` : route === '/responsive' ? `
    <main class="page-shell" style="container-type: inline-size; container-name: shell"><h1>Responsive fixture</h1><p class="responsive-media-marker responsive-container-marker">Responsive marker.</p><p class="responsive-hover-marker">Hover marker.</p><div class="scroll-strip"><div class="scroll-strip-content">Wide content that scrolls inside its strip.</div></div>${overflow ? '<div class="too-wide">Too wide on phones.</div>' : ''}</main>
    <div class="off-canvas" aria-hidden="true">Off-canvas drawer</div>
  ` : route === '/assets' ? `
    <main class="page-shell"><h1>Asset fixture</h1><img src="/fixture.svg" alt="Fixture asset"><img src="/fixture.svg" alt="Repeated fixture asset"><div style="background-image: url('/fixture.svg')">Asset reference.</div></main>
  ` : route === '/incomplete-css' ? `
    <main class="page-shell"><h1>Incomplete CSS</h1><p class="incomplete-runtime">Cross-origin stylesheet candidate.</p></main>
  ` : route === '/broken-hydration' ? `
    <main class="page-shell"><h1>Broken hydration</h1><p data-hydration-error="true">Hydration deliberately failed.</p></main>
  ` : route === '/unverified-hydration' ? `
    <main class="page-shell"><h1>Unverified hydration</h1><p>Server-rendered content with Next-looking script evidence only.</p></main>
  ` : route === '/forms' ? FORMS_BODY.replace('<main class="page-shell">', `<main class="page-shell"${shift ? ` style="margin-left: ${shift}px"` : ''}>`) : route === '/plain-hydrated' ? `
    <main class="page-shell"><h1>Plain hydrated</h1><p>A hydration marker without a Next.js runtime.</p></main>
  ` : route === '/late-hydration' ? `
    <main class="page-shell"><h1>Late hydration</h1><button class="fixture-control" data-action="late" aria-label="Late action">Late action</button><p id="late-result"></p></main>
  ` : `
    <main class="page-shell"><h1>Destination</h1><p>Navigation reached its destination.</p></main>
  `;
  const extraHead = `${route === '/forms' ? FORMS_CSS : ''}${route === '/responsive' ? RESPONSIVE_CSS : ''}${route === '/incomplete-css' ? `<link rel="stylesheet" href="http://localhost:${port}/fixture-incomplete.css">` : ''}${isClone ? '<style>.motion-toggle { transform: none; rotate: 0deg; } .motion-toggle[data-state="open"] { transform: none; rotate: 90deg; }</style>' : ''}`;
  const hydrationAttribute = route === '/unverified-hydration'
    ? ''
    : ` data-hydrated="${['/broken-hydration', '/late-hydration'].includes(route) ? 'false' : 'true'}"`;
  const homeHead = route === '/home'
    ? `<link rel="canonical" href="https://fixture.example/home"><script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Parity fixture"}</script>${cloneNeedsRepair ? '' : '<meta name="description" content="Parity fixture home">'}`
    : '';
  const noiseScript = route === '/noise' ? `
    let noise = 0;
    setInterval(() => { noise += 1; document.querySelector('#noise-value').textContent = String(noise); }, 25);
    ${cloneNeedsRepair ? "console.error('Hydration failed because the server rendered HTML did not match the client.');" : ''}
  ` : '';
  const crashScript = route === '/destination' && cloneNeedsRepair
    ? "setTimeout(() => { throw new Error('Fixture clone crash'); }, 0);"
    : '';
  const nextRuntimeScript = route === '/plain-hydrated'
    ? ''
    : 'window.__next_f = window.__next_f || [];\n      window.__next_f.push({ fixture: true });';
  const routeScript = route === '/forms' ? FORMS_SCRIPT : route === '/late-hydration' ? LATE_HYDRATION_SCRIPT : '';
  return `<!doctype html>
<html${hydrationAttribute}>
  <head>
    <meta charset="utf-8">
    <title>Parity fixture</title>
    <style>${COMMON_CSS}.real-content { content: ".phantom"; background-image: url('/fixture.svg'); }</style>
    ${extraHead}
    ${homeHead}
    <script src="/assets/app-${deployVersion}.js"></script>
  </head>
  <body>
    ${body}
    <script>
      ${nextRuntimeScript}
      ${actionScript}
      ${noiseScript}
      ${crashScript}
      ${routeScript}
    </script>
  </body>
</html>`;
}

// `shift` moves the /forms content right by that many CSS pixels, for image
// parity tests that need a measurably wrong clone. `overflow` adds a box to
// /responsive that is wider than a phone viewport.
export function startFixtureServer({ mode = 'source', repaired = false, host = '0.0.0.0', port = 0, deployVersion = 'a1', shift = 0, overflow = false } = {}) {
  if (!['source', 'clone'].includes(mode)) throw new Error(`Unsupported fixture mode: ${mode}`);
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (requestUrl.pathname === '/fixture-incomplete.css') {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
      response.end('.incomplete-runtime { color: darkorange; }');
      return;
    }
    if (requestUrl.pathname === '/fixture.svg') {
      response.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="seagreen"/></svg>');
      return;
    }
    if (requestUrl.pathname === `/assets/app-${deployVersion}.js`) {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      response.end(`window.__fixtureApp = ${JSON.stringify(deployVersion)};`);
      return;
    }
    if (requestUrl.pathname === '/sitemap.xml') {
      const origin = `http://${request.headers.host ?? 'localhost'}`;
      response.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store' });
      response.end(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/home</loc></url><url><loc>${origin}/destination</loc></url><url><loc>https://elsewhere.example/ignored</loc></url></urlset>`);
      return;
    }
    const allowed = new Set(['/home', '/noise', '/responsive', '/assets', '/incomplete-css', '/broken-hydration', '/unverified-hydration', '/destination', '/forms', '/plain-hydrated', '/late-hydration']);
    if (!allowed.has(requestUrl.pathname)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(pageDocument({ route: requestUrl.pathname, mode, repaired, port: server.address()?.port ?? port, deployVersion, shift, overflow }));
  });
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Fixture server did not expose a TCP port'));
        return;
      }
      resolve({
        mode,
        repaired,
        deployVersion,
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
        server,
        close: () => new Promise((closeResolve, closeReject) => server.close((error) => error ? closeReject(error) : closeResolve())),
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Set(process.argv.slice(2));
  const mode = args.has('--clone') ? 'clone' : 'source';
  const repaired = args.has('--repaired');
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex === -1 ? 0 : Number(process.argv[portIndex + 1]);
  const fixture = await startFixtureServer({ mode, repaired, port });
  console.log(`FIXTURE_READY ${fixture.url}`);
}
