import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// A layer that is registered in five places out of six is a layer that is off,
// unnamed, missing from a voice tool or able to cross a package boundary
// nobody declared. These checks are the shortest path back to a complete
// registration when a file moves or a new one is added.

const root = fileURLToPath(new URL('../../..', import.meta.url));
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('the layer is constructed and registered as local-only', () => {
  const catalog = read('src/app/constructCatalog.js');
  assert.match(
    catalog,
    /import \{ createDeviceSweepLayer \} from '\.\.\/layers\/deviceSweep\/index\.js';/,
  );
  assert.match(catalog, /createDeviceSweepLayer\(\)/);
  assert.match(
    catalog,
    /Object\.freeze\(\{\s*id: 'device-sweep',\s*disposition: 'local-only',?\s*\}\)/,
    'a sweep of a private network must never enter a share link',
  );
});

test('the row, the name and the voice manifest all know the layer', () => {
  assert.match(
    read('src/ui/layerNames.js'),
    /'device-sweep': msg\('Device Sweep'\)/,
  );
  assert.match(
    read('src/ui/layerPanel.js'),
    /ids: \[[\s\S]*?'private-wifi',\s*'device-sweep',[\s\S]*?\],/,
    'the row sits with the other own-network layers',
  );
  assert.match(read('src/voice/layerManifest.js'), /id: 'device-sweep',/);
  assert.match(read('README.md'), /🔎 \*\*Device Sweep\*\*/);
});

test('every module of the layer is declared in both layer packages', () => {
  const boundaries = read('scripts/package-boundaries.json');
  const modules = fs
    .readdirSync(path.join(root, 'src/layers/deviceSweep'))
    .filter((name) => name.endsWith('.js'));
  assert.ok(modules.includes('index.js'));
  for (const name of modules) {
    const entry = `"src/layers/deviceSweep/${name}"`;
    assert.equal(
      boundaries.split(entry).length - 1,
      2,
      `${name} must be declared in application-components and application-layer-construction`,
    );
  }
});

test('every shipped locale names the layer', () => {
  for (const locale of ['ar', 'es', 'fr', 'ru', 'zh-CN']) {
    const catalog = JSON.parse(read(`src/i18n/locales/${locale}.json`));
    assert.ok(catalog['Device Sweep'], `${locale} names the layer`);
  }
});
