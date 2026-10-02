const OBSERVED_LIMIT = 4000;
const COVERAGE_FIELDS = [
  ['Visual regions', 'visualCoverage'],
  ['Motion and state', 'motionCoverage'],
  ['DOMSnapshot', 'domSnapshotCoverage'],
  ['Responsive', 'responsiveCoverage'],
  ['Assets', 'assetCoverage'],
  ['Accessibility tree', 'ariaCoverage'],
  ['Head metadata', 'headCoverage'],
  ['Load performance', 'performanceCoverage'],
  ['Runtime errors', 'runtimeErrorCoverage'],
  ['Image parity', 'imageParityCoverage'],
];

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

// Reports live in runs/<report-run>/report.html; evidence lives next to it.
function evidenceHref(evidence) {
  return `../${encodeURIComponent(evidence.runId)}/${evidence.artifact.split('/').map(encodeURIComponent).join('/')}`;
}

function evidenceText(evidence) {
  if (!evidence) return 'none';
  return `${evidence.runId} · ${evidence.artifact}${evidence.locator && evidence.locator !== '#' ? ` ${evidence.locator}` : ''}`;
}

function image(label, evidence) {
  if (!evidence?.runId || !evidence.artifact?.endsWith('.png')) return '';
  return `<figure><img loading="lazy" alt="${escapeHtml(`${label} region capture`)}" src="${escapeHtml(evidenceHref(evidence))}"><figcaption>${escapeHtml(label)}</figcaption></figure>`;
}

function observedText(observed) {
  if (observed === undefined) return '';
  const text = JSON.stringify(observed, null, 2) ?? '';
  return text.length > OBSERVED_LIMIT ? `${text.slice(0, OBSERVED_LIMIT)}\n… truncated (${text.length} characters)` : text;
}

function findingArticle(finding) {
  const comparator = finding.comparator ?? {};
  const images = [image('Source', finding.evidence?.source), image('Clone', finding.evidence?.clone), image('Difference', finding.evidence?.diff)].join('');
  const observed = observedText(finding.observed);
  return `<article class="finding ${finding.status === 'open' ? 'is-gate' : 'is-info'}">
<header><span class="badge">${escapeHtml(finding.status)}</span> <strong>${escapeHtml(finding.category)}</strong> <span class="muted">${escapeHtml([comparator.instrument, comparator.dimension, comparator.mode].filter(Boolean).join(' · '))}</span></header>
<p class="subject">${escapeHtml(JSON.stringify(finding.subject ?? {}))}</p>
${images ? `<div class="images">${images}</div>` : ''}
${observed ? `<details><summary>Observed values</summary><pre>${escapeHtml(observed)}</pre></details>` : ''}
<p class="evidence">Source: ${escapeHtml(evidenceText(finding.evidence?.source))}<br>Clone: ${escapeHtml(evidenceText(finding.evidence?.clone))}</p>
</article>`;
}

function coverageRows(report) {
  return COVERAGE_FIELDS
    .filter(([, key]) => report[key]?.configured)
    .map(([label, key]) => {
      const coverage = report[key];
      const details = Object.entries(coverage)
        .filter(([field, value]) => !['configured', 'complete'].includes(field) && (typeof value === 'number' || typeof value === 'string'))
        .map(([field, value]) => `${field}: ${value}`)
        .join(', ');
      return `<tr><th scope="row">${escapeHtml(label)}</th><td>${coverage.complete ? 'complete' : 'incomplete'}</td><td>${escapeHtml(details)}</td></tr>`;
    })
    .join('\n');
}

function formatValue(value) {
  return value === null || value === undefined ? '—' : String(value);
}

// Screenshot comparisons: the reference and clone side by side with their
// difference (a visual aid, not a score), then every anchor and region.
function imageParitySection(report, reportRunId) {
  const pages = report.imageParity?.pages ?? [];
  if (!pages.length) return '';
  const sections = pages.map((page) => {
    const views = page.views && reportRunId
      ? `<div class="images">${image('Reference', { runId: reportRunId, artifact: page.views.reference })}${image('Clone', { runId: reportRunId, artifact: page.views.clone })}${image('Difference', { runId: reportRunId, artifact: page.views.diff })}</div>`
      : '';
    const anchorRows = page.anchors.map((anchor) => `<tr><td>${escapeHtml(anchor.id)}</td><td>${escapeHtml(formatValue(anchor.reference))}</td><td>${escapeHtml(formatValue(anchor.clone))}</td><td>${escapeHtml(formatValue(anchor.delta))}</td><td>${escapeHtml(anchor.tolerance)}</td><td>${anchor.within ? 'within' : `<strong>${escapeHtml(anchor.mode === 'gate' ? 'gate' : 'outside')}</strong>`}</td></tr>`).join('\n');
    const regionRows = page.regions.map((region) => `<tr><td>${escapeHtml(region.id)}</td><td>${escapeHtml(region.mode)}</td><td>${escapeHtml(typeof region.diffRatio === 'number' ? `${(region.diffRatio * 100).toFixed(2)} %` : '—')}</td><td>${region.equal ? 'within' : '<strong>differs</strong>'}</td></tr>`).join('\n');
    return `<section class="route"><h3>${escapeHtml(page.page)} <span class="muted">${escapeHtml(page.route ?? '')}</span></h3>
${page.complete ? '' : '<p class="muted">Not compared: the capture or the reference is missing. See the findings.</p>'}
${views}
${anchorRows ? `<div class="scroll"><table><thead><tr><th>Anchor</th><th>Reference</th><th>Clone</th><th>Δ</th><th>Tolerance</th><th>Result</th></tr></thead><tbody>\n${anchorRows}\n</tbody></table></div>` : ''}
${regionRows ? `<div class="scroll"><table><thead><tr><th>Region</th><th>Mode</th><th>Different pixels</th><th>Result</th></tr></thead><tbody>\n${regionRows}\n</tbody></table></div>` : ''}
</section>`;
  }).join('\n');
  return `<section><h2>Image parity</h2>
<p>Anchors are probes run identically on the reference and on the clone captured at the reference scale. Differences are in CSS pixels, or RGB distance for colours. The page images are a visual aid, not a score.</p>
${report.notApplicable ? `<p class="muted">Not applicable to screenshot evidence: ${escapeHtml(report.notApplicable.join(', '))}.</p>` : ''}
${sections}
</section>`;
}

function rightsSection(assetRights) {
  if (!assetRights) return '';
  const summary = Object.entries(assetRights.summary ?? {}).map(([rightsClass, count]) => `<li>${escapeHtml(rightsClass)}: ${count}</li>`).join('');
  const rows = (assetRights.assets ?? []).map((asset) => `<tr><td>${escapeHtml(asset.rightsClass)}</td><td class="url">${escapeHtml(asset.url)}</td><td>${escapeHtml(asset.mime ?? '')}</td><td>${escapeHtml(asset.note)}</td></tr>`).join('\n');
  return `<section><h2>Source asset rights</h2>
<p>Informational. Check these before publishing a clone of a site you do not own.</p>
<ul>${summary}</ul>
<div class="scroll"><table><thead><tr><th>Class</th><th>URL</th><th>Type</th><th>Note</th></tr></thead><tbody>
${rows}
</tbody></table></div></section>`;
}

export function renderReportHtml(report, { reportRunId = report.reportRunId ?? null, assetRights = null } = {}) {
  const findings = report.findings ?? [];
  const groups = new Map();
  for (const finding of findings) {
    const route = finding.subject?.route ?? 'Site-wide';
    if (!groups.has(route)) groups.set(route, []);
    groups.get(route).push(finding);
  }
  const gates = findings.filter((finding) => finding.status === 'open').length;
  const findingSections = [...groups.entries()]
    .sort(([left], [right]) => String(left).localeCompare(String(right)))
    .map(([route, entries]) => `<section class="route"><h3>${escapeHtml(route)}</h3>\n${entries.map(findingArticle).join('\n')}</section>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parity report ${escapeHtml(reportRunId ?? '')}</title>
<style>
:root { color-scheme: light dark; --bg: #fff; --fg: #1b1b1f; --muted: #5f6368; --line: #d9d9de; --gate: #b3261e; --info: #0b57d0; --panel: #f6f7f9; }
@media (prefers-color-scheme: dark) { :root { --bg: #131316; --fg: #e8e8ec; --muted: #a0a4ab; --line: #34353a; --gate: #f2b8b5; --info: #a8c7fa; --panel: #1d1e22; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 72rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
h1 { font-size: 1.6rem; margin: 0 0 0.5rem; }
h2 { font-size: 1.2rem; margin-top: 2rem; border-bottom: 1px solid var(--line); padding-bottom: 0.25rem; }
h3 { font-size: 1rem; margin: 1.5rem 0 0.5rem; font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
dt { color: var(--muted); }
dd { margin: 0; font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 0.35rem 0.5rem; vertical-align: top; }
.scroll { overflow-x: auto; }
.url { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
.finding { border: 1px solid var(--line); border-left: 4px solid var(--info); border-radius: 6px; padding: 0.75rem 1rem; margin: 0.75rem 0; background: var(--panel); }
.finding.is-gate { border-left-color: var(--gate); }
.badge { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
.muted, .subject, .evidence { color: var(--muted); font-size: 0.875rem; overflow-wrap: anywhere; }
.images { display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 0.5rem 0; }
figure { margin: 0; max-width: 100%; }
figure img { display: block; max-width: min(100%, 22rem); border: 1px solid var(--line); background: repeating-conic-gradient(#ccc 0% 25%, transparent 0% 50%) 50% / 16px 16px; }
figcaption { font-size: 0.8rem; color: var(--muted); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.8rem; }
</style>
</head>
<body>
<main>
<h1>Parity report</h1>
<dl>
<dt>Report run</dt><dd>${escapeHtml(reportRunId ?? 'unknown')}</dd>
<dt>Source run</dt><dd>${escapeHtml(report.sourceRunId)}</dd>
<dt>Clone run</dt><dd>${escapeHtml(report.cloneRunId)}</dd>
<dt>Findings</dt><dd>${gates} gate, ${findings.length - gates} informational</dd>
</dl>
<p>${escapeHtml(report.semantics?.parity ?? '')} ${escapeHtml(report.semantics?.milestone ?? '')}</p>
<section><h2>Measurement coverage</h2>
<div class="scroll"><table><thead><tr><th>Module</th><th>Status</th><th>Details</th></tr></thead><tbody>
${coverageRows(report)}
</tbody></table></div></section>
<section><h2>Findings</h2>
${findingSections || '<p>No findings. Coverage above shows what was compared.</p>'}
</section>
${imageParitySection(report, reportRunId)}
${rightsSection(assetRights)}
</main>
</body>
</html>
`;
}
