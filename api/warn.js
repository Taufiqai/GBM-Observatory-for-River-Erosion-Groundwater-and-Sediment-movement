// api/warn.js — live early-warning assessment for the pilot districts.
// GET /api/warn                 → all districts
// GET /api/warn?district=kurigram
// Same engine as the browser (warn-engine.js). Thresholds are re-fitted on the last 20
// complete years; the fitted model is kept in memory per instance and the response is
// cached at the edge for an hour, so many officers opening the page cost one computation.

const W = require("../warn-engine.js");

const _models = new Map(); // `${district}:${y0}-${y1}` → history inputs

async function assessDistrict(id, today) {
  const y1 = +today.slice(0, 4) - 1, y0 = y1 - 19;
  const ck = id + ":" + y0 + "-" + y1;
  let history = _models.get(ck);
  if (!history) {
    history = await W.fetchHistory(id, y0 + "-01-01", y1 + "-12-31", fetch);
    _models.set(ck, history);
  }
  return W.runLive(id, fetch, { today, history });
}

async function assessAll(ids, today) {
  const out = {};
  await Promise.all(ids.map(async id => {
    try { out[id] = await assessDistrict(id, today); }
    catch (e) { out[id] = { district: id, error: String((e && e.message) || e) }; }
  }));
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const q = (req.query && req.query.district) || "all";
  const ids = q === "all" ? Object.keys(W.DISTRICTS) : String(q).split(",").filter(k => W.DISTRICTS[k]);
  if (!ids.length) { res.status(400).json({ error: "unknown district", districts: Object.keys(W.DISTRICTS) }); return; }
  const today = new Date().toISOString().slice(0, 10);
  const districts = await assessAll(ids, today);
  const failed = Object.values(districts).filter(d => d.error).length;
  res.setHeader("Cache-Control", failed ? "no-store" : "public, s-maxage=3600, stale-while-revalidate=10800");
  res.status(failed === ids.length ? 502 : 200).json({
    generated: new Date().toISOString(), today, engine: W.VERSION, rules: W.RULES.id,
    notice: "Pilot decision-support. FFWC/BWDB and BMD are the official warning authorities.",
    districts
  });
};

module.exports.assessAll = assessAll;
