#!/usr/bin/env node
/**
 * Device Sweep in the real app, plus a boot with the network cut off.
 *
 * Asserts, in headless Chrome against a running dev server:
 *
 *  1. turning the layer on makes its row, its own chips, the local-only wording,
 *     and a feedback line that is already a polite live region;
 *  2. the layer's real `<input type="file">` takes an nmap XML report before
 *     any place exists: the row lists the same four devices as real buttons,
 *     disabled and saying what they need, because the ring has nowhere to draw
 *     and no slot to centre;
 *  3. a place typed into the layer's own dialog then flies the camera there:
 *     the counter reads 4, the feedback line names the file, the count and how
 *     many devices were new, the entries turn back on, and pressing one with
 *     the keyboard centres its device;
 *  4. a file that is not an inventory is refused in that same line and leaves
 *     the counter alone;
 *  5. an nmap report from another network is asked about in the row instead of
 *     being written: the counter stays at 4 until IMPORT ANYWAY, then reads 6;
 *  6. a second boot where every cross-origin request fails still reaches
 *     `ready`: the keyless globe takes over, the cover is lifted, and the 30 s
 *     startup guard never fires (no stall line in the banner, no stall warning
 *     in the console);
 *  7. a third boot where one startup phase never settles (`?qaStall=tools`, a
 *     QA-only seam): after its 30 s the guard names the step in the visible
 *     status banner, lifts the cover, disables the controls whose component
 *     never arrived, offers RELOAD and DISMISS, and the console behind it still
 *     answers a real click once the notice is dismissed.
 *  8. a fourth boot stalling on `controls`, the phase that builds the shell
 *     (`?qaStall=controls`): the banner exists but no shell feedback owns it, so
 *     the guard's sentence is written into the elements themselves — that is
 *     main.js's fallback, and the message, the lifted cover and its persistence
 *     are checked there.
 *
 * The scan is this gate's own fixture, written under `qa-artifacts/`; the file
 * is read in the page and never uploaded anywhere. Nothing here needs a key.
 * The place is typed through the dialog rather than written to storage because
 * the camera has to move for the ring to be in view.
 *
 * Run (dev server up): node scripts/qa-device-sweep.mjs --url http://localhost:4173
 * Failures save screenshots, console and network evidence under
 * `qa-artifacts/qa-device-sweep/`.
 *
 * A bare container needs fonts as well as Chrome's shared libraries: with no
 * fontconfig match, Chrome renders no text and the typed coordinates arrive one
 * character at a time, so step 2 fails on a page that is perfectly healthy.
 * Install a font package (fonts-dejavu-core is enough) or point
 * `FONTCONFIG_FILE` at a config naming a font directory.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import puppeteer from 'puppeteer';

import {
  saveFailureArtifacts,
  watchPage,
} from './qa-browserEvidence.mjs';
import { chromeExecutablePath } from './qa-chrome.mjs';

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const appUrl = new URL(
  (urlIndex >= 0 ? args[urlIndex + 1] : undefined) ||
    process.env.QA_BASE_URL ||
    'http://localhost:4173',
);
appUrl.searchParams.set('welcome', '0');
const APP_ORIGIN = appUrl.origin;

/** The row this gate drives, addressed the way the panel writes it. */
const ROW = '#data-toggles [data-layer-id="device-sweep"]';
const FILE_INPUT = '#device-sweep-file';
const DIALOG = 'dialog.device-sweep-dialog';

/** A place with nothing of the operator's in it: only the ring is drawn there. */
const PLACE = { lat: 48.8566, lon: 2.3522 };

/** Four hosts, one evidence shape each: camera, recorder, board, unknown. */
const NMAP = `<?xml version="1.0" encoding="UTF-8"?>
<nmaprun scanner="nmap" args="nmap -sV -oX home.xml 192.168.1.0/24" version="7.94">
<host><status state="up" reason="arp-response"/>
<address addr="192.168.1.10" addrtype="ipv4"/>
<address addr="44:19:B6:11:22:33" addrtype="mac" vendor="Hangzhou Hikvision Digital Technology Co., Ltd."/>
<hostnames><hostname name="ipcam-entree" type="PTR"/></hostnames>
<ports><port protocol="tcp" portid="554"><state state="open"/></port>
<port protocol="tcp" portid="80"><state state="open"/></port></ports>
</host>
<host><status state="up" reason="arp-response"/>
<address addr="192.168.1.20" addrtype="ipv4"/>
<address addr="3C:EF:8C:44:55:66" addrtype="mac" vendor="Zhejiang Dahua Technology Co., Ltd."/>
<hostnames><hostname name="nvr-garage" type="PTR"/></hostnames>
<ports><port protocol="tcp" portid="37777"><state state="open"/></port></ports>
</host>
<host><status state="up" reason="arp-response"/>
<address addr="192.168.1.30" addrtype="ipv4"/>
<address addr="B8:27:EB:77:88:99" addrtype="mac" vendor="Raspberry Pi Foundation"/>
<hostnames><hostname name="raspberrypi" type="PTR"/></hostnames>
<ports><port protocol="tcp" portid="22"><state state="open"/></port></ports>
</host>
<host><status state="up" reason="arp-response"/>
<address addr="192.168.1.40" addrtype="ipv4"/>
<address addr="00:1A:2B:AA:BB:CC" addrtype="mac"/>
<hostnames><hostname name="prise-salon" type="PTR"/></hostnames>
<ports><port protocol="tcp" portid="8080"><state state="open"/></port></ports>
</host>
<runstats><finished time="1763600030"/></runstats>
</nmaprun>
`;

/**
 * Another operator's network, shaped like a real report: no device in it is one
 * of the four above, which is exactly what the row has to ask about.
 */
const OTHER_NETWORK_NMAP = `<?xml version="1.0" encoding="UTF-8"?>
<nmaprun scanner="nmap" args="nmap -sn -oX office.xml 10.0.0.0/24" version="7.94">
<host><status state="up" reason="arp-response"/>
<address addr="10.0.0.20" addrtype="ipv4"/>
<address addr="00:11:22:33:44:55" addrtype="mac"/>
<hostnames><hostname name="bureau-imprimante" type="PTR"/></hostnames>
<ports><port protocol="tcp" portid="9100"><state state="open"/></port></ports>
</host>
<host><status state="up" reason="arp-response"/>
<address addr="10.0.0.21" addrtype="ipv4"/>
<address addr="00:11:22:33:44:66" addrtype="mac"/>
<hostnames><hostname name="bureau-nas" type="PTR"/></hostnames>
<ports><port protocol="tcp" portid="5000"><state state="open"/></port></ports>
</host>
<runstats><finished time="1763600040"/></runstats>
</nmaprun>
`;

/** A file an operator might pick by mistake: it holds no inventory shape. */
const NOT_AN_INVENTORY = `Shopping list
two lemons
printer paper
nothing on the network here
`;

/** Write the gate's fixtures where CI keeps evidence, which is ignored. */
async function writeFixtures() {
  const dir = path.join('qa-artifacts', 'qa-device-sweep');
  await fs.mkdir(dir, { recursive: true });
  const scan = path.resolve(dir, 'home-nmap.xml');
  const refused = path.resolve(dir, 'shopping-list.txt');
  const stranger = path.resolve(dir, 'office-nmap.xml');
  await fs.writeFile(scan, NMAP);
  await fs.writeFile(refused, NOT_AN_INVENTORY);
  await fs.writeFile(stranger, OTHER_NETWORK_NMAP);
  return { scan, refused, stranger };
}

/** The row's device list, as the operator and a screen reader reach it. */
function readList(page) {
  return page.evaluate((selector) => {
    const container = document.querySelector(
      `${selector} .data-row-list--sequence`,
    );
    return {
      tag: container?.tagName ?? null,
      label: container?.getAttribute('aria-label') ?? null,
      entries: [...(container?.children ?? [])].map((entry) => {
        const button = entry.querySelector('button');
        return {
          button: button?.tagName ?? null,
          disabled: button?.disabled ?? null,
          title: button?.title ?? '',
          lead: entry.querySelector('.data-row-list-lead')?.textContent ?? '',
          text: entry.querySelector('.data-row-list-text')?.textContent ?? '',
        };
      }),
    };
  }, ROW);
}

/** The row as the operator sees it, plus the attributes that make it heard. */
function readRow(selector) {
  const row = document.querySelector(selector);
  const info = row?.querySelector('.data-toggle-controls-info') ?? null;
  return {
    toggle: row?.querySelector('.data-toggle-btn')?.textContent?.trim() ?? null,
    count: row?.querySelector('.data-count')?.textContent?.trim() ?? null,
    info: info?.textContent ?? '',
    role: info?.getAttribute('role') ?? null,
    live: info?.getAttribute('aria-live') ?? null,
    atomic: info?.getAttribute('aria-atomic') ?? null,
    chips: row
      ? [...row.querySelectorAll('[data-chip-id]')].map(
          (chip) => chip.dataset.chipId,
        )
      : [],
  };
}

/** The status banner's settled text: the split-flap cells carry none of it. */
function bannerText(page) {
  return page.evaluate(
    () => document.getElementById('global-loading-status')?.textContent ?? '',
  );
}

/**
 * Boot a page whose startup stops on `phase`, and wait for the guard to speak.
 *
 * Every real phase settles or is synchronous, so `qaStall` is the only way into
 * the guard's stall path from a browser. Returns the banner and the cover as
 * they read once it has, and how long it took.
 */
async function stallBoot(browser, { phase, name, errors, monitors }) {
  const page = await browser.newPage();
  monitors.push(watchPage(page, { name, errors }));
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const url = new URL(appUrl.href);
  url.searchParams.set('qaStall', phase);
  const openedAt = Date.now();
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      /Startup is still at/.test(
        document.getElementById('global-loading-status')?.textContent ?? '',
      ),
    { timeout: 90_000, polling: 500 },
  );
  const stall = await page.evaluate(() => {
    const status = document.getElementById('global-loading-status');
    const cover = document.getElementById('loading-screen');
    return {
      banner: status?.textContent ?? '',
      label: document.getElementById('global-loading-label')?.textContent ?? '',
      detail:
        document.getElementById('global-loading-detail')?.textContent ?? '',
      state: status?.dataset?.state ?? null,
      onScreen: status?.hidden === false,
      role: status?.getAttribute('role') ?? null,
      live: status?.getAttribute('aria-live') ?? null,
      coverLifted: cover?.classList.contains('hidden') === true,
      coverAria: cover?.getAttribute('aria-hidden'),
      stage: document.querySelector('.loader-status')?.textContent ?? '',
      // False when the stall came before the panel that builds the row.
      shellBuilt: Boolean(
        document.querySelector('#data-toggles [data-layer-id] .data-toggle-btn'),
      ),
    };
  });
  return { page, stall, waited: Date.now() - openedAt };
}

/** What every stall must say, whatever step it stopped at. */
function assertStallSpoken(stall, waited) {
  assert.ok(
    waited >= 29_000,
    `the guard gave the startup its full 30 s budget (waited ${waited} ms)`,
  );
  assert.match(stall.banner, /Startup is still at “/);
  assert.match(stall.banner, /after 30 s/, 'it says how long it waited');
  assert.ok(
    stall.stage.trim() && stall.banner.includes(stall.stage.trim()),
    `the banner names the step the cover stopped at (${stall.stage.trim()})`,
  );
  assert.equal(stall.role, 'status', 'the banner is a status region');
  assert.equal(stall.onScreen, true, 'the message is shown, not only written');
  assert.equal(stall.live, 'polite', 'and it is announced');
  assert.equal(stall.coverLifted, true, 'the cover is lifted');
  assert.equal(
    stall.coverAria,
    'true',
    'and taken out of the reading order with it',
  );
}

/** The line a moment later: whatever ticks this banner must not wipe it. */
async function assertStallPersists(page) {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.match(
    await bannerText(page),
    /Startup is still at/,
    'the stall line stays up',
  );
}

async function main() {
  const { scan, refused, stranger } = await writeFixtures();
  const browser = await puppeteer.launch({
    executablePath: chromeExecutablePath(),
    headless: true,
    args: [
      '--lang=en-US',
      '--no-sandbox',
      // Headless Linux has no GPU: Cesium needs a software rasterizer.
      ...(process.platform === 'darwin'
        ? ['--use-angle=metal', '--enable-gpu']
        : ['--use-gl=angle', '--use-angle=swiftshader']),
    ],
  });
  const errors = [];
  const monitors = [];
  let count = 0;
  const step = async (name, run) => {
    try {
      await run();
    } catch (error) {
      console.error(`FAIL ${name}`);
      throw error;
    }
    count += 1;
    console.log(`PASS ${name}`);
  };
  try {
    // ── 1. The layer, its row and its own controls. ────────────────────────
    const page = await browser.newPage();
    monitors.push(watchPage(page, { name: 'sweep', errors }));
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(appUrl.href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () =>
        document
          .getElementById('loading-screen')
          ?.classList.contains('hidden') === true,
      { timeout: 120_000 },
    );
    await page.evaluate(async () => {
      // A scan left behind by an earlier run would make "4 new" a different
      // number, and the gate has to be repeatable.
      localStorage.removeItem('gev.device-sweep.v1');
      await window.__godsEyeView.dataManager.setEnabled(
        'device-sweep',
        true,
        { origin: 'qa' },
      );
    });
    await page.waitForSelector(`${ROW} .data-toggle-controls-info`);

    await step('the layer turns on with its chips, its wording and its live line', async () => {
      const row = await page.evaluate(readRow, ROW);
      assert.equal(row.toggle, 'ON');
      assert.deepEqual(row.chips, [
        'import',
        'place',
        'place-pick',
        'place-coordinates',
        'note',
        'clear',
      ]);
      assert.match(row.info, /No scan yet/);
      assert.match(row.info, /your own spaces only/);
      // The rows that answer an action are the ones a screen reader must hear.
      assert.equal(row.role, 'status');
      assert.equal(row.live, 'polite');
      assert.equal(row.atomic, 'true');
    });

    // ── 2. The operator's own report, readable before it is placed. ────────
    await step('a picked nmap report is listed before the sweep has a place', async () => {
      const input = await page.$(FILE_INPUT);
      assert.ok(input, 'the layer keeps its file input in the document');
      await input.uploadFile(scan);
      await page.waitForFunction(
        (selector) =>
          document
            .querySelector(selector)
            ?.querySelector('.data-toggle-controls-info')
            ?.textContent?.includes('Imported 4 devices from home-nmap.xml') ===
          true,
        { timeout: 30_000 },
        ROW,
      );
      // No place means no ring and no slot to fly to — but the scan is already
      // the operator's to read, so the list is there and says why it is inert.
      assert.match(
        await page.$eval(`${ROW} .data-count`, (node) =>
          node.textContent.trim(),
        ),
        /^(—|0)$/,
        'nothing is drawn around a place that was never set',
      );
      const row = await page.evaluate(readRow, ROW);
      assert.match(row.info, /Imported 4 devices from home-nmap\.xml/);
      assert.match(row.info, /4 new since your last scan/);
      const list = await readList(page);
      assert.equal(list.entries.length, 4, 'the unplaced scan is readable');
      assert.match(
        list.entries[0].text,
        /Camera-like/,
        'the flagged device leads the list, as it leads the ring',
      );
      assert.ok(
        list.entries.every((entry) => entry.disabled),
        'without a place the entries are read, not pressed',
      );
      assert.match(
        list.entries[0].title,
        /Set your place to centre this device/,
        'and each says what it needs',
      );
    });

    // ── 3. A place, typed the way an operator types it. ────────────────────
    await step('typed coordinates place the sweep, and its list can centre a device', async () => {
      // The row is rendered but sits in a collapsed panel in a headless boot,
      // and this gate is about the layer, not about panel chrome: the chip is
      // activated where the panel put it. Everything after it is visible.
      await page.$eval(`${ROW} [data-chip-id="place-coordinates"]`, (chip) =>
        chip.click(),
      );
      const input = `${DIALOG} input[type="text"]`;
      await page.waitForSelector(input);
      await page.click(input, { clickCount: 3 });
      await page.type(input, `${PLACE.lat}, ${PLACE.lon}`);
      await page.$eval(`${DIALOG} button[type="submit"]`, (button) =>
        button.click(),
      );
      await page.waitForFunction(
        () => !document.querySelector('dialog.device-sweep-dialog'),
        { timeout: 10_000 },
      );
      const row = await page.evaluate(readRow, ROW);
      assert.match(row.info, /Sweep place set for this device/);
      // The camera flies to the typed place; the row can only count what the
      // new view contains, so wait for the ring to be inside it.
      await page.waitForFunction(
        (selector) =>
          document.querySelector(selector)?.querySelector('.data-count')
            ?.textContent?.trim() === '4',
        { timeout: 60_000 },
        ROW,
      );
      const placed = await page.evaluate(readRow, ROW);
      assert.equal(placed.count, '4', 'the ring is inside the new view');

      // The globe's markers answer the mouse only. The row carries the same
      // sweep as real buttons, so a keyboard or a thumb can read it and reach
      // one device without hunting a point on the globe.
      const list = await readList(page);
      assert.equal(list.tag, 'UL', 'a set of devices, not a sequence');
      assert.equal(list.label, 'Devices in this sweep');
      assert.equal(list.entries.length, 4, 'one entry per device');
      assert.ok(
        list.entries.every((entry) => entry.button === 'BUTTON'),
        'each entry is a real button, so Tab reaches it',
      );
      assert.ok(
        list.entries.every((entry) => !entry.disabled),
        'a place turns the entries back on',
      );

      // The panel starts collapsed, which the chip clicks above did not care
      // about; a Tab does. Open it so the entry is really focusable.
      const collapsed = await page.$eval('#data-panel', (panel) =>
        panel.classList.contains('collapsed'),
      );
      if (collapsed) {
        await page.$eval('#data-panel .panel-collapse-btn', (button) =>
          button.click(),
        );
        await page.waitForFunction(
          () =>
            !document
              .getElementById('data-panel')
              ?.classList.contains('collapsed'),
          { timeout: 10_000 },
        );
      }

      // The keyboard path to the globe: focus the entry and press Enter, the
      // way a button is activated, rather than calling the handler directly.
      const first = `${ROW} .data-row-list--sequence .data-row-list-item`;
      await page.focus(first);
      assert.equal(
        await page.evaluate(
          (selector) =>
            document.activeElement ===
            document.querySelector(
              `${selector} .data-row-list--sequence button`,
            ),
          ROW,
        ),
        true,
        'the entry took the focus, so Enter can press it',
      );
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        (selector) =>
          document
            .querySelector(selector)
            ?.querySelector('.data-toggle-controls-info')
            ?.textContent?.includes('Centered on') === true,
        { timeout: 15_000 },
        ROW,
      );
      const centered = await page.evaluate(readRow, ROW);
      assert.match(
        centered.info,
        new RegExp(`Centered on ${list.entries[0].lead.replace(/\./g, '\\.')}`),
        'the entry that took the Enter key is the one it centred',
      );
    });

    // ── 4. A file that is not an inventory. ────────────────────────────────
    await step('a file that is not an inventory is refused in the same line', async () => {
      const input = await page.$(FILE_INPUT);
      await input.uploadFile(refused);
      await page.waitForFunction(
        (selector) =>
          document
            .querySelector(selector)
            ?.querySelector('.data-toggle-controls-info')
            ?.textContent?.includes(
              'That file is not an inventory this layer reads',
            ) === true,
        { timeout: 30_000 },
        ROW,
      );
      const row = await page.evaluate(readRow, ROW);
      assert.equal(row.count, '4', 'a refused file cannot change the count');
      assert.equal(
        row.live,
        'polite',
        'the refusal is announced through the same line',
      );
    });

    // ── 5. A file from another network: asked, never silently written. ─────
    await step('a file from another network is asked about before it is kept', async () => {
      const input = await page.$(FILE_INPUT);
      await input.uploadFile(stranger);
      await page.waitForFunction(
        (selector) =>
          document
            .querySelector(selector)
            ?.querySelector('.data-toggle-controls-info')
            ?.textContent?.includes('Import it anyway?') === true,
        { timeout: 30_000 },
        ROW,
      );
      const asked = await page.evaluate(readRow, ROW);
      assert.match(asked.info, /Only 0 of your 4 devices are in this file/);
      assert.match(
        asked.info,
        /Your scan would stay, greyed/,
        'the row says what importing it would do',
      );
      assert.equal(asked.count, '4', 'nothing is written before the answer');
      assert.ok(
        asked.chips.includes('import-cancel'),
        'the row can be told no',
      );

      // The chip that asked the question is the one that answers it.
      await page.$eval(`${ROW} [data-chip-id="import"]`, (chip) =>
        chip.click(),
      );
      await page.waitForFunction(
        (selector) =>
          document.querySelector(selector)?.querySelector('.data-count')
            ?.textContent?.trim() === '6',
        { timeout: 60_000 },
        ROW,
      );
      const kept = await page.evaluate(readRow, ROW);
      assert.equal(
        kept.count,
        '6',
        'the stored sweep was kept beside the confirmed one',
      );
      assert.match(kept.info, /Imported 2 devices from office-nmap\.xml/);
      assert.equal(
        kept.chips.includes('import-cancel'),
        false,
        'the question is gone once it is answered',
      );
    });

    await page.close();

    // ── 6. A boot with every cross-origin request cut off. ─────────────────
    const blockedPage = await browser.newPage();
    const blockedMonitor = watchPage(blockedPage, {
      name: 'blocked-network',
      errors,
    });
    monitors.push(blockedMonitor);
    await blockedPage.setViewport({
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
    });
    await blockedPage.setRequestInterception(true);
    let blocked = 0;
    blockedPage.on('request', (request) => {
      const requestUrl = request.url();
      // Cesium's blob/data work is not a network call; only http(s) is.
      if (!/^https?:/i.test(requestUrl)) return request.continue();
      if (new URL(requestUrl).origin === APP_ORIGIN) return request.continue();
      blocked += 1;
      return request.abort('failed');
    });
    await blockedPage.goto(appUrl.href, { waitUntil: 'domcontentloaded' });
    await blockedPage.waitForFunction(
      () =>
        document
          .getElementById('loading-screen')
          ?.classList.contains('hidden') === true,
      { timeout: 120_000 },
    );
    const boot = await blockedPage.evaluate(() => ({
      coverHidden:
        document
          .getElementById('loading-screen')
          ?.classList.contains('hidden') === true,
      globeShown: window.__godsEyeView?.viewer?.scene?.globe?.show === true,
      tileset: Boolean(window.__godsEyeView?.tileset),
      sweepRegistered:
        window.__godsEyeView?.dataManager?.layers?.has('device-sweep') === true,
      banner: document.getElementById('global-loading-status')?.textContent ?? '',
    }));

    await step('the cut-off boot reaches the console without a stall', () => {
      assert.ok(blocked > 0, 'the gate actually blocked cross-origin traffic');
      assert.equal(boot.coverHidden, true);
      assert.equal(boot.globeShown, true, 'the keyless globe took over');
      assert.equal(boot.tileset, false, 'no photoreal tileset without a network');
      assert.equal(
        boot.sweepRegistered,
        true,
        'a degraded boot still registers every layer',
      );
      // The guard warns in the console before it speaks, so either is a stall.
      assert.doesNotMatch(boot.banner, /Startup is still at/);
      const stall = blockedMonitor.console.filter((entry) =>
        /\[Startup\] still in/.test(entry.text),
      );
      assert.deepEqual(stall, [], 'the budgets took the degraded path in time');
      console.log(`  cross-origin requests blocked: ${blocked}`);
    });

    await blockedPage.close();

    // ── 7. A startup step that never settles. ──────────────────────────────
    await step('a stalled step is named in the banner, the cover lifts and the console answers', async () => {
      // `tools` is the last phase: what the cover hides is a finished console.
      const { page, stall, waited } = await stallBoot(browser, {
        phase: 'tools',
        name: 'stalled-startup',
        errors,
        monitors,
      });
      assertStallSpoken(stall, waited);
      assert.equal(stall.state, 'error', 'the banner reads as a failure');
      // A message that survives its own tick: the shell's loading feedback also
      // writes this banner, and a stall line it wipes would be news nobody read.
      await assertStallPersists(page);

      // A half-built console says what it lost and turns those controls off;
      // the notice it cannot wait out carries the two actions that end it.
      const degraded = await page.evaluate(() => {
        const actions = document.getElementById('global-loading-actions');
        const sceneStart = document.getElementById('scene-start-btn');
        return {
          actionsHidden: actions?.hidden ?? null,
          buttons: [...(actions?.querySelectorAll('button') ?? [])].map(
            (button) => button.textContent.trim(),
          ),
          sceneMarked:
            document.getElementById('scene-panel')?.dataset?.degraded ?? null,
          sceneStartDisabled: sceneStart?.disabled ?? null,
          sceneStartTitle: sceneStart?.title ?? '',
        };
      });
      assert.match(
        stall.banner,
        /Unavailable: scenes, drawing and voice\./,
        'the notice names what the stall left without its component',
      );
      assert.equal(
        degraded.actionsHidden,
        false,
        'a persistent notice offers a way out',
      );
      assert.deepEqual(degraded.buttons, ['RELOAD', 'DISMISS']);
      assert.equal(degraded.sceneMarked, 'true');
      assert.equal(
        degraded.sceneStartDisabled,
        true,
        'a control whose component never arrived is off',
      );
      assert.match(degraded.sceneStartTitle, /Unavailable until you reload/);

      // Dismiss ends the notice; RELOAD is left alone (it would leave the page).
      await page.$eval('#global-loading-dismiss', (button) => button.click());
      await page.waitForFunction(
        () => document.getElementById('global-loading-status')?.hidden === true,
        { timeout: 10_000 },
      );

      // Usable, not merely visible: a real control behind the lifted cover.
      await page.$eval(`${ROW} .data-toggle-btn`, (button) => button.click());
      await page.waitForFunction(
        (selector) =>
          document
            .querySelector(selector)
            ?.querySelector('.data-toggle-btn')
            ?.textContent?.trim() === 'ON',
        { timeout: 30_000 },
        ROW,
      );
      const row = await page.evaluate(readRow, ROW);
      assert.equal(row.toggle, 'ON', 'the console behind the cover answers');
      // Same origin, same storage: the sweep the earlier steps imported is the
      // one this row reads back, which is what makes the row live, not painted.
      assert.match(row.info, /6 devices/, 'and its row reads the stored sweep');
      await page.close();
    });

    // ── 8. A stall before the shell exists. ────────────────────────────────
    await step('a stall before the console is built still writes the banner', async () => {
      // `controls` builds the shell, whose loading feedback owns the banner's
      // text and `data-state`. Stalling there leaves the banner with nobody
      // driving it: the one path where main.js's `notify` writes the elements
      // itself instead of posting a shell notice.
      const { page, stall, waited } = await stallBoot(browser, {
        phase: 'controls',
        name: 'early-stall',
        errors,
        monitors,
      });
      assertStallSpoken(stall, waited);
      assert.equal(stall.shellBuilt, false, 'this boot never reached the shell');
      assert.match(
        stall.label,
        /Startup is still at/,
        'the fallback wrote the banner label itself',
      );
      assert.equal(
        stall.detail.trim(),
        '',
        'the stale loading detail is cleared with it',
      );
      assert.equal(stall.state, null, 'no shell owns data-state yet');
      await assertStallPersists(page);
      // No shell exists to own the notice, so the fallback must offer the same
      // way out: the actions row is in the markup either way.
      assert.equal(
        await page.$eval('#global-loading-actions', (row) => row.hidden),
        false,
        'a stall before the shell can still be dismissed or reloaded',
      );
      assert.equal(
        await page.$eval('#draw-toggle', (button) => button.disabled),
        true,
        'the drawing tool needs the phase this boot never reached',
      );
      await page.$eval('#global-loading-dismiss', (button) => button.click());
      await page.waitForFunction(
        () => document.getElementById('global-loading-status')?.hidden === true,
        { timeout: 10_000 },
      );
      await page.close();
    });

    await step('no uncaught page errors in any boot', () => {
      assert.deepEqual(errors, []);
    });

    console.log(`RESULT: ${count} passed`);
  } catch (error) {
    const dir = await saveFailureArtifacts({
      dir: 'qa-artifacts/qa-device-sweep',
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
