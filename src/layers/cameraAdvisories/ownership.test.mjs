import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';

import {
  createCameraAdvisoriesLayer,
  CAMERA_ADVISORIES_ROUTE,
  createCameraAdvisoriesSource,
} from './index.js';
import { layerFeedState } from '../../data/feedState.js';

const finding = (id, lat, severity, colourScore) => ({
  id,
  name: `camera ${id}`,
  lat,
  lon: -122.3,
  brand: 'axis',
  model: 'Q6135-LE',
  matches: [
    {
      source: 'nvd',
      id: 'CVE-2024-0001',
      title: 'Axis Q6135-LE firmware allows remote code execution.',
      url: 'https://nvd.nist.gov/vuln/detail/CVE-2024-0001',
      published: '2024-01-02T00:00:00.000Z',
      score: colourScore,
      severity,
      cves: ['CVE-2024-0001'],
      match: 'model',
    },
  ],
  worstSeverity: severity,
  worstScore: colourScore,
});

const snapshot = () => ({
  generatedAt: '2026-11-06T10:00:00.000Z',
  findings: [
    finding('kc-1', 47.6, 'critical', 9.8),
    finding('kc-2', 47.61, 'medium', 5.3),
  ],
  counts: {
    critical: 1,
    high: 0,
    medium: 1,
    low: 0,
    unscored: 0,
    flagged: 2,
    advisories: 2,
    brandOnlyAdvisories: 3,
    truncated: false,
  },
  cameras: {
    total: 4,
    identified: 2,
    brands: [{ id: 'axis', cameras: 2, queried: true }],
  },
  sources: [
    { id: 'cisa-csaf', ok: true, advisories: 1 },
    { id: 'nvd', ok: true, advisories: 1 },
  ],
  firmwareObserved: false,
  deviceContact: 'none',
  ageMs: 0,
  stale: false,
});

/** A viewer that records the primitive collection and what it holds. */
function harness(getSnapshot) {
  const primitives = [];
  const viewer = {
    camera: { moveStart: new Cesium.Event() },
    scene: {
      requestRender() {},
      primitives: {
        add(value) {
          primitives.push(value);
          return value;
        },
        remove(value) {
          const index = primitives.indexOf(value);
          if (index >= 0) primitives.splice(index, 1);
        },
      },
    },
  };
  const layer = createCameraAdvisoriesLayer({
    source: { getSnapshot: (...args) => getSnapshot(...args) },
  });
  layer.init(viewer);
  return { layer, viewer, primitives, collection: () => primitives[0] };
}

test('disabled layers fetch nothing; enabled ones draw one marker per finding', async () => {
  let asked = 0;
  const h = harness(async () => {
    asked += 1;
    return snapshot();
  });
  assert.equal(await h.layer.update(), false);
  assert.equal(asked, 0);
  h.layer.enable();
  assert.equal(await h.layer.update(), true);
  assert.equal(asked, 1);
  assert.equal(h.collection().length, 2);
  assert.equal(
    h.collection().get(0).color.toCssHexString(),
    Cesium.Color.fromCssColorString('#ff3b5c').toCssHexString(),
  );
  assert.equal(
    h.collection().get(1).color.toCssHexString(),
    Cesium.Color.fromCssColorString('#ffd166').toCssHexString(),
  );

  const controls = h.layer.getRowControls();
  assert.equal(controls.legend.length, 5);
  assert.equal(controls.legend[0].count, 1);
  assert.equal(controls.list.items.length, 2);
  assert.match(controls.list.items[0].lead, /9\.8/);
  assert.match(controls.info, /2 cameras with published advisories/);
  assert.match(controls.info, /no device contacted/);
  assert.match(controls.info, /firmware not observed/);

  const stats = h.layer.getStats();
  assert.equal(stats.count, 2);
  assert.equal(stats.error, null);
  assert.equal(layerFeedState(stats), 'nominal');
  const records = h.layer.getAnalystRecords();
  assert.equal(records[0].severity, 'critical');
  assert.deepEqual(records[0].cves, ['CVE-2024-0001']);
  h.layer.destroy();
  assert.equal(h.primitives.length, 0);
});

test('a failed read keeps its error and schedules a retry', async () => {
  const h = harness(async () => {
    throw Object.assign(new Error('Camera-advisory feed unavailable (HTTP 502)'), {
      retryable: true,
      retryAfterMs: 30000,
    });
  });
  h.layer.enable();
  assert.equal(await h.layer.update(), false);
  const stats = h.layer.getStats();
  assert.match(stats.error, /HTTP 502/);
  assert.ok(stats.retryInSec > 0);
  assert.equal(h.collection().length, 0);
  h.layer.destroy();
});

test('a kill-switch 503 does not schedule an endless retry', async () => {
  const h = harness(async () => {
    throw Object.assign(
      new Error('Camera-advisory feed disabled on this server (HTTP 503)'),
      { retryableAfterSetup: true, retryable: true },
    );
  });
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.layer.getStats().retryInSec, null);
  h.layer.destroy();
});

test('the browser source reads the advisory route and maps its payload', async () => {
  const source = createCameraAdvisoriesSource({
    fetchImpl: async (route) => {
      assert.equal(route, CAMERA_ADVISORIES_ROUTE);
      return new Response(
        JSON.stringify({ ...snapshot(), ageMs: 8000, stale: true }),
        { status: 200 },
      );
    },
  });
  const read = await source.getSnapshot({}, {});
  assert.equal(read.findings.length, 2);
  assert.equal(read.ageMs, 8000);
  assert.equal(read.stale, true);
  assert.equal(read.deviceContact, 'none');
});

test('the browser source refuses a malformed body instead of drawing zeros', async () => {
  const source = createCameraAdvisoriesSource({
    fetchImpl: async () => new Response('{"error":"nope"}', { status: 200 }),
  });
  await assert.rejects(() => source.getSnapshot({}, {}), /Malformed/);
});
