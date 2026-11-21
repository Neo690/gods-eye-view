// Generate the watchdog's sentences from the translation catalogs.
//
// The watchdog runs when no module does, so its sentences cannot come from the
// i18n bundles at runtime. They are copied into public/boot-watchdog.js instead,
// and this script is what copies them: run `npm run boot-watchdog:i18n` after a
// catalog change, or `--check` to fail when the file is stale (what the test
// does). English is the source language the catalogs translate from, so its
// sentences live here.
import fs from 'node:fs';

/**
 * English sources; every other shipped locale reads them from its catalog.
 * A JSON file, not an import: `scripts/i18n.mjs` has to read them from a
 * sandbox that only copies the checker, so it opens this file when it exists.
 */
export const ENGLISH = Object.freeze(
  JSON.parse(
    fs.readFileSync(
      new URL('./boot-watchdog-messages.json', import.meta.url),
      'utf8',
    ),
  ),
);

/** The shipped locales, in the order the file writes them. */
export const SHIPPED = Object.freeze(['en', 'ar', 'es', 'fr', 'ru', 'zh-CN']);

const FILE = new URL('../public/boot-watchdog.js', import.meta.url);
const START = '// gev:watchdog-messages:start';
const END = '// gev:watchdog-messages:end';

/** Read one catalog's four sentences, failing loudly on a missing key. */
function readCatalog(locale) {
  if (locale === 'en') return ENGLISH;
  const catalog = JSON.parse(
    fs.readFileSync(
      new URL(`../src/i18n/locales/${locale}.json`, import.meta.url),
      'utf8',
    ),
  );
  const messages = {};
  for (const [name, source] of Object.entries(ENGLISH)) {
    const value = catalog[source];
    if (!value) throw new Error(`${locale}.json is missing "${source}"`);
    messages[name] = value;
  }
  return messages;
}

/** The table as the generated block writes it. */
export function renderBlock() {
  const messages = Object.fromEntries(
    SHIPPED.map((locale) => [locale, readCatalog(locale)]),
  );
  const body = JSON.stringify(messages, null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join('\n');
  return `${START}\n  var MESSAGES = ${body};\n  ${END}`;
}

/** Replace the generated region; `check` reports instead of writing. */
export function apply({ check = false } = {}) {
  const source = fs.readFileSync(FILE, 'utf8');
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  if (start < 0 || end < 0) throw new Error(`markers missing in ${FILE.pathname}`);
  const next = source.slice(0, start) + renderBlock() + source.slice(end + END.length);
  if (check) return next === source ? 0 : 1;
  if (next !== source) fs.writeFileSync(FILE, next);
  return 0;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const check = process.argv.includes('--check');
  const status = apply({ check });
  if (check && status) {
    console.error(
      'public/boot-watchdog.js is stale: run `npm run boot-watchdog:i18n`.',
    );
  }
  process.exit(status);
}
