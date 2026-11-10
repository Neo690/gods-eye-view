// The place line ASK appends to an alert: offline country, coordinates in the
// operator's language, and the promise that a missing pack never costs the
// answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlertPlaces, formatAlertCoordinates } from './place.js';
import { setLocale } from '../../i18n/index.js';

const withLocale = (locale, run) => {
  setLocale(locale);
  try {
    return run();
  } finally {
    setLocale('en');
  }
};

test('coordinates read in the operator language with catalog directions', () => {
  withLocale('en', () =>
    assert.equal(formatAlertCoordinates(48.8566, 2.3522), '48.857° N, 2.352° E'),
  );
  withLocale('fr', () =>
    assert.equal(
      formatAlertCoordinates(-33.9249, -18.4241),
      '33,925° S, 18,424° O',
    ),
  );
  withLocale('ru', () =>
    assert.equal(
      formatAlertCoordinates(55.7558, 37.6173),
      '55,756° С, 37,617° В',
    ),
  );
  withLocale('zh-CN', () =>
    assert.equal(
      formatAlertCoordinates(-36.8485, 174.7633),
      '36.849° 南, 174.763° 东',
    ),
  );
});

test('before the country pack is warm, the answer still gives coordinates', async () => {
  const places = createAlertPlaces({
    loadLocator: async () => () => ({ name: 'France', iso2: 'FR' }),
  });
  assert.equal(places.ready, false);
  assert.equal(
    places.describe({ latDeg: 48.8566, lonDeg: 2.3522 }),
    '48.857° N, 2.352° E',
  );
  assert.equal(await places.warm(), true);
  assert.equal(places.ready, true);
  assert.equal(
    places.describe({ latDeg: 48.8566, lonDeg: 2.3522 }),
    'France · 48.857° N, 2.352° E',
  );
});

test('the country is named in the UI language, not the pack spelling', async () => {
  const places = createAlertPlaces({
    loadLocator: async () => () => ({ name: 'United States of America', iso2: 'US' }),
  });
  await places.warm();
  withLocale('fr', () =>
    assert.equal(
      places.describe({ latDeg: 40.71, lonDeg: -74.01 }),
      'États-Unis · 40,710° N, 74,010° O',
    ),
  );
});

test('water, a nameless territory and broken input lose only what is missing', async () => {
  const places = createAlertPlaces({
    // The pack has no country here, and a territory ICU cannot name falls back
    // to the pack's own label.
    loadLocator: async () => (lat, lon) =>
      lon === 0 ? null : { name: 'Akrotiri Sovereign Base Area', iso2: '-99' },
  });
  await places.warm();
  assert.equal(places.describe({ latDeg: 0, lonDeg: 0 }), '0.000° N, 0.000° E');
  assert.equal(
    places.describe({ latDeg: -5, lonDeg: 33 }),
    'Akrotiri Sovereign Base Area · 5.000° S, 33.000° E',
  );
  assert.equal(places.describe({}), '');
  assert.equal(places.describe({ latDeg: 'north', lonDeg: 2 }), '');
  assert.equal(places.describe({ latDeg: 200, lonDeg: 2 }), '');
});

test('a throwing country lookup or loader never breaks the answer', async () => {
  const throwing = createAlertPlaces({
    loadLocator: async () => () => {
      throw new Error('pack');
    },
  });
  await throwing.warm();
  assert.equal(
    throwing.describe({ latDeg: 10, lonDeg: 20 }),
    '10.000° N, 20.000° E',
  );

  const unavailable = createAlertPlaces({
    loadLocator: async () => {
      throw new Error('missing');
    },
  });
  assert.equal(await unavailable.warm(), false);
  assert.equal(unavailable.ready, false);
  assert.equal(
    unavailable.describe({ latDeg: 10, lonDeg: 20 }),
    '10.000° N, 20.000° E',
  );
});

test('warming twice keeps one pack load in flight', async () => {
  let loads = 0;
  const places = createAlertPlaces({
    loadLocator: async () => {
      loads += 1;
      return () => null;
    },
  });
  const [first, second] = await Promise.all([places.warm(), places.warm()]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(loads, 1);
  assert.equal(await places.warm(), true);
  assert.equal(loads, 1);
});
