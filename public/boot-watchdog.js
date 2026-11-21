// Module-graph watchdog.
//
// Everything else lives in modules, so a graph that never loads — a failed
// chunk, a stale cache, an offline shell — leaves no application code to report
// it. This file is a classic script, allowed by the page's `script-src 'self'`
// policy where an inline one would be blocked, and it runs before the module.
// After 15 s it reveals the fallback line the loading template already carries;
// `main.js` marks `data-boot="started"` as soon as its own module runs, and
// `data-boot="ready"` once every startup phase settled, so a graph that runs
// but never finishes is caught 15 s later.
//
// The sentences are repeated here on purpose: the app's translations live in
// modules, and the whole point of this script is that no module ran, so
// `navigator.languages` is the only language signal left. They are generated
// from src/i18n/locales by `npm run boot-watchdog:i18n` — never edit the table
// by hand.
(function () {
  // gev:watchdog-messages:start
  var MESSAGES = {
    "en": {
      "text": "Loading did not start. Reload to try again.",
      "failed": "{file} did not load.",
      "ready": "The map did not finish starting. Reload to try again.",
      "reload": "Reload"
    },
    "ar": {
      "text": "لم يبدأ التحميل. أعد التحميل للمحاولة مجددًا.",
      "failed": "تعذّر تحميل {file}.",
      "ready": "لم تُكمل الخريطة بدء التشغيل. أعد التحميل للمحاولة مجددًا.",
      "reload": "إعادة التحميل"
    },
    "es": {
      "text": "La carga no se inició. Recarga para reintentar.",
      "failed": "No se pudo cargar {file}.",
      "ready": "El mapa no terminó de iniciarse. Recarga para reintentar.",
      "reload": "Recargar"
    },
    "fr": {
      "text": "Le chargement n'a pas démarré. Rechargez pour réessayer.",
      "failed": "Le fichier {file} n'a pas pu être chargé.",
      "ready": "La carte n'a pas fini de démarrer. Rechargez pour réessayer.",
      "reload": "Recharger"
    },
    "ru": {
      "text": "Загрузка не началась. Перезагрузите страницу.",
      "failed": "Не удалось загрузить {file}.",
      "ready": "Карта не завершила запуск. Перезагрузите страницу.",
      "reload": "Перезагрузить"
    },
    "zh-CN": {
      "text": "加载未启动。请重新加载重试。",
      "failed": "无法加载 {file}。",
      "ready": "地图未能完成启动。请重新加载重试。",
      "reload": "重新加载"
    }
  };
  // gev:watchdog-messages:end

  /** The shipped locale closest to the browser's first usable preference. */
  function pickLocale(languages) {
    for (var i = 0; i < languages.length; i += 1) {
      var tag = String(languages[i] || '').toLowerCase();
      if (tag.indexOf('zh') === 0) return 'zh-CN';
      var base = tag.split('-')[0];
      if (MESSAGES[base]) return base;
    }
    return 'en';
  }

  function preferredLanguages() {
    return navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language || 'en'];
  }

  // The name of the first script the browser failed to load. Knowing that a
  // chunk 404'd is worth more than a generic "it did not start": the failed
  // file usually names the cause (a stale build, an offline shell).
  var failed = '';

  function rememberFailedScript(event) {
    var target = event && event.target;
    if (!target || target.tagName !== 'SCRIPT' || failed) return;
    var url = String(target.src || '');
    if (!url) return;
    failed = url.split('/').pop().split('?')[0] || url;
  }

  try {
    window.addEventListener('error', rememberFailedScript, true);
  } catch (error) {
    // A browser that refuses capture still gets the plain sentence.
  }

  /** Reveal the line, in the reader's language, with its way out. */
  function reveal(sentence) {
    var locale = pickLocale(preferredLanguages());
    var line = document.getElementById('boot-watchdog');
    var text = document.getElementById('boot-watchdog-text');
    if (!line || !text) return;
    text.textContent = sentence;
    line.lang = locale;
    if (locale === 'ar') line.dir = 'rtl';
    var reload = document.getElementById('boot-watchdog-reload');
    if (reload) {
      reload.textContent = MESSAGES[locale].reload;
      reload.hidden = false;
    }
    line.hidden = false;
  }

  // No module has run: say so, and name the script that did not arrive.
  window.setTimeout(function () {
    if (document.documentElement.dataset.boot) return;
    var messages = MESSAGES[pickLocale(preferredLanguages())];
    var sentence = messages.text;
    if (failed) {
      sentence += ' ' + messages.failed.replace('{file}', failed);
    }
    reveal(sentence);
  }, 15000);

  // The module ran but a phase never settled: the cover is still up and the
  // startup guard's own budget may belong to a boot that never got that far.
  window.setTimeout(function () {
    if (document.documentElement.dataset.boot !== 'started') return;
    reveal(MESSAGES[pickLocale(preferredLanguages())].ready);
  }, 30000);
})();
