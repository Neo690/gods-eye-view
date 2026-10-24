import { expandApplicationHtml } from '../build/application-html.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = expandApplicationHtml(readFileSync(new URL('../index.html', import.meta.url), 'utf8'));
const parameters = readFileSync(new URL('./ui/styleParameters.js', import.meta.url), 'utf8');

// Focused markup guards; actual computed names are checked in Chromium.
// Native labels and hidden inputs must not be treated as missing aria-labels.
test('HUD sliders and location search have descriptive explicit names', () => {
  for (const [id, name] of [
    ['scope-feather-slider', 'Scope edge feather'],
    ['bloom-intensity-slider', 'Bloom intensity'],
    ['sharpen-intensity-slider', 'Sharpen intensity'],
    ['location-search', 'Search location by name or coordinates'],
  ]) {
    const input = html.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];
    assert.ok(input, `${id} exists`);
    assert.ok(input.includes(`aria-label="${name}"`), `${id} has its descriptive name`);
  }
});

test('fields whose Enter does something ask the phone keyboard for it', () => {
  // Gboard's return key reaches the WebView as keydown "Unidentified" with
  // keyCode 229, which an Enter handler cannot see: the keyboard just closed
  // and the typed value was never committed. enterkeyhint turns the action key
  // into an editor action, which Chromium delivers as a real Enter keydown.
  for (const [id, hint] of [
    ['location-search', 'search'],
    ['draw-label-input', 'done'],
    ['sdr-frequency-input', 'done'],
  ]) {
    const input = html.match(
      new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`),
    )?.[0];
    assert.ok(input, `${id} exists`);
    assert.ok(
      input.includes(`enterkeyhint="${hint}"`),
      `${id} must offer a "${hint}" action key, not a plain return`,
    );
  }
});

test('the first-run checkbox keeps its native visible label', () => {
  // The span may carry a data-i18n extraction attribute; the native wrapping
  // label contract is what this guards.
  assert.match(html, /<label\b[^>]*class="first-run-suppress"[^>]*>\s*<input type="checkbox" data-first-run-suppress \/>\s*<span\b[^>]*>Don't show this again<\/span>\s*<\/label>/);
});

test('generated style sliders use the visible parameter label as their name', () => {
  assert.match(parameters, /label\.textContent\s*=\s*t\(metadata\.label\);/);
  assert.match(parameters, /ariaLabel:\s*t\(metadata\.label\)/);
});
