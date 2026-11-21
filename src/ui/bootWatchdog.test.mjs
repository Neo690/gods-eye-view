import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// The watchdog exists for the one failure no application test can reach: a
// module graph that never executes. Its three parts are in three files that do
// not import each other, so the only way to keep them wired is to check them.

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

test('index.html loads the watchdog as an external classic script', () => {
  const html = read('index.html');
  assert.match(
    html,
    /<script src="\/boot-watchdog\.js"><\/script>/,
    'inline script would be blocked by the page CSP',
  );
  assert.ok(
    html.indexOf('/boot-watchdog.js') < html.indexOf('type="module"'),
    'the watchdog runs before the application module',
  );
  const script = read('public/boot-watchdog.js');
  assert.match(script, /setTimeout/, 'a classic script, not a module');
  assert.match(script, /dataset\.boot === 'started'/, 'it stands down once the app ran');
  assert.match(script, /getElementById\('boot-watchdog'\)/);
  assert.match(script, /15000/, 'it waits before accusing a slow start');
});

test('the loading template carries the line, hidden until needed', () => {
  const template = read('src/ui/templates/hud-loading.html');
  const line = template.match(/<p[^>]*id="boot-watchdog"[^>]*>([^<]*)<\/p>/);
  assert.ok(line, 'the fallback line exists in the cover');
  assert.match(line[0], /\bhidden\b/, 'it is not shown on a normal boot');
  assert.match(line[0], /role="alert"/, 'and is announced when it is');
  assert.match(line[0], /data-i18n/, 'its sentence is translatable');
  assert.match(line[1], /Loading did not start/);
});

function runWatchdog({ language = 'en-US', languages = null } = {}) {
  const script = read('public/boot-watchdog.js');
  const line = { hidden: true, textContent: '', lang: '', dir: '' };
  const sandbox = {
    window: { setTimeout: (fn) => (fn(), 1) },
    document: {
      documentElement: { dataset: {} },
      getElementById: (id) => (id === 'boot-watchdog' ? line : null),
    },
    navigator: { language, ...(languages ? { languages } : {}) },
  };
  vm.runInNewContext(script, sandbox);
  return line;
}

test('the fallback line speaks the page language without any module', () => {
  assert.equal(
    runWatchdog({ language: 'fr-FR' }).textContent,
    "Le chargement n'a pas démarré. Rechargez pour réessayer.",
  );
  const arabic = runWatchdog({ language: 'ar' });
  assert.match(arabic.textContent, /لم يبدأ التحميل/);
  assert.equal(arabic.lang, 'ar');
  assert.equal(arabic.dir, 'rtl', 'an Arabic sentence runs right to left');

  assert.equal(
    runWatchdog({ languages: ['de-DE', 'es-ES'] }).lang,
    'es',
    'the first preference this build ships decides',
  );
  assert.equal(
    runWatchdog({ languages: ['de-DE'] }).lang,
    'en',
    'an unshipped language keeps the template\'s English line',
  );
  assert.equal(
    runWatchdog({ language: 'zh-TW' }).lang,
    'zh-CN',
    'both Chinese forms read the one shipped catalog',
  );
});

const SHIPPED = ['en', 'fr', 'es', 'ru', 'ar', 'zh-CN'];

test('every sentence the watchdog can show is a shipped catalog message', () => {
  const script = read('public/boot-watchdog.js');
  const block = script.slice(script.indexOf('var SENTENCE'), script.indexOf('};'));
  const keys = [...block.matchAll(/^\s{4}(?:'([^']+)'|([a-z]+)):/gm)].map(
    (match) => match[1] || match[2],
  );
  assert.deepEqual([...keys].sort(), [...SHIPPED].sort());
  for (const locale of SHIPPED.filter((name) => name !== 'en')) {
    const catalog = JSON.parse(read(`src/i18n/locales/${locale}.json`));
    const sentence =
      catalog['Loading did not start. Reload to try again.'] ?? '';
    assert.ok(
      sentence && script.includes(sentence),
      `${locale} ships the same sentence as the watchdog`,
    );
  }
});

test('the application module marks the boot as started', () => {
  const main = read('src/main.js');
  assert.match(main, /documentElement\.dataset\.boot = 'started'/);
  assert.ok(
    main.indexOf("dataset.boot = 'started'") <
      main.indexOf('createStandaloneApplication('),
    'the mark is set as soon as the module runs, before any startup work',
  );
});
