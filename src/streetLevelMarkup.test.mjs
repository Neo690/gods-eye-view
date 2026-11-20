import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { expandApplicationHtml } from '../build/application-html.js';
import {
  elementInner,
  queryElement,
  queryElements,
} from './testSupport/htmlMarkup.mjs';
import { readStylesheet } from './testSupport/readStylesheet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const html = expandApplicationHtml(read('index.html'));
const css = readStylesheet(path.join(ROOT, 'style.css'));
const panelCss = read('src/ui/styles/street-level.css');
const panelChrome = read('src/ui/panelChrome.js');
const layoutController = read('src/ui/panelLayoutController.js');

test('Street Level is a collapsible right-rail panel that starts collapsed', () => {
  // Tags are read, not spelled: Prettier wraps attributes onto their own
  // lines, and that must not read as a template change.
  const panel = queryElement(html, { id: 'street-level-panel' });
  assert.equal(panel?.tag, 'div');
  assert.deepEqual(panel.classes, ['panel-collapsible', 'collapsed']);
  assert.equal(panel.attrs['data-panel-id'], 'street-level-panel');

  assert.ok(
    queryElement(html, {
      tag: 'button',
      classes: ['panel-collapse-btn'],
      attrs: { 'data-collapse-target': 'street-level-panel' },
    }),
    'the collapse button targets the panel',
  );

  assert.ok(
    queryElements(html, { tag: 'span', classes: ['panel-title'] }).some(
      (span) => elementInner(html, span) === 'STREET LEVEL',
    ),
    'the panel is titled',
  );

  // Provider-neutral header: no vendor mark; the inner restores its scroll.
  assert.doesNotMatch(html, /sl-mark|mly-mark/);
  assert.ok(
    queryElement(html, {
      classes: ['street-level-panel-inner'],
      attrs: { 'data-rail-scroller': '' },
    }),
    'the panel body is the rail scroller',
  );
  assert.doesNotMatch(
    html,
    /mapillary-dock|sl-minimized|sl-3d-btn|sl-photoreal-btn/,
  );
});

test('the panel is registered with panel chrome, cockpit entry and the right rail', () => {
  assert.match(panelChrome, /\{ id: 'street-level-panel' \}/);
  assert.match(
    panelChrome,
    /COCKPIT_ENTRY_COLLAPSE_PANEL_IDS = Object\.freeze\(\[[\s\S]*'street-level-panel'/,
  );
  assert.match(
    panelChrome,
    /const isRightRail = \[[\s\S]*'street-level-panel'/,
  );
  assert.match(
    layoutController,
    /for \(const panel of \[[\s\S]*?this\._streetLevelPanel,[\s\S]*?\]\) \{[\s\S]*?stack\.insertBefore\(panel, globalContextPanel\)/,
  );
  assert.ok(css.includes('#right-context-rail > #street-level-panel'));
});

test('the key gate holds every filter, with the error line outside it', () => {
  const gate = queryElement(html, { id: 'sl-controls' });
  assert.ok(gate, 'the key gate is in the markup');
  assert.equal(gate.tag, 'fieldset');
  const inner = elementInner(html, gate);
  assert.match(inner, /data-sl-pano="all"/);
  assert.match(inner, /id="sl-since"/);
  assert.ok(
    html.indexOf('id="sl-error"') < gate.start,
    'the error line sits above the gate',
  );
  // The chips stay outside the gate, so their key tooltip is reachable.
  assert.ok(queryElement(html, { id: 'sl-provider-chips' }));
  assert.doesNotMatch(inner, /sl-provider-chips/);
  assert.equal(queryElement(html, { id: 'sl-error' }).attrs.role, 'alert');
});

test('each radiogroup is one tab stop, on its checked button', () => {
  for (const [group, checked] of [
    ['data-sl-render', 'letterbox'],
    ['data-sl-pano', 'all'],
  ]) {
    const radios = [
      ...html.matchAll(
        new RegExp(`<button\\s[^>]*${group}="([a-z]+)"[^>]*>`, 'g'),
      ),
    ];
    assert.ok(radios.length >= 2, group);
    for (const [tag, value] of radios)
      assert.equal(
        /tabindex="-1"/.test(tag),
        value !== checked,
        `${group}="${value}" roving tab stop`,
      );
  }
});

test('the Cyber theme frames the Street Level panel like its rail peers (P3)', () => {
  const cyber = read('src/ui/styles/cyber.css');
  const inner = (cyber.match(/\.recent-imagery-panel-inner,/g) || []).length;
  const panel = (cyber.match(/#recent-imagery-panel,/g) || []).length;
  assert.ok(inner > 0 && panel > 0);
  assert.equal(
    (cyber.match(/\.street-level-panel-inner,/g) || []).length,
    inner,
  );
  assert.equal((cyber.match(/#street-level-panel,/g) || []).length, panel);
  // A theme header rule must be able to outrank the panel's own.
  assert.doesNotMatch(panelCss, /#street-level-panel \.panel-header/);
});

test('OPEN STREET VIEW keeps its width beside a long coverage line', () => {
  // .scene-btn grows and shrinks (flex: 1) and loads after this stylesheet:
  // only a more specific rule keeps the button from being squeezed.
  assert.match(css, /\.scene-btn \{[^}]*flex: 1;/);
  assert.match(
    panelCss,
    /\.sl-meta-row \.sl-nearest-btn \{\s*flex: 0 0 auto;\s*\}/,
  );
  assert.match(panelCss, /\.sl-meta-row \.sl-meta \{[^}]*min-width: 0;/);
});
