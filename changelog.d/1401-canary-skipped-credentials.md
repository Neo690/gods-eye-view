- **Report the live layers a run skipped.** Keyed secret detection now reports
  which secret names are set, and the selection step turns them into runnable
  layers. Every keyed layer the run cannot exercise is listed in the job summary
  with its reason — including a half-configured pair such as `ACLED_EMAIL` set
  with `ACLED_PASSWORD` missing, which used to be skipped silently. Only names
  appear in that report; a value never does. A partial credential also raises a
  warning annotation.
