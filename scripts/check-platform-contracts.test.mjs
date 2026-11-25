import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PLATFORM_FILES,
  checkPlatformContracts,
  evaluatePlatformContracts,
  formatPlatformReport,
} from './check-platform-contracts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function platformFiles() {
  return Object.fromEntries(
    PLATFORM_FILES.map((file) => [
      file,
      readFileSync(path.join(ROOT, file), 'utf8'),
    ]),
  );
}

function mutate(file, find, replace) {
  const files = platformFiles();
  const before = files[file];
  assert.ok(before.includes(find), `${file} no longer contains ${find}`);
  files[file] = before.replace(find, replace);
  return files;
}

function failed(result, id) {
  return result.checks.find((entry) => entry.id === id && !entry.ok);
}

test('the repository satisfies the cross-platform release contract', () => {
  const result = checkPlatformContracts();
  assert.equal(result.ok, true, formatPlatformReport(result));
  assert.equal(
    result.checks.every((entry) => entry.ok),
    true,
  );
});

test('a renamed update tag is caught', () => {
  const files = mutate(
    'src/updates/updateChannel.js',
    "tag: 'ios-latest'",
    "tag: 'ios-staging'",
  );
  assert.ok(failed(evaluatePlatformContracts(files), 'channels.tags'));
});

test('a renamed release asset is caught', () => {
  const files = mutate(
    'scripts/verify-published-assets.mjs',
    "assetName: 'gods-eye-view.apk'",
    "assetName: 'gods-eye-view-new.apk'",
  );
  assert.ok(failed(evaluatePlatformContracts(files), 'channels.assets'));
});

test('an Android application id drift is caught', () => {
  const files = mutate(
    'android/app/build.gradle',
    "applicationId 'com.godseye.view'",
    "applicationId 'com.godseye.preview'",
  );
  assert.ok(failed(evaluatePlatformContracts(files), 'bundle.android'));
});

test('an iOS bundle id drift is caught', () => {
  const files = mutate(
    'ios/xtool.yml',
    'bundleID: com.godseye.view',
    'bundleID: com.godseye.preview',
  );
  assert.ok(failed(evaluatePlatformContracts(files), 'bundle.ios'));
});

test('a publisher that no longer runs from main is caught', () => {
  const files = mutate(
    '.github/workflows/android-apk.yml',
    'branches: [android-shell, main]',
    'branches: [android-shell]',
  );
  assert.ok(failed(evaluatePlatformContracts(files), 'publish.android.main'));
});

test('a publisher that ignores shared web changes is caught', () => {
  const files = mutate(
    '.github/workflows/windows-installer.yml',
    "      - 'src/**'\n",
    '',
  );
  assert.ok(failed(evaluatePlatformContracts(files), 'publish.windows.paths'));
});

test('an Android default version drift is caught', () => {
  const files = mutate(
    'android/app/build.gradle',
    "System.getenv('GEV_VERSION_CODE') ?: '1'",
    "System.getenv('GEV_VERSION_CODE') ?: '2'",
  );
  assert.ok(failed(evaluatePlatformContracts(files), 'android.version'));
});

test('an iOS marketing version drift is caught', () => {
  const files = mutate(
    'ios/project.yml',
    "MARKETING_VERSION: '1.0'",
    "MARKETING_VERSION: '1.1'",
  );
  assert.ok(failed(evaluatePlatformContracts(files), 'ios.version'));
});

test('an invalid desktop version is caught', () => {
  const files = mutate(
    'desktop/package.json',
    '"version": "1.0.0"',
    '"version": "next"',
  );
  assert.ok(failed(evaluatePlatformContracts(files), 'desktop.version'));
});

test('dropping an Android signature scheme is caught', () => {
  const files = platformFiles();
  files['android/app/build.gradle'] = files[
    'android/app/build.gradle'
  ].replaceAll('enableV3Signing true', 'enableV3Signing false');
  assert.ok(failed(evaluatePlatformContracts(files), 'android.signing'));
});

test('dropping the iOS signature verification is caught', () => {
  const files = mutate(
    '.github/workflows/ios-app.yml',
    'codesign --verify --deep --strict',
    'codesign --verify',
  );
  assert.ok(failed(evaluatePlatformContracts(files), 'ios.signing'));
});

test('a release that steals the latest slot is caught', () => {
  const files = mutate(
    '.github/workflows/windows-installer.yml',
    'make_latest=false',
    'make_latest=true',
  );
  assert.ok(failed(evaluatePlatformContracts(files), 'release.latest-owner'));
});

test('a gate that stops keeping its report is caught', () => {
  const files = mutate(
    '.github/workflows/published-assets.yml',
    '--json published-assets.json',
    '',
  );
  assert.ok(failed(evaluatePlatformContracts(files), 'release.gate'));
});

test('a payload that stops rejecting credential files is caught', () => {
  const files = mutate(
    'desktop/prepare-payload.mjs',
    'CREDENTIAL_PATHS',
    'ALLOWED_PATHS',
  );
  assert.ok(
    failed(evaluatePlatformContracts(files), 'security.credential-files'),
  );
});
