# Demo script (4-5 min). Setup: dashboard open, "Show simulated" ON, DEMO_MODE (timeout 60 s), hotspot ready.
Env: `export SIM_KEY=... DEFAULT_CENTER=lat,lng` · base = deployed URL.
| Time | Action | Command / cue |
|---|---|---|
| 0:00 | Explain panels: events, map, detail | |
| 0:30 | **Dev A shakes the real phone** → prompt, one grey hollow dot, no incident | cue Dev A at 0:25 |
| 1:15 | Accident incident pops up with pulse + toast | `npm run sim -- bus --base $URL` |
| 2:00 | Disaster incident, counts climb | `npm run sim -- quake --base $URL` |
| 2:45 | Answer safe on phone; sim answers land; unanswered fall to No response (60 s) | open No response tab |
| 3:30 | Send shelters; phone shows list | Safe tab → button |
| 4:00 | Resolve (409 → force), History, frozen banner, Export CSV | |
Extras if time: `noise` (dots that never promote), `late` (Late badge), `nolocation` (Approx badges + dashed circles).
**Backup:** record a full run by 2:30. Last resort: `npm run mock` + dashboard only.
