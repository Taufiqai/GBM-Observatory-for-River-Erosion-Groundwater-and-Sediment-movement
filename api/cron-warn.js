// api/cron-warn.js — daily pilot log (Vercel Cron, 01:00 UTC = 07:00 Dhaka).
// Computes today's assessment for every pilot district and writes it to Blob storage as
// pilot/warnings/YYYY-MM-DD.json. This file series IS the prospective record the pilot
// evaluation scores at the end of the season: what the system said, on which day, before
// anyone knew the outcome. Without a Blob store it still runs and says logged:false.

const W = require("../warn-engine.js");
const store = require("./_store.js");
const { assessAll } = require("./warn.js");

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== "Bearer " + secret) { res.status(401).json({ error: "unauthorized" }); return; }
  const today = new Date().toISOString().slice(0, 10);
  const districts = await assessAll(Object.keys(W.DISTRICTS), today);
  // keep the log compact: level, drivers without the ensemble band arrays
  const compact = {};
  for (const [k, a] of Object.entries(districts)) {
    compact[k] = a.error ? { error: a.error } : {
      level: a.level, earliestLeadDays: a.earliestLeadDays, ensemble: a.ensemble,
      drivers: a.drivers.map(d => { const c = Object.assign({}, d); delete c.band; return c; }),
      thresholds: a.thresholds, calibration: a.calibration
    };
  }
  const record = { date: today, generated: new Date().toISOString(), engine: W.VERSION, rules: W.RULES.id, districts: compact };
  let logged = false, reason = null;
  if (store.configured()) {
    try { await store.putJSON("pilot/warnings/" + today + ".json", record, { overwrite: true }); logged = true; }
    catch (e) { reason = String((e && e.message) || e); }
  } else reason = "storage_not_configured";
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ logged, reason, date: today, levels: Object.fromEntries(Object.entries(compact).map(([k, v]) => [k, v.level == null ? null : v.level])) });
};
