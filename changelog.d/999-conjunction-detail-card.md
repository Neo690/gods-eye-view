- A predicted close approach now opens its detail card on click. The conjunction
  markers this layer paints answer a left click (when no tool owns the pointer),
  and the clicked one swaps its one-line ambient label for the wider selected
  card the overlay host already draws: both objects by name and NORAD number,
  the **probability of collision** in the exponent the feed reports (a fixed
  `0.000` would call every real Pc impossible), the **TCA** in UTC, the
  **relative speed**, and the source line (`Space-Track CDM`) that says which
  feed asserted it. A value the CDM omitted reads "Unavailable", never `0`.
  Clicking empty space closes the card; a click on another layer's entity leaves
  it alone so sibling selections still work, and a refresh whose feed no longer
  carries the event drops the selection with it. The handler is installed with
  the layer and destroyed with it, and takes the click-handler factory as an
  option so the layer stays testable without a canvas.
