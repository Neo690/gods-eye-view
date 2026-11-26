- **Keep provider keys out of the uploaded live layer reports.** The gate records
  the request URLs it sees, and a proxy that puts a provider key in a query
  string would have published that key with the report artifact. Every string in
  a report now passes through `redactSecrets`, which replaces the value of each
  secret the canary knows and blanks any credential-named query parameter it does
  not.
