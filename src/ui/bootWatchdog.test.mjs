import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { ENGLISH, SHIPPED, renderBlock } from '../../scripts/boot-watchdog-messages.mjs';

// The watchdog exists for the one failure no application test can reach: a
// module graph that never executes. Its parts are in separate files that do
// not import each other, so the only way to keep them wired is to check them.

const go = (run) => (run.go(), run);

const read = (file) =>
  fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

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
  assert.match(script, /dataset\.boot !== 'started'/, 'it checks the boot mark');
  assert.match(script, /getElementById\('boot-watchdog'\)/);
  assert.match(script, /15000/, 'it waits before accusing a slow start');
  assert.match(script, /30000/, 'and a second time for a boot that never ended');
  assert.match(script, /addEventListener\('error'/, 'a failed chunk is named');
});

test('the loading template carries the line, its sentence and its way out', () => {
  const template = read('src/ui/templates/hud-loading.html');
  assert.match(template, /id="boot-watchdog"/, 'the fallback line exists');
  assert.match(template, /id="boot-watchdog-text"[^>]*data-i18n/);
  assert.match(template, /Loading did not start/);
  assert.match(
    template,
    /id="boot-watchdog-reload"[^>]*href=""/,
    'a real reload control, needing no module',
  );
  assert.match(template, /id="boot-watchdog"[^>]*\bhidden\b/);
  assert.match(template, /id="boot-watchdog"[^>]*role="alert"/);
});

function runWatchdog({
  language = 'en-US',
  languages = null,
  boot = null,
} = {}) {
  const script = read('public/boot-watchdog.js');
  const line = { hidden: true, lang: '', dir: '' };
  const text = { textContent: '' };
  const reload = { hidden: true, textContent: '' };
  const listeners = [];
  const timers = [];
  const sandbox = {
    window: {
      setTimeout: (fn) => (timers.push(fn), timers.length),
      addEventListener: (type, fn) => (type === 'error' && listeners.push(fn)),
    },
    document: {
      documentElement: { dataset: boot ? { boot } : {} },
      getElementById: (id) =>
        ({ 'boot-watchdog': line, 'boot-watchdog-text': text })[id] ??
        (id === 'boot-watchdog-reload' ? reload : null),
    },
    navigator: { language, ...(languages ? { languages } : {}) },
  };
  vm.runInNewContext(script, sandbox);
  return {
    line,
    text,
    reload,
    failScript: (src) =>
      listeners[0]?.({ target: { tagName: 'SCRIPT', src } }),
    // The two deadlines fire in order; a boot that reports `started` is the
    // only one the second deadline speaks to.
    go: () => timers.forEach((fn) => fn()),
  };
}

test('the fallback line speaks the page language without any module', () => {
  const french = runWatchdog({ language: 'fr-FR' });
  french.go();
  assert.equal(
    french.text.textContent,
    "Le chargement n'a pas démarré. Rechargez pour réessayer.",
  );
  assert.equal(french.reload.textContent, 'Recharger', 'the way out is localized');
  assert.equal(french.reload.hidden, false);

  const arabic = runWatchdog({ language: 'ar' });
  arabic.go();
  assert.match(arabic.text.textContent, /لم يبدأ التحميل/);
  assert.equal(arabic.line.lang, 'ar');
  assert.equal(arabic.line.dir, 'rtl', 'an Arabic sentence runs right to left');

  assert.equal(
    go(runWatchdog({ languages: ['de-DE', 'es-ES'] })).line.lang,
    'es',
    'the first preference this build ships decides',
  );
  assert.equal(
    go(runWatchdog({ languages: ['de-DE'] })).line.lang,
    'en',
    'an unshipped language keeps the template English line',
  );
  assert.equal(
    go(runWatchdog({ language: 'zh-TW' })).line.lang,
    'zh-CN',
    'both Chinese forms read the one shipped catalog',
  );
});

test('a script that never arrived is named in the sentence', () => {
  const run = runWatchdog({ language: 'fr-FR' });
  run.failScript('https://example.test/assets/main-abc123.js?v=4');
  run.go();
  const line = run.text.textContent;
  assert.match(line, /main-abc123\.js/);
  assert.match(line, /n'a pas pu être chargé/);
});

test('a boot that started but never finished says so instead', () => {
  const run = runWatchdog({ language: 'fr-FR', boot: 'started' });
  run.go();
  assert.match(
    run.text.textContent,
    /La carte n'a pas fini de démarrer/,
    'the second timer catches a cover nobody lifted',
  );
});

test('the generated table is in step with the catalogs', () => {
  const script = read('public/boot-watchdog.js');
  assert.ok(
    script.includes(renderBlock()),
    'run `npm run boot-watchdog:i18n` after changing a catalog',
  );
  assert.deepEqual(
    Object.keys(JSON.parse(script.slice(
      script.indexOf('var MESSAGES = ') + 'var MESSAGES = '.length,
      script.indexOf('};', script.indexOf('var MESSAGES = ')) + 1,
    ))).sort(),
    [...SHIPPED].sort(),
  );
  for (const locale of SHIPPED.filter((name) => name !== 'en')) {
    const catalog = JSON.parse(read(`src/i18n/locales/${locale}.json`));
    for (const sentence of Object.values(ENGLISH)) {
      assert.ok(catalog[sentence], `${locale} translates "${sentence}"`);
    }
  }
});

test('the application module marks the boot as started, and then ready', () => {
  const main = read('src/main.js');
  assert.match(main, /documentElement\.dataset\.boot = 'started'/);
  assert.match(main, /dataset\.boot = 'ready'/);
  assert.match(main, /dataset\.boot = 'failed'/);
  assert.ok(
    main.indexOf("dataset.boot = 'started'") <
      main.indexOf('createStandaloneApplication('),
    'the mark is set as soon as the module runs, before any startup work',
  );
});
