// Same-origin proxy for Open-Meteo — defeats ISP-level blocking of the API domains.
// The browser calls /api/om?u=<encoded open-meteo url>; Vercel's server fetches it.
export default async function handler(req, res) {
  const u = req.query.u;
  try {
    const url = new URL(u);
    const allowed = [
      "archive-api.open-meteo.com",
      "api.open-meteo.com",
      "flood-api.open-meteo.com",
      "marine-api.open-meteo.com"
    ];
    if (!allowed.includes(url.hostname)) {
      res.status(400).json({ error: "host not allowed" });
      return;
    }
    const r = await fetch(url.toString());
    const j = await r.json();
    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(r.ok ? 200 : r.status).json(j);
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}
