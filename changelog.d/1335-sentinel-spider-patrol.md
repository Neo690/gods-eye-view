- The **Sentinel** (DATA ▸ Sentinel, still the `ai-agent` layer id) is now a
  robot spider that walks the globe instead of a badge that watched it. It
  keeps the roster watchdog — a feed that breaks is still reported — and adds a
  patrol: every cycle it ranks the enabled layers by severity, feed health,
  freshness, distance and how long ago it looked at each, crawls along a great
  circle to the nearest record of the best one — turning at a bounded rate, so
  the walk arcs instead of teleporting — and on arrival scans the ground under
  it and reports what that layer holds in the operator's language
  (`{count} records`, plural rules included). A feed error or an escalated
  event pulls it off its route to the layer that broke. The body is four
  procedurally drawn gait frames, so no sprite asset and no build step, on a
  billboard with a scan ring tinted by severity and a note naming the layer
  under inspection, drawn by the world-overlay host rather than an entity
  label graphic (Cesium labels remain forbidden); the report card in the
  corner keeps the finding list,
  translated and clickable, collapsible, and dormant when the layer is off.
  The patrol is local and deterministic: nothing here enables a layer, nothing
  moves the camera, and the optional model only ever words one warning finding
  as a sentence, at most once every twenty minutes — with no key, or no canvas
  to draw the body, the layer still watches and still reports (yourname,
  #1335).
