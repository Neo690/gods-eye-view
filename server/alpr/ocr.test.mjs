import assert from 'node:assert/strict';
import test from 'node:test';

import { decodePlate, parsePlateConfig } from './ocr.js';

const CONFIG = `
max_plate_slots: 4
alphabet: '0123456789ABC_'
pad_char: '_'
img_height: 32
img_width: 96
image_color_mode: rgb
`;

/** A one-hot output where `word` fills the first slots. */
function oneHot(word, config, probability = 0.9) {
  const vocab = config.alphabet.length;
  const data = new Float32Array(config.slots * vocab);
  for (let slot = 0; slot < config.slots; slot += 1) {
    const char = word[slot] ?? config.padChar;
    data[slot * vocab + config.alphabet.indexOf(char)] = probability;
  }
  return { data, dims: [1, config.slots, vocab] };
}

test('the plate config keeps the alphabet, slots and input size', () => {
  const config = parsePlateConfig(CONFIG);
  assert.equal(config.alphabet, '0123456789ABC_');
  assert.equal(config.slots, 4);
  assert.equal(config.padChar, '_');
  assert.equal(config.height, 32);
  assert.equal(config.width, 96);
  assert.equal(config.colorMode, 'rgb');
});

test('a config without an alphabet is refused, not guessed', () => {
  assert.throws(
    () => parsePlateConfig('max_plate_slots: 7\n'),
    /no alphabet/,
  );
});

test('a config without a slot count is refused', () => {
  assert.throws(
    () => parsePlateConfig("alphabet: 'ABC'\n"),
    /max_plate_slots/,
  );
});

test('decoding joins the argmax of every slot', () => {
  const config = parsePlateConfig(CONFIG);
  const plate = decodePlate(oneHot('A1B', config), config);
  assert.equal(plate.text, 'A1B');
  assert.ok(plate.confidence > 0.89 && plate.confidence < 0.91);
  assert.equal(plate.perChar.length, 3);
});

test('trailing padding is stripped and left out of the confidence', () => {
  const config = parsePlateConfig(CONFIG);
  const output = oneHot('AB', config, 0.5);
  const vocab = config.alphabet.length;
  // Padding slots are near-certain in practice; they must not lift the score.
  for (let slot = 2; slot < config.slots; slot += 1)
    output.data[slot * vocab + config.alphabet.indexOf('_')] = 1;
  const plate = decodePlate(output, config);
  assert.equal(plate.text, 'AB');
  assert.ok(Math.abs(plate.confidence - 0.5) < 1e-6);
});

test('a plate that is nothing but padding is not a plate', () => {
  const config = parsePlateConfig(CONFIG);
  assert.equal(decodePlate(oneHot('', config), config), null);
});

test('an output whose width is not the alphabet is refused', () => {
  const config = parsePlateConfig(CONFIG);
  const output = oneHot('AB', config);
  const wrong = { data: output.data, dims: [1, config.slots, 5] };
  assert.equal(decodePlate(wrong, config), null);
});

test('the alphabet decides the characters, not an index table', () => {
  const config = { alphabet: 'AB', slots: 2, padChar: '-' };
  const data = new Float32Array([0.1, 0.9, 0.8, 0.2]);
  assert.equal(
    decodePlate({ data, dims: [1, 2, 2] }, config).text,
    'BA',
  );
});
