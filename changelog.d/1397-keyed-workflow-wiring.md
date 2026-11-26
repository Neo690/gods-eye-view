- **The live canary's keyed provider list now has one source.** Secret detection
  and the keyed preview's environment in `.github/workflows/live-layers.yml` are
  generated from `KEYED_LAYERS`, so a new keyed provider is one manifest entry
  plus `node scripts/keyed-live-layers-workflow.mjs --write` instead of four
  edits in the workflow that could drift apart. The unit suite fails when the
  checked-in wiring no longer matches the manifest, and refuses a layer id or
  secret name that cannot be rendered into YAML and shell. The keyless preview
  stays outside both generated regions, so it still never receives a provider
  secret.
