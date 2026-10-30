/**
 * Limb check for the solar-storm aurora oval.
 *
 * The layer hides each aurora point with Cesium's EllipsoidalOccluder inside
 * scene.preRender (src/layers/spaceWeather/index.js, cullHorizon). This script
 * runs that exact predicate (with its hysteresis) against the cells the route
 * actually draws, from today's real OVATION grid, while the camera orbits the
 * globe the way a mouse drag moves it — then reports whether a cell ever flips
 * visibility more than once (flicker), whether a hand jittering on the limb
 * blinks the edge, and how far past the horizon any drawn cell reaches.
 *
 *   node scripts/qa-aurora-limb.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { createHorizonCuller } from '../src/layers/spaceWeather/horizon.js';
import { normalizeAuroraGrid } from '../src/layers/spaceWeather/records.js';

const OVATION_URL =
  'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
// A saved grid keeps the run offline; otherwise read the live one, which is
// what the layer draws after the route's three-minute cache expires.
const payload = existsSync('.tmp-ovation.json')
  ? JSON.parse(readFileSync('.tmp-ovation.json', 'utf8'))
  : await (await fetch(OVATION_URL)).json();
const grid = normalizeAuroraGrid(payload);
if (!grid) throw new Error('No aurora grid in the payload');
const cells = grid.points.map(([lon, lat, probability]) => ({
  lon,
  lat,
  probability,
  position: Cesium.Cartesian3.fromDegrees(lon, lat),
}));
console.log(
  `cells drawn: ${cells.length} (peak ${grid.peak.probability}% at ${grid.peak.lat}, ${grid.peak.lon})`,
);

const culler = createHorizonCuller();
const ALTITUDE_M = 12_000_000;
const CAMERA_LAT = 35;
const shown = new Uint8Array(cells.length);

/** The layer's own frame: set the camera, then ask each cell with its state. */
function visibleMask(lonDeg, latDeg = CAMERA_LAT, height = ALTITUDE_M) {
  const cameraPosition = Cesium.Cartesian3.fromDegrees(
    lonDeg,
    latDeg,
    height,
  );
  culler.setCamera(cameraPosition);
  for (let i = 0; i < cells.length; i++) {
    const next = culler.isVisible(cells[i].position, shown[i] === 1);
    shown[i] = next ? 1 : 0;
  }
  return shown.slice();
}

const camera = new Cesium.Cartesian3();

/** Angle between the camera direction and the cell, in degrees from the centre. */
function angleFromCamera(cell, lonDeg, latDeg = CAMERA_LAT) {
  Cesium.Cartesian3.fromDegrees(lonDeg, latDeg, ALTITUDE_M, undefined, camera);
  const cos =
    Cesium.Cartesian3.dot(cell.position, camera) /
    (Cesium.Cartesian3.magnitude(cell.position) *
      Cesium.Cartesian3.magnitude(camera));
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

/** The visible cap's radius in degrees for this camera altitude. */
const CAP_DEG =
  (Math.acos(6371008.8 / (6371008.8 + ALTITUDE_M)) * 180) / Math.PI;

// ── One steady drag around the planet, 0.1° per frame ────────────────────────
const STEP_DEG = 0.1;
const frames = Math.round(360 / STEP_DEG);
const flips = new Int32Array(cells.length);
const runs = new Uint16Array(cells.length);
const previous = new Uint8Array(cells.length);
const first = new Uint8Array(cells.length);
let beyondHorizon = 0;
let worstAngle = 0;
let maxVisible = 0;
let visibleSamples = 0;

for (let frame = 0; frame < frames; frame++) {
  const lon = -180 + frame * STEP_DEG;
  const mask = visibleMask(lon);
  let visible = 0;
  for (let i = 0; i < cells.length; i++) {
    if (mask[i]) {
      visible++;
      visibleSamples++;
      const angle = angleFromCamera(cells[i], lon);
      if (angle > CAP_DEG + 0.5) beyondHorizon++;
      if (angle > worstAngle) worstAngle = angle;
    }
    if (!first[i]) {
      first[i] = 1;
      previous[i] = mask[i];
      continue;
    }
    if (mask[i] !== previous[i]) {
      flips[i]++;
      if (mask[i]) runs[i]++;
      previous[i] = mask[i];
    }
  }
  maxVisible = Math.max(maxVisible, visible);
}

let flickering = 0;
let cellsNeverVisible = 0;
let cellsAlwaysVisible = 0;
let maxFlips = 0;
for (let i = 0; i < cells.length; i++) {
  const transitions = flips[i];
  if (transitions > 2) flickering++;
  if (transitions === 0) {
    if (previous[i]) cellsAlwaysVisible++;
    else cellsNeverVisible++;
  }
  maxFlips = Math.max(maxFlips, transitions);
}

console.log(`orbit: ${frames} frames at ${STEP_DEG}° steps`);
console.log(`visible cells at once: max ${maxVisible}`);
console.log(`cells with more than 2 transitions: ${flickering}`);
console.log(`max transitions for one cell: ${maxFlips}`);
console.log(`cells never visible in a full orbit: ${cellsNeverVisible}`);
console.log(`cells visible the whole orbit: ${cellsAlwaysVisible}`);
console.log(
  `cells drawn past the horizon (cap ${CAP_DEG.toFixed(1)}°): ${beyondHorizon}`,
);
console.log(`worst drawn angle: ${worstAngle.toFixed(2)}°`);
console.log(
  `visible-share of samples: ${((visibleSamples / (frames * cells.length)) * 100).toFixed(2)}%`,
);

// ── A hand jittering at the limb: ±0.02° around one heading ──────────────────
const jitterFlips = new Int32Array(cells.length);
const jitterPrev = new Uint8Array(cells.length);
const jitterFirst = new Uint8Array(cells.length);
let jitterToggles = 0;
for (let frame = 0; frame < 240; frame++) {
  const lon = 0 + Math.sin((frame / 240) * Math.PI * 8) * 0.02;
  const mask = visibleMask(lon);
  for (let i = 0; i < cells.length; i++) {
    if (!jitterFirst[i]) {
      jitterFirst[i] = 1;
      jitterPrev[i] = mask[i];
      continue;
    }
    if (mask[i] !== jitterPrev[i]) {
      jitterFlips[i]++;
      jitterToggles++;
      jitterPrev[i] = mask[i];
    }
  }
}
console.log(`\njitter (±0.02°): total toggles ${jitterToggles}`);
const worst = [...jitterFlips.keys()]
  .sort((a, b) => jitterFlips[b] - jitterFlips[a])
  .slice(0, 5)
  .filter((i) => jitterFlips[i] > 0);
for (const i of worst)
  console.log(
    `  cell ${cells[i].lon},${cells[i].lat} (${cells[i].probability}%) toggled ${jitterFlips[i]}x`,
  );
