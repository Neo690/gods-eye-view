/**
 * Read the tags of a markup string, so a test can assert the STRUCTURE of a
 * template instead of spelling out its whitespace.
 *
 * The markup this project ships is formatted by Prettier: attributes wrap onto
 * their own lines the moment a tag gets wide, which is a formatting decision,
 * not a template change. A regular expression that spells out single spaces
 * fails on the reformat and teaches the next person to loosen the assertion
 * until it proves nothing. Reading the tags instead makes the same assertions
 * and keeps them exact.
 *
 * It is deliberately small: no tree, no CSS, no error recovery. It reads
 * elements in document order with their attributes and the range of their
 * inner content, which is what a markup-consistency test needs.
 */

const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

const VOID_TAGS = new Set(
  'area base br col embed hr img input link meta source track wbr'.split(' '),
);

/** Raw-text elements whose content is not markup. */
const RAW_TEXT = new Set(['script', 'style']);

const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;

function parseAttributes(source) {
  const attributes = {};
  for (const match of String(source ?? '').matchAll(ATTRIBUTE)) {
    const name = match[1].toLowerCase();
    attributes[name] = match[2] ?? match[3] ?? '';
  }
  return attributes;
}

/**
 * Elements in document order.
 *
 * @param {string} html
 * @returns {Array<{tag: string, attrs: Object<string,string>,
 *   classes: string[], start: number, innerStart: number,
 *   innerEnd: number|null, end: number|null, selfClosing: boolean}>}
 */
export function markupElements(html) {
  const source = String(html ?? '');
  const elements = [];
  const stack = [];
  for (const match of source.matchAll(TAG)) {
    const [, closing, rawTag, attributes, selfClosing] = match;
    const tag = rawTag.toLowerCase();
    if (closing) {
      // Close the nearest open element of this name and anything left inside
      // it: an unbalanced template still yields a usable range.
      const at = stack.map((entry) => entry.tag).lastIndexOf(tag);
      if (at < 0) continue;
      for (const entry of stack.splice(at)) {
        entry.innerEnd = match.index;
        entry.end = match.index + match[0].length;
      }
      continue;
    }
    const attrs = parseAttributes(attributes);
    const element = {
      tag,
      attrs,
      classes: String(attrs.class ?? '')
        .split(/\s+/)
        .filter(Boolean),
      start: match.index,
      innerStart: match.index + match[0].length,
      innerEnd: null,
      end: null,
      selfClosing: selfClosing === '/' || VOID_TAGS.has(tag),
    };
    elements.push(element);
    if (element.selfClosing) {
      element.innerEnd = element.innerStart;
      element.end = element.innerStart;
      continue;
    }
    stack.push(element);
    if (RAW_TEXT.has(tag)) {
      const close = source
        .toLowerCase()
        .indexOf(`</${tag}`, element.innerStart);
      if (close >= 0) {
        element.innerEnd = close;
        element.end = source.indexOf('>', close) + 1 || source.length;
      }
    }
  }
  for (const entry of stack) {
    // Never closed: its content runs to the end of the source.
    entry.innerEnd ??= source.length;
    entry.end ??= source.length;
  }
  return elements;
}

function matches(element, { tag, id, classes = [], attrs = {} } = {}) {
  if (tag && element.tag !== String(tag).toLowerCase()) return false;
  if (id && element.attrs.id !== id) return false;
  if (!classes.every((name) => element.classes.includes(name))) return false;
  return Object.entries(attrs).every(
    ([name, value]) => element.attrs[name.toLowerCase()] === value,
  );
}

/**
 * Every element matching a tag, an id, required classes and exact attributes.
 * @param {string} html
 * @param {{tag?: string, id?: string, classes?: string[],
 *   attrs?: Object<string,string>}} [criteria]
 */
export function queryElements(html, criteria = {}) {
  return markupElements(html).filter((element) => matches(element, criteria));
}

/**
 * The first matching element, or null.
 * @param {string} html
 * @param {{tag?: string, id?: string, classes?: string[],
 *   attrs?: Object<string,string>}} [criteria]
 */
export function queryElement(html, criteria = {}) {
  return queryElements(html, criteria)[0] ?? null;
}

/** The markup between an element's tags. */
export function elementInner(html, element) {
  const source = String(html ?? '');
  const start = element?.innerStart ?? 0;
  const end = element?.innerEnd ?? source.length;
  return source.slice(start, end);
}
