import assert from 'node:assert/strict';
import test from 'node:test';

import {
  elementInner,
  markupElements,
  queryElement,
  queryElements,
} from '../testSupport/htmlMarkup.mjs';

test('attributes wrapped onto several lines are read as one element', () => {
  const html = [
    '<div',
    '  id="panel"',
    '  class="panel-collapsible collapsed"',
    '  data-panel-id="panel"',
    '>',
  ].join('\n');
  const element = queryElement(html, { id: 'panel' });
  assert.equal(element.tag, 'div');
  assert.deepEqual(element.classes, ['panel-collapsible', 'collapsed']);
  assert.equal(element.attrs['data-panel-id'], 'panel');
});

test('a > inside a quoted attribute does not end the tag', () => {
  const html = '<button title="a > b" class="x">Go</button>';
  const button = queryElement(html, { tag: 'button' });
  assert.equal(button.attrs.title, 'a > b');
  assert.equal(elementInner(html, button), 'Go');
});

test('inner content is the range between the tags, nested names included', () => {
  const html =
    '<fieldset id="g"><div><input id="a"></div><div id="b">x</div></fieldset><p id="after">ok</p>';
  const gate = queryElement(html, { id: 'g' });
  assert.match(elementInner(html, gate), /id="b"/);
  assert.doesNotMatch(elementInner(html, gate), /id="after"/);
  assert.equal(queryElement(html, { id: 'after' }).tag, 'p');
});

test('void tags do not swallow what follows them', () => {
  const html = '<label>Name<input id="field"></label><span id="next">x</span>';
  assert.equal(queryElement(html, { id: 'next' }).tag, 'span');
  assert.equal(elementInner(html, queryElement(html, { id: 'field' })), '');
});

test('same-name nesting closes in order, and an unbalanced tag still yields a range', () => {
  const html = '<div class="outer"><div class="inner">x</div></div>';
  const [outer, inner] = queryElements(html, { tag: 'div' });
  assert.equal(elementInner(html, inner), 'x');
  assert.equal(elementInner(html, outer).trim(), '<div class="inner">x</div>');

  const open = '<div id="only"><span>a</span>';
  assert.equal(
    elementInner(open, queryElement(open, { id: 'only' })),
    '<span>a</span>',
  );
});

test('a bare attribute reads as empty, and matching can require it', () => {
  const html = '<span class="panel-title" data-i18n>STREET LEVEL</span>';
  const titled = queryElement(html, {
    classes: ['panel-title'],
    attrs: { 'data-i18n': '' },
  });
  assert.ok(titled);
  assert.deepEqual(
    markupElements(html).map(({ tag }) => tag),
    ['span'],
  );
});
