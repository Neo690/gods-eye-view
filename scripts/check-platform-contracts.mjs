#!/usr/bin/env node

// The three release shells share more than a web bundle: one bundle
// identifier per store, one artifact name per rolling release, one tag per
// update channel, and one set of source paths that must trigger a rebuild.
//
// Those values live in different languages — Gradle, XcodeGen, xtool, YAML,
// JavaScript, Java and Swift — so a rename in one place can leave the others
// pointing at the previous artifact. The release page still looks fine; the
// phone refuses the update, or the updater looks for a file the release no
// longer carries. The two mobile shells also mirror an in-app `/api/*` surface;
// a route or upstream host added to one LiveApi without the other is invisible
// until that layer 404s on the platform that is missing it.
//
// This check reads the declarations, not a build: it is fast enough for every
// CI run and catches drift before a publisher runs. `verify-published-assets`
// remains the post-publish proof over the bytes that were actually uploaded.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every declaration the contract reads, relative to the repository root. */
export const PLATFORM_FILES = Object.freeze([
  'package.json',
  'desktop/package.json',
  'desktop/electron-builder.yml',
  'desktop/prepare-payload.mjs',
  'android/app/build.gradle',
  'android/app/src/main/AndroidManifest.xml',
  'android/app/src/main/java/com/godseye/view/LiveApi.java',
  'ios/project.yml',
  'ios/xtool.yml',
  'ios/Info.xtool.plist',
  'ios/GodsEyeView/Info.plist',
  'ios/GodsEyeView/LiveApi.swift',
  'ios/GodsEyeView/LocalServer.swift',
  'ios/Package.swift',
  'src/data/inAppApi.js',
  'src/data/transitFeeds.js',
  'src/data/gbfsSource.js',
  'src/standalone/layerSources.js',
  'scripts/install-latest-apk.mjs',
  'scripts/prepare-ios-payload.mjs',
  'scripts/release-provenance.mjs',
  'scripts/verify-published-assets.mjs',
  'src/updates/updateChannel.js',
  '.github/workflows/windows-installer.yml',
  '.github/workflows/android-apk.yml',
  '.github/workflows/ios-app.yml',
  '.github/workflows/published-assets.yml',
]);

/** The one bundle identifier the two mobile stores install and update. */
export const MOBILE_BUNDLE_ID = 'com.godseye.view';

/** The desktop app is deliberately a separate application id. */
export const DESKTOP_APP_ID = 'com.godseyeview.desktop';

/** The provenance files every publisher uploads beside its artifact. */
export const RELEASE_PROVENANCE = Object.freeze({
  manifest: 'provenance.json',
  sbom: 'sbom.cdx.json',
});

/**
 * Routes one shell answers and the other deliberately does not.
 *
 * The Android shell keeps a WMS weather-tile fallback for the observed-weather
 * layer; the iOS shell does not need it because the in-page API
 * (`src/data/inAppApi.js`) answers those two paths before the loopback route.
 * This is the only permitted route asymmetry: every other route must exist in
 * both dispatchers, so a new transit/GBFS route cannot land on one side only.
 */
export const LIVE_API_ROUTE_EXCEPTIONS = Object.freeze({
  android: Object.freeze(['/api/weather/image', '/api/weather/tile']),
  ios: Object.freeze([]),
});

/** Rolling release and asset names shared by publishers, updater and gate. */
export const RELEASE_CHANNELS = Object.freeze({
  android: Object.freeze({
    tag: 'apk-latest',
    asset: 'gods-eye-view.apk',
    workflow: '.github/workflows/android-apk.yml',
  }),
  ios: Object.freeze({
    tag: 'ios-latest',
    asset: 'gods-eye-view.ipa',
    workflow: '.github/workflows/ios-app.yml',
  }),
  windows: Object.freeze({
    tag: 'desktop-latest',
    asset: 'gods-eye-view-windows-setup.exe',
    workflow: '.github/workflows/windows-installer.yml',
  }),
});

/** Inputs every publisher must rebuild for: the bundle is the app. */
export const SHARED_RELEASE_PATHS = Object.freeze([
  'src/**',
  'public/**',
  'build/**',
  'server/**',
  'config/**',
  'index.html',
  'style.css',
  'vite.config.js',
  'package.json',
  'package-lock.json',
]);

const PLATFORM_RELEASE_PATHS = Object.freeze({
  windows: 'desktop/**',
  android: 'android/**',
  ios: 'ios/**',
});

function check(id, ok, detail) {
  return { id, ok: Boolean(ok), detail };
}

function textOf(files, file) {
  return String(files[file] ?? '');
}

function has(files, file, pattern) {
  return pattern.test(textOf(files, file));
}

function capture(files, file, pattern) {
  return pattern.exec(textOf(files, file))?.[1] ?? null;
}

function workflowBranches(text) {
  const block = /push:\s*\n\s*branches:\s*\[([^\]]+)\]/.exec(text)?.[1];
  return block
    ? block
        .split(',')
        .map((branch) => branch.trim())
        .filter(Boolean)
    : [];
}

function workflowPaths(text) {
  const block = /paths:\s*\n((?:\s*-\s*'[^']+'\s*\n?)+)/.exec(text)?.[1];
  return block
    ? [...block.matchAll(/-\s*'([^']+)'/g)].map((match) => match[1])
    : [];
}

function updateChannelTags(text) {
  return [...text.matchAll(/\btag:\s*'([^']+)'/g)].map((match) => match[1]);
}

function updateChannelAssets(text) {
  return [...text.matchAll(/\bassetMatch:\s*'([^']+)'/g)].map(
    (match) => match[1],
  );
}

function releaseGateTags(text) {
  return [...text.matchAll(/\btag:\s*'([^']+)'/g)].map((match) => match[1]);
}

function releaseGateAssets(text) {
  return [...text.matchAll(/\bassetName:\s*'([^']+)'/g)].map(
    (match) => match[1],
  );
}

function expectedTags() {
  return Object.values(RELEASE_CHANNELS).map((channel) => channel.tag);
}

function expectedAssets() {
  return Object.values(RELEASE_CHANNELS).map((channel) => channel.asset);
}

function sameMembers(actual, expected) {
  return (
    actual.length === expected.length &&
    expected.every((value) => actual.includes(value))
  );
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

/** The host allowlist a LiveApi exposes, or null when it cannot be read. */
function liveApiHosts(text, language) {
  const block =
    language === 'java'
      ? /UPSTREAM_HOSTS\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(text)?.[1]
      : /upstreamHosts\s*:\s*Set<String>\s*=\s*\[([\s\S]*?)\n\s*\]/.exec(
          text,
        )?.[1];
  if (block === undefined) return null;
  return uniqueSorted(
    [...block.matchAll(/"([^"]+)"/g)]
      .map((match) => match[1].trim().toLowerCase())
      .filter(Boolean),
  );
}

/** `/api/celestrak/` and `/api/celestrak?x=1` both normalise to one route. */
function normalizeLiveApiRoute(value) {
  const path = String(value).split(/[?#]/)[0].replace(/\/+$/, '');
  return path || '/';
}

/** The routes one dispatcher actually matches, or null when unreadable. */
function liveApiRoutes(text, language) {
  const start = text.indexOf(
    language === 'java'
      ? 'static WebResourceResponse serve('
      : 'func handle(_ request: HTTPRequest)',
  );
  const end = text.indexOf(
    language === 'java' ? '/* ── CelesTrak' : 'func rescue(',
    start,
  );
  if (start < 0 || end < 0) return null;
  const routes = [...text.slice(start, end).matchAll(/"(\/api[^"]*)"/g)].map(
    (match) => normalizeLiveApiRoute(match[1]),
  );
  return uniqueSorted(routes.filter((route) => route !== '/api'));
}

/** The hosts the transit registry actually fetches. */
function transitSourceHosts(text) {
  const hosts = [];
  for (const match of text.matchAll(/^\s*url:\s*'([^']+)'/gm)) {
    try {
      hosts.push(new URL(match[1]).host.toLowerCase());
    } catch {
      // A non-URL `url:` value is not a feed endpoint; the shape checks in the
      // transit suite own that error.
    }
  }
  return hosts.length ? uniqueSorted(hosts) : null;
}

/** The explicit hosts the GBFS proxy accepts. */
function gbfsSourceHosts(text) {
  const block = /GBFS_ALLOWED_HOSTS\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(
    text,
  )?.[1];
  if (block === undefined) return null;
  return uniqueSorted(
    [...block.matchAll(/'([^']+)'/g)]
      .map((match) => match[1].trim().toLowerCase())
      .filter(Boolean),
  );
}

function routeOnlyIn(routes, other, exceptions) {
  return (routes ?? []).filter(
    (route) => !(other ?? []).includes(route) && !exceptions.includes(route),
  );
}

function exceptionProblems(routes, other, exceptions, label) {
  const problems = [];
  for (const route of exceptions) {
    if (!(routes ?? []).includes(route)) {
      problems.push(`${label} exception ${route} is no longer routed`);
    }
    if ((other ?? []).includes(route)) {
      problems.push(`${label} exception ${route} is routed by both shells`);
    }
  }
  return problems;
}

function iosPlistString(text, key) {
  return new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(
    text,
  )?.[1];
}

/**
 * Evaluate the contract over a map of file path -> text.
 *
 * Pure so a test can mutate one declaration and prove the check notices,
 * without building a Gradle project or an Xcode workspace.
 *
 * @param {Record<string, string>} files
 * @returns {{ok: boolean, checks: Array<{id: string, ok: boolean, detail: string}>}}
 */
export function evaluatePlatformContracts(files) {
  const checks = [];
  const missing = PLATFORM_FILES.filter(
    (file) => typeof files[file] !== 'string',
  );
  checks.push(
    check(
      'files.present',
      missing.length === 0,
      missing.length
        ? `missing declarations: ${missing.join(', ')}`
        : `${PLATFORM_FILES.length} platform declarations are present`,
    ),
  );
  if (missing.length) return { ok: false, checks };

  const updateChannel = textOf(files, 'src/updates/updateChannel.js');
  const gate = textOf(files, 'scripts/verify-published-assets.mjs');

  const tags = updateChannelTags(updateChannel);
  const gateTags = releaseGateTags(gate);
  checks.push(
    check(
      'channels.tags',
      sameMembers(tags, expectedTags()) &&
        sameMembers(gateTags, expectedTags()),
      `updater ${tags.join(', ') || 'none'}; gate ${gateTags.join(', ') || 'none'}; expected ${expectedTags().join(', ')}`,
    ),
  );

  const assets = updateChannelAssets(updateChannel).filter(
    (asset) => asset !== 'setup',
  );
  const gateAssets = releaseGateAssets(gate);
  checks.push(
    check(
      'channels.assets',
      sameMembers(
        Object.values(RELEASE_CHANNELS)
          .filter((channel) => channel.tag !== RELEASE_CHANNELS.windows.tag)
          .map((channel) => channel.asset),
        assets,
      ) && sameMembers(expectedAssets(), gateAssets),
      `updater ${assets.join(', ') || 'none'}; gate ${gateAssets.join(', ') || 'none'}`,
    ),
  );

  const desktopBuilder = textOf(files, 'desktop/electron-builder.yml');
  const publisherAssetChecks = [
    ['.github/workflows/windows-installer.yml', RELEASE_CHANNELS.windows.asset],
    ['.github/workflows/android-apk.yml', RELEASE_CHANNELS.android.asset],
    ['.github/workflows/ios-app.yml', RELEASE_CHANNELS.ios.asset],
  ];
  checks.push(
    check(
      'channels.publishers',
      desktopBuilder.includes(
        `artifactName: ${RELEASE_CHANNELS.windows.asset}`,
      ) &&
        publisherAssetChecks.every(([workflow, asset]) =>
          textOf(files, workflow).includes(asset),
        ),
      'the Windows builder and all three workflows name the assets the gate verifies',
    ),
  );

  checks.push(
    check(
      'bundle.android',
      has(
        files,
        'android/app/build.gradle',
        new RegExp(`namespace\\s+'${MOBILE_BUNDLE_ID}'`),
      ) &&
        has(
          files,
          'android/app/build.gradle',
          new RegExp(`applicationId\\s+'${MOBILE_BUNDLE_ID}'`),
        ) &&
        textOf(files, 'scripts/install-latest-apk.mjs').includes(
          `APK_APPLICATION_ID = '${MOBILE_BUNDLE_ID}'`,
        ),
      `Gradle, the APK installer and the store identity all use ${MOBILE_BUNDLE_ID}`,
    ),
  );

  const iosProject = textOf(files, 'ios/project.yml');
  const iosXtool = textOf(files, 'ios/xtool.yml');
  const iosPlist = textOf(files, 'ios/Info.xtool.plist');
  const iosWorkflow = textOf(files, '.github/workflows/ios-app.yml');
  const iosIds = [
    iosProject.includes(`PRODUCT_BUNDLE_IDENTIFIER: ${MOBILE_BUNDLE_ID}`),
    iosXtool.includes(`bundleID: ${MOBILE_BUNDLE_ID}`),
    iosWorkflow.includes(`GEV_BUNDLE_ID: ${MOBILE_BUNDLE_ID}`),
  ];
  checks.push(
    check(
      'bundle.ios',
      iosIds.every(Boolean),
      `Project, xtool and CI all use ${MOBILE_BUNDLE_ID}`,
    ),
  );

  checks.push(
    check(
      'bundle.desktop',
      desktopBuilder.includes(`appId: ${DESKTOP_APP_ID}`),
      `the desktop shell keeps its own application id ${DESKTOP_APP_ID}`,
    ),
  );

  for (const [platform, channel] of Object.entries(RELEASE_CHANNELS)) {
    const workflow = textOf(files, channel.workflow);
    const branches = workflowBranches(workflow);
    checks.push(
      check(
        `publish.${platform}.main`,
        branches.includes('main') && workflow.includes('workflow_dispatch:'),
        `${channel.workflow} publishes from main and can be run by hand (${branches.join(', ')})`,
      ),
    );

    const declaredPaths = workflowPaths(workflow);
    const requiredPaths = [
      ...SHARED_RELEASE_PATHS,
      PLATFORM_RELEASE_PATHS[platform],
      ...(platform === 'ios' ? ['scripts/prepare-ios-payload.mjs'] : []),
    ];
    const missingPaths = requiredPaths.filter(
      (required) => !declaredPaths.includes(required),
    );
    checks.push(
      check(
        `publish.${platform}.paths`,
        missingPaths.length === 0,
        missingPaths.length
          ? `${channel.workflow} would not rebuild after: ${missingPaths.join(', ')}`
          : `${channel.workflow} watches every shared bundle input and its own shell`,
      ),
    );
  }

  checks.push(
    check(
      'android.version',
      has(
        files,
        'android/app/build.gradle',
        /GEV_VERSION_CODE'\)?\s*\?\:\s*'1'/,
      ) &&
        has(
          files,
          'android/app/build.gradle',
          /GEV_VERSION_NAME'\)?\s*\?\:\s*'1\.0'/,
        ) &&
        has(
          files,
          '.github/workflows/android-apk.yml',
          /CODE=\$\(\(\s*1000\s*\+\s*\$\{\{\s*github\.run_number\s*\}\}\s*\)\)/,
        ) &&
        has(
          files,
          '.github/workflows/android-apk.yml',
          /GEV_VERSION_NAME=1\.0\.\$CODE/,
        ),
      'Android keeps a local 1.0 default and a rising CI versionCode',
    ),
  );

  checks.push(
    check(
      'ios.version',
      iosProject.includes("MARKETING_VERSION: '1.0'") &&
        iosProject.includes("CURRENT_PROJECT_VERSION: '1'") &&
        iosPlistString(iosPlist, 'CFBundleShortVersionString') === '1.0' &&
        iosWorkflow.includes('GEV_VERSION_NAME=1.0.${{ github.run_number }}') &&
        iosWorkflow.includes('GEV_BUILD_NUMBER=${{ github.run_number }}') &&
        iosWorkflow.includes('MARKETING_VERSION="$GEV_VERSION_NAME"') &&
        iosWorkflow.includes('CURRENT_PROJECT_VERSION="$GEV_BUILD_NUMBER"'),
      'the Xcode spec, xtool plist and CI agree on the iOS version and build number',
    ),
  );

  let desktopVersion = null;
  try {
    desktopVersion = JSON.parse(textOf(files, 'desktop/package.json')).version;
  } catch {
    desktopVersion = null;
  }
  // The iPhone app draws the same public layers as the APK without a hosted
  // server. Both halves have to stay in step: the Swift routes, the key
  // fallback, the loopback port the page matches, and the tile relay that uses
  // it.
  const iosLiveApi = textOf(files, 'ios/GodsEyeView/LiveApi.swift');
  const iosServer = textOf(files, 'ios/GodsEyeView/LocalServer.swift');
  const inAppApi = textOf(files, 'src/data/inAppApi.js');
  const layerSources = textOf(files, 'src/standalone/layerSources.js');
  const iosPort = capture(
    files,
    'ios/GodsEyeView/LocalServer.swift',
    /static let port: UInt16 = (\d+)/,
  );
  checks.push(
    check(
      'ios.keyless-api',
      iosPort !== null &&
        [
          '/api/health',
          '/api/celestrak/',
          '/api/flights',
          '/api/military',
          '/api/launches',
          '/api/upstream',
        ].every((route) => iosLiveApi.includes(`"${route}`)) &&
        iosLiveApi.includes('"no_key"') &&
        iosServer.includes('liveApi.handle') &&
        inAppApi.includes('export function inIOSShell') &&
        inAppApi.includes(`const IOS_SHELL_PORT = '${iosPort}'`) &&
        layerSources.includes(`const IOS_SHELL_PORT = '${iosPort}'`),
      `the iOS shell answers the keyless routes in-app on port ${iosPort}, names routes that need a key, and the page recognises that origin`,
    ),
  );

  const androidLiveApi = textOf(
    files,
    'android/app/src/main/java/com/godseye/view/LiveApi.java',
  );
  const androidHosts = liveApiHosts(androidLiveApi, 'java');
  const iosHosts = liveApiHosts(iosLiveApi, 'swift');
  const transitHosts = transitSourceHosts(
    textOf(files, 'src/data/transitFeeds.js'),
  );
  const gbfsHosts = gbfsSourceHosts(textOf(files, 'src/data/gbfsSource.js'));
  const missingFromIos = (androidHosts ?? []).filter(
    (host) => !(iosHosts ?? []).includes(host),
  );
  const missingFromAndroid = (iosHosts ?? []).filter(
    (host) => !(androidHosts ?? []).includes(host),
  );
  const sourceProblems = [];
  for (const [kind, hosts] of [
    ['transit', transitHosts],
    ['GBFS', gbfsHosts],
  ]) {
    for (const host of hosts ?? []) {
      if (!(androidHosts ?? []).includes(host)) {
        sourceProblems.push(`${kind} source ${host} is missing from Android`);
      }
      if (!(iosHosts ?? []).includes(host)) {
        sourceProblems.push(`${kind} source ${host} is missing from iOS`);
      }
    }
  }
  const sourceHostsReadable =
    transitHosts !== null &&
    gbfsHosts !== null &&
    transitHosts.length > 0 &&
    gbfsHosts.length > 0;
  const hostsOk =
    androidHosts !== null &&
    iosHosts !== null &&
    androidHosts.length > 0 &&
    iosHosts.length > 0 &&
    missingFromIos.length === 0 &&
    missingFromAndroid.length === 0 &&
    sourceHostsReadable &&
    sourceProblems.length === 0;
  checks.push(
    check(
      'live-api.hosts',
      hostsOk,
      hostsOk
        ? `${androidHosts.length} hosts are identical in Android and iOS, including every transit and GBFS source`
        : `Android ${androidHosts?.length ?? 'unreadable'}, iOS ${
            iosHosts?.length ?? 'unreadable'
          }; missing on iOS: ${missingFromIos.join(', ') || 'none'}; missing on Android: ${
            missingFromAndroid.join(', ') || 'none'
          }; ${
            sourceProblems.join('; ') ||
            (sourceHostsReadable
              ? 'source hosts agree'
              : 'the transit or GBFS host registry could not be read')
          }`,
    ),
  );

  const androidRoutes = liveApiRoutes(androidLiveApi, 'java');
  const iosRoutes = liveApiRoutes(iosLiveApi, 'swift');
  const androidOnly = routeOnlyIn(
    androidRoutes,
    iosRoutes,
    LIVE_API_ROUTE_EXCEPTIONS.android,
  );
  const iosOnly = routeOnlyIn(
    iosRoutes,
    androidRoutes,
    LIVE_API_ROUTE_EXCEPTIONS.ios,
  );
  const sharedRoutes = (androidRoutes ?? []).filter((route) =>
    (iosRoutes ?? []).includes(route),
  );
  const routeProblems = [
    ...exceptionProblems(
      androidRoutes,
      iosRoutes,
      LIVE_API_ROUTE_EXCEPTIONS.android,
      'Android',
    ),
    ...exceptionProblems(
      iosRoutes,
      androidRoutes,
      LIVE_API_ROUTE_EXCEPTIONS.ios,
      'iOS',
    ),
  ];
  const routesOk =
    androidRoutes !== null &&
    iosRoutes !== null &&
    androidRoutes.includes('/api/upstream') &&
    iosRoutes.includes('/api/upstream') &&
    androidOnly.length === 0 &&
    iosOnly.length === 0 &&
    routeProblems.length === 0;
  checks.push(
    check(
      'live-api.routes',
      routesOk,
      routesOk
        ? `${sharedRoutes.length} routes are shared by Android and iOS, plus ${LIVE_API_ROUTE_EXCEPTIONS.android.length} documented Android-only weather fallbacks`
        : `Android ${androidRoutes?.length ?? 'unreadable'} routes, iOS ${
            iosRoutes?.length ?? 'unreadable'
          }; only on Android: ${androidOnly.join(', ') || 'none'}; only on iOS: ${
            iosOnly.join(', ') || 'none'
          }; ${routeProblems.join('; ') || 'both shells answer /api/upstream'}`,
    ),
  );

  checks.push(
    check(
      'desktop.version',
      /^\d+\.\d+\.\d+$/.test(String(desktopVersion ?? '')) &&
        textOf(files, '.github/workflows/windows-installer.yml').includes(
          'GEV_DESKTOP_VERSION=1.0.${{ github.run_number }}',
        ) &&
        textOf(files, 'desktop/electron-builder.yml').includes(
          'artifactName: gods-eye-view-windows-setup.exe',
        ),
      `desktop package version ${desktopVersion}; CI assigns a rising 1.0.<run> version`,
    ),
  );

  checks.push(
    check(
      'android.signing',
      has(files, 'android/app/build.gradle', /enableV2Signing true/) &&
        has(files, 'android/app/build.gradle', /enableV3Signing true/) &&
        textOf(files, '.github/workflows/android-apk.yml').includes(
          'verify --print-certs',
        ) &&
        textOf(files, '.github/workflows/android-apk.yml').includes(
          'ANDROID_KEYSTORE_BASE64',
        ),
      'the APK is signed with the stable CI key and checked with apksigner before upload',
    ),
  );

  checks.push(
    check(
      'ios.signing',
      iosWorkflow.includes('CODE_SIGNING_ALLOWED=NO') &&
        iosWorkflow.includes('codesign --verify --deep --strict') &&
        iosWorkflow.includes('security delete-keychain') &&
        iosWorkflow.includes('make_latest=false'),
      'the iOS build compiles unsigned, verifies the exported signature and leaves signing material on the runner',
    ),
  );

  checks.push(
    check(
      'desktop.smoke',
      textOf(files, '.github/workflows/windows-installer.yml').includes(
        '--verify',
      ) &&
        textOf(files, '.github/workflows/windows-installer.yml').includes(
          'latest.yml',
        ) &&
        textOf(files, '.github/workflows/windows-installer.yml').includes(
          'make_latest=false',
        ),
      'the Windows installer is started with --verify, carries latest.yml and leaves the latest slot to Android',
    ),
  );

  checks.push(
    check(
      'release.latest-owner',
      has(
        files,
        '.github/workflows/android-apk.yml',
        /gh release create apk-latest[\s\S]*?--latest/,
      ) &&
        has(
          files,
          '.github/workflows/android-apk.yml',
          /gh release edit apk-latest[\s\S]*?--latest/,
        ) &&
        has(files, '.github/workflows/ios-app.yml', /make_latest=false/) &&
        has(
          files,
          '.github/workflows/windows-installer.yml',
          /make_latest=false/,
        ),
      'apk-latest owns the repository latest slot; Windows and iOS keep their stable tags out of it',
    ),
  );

  const gateWorkflow = textOf(files, '.github/workflows/published-assets.yml');
  const provenance = textOf(files, 'scripts/release-provenance.mjs');
  const provenanceWorkflows = Object.values(RELEASE_CHANNELS).map(
    (channel) => channel.workflow,
  );
  checks.push(
    check(
      'release.provenance',
      provenance.includes(
        `PROVENANCE_ASSET = '${RELEASE_PROVENANCE.manifest}'`,
      ) &&
        provenance.includes(`SBOM_ASSET = '${RELEASE_PROVENANCE.sbom}'`) &&
        gate.includes(`provenanceName: '${RELEASE_PROVENANCE.manifest}'`) &&
        gate.includes(`sbomName: '${RELEASE_PROVENANCE.sbom}'`) &&
        gate.includes('verifyProvenance') &&
        provenanceWorkflows.every(
          (workflow) =>
            textOf(files, workflow).includes(
              'node scripts/release-provenance.mjs',
            ) &&
            textOf(files, workflow).includes(RELEASE_PROVENANCE.manifest) &&
            textOf(files, workflow).includes(RELEASE_PROVENANCE.sbom),
        ),
      'the generator, the gate and all three publishers agree on provenance.json and sbom.cdx.json',
    ),
  );

  checks.push(
    check(
      'release.gate',
      gateWorkflow.includes('workflows:') &&
        gateWorkflow.includes("'Windows installer'") &&
        gateWorkflow.includes("'Android APK'") &&
        gateWorkflow.includes("'iOS app'") &&
        gateWorkflow.includes('cron:') &&
        gateWorkflow.includes('node scripts/verify-published-assets.mjs') &&
        gateWorkflow.includes('--repo') &&
        gateWorkflow.includes('--json published-assets.json') &&
        gateWorkflow.includes('if: always()'),
      'the published-assets gate runs after all three publishers and daily, and keeps its report',
    ),
  );

  checks.push(
    check(
      'security.credential-files',
      textOf(files, 'desktop/prepare-payload.mjs').includes(
        'const CREDENTIAL_PATHS',
      ) &&
        textOf(files, 'desktop/prepare-payload.mjs').includes(
          'credential files would be packaged',
        ) &&
        textOf(files, 'scripts/prepare-ios-payload.mjs').includes(
          'const CREDENTIAL_PATTERNS',
        ) &&
        textOf(files, 'scripts/prepare-ios-payload.mjs').includes(
          'credential-shaped files would ship inside the app',
        ),
      'the desktop and iOS payloads refuse credential-shaped files before packaging',
    ),
  );

  return { ok: checks.every((entry) => entry.ok), checks };
}

/** Read every declaration from a checkout, then evaluate the contract. */
export function checkPlatformContracts({ root = ROOT } = {}) {
  const files = {};
  for (const file of PLATFORM_FILES) {
    const absolute = path.join(root, file);
    files[file] = existsSync(absolute)
      ? readFileSync(absolute, 'utf8')
      : undefined;
  }
  return evaluatePlatformContracts(files);
}

export function formatPlatformReport(result) {
  const lines = [];
  for (const entry of result.checks) {
    lines.push(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.id}: ${entry.detail}`);
  }
  lines.push(
    '',
    result.ok
      ? `platform release contract: ${result.checks.length} checks passed`
      : `platform release contract: ${result.checks.filter((entry) => !entry.ok).length} failed`,
  );
  return lines.join('\n');
}

const invoked = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invoked) {
  const result = checkPlatformContracts();
  console.log(formatPlatformReport(result));
  process.exitCode = result.ok ? 0 : 1;
}
