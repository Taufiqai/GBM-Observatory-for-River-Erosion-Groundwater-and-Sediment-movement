// api/om.js — same-origin relay for Open-Meteo (flood, archive, forecast, marine).
// Why: some Bangladeshi ISPs block or throttle *.open-meteo.com. The dashboard first calls
// Open-Meteo directly and, if that fails, retries here (see the fetch wrapper in index.html).
// GET only, fixed host allow-list, no headers forwarded, responses cached at the edge.

const ALLOWED = new Set([
  "archive-api.open-meteo.com",
  "api.open-meteo.com",
  "flood-api.open-meteo.com",
  "marine-api.open-meteo.com",
  "ensemble-api.open-meteo.com",
  "air-quality-api.open-meteo.com"
]);

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS"); res.status(204).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ error: "GET only" }); return; }
  const u = req.query && req.query.u;
  if (!u || typeof u !== "string" || u.length > 8000) { res.status(400).json({ error: "missing or oversized ?u=" }); return; }
  let url;
  try { url = new URL(u); } catch (e) { res.status(400).json({ error: "invalid URL" }); return; }
  if (url.protocol !== "https:" || !ALLOWED.has(url.hostname)) { res.status(400).json({ error: "host not allowed" }); return; }
  try {
    const r = await fetch(url.toString(), { headers: { "User-Agent": "gbm-observatory/1.0 (+https://gbmobservatory.vercel.app)" } });
    const text = await r.text();
    res.status(r.status);
    res.setHeader("Content-Type", r.headers.get("content-type") || "application/json");
    // historical requests change rarely; forecasts every few hours
    const historical = /archive-api|start_date=19|start_date=200/.test(url.toString()) && !/forecast_days|past_days/.test(url.toString());
    res.setHeader("Cache-Control", r.ok ? (historical ? "public, s-maxage=86400, stale-while-revalidate=604800" : "public, s-maxage=1800, stale-while-revalidate=3600") : "no-store");
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: "upstream fetch failed", detail: String((e && e.message) || e) });
  }
};
