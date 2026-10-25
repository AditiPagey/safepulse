# Q&A prep
| Question | Answer |
|---|---|
| False alarms? | Sustained-pattern check, cooldown guards; one report never makes an incident, counts across people do |
| Privacy? | Sensing on device, one location reading at impact, consent at signup, staff-only access, kept as incident history |
| Battery? | Sensor runs only while app is open; roadmap: low-power background sensing |
| Scale? | Reports are tiny; grouping is an indexed query; per-incident tables are self-contained |
| Why not call emergency services? | People can't always call; we give automatic triage and find those who don't answer |
| No internet? | Roadmap: SMS and phone-to-phone relay; local prompt works offline |
| Spam? | Per-user dedupe, rate limiting, multi-user thresholds |
| Retention? | Incident history; retention is configuration (e.g. one year) |
| Existing alert systems? | Similar sensing exists; we add the check-in loop, search list, shelter routing, small-incident coverage (verify before claiming specifics) |
| Limitation? | Prototype senses only while app is open; background needs a native app |
