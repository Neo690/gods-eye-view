/**
 * Plate OCR configuration and greedy decoding, without any runtime.
 *
 * `fast-plate-ocr` answers with one probability vector per character slot
 * (`[1, slots, vocabulary]`) rather than a CTC timeline, so decoding is an
 * argmax per slot followed by stripping the padding character. The alphabet,
 * the slot count and the input size come from the YAML the model was trained
 * with; this module reads the handful of keys it needs instead of pulling a
 * YAML parser into a server that otherwise has none.
 * @module server/alpr/ocr
 */

/** Padding character when the config does not name one. */
export const DEFAULT_PAD_CHAR = '_';

/** Input size used when the config omits it (the hub's own default). */
export const DEFAULT_PLATE_INPUT = Object.freeze({ height: 64, width: 128 });

/** Read one top-level `key: value` scalar from the plate config. */
function scalar(text, key) {
  const match = new RegExp(`^${key}:[ \t]*(.+)$`, 'm').exec(text);
  if (!match) return null;
  return match[1].replace(/\s+#.*$/, '').trim();
}

/**
 * The inference settings of a plate model.
 *
 * @param {string} text Contents of the `*_plate_config.yaml` file.
 * @returns {{alphabet:string, slots:number, padChar:string, height:number,
 *   width:number, colorMode:'grayscale'|'rgb'}} Settings the engine needs.
 * @throws {TypeError} When the config lacks the alphabet or the slot count —
 *   guessing either would silently produce plausible-looking wrong plates.
 */
export function parsePlateConfig(text) {
  if (typeof text !== 'string' || !text.trim())
    throw new TypeError('A plate config is required');
  const alphabetMatch = /^alphabet:[ \t]*['"](.*)['"][ \t]*$/m.exec(text);
  const alphabet = alphabetMatch ? alphabetMatch[1] : '';
  if (!alphabet) throw new TypeError('Plate config has no alphabet');
  const slots = Number(scalar(text, 'max_plate_slots'));
  if (!Number.isInteger(slots) || slots <= 0)
    throw new TypeError('Plate config has no usable max_plate_slots');
  const padChar = (scalar(text, 'pad_char') || DEFAULT_PAD_CHAR).replace(
    /^['"]|['"]$/g,
    '',
  );
  const height =
    Number(scalar(text, 'img_height')) || DEFAULT_PLATE_INPUT.height;
  const width = Number(scalar(text, 'img_width')) || DEFAULT_PLATE_INPUT.width;
  const colorMode =
    scalar(text, 'image_color_mode') === 'rgb' ? 'rgb' : 'grayscale';
  return { alphabet, slots, padChar, height, width, colorMode };
}

/**
 * Decode one plate from the OCR head's probabilities.
 *
 * Confidence is the mean of the per-slot maxima: a plate read at 0.99 on six
 * slots and 0.40 on two is not a 0.99 read, and the panel shows this number
 * beside the text.
 *
 * @param {{data:ArrayLike<number>, dims:number[]}} output The `plate` output.
 * @param {{alphabet:string, slots:number, padChar:string}} config
 * @returns {{text:string, confidence:number, perChar:number[]}|null} `null`
 *   when the model answered nothing at all.
 */
export function decodePlate(output, config) {
  const { alphabet, slots, padChar } = config;
  if (!Array.isArray(output?.dims) || output.dims.length < 2) return null;
  const vocab = alphabet.length;
  if (!vocab) return null;
  const stride = output.dims[output.dims.length - 1];
  if (stride !== vocab) return null;
  const slotCount = Math.min(slots, output.dims[output.dims.length - 2]);
  const data = output.data;
  const chars = [];
  for (let slot = 0; slot < slotCount; slot += 1) {
    const base = slot * vocab;
    let bestIndex = 0;
    let best = -Infinity;
    for (let index = 0; index < vocab; index += 1) {
      const value = Number(data[base + index]);
      if (value > best) {
        best = value;
        bestIndex = index;
      }
    }
    if (!Number.isFinite(best)) continue;
    chars.push({ char: alphabet[bestIndex] || '', probability: best });
  }
  // Trailing padding is the model saying "the plate ended here". Its own
  // probability is high by construction, so it must not enter the average.
  while (chars.length && chars[chars.length - 1].char === padChar) chars.pop();
  if (!chars.length) return null;
  const text = chars.map((entry) => entry.char).join('');
  if (!text) return null;
  const perChar = chars.map((entry) => entry.probability);
  const confidence =
    perChar.reduce((sum, value) => sum + value, 0) / perChar.length;
  return { text, confidence, perChar };
}
