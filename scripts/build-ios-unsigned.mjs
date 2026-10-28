#!/usr/bin/env node

// Build an UNSIGNED `.ipa` of the iOS shell, for trying the app on a phone
// without a developer account.
//
// This is the missing link between `npm run ios:payload` (which stages the
// bundle) and `ios/README.md`'s Xcode instructions: the shell is compiled with
// `CODE_SIGNING_ALLOWED=NO`, so nothing has to be configured in Xcode, and the
// result is packaged the way an `.ipa` is: `Payload/GodsEyeView.app` inside a
// zip.
//
// What an unsigned `.ipa` is and is not:
//
//   * It does NOT install on a stock iPhone directly. iOS runs only signed
//     code, and no tool changes that — an unsigned bundle dragged onto a
//     device is rejected by the install service.
//   * It is what Sideloadly and AltStore expect on Windows: they re-sign it
//     with a free Apple ID on the operator's machine, then install it. That
//     profile expires after seven days; re-running the tool renews it and the
//     WebView's storage, where Provider Settings keeps the keys, survives.
//
// So the machine that RUNS this script needs macOS with Xcode 15 and XcodeGen;
// the machine that INSTALLS the result can be Windows. `ios/README.md` carries
// the Xcode route, which signs on the fly and needs no `.ipa` at all.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareIosPayload } from './prepare-ios-payload.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPTS_DIR, '..');
const IOS_DIR = path.join(ROOT, 'ios');
const BUILD_DIR = path.join(IOS_DIR, 'build', 'unsigned');
const DERIVED_DIR = path.join(BUILD_DIR, 'DerivedData');
const PAYLOAD_DIR = path.join(BUILD_DIR, 'Payload');
const IPA_PATH = path.join(BUILD_DIR, 'gods-eye-view-unsigned.ipa');
const APP_NAME = 'GodsEyeView.app';
const PROJECT = 'GodsEyeView.xcodeproj';
const SCHEME = 'GodsEyeView';

function fail(message, hint) {
  console.error(`\nios unsigned ipa failed: ${message}`);
  if (hint) console.error(hint);
  process.exitCode = 1;
}

/** Run a command, streaming its output unless `capture` asks for the text. */
function run(command, args, { cwd = ROOT, capture = false, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture
      ? `${result.stdout || ''}${result.stderr || ''}`.trim()
      : '';
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status}${detail ? `\n${detail}` : ''}`,
    );
  }
  return capture ? (result.stdout || '').trim() : '';
}

const have = (command) =>
  spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).status === 0;

/**
 * Compile the shell for a device without signing it, and package the app the
 * way an `.ipa` is packaged.
 * @param {{webBuild?: boolean}} [options]  `webBuild: false` reuses `dist/`.
 */
export function buildUnsignedIpa({ webBuild = true } = {}) {
  if (process.platform !== 'darwin') {
    throw new Error(
      'this needs macOS: the iOS shell is Swift compiled by Xcode, and no other platform ships that toolchain',
    );
  }
  if (!have('xcodebuild')) throw new Error('xcodebuild not found; install Xcode 15 or later');
  if (!have('xcodegen')) {
    throw new Error('xcodegen not found; install it with `brew install xcodegen`');
  }

  if (webBuild) {
    console.log('== building the web bundle ==');
    run('npm', ['run', 'build']);
  } else if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('no dist/ to reuse; run without --skip-build first');
  }

  console.log('== staging the bundle into the shell ==');
  prepareIosPayload();

  console.log('== generating the Xcode project ==');
  run('xcodegen', ['generate'], { cwd: IOS_DIR });

  console.log('== compiling for the device, unsigned ==');
  rmSync(DERIVED_DIR, { recursive: true, force: true });
  run('xcodebuild', [
    '-project', path.join(IOS_DIR, PROJECT),
    '-scheme', SCHEME,
    '-configuration', 'Release',
    '-sdk', 'iphoneos',
    '-derivedDataPath', DERIVED_DIR,
    // The three flags that keep signing out of it: no identity, no profile,
    // no signing step. Without all three xcodebuild falls back to automatic
    // signing and asks for a team that this machine does not have.
    'CODE_SIGNING_ALLOWED=NO',
    'CODE_SIGNING_REQUIRED=NO',
    'CODE_SIGN_IDENTITY=',
    'build',
  ]);

  const builtApp = path.join(DERIVED_DIR, 'Build', 'Products', 'Release-iphoneos', APP_NAME);
  if (!existsSync(builtApp)) throw new Error(`no app at ${path.relative(ROOT, builtApp)}`);
  if (existsSync(path.join(builtApp, '_CodeSignature'))) {
    throw new Error(
      'the compiled app carries a signature; the CODE_SIGNING flags did not apply, so this is not the unsigned build this script promises',
    );
  }
  // The console has to be inside the app: an .ipa without www/ launches to a
  // blank WebView, which is the one failure mode that looks like a crash.
  const indexInside = path.join(builtApp, 'www', 'index.html');
  if (!existsSync(indexInside)) {
    throw new Error('the compiled app has no www/index.html; was the payload staged?');
  }

  console.log('== packaging Payload/ into the .ipa ==');
  rmSync(PAYLOAD_DIR, { recursive: true, force: true });
  mkdirSync(PAYLOAD_DIR, { recursive: true });
  cpSync(builtApp, path.join(PAYLOAD_DIR, APP_NAME), { recursive: true });
  rmSync(IPA_PATH, { force: true });
  // `ditto` rather than `zip`: it preserves the resource forks and symlinks
  // iOS bundles rely on, and it is what Xcode's own exporter uses.
  run('ditto', [
    '-c', '-k', '--sequesterRsrc', '--keepParent',
    'Payload', IPA_PATH,
  ], { cwd: BUILD_DIR });

  const bytes = statSync(IPA_PATH).size;
  const sha = run('shasum', ['-a', '256', IPA_PATH], { capture: true }).split(/\s+/)[0];
  console.log('');
  console.log(`ipa:    ${path.relative(ROOT, IPA_PATH)}`);
  console.log(`size:   ${(bytes / 1024 / 1024).toFixed(1)} MiB`);
  console.log(`sha256: ${sha}`);
  console.log('signed: no — see the header of this script before trying to install it');
  return { ipa: IPA_PATH, bytes, sha256: sha };
}

const invoked = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (invoked === import.meta.url) {
  try {
    buildUnsignedIpa({ webBuild: !process.argv.includes('--skip-build') });
  } catch (error) {
    fail(
      error.message,
      process.platform === 'darwin'
        ? 'ios/README.md covers the Xcode route, which signs on the fly.'
        : 'Build this on a Mac, or in CI, then re-sign the .ipa with Sideloadly on Windows.',
    );
  }
}
