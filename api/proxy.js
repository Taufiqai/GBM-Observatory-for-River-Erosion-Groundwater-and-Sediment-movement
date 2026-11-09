// api/proxy.js — CORS relay for read-only public data endpoints that don't send browser-friendly
// CORS headers (e.g. NOAA ERDDAP behind a government WAF, FFWC/BWDB feeds).
// Used by the Coastal station (IBTrACS cyclone tracks) and the Bridge station's feed importer.
// GET only; no credentials, no request body, no header passthrough; restricted to public
// data hosts so the deployment cannot be used as an open relay.

const ALLOWED_SUFFIXES = [
  ".gov.bd", ".noaa.gov", ".nasa.gov", ".usgs.gov", ".open-meteo.com", ".googleapis.com",
  ".icimod.org", ".reliefweb.int", ".gdacs.org", ".copernicus.eu", ".ecmwf.int", ".wmo.int"
];
const ALLOWED_EXACT = new Set(["reliefweb.int", "gdacs.org", "api.reliefweb.int"]);

function hostAllowed(h) {
  h = String(h || "").toLowerCase();
  if (!h || /^[\d.]+$/.test(h) || h.includes(":")) return false; // no raw IPs
  return ALLOWED_EXACT.has(h) || ALLOWED_SUFFIXES.some(s => h.endsWith(s) || h === s.slice(1));
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ error: "GET only" }); return; }

  const target = req.query && req.query.url;
  if (!target || typeof target !== "string" || target.length > 8000) { res.status(400).json({ error: "Missing ?url= parameter" }); return; }
  let parsed;
  try { parsed = new URL(target); } catch (e) { res.status(400).json({ error: "Invalid URL" }); return; }
  if (!["http:", "https:"].includes(parsed.protocol)) { res.status(400).json({ error: "Only http/https allowed" }); return; }
  if (!hostAllowed(parsed.hostname)) {
    res.status(403).json({ error: "Host not on the public-data allow-list", host: parsed.hostname, allowed: ALLOWED_SUFFIXES });
    return;
  }
  try {
    const upstream = await fetch(parsed.toString(), { headers: { "User-Agent": "gbm-observatory-proxy/1.1" }, redirect: "follow" });
    const finalHost = new URL(upstream.url || parsed.toString()).hostname;
    if (!hostAllowed(finalHost)) { res.status(403).json({ error: "Redirected off the allow-list", host: finalHost }); return; }
    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.length > 4 * 1024 * 1024) { res.status(413).json({ error: "Upstream response larger than 4 MB" }); return; }
    res.status(upstream.status);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", upstream.ok ? "public, s-maxage=300, max-age=300" : "no-store");
    res.send(body);
  } catch (err) {
    res.status(502).json({ error: "Upstream fetch failed", detail: String(err) });
  }
};
