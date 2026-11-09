// api/pilot-data.js — evaluator export of the pilot logs.
// GET with header  x-admin-key: <PILOT_ADMIN_KEY>
//   ?type=feedback|warnings  (default feedback)   ?format=json|csv (default json)
// Disabled (501) until PILOT_ADMIN_KEY is set in the Vercel project.

const crypto = require("crypto");
const store = require("./_store.js");

function sameKey(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function toCSV(rows) {
  if (!rows.length) return "";
  const cols = [...rows.reduce((s, r) => { Object.keys(r).forEach(k => s.add(k)); return s; }, new Set())];
  const cell = v => { if (v == null) return ""; const s = typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(",")].concat(rows.map(r => cols.map(c => cell(r[c])).join(","))).join("\n");
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const adminKey = process.env.PILOT_ADMIN_KEY;
  if (!adminKey) { res.status(501).json({ error: "PILOT_ADMIN_KEY not set on this deployment" }); return; }
  if (!sameKey(req.headers["x-admin-key"], adminKey)) { res.status(401).json({ error: "unauthorized" }); return; }
  if (!store.configured()) { res.status(503).json({ error: "storage_not_configured" }); return; }
  const type = req.query.type === "warnings" ? "warnings" : "feedback";
  try {
    const blobs = await store.listAll("pilot/" + type + "/", 3000);
    const rows = [];
    for (const b of blobs) { const j = await store.readJSON(b); if (j) rows.push(j); }
    let flat = rows;
    if (type === "warnings") {
      flat = [];
      for (const r of rows) for (const [d, a] of Object.entries(r.districts || {})) {
        flat.push({ date: r.date, district: d, level: a.level, earliestLeadDays: a.earliestLeadDays, ensemble: a.ensemble,
          topDriver: a.drivers && a.drivers[0] ? a.drivers[0].kind + ":" + a.drivers[0].key : null, error: a.error || null, rules: r.rules });
      }
      flat.sort((a, b) => (a.date + a.district).localeCompare(b.date + b.district));
    } else flat.sort((a, b) => String(a.received).localeCompare(String(b.received)));
    if (req.query.format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=gbm-pilot-" + type + ".csv");
      res.status(200).send(toCSV(flat));
    } else res.status(200).json({ type, count: flat.length, rows: flat });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
