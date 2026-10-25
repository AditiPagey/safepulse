# SafePulse phone app (Dev A)

No installs needed except Node (v18+). No `npm install`.

## 1. Run it on your laptop
```
cd phone
node server.js
```
Open http://localhost:5173/?demo=1  (laptops have no motion sensor; use "Simulate shake")

## 2. Open it on your phone (needs https)
Install cloudflared once:
- Mac:     brew install cloudflared
- Windows: winget install --id Cloudflare.cloudflared

Keep `node server.js` running. In a SECOND terminal:
```
cloudflared tunnel --url http://localhost:5173
```
Open the printed https://....trycloudflare.com link on your phone, with `/?demo=1` at the end.

## 3. Switch to Dev B's real server (around 1:15)
1. `server.js` line 10: REAL_SERVER = 'https://dev-b-url-here'
2. `src/config.js`: FAKE = false
3. Stop `node server.js` (Ctrl+C) and start it again. On the phone: Reset app, sign up again.

## 4. Tune the shake detector (src/config.js, the C block)
Open ?demo=1 on the phone and watch the live graph while you shake:
- Hand shake doesn't trigger -> lower T_HIGH or MIN_SUSTAIN_MS
- Walking/handling triggers   -> raise T_HIGH or MIN_DUTY
Tests: `node test/detector.test.js` (7 synthetic signals from the plan, all pass)

## 5. Give to the team
- Dev B: the REPORT JSON line (phone: shown in console; or copy the example below)
- Final deploy: copy index.html, manifest.webmanifest and src/ into server/public/phone (no build step)

Example report:
{"report_id":"e554b8a8-...","user_id":"490f31df-...","event_ts":"2026-10-24T23:56:53.334Z",
 "lat":32.88,"lng":-117.23,"accuracy_m":15,"loc_source":"gps","score":0.68,"peak_g":1.13,
 "duration_ms":4912,"home_region":"sim-region"}

## Files
- server.js        serves the app + forwards /api to Dev B
- index.html       all 4 screens
- src/config.js    FAKE switch + detector settings
- src/api.js       the only file that talks to the server (fake mode inside)
- src/detector.js  shake detection + score (pure logic)
- src/sensor.js    phone motion sensor -> detector, input guard
- src/location.js  one GPS reading, 6 s timeout
- src/outbox.js    send queue with retries, survives reload
- src/main.js      screens, trigger flow, answers, polling, shelters, demo tools
