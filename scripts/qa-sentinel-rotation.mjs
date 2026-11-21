#!/usr/bin/env node
/**
 * Deterministic browser gate for the Sentinel's site rotation.
 *
 * The app is loaded with only Radio Sites and the Sentinel enabled. Two fixed
 * sites are answered by a request fixture, so the test does not depend on the
 * ANFR extract, the network or a particular viewport. The gate watches the
 * Sentinel's own scan state and asserts that two successive scans land on two
 * different sites, in a fixed order, at the fixture's exact coordinates and
 * provider ids. The camera starts nearer `qa-site-a`, so the sequence is
 * deterministic rather than decided by a floating-point tie.
 *
 * Run (server up): npm run qa:sentinel-rotation -- --url http://localhost:4173
 * A failure saves the page, console and network evidence under
 * `qa-artifacts/sentinel-rotation/`.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

import puppeteer from 'puppeteer';

import { saveFailureArtifacts, watchPage } from './qa-browserEvidence.mjs';
import { chromeExecutablePath } from './qa-chrome.mjs';

const SITES = Object.freeze([
  { id: 'qa-site-a', lat: 48.85, lon: 2.35 },
  { id: 'qa-site-b', lat: 48.9, lon: 2.4 },
]);
const EXPECTED_ORDER = Object.freeze(SITES.map((site) => site.id));
const COORDINATE_TOLERANCE = 1e-6;

const siteAt = (lat, lon) =>
  SITES.find(
    (site) =>
      Math.abs(site.lat - lat) < 1e-6 && Math.abs(site.lon - lon) < 1e-6,
  ) ?? null;

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const url = (
  urlIndex >= 0 ? args[urlIndex + 1] : 'http://localhost:4173'
).replace(/\/$/, '');

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromeExecutablePath(),
    defaultViewport: { width: 1440, height: 900 },
    protocolTimeout: 180_000,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  const errors = [];
  const monitors = [];
  let page = null;
  try {
    page = await browser.newPage();
    monitors.push(watchPage(page, { name: 'sentinel-rotation', errors }));

    // Every radio-site read is this fixture: the layer is real, the data is
    // fixed, and the Sentinel's rotation is the only variable under test.
    const cdp = await page.createCDPSession();
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*/api/cell-towers*' }],
    });
    cdp.on('Fetch.requestPaused', ({ requestId }) => {
      cdp
        .send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'application/json' },
          ],
          body: Buffer.from(
            JSON.stringify({
              points: SITES.map((site) => ({
                id: site.id,
                lat: site.lat,
                lon: site.lon,
                label: site.id,
              })),
              matched: SITES.length,
              source: 'anfr',
              attribution: {
                label: 'ANFR',
                licence: 'Licence Ouverte 2.0',
              },
            }),
          ).toString('base64'),
        })
        .catch(() => {});
    });

    await page.goto(`${url}/?welcome=0`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__godsEyeView?.viewer, {
      timeout: 120_000,
    });
    await page.waitForFunction(
      () => document.documentElement.dataset.boot === 'ready',
      { timeout: 120_000 },
    );
    // The welcome flight would overwrite a view set while it is still running.
    await new Promise((resolve) => setTimeout(resolve, 8000));
    await page.evaluate(async () => {
      const viewer = window.__godsEyeView.viewer;
      viewer.camera.cancelFlight?.();
      const C = viewer.camera.positionCartographic.constructor;
      viewer.camera.setView({
        destination: viewer.scene.globe.ellipsoid.cartographicToCartesian(
          // Near qa-site-a: the first pick is unambiguous, so the gate can
          // assert the full sequence instead of accepting either order.
          C.fromDegrees(2.355, 48.855, 200_000),
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
      document
        .querySelector(
          '#data-toggles [data-layer-id="cell-towers"] .data-toggle-btn',
        )
        ?.click();
    });

    await page.evaluate(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const module =
          window.__godsEyeView.dataManager.layers.get('cell-towers')?.module;
        if ((module?.getStats?.().count ?? 0) >= 2) return;
        await sleep(500);
      }
      throw new Error('the radio-site fixture did not reach the layer');
    });
    const layerSites = await page.evaluate(() => {
      const module =
        window.__godsEyeView.dataManager.layers.get('cell-towers')?.module;
      return module?.getPatrolSites?.(10) ?? [];
    });
    assert.equal(
      layerSites.length,
      SITES.length,
      'the layer holds both fixture sites',
    );
    for (const expected of SITES) {
      const row = layerSites.find((site) => site.id === expected.id);
      assert.ok(row, `the layer exposes ${expected.id}`);
      assert.ok(
        Math.abs(row.latitude - expected.lat) < COORDINATE_TOLERANCE &&
          Math.abs(row.longitude - expected.lon) < COORDINATE_TOLERANCE,
        `${expected.id} keeps its fixture coordinates: ${JSON.stringify(row)}`,
      );
    }
    await page.evaluate(async () => {
      document
        .querySelector(
          '#data-toggles [data-layer-id="ai-agent"] .data-toggle-btn',
        )
        ?.click();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    });

    const scans = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const module = () =>
        window.__godsEyeView.dataManager.layers.get('ai-agent')?.module;
      const out = [];
      let wasScanning = false;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline && out.length < 2) {
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
    });

    assert.equal(
      scans.length,
      2,
      'the Sentinel completed two scans in the gate window',
    );
    for (const scan of scans) assert.equal(scan.target, 'cell-towers');
    const fixtures = scans.map((scan) => siteAt(scan.lat, scan.lon));
    assert.ok(
      fixtures.every(Boolean),
      `every scan stands exactly on a fixture site: ${JSON.stringify(scans)}`,
    );
    for (const scan of scans)
      assert.equal(
        scan.targetKind,
        null,
        'the scans inspect the static layer, not a GhostMaps alert',
      );
    assert.deepEqual(
      fixtures.map((site) => site.id),
      EXPECTED_ORDER,
      'two successive scans visit two different sites in a deterministic order',
    );
    for (const [index, scan] of scans.entries()) {
      const site = fixtures[index];
      assert.ok(
        Math.abs(scan.lat - site.lat) < COORDINATE_TOLERANCE &&
          Math.abs(scan.lon - site.lon) < COORDINATE_TOLERANCE,
        `scan ${index + 1} chose ${site.id}'s exact coordinates`,
      );
      console.log(
        `scan ${index + 1}: ${scan.target} id=${site.id} lat=${site.lat.toFixed(5)} lon=${site.lon.toFixed(5)}`,
      );
    }
    assert.deepEqual(errors, []);
    console.log(
      `RESULT: two successive scans visited ${EXPECTED_ORDER.join(' then ')} with distinct provider ids and coordinates`,
    );
  } catch (error) {
    const dir = await saveFailureArtifacts({
      dir: 'qa-artifacts/sentinel-rotation',
      browser,
      monitors,
      error,
    }).catch(() => null);
    if (dir) console.error(`failure evidence saved in ${dir}/`);
    throw error;
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
