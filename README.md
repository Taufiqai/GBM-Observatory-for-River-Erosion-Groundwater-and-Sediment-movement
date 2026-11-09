# GBM Observatory

**Observing the Ganges-Brahmaputra-Meghna (GBM) Systems focusing Bangladesh**

Concept and Design: Md Taufiqul Islam, Joint Secretary to Bangladesh Government (taufiq28@gmail.com)

Live site: https://gbmobservatory.vercel.app

Twelve stations in one web app (`index.html`), plus a small set of Vercel serverless functions in `api/`.

| Station | What it does |
|---|---|
| Command | Whole-basin scan of sentinel points, rule-based action queue, AI situation assessment |
| **Early Warning (pilot)** | Flood warning levels and role checklists for Sirajganj, Kurigram and Sunamganj; bilingual bulletin; drill mode; hindcast track record; anonymous officer feedback |
| Headwater · Monsoon · Riverbank · Aquifer · Charland · Effluent · Coastal · Outlook · Confluence · Bridge | Monitoring stations for snowmelt, rainfall, erosion and flow, groundwater, silt, water quality, estuary and cyclones, ML outlook, cross-station interactions, institutional data |

## Early Warning pilot

An AI-assisted early-warning and decision aid for district and upazila officers (DC office, UNO offices, PIO, DAE). Pilot decision-support only: FFWC/BWDB and BMD remain the official warning authorities.

* **Engine** — `warn-engine.js`, one file used by both the browser and the functions. Rules `EW-rules-v1` were fixed before verification: modelled flow (GloFAS) against 2-, 5- and 20-year flood flows (Watch, Warning, Severe); log-linear upstream projection; 3-day rain against the 95th, 99th and 99.7th percentiles (Sunamganj); a GloFAS 50-member ensemble probability of 50% or more (live only).
* **Verification** — `api/hindcast.js` fits thresholds on 1995–2014 and scores 2016–2024 against `ew-events.json`, a catalogue of dated, sourced reports of rivers above danger level (with an audit of unmatched warnings). In that hindcast, Watch caught 6 of 8 documented floods in Sirajganj, 6 of 8 in Kurigram and 10 of 11 in Sunamganj, with a median of 2.5–3.5 days before the first report. Sunamganj's rain trigger also raised many unconfirmed Watch episodes. The full evaluation is a separate document.
* **AI** — `api/analyst.js` (`mode: "bulletin"`) asks Claude to rewrite the rule-based assessment for a given office. It may not change the level or invent figures, and the rule-based bulletin always works without it.
* **Pilot logging** — `api/cron-warn.js` runs daily at 07:00 Dhaka time and stores that day's assessment. This is the prospective record the season will be scored on. `api/feedback.js` stores anonymous feedback and drill results, and `api/pilot-data.js` exports them for the coordinator.

### One-time setup (Vercel project settings)

| Setting | Why | Without it |
|---|---|---|
| Storage → **Blob** store connected to the project (sets `BLOB_READ_WRITE_TOKEN`) | Daily warning log, feedback, drills | The station works; feedback is offered as a downloadable file and the daily log is not kept |
| `ANTHROPIC_API_KEY` | AI bulletin and Command-station analyst | Rule-based bulletin only |
| `ANTHROPIC_MODEL` (optional) | Override the model (default `claude-sonnet-5-5`) | Default model |
| `PILOT_ADMIN_KEY` | Lets the pilot coordinator export logs from the Early Warning station | Export disabled |
| `CRON_SECRET` (recommended) | Only Vercel Cron can trigger the daily log | Anyone can trigger an extra log run |

### Functions

| Path | Purpose |
|---|---|
| `/api/om` | Same-origin relay for Open-Meteo (some Bangladeshi networks block it). The page tries Open-Meteo directly first and falls back to this relay automatically |
| `/api/proxy` | CORS relay for public data hosts on an allow-list (`.gov.bd`, NOAA, NASA, …), used by the Coastal and Bridge stations |
| `/api/analyst` | Claude, server-side: Command assessment (`mode: "scan"`) and Early Warning bulletin (`mode: "bulletin"`) |
| `/api/warn` | Today's assessment for the pilot districts (edge-cached for 1 hour) |
| `/api/hindcast?district=…` | Retrospective verification. Optional, clearly labelled post-hoc sensitivity runs: `watchT=1.5`, `rainWatchP=0.97` |
| `/api/cron-warn` | Daily pilot log (Vercel Cron) |
| `/api/feedback` | Anonymous officer feedback and drill results (POST) |
| `/api/pilot-data` | Coordinator export, CSV or JSON (`x-admin-key` header) |

## Development

```bash
npm test          # unit tests for the early-warning engine (node --test)
```

There is no build step. Pushing to `main` deploys to production, and pushing any other branch gives a preview deployment.

## Mobile app (PWA)

`manifest.webmanifest`, `sw.js` and the icons make the site installable (Android: menu → Install app; iPhone: Share → Add to Home Screen). The service worker caches the app shell and the last early-warning assessment for offline viewing. Live data is always fetched fresh.
