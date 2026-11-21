// Module-graph watchdog.
//
// Everything else lives in modules, so a graph that never loads — a failed
// chunk, a stale cache, an offline shell — leaves no application code to report
// it. This file is a classic script, allowed by the page's `script-src 'self'`
// policy where an inline one would be blocked, and it runs before the module.
// After 15 s it reveals the fallback line the loading template already carries;
// `main.js` marks `data-boot="started"` as soon as its own module runs.
//
// The sentence is repeated here on purpose. The app's translations live in
// modules, and the whole point of this script is that no module ran, so
// `navigator.languages` is the only language signal left. Keep these in step
// with src/i18n/locales (test: src/ui/bootWatchdog.test.mjs).
(function () {
  var SENTENCE = {
    en: 'Loading did not start. Reload to try again.',
    fr: "Le chargement n'a pas démarré. Rechargez pour réessayer.",
    es: 'La carga no se inició. Recarga para reintentar.',
    ru: 'Загрузка не началась. Перезагрузите страницу.',
    ar: 'لم يبدأ التحميل. أعد التحميل للمحاولة مجددًا.',
    'zh-CN': '加载未启动。请重新加载重试。',
  };

  /** The shipped locale closest to the browser's first usable preference. */
  function pickLocale(languages) {
    for (var i = 0; i < languages.length; i += 1) {
      var tag = String(languages[i] || '').toLowerCase();
      if (tag.indexOf('zh') === 0) return 'zh-CN';
      var base = tag.split('-')[0];
      if (SENTENCE[base]) return base;
    }
    return 'en';
  }

  window.setTimeout(function () {
    if (document.documentElement.dataset.boot === 'started') return;
    var line = document.getElementById('boot-watchdog');
    if (!line) return;
    var languages =
      navigator.languages && navigator.languages.length
        ? navigator.languages
        : [navigator.language || 'en'];
    var locale = pickLocale(languages);
    line.textContent = SENTENCE[locale];
    line.lang = locale;
    if (locale === 'ar') line.dir = 'rtl';
    line.hidden = false;
  }, 15000);
})();
