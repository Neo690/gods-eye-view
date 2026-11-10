import assert from 'node:assert/strict';
import test from 'node:test';
import { compareGhostMapsAlerts, scoreGhostMapsAlert } from './severity.js';

const table = (rows) =>
  `<table>${rows
    .map(([label, value]) => `<tr><td>${label}</td><td>${value}</td></tr>`)
    .join('')}</table>`;

test('mass-casualty violence outranks a single incident and property crime', () => {
  const massStabbing = scoreGhostMapsAlert({
    name: 'MassStabbing',
    description: table([
      ['Event', 'MassStabbing'],
      ['Civilian Killed', '11'],
      ['Civilian Wounded', '6'],
    ]),
  });
  const ied = scoreGhostMapsAlert({
    name: 'IED',
    description: table([['Event', 'IED']]),
  });
  const vandalism = scoreGhostMapsAlert({
    name: 'Vandalism',
    description: table([['Event', 'Vandalism']]),
  });
  const protest = scoreGhostMapsAlert({
    name: 'ProtestDemonstrationSite',
    description: table([['Event', 'Protest']]),
  });

  assert.ok(massStabbing.score > ied.score);
  assert.ok(ied.score > vandalism.score);
  assert.ok(vandalism.score > protest.score);
  assert.equal(massStabbing.severity, 'emergency');
  assert.equal(ied.severity, 'warn');
  assert.equal(protest.severity, 'info');
});

test('one reported death already lifts a non-violent placemark', () => {
  const plain = scoreGhostMapsAlert({ name: 'Patrol' });
  const deadly = scoreGhostMapsAlert({
    name: 'Patrol',
    description: table([['Enemy Killed', '1']]),
  });
  assert.ok(deadly.score > plain.score + 30);
  assert.equal(deadly.summary, 'Patrol · 1 killed');
});

test('destroyed installations add weight, but never outweigh a killing', () => {
  const destroyed = scoreGhostMapsAlert({
    name: 'Safehouse',
    description: table([['OperationalStatus', 'Destroyed']]),
  });
  const killing = scoreGhostMapsAlert({
    name: 'Killing',
    description: table([['Civilian Killed', '1']]),
  });
  assert.ok(killing.score > destroyed.score);
  assert.ok(destroyed.score > scoreGhostMapsAlert({ name: 'Safehouse' }).score);
});

test('ranking is deterministic for equal scores', () => {
  const rows = [
    { name: 'Zulu', product: 'cip', index: 3, score: 90 },
    { name: 'Alpha', product: 'kinetic-30d', index: 1, score: 90 },
    { name: 'Alpha', product: 'cip', index: 9, score: 90 },
    { name: 'Alpha', product: 'cip', index: 2, score: 200 },
  ];
  const sorted = [...rows].sort(compareGhostMapsAlerts);
  assert.deepEqual(
    sorted.map((row) => `${row.product}:${row.index}`),
    ['cip:2', 'cip:9', 'kinetic-30d:1', 'cip:3'],
  );
});

test('missing and malformed fields score as an info placemark', () => {
  const alert = scoreGhostMapsAlert({
    name: null,
    description: 'not a table',
  });
  assert.equal(alert.score, 0);
  assert.equal(alert.severity, 'info');
  assert.equal(alert.summary, 'Report');
});
