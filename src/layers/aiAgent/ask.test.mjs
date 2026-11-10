// ASK mode's brain: what a spoken question means and what the Sentinel
// answers. No DOM, no microphone, no model — a transcript in, a sentence out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASK_INTENTS,
  createAlertAnswerer,
  normalizeQuestion,
  readAskIntent,
} from './ask.js';
import { setLocale } from '../../i18n/index.js';

const alerts = [
  {
    id: 'cip:1',
    name: 'MassStabbing',
    folder: 'Syria',
    summary: 'MassStabbing · 11 killed',
    severity: 'emergency',
  },
  {
    id: 'cip:2',
    name: 'MissileStrike',
    folder: 'Ukraine',
    summary: 'MissileStrike · 2 killed',
    severity: 'emergency',
  },
  {
    id: 'cip:3',
    name: 'Vandalism',
    folder: 'Iraq',
    summary: 'Vandalism',
    severity: 'info',
  },
];

const withLocale = (locale, run) => {
  setLocale(locale);
  try {
    return run();
  } finally {
    setLocale('en');
  }
};

test('a question is recognized in every shipped language, punctuation and accents included', () => {
  assert.deepEqual(
    ['La plus grave ?', 'la plus dangereuse', 'most severe', 'la más grave'].map(
      readAskIntent,
    ),
    ['worst', 'worst', 'worst', 'worst'],
  );
  assert.deepEqual(
    ['et la suivante', 'next one', 'la siguiente', 'следующая'].map(
      readAskIntent,
    ),
    ['next', 'next', 'next', 'next'],
  );
  assert.deepEqual(
    ['combien d’alertes', 'how many alerts', 'cuántas alertas', '总数'].map(
      readAskIntent,
    ),
    ['total', 'total', 'total', 'total'],
  );
  assert.deepEqual(
    ['répète', 'say that again', 'otra vez', '重复'].map(readAskIntent),
    ['repeat', 'repeat', 'repeat', 'repeat'],
  );
  // Arabic alef and ta marbuta are folded, so a transcript written with
  // different glyphs still asks the same question.
  assert.equal(readAskIntent('الأخطر؟'), 'worst');
  assert.equal(readAskIntent('التالية'), 'next');
  // Anything else is not one of the four answers.
  assert.equal(readAskIntent('bonjour'), null);
  assert.equal(readAskIntent(''), null);
  assert.equal(readAskIntent(undefined), null);
  assert.deepEqual(ASK_INTENTS, ['worst', 'next', 'total', 'repeat']);
});

test('the question normalizer keeps letters in every script and drops noise', () => {
  assert.equal(normalizeQuestion('  La PLUS grave, svp ! '), 'la plus grave svp');
  assert.equal(normalizeQuestion('répète'), 'repete');
  assert.equal(normalizeQuestion('Следующая?'), 'следующая');
  assert.equal(normalizeQuestion('最严重！'), '最严重');
});

test('the most severe answer names the first ranked alert and where it is', () => {
  withLocale('fr', () => {
    const answerer = createAlertAnswerer();
    const answer = answerer.answer(alerts, readAskIntent('la plus grave'));
    assert.equal(answer.intent, 'worst');
    assert.equal(answer.alertId, 'cip:1');
    assert.equal(answer.text, 'La plus grave : MassStabbing · 11 killed · Syria');
  });
});

test('next walks the ranking in order and wraps back to the most severe alert', () => {
  const answerer = createAlertAnswerer();
  const ask = (text) => answerer.answer(alerts, readAskIntent(text));
  assert.equal(ask('next').alertId, 'cip:1', 'next from nowhere is the first');
  assert.equal(ask('la suivante').alertId, 'cip:2');
  assert.equal(ask('next').alertId, 'cip:3');
  assert.equal(ask('next').alertId, 'cip:1', 'past the last, back to the top');
  // Asking for the worst alert again resets the walk to the top.
  assert.equal(ask('la plus grave').alertId, 'cip:1');
  assert.equal(ask('next').alertId, 'cip:2');
});

test('the total counts the loaded alerts and the emergencies among them', () => {
  withLocale('fr', () => {
    const answerer = createAlertAnswerer();
    assert.equal(
      answerer.answer(alerts, 'total').text,
      '3 alertes chargées · 2 urgences',
    );
  });
  withLocale('en', () => {
    const answerer = createAlertAnswerer();
    assert.equal(
      answerer.answer(alerts, 'total').text,
      '3 alerts loaded · 2 emergencies',
    );
  });
});

test('repeat says the last answer, and has something to say before any question', () => {
  withLocale('fr', () => {
    const answerer = createAlertAnswerer();
    assert.equal(answerer.answer(alerts, 'repeat').text, "Rien à répéter pour l'instant.");
    answerer.answer(alerts, 'worst');
    const repeated = answerer.answer(alerts, 'repeat');
    assert.equal(repeated.text, 'La plus grave : MassStabbing · 11 killed · Syria');
    assert.equal(repeated.alertId, null);
  });
});

test('a question outside the four gets the menu, and an empty layer says so', () => {
  const answerer = createAlertAnswerer();
  const menu = answerer.answer(alerts, readAskIntent('bonjour'));
  assert.equal(menu.intent, null);
  assert.match(menu.text, /most severe alert/i);

  const counted = createAlertAnswerer();
  const total = counted.answer(alerts, 'total');
  assert.equal(counted.answer(alerts, 'repeat').text, total.text);

  const empty = counted.answer([], 'worst');
  assert.equal(empty.alertId, null);
  assert.match(empty.text, /no ghostmaps alerts/i);
  // Repeat repeats whatever was said last, including an empty layer.
  assert.equal(counted.answer([], 'repeat').text, empty.text);
});
