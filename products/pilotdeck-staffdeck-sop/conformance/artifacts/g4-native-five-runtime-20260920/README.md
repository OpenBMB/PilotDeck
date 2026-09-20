# G4 native-five runtime artifact

This directory is the durable, sanitized copy of the completed G4 runtime
record. The source run directory was `/tmp/pilotdeck-g4-runtime-20260920`;
temporary containers, network, and credentials were not retained.

The result covers clean exported-artifact startup, external Knowledge and SOP
health, Knowledge restart/query recovery, PilotDeck restart with a persisted
SOP wait, SOP outage/recovery without a false state advance, and one durable
manual compaction boundary. Provider URLs, API keys, and database contents are
not included.
