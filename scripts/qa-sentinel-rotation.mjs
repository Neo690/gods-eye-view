#!/usr/bin/env node
/**
 * Deterministic browser gate for the Sentinel's static-site rotation.
 *
 * Three boots. Two enable one static layer each and the Sentinel. Fixed request
 * fixtures answer the layer's API, so the test does not depend on the network
 * or a particular viewport. The gate watches the Sentinel's own scan state and
 * asserts that two successive scans visit two different sites, in a fixed
 * order, at the fixture's exact coordinates and provider ids.
 *
 * After the first scan the page is really reloaded. The same tab keeps its
 * sessionStorage, so the next scan must visit the other site instead of
 * returning to the one already recorded; a lost memory would pick the nearest
 * site again. Radio Sites covers the ANFR fixture; Mapped Installations covers
 * Creil and Villacoublay. The camera is held on the fixture view before every
 * scan (see settleCamera), so the sequence is deterministic rather than decided
 * by a floating-point tie, and the reloaded page must ask its API again.
 *
 * The third boot enables BOTH static layers at once and watches six scans. No
 * layer may take two scans in a row, every scan must stand on one of that
 * layer's sites, each layer must visit both of its own sites, and with every
 * site cooling each layer must then fall back to its longest-unvisited one:
 * that is what proves neither catalog starves the other's rotation, on the
 * fresh and the cooldown path alike.
 *
 * Run (server up): npm run qa:sentinel-rotation -- --url http://localhost:4173
 * `--case <name>[,<name>]` runs only the named boots (`radio-sites`,
 * `military-bases`, `radio-sites-and-installations`); an empty or unknown name
 * exits 2 with the list of boots. Every selected boot runs
 * even when an earlier one fails, so one broken case cannot hide another's
 * verdict. A failure saves the page, console, network and Sentinel state under
 * `qa-artifacts/sentinel-rotation/<case>/`, so the boots never share evidence.
 *
 * `--self-check` runs one boot, Radio Sites, with the tab's site memory wiped
 * between the reload and the next scan: the gate must then fail on the rotation
 * assertion, and the mode exits 0 only when that expected failure was produced.
 * It is the proof that the assertions still bite, not a second gate.
 */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import puppeteer from 'puppeteer';

import { saveFailureArtifacts, watchPage } from './qa-browserEvidence.mjs';
import { chromeExecutablePath } from './qa-chrome.mjs';

const COORDINATE_TOLERANCE = 1e-6;
const FONT_STYLESHEET = 'fonts.googleapis.com';
const MEMORY_KEY = 'gev:sentinel:visited-sites';
/** What `--self-check` must still see when the tab forgets its scans. */
const ROTATION_FAILURE_MARKER =
  /after reload, the Sentinel skips the remembered site and rotates/;
const EMPTY_MILITARY_NAMES = Object.freeze({
  release: 'qa-fixture',
  snapshots: [],
  classes: [],
  records: [],
});

const CASES = Object.freeze([
  {
    name: 'radio-sites',
    label: 'Radio Sites',
    layerId: 'cell-towers',
    camera: { lat: 48.855, lon: 2.355 },
    sites: [
      { id: 'qa-site-a', label: 'qa-site-a', lat: 48.85, lon: 2.35 },
      { id: 'qa-site-b', label: 'qa-site-b', lat: 48.9, lon: 2.4 },
    ],
    fixture: {
      match: '/api/cell-towers',
      urlPattern: '*/api/cell-towers*',
      body: {
        points: [
          {
            id: 'qa-site-a',
            label: 'qa-site-a',
            lat: 48.85,
            lon: 2.35,
          },
          {
            id: 'qa-site-b',
            label: 'qa-site-b',
            lat: 48.9,
            lon: 2.4,
          },
        ],
        matched: 2,
        source: 'anfr',
        attribution: {
          label: 'ANFR',
          licence: 'Licence Ouverte 2.0',
        },
      },
    },
  },
  {
    name: 'military-bases',
    label: 'Mapped Installations',
    layerId: 'military-installations',
    // Near Creil, so the first pick is unambiguous and the second is
    // Villacoublay rather than a tie.
    camera: { lat: 49.225, lon: 2.475 },
    sites: [
      {
        id: 'osm:node:91001',
        label: 'Creil',
        lat: 49.253,
        lon: 2.519,
      },
      {
        id: 'osm:node:91002',
        label: 'Villacoublay',
        lat: 48.774,
        lon: 2.191,
      },
    ],
    fixture: {
      match: '/api/military-installations',
      urlPattern: '*/api/military-installations*',
      // The layer also loads a bundled worldwide names pack. It is real data,
      // not network data, so it would add bases around Paris after a reload;
      // answer that pack with an empty fixture to keep this gate hermetic.
      stubs: [
        {
          match: 'osm_military_names',
          urlPattern: '*osm_military_names*',
          body: EMPTY_MILITARY_NAMES,
        },
        {
          match: '/assets/names-',
          urlPattern: '*/assets/names-*',
          body: EMPTY_MILITARY_NAMES,
        },
      ],
      body: {
        elements: [
          {
            type: 'node',
            id: 91001,
            lat: 49.253,
            lon: 2.519,
            tags: { military: 'airfield', name: 'Creil' },
          },
          {
            type: 'node',
            id: 91002,
            lat: 48.774,
            lon: 2.191,
            tags: { military: 'airfield', name: 'Villacoublay' },
          },
        ],
        status: 'ready',
        retrievedAt: '2026-01-01T00:00:00Z',
      },
    },
  },
]);

// Both static layers at once: the boot this gate exists to prove now that a
// catalog can win every ranking and leave the other uninspected.
const COEXISTENCE = Object.freeze({
  name: 'radio-sites-and-installations',
  label: 'Radio Sites + Mapped Installations',
  camera: { lat: 48.855, lon: 2.355 },
  layers: [
    { id: CASES[0].layerId, label: CASES[0].label, sites: CASES[0].sites },
    { id: CASES[1].layerId, label: CASES[1].label, sites: CASES[1].sites },
  ],
  fixtures: [CASES[0].fixture, CASES[1].fixture],
  scans: 6,
  // With the camera settled on the fixture view (see settleCamera), the walk
  // is reproducible: nearest site, then the other layer's nearer base, then
  // the remaining tower, then the remaining base. Scans five and six have no
  // unvisited site left anywhere, so they take the longest-unvisited site of
  // each layer — the sites the pair started with.
  expected: [
    'qa-site-a',
    'osm:node:91002',
    'qa-site-b',
    'osm:node:91001',
    'qa-site-a',
    'osm:node:91002',
  ],
});

const siteAt = (sites, lat, lon) =>
  sites.find(
    (site) =>
      Math.abs(site.lat - lat) < COORDINATE_TOLERANCE &&
      Math.abs(site.lon - lon) < COORDINATE_TOLERANCE,
  ) ?? null;

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const url = (
  urlIndex >= 0 ? args[urlIndex + 1] : 'http://localhost:4173'
).replace(/\/$/, '');
const caseIndex = args.indexOf('--case');
// `--case` without a value must not quietly mean "no boots": a typo in CI
// would otherwise finish green without starting a browser.
const caseArg = caseIndex >= 0 ? String(args[caseIndex + 1] ?? '') : null;
// The sabotage mode: it proves the assertions can fail, so it takes its own
// boot rather than being mixed into a case selection.
const selfCheck = args.includes('--self-check');

/**
 * Load the app again in the same tab, the way a reload would.
 *
 * A direct `page.reload()` in a container with no fonts used to lose the
 * target: Chrome aborts in `SkFontMgr_FontConfigInterface` while resolving the
 * Google Fonts families index.html links. installFixtures now answers that
 * stylesheet with an empty one, so the page declares no remote family and the
 * abort has nothing to resolve — the hop through about:blank is gone.
 */
async function reloadApp(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
}

/**
 * The case is about surviving a reload, so refuse a navigation that only looks
 * like one: `performance.navigation` records the type the browser performed.
 */
async function assertReloaded(page, label) {
  const type = await page.evaluate(
    () => performance.getEntriesByType('navigation')[0]?.type ?? null,
  );
  assert.equal(type, 'reload', `${label}: the tab really reloaded`);
}

/**
 * Fail before Chrome starts when nothing serves the app: a dead preview would
 * otherwise cost one 120-second wait per boot and read like a browser crash.
 */
async function assertPreview(target) {
  let response;
  try {
    response = await fetch(`${target}/?welcome=0`, {
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new Error(`nothing answered at ${target} (${error.message})`);
  }
  if (!response.ok) {
    throw new Error(`${target} answered HTTP ${response.status}, not the app`);
  }
}

/** Wait for the shell and the viewer after a navigation or reload. */
async function waitForApp(page) {
  await page.waitForFunction(() => window.__godsEyeView?.viewer, {
    timeout: 120_000,
  });
  await page.waitForFunction(
    () => document.documentElement.dataset.boot === 'ready',
    { timeout: 120_000 },
  );
  // The welcome flight would overwrite a view set while it is still running.
  await new Promise((resolve) => setTimeout(resolve, 8000));
}

/**
 * Set the fixture's view, leave only the named layers enabled, and show them.
 * `layers` is one entry per layer the boot needs, each with the sites its
 * fixture is expected to produce.
 */
async function prepareLayers(page, { camera, layers }) {
  const layerIds = layers.map((layer) => layer.id);
  await page.evaluate(
    async ({ layerIds, camera }) => {
      const viewer = window.__godsEyeView.viewer;
      viewer.camera.cancelFlight?.();
      const C = viewer.camera.positionCartographic.constructor;
      viewer.camera.setView({
        destination: viewer.scene.globe.ellipsoid.cartographicToCartesian(
          C.fromDegrees(camera.lon, camera.lat, 200_000),
        ),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      for (const entry of document.querySelectorAll(
        '#data-toggles [data-layer-id]',
      )) {
        const button = entry.querySelector('.data-toggle-btn');
        if (button?.textContent?.trim() === 'ON') button.click();
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      for (const layerId of layerIds) {
        document
          .querySelector(
            `#data-toggles [data-layer-id="${layerId}"] .data-toggle-btn`,
          )
          ?.click();
      }
    },
    { layerIds, camera },
  );

  // Every layer the boot enabled must reach its fixture and expose exactly the
  // sites that fixture carries, at their published coordinates.
  for (const layer of layers) {
    await page.evaluate(
      async ({ layerId, count, label }) => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const module =
            window.__godsEyeView.dataManager.layers.get(layerId)?.module;
          if ((module?.getStats?.().count ?? 0) >= count) return;
          await sleep(500);
        }
        throw new Error(`${label} fixture did not reach the layer`);
      },
      { layerId: layer.id, count: layer.sites.length, label: layer.label },
    );

    const layerSites = await page.evaluate((layerId) => {
      const module =
        window.__godsEyeView.dataManager.layers.get(layerId)?.module;
      return module?.getPatrolSites?.(10) ?? [];
    }, layer.id);
    const uniqueSites = new Map(layerSites.map((site) => [site.id, site]));
    assert.equal(
      uniqueSites.size,
      layer.sites.length,
      `${layer.label} holds both fixture sites`,
    );
    for (const expected of layer.sites) {
      const row = uniqueSites.get(expected.id);
      assert.ok(row, `${layer.label} exposes ${expected.id}`);
      assert.equal(
        row.label,
        expected.label,
        `${layer.label} exposes ${expected.id}'s label`,
      );
      assert.ok(
        Math.abs(row.latitude - expected.lat) < COORDINATE_TOLERANCE &&
          Math.abs(row.longitude - expected.lon) < COORDINATE_TOLERANCE,
        `${expected.id} keeps its fixture coordinates: ${JSON.stringify(row)}`,
      );
    }
  }
}

/** A boot's fixtures and layers, whether it enables one layer or both. */
const fixturesOf = (spec) => spec.fixtures ?? [spec.fixture];
const layersOf = (spec) =>
  spec.layers ?? [{ id: spec.layerId, label: spec.label, sites: spec.sites }];

/**
 * A fresh page with the fixed APIs installed, the app booted, every layer the
 * boot needs holding its fixture sites, and the camera held on the view.
 *
 * Every read of these layers is a fixture: the layers are real, the data is
 * fixed, and the Sentinel's rotation is the only variable under test.
 */
async function openBoot(browser, spec, errors, monitors) {
  const page = await browser.newPage();
  monitors.push(
    watchPage(page, { name: `sentinel-rotation-${spec.name}`, errors }),
  );
  const fixtures = await installFixtures(page, fixturesOf(spec));
  await page.goto(`${url}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await waitForApp(page);
  await prepareLayers(page, { camera: spec.camera, layers: layersOf(spec) });
  assertFixturesRead(fixtures.hits, spec.label);
  await settleCamera(page, spec.camera);
  return { page, fixtures };
}

/**
 * Hold the camera on the fixture view until it is really there.
 *
 * The Sentinel spawns where the operator is looking, so the spider's first
 * target is decided by the camera and not only by the fixture ranking. Reading
 * the view back before the first scan keeps the walk reproducible instead of
 * depending on whatever the app did to the camera since setView.
 */
async function settleCamera(page, camera) {
  await page.evaluate(async ({ camera }) => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const viewer = window.__godsEyeView.viewer;
    const C = viewer.camera.positionCartographic.constructor;
    const place = () =>
      viewer.camera.setView({
        destination: viewer.scene.globe.ellipsoid.cartographicToCartesian(
          C.fromDegrees(camera.lon, camera.lat, 200_000),
        ),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const current = viewer.camera.positionCartographic;
      const lat = (current.latitude * 180) / Math.PI;
      const lon = (current.longitude * 180) / Math.PI;
      if (
        Math.abs(lat - camera.lat) < 0.005 &&
        Math.abs(lon - camera.lon) < 0.005 &&
        Math.abs(current.height - 200_000) < 1_000
      )
        return;
      viewer.camera.cancelFlight?.();
      place();
      await sleep(250);
    }
    throw new Error(
      `the camera would not settle on ${camera.lat}, ${camera.lon}`,
    );
  }, { camera });
}

/** Start the Sentinel without an extra fixed sleep: walk time is part of it. */
async function enableSentinel(page) {
  await page.evaluate(() => {
    document
      .querySelector(
        '#data-toggles [data-layer-id="ai-agent"] .data-toggle-btn',
      )
      ?.click();
  });
}

/** Watch scan starts; return each target and the coordinates it stands on. */
async function observeScans(page, count) {
  return page.evaluate(async (wanted) => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const module = () =>
      window.__godsEyeView.dataManager.layers.get('ai-agent')?.module;
    const out = [];
    let wasScanning = false;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && out.length < wanted) {
      const stats = module()?.getStats?.();
      if (stats?.scanning && !wasScanning) {
        out.push({
          target: stats.target,
          targetKind: stats.targetKind,
          lat: stats.latDeg,
          lon: stats.lonDeg,
        });
      }
      wasScanning = Boolean(stats?.scanning);
      await sleep(100);
    }
    return out;
  }, count);
}

/** The scan is recorded in sessionStorage just before `scanning` goes false. */
async function waitForScanEnd(page) {
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const module = () =>
      window.__godsEyeView.dataManager.layers.get('ai-agent')?.module;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!module()?.getStats?.().scanning) return;
      await sleep(100);
    }
    throw new Error('the Sentinel scan did not finish before the reload');
  });
}

async function readMemory(page) {
  return page.evaluate((key) => {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version,
      count: Object.keys(parsed.sites || {}).length,
    };
  }, MEMORY_KEY);
}

/**
 * Answer the page's layer reads with the boot's fixed JSON, so the gate never
 * depends on the network. A stub whose `match` appears in the URL wins over
 * the fixture body it belongs to.
 */
async function installFixtures(page, fixtures) {
  const stubs = fixtures.flatMap((fixture) => fixture.stubs ?? []);
  // Every fixture must be asked for at least once: a 200 with the wrong body
  // would still let a layer count rows, so the request itself is the proof.
  const hits = new Map(fixtures.map((fixture) => [fixture.match, 0]));
  const cdp = await page.createCDPSession();
  await cdp.send('Fetch.enable', {
    patterns: [
      ...fixtures.map((fixture) => ({ urlPattern: fixture.urlPattern })),
      ...stubs.map((stub) => ({ urlPattern: stub.urlPattern })),
      { urlPattern: `*${FONT_STYLESHEET}*` },
    ],
  });
  cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
    // An empty stylesheet declares no family, so no font is fetched: the gate
    // measures rotation, not typography, stops depending on Google, and leaves
    // the font manager nothing to resolve on a machine without fonts.
    if (request.url.includes(FONT_STYLESHEET)) {
      cdp
        .send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/css' }],
          body: '',
        })
        .catch(() => {});
      return;
    }
    const stub = stubs.find((candidate) =>
      request.url.includes(candidate.match),
    );
    const fixture = fixtures.find((candidate) =>
      request.url.includes(candidate.match),
    );
    if (fixture) hits.set(fixture.match, hits.get(fixture.match) + 1);
    cdp
      .send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(
          JSON.stringify(stub?.body ?? fixture?.body ?? {}),
        ).toString('base64'),
      })
      .catch(() => {});
  });
  return { cdp, hits };
}

/**
 * Refuse a boot whose layer never asked its API for the fixture. With `since`
 * (the hit counts from before a reload), the request must be new: counts from
 * the first page would otherwise make the check pass on its own.
 */
function assertFixturesRead(hits, label, since = null) {
  for (const [match, count] of hits) {
    if (count > (since?.get(match) ?? 0)) continue;
    assert.fail(
      since
        ? `${label}: the reloaded page never re-requested ${match}`
        : `${label}: the page never requested ${match}`,
    );
  }
}

/**
 * Drop the tab's site memory after a reload and before the Sentinel starts.
 *
 * An empty store would make the sabotage a no-op, so a wipe that finds nothing
 * fails here instead of letting the self-check read as a proof.
 */
async function forgetVisitedSites(page) {
  const kept = await page.evaluate((key) => {
    const before = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    return before;
  }, MEMORY_KEY);
  assert.ok(kept, 'the reload kept a site memory to wipe');
}

async function runCase(
  browser,
  spec,
  errors,
  monitors,
  { forgetMemory = false } = {},
) {
  const { page, fixtures } = await openBoot(browser, spec, errors, monitors);
  await enableSentinel(page);

  const before = await observeScans(page, 1);
  assert.equal(before.length, 1, `${spec.label}: first scan starts`);
  await waitForScanEnd(page);
  const memoryBefore = await readMemory(page);
  assert.equal(memoryBefore?.version, 2, 'the tab has a versioned memory');
  assert.ok(memoryBefore.count >= 1, 'the first scan was remembered');

  const hitsBeforeReload = new Map(fixtures.hits);
  await reloadApp(page);
  await assertReloaded(page, spec.label);
  // The self-check's sabotage. The module reads this key when it is enabled
  // further down, so wiping it here makes the reloaded page believe it never
  // scanned anything.
  if (forgetMemory) await forgetVisitedSites(page);
  await waitForApp(page);
  await prepareLayers(page, { camera: spec.camera, layers: layersOf(spec) });
  assertFixturesRead(fixtures.hits, spec.label, hitsBeforeReload);
  await settleCamera(page, spec.camera);
  await enableSentinel(page);

  const after = await observeScans(page, 2);

  for (const [phase, scans] of [
    ['before reload', before],
    ['after reload', after],
  ]) {
    assert.equal(
      scans.length,
      phase === 'before reload' ? 1 : 2,
      `${spec.label}: ${phase} completed the expected scans`,
    );
    for (const scan of scans) {
      assert.equal(scan.target, spec.layerId);
      assert.equal(
        scan.targetKind,
        null,
        `${spec.label} scans inspect the static layer, not a GhostMaps alert`,
      );
    }
  }

  const beforeSites = before.map((scan) =>
    siteAt(spec.sites, scan.lat, scan.lon),
  );
  const afterSites = after.map((scan) =>
    siteAt(spec.sites, scan.lat, scan.lon),
  );
  assert.ok(
    [...beforeSites, ...afterSites].every(Boolean),
    `every ${spec.label} scan stands exactly on a fixture site`,
  );
  assert.equal(
    beforeSites[0].id,
    spec.sites[0].id,
    `${spec.label}: the first scan visits the nearest site`,
  );
  assert.deepEqual(
    afterSites.map((site) => site.id),
    [spec.sites[1].id, spec.sites[0].id],
    `${spec.label}: after reload, the Sentinel skips the remembered site and rotates`,
  );
  assert.notEqual(
    beforeSites[0].id,
    afterSites[0].id,
    `${spec.label}: sessionStorage prevented scanning the same site again`,
  );

  console.log(
    `[${spec.name}] before reload: ${beforeSites[0].id} (${before[0].lat.toFixed(5)}, ${before[0].lon.toFixed(5)})`,
  );
  for (const [index, scan] of after.entries()) {
    const site = afterSites[index];
    console.log(
      `[${spec.name}] after reload scan ${index + 1}: ${site.id} (${scan.lat.toFixed(5)}, ${scan.lon.toFixed(5)})`,
    );
  }
  console.log(
    `RESULT ${spec.label}: ${beforeSites[0].id} survived reload through sessionStorage; then ${afterSites.map((site) => site.id).join(' then ')}`,
  );
  // main closes the page once the boot is settled, so a failure can still
  // capture the page it happened on.
}

/**
 * Both static layers on at once.
 *
 * Radio Sites and Mapped Installations hold four fixture sites between them,
 * and the Sentinel inspects one site per scan: a catalog that always won the
 * ranking would starve the other one. Six scans must alternate layers, cover
 * both sites of each layer, and then revisit the longest-unvisited site of
 * each layer once nothing is left unvisited — the cooldown path, where only
 * the visit times and the repeat penalty can break the tie.
 */
async function runCoexistenceCase(browser, spec, errors, monitors) {
  const { page } = await openBoot(browser, spec, errors, monitors);
  await enableSentinel(page);

  const scans = await observeScans(page, spec.scans);
  assert.equal(
    scans.length,
    spec.scans,
    `${spec.label}: the Sentinel completed ${spec.scans} scans`,
  );

  const visits = scans.map((scan) => {
    assert.equal(
      scan.targetKind,
      null,
      `${spec.label}: a static layer is inspected, not a GhostMaps alert`,
    );
    const layer = spec.layers.find(
      (candidate) => candidate.id === scan.target,
    );
    assert.ok(
      layer,
      `${spec.label}: ${scan.target} is one of the two enabled layers`,
    );
    const site = siteAt(layer.sites, scan.lat, scan.lon);
    assert.ok(
      site,
      `${spec.label}: the scan stands exactly on a ${layer.label} site`,
    );
    return { layerId: layer.id, label: layer.label, siteId: site.id };
  });

  // The anti-starvation property: one catalog may not take every scan, and no
  // layer may be skipped while the other is inspected twice in a row.
  for (let index = 1; index < visits.length; index += 1) {
    assert.notEqual(
      visits[index].layerId,
      visits[index - 1].layerId,
      `${spec.label}: scan ${index + 1} leaves ${visits[index - 1].label}`,
    );
  }

  for (const layer of spec.layers) {
    const visited = visits.filter((visit) => visit.layerId === layer.id);
    assert.equal(
      visited.length,
      spec.scans / 2,
      `${layer.label} is inspected as often as the other layer`,
    );
    assert.equal(
      new Set(visited.map((visit) => visit.siteId)).size,
      layer.sites.length,
      `${layer.label}: both of its sites were inspected`,
    );
    // Every site is cooling by this layer's third visit, so it falls back to
    // the one it visited longest ago: the same site it started with.
    assert.equal(
      visited.at(-1).siteId,
      visited[0].siteId,
      `${layer.label}: the cooldown revisits its longest-unvisited site`,
    );
    assert.notEqual(
      visited.at(-1).siteId,
      visited.at(-2).siteId,
      `${layer.label}: not the site it just scanned`,
    );
  }

  assert.deepEqual(
    visits.map((visit) => visit.siteId),
    spec.expected,
    `${spec.label}: the settled camera gives the reproducible walk`,
  );

  for (const visit of visits) {
    console.log(`[${spec.name}] ${visit.label}: ${visit.siteId}`);
  }
  console.log(
    `RESULT ${spec.label}: ${visits.map((visit) => visit.siteId).join(' then ')}`,
  );
  console.log(
    'RESULT: neither static layer starved the rotation; each visited both of its sites',
  );
  console.log(
    'RESULT: with every site cooling, each layer revisited its longest-unvisited site',
  );
}

/** The Sentinel's own readout, so a failed boot says what it saw. */
async function sentinelProbe(page) {
  return page.evaluate(() => {
    const module = window.__godsEyeView?.dataManager?.layers?.get(
      'ai-agent',
    )?.module;
    const raw = sessionStorage.getItem('gev:sentinel:visited-sites');
    return {
      stats: module?.getStats?.() ?? null,
      memory: raw ? JSON.parse(raw) : null,
    };
  });
}

/** One boot the gate can run, in the order a full run takes them. */
const BOOTS = Object.freeze([
  ...CASES.map((spec) => ({
    name: spec.name,
    label: spec.label,
    run: (browser, errors, monitors) =>
      runCase(browser, spec, errors, monitors),
  })),
  {
    name: COEXISTENCE.name,
    label: COEXISTENCE.label,
    run: (browser, errors, monitors) =>
      runCoexistenceCase(browser, COEXISTENCE, errors, monitors),
  },
]);

/**
 * Prove the gate can still go red.
 *
 * A green rotation run only means something while the assertions that model it
 * can fail, so this boot runs the same case with the tab's memory wiped: the
 * reloaded Sentinel must then walk back to the site it just left. The boot must
 * fail on that assertion — staying green means the check has become decoration,
 * and failing on anything else means the gate is broken for another reason and
 * proves nothing about the rotation.
 */
async function expectRotationFailure(browser, errors, monitors) {
  const spec = CASES[0];
  let failure = null;
  try {
    await runCase(browser, spec, errors, monitors, { forgetMemory: true });
  } catch (thrown) {
    failure = thrown;
  }
  if (!failure)
    assert.fail(
      `${spec.label}: the gate stayed green with its site memory wiped, so the rotation assertions no longer bite`,
    );
  assert.match(
    failure.message,
    ROTATION_FAILURE_MARKER,
    `${spec.label}: the sabotaged boot failed on something other than the rotation: ${failure.message}`,
  );
  // The assertion's own words, so the log carries the proof, not the claim.
  console.log(`  failed as expected: ${failure.message.split('\n')[0]}`);
  console.log(
    `RESULT ${spec.label}: a forgotten site fails the rotation, as it must`,
  );
}

/**
 * The one boot `--self-check` runs. Kept out of BOOTS so a full run can never
 * include the sabotage and mistake it for a verdict.
 */
const SELF_CHECK = Object.freeze({
  name: 'self-check',
  label: 'Self-check: a forgotten site must fail the rotation',
  run: (browser, errors, monitors) =>
    expectRotationFailure(browser, errors, monitors),
});

/**
 * Resolve `--case` against the boots. An empty value, an unknown name or a
 * selection that keeps no boot is a usage error, never a silent green run.
 */
function selectedBoots(caseArg) {
  if (caseArg === null) return BOOTS;
  const names = [
    ...new Set(caseArg.split(',').map((name) => name.trim())),
  ].filter(Boolean);
  const known = BOOTS.map((boot) => boot.name);
  // `--case --url …` reads as a flag, not a boot name: say which one is meant.
  if (!names.length || names.some((name) => name.startsWith('--'))) {
    throw new Error(`--case needs a boot name; known: ${known.join(', ')}`);
  }
  const unknown = names.filter((name) => !known.includes(name));
  if (unknown.length) {
    throw new Error(
      `unknown case(s): ${unknown.join(', ')}; known: ${known.join(', ')}`,
    );
  }
  return BOOTS.filter((boot) => names.includes(boot.name));
}

/**
 * When the failure is Chrome dying rather than an assertion, say so: the
 * evidence shows a detached frame or a closed target, which reads like a
 * rotation failure otherwise. A font-stack abort on reload is one cause; see
 * reloadApp.
 */
function browserDeath(browser) {
  if (browser.connected !== false) return null;
  const child = browser.process?.();
  const signal = child?.signalCode ?? null;
  const code = child?.exitCode ?? null;
  const how = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
  const hint =
    signal === 'SIGABRT' || signal === 'SIGSEGV'
      ? '; an abort on reload can be the font stack, see reloadApp'
      : '';
  return `the browser died (${how}), not the gate${hint}`;
}

/**
 * Run one boot and hand back its error, or null. Each boot owns its console
 * list and its pages, so one failing case neither stops the next nor shares a
 * directory with another. It also prints how long it took, so a slow boot is
 * visible in the log.
 */
async function runBoot(browser, boot) {
  const errors = [];
  const monitors = [];
  const dir = `qa-artifacts/sentinel-rotation/${boot.name}`;
  // A rerun must not inherit the previous run's pages as if they were current.
  await rm(dir, { recursive: true, force: true });
  const startedAt = Date.now();
  const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  try {
    await boot.run(browser, errors, monitors);
    assert.deepEqual(errors, [], `${boot.label}: the page logged no errors`);
    console.log(`PASS ${boot.label} (${elapsed()})`);
    return null;
  } catch (failure) {
    const death = browserDeath(browser);
    const error = death ? new Error(`${failure.message} — ${death}`) : failure;
    const saved = await saveFailureArtifacts({
      dir,
      browser,
      monitors,
      error,
      probe: sentinelProbe,
    }).catch(() => null);
    if (saved) console.error(`failure evidence saved in ${saved}/`);
    console.error(`FAIL ${boot.label} (${elapsed()}): ${error.message}`);
    return error;
  } finally {
    for (const monitor of monitors) {
      await monitor.page.close().catch(() => {});
    }
  }
}

async function main() {
  let boots;
  try {
    // The self-check sabotages one known boot; a `--case` alongside it would
    // read as a preference for which sabotage to run, so it is a usage error.
    if (selfCheck && caseIndex >= 0)
      throw new Error('--self-check runs its own boot; drop --case');
    boots = selfCheck ? [SELF_CHECK] : selectedBoots(caseArg);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  try {
    await assertPreview(url);
  } catch (error) {
    console.error(`${error.message}; start the preview first`);
    process.exit(2);
  }
  console.log(`boots: ${boots.map((boot) => boot.name).join(', ')} at ${url}`);
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromeExecutablePath(),
    defaultViewport: { width: 1440, height: 900 },
    protocolTimeout: 180_000,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  const failures = [];
  try {
    for (const boot of boots) {
      const error = await runBoot(browser, boot);
      if (error) failures.push({ label: boot.label, error });
    }
    if (failures.length) {
      throw new Error(
        `${failures.length} of ${boots.length} boot(s) failed: ${failures
          .map((failure) => failure.label)
          .join(', ')}`,
      );
    }
    if (selfCheck) {
      console.log(
        'RESULT: with its memory wiped, the gate failed the rotation, as it must',
      );
    } else {
      console.log(`RESULT: ${boots.length} of ${boots.length} boots passed`);
      if (boots.length === BOOTS.length) {
        console.log(
          'RESULT: each static layer rotated to a new site after a real reload',
        );
        console.log(
          'RESULT: with both static layers on, neither starved the other',
        );
      }
    }
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
