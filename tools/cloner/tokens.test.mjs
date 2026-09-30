import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractDesignTokens, renderDesignTokensMarkdown, renderThemeCss } from './tokens.mjs';

test('design tokens rank rendered style values and skip hidden or empty values', () => {
  const computedStyles = ['display', 'visibility', 'color', 'background-color', 'font-size', 'border-top-left-radius', 'box-shadow', 'padding-top', 'border-top-width', 'border-top-color'];
  const strings = ['block', 'visible', 'rgb(17, 17, 17)', 'rgba(0, 0, 0, 0)', '16px', '8px', 'none', '12px', '0px', 'rgb(46, 139, 87)', 'none-display', 'hidden', '1px', '0px 1px 2px rgba(0, 0, 0, 0.2)'];
  const style = (values) => computedStyles.map((property) => strings.indexOf(values[property]));
  const observation = {
    route: '/home',
    computedStyles,
    snapshot: {
      strings,
      documents: [{
        layout: {
          styles: [
            style({ display: 'block', visibility: 'visible', color: 'rgb(17, 17, 17)', 'background-color': 'rgba(0, 0, 0, 0)', 'font-size': '16px', 'border-top-left-radius': '8px', 'box-shadow': 'none', 'padding-top': '12px', 'border-top-width': '0px', 'border-top-color': 'rgb(17, 17, 17)' }),
            style({ display: 'block', visibility: 'visible', color: 'rgb(17, 17, 17)', 'background-color': 'rgb(46, 139, 87)', 'font-size': '16px', 'border-top-left-radius': '0px', 'box-shadow': '0px 1px 2px rgba(0, 0, 0, 0.2)', 'padding-top': '0px', 'border-top-width': '1px', 'border-top-color': 'rgb(46, 139, 87)' }),
            style({ display: 'block', visibility: 'hidden', color: 'rgb(46, 139, 87)', 'font-size': '16px' }),
          ],
        },
      }],
    },
  };
  const tokens = extractDesignTokens([observation], { runId: '20260914T000001Z_source_11111111', siteKey: 'tokens.example' });
  assert.equal(tokens.nodesAnalyzed, 2);
  assert.deepEqual(tokens.colors.text, [{ value: 'rgb(17, 17, 17)', count: 2 }]);
  assert.deepEqual(tokens.colors.surface, [{ value: 'rgb(46, 139, 87)', count: 1 }]);
  assert.deepEqual(tokens.colors.border, [{ value: 'rgb(46, 139, 87)', count: 1 }]);
  assert.deepEqual(tokens.radii, [{ value: '8px', count: 1 }]);
  assert.deepEqual(tokens.shadows, [{ value: '0px 1px 2px rgba(0, 0, 0, 0.2)', count: 1 }]);
  assert.deepEqual(tokens.spacing, [{ value: '12px', count: 1 }]);
  assert.match(renderThemeCss(tokens), /@theme \{\n {2}--color-text-1: rgb\(17, 17, 17\);/u);
  assert.match(renderDesignTokensMarkdown(tokens), /20260914T000001Z_source_11111111/u);
});
