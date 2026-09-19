import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { render } from '../scripts/build-tokens.mjs';

const tokens = JSON.parse(readFileSync(new URL('../../design/tokens.json', import.meta.url)));

test('tokens.css is up to date with design/tokens.json', () => {
  const onDisk = readFileSync(new URL('../tokens.css', import.meta.url), 'utf8');
  assert.equal(onDisk, render(tokens));
});
test('both themes define every colour', () => {
  const css = render(tokens);
  for (const k of Object.keys(tokens.dark)) {
    const v = '--' + k.replaceAll('_', '-') + ':';
    assert.equal(css.split(v).length - 1, 3, v); // dark, light, system-light
  }
});
function lum(hex) { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; }
function contrast(a, b) { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); }
test('text on bg and surface meets AA in both themes', () => {
  for (const t of ['dark', 'light']) for (const fg of ['text', 'text_soft', 'text_mute']) for (const bg of ['bg', 'surface'])
    assert.ok(contrast(tokens[t][fg], tokens[t][bg]) >= 4.5, `${t} ${fg} on ${bg}`);
});
test('text_mute stays quieter than text_soft in both themes', () => {
  for (const t of ['dark', 'light']) for (const bg of ['bg', 'surface'])
    assert.ok(contrast(tokens[t].text_mute, tokens[t][bg]) < contrast(tokens[t].text_soft, tokens[t][bg]), `${t} on ${bg}`);
});
