import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHANNELS,
  RELEASES_API,
  REPO,
  fetchReleases,
  resolveUpdateInfo,
  shellPlatform,
} from './updateChannel.js';
import { installUpdatePanel } from './updatePanel.js';

// ── A tiny document harness, in the spirit of the repo's mock environments ──
function makeDoc() {
  /** @type {Map<string, object>} */
  const byId = new Map();
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.id = '';
      this.children = [];
      this.parentElement = null;
      this._listeners = new Map();
      this._attributes = new Map();
      this.hidden = false;
      this.textContent = '';
      this.title = '';
      this.className = '';
    }
    lastChild = null;
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      this.lastChild = child;
      if (child.id) byId.set(child.id, child);
      return child;
    }
    classList = {
      add: (name) => {
        const value = this.className.trim();
        this.className = value ? `${value} ${name}` : name;
      },
      remove: (name) => {
        this.className = this.className
          .split(' ')
          .filter((c) => c && c !== name)
          .join(' ');
      },
      contains: (name) => this.className.split(' ').includes(name),
    };
    append(...children) {
      for (const child of children) this.appendChild(child);
      return this;
    }
    remove() {
      if (this.parentElement) {
        const i = this.parentElement.children.indexOf(this);
        if (i >= 0) this.parentElement.children.splice(i, 1);
        this.parentElement = null;
      }
      if (this.id) byId.delete(this.id);
    }
    setAttribute(name, value) {
      if (name === 'id') {
        this.id = String(value);
        byId.set(this.id, this);
      } else this._attributes.set(name, String(value));
      if (name === 'hidden') this.hidden = true;
    }
    getAttribute(name) {
      if (this._attributes.has(name)) return this._attributes.get(name);
      if (name === 'id') return this.id || null;
      return null;
    }
    removeAttribute(name) {
      this._attributes.delete(name);
      if (name === 'hidden') this.hidden = false;
    }
    addEventListener(name, listener) {
      if (!this._listeners.has(name)) this._listeners.set(name, new Set());
      this._listeners.get(name).add(listener);
    }
    removeEventListener(name, listener) {
      this._listeners.get(name)?.delete(listener);
    }
    dispatch(name) {
      for (const listener of [...(this._listeners.get(name) || [])])
        listener({ target: this, key: name === 'keydown' ? 'Escape' : undefined });
    }
    contains(node) {
      return node === this || this.children.includes(node);
    }
  }
  const button = new Element('button');
  const doc = {
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => new Element(tag),
    addEventListener() {},
    removeEventListener() {},
  };
  const body = new Element('body');
  doc.body = body;
  byId.set('update-check-btn', button);
  return { doc, button };
}

// ── Fixtures ─────────────────────────────────
const release = (tag, published, assets = []) => ({
  tag_name: tag,
  published_at: published,
  assets,
});
const asset = (name, stamps = {}) => ({
  name,
  browser_download_url: `https://github.com/${REPO}/releases/download/x/${name}`,
  ...stamps,
});

const OLD = '2026-10-20T12:00:00Z';
const NEWER = '2026-10-30T09:00:00Z';
const bundled = { buildTime: '2026-10-25T12:00:00Z', buildSha: 'abc123def456' };
const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── resolveUpdateInfo ────────────────────────

test('resolveUpdateInfo reports an available update per published channel', () => {
  const info = resolveUpdateInfo(
    [
      release('apk-latest', NEWER, [asset('gods-eye-view.apk')]),
      release('ios-latest', OLD, [asset('gods-eye-view.ipa')]),
      release('desktop-latest', NEWER, [asset("God's Eye View Setup 1.2.3.exe")]),
    ],
    bundled,
  );
  assert.deepEqual(
    info.channels.map((c) => [c.id, c.available]),
    [
      ['android', true],
      ['ios', false],
      ['windows', true],
    ],
  );
  const android = info.channels[0];
  assert.equal(
    android.openUrl,
    `https://github.com/${REPO}/releases/download/x/gods-eye-view.apk`,
  );
  assert.equal(android.artefactName, 'gods-eye-view.apk');
});

test('resolveUpdateInfo falls back to the release page when an artefact is missing', () => {
  const info = resolveUpdateInfo([release('ios-latest', NEWER, [])], bundled);
  const ios = info.channels.find((c) => c.id === 'ios');
  assert.equal(ios.ok, true);
  assert.equal(ios.artefactName, null);
  assert.equal(ios.openUrl, `https://github.com/${REPO}/releases/ios-latest`);
});

test('a channel that was never published is unavailable, not an offer', () => {
  const info = resolveUpdateInfo([release('apk-latest', NEWER)], bundled);
  const ios = info.channels.find((c) => c.id === 'ios');
  assert.equal(ios.ok, false);
  assert.equal(ios.available, false);
  assert.equal(ios.publishedAt, null);
});

test('a bundle built after the newest release is current on every channel', () => {
  const info = resolveUpdateInfo(
    CHANNELS.map((c) => release(c.tag, OLD, [asset(c.assetMatch)])),
    { ...bundled, buildTime: NEWER },
  );
  assert.equal(info.channels.every((c) => c.available === false), true);
});

test('malformed payloads resolve to per-channel unavailability, never a throw', () => {
  for (const payload of [null, 'nope', 42, [null, { tag_name: 'apk-latest' }]]) {
    const info = resolveUpdateInfo(payload, bundled);
    assert.equal(info.channels.length, CHANNELS.length);
  }
});

test('the windows matcher only takes the .exe, not any asset named SETUP', () => {
  const info = resolveUpdateInfo(
    [release('desktop-latest', NEWER, [asset('setup-notes.md'), asset('GEV Setup 1.0.exe')])],
    bundled,
  );
  const windows = info.channels.find((c) => c.id === 'windows');
  assert.equal(windows.artefactName, 'GEV Setup 1.0.exe');
});

test('a --clobber republication is an update despite the frozen release date', () => {
  // Real shape of apk-latest on 2026-11-01: the workflow created the release
  // on 2026-10-22 and replaces the APK in place on every run, so
  // release.published_at never moves again — only the asset's own stamps
  // carry the moment the current build was published. A bundle built between
  // the two must still see the replacement as an update it can take.
  const info = resolveUpdateInfo(
    [
      {
        tag_name: 'apk-latest',
        published_at: '2026-10-22T18:49:11Z',
        updated_at: '2026-11-01T13:26:17Z',
        assets: [
          asset('gods-eye-view.apk', {
            created_at: '2026-11-01T13:26:14Z',
            updated_at: '2026-11-01T13:26:16Z',
          }),
        ],
      },
    ],
    { buildTime: '2026-10-28T09:00:00Z', buildSha: 'feedbeef6789' },
  );
  const android = info.channels.find((c) => c.id === 'android');
  assert.equal(android.available, true, 'the replacement counts as an update');
  // The panel's own line dates the artefact, not the page it sits on.
  assert.equal(android.publishedAt, '2026-11-01T13:26:16.000Z');
});

test('an artefact older than the bundle stays current even from a later page date', () => {
  // Guard on the inverse face: a page touched on release-editing churn after
  // the artefact shipped must not turn the same APK into an update.
  const info = resolveUpdateInfo(
    [
      {
        tag_name: 'apk-latest',
        published_at: '2026-10-22T18:49:11Z',
        updated_at: '2026-11-01T13:26:17Z',
        assets: [asset('gods-eye-view.apk', {
          created_at: '2026-11-01T13:26:14Z',
          updated_at: '2026-11-01T13:26:16Z',
        })],
      },
    ],
    { buildTime: '2026-11-02T00:00:00Z', buildSha: 'feedbeef6789' },
  );
  const android = info.channels.find((c) => c.id === 'android');
  assert.equal(android.available, false);
  assert.equal(android.publishedAt, '2026-11-01T13:26:16.000Z');
});

test('assets without stamps fall back to the release page timestamps', () => {
  // The stamp candidates never throw on an asset whose dates were stripped,
  // and resolve to the page's published_at as before.
  const info = resolveUpdateInfo(
    [release('apk-latest', NEWER, [asset('gods-eye-view.apk')])],
    bundled,
  );
  const android = info.channels.find((c) => c.id === 'android');
  assert.equal(android.available, true);
  assert.equal(android.publishedAt, new Date(Date.parse(NEWER)).toISOString());
});

// ── shellPlatform ────────────────────────────

test('shellPlatform reads the three shells the bundle ships on', () => {
  assert.equal(shellPlatform('Mozilla/5.0 (Linux; Android 14) AppleWebKit'), 'android');
  assert.equal(shellPlatform('Mozilla/5.0 (iPhone; CPU iPhone)'), 'ios');
  assert.equal(shellPlatform('Mozilla/5.0 (Windows NT 10.0) Electron'), 'windows');
  assert.equal(shellPlatform(''), 'windows');
});

// ── fetchReleases ────────────────────────────

test('fetchReleases returns [] instead of throwing on network failure', async () => {
  assert.deepEqual(
    await fetchReleases({ fetch: async () => ({ ok: false, status: 403 }) }),
    [],
  );
  assert.deepEqual(
    await fetchReleases({
      fetch: async () => {
        throw new Error('down');
      },
    }),
    [],
  );
  assert.deepEqual(
    await fetchReleases({
      fetch: async () => ({
        ok: true,
        json: async () => [release('apk-latest', OLD)],
      }),
    }),
    [release('apk-latest', OLD)],
  );
});

test('the published API endpoint is the repository the channels read', () => {
  assert.equal(
    RELEASES_API,
    'https://api.github.com/repos/Neo690/gods-eye-view/releases?per_page=20',
  );
});

// ── installUpdatePanel ───────────────────────

test('the panel renders one row per channel and opens the artefact on click', async () => {
  const { doc, button } = makeDoc();
  const opened = [];
  let info;
  let onCheck;
  const panel = installUpdatePanel(
    { document: doc },
    {
      openExternal: (url) => opened.push(url),
      // Inject the same stub shape checkForUpdate has, bypassing the network.
      checkForUpdate: () => info,
    },
  );
  info = resolveUpdateInfo(
    [
      release('apk-latest', NEWER, [asset('gods-eye-view.apk')]),
      release('desktop-latest', OLD, [asset('GEV Setup 1.0.exe')]),
    ],
    bundled,
  );
  button.dispatch('click');
  await drain();
  const dialog = doc.body.children.find((c) => c.tagName === 'DIV');
  assert.ok(dialog, 'the panel body was created');
  const list = dialog.children.find((c) => c.className === 'app-update-rows');
  assert.ok(list, 'the channel list was painted');
  assert.equal(list.children.length, CHANNELS.length);
  // Whichever platform the shell reports is the one row emphasized; the
  // harness runs on the bare Node user agent, so that is the Windows channel.
  const emphasized = list.children.findIndex((c) =>
    String(c.className).includes('app-update-row-current'),
  );
  assert.notEqual(
    emphasized,
    -1,
    "the shell's own channel row is emphasized",
  );
  assert.equal(CHANNELS[emphasized].id, 'windows');
  // The only available channel renders its action button; clicking it opens
  // the artefact url exactly once.
  list.children[0].children[3].dispatch('click');
  assert.deepEqual(opened, [
    `https://github.com/${REPO}/releases/download/x/gods-eye-view.apk`,
  ]);
  panel.destroy();
});

test('a second press hides the panel even if the check was still in flight', async () => {
  const { doc, button } = makeDoc();
  let resolveCheck;
  const panel = installUpdatePanel(
    { document: doc },
    {
      openExternal: () => {},
      checkForUpdate: () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    },
  );
  button.dispatch('click');
  const dialog = doc.body.children.find((c) => c.tagName === 'DIV');
  button.dispatch('click');
  assert.equal(dialog.hidden, true);
  // The late network answer must not paint channel rows into the hidden panel:
  // only the synchronous pre-check scaffold (title, build line, status) is
  // there, and it is not joined by the resolved channel list.
  resolveCheck(resolveUpdateInfo([], bundled));
  await drain();
  assert.equal(
    dialog.children.some((c) => c.className === 'app-update-rows'),
    false,
  );
  panel.destroy();
});

test('the panel is inert on a shell whose chrome carries no update button', () => {
  const { doc } = makeDoc();
  doc.body.children.length = 0;
  doc.getElementById = () => null;
  const panel = installUpdatePanel(
    { document: doc },
    { openExternal: () => {} },
  );
  assert.ok(panel);
  panel.destroy();
});
