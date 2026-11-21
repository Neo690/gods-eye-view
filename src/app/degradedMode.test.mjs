import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDegradedControls,
  phaseAvailable,
  unavailableFeatures,
} from './degradedMode.js';

function fakeControl(props = {}) {
  return {
    disabled: false,
    title: '',
    dataset: {},
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    ...props,
  };
}

function fakeHost(requires, controls, props = {}) {
  return {
    dataset: { requires },
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    querySelectorAll: () => controls,
    matches: () => false,
    ...props,
  };
}

test('a degraded boot is queryable by handlers that own no control', () => {
  const root = { querySelectorAll: () => [] };
  applyDegradedControls({ missing: ['controls'], root });
  assert.equal(phaseAvailable('scene'), true);
  assert.equal(phaseAvailable('controls'), false, 'the console never arrived');
  applyDegradedControls({ missing: [], root });
  assert.equal(phaseAvailable('controls'), true, 'a healthy boot forgets it');
});

test('a missing phase turns off its controls and leaves the rest alone', () => {
  const sceneStart = fakeControl();
  const sceneStop = fakeControl();
  const layerToggle = fakeControl();
  const root = {
    querySelectorAll: () => [
      fakeHost('tools', [sceneStart, sceneStop]),
      fakeHost('data', [layerToggle]),
    ],
  };

  assert.equal(applyDegradedControls({ missing: ['tools'], root }), 2);
  assert.equal(sceneStart.disabled, true);
  assert.equal(sceneStop.disabled, true);
  assert.equal(sceneStart.dataset.degraded, 'true');
  assert.equal(sceneStart.attributes.get('aria-disabled'), 'true');
  assert.equal(
    sceneStart.title,
    'Unavailable until you reload',
    'the control explains itself on hover',
  );
  assert.equal(layerToggle.disabled, false, 'a built phase keeps its controls');
  assert.equal(layerToggle.title, '');
});

test('a host that is itself a control is disabled too', () => {
  const draw = fakeControl({
    dataset: { requires: 'tools' },
    matches: (selector) => selector.includes('button'),
    querySelectorAll: () => [],
  });
  const root = { querySelectorAll: () => [draw] };

  assert.equal(applyDegradedControls({ missing: ['tools'], root }), 1);
  assert.equal(draw.disabled, true);
  assert.equal(draw.title, 'Unavailable until you reload');
});

test('an already-disabled control keeps what it said', () => {
  const control = fakeControl({ disabled: true, title: 'Needs a key' });
  const root = { querySelectorAll: () => [fakeHost('tools', [control])] };

  assert.equal(applyDegradedControls({ missing: ['tools'], root }), 0);
  assert.equal(control.title, 'Needs a key');
});

test('nothing missing, or no document, disables nothing', () => {
  const control = fakeControl();
  const root = { querySelectorAll: () => [fakeHost('tools', [control])] };
  assert.equal(applyDegradedControls({ missing: [], root }), 0);
  assert.equal(applyDegradedControls({ missing: ['tools'], root: null }), 0);
  assert.equal(control.disabled, false);
});

test('the features are named in readable words, not phase names', () => {
  assert.equal(unavailableFeatures([]), '');
  assert.equal(unavailableFeatures(['tools']), 'scenes, drawing and voice');
  assert.equal(
    unavailableFeatures(['data', 'tools']),
    'live data, scenes, drawing and voice',
  );
});
