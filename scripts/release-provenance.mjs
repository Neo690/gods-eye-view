#!/usr/bin/env node

// The provenance every rolling release carries beside its artifact.
//
// A release page says which version the publisher meant to ship. It does not
// say which commit produced the bytes, whether the file a phone downloads is
// the one that was built, or which third-party components are inside. This
// script writes the two files that answer those questions, and the published
// assets gate (`scripts/verify-published-assets.mjs`) re-checks them against
// the release it downloads:
//
//   provenance.json  schemaVersion, platform, release tag, commit, version,
//                    the bundle name/size/SHA-256, and the SBOM's name/size/
//                    SHA-256/component count.
//   sbom.cdx.json    CycloneDX 1.5: the shipped bundle as a file component
//                    with its SHA-256, and every production npm dependency of
//                    the shell that contains it.
//
// Both files are generated on the runner, after the artifact exists and before
// it is uploaded, so the digest in the manifest is the digest of the file the
// release serves.
//
// Usage:
//   node scripts/release-provenance.mjs \
//     --platform windows --release desktop-latest \
//     --version 1.0.120 --commit "$GITHUB_SHA" \
//     --artifact desktop/release/gods-eye-view-windows-setup.exe \
//     --manifest desktop/release/provenance.json \
//     --sbom desktop/release/sbom.cdx.json
//
// `--manifest` and `--sbom` default to the artifact's directory. Exits 1 with
// the reason when the artifact or the dependency tree cannot be read.

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The two assets every publisher writes beside its artifact. */
export const PROVENANCE_ASSET = 'provenance.json';
export const SBOM_ASSET = 'sbom.cdx.json';
export const PROVENANCE_SCHEMA_VERSION = 1;

/** The platform names the manifest may carry, and the tag it must name. */
export const PROVENANCE_PLATFORMS = Object.freeze({
  windows: Object.freeze({ release: 'desktop-latest', label: 'Windows' }),
  android: Object.freeze({ release: 'apk-latest', label: 'Android' }),
  ios: Object.freeze({ release: 'ios-latest', label: 'iOS' }),
});

/** SHA-256 of a buffer, lowercase hex: the form the manifest and gate use. */
export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** SHA-256 of a file, read in one pass. */
export function sha256File(file) {
  return sha256(readFileSync(file));
}

/** The package manager invocation that works on Windows and POSIX runners. */
function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/**
 * `npm sbom` writes a CycloneDX document of the production dependency tree.
 * The shell's source checkout is already installed on every publisher, so this
 * reads the tree that was actually built rather than resolving it again.
 */
export function readNpmSbom(cwd) {
  const result = spawnSync(
    npmCommand(),
    ['sbom', '--sbom-format', 'cyclonedx', '--omit=dev'],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `npm sbom failed in ${cwd} (exit ${result.status}): ${
        (result.stderr || result.stdout || '').trim() || 'no output'
      }`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`npm sbom in ${cwd} did not print JSON: ${error.message}`);
  }
}

/** One component identity, tolerant of the fields npm emits across versions. */
function componentKey(component) {
  return (
    component?.['bom-ref'] ||
    component?.purl ||
    `${component?.name ?? ''}@${component?.version ?? ''}`
  );
}

/** Merge component lists, keeping the first occurrence of each identity. */
export function mergeSbomComponents(documents) {
  const seen = new Set();
  const components = [];
  for (const document of documents) {
    for (const component of document?.components ?? []) {
      const key = componentKey(component);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      components.push(component);
    }
  }
  return components.sort((left, right) =>
    String(componentKey(left)).localeCompare(String(componentKey(right))),
  );
}

/** The Electron version the Windows shell packages, from its manifest. */
function electronVersion() {
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8'),
  );
  return String(
    manifest.devDependencies?.electron ?? manifest.dependencies?.electron ?? '',
  ).replace(/^[^\d]*/, '');
}

/**
 * Build the CycloneDX document. `documents` are the npm BOMs read from the
 * checkouts whose dependency trees ship in the artifact.
 */
export function buildSbom({
  platform,
  release,
  commit,
  version,
  bundle,
  documents = [],
  electron = null,
  generatedAt = new Date().toISOString(),
}) {
  const components = mergeSbomComponents(documents);
  if (electron) {
    const purl = `pkg:npm/electron@${electron}`;
    if (!components.some((component) => componentKey(component) === purl)) {
      components.push({
        type: 'framework',
        name: 'electron',
        version: electron,
        purl,
        'bom-ref': purl,
      });
    }
  }
  components.push({
    type: 'file',
    name: bundle.name,
    'bom-ref': `urn:gev:bundle:${bundle.sha256}`,
    hashes: [{ alg: 'SHA-256', content: bundle.sha256 }],
    properties: [
      { name: 'gev:release-bundle', value: 'true' },
      { name: 'gev:size', value: String(bundle.size) },
    ],
  });

  return {
    $schema: 'http://cyclonedx.org/schema/bom-1.5.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: generatedAt,
      tools: [{ vendor: 'Gods Eye View', name: 'release-provenance' }],
      component: {
        type: 'application',
        'bom-ref': `pkg:generic/gods-eye-view@${version}?platform=${platform}`,
        name: "God's Eye View",
        version,
        hashes: [{ alg: 'SHA-256', content: bundle.sha256 }],
      },
      properties: [
        { name: 'gev:platform', value: platform },
        { name: 'gev:release', value: release },
        { name: 'gev:commit', value: commit },
        { name: 'gev:bundle:name', value: bundle.name },
        { name: 'gev:bundle:size', value: String(bundle.size) },
        { name: 'gev:bundle:sha256', value: bundle.sha256 },
      ],
    },
    components,
  };
}

/** The manifest the gate verifies, with the SBOM's own digest already inside. */
export function buildProvenance({
  platform,
  release,
  commit,
  version,
  bundle,
  sbom,
  generatedAt = new Date().toISOString(),
}) {
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    platform,
    release,
    commit: String(commit).toLowerCase(),
    version: String(version),
    generatedAt,
    bundle: {
      name: bundle.name,
      size: bundle.size,
      sha256: bundle.sha256,
    },
    sbom: {
      name: SBOM_ASSET,
      format: 'CycloneDX',
      specVersion: '1.5',
      size: sbom.size,
      sha256: sbom.sha256,
      components: sbom.components,
    },
  };
}

function fail(message) {
  console.error(`release provenance failed: ${message}`);
  process.exitCode = 1;
}

/**
 * Write `sbom.cdx.json` and `provenance.json` for one artifact. The manifest is
 * written after the SBOM, and hashes the bytes that were just written.
 */
export function writeReleaseProvenance({
  platform,
  release,
  commit,
  version,
  artifact,
  manifestPath,
  sbomPath,
  root = ROOT,
  generatedAt = new Date().toISOString(),
  log = console.log,
}) {
  const spec = PROVENANCE_PLATFORMS[platform];
  if (!spec) throw new Error(`unknown platform ${JSON.stringify(platform)}`);
  if (release !== spec.release) {
    throw new Error(
      `${platform} is published to ${spec.release}, not ${JSON.stringify(release)}`,
    );
  }
  if (!/^[0-9a-f]{40}$/i.test(String(commit))) {
    throw new Error(
      `commit must be the 40-hex GITHUB_SHA, not ${JSON.stringify(commit)}`,
    );
  }
  if (!version) throw new Error('version is required');
  if (!artifact || !existsSync(artifact)) {
    throw new Error(`artifact does not exist: ${artifact}`);
  }

  const bundle = {
    name: path.basename(artifact),
    size: statSync(artifact).size,
    sha256: sha256File(artifact),
  };

  const documents = [readNpmSbom(root)];
  // The Windows app also ships the shell's own production dependency
  // (electron-updater); the web payload and the other two shells do not.
  if (platform === 'windows') {
    documents.push(readNpmSbom(path.join(root, 'desktop')));
  }
  const sbom = buildSbom({
    platform,
    release,
    commit: String(commit).toLowerCase(),
    version,
    bundle,
    documents,
    electron: platform === 'windows' ? electronVersion() : null,
    generatedAt,
  });
  const sbomBuffer = Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`);

  mkdirSync(path.dirname(sbomPath), { recursive: true });
  writeFileSync(sbomPath, sbomBuffer);
  const manifest = buildProvenance({
    platform,
    release,
    commit,
    version,
    bundle,
    sbom: {
      size: sbomBuffer.length,
      sha256: sha256(sbomBuffer),
      components: sbom.components.length,
    },
    generatedAt,
  });
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  log(
    `provenance: ${platform} ${version} ${bundle.name} (${bundle.size} bytes, sha256 ${bundle.sha256})`,
  );
  log(
    `sbom: ${sbom.components.length} components, ${sbomBuffer.length} bytes -> ${path.relative(process.cwd(), sbomPath)}`,
  );
  log(`manifest: ${path.relative(process.cwd(), manifestPath)}`);
  return { manifest, sbom, bundle };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`--${key} needs a value`);
    }
    values[key] = value;
    index += 1;
  }
  return values;
}

const USAGE = `usage: node scripts/release-provenance.mjs [options]
  --platform=windows|android|ios  release channel (required)
  --release=<tag>                 desktop-latest, apk-latest or ios-latest
  --version=<version>             version written into the release notes
  --commit=<sha>                  full 40-hex commit the artifact was built from
  --artifact=<path>               installer, APK or IPA that is published
  --manifest=<path>               default: <artifact dir>/${PROVENANCE_ASSET}
  --sbom=<path>                   default: <artifact dir>/${SBOM_ASSET}
  --help                          this text
`;

function main(argv) {
  if (argv.includes('--help')) {
    console.log(USAGE);
    return 0;
  }
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    return 2;
  }
  const required = ['platform', 'release', 'version', 'commit', 'artifact'];
  const missing = required.filter((key) => !options[key]);
  if (missing.length) {
    console.error(`missing --${missing.join(', --')}`);
    console.error(USAGE);
    return 2;
  }
  const artifact = path.resolve(options.artifact);
  const directory = path.dirname(artifact);
  const manifestPath = path.resolve(
    options.manifest ?? path.join(directory, PROVENANCE_ASSET),
  );
  const sbomPath = path.resolve(
    options.sbom ?? path.join(directory, SBOM_ASSET),
  );
  writeReleaseProvenance({
    platform: options.platform,
    release: options.release,
    commit: options.commit,
    version: options.version,
    artifact,
    manifestPath,
    sbomPath,
  });
  return process.exitCode ?? 0;
}

const invoked = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invoked) {
  try {
    const code = main(process.argv.slice(2));
    if (code !== 0) process.exitCode = code;
  } catch (error) {
    fail(error.message);
  }
}
