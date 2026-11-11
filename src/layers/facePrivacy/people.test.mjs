// src/layers/facePrivacy/people.test.mjs
// The headcount is honest about its basis: faces seen, never identities.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PEOPLE_BASIS,
  PEOPLE_LIMIT_NOTE,
  countPeople,
  peopleLabel,
  peopleSummary,
} from './people.js';

test('a headcount is the number of faces the detector found', () => {
  assert.equal(countPeople({ faces: [{}, {}, {}] }), 3);
  assert.equal(countPeople({ faces: [] }), 0);
  assert.equal(countPeople({}), 0);
  assert.equal(countPeople(null), 0);
  assert.equal(countPeople(undefined), 0);
  // A payload whose faces field is not a list cannot invent people.
  assert.equal(countPeople({ faces: 'three' }), 0);
});

test('the label states people, and never a negative or fractional count', () => {
  assert.match(peopleLabel(3), /3/);
  assert.match(peopleLabel(3), /people/i);
  assert.match(peopleLabel(1), /1/);
  assert.match(peopleLabel(0), /no person/i);
  assert.match(peopleLabel(-4), /no person/i);
  assert.match(peopleLabel(2.7), /2/);
  assert.match(peopleLabel('8'), /8/);
  assert.match(peopleLabel(Number.NaN), /no person/i);
});

test('a summary names the camera before the count', () => {
  assert.equal(
    peopleSummary({ cameraId: 'cam-7', count: 4 }).startsWith('cam-7 · '),
    true,
  );
  assert.match(peopleSummary({ cameraId: null, count: 2 }), /2/);
  assert.match(peopleSummary({}), /no person/i);
});

test('the basis and its limit travel with the feature', () => {
  assert.equal(PEOPLE_BASIS, 'scrfd-faces');
  assert.match(PEOPLE_LIMIT_NOTE, /facing away or hidden/);
  // The note must not promise an identity capability this build lacks.
  assert.doesNotMatch(PEOPLE_LIMIT_NOTE, /identif|match|recogni/i);
});
