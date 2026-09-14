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
`;

function pageDocument({ route, mode, repaired, port }) {
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
      <div class="toolbar">
        ${moreControls}
        <button class="fixture-control motion-toggle motion-sampled${cloneNeedsRepair ? ' motion-defect' : ''}" data-control-class="toggle" data-action="toggle" data-state="closed" aria-label="Toggle" aria-pressed="false">Toggle</button>
        <button class="fixture-control" data-control-class="dead" aria-label="Dead button">Dead button</button>
        <button class="fixture-control" data-control-class="overlay-trigger" data-action="overlay" aria-label="Open overlay">Open overlay</button>
        <button class="fixture-control" data-control-class="dom-trigger" data-action="dom" aria-label="Add item">Add item</button>
        <a class="fixture-control" data-control-class="navigation" aria-label="Go destination" href="/destination">Go destination</a>
        <button class="fixture-control" data-control-class="destructive" aria-label="Delete account">Delete account</button>
      </div>
      <ul id="items"></ul>
      <div id="overlay-root"></div>
    </main>
  ` : route === '/noise' ? `
    <main class="page-shell"><h1>Noisy timer</h1><p class="noise-value" id="noise-value">0</p><div data-control-region="noise-dead"><button class="fixture-control" data-control-class="dead" aria-label="Noisy dead button">Noisy dead button</button></div></main>
  ` : route === '/responsive' ? `
    <main class="page-shell" style="container-type: inline-size; container-name: shell"><h1>Responsive fixture</h1><p class="responsive-media-marker responsive-container-marker">Responsive marker.</p></main>
  ` : route === '/incomplete-css' ? `
    <main class="page-shell"><h1>Incomplete CSS</h1><p class="incomplete-runtime">Cross-origin stylesheet candidate.</p></main>
  ` : route === '/broken-hydration' ? `
    <main class="page-shell"><h1>Broken hydration</h1><p data-hydration-error="true">Hydration deliberately failed.</p></main>
  ` : route === '/unverified-hydration' ? `
    <main class="page-shell"><h1>Unverified hydration</h1><p>Server-rendered content with Next-looking script evidence only.</p></main>
  ` : `
    <main class="page-shell"><h1>Destination</h1><p>Navigation reached its destination.</p></main>
  `;
  const extraHead = `${route === '/incomplete-css' ? `<link rel="stylesheet" href="http://localhost:${port}/fixture-incomplete.css">` : ''}${isClone ? '<style>.motion-toggle { transform: none; rotate: 0deg; } .motion-toggle[data-state="open"] { transform: none; rotate: 90deg; }</style>' : ''}`;
  const hydrationAttribute = route === '/unverified-hydration'
    ? ''
    : ` data-hydrated="${route === '/broken-hydration' ? 'false' : 'true'}"`;
  const noiseScript = route === '/noise' ? `
    let noise = 0;
    setInterval(() => { noise += 1; document.querySelector('#noise-value').textContent = String(noise); }, 25);
  ` : '';
  return `<!doctype html>
<html${hydrationAttribute}>
  <head>
    <meta charset="utf-8">
    <title>Parity fixture</title>
    <style>${COMMON_CSS}</style>
    ${extraHead}
  </head>
  <body>
    ${body}
    <script>
      window.__next_f = window.__next_f || [];
      window.__next_f.push({ fixture: true });
      ${actionScript}
      ${noiseScript}
    </script>
  </body>
</html>`;
}

export function startFixtureServer({ mode = 'source', repaired = false, host = '0.0.0.0', port = 0 } = {}) {
  if (!['source', 'clone'].includes(mode)) throw new Error(`Unsupported fixture mode: ${mode}`);
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (requestUrl.pathname === '/fixture-incomplete.css') {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
      response.end('.incomplete-runtime { color: darkorange; }');
      return;
    }
    const allowed = new Set(['/home', '/noise', '/responsive', '/incomplete-css', '/broken-hydration', '/unverified-hydration', '/destination']);
    if (!allowed.has(requestUrl.pathname)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(pageDocument({ route: requestUrl.pathname, mode, repaired, port: server.address()?.port ?? port }));
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
