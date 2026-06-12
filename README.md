# GBM Observatory

**Monitoring River Erosion, Groundwater, and the Alluvion–Diluvion Cycle in the Ganges–Brahmaputra–Meghna System focusing Bangladesh**

Concept and Design: Md Taufiqul Islam, Joint Secretary to Bangladesh Government (taufiq28@gmail.com)

Five stations in one self-contained web app — no build step, no server code, no API keys:

| Station | What it does | Data |
|---|---|---|
| Riverbank | Bank-erosion risk, flow forecast, bankline imagery comparison | GloFAS (Open-Meteo), NASA GIBS HLS/VIIRS |
| Aquifer | Groundwater stress, recharge balance, GRACE storage anomaly | ERA5 (Open-Meteo), NASA GRACE via GIBS |
| Charland | Silt-pulse tracking, 25-year land time machine, computed alluvion–diluvion areas | GloFAS, NASA MODIS/HLS |
| Confluence | Cross-station analytics: falling-limb failure index, river–aquifer coupling, system scorecard | GloFAS × ERA5 |
| Bridge | Import institutional data (BWDB, WARPO, CEGIS, IWM, BIWTA): CSV series, GeoJSON layers, API connector, model validation | User-supplied, processed entirely in-browser |

---

## Deploy from GitHub through Vercel

1. **Create the repository.** On GitHub, create a new repository (e.g. `gbm-observatory`), then push this folder's contents to it:
   ```bash
   git init
   git add .
   git commit -m "GBM Observatory v2.1"
   git branch -M main
   git remote add origin https://github.com/<your-username>/gbm-observatory.git
   git push -u origin main
   ```
2. **Import to Vercel.** Sign in at vercel.com (the free Hobby plan is sufficient), choose **Add New → Project**, select the repository, leave **Framework Preset = Other**, leave build command and output directory **empty** (this is a pure static site), and press **Deploy**. The site is live in under a minute at `https://<project>.vercel.app`.
3. **Automatic updates.** Every `git push` to `main` redeploys automatically. Edits to `index.html` are the only thing ever needed.
4. **Custom domain (optional).** Project → Settings → Domains; Vercel issues HTTPS automatically. HTTPS matters: the service worker and "install app" features only activate on HTTPS (Vercel provides it by default).

Nothing else is required — there are no environment variables, no secrets, and no backend, because all data sources are free public APIs called directly from the visitor's browser.

## Mobile app (PWA — included and ready)

This package is already a **Progressive Web App**: `manifest.webmanifest`, `sw.js` (offline app-shell caching; live data always fetched fresh), and icons are wired into `index.html`. Once deployed on Vercel:

- **Android (Chrome):** visit the site → menu ⋮ → **Add to Home screen / Install app**. It installs with the GBM icon, runs full-screen, and appears in the app drawer like a native app.
- **iOS (Safari):** Share → **Add to Home Screen**.
- The interface is responsive: below ~980 px the panels stack into a single column suited to phones.

### Publishing to the app stores (optional next step)

- **Google Play:** wrap the deployed URL as a Trusted Web Activity with **Bubblewrap** (`npm i -g @bubblewrap/cli`, then `bubblewrap init --manifest https://<your-site>/manifest.webmanifest` and `bubblewrap build`). This produces a signed AAB for the Play Console (one-time $25 developer fee). The app remains this website — every dashboard update ships instantly without store review.
- **Apple App Store:** Apple does not accept bare TWAs; wrap with **Capacitor** (`npm i @capacitor/core @capacitor/ios`, point the webDir at this folder or use a remote URL config), open in Xcode, and submit ($99/year). Review tends to expect some native value-add; the PWA route via Safari is the zero-friction alternative.
- **Government distribution:** for official use, the simplest robust path is the Vercel URL plus PWA installation, optionally behind your organization's domain — no store gatekeeping, instant updates, works on every platform.


## Automatic feeds (Google Flood Hub · FFWC · NASA SWOT)

The Bridge station's **Automatic feeds** panel continuously harvests external forecast and observation sources (refresh every 30 minutes while open):

- **Google Flood Hub** — the AI gauge-forecast system (Nearing et al., 2024, *Nature*) covering FFWC-partnered Bangladesh gauges. Requires a free API key from Google's Flood Forecasting API program; apply the preset, paste your keyed request URL, map the JSON fields.
- **FFWC / BWDB** — official observed levels. FFWC's server doesn't send CORS headers, so the dashboard automatically retries through this repository's **`api/proxy.js`** serverless function (domain-allowlisted; deployed automatically by Vercel — no configuration needed).
- **NASA SWOT** — satellite-measured river water-surface elevation via PO.DAAC's public **Hydrocron** API (no login). Apply the preset and substitute a SWORD `reach_id` for your river segment.

Any other JSON endpoint works through the same panel (dot-path field mapping, e.g. `properties.wse`). Fetched feeds load as the observed series and can be validated against GloFAS/ERA5 with one click.

## The Bridge station (institutional data)

BWDB, WARPO, CEGIS, IWM and BIWTA data is integrated through the **Bridge** tab: load CSV time series (gauge levels, well records, model output), overlay GeoJSON layers (erosion-prediction lines, embankments, navigation routes), or connect a JSON API endpoint when one exists. All processing is client-side — institutional data never leaves the user's machine, preserving data-sharing agreements. The companion handbook's Part V details formats, workflows, and the validation methodology.

## Notes

- Data sources: Open-Meteo (GloFAS & ERA5; CC-BY 4.0 attribution appreciated), NASA GIBS/Worldview imagery services, Esri World Imagery basemap. All free for this use; keep the in-app attributions intact.
- All indices are screening heuristics; consult the handbook for interpretation and limits, and official sources (BWDB/FFWC, CGWB, CEGIS, DLRS) for decisions.
