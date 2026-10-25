# SafePulse Dev C: dashboard, mock, simulator, pitch
```
npm i
npm run mock                      # mock dept API on :8081 (key dev-dept-key)
cp dashboard/.env.example dashboard/.env && API_TARGET=http://localhost:8081 npm run dev
SIM_KEY=... npm run sim -- bus --base http://localhost:8080 --seed 1
npm run build                     # -> server/public/dashboard
```
Random answers: `npm run sim -- quake --mix 50,20,30` = 50% safe, 20% help, 30% never answer (use `--seed N` to repeat a run).

Mixed simulation (equal accidents and lone signals): `npm run sim -- mixed --n 6 --every 60`. In the dashboard, ▶ Start simulation / Clear work against the mock only.
Dashboard shows simulated data by default for now; set `VITE_SHOW_SIM=false` to hide it.

## Questions for Dev B (send by 1:00)
1. Settings shape assumed: `{timeout_seconds, accident:{radius_m,window_s,min_count,max_accuracy_m}, disaster:{...}}`.
2. List endpoints assumed wrapped: `/events` -> `{events:[]}`, `/inbox` -> `{items:[]}` (code also accepts bare arrays).
3. Inbox rows need `report_id, event_ts, lat, lng, accuracy_m, loc_source, is_sim`.
4. Event rows need `center, radius_m, counts, parent_event_id, is_sim, opened_at, first_signal_ts, resolved_at`.
5. Must `/api/answers` accept `X-Sim-Key` (sim users have no token)?
6. CORS: expose `X-Server-Time` if dashboard is served from another origin.
## Not built yet
Marker clustering (SVG circles are fine at ~300), heat layer, replay slider (on cut list).
