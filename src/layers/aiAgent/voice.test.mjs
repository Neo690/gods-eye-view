// The Sentinel's voice: one headline per GhostMaps alert, through the device
// synthesiser. The engine is a seam here, so the mute, the cancellation and a
// silent device are all walkable without audio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlertVoice, MAX_ALERT_SPEECH_CHARS } from './voice.js';

class FakeUtterance {
  constructor(text) {
    this.text = text;
  }
}

function fakeEngine() {
  const spoken = [];
  const engine = {
    spoken,
    cancels: 0,
    speak(utterance) {
      spoken.push(utterance);
    },
    cancel() {
      engine.cancels += 1;
    },
  };
  return engine;
}

test('an alert is said aloud once, in the operator language, after cancelling the last one', () => {
  const engine = fakeEngine();
  const voice = createAlertVoice({
    speech: engine,
    utterance: FakeUtterance,
    locale: () => 'fr',
  });
  assert.equal(voice.announce('MassStabbing · 11 tués'), true);
  assert.equal(engine.spoken.length, 1);
  assert.equal(engine.spoken[0].text, 'MassStabbing · 11 tués');
  assert.equal(engine.spoken[0].lang, 'fr');

  // The tour moved on: the old headline is cancelled, not queued.
  assert.equal(voice.announce('Vandalism'), true);
  assert.equal(engine.cancels, 2);
  assert.equal(engine.spoken.length, 2);
});

test('a muted voice says nothing and silences the sentence in progress', () => {
  const engine = fakeEngine();
  const voice = createAlertVoice({ speech: engine, utterance: FakeUtterance });
  voice.announce('MassStabbing');
  voice.setEnabled(false);
  assert.equal(voice.isEnabled(), false);
  assert.equal(voice.announce('Vandalism'), false);
  assert.equal(engine.spoken.length, 1);
  assert.equal(engine.cancels >= 2, true, 'muting stops the open sentence');
  voice.setEnabled(true);
  assert.equal(voice.announce('Vandalism'), true);
  assert.equal(engine.spoken.length, 2);
});

test('an empty line, a silent device and a throwing engine are normal answers', () => {
  const engine = fakeEngine();
  const voice = createAlertVoice({ speech: engine, utterance: FakeUtterance });
  assert.equal(voice.announce(''), false);
  assert.equal(voice.announce('   \n  '), false);
  assert.equal(engine.spoken.length, 0);

  const withoutEngine = createAlertVoice({
    speech: null,
    utterance: FakeUtterance,
  });
  assert.equal(withoutEngine.announce('MassStabbing'), false);

  const withoutUtterance = createAlertVoice({
    speech: engine,
    utterance: null,
  });
  assert.equal(withoutUtterance.announce('MassStabbing'), false);

  const broken = createAlertVoice({
    speech: {
      speak() {
        throw new Error('the engine died');
      },
      cancel() {},
    },
    utterance: FakeUtterance,
  });
  assert.equal(broken.announce('MassStabbing'), false);
});

test('a long popup line is cut to a headline', () => {
  const engine = fakeEngine();
  const voice = createAlertVoice({ speech: engine, utterance: FakeUtterance });
  assert.equal(voice.announce('x'.repeat(MAX_ALERT_SPEECH_CHARS + 60)), true);
  assert.equal(engine.spoken[0].text.length, MAX_ALERT_SPEECH_CHARS);
});

test('a destroyed voice stops and never speaks again', () => {
  const engine = fakeEngine();
  const voice = createAlertVoice({ speech: engine, utterance: FakeUtterance });
  voice.announce('MassStabbing');
  voice.destroy();
  assert.equal(voice.announce('Vandalism'), false);
  assert.equal(engine.spoken.length, 1);
  assert.ok(engine.cancels >= 2);
});
