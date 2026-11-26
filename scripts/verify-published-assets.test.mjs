import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assetNameFromUrl,
  channelStatus,
  compareVersions,
  normalizeCertificateDigest,
  notesCommit,
  notesVersion,
  parseApkSigner,
  parseBadging,
  parseLatestYml,
  resolveAndroidTool,
  sha256Hex,
  sha512Base64,
  summarize,
  verifyApk,
  verifyDesktop,
  verifyIos,
  verifyProvenance,
  verifyPublishedAssets,
} from './verify-published-assets.mjs';

const INSTALLER = Buffer.from('a windows installer, in miniature');
const INSTALLER_SHA = sha512Base64(INSTALLER);
const INSTALLER_NAME = 'gods-eye-view-windows-setup.exe';
const COMMIT = `${'92d8f27'}${'0'.repeat(33)}`;

/** A manifest and its SBOM, both matching the bytes they describe. */
function provenanceFor({
  tag = 'desktop-latest',
  platform = 'windows',
  assetName = INSTALLER_NAME,
  bytes = INSTALLER,
  version = '1.0.120',
  commit = COMMIT,
} = {}) {
  const digest = sha256Hex(bytes);
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    metadata: {
      component: { type: 'application', name: "God's Eye View", version },
      properties: [
        { name: 'gev:platform', value: platform },
        { name: 'gev:release', value: tag },
        { name: 'gev:commit', value: commit },
      ],
    },
    components: [
      {
        type: 'file',
        name: assetName,
        hashes: [{ alg: 'SHA-256', content: digest }],
      },
      { type: 'library', name: 'example', version: '1.0.0' },
    ],
  };
  const sbomText = `${JSON.stringify(sbom, null, 2)}\n`;
  const manifest = {
    schemaVersion: 1,
    platform,
    release: tag,
    commit,
    version,
    bundle: { name: assetName, size: bytes.length, sha256: digest },
    sbom: {
      name: 'sbom.cdx.json',
      format: 'CycloneDX',
      specVersion: '1.5',
      size: Buffer.byteLength(sbomText),
      sha256: sha256Hex(Buffer.from(sbomText)),
      components: sbom.components.length,
    },
  };
  return {
    manifestText: `${JSON.stringify(manifest, null, 2)}\n`,
    sbomText,
    manifest,
    sbom,
  };
}

const FEED = [
  'version: 1.0.120',
  'files:',
  `  - url: ${INSTALLER_NAME}`,
  `    sha512: ${INSTALLER_SHA}`,
  `    size: ${INSTALLER.length}`,
  `path: ${INSTALLER_NAME}`,
  `sha512: ${INSTALLER_SHA}`,
  "releaseDate: '2026-11-23T00:34:33.437Z'",
  '',
].join('\n');

const BADGING = [
  "package: name='com.godseye.view' versionCode='1175' versionName='1.0.1175' platformBuildVersionName='16' platformBuildVersionCode='36' compileSdkVersion='36' compileSdkVersionCodename='16'",
  "application-label:'God's Eye View'",
  '',
].join('\n');

const SIGNER = [
  'Verifies',
  'Verified using v1 scheme (JAR signing): false',
  'Verified using v2 scheme (APK Signature Scheme v2): true',
  'Verified using v3 scheme (APK Signature Scheme v3): true',
  'Verified using v4 scheme (APK Signature Scheme v4): false',
  'Signer #1 certificate DN: CN=Gods Eye View, O=Neo690',
  'Signer #1 certificate SHA-256 digest: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  'Signer #1 certificate SHA-1 digest: 0123456789abcdef0123456789abcdef01234567',
  'Signer #1 certificate MD5 digest: 0123456789abcdef0123456789abcdef',
  '',
].join('\n');

function desktopRelease({
  body = 'Built from 92d8f27 (1.0.120) on main.',
  assets = null,
} = {}) {
  const provenance = provenanceFor();
  return {
    tag: 'desktop-latest',
    body,
    updatedAt: '2026-11-23T00:34:33Z',
    assets:
      assets ??
      [
        {
          name: 'latest.yml',
          size: Buffer.byteLength(FEED),
          updatedAt: '2026-11-23T00:34:33Z',
        },
        {
          name: INSTALLER_NAME,
          size: INSTALLER.length,
          updatedAt: '2026-11-23T00:34:33Z',
        },
        {
          name: 'provenance.json',
          size: Buffer.byteLength(provenance.manifestText),
          updatedAt: '2026-11-23T00:34:33Z',
        },
        {
          name: 'sbom.cdx.json',
          size: Buffer.byteLength(provenance.sbomText),
          updatedAt: '2026-11-23T00:34:33Z',
        },
      ],
  };
}

function apkRelease({
  body = 'Built from 92d8f27 (1.0.1175) on main.',
  bytes = Buffer.from('apk bytes'),
} = {}) {
  return {
    tag: 'apk-latest',
    body,
    updatedAt: '2026-11-23T12:00:00Z',
    assets: [
      {
        name: 'gods-eye-view.apk',
        size: bytes.length,
        updatedAt: '2026-11-23T12:00:00Z',
      },
    ],
  };
}

test('latest.yml is read as electron-builder writes it', () => {
  assert.deepEqual(parseLatestYml(FEED), {
    version: '1.0.120',
    path: INSTALLER_NAME,
    sha512: INSTALLER_SHA,
    files: [
      {
        url: INSTALLER_NAME,
        sha512: INSTALLER_SHA,
        size: String(INSTALLER.length),
      },
    ],
  });
});

test('quoted values and the older flat feed parse the same way', () => {
  const quoted = [
    "version: '1.0.120'",
    'files:',
    `  - url: "${INSTALLER_NAME}"`,
    `    sha512: "${INSTALLER_SHA}"`,
    `    size: ${INSTALLER.length}`,
    `path: "${INSTALLER_NAME}"`,
    `sha512: "${INSTALLER_SHA}"`,
    '',
  ].join('\n');
  assert.equal(parseLatestYml(quoted).version, '1.0.120');
  assert.equal(parseLatestYml(quoted).files[0].url, INSTALLER_NAME);
  assert.equal(parseLatestYml(quoted).path, INSTALLER_NAME);

  const flat = [
    'version: 1.0.1',
    `path: ${INSTALLER_NAME}`,
    `sha512: ${INSTALLER_SHA}`,
  ].join('\n');
  assert.deepEqual(parseLatestYml(flat), {
    version: '1.0.1',
    path: INSTALLER_NAME,
    sha512: INSTALLER_SHA,
    files: [],
  });
});

test('a feed URL yields the file name the release carries', () => {
  assert.equal(
    assetNameFromUrl(
      'https://github.com/o/r/releases/download/desktop-latest/gods-eye-view-windows-setup.exe',
    ),
    INSTALLER_NAME,
  );
  assert.equal(assetNameFromUrl(`${INSTALLER_NAME}?x=1#frag`), INSTALLER_NAME);
  assert.equal(assetNameFromUrl(''), '');
});

test('sha512 is the base64 of the digest, as latest.yml declares it', () => {
  // NIST's SHA-512("abc"), so the encoding is checked against a vector rather
  // than against the same hash function the implementation calls.
  const hex =
    'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a' +
    '2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f';
  assert.equal(
    sha512Base64(Buffer.from('abc')),
    Buffer.from(hex, 'hex').toString('base64'),
  );
});

test('the published version is read out of the notes the workflows write', () => {
  assert.equal(
    notesVersion('Built from 92d8f27 (1.0.1175) on main.'),
    '1.0.1175',
  );
  assert.equal(
    notesVersion('Built from 92d8f27 (1.0.120) on main.'),
    '1.0.120',
  );
  assert.equal(notesVersion('Updated by hand'), null);
  assert.equal(notesVersion(''), null);
});

test('the published commit is read from the notes, short or full', () => {
  assert.equal(notesCommit('Built from 92d8f27 (1.0.120) on main.'), '92d8f27');
  assert.equal(
    notesCommit(`Built from ${COMMIT} (1.0.120) on main.`),
    COMMIT,
  );
  assert.equal(notesCommit('Updated by hand'), null);
});

function downloaded(text) {
  return {
    text,
    bytes: Buffer.byteLength(text),
    sha256: sha256Hex(Buffer.from(text)),
  };
}

function bundleFor(bytes = INSTALLER) {
  return {
    name: INSTALLER_NAME,
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
  };
}

function desktopReleaseFor(manifestText, sbomText) {
  return desktopRelease({
    assets: [
      { name: 'latest.yml', size: Buffer.byteLength(FEED) },
      { name: INSTALLER_NAME, size: INSTALLER.length },
      { name: 'provenance.json', size: Buffer.byteLength(manifestText) },
      { name: 'sbom.cdx.json', size: Buffer.byteLength(sbomText) },
    ],
  });
}

test('the provenance manifest ties commit, version, bundle and SBOM together', () => {
  const provenance = provenanceFor();
  const checks = verifyProvenance({
    channel: 'desktop',
    release: desktopRelease(),
    manifest: downloaded(provenance.manifestText),
    sbom: downloaded(provenance.sbomText),
    bundle: bundleFor(),
  });
  assert.equal(channelStatus(checks), 'pass', JSON.stringify(checks));
  assert.equal(
    checks.find((entry) => entry.name === 'provenance.commit').status,
    'pass',
  );
});

test('a manifest naming another commit than the release notes fails', () => {
  const provenance = provenanceFor();
  provenance.manifest.commit = 'f'.repeat(40);
  const manifestText = `${JSON.stringify(provenance.manifest)}\n`;
  const checks = verifyProvenance({
    channel: 'desktop',
    release: desktopReleaseFor(manifestText, provenance.sbomText),
    manifest: downloaded(manifestText),
    sbom: downloaded(provenance.sbomText),
    bundle: bundleFor(),
  });
  const commit = checks.find((entry) => entry.name === 'provenance.commit');
  assert.equal(commit.status, 'fail');
  assert.match(commit.detail, /release notes name 92d8f27/);
});

test('a manifest whose bundle digest disagrees with the bytes fails', () => {
  const provenance = provenanceFor();
  provenance.manifest.bundle.sha256 = '0'.repeat(64);
  const manifestText = `${JSON.stringify(provenance.manifest)}\n`;
  const checks = verifyProvenance({
    channel: 'desktop',
    release: desktopReleaseFor(manifestText, provenance.sbomText),
    manifest: downloaded(manifestText),
    sbom: downloaded(provenance.sbomText),
    bundle: bundleFor(),
  });
  assert.equal(
    checks.find((entry) => entry.name === 'provenance.bundle').status,
    'fail',
  );
});

test('an SBOM that does not hash to the manifest value fails', () => {
  const provenance = provenanceFor();
  const checks = verifyProvenance({
    channel: 'desktop',
    release: desktopRelease(),
    manifest: downloaded(provenance.manifestText),
    sbom: downloaded(`${provenance.sbomText}\n`),
    bundle: bundleFor(),
  });
  assert.equal(
    checks.find((entry) => entry.name === 'provenance.sbom').status,
    'fail',
  );
});

test('an SBOM that is not a JSON object fails instead of crashing', () => {
  const provenance = provenanceFor();
  const checks = verifyProvenance({
    channel: 'desktop',
    release: desktopRelease(),
    manifest: downloaded(provenance.manifestText),
    sbom: downloaded('null\n'),
    bundle: bundleFor(),
  });
  assert.equal(
    checks.find((entry) => entry.name === 'provenance.sbom-format').status,
    'fail',
  );
});

test('a manifest naming another SBOM format version fails', () => {
  const provenance = provenanceFor();
  provenance.manifest.sbom.specVersion = '1.6';
  const manifestText = `${JSON.stringify(provenance.manifest)}\n`;
  const checks = verifyProvenance({
    channel: 'desktop',
    release: desktopReleaseFor(manifestText, provenance.sbomText),
    manifest: downloaded(manifestText),
    sbom: downloaded(provenance.sbomText),
    bundle: bundleFor(),
  });
  assert.equal(
    checks.find((entry) => entry.name === 'provenance.sbom-format').status,
    'fail',
  );
});

test('a release without provenance cannot pass the gate', () => {
  const checks = verifyProvenance({
    channel: 'desktop',
    release: desktopRelease({
      assets: [{ name: INSTALLER_NAME, size: INSTALLER.length }],
    }),
    manifest: null,
    sbom: null,
    bundle: bundleFor(),
  });
  assert.equal(channelStatus(checks), 'fail');
  assert.match(checks[0].detail, /carries no provenance\.json/);
});

test('a matching feed, installer and release notes pass the desktop channel', () => {
  const checks = verifyDesktop({
    release: desktopRelease(),
    feedText: FEED,
    installer: {
      path: '/tmp/installer.exe',
      bytes: INSTALLER.length,
      sha512: INSTALLER_SHA,
    },
  });
  assert.equal(channelStatus(checks), 'pass');
  assert.equal(
    checks.find((entry) => entry.name === 'feed.sha512').status,
    'pass',
  );
});

test('a feed whose SHA-512 does not match the bytes fails the gate', () => {
  const checks = verifyDesktop({
    release: desktopRelease(),
    feedText: FEED.replace(
      INSTALLER_SHA,
      sha512Base64(Buffer.from('something else')),
    ),
    installer: {
      path: '/tmp/installer.exe',
      bytes: INSTALLER.length,
      sha512: INSTALLER_SHA,
    },
  });
  const result = checks.find((entry) => entry.name === 'feed.sha512');
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /latest\.yml says .*the download is/);
});

test('a feed that declares no SHA-512 at all fails the gate', () => {
  const stripped = FEED.replace(/^sha512: .*$/m, '').replace(
    /^    sha512: .*$/m,
    '',
  );
  const checks = verifyDesktop({
    release: desktopRelease(),
    feedText: stripped,
    installer: {
      path: '/tmp/installer.exe',
      bytes: INSTALLER.length,
      sha512: INSTALLER_SHA,
    },
  });
  assert.equal(
    checks.find((entry) => entry.name === 'feed.sha512').status,
    'fail',
  );
  assert.match(
    checks.find((entry) => entry.name === 'feed.sha512').detail,
    /declares no sha512/,
  );
});

test('a truncated download fails even when the feed is intact', () => {
  const checks = verifyDesktop({
    release: desktopRelease(),
    feedText: FEED,
    installer: {
      path: '/tmp/installer.exe',
      bytes: INSTALLER.length - 1,
      sha512: INSTALLER_SHA,
    },
  });
  assert.equal(
    checks.find((entry) => entry.name === 'feed.sha512').status,
    'fail',
  );
});

test('a feed naming a different file than the release carries fails the gate', () => {
  const renamed = FEED.replaceAll(INSTALLER_NAME, 'gods-eye-view-1.0.120.exe');
  const checks = verifyDesktop({
    release: desktopRelease(),
    feedText: renamed,
    installer: {
      path: '/tmp/installer.exe',
      bytes: INSTALLER.length,
      sha512: INSTALLER_SHA,
    },
  });
  assert.equal(
    checks.find((entry) => entry.name === 'feed.name').status,
    'fail',
  );
  assert.match(
    checks.find((entry) => entry.name === 'feed.name').detail,
    /gods-eye-view-1\.0\.120\.exe/,
  );
});

test('a feed version the notes disagree with fails the gate', () => {
  const checks = verifyDesktop({
    release: desktopRelease({ body: 'Built from 92d8f27 (1.0.121) on main.' }),
    feedText: FEED,
    installer: {
      path: '/tmp/installer.exe',
      bytes: INSTALLER.length,
      sha512: INSTALLER_SHA,
    },
  });
  const result = checks.find((entry) => entry.name === 'feed.version');
  assert.equal(result.status, 'fail');
  assert.match(
    result.detail,
    /latest\.yml says 1\.0\.120, the release notes say 1\.0\.121/,
  );
});

test('notes without a version cannot vouch for the feed, so the gate fails', () => {
  const checks = verifyDesktop({
    release: desktopRelease({ body: 'Built from 92d8f27 on main.' }),
    feedText: FEED,
    installer: {
      path: '/tmp/installer.exe',
      bytes: INSTALLER.length,
      sha512: INSTALLER_SHA,
    },
  });
  assert.equal(
    checks.find((entry) => entry.name === 'feed.version').status,
    'fail',
  );
});

test('a release missing the installer or the feed fails before any download', () => {
  const noInstaller = verifyDesktop({
    release: desktopRelease({ assets: [{ name: 'latest.yml', size: 1 }] }),
  });
  assert.equal(channelStatus(noInstaller), 'fail');
  assert.equal(
    noInstaller.find((entry) => entry.name === 'installer').status,
    'fail',
  );

  const noRelease = verifyDesktop({ release: null });
  assert.equal(channelStatus(noRelease), 'fail');
  assert.match(noRelease[0].detail, /no desktop-latest release is published/);
});

test('an APK manifest is read from the badging line, whatever the field order', () => {
  assert.deepEqual(parseBadging(BADGING), {
    packageName: 'com.godseye.view',
    versionCode: '1175',
    versionName: '1.0.1175',
  });
  const reordered =
    "package: versionName='1.0.1175' name='com.godseye.view' versionCode='1175'";
  assert.deepEqual(parseBadging(reordered), {
    packageName: 'com.godseye.view',
    versionCode: '1175',
    versionName: '1.0.1175',
  });
  assert.equal(parseBadging('W/ziparchive: something odd'), null);
});

test('apksigner output yields the signer and the schemes that were verified', () => {
  const parsed = parseApkSigner(SIGNER);
  assert.equal(parsed.signers.length, 1);
  assert.equal(
    parsed.signers[0].sha256,
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  );
  assert.equal(parsed.schemes[2], true);
  assert.equal(parsed.schemes[3], true);
  assert.equal(parsed.schemes[1], false);
});

test('a certificate digest is normalised from either form', () => {
  const bare =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const colon = bare.toUpperCase().match(/.{2}/g).join(':');
  assert.equal(normalizeCertificateDigest(colon), bare);
  assert.equal(normalizeCertificateDigest(`  ${bare}  `), bare);
  assert.equal(normalizeCertificateDigest('not a digest'), null);
  assert.equal(normalizeCertificateDigest(bare.slice(2)), null);
});

test('a matching APK passes the android channel', () => {
  const bytes = Buffer.from('apk bytes');
  const checks = verifyApk({
    release: apkRelease({ bytes }),
    apk: { path: '/tmp/gods-eye-view.apk', bytes: bytes.length },
    badgingText: BADGING,
    signerText: SIGNER,
  });
  assert.equal(channelStatus(checks), 'pass');
  assert.equal(
    checks.find((entry) => entry.name === 'apk.certificate-pin').status,
    'skip',
  );
});

test('the APK version must match the notes and its version code the name', () => {
  const wrongVersion = verifyApk({
    release: apkRelease(),
    apk: {
      path: '/tmp/gods-eye-view.apk',
      bytes: Buffer.byteLength('apk bytes'),
    },
    badgingText: BADGING.replace('1.0.1175', '1.0.1174').replace(
      "versionCode='1175'",
      "versionCode='1174'",
    ),
    signerText: SIGNER,
  });
  assert.equal(
    wrongVersion.find((entry) => entry.name === 'apk.version').status,
    'fail',
  );
  assert.match(
    wrongVersion.find((entry) => entry.name === 'apk.version').detail,
    /the APK is 1\.0\.1174/,
  );

  const wrongCode = verifyApk({
    release: apkRelease(),
    apk: {
      path: '/tmp/gods-eye-view.apk',
      bytes: Buffer.byteLength('apk bytes'),
    },
    badgingText: BADGING.replace("versionCode='1175'", "versionCode='1174'"),
    signerText: SIGNER,
  });
  assert.equal(
    wrongCode.find((entry) => entry.name === 'apk.version-code').status,
    'fail',
  );
});

test('an APK for another package or without a v2/v3 signature fails', () => {
  const otherPackage = verifyApk({
    release: apkRelease(),
    apk: {
      path: '/tmp/gods-eye-view.apk',
      bytes: Buffer.byteLength('apk bytes'),
    },
    badgingText: BADGING.replace('com.godseye.view', 'com.example.other'),
    signerText: SIGNER,
  });
  assert.equal(
    otherPackage.find((entry) => entry.name === 'apk.package').status,
    'fail',
  );

  const v1Only = verifyApk({
    release: apkRelease(),
    apk: {
      path: '/tmp/gods-eye-view.apk',
      bytes: Buffer.byteLength('apk bytes'),
    },
    badgingText: BADGING,
    signerText: SIGNER.replace(
      'Verified using v1 scheme (JAR signing): false',
      'Verified using v1 scheme (JAR signing): true',
    )
      .replace(
        'v2 scheme (APK Signature Scheme v2): true',
        'v2 scheme (APK Signature Scheme v2): false',
      )
      .replace(
        'v3 scheme (APK Signature Scheme v3): true',
        'v3 scheme (APK Signature Scheme v3): false',
      ),
  });
  assert.equal(
    v1Only.find((entry) => entry.name === 'apk.scheme').status,
    'fail',
  );
  assert.match(
    v1Only.find((entry) => entry.name === 'apk.scheme').detail,
    /Android 7/,
  );
});

test('a signature apksigner refuses fails the gate with its reason', () => {
  const checks = verifyApk({
    release: apkRelease(),
    apk: {
      path: '/tmp/gods-eye-view.apk',
      bytes: Buffer.byteLength('apk bytes'),
    },
    badgingText: BADGING,
    signerError: 'apksigner exited 1: DOES NOT VERIFY',
  });
  assert.equal(
    checks.find((entry) => entry.name === 'apk.signature').status,
    'fail',
  );
  assert.match(
    checks.find((entry) => entry.name === 'apk.signature').detail,
    /DOES NOT VERIFY/,
  );
});

test('a pinned certificate must match every signer', () => {
  const digest =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const base = {
    release: apkRelease(),
    apk: {
      path: '/tmp/gods-eye-view.apk',
      bytes: Buffer.byteLength('apk bytes'),
    },
    badgingText: BADGING,
    signerText: SIGNER,
  };
  assert.equal(
    verifyApk({ ...base, pinnedCert: digest }).find(
      (entry) => entry.name === 'apk.certificate-pin',
    ).status,
    'pass',
  );
  assert.equal(
    verifyApk({ ...base, pinnedCert: digest.replace('0123', 'fedc') }).find(
      (entry) => entry.name === 'apk.certificate-pin',
    ).status,
    'fail',
  );
  assert.equal(
    verifyApk({ ...base, pinnedCert: 'not-a-digest' }).find(
      (entry) => entry.name === 'apk.certificate-pin',
    ).status,
    'fail',
  );
});

test('the APK is checked against the release notes, and their absence is a failure', () => {
  const checks = verifyApk({
    release: apkRelease({ body: 'Built by hand' }),
    apk: {
      path: '/tmp/gods-eye-view.apk',
      bytes: Buffer.byteLength('apk bytes'),
    },
    badgingText: BADGING,
    signerText: SIGNER,
  });
  assert.equal(
    checks.find((entry) => entry.name === 'apk.version').status,
    'fail',
  );
  assert.match(
    checks.find((entry) => entry.name === 'apk.version').detail,
    /release notes/,
  );
});

test('no IPA is required when the Apple secrets are absent, and a stale one is refused', () => {
  const absent = verifyIos({ release: null, appleSigning: 'false' });
  assert.equal(channelStatus(absent), 'pass');
  assert.match(absent[0].detail, /carries no \.ipa/);

  const stale = verifyIos({
    release: {
      tag: 'ios-latest',
      body: '',
      assets: [{ name: 'gods-eye-view.ipa', size: 10, updatedAt: null }],
    },
    appleSigning: 'false',
  });
  assert.equal(channelStatus(stale), 'fail');
  assert.match(stale[0].detail, /must be deleted/);
});

test('with the Apple secrets configured the IPA must exist', () => {
  const published = verifyIos({
    release: {
      tag: 'ios-latest',
      body: '',
      assets: [{ name: 'gods-eye-view.ipa', size: 10, updatedAt: null }],
    },
    appleSigning: 'true',
  });
  assert.equal(channelStatus(published), 'pass');

  const missing = verifyIos({ release: null, appleSigning: 'true' });
  assert.equal(channelStatus(missing), 'fail');
  assert.match(missing[0].detail, /carries no gods-eye-view\.ipa/);
});

test('an unstated Apple configuration is skipped, never guessed', () => {
  const checks = verifyIos({ release: null, appleSigning: 'unknown' });
  assert.equal(channelStatus(checks), 'skip');
  assert.equal(
    summarize([{ channel: 'ios', status: 'skip', checks }]).ok,
    true,
  );
  assert.equal(channelStatus(verifyIos({ appleSigning: 'maybe' })), 'fail');
});

test('the Android tools are looked for in the newest build-tools directory', () => {
  const found = resolveAndroidTool('apksigner', {
    env: { ANDROID_HOME: '/sdk' },
    exists: (candidate) => candidate === '/sdk/build-tools/35.0.0/apksigner',
    readdir: (directory) =>
      directory === '/sdk/build-tools' ? ['9.0.0', '35.0.0', '34.0.0'] : [],
  });
  assert.equal(found.path, '/sdk/build-tools/35.0.0/apksigner');
  assert.ok(compareVersions('9.0.0', '35.0.0') < 0);
  assert.ok(compareVersions('35.0.0', '35.0.0') === 0);
  assert.equal(
    resolveAndroidTool('apksigner', { explicit: '/opt/apksigner', env: {} })
      .path,
    '/opt/apksigner',
  );
  assert.equal(
    resolveAndroidTool('aapt2', { env: {}, exists: () => false }).path,
    'aapt2',
    'nothing found falls back to PATH, and the failure names what was looked for',
  );
});

test('the gate reads the release and its bytes as one snapshot', async () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), 'gev-published-assets-test-'),
  );
  const apiUrl =
    'https://api.github.com/repos/o/r/releases/tags/desktop-latest';
  const feedUrl =
    'https://github.com/o/r/releases/download/desktop-latest/latest.yml';
  const installerUrl = `https://github.com/o/r/releases/download/desktop-latest/${INSTALLER_NAME}`;
  const provenanceUrl =
    'https://github.com/o/r/releases/download/desktop-latest/provenance.json';
  const sbomUrl =
    'https://github.com/o/r/releases/download/desktop-latest/sbom.cdx.json';
  const provenance = provenanceFor();
  const payload = {
    tag_name: 'desktop-latest',
    body: 'Built from 92d8f27 (1.0.120) on main.',
    updated_at: '2026-11-23T00:34:33Z',
    assets: [
      {
        name: 'latest.yml',
        size: Buffer.byteLength(FEED),
        updated_at: '2026-11-23T00:34:33Z',
        browser_download_url: feedUrl,
        url: 'unused',
      },
      {
        name: INSTALLER_NAME,
        size: INSTALLER.length,
        updated_at: '2026-11-23T00:34:33Z',
        browser_download_url: installerUrl,
        url: 'unused',
      },
      {
        name: 'provenance.json',
        size: Buffer.byteLength(provenance.manifestText),
        updated_at: '2026-11-23T00:34:33Z',
        browser_download_url: provenanceUrl,
        url: 'unused',
      },
      {
        name: 'sbom.cdx.json',
        size: Buffer.byteLength(provenance.sbomText),
        updated_at: '2026-11-23T00:34:33Z',
        browser_download_url: sbomUrl,
        url: 'unused',
      },
    ],
  };
  const fetchImpl = async (url) => {
    if (url === apiUrl)
      return new Response(JSON.stringify(payload), { status: 200 });
    if (url === feedUrl) return new Response(FEED, { status: 200 });
    if (url === installerUrl) return new Response(INSTALLER, { status: 200 });
    if (url === provenanceUrl)
      return new Response(provenance.manifestText, { status: 200 });
    if (url === sbomUrl)
      return new Response(provenance.sbomText, { status: 200 });
    return new Response('not found', { status: 404 });
  };

  try {
    const report = await verifyPublishedAssets({
      repo: 'o/r',
      channels: ['desktop'],
      directory,
      fetchImpl,
    });
    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert.equal(report.channels[0].status, 'pass');
    assert.equal(
      report.channels[0].checks.find((entry) => entry.name === 'feed.sha512')
        .status,
      'pass',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a channel that cannot read its release is a failure, not a skip', async () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), 'gev-published-assets-test-'),
  );
  const fetchImpl = async () =>
    new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
      status: 403,
      headers: { 'x-ratelimit-reset': '1893456000' },
    });
  try {
    const report = await verifyPublishedAssets({
      repo: 'o/r',
      channels: ['ios'],
      directory,
      fetchImpl,
    });
    assert.equal(report.ok, false);
    assert.equal(report.channels[0].status, 'fail');
    assert.match(report.channels[0].checks[0].detail, /set GH_TOKEN/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
