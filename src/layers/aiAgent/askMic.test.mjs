// The held microphone behind ASK mode, walked through both shells: the
// Android bridge's own event channel and a Web Speech recogniser. The point of
// each test is that one press produces exactly one transcript (or one refusal),
// and that the microphone is never left open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASK_MIC_SILENCE_MS,
  askSpeechAvailable,
  createAskMic,
} from './askMic.js';

function fakeBridge() {
  const calls = [];
  return {
    calls,
    askDictate(locale) {
      calls.push(['ask', locale]);
      return true;
    },
    dictateStop() {
      calls.push(['stop']);
    },
    dictateCancel() {
      calls.push(['cancel']);
    },
  };
}

const flush = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

test('a shell without a question channel or a Web Speech engine cannot ask', () => {
  assert.equal(askSpeechAvailable({ bridge: {}, scope: {} }), false);
  assert.equal(askSpeechAvailable({ bridge: undefined, scope: {} }), false);
  assert.equal(
    askSpeechAvailable({ bridge: { askDictate() {} }, scope: {} }),
    true,
  );
  assert.equal(
    askSpeechAvailable({ bridge: {}, scope: { webkitSpeechRecognition() {} } }),
    true,
  );
  const silent = createAskMic({ bridge: {}, scope: {} });
  assert.equal(silent.available, false);
  assert.equal(silent.start(), false);
});

test('a native press opens the question channel and its final line is the transcript', () => {
  const bridge = fakeBridge();
  const scope = {};
  const heard = [];
  const errors = [];
  const mic = createAskMic({
    bridge,
    scope,
    locale: () => 'fr',
    onTranscript: (text) => heard.push(text),
    onError: (code) => errors.push(code),
  });

  assert.equal(typeof scope.__gevAskDictation, 'function');
  assert.equal(mic.start(), true);
  assert.deepEqual(bridge.calls, [['cancel'], ['ask', 'fr']]);

  // Progress is not an answer.
  scope.__gevAskDictation({ status: 'listening', text: '', message: '' });
  scope.__gevAskDictation({ status: 'partial', text: 'la', message: '' });
  assert.deepEqual(heard, []);

  scope.__gevAskDictation({
    status: 'final',
    text: '  la   plus grave ',
    message: '',
  });
  assert.deepEqual(heard, ['la plus grave']);
  assert.deepEqual(errors, []);

  // A late event from the finished session is not a second question.
  scope.__gevAskDictation({ status: 'final', text: 'total', message: '' });
  assert.deepEqual(heard, ['la plus grave']);
});

test('releasing a native press asks for the final line; an error is reported', () => {
  const bridge = fakeBridge();
  const scope = {};
  const heard = [];
  const errors = [];
  const mic = createAskMic({
    bridge,
    scope,
    onTranscript: (text) => heard.push(text),
    onError: (code) => errors.push(code),
  });

  mic.start();
  assert.equal(mic.stop(), true);
  assert.ok(
    bridge.calls.some(([name]) => name === 'stop'),
    'the release stops the recogniser',
  );
  scope.__gevAskDictation({
    status: 'final',
    text: 'combien d’alertes',
    message: '',
  });
  assert.deepEqual(heard, ['combien d’alertes']);

  mic.start();
  scope.__gevAskDictation({ status: 'error', text: '', message: 'permission' });
  assert.deepEqual(errors, ['permission']);
});

test('a shell that never answers releases the press on its own', async () => {
  const bridge = fakeBridge();
  const errors = [];
  const mic = createAskMic({
    bridge,
    scope: {},
    silenceMs: 5,
    onError: (code) => errors.push(code),
  });
  assert.ok(ASK_MIC_SILENCE_MS > 0);
  mic.start();
  await flush();
  assert.deepEqual(errors, ['no_match']);
  assert.equal(mic.stop(), false, 'the press is already over');
});

test('the Web Speech path listens in the operator language and aborts after a result', () => {
  const instances = [];
  class FakeRecognition {
    constructor() {
      instances.push(this);
    }
    start() {
      this.started = true;
    }
    stop() {
      this.stopped = true;
    }
    abort() {
      this.aborted = true;
    }
  }
  const heard = [];
  const errors = [];
  const mic = createAskMic({
    bridge: {},
    scope: { SpeechRecognition: FakeRecognition },
    locale: () => 'es',
    onTranscript: (text) => heard.push(text),
    onError: (code) => errors.push(code),
  });

  assert.equal(mic.start(), true);
  const first = instances[0];
  assert.equal(first.started, true);
  assert.equal(first.lang, 'es');
  assert.equal(first.continuous, true);
  first.onresult({
    results: [
      Object.assign([{ transcript: 'la siguiente' }], { isFinal: true }),
    ],
  });
  assert.deepEqual(heard, ['la siguiente']);
  assert.equal(first.aborted, true, 'the microphone closes after the answer');

  // A release finalizes a still-open press; the engine's end is the outcome.
  mic.start();
  const second = instances[1];
  assert.equal(mic.stop(), true);
  assert.equal(second.stopped, true);
  second.onend();
  assert.deepEqual(errors, ['no_match']);

  // A named engine failure reaches the layer with its code.
  mic.start();
  instances[2].onerror({ error: 'no-speech' });
  assert.deepEqual(errors, ['no_match', 'no_match']);
});

test('cancelling and destroying close the microphone without a transcript', () => {
  const bridge = fakeBridge();
  const scope = {};
  const heard = [];
  const mic = createAskMic({
    bridge,
    scope,
    onTranscript: (text) => heard.push(text),
  });
  mic.start();
  assert.equal(mic.cancel(), true);
  assert.ok(bridge.calls.some(([name]) => name === 'cancel'));
  scope.__gevAskDictation({ status: 'final', text: 'la plus grave', message: '' });
  assert.deepEqual(heard, []);

  mic.start();
  mic.destroy();
  assert.equal(mic.available, false);
  assert.equal(scope.__gevAskDictation, undefined);
  assert.equal(mic.start(), false);
});
