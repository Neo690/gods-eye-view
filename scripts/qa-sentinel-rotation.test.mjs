import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BOOTS,
  SELF_CHECKS,
  USAGE,
  parseArgs,
  resolveBoots,
  selectedBoots,
} from './qa-sentinel-rotation.mjs';

const args = (argv) => Object.fromEntries(parseArgs(argv));

test('only the documented flags are accepted, and a typo is a usage error', () => {
  assert.deepEqual(args(['--url', 'http://localhost:4000']), {
    '--url': 'http://localhost:4000',
  });
  assert.deepEqual(args(['--self-check']), { '--self-check': true });
  assert.deepEqual(args(['--case', 'radio-sites,military-bases']), {
    '--case': 'radio-sites,military-bases',
  });
  // `--urll` used to be ignored, and the gate then ran against the default
  // address: a different server altogether, and green for the wrong reason.
  assert.throws(
    () => parseArgs(['--urll', 'http://localhost:4000']),
    /unknown argument "--urll"/,
  );
});

test('a repeated flag or a flag without a value is never defaulted', () => {
  assert.throws(
    () => parseArgs(['--url', 'a', '--url', 'b']),
    /--url given twice/,
  );
  assert.throws(() => parseArgs(['--url']), /--url needs a value/);
  assert.throws(() => parseArgs(['--case']), /--case needs a value/);
  // A following flag is not a value, so this must not run the case named
  // "--self-check".
  assert.throws(
    () => parseArgs(['--url', '--self-check']),
    /--url needs a value/,
  );
});

test('boots are selected by name, and an empty or unknown selection is fatal', () => {
  assert.deepEqual(
    selectedBoots(null).map((boot) => boot.name),
    BOOTS.map((boot) => boot.name),
  );
  assert.deepEqual(
    selectedBoots(' military-bases , radio-sites ').map((boot) => boot.name),
    ['radio-sites', 'military-bases'],
    'the selection follows the boot order, not the order typed',
  );
  assert.deepEqual(
    selectedBoots('radio-sites,radio-sites').map((boot) => boot.name),
    ['radio-sites'],
  );
  // An empty value must not mean "no boots": that would finish green without
  // starting a browser.
  assert.throws(() => selectedBoots(''), /--case needs a boot name/);
  assert.throws(
    () => selectedBoots('radio-site'),
    /unknown case\(s\): radio-site/,
  );
});

test('--self-check and --case together are a usage error, not a preference', () => {
  assert.throws(
    () => resolveBoots({ selfCheck: true, caseArg: 'radio-sites' }),
    /--self-check runs its own boot; drop --case/,
  );
  assert.deepEqual(
    resolveBoots({ selfCheck: true, caseArg: null }).map((boot) => boot.name),
    SELF_CHECKS.map((boot) => boot.name),
  );
  assert.equal(resolveBoots({ selfCheck: false, caseArg: null }).length, BOOTS.length);
});

test('a sabotage can never be mistaken for a verdict, and every boot has one name', () => {
  const named = [...BOOTS, ...SELF_CHECKS].map((boot) => boot.name);
  assert.equal(new Set(named).size, named.length, 'boot names are unique');
  const verdicts = new Set(BOOTS.map((boot) => boot.name));
  for (const check of SELF_CHECKS) {
    assert.equal(
      verdicts.has(check.name),
      false,
      `${check.name} is not part of a normal run`,
    );
  }
  // CI documents three sabotages; a boot quietly dropped here would leave one
  // assertion with no proof that it still bites.
  assert.deepEqual(
    SELF_CHECKS.map((boot) => boot.name),
    ['self-check-rotation', 'self-check-pack', 'self-check-starvation'],
  );
  assert.ok(USAGE.includes('--url'));
  assert.ok(USAGE.includes('--case'));
  assert.ok(USAGE.includes('--self-check'));
});
