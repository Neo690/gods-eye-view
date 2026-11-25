/**
 * Key declarations for application layers.
 *
 * A layer whose provider cannot work without a credential is marked
 * `required: true`. Optional credentials are still declared here so their
 * provider relationship stays reviewable, but they do not make the layer
 * keyed: the layer has a keyless fallback and belongs in the keyless canary
 * decision inventory.
 *
 * The live keyless canary gate and its tests derive their inventory from this
 * file. A new layer without a required declaration is therefore treated as
 * keyless until the reviewer either declares its key or records a canary
 * decision for it.
 */
export const LAYER_KEY_DECLARATIONS = Object.freeze({
  'local-firms': Object.freeze({
    keys: Object.freeze(['firms']),
    required: true,
  }),
  'conflict-events': Object.freeze({
    keys: Object.freeze(['acled']),
    required: true,
  }),
  'fishing-effort': Object.freeze({
    keys: Object.freeze(['global-fishing-watch']),
    required: true,
  }),
  'ais-live-vessels': Object.freeze({
    keys: Object.freeze(['aisstream']),
    required: true,
  }),

  // Optional credentials: these layers have a keyless provider or fallback.
  flights: Object.freeze({
    keys: Object.freeze(['opensky']),
    required: false,
  }),
  military: Object.freeze({
    keys: Object.freeze(['adsb-exchange']),
    required: false,
  }),
  traffic: Object.freeze({
    keys: Object.freeze(['tomtom']),
    required: false,
  }),
  'satellite-watch': Object.freeze({
    keys: Object.freeze(['n2yo', 'space-track']),
    required: false,
  }),
  'cell-towers': Object.freeze({
    keys: Object.freeze(['opencellid']),
    required: false,
  }),
  radiation: Object.freeze({
    keys: Object.freeze(['uradmonitor']),
    required: false,
  }),
  'rocket-launches': Object.freeze({
    keys: Object.freeze(['launch-library']),
    required: false,
  }),
  'street-level': Object.freeze({
    keys: Object.freeze(['mapillary', 'google-maps']),
    required: false,
  }),
});

/** True when the layer has no credential-free operating path. */
export function layerRequiresKey(
  layerId,
  declarations = LAYER_KEY_DECLARATIONS,
) {
  return declarations[layerId]?.required === true;
}

/**
 * Derive the keyless candidate inventory from the catalog and its key
 * declarations. Passing metadata objects or ids is supported.
 * @param {Array<string|{id: string}>} layers
 * @param {Record<string, {required?: boolean}>} [declarations]
 * @returns {string[]} layer ids with no required credential
 */
export function deriveKeylessLayerIds(
  layers,
  declarations = LAYER_KEY_DECLARATIONS,
) {
  return layers
    .map((layer) => (typeof layer === 'string' ? layer : layer?.id))
    .filter((id) => typeof id === 'string' && id.length > 0)
    .filter((id) => !layerRequiresKey(id, declarations))
    .sort();
}
