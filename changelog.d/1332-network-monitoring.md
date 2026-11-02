- Put the **operator's own nodes on the globe**. `GEV_NETMON_TARGETS` names the
  hosts and ports this server may probe — label, host, port and the operator's
  declared position, never one guessed from a hostname — and the server answers
  them with one plain TCP connect per round, no payload sent, cached so browser
  polls never multiply probes. The new Network Monitor layer draws each placed
  target at its declared position: green when a connection was accepted, red
  when it was refused or timed out, with the round's age on the layer row and a
  staleness badge once that round grows old. Unpositioned targets are still
  probed and counted in the attribution, and with nothing configured the layer
  row explains the next step instead of failing silently (yourname, #1332).
