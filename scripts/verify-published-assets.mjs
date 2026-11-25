#!/usr/bin/env node
/**
 * Gate over the assets this repository has actually published.
 *
 * The publishing workflows (`windows-installer.yml`, `android-apk.yml`,
 * `ios-app.yml`) upload a rolling release each. A build that uploads the wrong
 * bytes, a feed that names a file the release does not carry, or an APK signed
 * by a key the phone will refuse all look identical from the release page. This
 * script downloads what is published and checks the three promises the release
 * makes:
 *
 *   desktop  `latest.yml` names `gods-eye-view-windows-setup.exe`, its size and
 *            base64 SHA-512 match the downloaded installer, and its version
 *            matches the version in the release notes.
 *   android  `gods-eye-view.apk` is `com.godseye.view`, its versionName matches
 *            the release notes and its versionCode the name, `apksigner`
 *            verifies the signature, and the APK carries a v2/v3 scheme (what
 *            Android 7+ checks before installing an update). When
 *            ANDROID_CERT_SHA256 is pinned, the signing certificate must match.
 *   ios      with no Apple signing secrets configured, `ios-latest` must carry
 *            no `.ipa` at all: a stale one is installable-looking and cannot be
 *            rebuilt. With the secrets configured, the `.ipa` must exist.
 *
 * Nothing here trusts the build: every check reads the published release over
 * the GitHub API and the bytes over the asset URL. A release that is being
 * republished while it is read is re-read rather than reported as a mismatch,
 * because two uploads of one rolling tag are not the same feed and file pair.
 *
 *   node scripts/verify-published-assets.mjs --repo=Neo690/gods-eye-view
 *   node scripts/verify-published-assets.mjs --channel=desktop --apple-signing=false
 *
 * Exit codes: 0 when every channel passes (a SKIP is a pass, see `ios`), 1 when
 * a check fails, 2 for a usage error. GH_TOKEN (or GITHUB_TOKEN) raises the
 * GitHub API limit and is required for a private repository.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APK_APPLICATION_ID,
  parseArgs,
  parseRepo,
} from './install-latest-apk.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USER_AGENT = 'gods-eye-view-published-assets-gate';
const DEFAULT_TIMEOUT_SECONDS = 300;
const SETTLE_ATTEMPTS = 3;
const SETTLE_WAIT_MS = 5000;

/** The three rolling releases the publishing workflows write. */
export const RELEASES = Object.freeze({
  desktop: Object.freeze({
    label: 'Windows installer',
    tag: 'desktop-latest',
    assetName: 'gods-eye-view-windows-setup.exe',
    feedName: 'latest.yml',
  }),
  android: Object.freeze({
    label: 'Android APK',
    tag: 'apk-latest',
    assetName: 'gods-eye-view.apk',
  }),
  ios: Object.freeze({
    label: 'iOS IPA',
    tag: 'ios-latest',
    assetName: 'gods-eye-view.ipa',
  }),
});

export const CHANNELS = Object.freeze(Object.keys(RELEASES));

/** One check: `pass`, `fail` or `skip` (a check that cannot apply). */
export function check(name, status, detail) {
  return { name, status, detail };
}

/** A channel passes unless a check failed; checks that all skip are a skip. */
export function channelStatus(checks) {
  if (checks.some((entry) => entry.status === 'fail')) return 'fail';
  if (checks.some((entry) => entry.status === 'pass')) return 'pass';
  return 'skip';
}

/** Whether the whole gate passes, and which channels made it fail. */
export function summarize(channels) {
  const failed = channels
    .filter((entry) => entry.status === 'fail')
    .map((entry) => entry.channel);
  return { ok: failed.length === 0, failed };
}

/** A file name out of a feed URL (or a bare file name); query and hash dropped. */
export function assetNameFromUrl(value) {
  const text = String(value ?? '').split(/[?#]/)[0];
  return text.slice(text.lastIndexOf('/') + 1);
}

/**
 * Parse electron-builder's `latest.yml`.
 *
 * The file is small, generated, and has a fixed shape: flat `version`, `path`,
 * `sha512` keys and a `files` list of `- url: ... sha512: ... size: ...`
 * entries. Pulling in a YAML parser for that would add a dependency to every
 * install to read six keys, so this reads exactly the subset and leaves
 * anything else alone. Values may be quoted; electron-builder quotes the
 * release date and writes everything else bare.
 *
 * @param {string} text
 * @returns {{version: string|null, path: string|null, sha512: string|null,
 *   files: Array<{url?: string, sha512?: string, size?: string}>}}
 */
export function parseLatestYml(text) {
  const result = { version: null, path: null, sha512: null, files: [] };
  let section = null;
  let entry = null;

  for (const raw of String(text ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (indent === 0) {
      entry = null;
      const { key, value } = splitKeyValue(line);
      if (key === 'files') {
        if (value)
          throw new Error(`latest.yml: "files" is not a list: ${value}`);
        section = 'files';
        continue;
      }
      section = null;
      if (key === 'version') result.version = value;
      else if (key === 'path') result.path = value;
      else if (key === 'sha512') result.sha512 = value;
      continue;
    }

    if (section !== 'files') continue;
    if (line.startsWith('- ')) {
      entry = {};
      result.files.push(entry);
      const { key, value } = splitKeyValue(line.slice(2).trim());
      if (key) entry[key] = value;
      continue;
    }
    if (!entry) continue;
    const { key, value } = splitKeyValue(line);
    if (key) entry[key] = value;
  }

  return result;
}

function splitKeyValue(line) {
  const index = line.indexOf(':');
  if (index === -1) return { key: line.trim(), value: '' };
  const key = line.slice(0, index).trim();
  let value = line.slice(index + 1).trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      value = value.slice(1, -1);
    }
  }
  return { key, value };
}

/** Base64 SHA-512, the encoding electron-builder puts in `latest.yml`. */
export function sha512Base64(buffer) {
  return createHash('sha512').update(buffer).digest('base64');
}

/**
 * The `(1.0.120)` version every publishing workflow writes into its release
 * notes: `Built from <sha> (<version>) on <branch>.`
 *
 * The feed and the APK are checked against the notes so that the three cannot
 * disagree: a release whose notes say one version while its artifact says
 * another is exactly the drift this gate exists for.
 */
export function notesVersion(body) {
  const match = /Built from\s+\S+\s+\(([^)]+)\)/i.exec(String(body ?? ''));
  const value = match?.[1]?.trim() ?? '';
  return /^\d+(?:\.\d+)+$/.test(value) ? value : null;
}

/**
 * The checks over the Windows channel's published feed and installer.
 * @param {{release?: object|null, feedText?: string|null,
 *   installer?: {path: string, bytes: number, sha512: string}|null}} input
 */
export function verifyDesktop({
  release = null,
  feedText = null,
  installer = null,
} = {}) {
  const spec = RELEASES.desktop;
  const checks = [];
  const feedAsset = release?.assets?.find(
    (asset) => asset.name === spec.feedName,
  );
  const installerAsset = release?.assets?.find(
    (asset) => asset.name === spec.assetName,
  );

  checks.push(
    check(
      'release',
      release ? 'pass' : 'fail',
      release
        ? `${spec.tag} is published`
        : `no ${spec.tag} release is published`,
    ),
  );
  if (!release) return checks;

  checks.push(
    check(
      'feed',
      feedAsset ? 'pass' : 'fail',
      feedAsset
        ? `${spec.feedName} is published (${feedAsset.size} bytes)`
        : `${spec.tag} carries no ${spec.feedName}, so the updater has nothing to read`,
    ),
  );
  checks.push(
    check(
      'installer',
      installerAsset ? 'pass' : 'fail',
      installerAsset
        ? `${spec.assetName} is published (${installerAsset.size} bytes)`
        : `${spec.tag} carries no ${spec.assetName}`,
    ),
  );
  if (!feedAsset || !installerAsset) return checks;

  if (!feedText) {
    checks.push(
      check('feed.read', 'fail', `${spec.feedName} could not be read`),
    );
    return checks;
  }
  let feed;
  try {
    feed = parseLatestYml(feedText);
  } catch (error) {
    checks.push(check('feed.read', 'fail', error.message));
    return checks;
  }
  checks.push(
    check(
      'feed.read',
      'pass',
      `${spec.feedName} parsed: version ${feed.version ?? 'missing'}, ${feed.files.length} file entr${
        feed.files.length === 1 ? 'y' : 'ies'
      }`,
    ),
  );

  checks.push(verifyFeedVersion(feed, release));
  checks.push(verifyFeedName(feed, spec.assetName));
  checks.push(verifyFeedSize(feed, installerAsset, spec.assetName));

  if (!installer) {
    checks.push(
      check(
        'installer.download',
        'fail',
        `${spec.assetName} could not be downloaded`,
      ),
    );
    return checks;
  }
  const failures = [];
  if (installer.bytes !== installerAsset.size) {
    failures.push(
      `the download is ${installer.bytes} bytes, the release says ${installerAsset.size}`,
    );
  }
  const declared = declaredSha512(feed, spec.assetName);
  if (!declared.length) {
    failures.push(`${spec.feedName} declares no sha512 for ${spec.assetName}`);
  }
  for (const value of declared) {
    if (value !== installer.sha512) {
      failures.push(
        `latest.yml says ${value}, the download is ${installer.sha512}`,
      );
    }
  }
  checks.push(
    check(
      'feed.sha512',
      failures.length ? 'fail' : 'pass',
      failures.length
        ? failures.join('; ')
        : `sha512 matches the downloaded installer (${installer.bytes} bytes)`,
    ),
  );
  return checks;
}

function verifyFeedVersion(feed, release) {
  const published = notesVersion(release.body);
  if (!feed.version) {
    return check('feed.version', 'fail', 'latest.yml carries no version');
  }
  if (!published) {
    return check(
      'feed.version',
      'fail',
      'the release notes carry no "Built from <sha> (<version>)" line, so the feed version cannot be checked',
    );
  }
  if (feed.version !== published) {
    return check(
      'feed.version',
      'fail',
      `latest.yml says ${feed.version}, the release notes say ${published}`,
    );
  }
  return check(
    'feed.version',
    'pass',
    `version ${feed.version} matches the release notes`,
  );
}

function verifyFeedName(feed, assetName) {
  const named = feed.path || feed.files[0]?.url || '';
  if (!named) {
    return check(
      'feed.name',
      'fail',
      'latest.yml names no file, so the updater cannot fetch one',
    );
  }
  const actual = assetNameFromUrl(named);
  if (actual !== assetName) {
    return check(
      'feed.name',
      'fail',
      `latest.yml names ${actual}, but the release carries ${assetName}`,
    );
  }
  const entry = feed.files.find(
    (file) => assetNameFromUrl(file.url) === assetName,
  );
  if (!entry) {
    return check(
      'feed.name',
      'fail',
      `latest.yml has no file entry for ${assetName}`,
    );
  }
  return check('feed.name', 'pass', `latest.yml names ${assetName}`);
}

function verifyFeedSize(feed, installerAsset, assetName) {
  const entry = feed.files.find(
    (file) => assetNameFromUrl(file.url) === assetName,
  );
  const size = Number(entry?.size);
  if (!Number.isFinite(size) || size <= 0) {
    return check(
      'feed.size',
      'fail',
      `latest.yml declares no size for ${assetName}`,
    );
  }
  if (size !== installerAsset.size) {
    return check(
      'feed.size',
      'fail',
      `latest.yml says ${size} bytes, the release says ${installerAsset.size}`,
    );
  }
  return check('feed.size', 'pass', `${size} bytes, as the release reports`);
}

function declaredSha512(feed, assetName) {
  const values = [];
  if (feed.sha512) values.push(feed.sha512);
  for (const file of feed.files) {
    if (assetNameFromUrl(file.url) !== assetName) continue;
    if (file.sha512) values.push(file.sha512);
  }
  return [...new Set(values)];
}

/**
 * `aapt`/`aapt2 dump badging`'s package line. Both tools print the same fields;
 * reading each field on its own keeps the order from mattering.
 */
export function parseBadging(text) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .find((entry) => entry.startsWith('package: '));
  if (!line) return null;
  const field = (name) =>
    line.match(new RegExp(`\\b${name}='([^']*)'`))?.[1] ?? null;
  return {
    packageName: field('name'),
    versionCode: field('versionCode'),
    versionName: field('versionName'),
  };
}

/**
 * `apksigner verify --verbose --print-certs` output: one entry per signer and
 * the scheme lines. The digest is what an update in place is checked against on
 * the phone.
 */
export function parseApkSigner(text) {
  const signers = new Map();
  const schemes = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const dn = line.match(/^Signer #(\d+) certificate DN: (.*)$/);
    if (dn) {
      const entry = signers.get(dn[1]) ?? { index: Number(dn[1]) };
      entry.dn = dn[2].trim();
      signers.set(dn[1], entry);
      continue;
    }
    const digest = line.match(
      /^Signer #(\d+) certificate SHA-256 digest: ([0-9a-fA-F:]+)$/,
    );
    if (digest) {
      const entry = signers.get(digest[1]) ?? { index: Number(digest[1]) };
      entry.sha256 = normalizeCertificateDigest(digest[2]);
      signers.set(digest[1], entry);
      continue;
    }
    const scheme = line.match(
      /^Verified using v(\d) scheme[^:]*: (true|false)$/,
    );
    if (scheme) schemes[scheme[1]] = scheme[2] === 'true';
  }
  return {
    signers: [...signers.values()].sort((a, b) => a.index - b.index),
    schemes,
  };
}

/** A SHA-256 certificate digest from either the colon-separated or bare form. */
export function normalizeCertificateDigest(value) {
  const text = String(value ?? '').trim();
  const cleaned = text.includes(':')
    ? text.replace(/[:\s]/g, '')
    : text.replace(/\s/g, '');
  return /^[0-9a-fA-F]{64}$/.test(cleaned) ? cleaned.toLowerCase() : null;
}

/**
 * The checks over the Android channel.
 * @param {{release?: object|null, apk?: {path: string, bytes: number}|null,
 *   badgingText?: string|null, badgingError?: string|null,
 *   signerText?: string|null, signerError?: string|null,
 *   pinnedCert?: string|null}} input
 */
export function verifyApk({
  release = null,
  apk = null,
  badgingText = null,
  badgingError = null,
  signerText = null,
  signerError = null,
  pinnedCert = null,
} = {}) {
  const spec = RELEASES.android;
  const checks = [];
  const published = notesVersion(release?.body);
  const apkAsset = release?.assets?.find(
    (asset) => asset.name === spec.assetName,
  );

  checks.push(
    check(
      'release',
      release ? 'pass' : 'fail',
      release
        ? `${spec.tag} is published${published ? ` (notes version ${published})` : ''}`
        : `no ${spec.tag} release is published`,
    ),
  );
  if (!release) return checks;

  checks.push(
    check(
      'apk.asset',
      apkAsset ? 'pass' : 'fail',
      apkAsset
        ? `${spec.assetName} is published (${apkAsset.size} bytes)`
        : `${spec.tag} carries no ${spec.assetName}`,
    ),
  );
  if (!apkAsset) return checks;

  if (!apk) {
    checks.push(
      check(
        'apk.download',
        'fail',
        `${spec.assetName} could not be downloaded`,
      ),
    );
    return checks;
  }
  checks.push(
    check(
      'apk.size',
      apk.bytes === apkAsset.size ? 'pass' : 'fail',
      apk.bytes === apkAsset.size
        ? `${apk.bytes} bytes, as the release reports`
        : `the download is ${apk.bytes} bytes, the release says ${apkAsset.size}`,
    ),
  );

  const badging = badgingText ? parseBadging(badgingText) : null;
  if (!badging) {
    checks.push(
      check(
        'apk.manifest',
        'fail',
        badgingError ||
          'the APK manifest could not be read (aapt/aapt2 printed no package line)',
      ),
    );
  } else {
    checks.push(
      check(
        'apk.manifest',
        'pass',
        `package ${badging.packageName}, versionName ${badging.versionName}, versionCode ${badging.versionCode}`,
      ),
    );
    checks.push(
      check(
        'apk.package',
        badging.packageName === APK_APPLICATION_ID ? 'pass' : 'fail',
        badging.packageName === APK_APPLICATION_ID
          ? `package ${APK_APPLICATION_ID}`
          : `the APK is ${badging.packageName}, not ${APK_APPLICATION_ID}`,
      ),
    );
    if (!published) {
      checks.push(
        check(
          'apk.version',
          'fail',
          'the release notes carry no "Built from <sha> (<version>)" line, so the APK version cannot be checked',
        ),
      );
    } else {
      checks.push(
        check(
          'apk.version',
          badging.versionName === published ? 'pass' : 'fail',
          badging.versionName === published
            ? `versionName ${badging.versionName} matches the release notes`
            : `the APK is ${badging.versionName}, the release notes say ${published}`,
        ),
      );
    }
    const code = String(badging.versionName ?? '')
      .split('.')
      .pop();
    checks.push(
      check(
        'apk.version-code',
        /^\d+$/.test(code) && code === badging.versionCode ? 'pass' : 'fail',
        /^\d+$/.test(code) && code === badging.versionCode
          ? `versionCode ${badging.versionCode} matches versionName ${badging.versionName}`
          : `versionCode ${badging.versionCode} does not match versionName ${badging.versionName}: Android reads this pair as the version to compare`,
      ),
    );
  }

  if (!signerText) {
    checks.push(
      check(
        'apk.signature',
        'fail',
        signerError ||
          'apksigner produced no output, so the signature is unverified',
      ),
    );
    return checks;
  }
  const { signers, schemes } = parseApkSigner(signerText);
  checks.push(
    check(
      'apk.signature',
      signers.length ? 'pass' : 'fail',
      signers.length
        ? 'apksigner verified the APK'
        : 'apksigner found no signer',
    ),
  );
  if (!signers.length) return checks;

  checks.push(
    check(
      'apk.signers',
      'pass',
      signers
        .map(
          (signer) =>
            `signer #${signer.index}${signer.dn ? ` ${signer.dn}` : ''}`,
        )
        .join(', '),
    ),
  );
  const strong = Boolean(schemes[2] || schemes[3]);
  checks.push(
    check(
      'apk.scheme',
      strong ? 'pass' : 'fail',
      strong
        ? `APK Signature Scheme v${schemes[3] ? 3 : 2} verified`
        : 'no v2/v3 signature: Android 7 and later refuse to install this APK',
    ),
  );

  const pin = pinnedCert ? normalizeCertificateDigest(pinnedCert) : null;
  if (pinnedCert && !pin) {
    checks.push(
      check(
        'apk.certificate-pin',
        'fail',
        `ANDROID_CERT_SHA256 is not a SHA-256 digest: ${pinnedCert}`,
      ),
    );
  } else if (!pin) {
    checks.push(
      check(
        'apk.certificate-pin',
        'skip',
        'no ANDROID_CERT_SHA256 is pinned, so the signer is verified but not compared with the key the phone expects',
      ),
    );
  } else {
    const mismatched = signers.filter((signer) => signer.sha256 !== pin);
    checks.push(
      check(
        'apk.certificate-pin',
        mismatched.length ? 'fail' : 'pass',
        mismatched.length
          ? `signer #${mismatched[0].index} is ${mismatched[0].sha256 ?? 'unreadable'}, expected ${pin}`
          : `signer certificate SHA-256 ${pin}`,
      ),
    );
  }
  return checks;
}

/**
 * The checks over the iOS channel.
 *
 * `appleSigning` is whether every secret `ios-app.yml` needs is configured.
 * Absent, the workflow's packaging job never runs, so an `.ipa` in the release
 * is a build from an earlier configuration that no run can refresh; the gate
 * requires it gone. `unknown` (a local run that was not told) skips instead of
 * guessing.
 */
export function verifyIos({ release = null, appleSigning = 'unknown' } = {}) {
  const spec = RELEASES.ios;
  const ipas = (release?.assets ?? []).filter((asset) =>
    asset.name.endsWith('.ipa'),
  );
  if (!['true', 'false', 'unknown'].includes(appleSigning)) {
    return [
      check(
        'apple-signing',
        'fail',
        `--apple-signing must be true, false or unknown: ${appleSigning}`,
      ),
    ];
  }
  if (appleSigning === 'unknown') {
    return [
      check(
        'ipa.absent',
        'skip',
        'Apple signing secret presence was not given, so whether an .ipa is expected is unknown',
      ),
    ];
  }
  if (appleSigning === 'false') {
    return [
      check(
        'ipa.absent',
        ipas.length ? 'fail' : 'pass',
        ipas.length
          ? `${spec.tag} still carries ${ipas.map((asset) => asset.name).join(', ')} while the Apple signing secrets are not configured; no run can rebuild or remove it, so it must be deleted`
          : `the Apple signing secrets are not configured and ${spec.tag} carries no .ipa${
              release
                ? ` (${release.assets.length} asset${release.assets.length === 1 ? '' : 's'} checked)`
                : ' (no release)'
            }`,
      ),
    ];
  }
  const ipa = release?.assets?.find((asset) => asset.name === spec.assetName);
  return [
    check(
      'ipa.present',
      ipa ? 'pass' : 'fail',
      ipa
        ? `${spec.assetName} is published (${ipa.size} bytes)`
        : `the Apple signing secrets are configured but ${spec.tag} carries no ${spec.assetName}`,
    ),
  ];
}

/**
 * Resolve `apksigner`/`aapt2`/`aapt`.
 *
 * CI images install the Android SDK outside PATH under ANDROID_HOME, and this
 * machine does the same, so the newest `build-tools` directory is checked
 * before a bare command name is left for the shell to resolve.
 */
export function resolveAndroidTool(
  name,
  {
    explicit,
    env = process.env,
    exists = existsSync,
    readdir = readdirSync,
  } = {},
) {
  const envName = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  // An explicit path (or APKSIGNER/AAPT2) is used as given: the caller chose
  // it, and spawn reports clearly when it is not executable.
  const configured = explicit || env[envName];
  if (configured) return { path: configured, looked: [configured] };

  const candidates = [];
  const roots = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    '/usr/local/lib/android/sdk',
  ].filter(Boolean);
  for (const root of roots) {
    const buildTools = path.join(root, 'build-tools');
    let versions = [];
    try {
      versions = readdir(buildTools);
    } catch {
      /* no SDK here */
    }
    for (const version of versions.sort(compareVersions).reverse()) {
      candidates.push(path.join(buildTools, version, name));
    }
  }
  const found = candidates.find((candidate) => exists(candidate));
  // A bare name is the PATH fallback: spawn reports ENOENT if it is not there,
  // which the caller reports with the paths it looked at.
  return { path: found ?? name, looked: [...candidates, name] };
}

/** Numeric-aware compare, so build-tools 9 sorts below 35. */
export function compareVersions(a, b) {
  const left = String(a)
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b)
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/** Run a command and keep every stream, so a failure can be reported. */
function runTool(command, args, { timeoutMs = 180_000 } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: (result.stderr || result.error?.message || '').trim(),
  };
}

function apiHeaders(token) {
  return {
    accept: 'application/vnd.github+json',
    'user-agent': USER_AGENT,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * One release as the API describes it, or null when the tag does not exist.
 * `body` is the notes every version check reads.
 */
export async function readRelease({
  repo,
  tag,
  fetchImpl = globalThis.fetch,
  token = '',
  timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000,
}) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repo}/releases/tags/${tag}`,
    {
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (response.status === 404) return null;
  if (response.status === 403 || response.status === 429) {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    const when =
      Number.isFinite(reset) && reset > 0
        ? ` (resets ${new Date(reset * 1000).toISOString()})`
        : '';
    throw new Error(
      `GitHub refused the release lookup with ${response.status}${when}; set GH_TOKEN to raise the API limit`,
    );
  }
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${repo} ${tag}`);
  }
  const data = await response.json();
  return {
    tag: data.tag_name ?? tag,
    body: typeof data.body === 'string' ? data.body : '',
    updatedAt: data.updated_at ?? null,
    assets: (Array.isArray(data.assets) ? data.assets : []).map((asset) => ({
      name: String(asset.name ?? ''),
      size: Number(asset.size ?? 0),
      updatedAt: asset.updated_at ?? null,
      browserDownloadUrl: asset.browser_download_url ?? null,
      url: asset.url ?? null,
    })),
  };
}

/** Stream an asset to disk, hashing it on the way. */
export async function downloadAsset({
  asset,
  directory,
  token = '',
  timeoutMs,
  fetchImpl = globalThis.fetch,
  readText = false,
}) {
  const url = asset.browserDownloadUrl || asset.url;
  if (!url) throw new Error(`${asset.name} has no download URL`);
  const response = await fetchImplUrl(fetchImpl, url, { token, timeoutMs });
  if (!response.ok)
    throw new Error(`downloading ${asset.name} answered ${response.status}`);
  const target = path.join(directory, asset.name);
  const hash = createHash('sha512');
  let bytes = 0;

  if (response.body?.getReader) {
    const stream = createWriteStream(target);
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        hash.update(chunk);
        bytes += chunk.length;
        if (!stream.write(chunk)) await once(stream, 'drain');
      }
    } finally {
      stream.end();
      await once(stream, 'close');
    }
  } else {
    const buffer = Buffer.from(await response.arrayBuffer());
    hash.update(buffer);
    bytes = buffer.length;
    writeFileSync(target, buffer);
  }

  return {
    name: asset.name,
    path: target,
    bytes,
    sha512: hash.digest('base64'),
    text: readText ? readFileSync(target, 'utf8') : undefined,
  };
}

async function fetchImplUrl(fetchImpl, url, { token, timeoutMs }) {
  return fetchImpl(url, {
    redirect: 'follow',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'user-agent': USER_AGENT,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** The fields that must not change between reading a release and its bytes. */
function releaseSnapshot(release) {
  const assets = release.assets
    .map((asset) => `${asset.name}:${asset.size}:${asset.updatedAt}`)
    .sort()
    .join(',');
  return `${release.updatedAt}|${assets}`;
}

/**
 * Read a release and its wanted assets as one consistent snapshot.
 *
 * A rolling tag is clobbered in place, so a gate that reads `latest.yml` and
 * then the installer can straddle two uploads. The release metadata is read
 * again after the downloads; when either read differs, the pair was never a
 * published state and is fetched again instead of reported as a mismatch.
 */
export async function readStableRelease({
  repo,
  tag,
  wanted = [],
  directory,
  token = '',
  timeoutMs,
  readTextFor = () => false,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt += 1) {
    const before = await readRelease({
      repo,
      tag,
      token,
      timeoutMs,
      fetchImpl,
    });
    if (!before) return { release: null, files: {} };
    if (!wanted.length) return { release: before, files: {} };

    const files = {};
    for (const name of wanted) {
      const asset = before.assets.find((candidate) => candidate.name === name);
      if (!asset) continue;
      files[name] = await downloadAsset({
        asset,
        directory,
        token,
        timeoutMs,
        fetchImpl,
        readText: readTextFor(name),
      });
    }

    const after = await readRelease({ repo, tag, token, timeoutMs, fetchImpl });
    if (after && releaseSnapshot(before) === releaseSnapshot(after)) {
      return { release: after, files };
    }
    for (const file of Object.values(files)) rmSync(file.path, { force: true });
    if (attempt < SETTLE_ATTEMPTS) await sleep(SETTLE_WAIT_MS);
  }
  throw new Error(
    `the ${tag} release changed while it was being read (${SETTLE_ATTEMPTS} attempts); re-run once the publisher has settled`,
  );
}

function failChannel(channel, detail) {
  return {
    channel,
    status: 'fail',
    checks: [check('release', 'fail', detail)],
  };
}

async function runDesktop(context) {
  if (context.log) context.log('desktop: reading latest.yml and the installer');
  const spec = RELEASES.desktop;
  const { release, files } = await readStableRelease({
    repo: context.repo,
    tag: spec.tag,
    wanted: [spec.feedName, spec.assetName],
    directory: context.directory,
    token: context.token,
    timeoutMs: context.timeoutMs,
    fetchImpl: context.fetchImpl,
    readTextFor: (name) => name === spec.feedName,
  });
  const checks = verifyDesktop({
    release,
    feedText: files[spec.feedName]?.text ?? null,
    installer: files[spec.assetName] ?? null,
  });
  return { channel: 'desktop', status: channelStatus(checks), checks };
}

async function runAndroid(context) {
  if (context.log) context.log('android: reading the APK');
  const spec = RELEASES.android;
  const { release, files } = await readStableRelease({
    repo: context.repo,
    tag: spec.tag,
    wanted: [spec.assetName],
    directory: context.directory,
    token: context.token,
    timeoutMs: context.timeoutMs,
    fetchImpl: context.fetchImpl,
  });
  const apk = files[spec.assetName] ?? null;
  let badgingText = null;
  let badgingError = null;
  let signerText = null;
  let signerError = null;

  if (apk) {
    const aapt2 = resolveAndroidTool('aapt2');
    const badging = runTool(aapt2.path, ['dump', 'badging', apk.path]);
    if (badging.status === 0) badgingText = badging.stdout;
    else {
      const aapt = resolveAndroidTool('aapt');
      const retry = runTool(aapt.path, ['dump', 'badging', apk.path]);
      if (retry.status === 0) badgingText = retry.stdout;
      else {
        badgingError = `aapt2 (${aapt2.path}): ${badging.stderr || `exit ${badging.status}`}; aapt (${aapt.path}): ${retry.stderr || `exit ${retry.status}`}`;
      }
    }

    if (context.log)
      context.log('android: verifying the signature with apksigner');
    const apksigner = resolveAndroidTool('apksigner');
    // `--verbose` is what prints the "Verified using vN scheme" lines the
    // gate reads; `--print-certs` alone prints only the certificate.
    const signature = runTool(apksigner.path, [
      'verify',
      '--verbose',
      '--print-certs',
      apk.path,
    ]);
    if (signature.status === 0) signerText = signature.stdout;
    else {
      signerError = `apksigner (${apksigner.path}) exited ${signature.status}: ${signature.stderr || signature.stdout || 'no output'}`;
    }
  }

  const checks = verifyApk({
    release,
    apk,
    badgingText,
    badgingError,
    signerText,
    signerError,
    pinnedCert: context.pinnedCert,
  });
  return { channel: 'android', status: channelStatus(checks), checks };
}

async function runIos(context) {
  const spec = RELEASES.ios;
  const release = await readRelease({
    repo: context.repo,
    tag: spec.tag,
    token: context.token,
    timeoutMs: context.timeoutMs,
    fetchImpl: context.fetchImpl,
  });
  const checks = verifyIos({ release, appleSigning: context.appleSigning });
  return { channel: 'ios', status: channelStatus(checks), checks };
}

const RUNNERS = { desktop: runDesktop, android: runAndroid, ios: runIos };

/**
 * Run every requested channel. A channel that cannot even read its release is
 * a failure, never a skip: "could not verify" is not "verified".
 */
export async function verifyPublishedAssets({
  repo,
  channels = CHANNELS,
  appleSigning = 'unknown',
  pinnedCert = null,
  directory,
  token = '',
  timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000,
  fetchImpl = globalThis.fetch,
  log = null,
} = {}) {
  const results = [];
  for (const channel of channels) {
    try {
      results.push(
        await RUNNERS[channel]({
          repo,
          directory,
          token,
          timeoutMs,
          fetchImpl,
          log,
          appleSigning,
          pinnedCert,
        }),
      );
    } catch (error) {
      results.push(failChannel(channel, error.message));
    }
  }
  const report = {
    repository: repo,
    generatedAt: new Date().toISOString(),
    channels: results,
    ...summarize(results),
  };
  return report;
}

function appleSigningOption(value) {
  if (value === undefined) return 'unknown';
  const text = String(value).toLowerCase();
  if (['true', 'yes', '1'].includes(text)) return 'true';
  if (['false', 'no', '0'].includes(text)) return 'false';
  if (text === 'unknown') return 'unknown';
  throw new Error(
    `--apple-signing must be true, false or unknown, not ${value}`,
  );
}

function originRepo() {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return result.status === 0 ? parseRepo(result.stdout) : null;
}

const USAGE = `usage: node scripts/verify-published-assets.mjs [options]
  --repo=<owner/name>          repository whose releases are checked (default: origin)
  --channel=<name>             desktop, android or ios; comma-separated (default: all three)
  --apple-signing=<bool>       whether every Apple signing secret is configured;
                               false requires ios-latest to carry no .ipa.
                               (default: $APPLE_SIGNING_SECRETS, else unknown)
  --android-cert-sha256=<hex>  expected APK signer certificate; also $ANDROID_CERT_SHA256
  --json=<path>                write the machine-readable report
  --work-dir=<path>            where downloads land (default: a temporary directory)
  --keep                       keep the downloaded files
  --timeout=<seconds>          per HTTP request (default ${DEFAULT_TIMEOUT_SECONDS})
  --verbose                    print every check, including the passing ones
  --help                       this text

Exit status: 0 when every channel passes, 1 when a check fails, 2 on usage.
GH_TOKEN (or GITHUB_TOKEN) raises the GitHub API limit.
`;

function printReport(report, { verbose }) {
  const width = Math.max(
    ...report.channels.map((entry) => entry.channel.length),
  );
  console.log(`Published assets gate — ${report.repository}`);
  for (const entry of report.channels) {
    const label = RELEASES[entry.channel].label;
    console.log(
      `${entry.channel.padEnd(width)}  ${entry.status.toUpperCase().padEnd(5)}  ${label}`,
    );
    for (const result of entry.checks) {
      if (!verbose && result.status === 'pass') continue;
      console.log(
        `  ${result.status.padEnd(5)}  ${result.name.padEnd(20)} ${result.detail}`,
      );
    }
  }
  const failed = report.channels.flatMap((entry) =>
    entry.checks
      .filter((result) => result.status === 'fail')
      .map((result) => `${entry.channel}: ${result.detail}`),
  );
  for (const detail of failed) {
    console.error(
      `${process.env.GITHUB_ACTIONS === 'true' ? '::error::' : 'error: '}${detail}`,
    );
  }
  console.log(report.ok ? 'published assets: PASS' : 'published assets: FAIL');
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(
      argv,
      new Set([
        'repo',
        'channel',
        'apple-signing',
        'android-cert-sha256',
        'json',
        'work-dir',
        'keep',
        'timeout',
        'verbose',
        'help',
      ]),
    );
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const valueFlags = [
    'repo',
    'channel',
    'apple-signing',
    'android-cert-sha256',
    'json',
    'work-dir',
    'timeout',
  ];
  const valueless = valueFlags.find(
    (flag) => flag in options && typeof options[flag] !== 'string',
  );
  if (valueless) {
    console.error(`--${valueless} needs a value`);
    console.error(USAGE);
    return 2;
  }

  const repo = options.repo || originRepo();
  if (!repo) {
    console.error(
      'cannot tell which repository to check: pass --repo=owner/name',
    );
    return 2;
  }

  const channels = (
    options.channel ? String(options.channel).split(',') : CHANNELS
  )
    .map((value) => value.trim())
    .filter(Boolean);
  const unknownChannel = channels.find((channel) => !RELEASES[channel]);
  if (unknownChannel) {
    console.error(
      `unknown channel ${unknownChannel}; choose from ${CHANNELS.join(', ')}`,
    );
    return 2;
  }

  let appleSigning;
  try {
    appleSigning = appleSigningOption(
      options['apple-signing'] ?? process.env.APPLE_SIGNING_SECRETS,
    );
  } catch (error) {
    console.error(error.message);
    return 2;
  }

  const timeoutMs =
    Math.max(10, Number(options.timeout) || DEFAULT_TIMEOUT_SECONDS) * 1000;
  const keep = Boolean(options.keep);
  let directory = options['work-dir']
    ? path.resolve(String(options['work-dir']))
    : null;
  if (directory) mkdirSync(directory, { recursive: true });
  else directory = mkdtempSync(path.join(tmpdir(), 'gev-published-assets-'));

  try {
    const report = await verifyPublishedAssets({
      repo,
      channels,
      appleSigning,
      pinnedCert:
        options['android-cert-sha256'] ??
        process.env.ANDROID_CERT_SHA256 ??
        null,
      directory,
      token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '',
      timeoutMs,
      log: (line) => console.log(line),
    });
    if (options.json) {
      const target = path.resolve(String(options.json));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
    }
    printReport(report, { verbose: Boolean(options.verbose) });
    return report.ok ? 0 : 1;
  } finally {
    if (!keep && !options['work-dir'])
      rmSync(directory, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  const code = await main(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}
