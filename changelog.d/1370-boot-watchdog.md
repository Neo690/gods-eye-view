- A page whose module graph never loads now says so instead of waiting
  forever on `Initializing photorealistic world...`. `public/boot-watchdog.js`
  is a classic script loaded before the application module: it waits 15 seconds
  for `main.js` to set `data-boot="started"` on the `<html>` element, and
  without that mark it reveals the loading cover's own fallback line,
  `Loading did not start. Reload to try again.`, in a `role="alert"` paragraph.
  The sentence is repeated in that file because the app's catalogs are modules
  too; `navigator.languages` picks the first shipped locale among
  en/fr/es/ru/ar/zh-CN, falls back to the template's English line, and marks an
  Arabic sentence `dir="rtl"`.
  External rather than inline because the page's CSP allows `script-src 'self'`
  and no inline script — the first inline version was blocked in the built app,
  which a browser check caught. A normal boot keeps the line hidden, so the
  watchdog is invisible unless it is the only thing left that can speak
  (Neo690, #1370).
