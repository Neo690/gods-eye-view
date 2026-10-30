// Command dictation: the shell's transcript, the palette, and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DICTATION_METHOD,
  DICTATION_SILENCE_MS,
  createDictation,
  dictationAvailable,
  dictationMessage,
  dictationOutcome,
} from './dictation.js';

function fakeButton() {
  const listeners = new Map();
  return {
    hidden: true,
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    click() {
      listeners.get('click')?.();
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function fakeDocument(lang = 'fr') {
  return { documentElement: { getAttribute: () => lang } };
}

test('dictation is only available when the shell exposes the method', () => {
  assert.equal(dictationAvailable(undefined), false);
  assert.equal(dictationAvailable({}), false);
  assert.equal(dictationAvailable({ dictate: 'not a function' }), false);
  assert.equal(dictationAvailable({ [DICTATION_METHOD]: () => true }), true);
});

test('a final transcript becomes a palette query', () => {
  assert.deepEqual(dictationOutcome({ status: 'final', text: '  gares  ' }), {
    action: 'command',
    text: 'gares',
  });
});

test('an empty final transcript is a miss, not an empty search', () => {
  const outcome = dictationOutcome({ status: 'final', text: '   ' });
  assert.equal(outcome.action, 'toast');
  assert.equal(outcome.message, dictationMessage('no_match'));
});

test('progress events carry no outcome', () => {
  assert.deepEqual(dictationOutcome({ status: 'listening' }), {
    action: 'ignore',
  });
  assert.deepEqual(dictationOutcome({ status: 'partial', text: 'ga' }), {
    action: 'ignore',
  });
  assert.deepEqual(dictationOutcome(undefined), { action: 'ignore' });
  assert.deepEqual(dictationOutcome({ status: 'nonsense' }), {
    action: 'ignore',
  });
});

test('failures say what the operator can act on', () => {
  assert.match(dictationMessage('permission'), /permission/i);
  assert.match(dictationMessage('network'), /network/i);
  assert.match(dictationMessage('timeout'), /nothing was heard/i);
  assert.match(dictationMessage('no_recognizer'), /not available/i);
  assert.match(dictationMessage(''), /not available/i);
  assert.equal(
    dictationOutcome({ status: 'error', message: 'permission' }).action,
    'toast',
  );
});

test('no shell means no dictation, and nothing changes on screen', () => {
  const button = fakeButton();
  assert.equal(
    createDictation({ button, bridge: {}, documentRef: fakeDocument() }),
    null,
  );
  assert.equal(button.hidden, true);
  assert.equal(button.listenerCount, 0);
});

test('pressing the button asks the shell in the page language', () => {
  const button = fakeButton();
  const calls = [];
  const dictation = createDictation({
    button,
    bridge: { dictate: (locale) => calls.push(locale) },
    documentRef: fakeDocument('fr-FR'),
  });
  assert.equal(button.hidden, false, 'an available shell reveals the button');
  button.click();
  assert.deepEqual(calls, ['fr-FR']);
  assert.equal(button.attributes.get('aria-busy'), 'true');
  dictation.destroy();
});

test('a press that is already running does not start a second capture', () => {
  const button = fakeButton();
  const calls = [];
  const dictation = createDictation({
    button,
    bridge: { dictate: (locale) => calls.push(locale) },
    documentRef: fakeDocument(),
  });
  button.click();
  button.click();
  assert.equal(calls.length, 1);
  dictation.destroy();
});

test('the transcript opens the palette and the button goes quiet', () => {
  const button = fakeButton();
  const opened = [];
  const dictation = createDictation({
    button,
    bridge: { dictate() {} },
    openPalette: (text) => opened.push(text),
    documentRef: fakeDocument(),
  });
  dictation.handle({ status: 'listening' });
  dictation.handle({ status: 'final', text: 'couche trafic' });
  assert.deepEqual(opened, ['couche trafic']);
  assert.equal(button.attributes.get('aria-busy'), 'false');
  dictation.destroy();
});

test('a failure is reported as a toast and never opens the palette', () => {
  const button = fakeButton();
  const opened = [];
  const toasts = [];
  const dictation = createDictation({
    button,
    bridge: { dictate() {} },
    openPalette: (text) => opened.push(text),
    toast: (message) => toasts.push(message),
    documentRef: fakeDocument(),
  });
  dictation.handle({ status: 'error', message: 'network' });
  assert.deepEqual(opened, []);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /network/i);
  dictation.destroy();
});

test('a shell that throws is reported rather than leaving the button lit', () => {
  const button = fakeButton();
  const toasts = [];
  createDictation({
    button,
    bridge: {
      dictate() {
        throw new Error('recogniser unavailable');
      },
    },
    toast: (message) => toasts.push(message),
    documentRef: fakeDocument(),
  });
  button.click();
  assert.equal(button.attributes.get('aria-busy'), 'false');
  assert.equal(toasts.length, 1);
});

test('a shell that never answers releases the button', () => {
  return new Promise((resolve) => {
    const button = fakeButton();
    createDictation({
      button,
      bridge: { dictate() {} },
      documentRef: fakeDocument(),
      silenceMs: 40,
    });
    button.click();
    assert.equal(button.attributes.get('aria-busy'), 'true');
    setTimeout(() => {
      assert.equal(button.attributes.get('aria-busy'), 'false');
      resolve();
    }, 120);
  });
});

test('the production deadline is long enough for a spoken command', () => {
  assert.ok(DICTATION_SILENCE_MS >= 8_000);
});

test('destroy restores the button to hidden', () => {
  const button = fakeButton();
  const dictation = createDictation({
    button,
    bridge: { dictate() {} },
    documentRef: fakeDocument(),
  });
  dictation.destroy();
  assert.equal(button.hidden, true);
  assert.equal(button.listenerCount, 0);
  assert.equal(button.attributes.get('aria-busy'), 'false');
});
