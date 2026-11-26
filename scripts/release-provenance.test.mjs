import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROVENANCE_SCHEMA_VERSION,
  buildProvenance,
  buildSbom,
  mergeSbomComponents,
  sha256,
} from './release-provenance.mjs';

const BUNDLE = {
  name: 'gods-eye-view.apk',
  size: 1234,
  sha256: sha256(Buffer.from('apk bytes')),
};
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function npmDocument(components) {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    metadata: { component: { type: 'library', name: 'checkout', version: '0.3.0' } },
    components,
  };
}

test('the SBOM carries the bundle hash and the release properties', () => {
  const sbom = buildSbom({
    platform: 'android',
    release: 'apk-latest',
    commit: COMMIT,
    version: '1.0.1175',
    bundle: BUNDLE,
    documents: [
      npmDocument([
        { type: 'library', name: 'left-pad', version: '1.0.0', purl: 'pkg:npm/left-pad@1.0.0' },
      ]),
    ],
    generatedAt: '2026-11-26T00:00:00.000Z',
  });
  assert.equal(sbom.bomFormat, 'CycloneDX');
  assert.equal(sbom.specVersion, '1.5');
  assert.equal(sbom.metadata.component.version, '1.0.1175');
  const properties = Object.fromEntries(
    sbom.metadata.properties.map((entry) => [entry.name, entry.value]),
  );
  assert.equal(properties['gev:commit'], COMMIT);
  assert.equal(properties['gev:platform'], 'android');
  assert.equal(properties['gev:release'], 'apk-latest');
  assert.equal(properties['gev:bundle:sha256'], BUNDLE.sha256);

  const file = sbom.components.find(
    (component) => component.type === 'file' && component.name === BUNDLE.name,
  );
  assert.equal(file.hashes[0].alg, 'SHA-256');
  assert.equal(file.hashes[0].content, BUNDLE.sha256);
  assert.ok(
    sbom.components.some((component) => component.name === 'left-pad'),
    'production npm components stay in the SBOM',
  );
});

test('duplicate npm components are written once', () => {
  const component = {
    type: 'library',
    name: 'shared',
    version: '2.0.0',
    purl: 'pkg:npm/shared@2.0.0',
  };
  const merged = mergeSbomComponents([
    npmDocument([component]),
    npmDocument([{ ...component }]),
  ]);
  assert.equal(merged.length, 1);
});

test('the Windows SBOM names the packaged Electron version', () => {
  const sbom = buildSbom({
    platform: 'windows',
    release: 'desktop-latest',
    commit: COMMIT,
    version: '1.0.120',
    bundle: BUNDLE,
    documents: [],
    electron: '45.0.0',
  });
  assert.ok(
    sbom.components.some(
      (component) =>
        component.name === 'electron' && component.version === '45.0.0',
    ),
  );
});

test('the manifest ties the bundle, the SBOM and the schema version together', () => {
  const sbom = { size: 321, sha256: 'a'.repeat(64), components: 7 };
  const manifest = buildProvenance({
    platform: 'ios',
    release: 'ios-latest',
    commit: COMMIT,
    version: '1.0.77',
    bundle: BUNDLE,
    sbom,
    generatedAt: '2026-11-26T00:00:00.000Z',
  });
  assert.equal(manifest.schemaVersion, PROVENANCE_SCHEMA_VERSION);
  assert.equal(manifest.platform, 'ios');
  assert.equal(manifest.release, 'ios-latest');
  assert.equal(manifest.commit, COMMIT);
  assert.equal(manifest.version, '1.0.77');
  assert.deepEqual(manifest.bundle, BUNDLE);
  assert.deepEqual(manifest.sbom, {
    name: 'sbom.cdx.json',
    format: 'CycloneDX',
    specVersion: '1.5',
    size: 321,
    sha256: 'a'.repeat(64),
    components: 7,
  });
});
