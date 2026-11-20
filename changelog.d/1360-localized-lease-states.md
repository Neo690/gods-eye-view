- A router's lease export is read in the language it was written in. The
  localized lease state — `Dynamique`, `Statique`, `Dynamisch`, `dinamica`,
  `statica` and the accented or non-Latin spellings beside them — sits in the
  column where a host name would go, so an export from a French or German router
  used to arrive with `Dynamique` printed as the device's name. The state is now
  skipped, the real name in the next column is kept, and a row that carries only
  the state arrives with no name rather than a wrong one (Neo690, #1360).
