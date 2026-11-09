// api/hindcast.js — retrospective verification of the early-warning rules.
// GET /api/hindcast?district=sirajganj[&base=1995-2014][&from=2016-01-01][&to=2024-12-31]
// 1. fit thresholds on the calibration years only (default 1995–2014)
// 2. run the observed-state rules day by day over the verification years (default 2016–2024)
// 3. score against the documented events in ew-events.json (POD, lead time, warning episodes)
// 4. score a calendar reference ("warn throughout the usual peak season") the same way
// The verification years never touch the thresholds, so this is an out-of-sample test.

const W = require("../warn-engine.js");
const CATALOGUE = require("../ew-events.json");

function parseBase(s) {
  const m = /^(\d{4})-(\d{4})$/.exec(String(s || ""));
  return m ? [+m[1], +m[2]] : [1995, 2014];
}
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const id = req.query && req.query.district;
  if (!W.DISTRICTS[id]) { res.status(400).json({ error: "?district= one of " + Object.keys(W.DISTRICTS).join(", ") }); return; }
  const [b0, b1] = parseBase(req.query.base);
  const from = isDate(req.query.from) ? req.query.from : "2016-01-01";
  const to = isDate(req.query.to) ? req.query.to : "2024-12-31";
  if (b1 >= +from.slice(0, 4)) { res.status(400).json({ error: "calibration years must end before the verification period starts" }); return; }
  try {
    const t0 = Date.now();
    const inputs = await W.fetchHistory(id, b0 + "-01-01", to, fetch);
    const model = W.calibrate(id, inputs, b0, b1);
    const daily = W.hindcast(model, inputs, from, to);
    const events = (CATALOGUE.events[id] || []);
    const eventsA = events.filter(e => e.quality === "A");
    const ref = W.calendarReference(model, daily.map(d => d.date));
    const score = (dl, ev, lvl) => { const v = W.verify(dl, ev, { minLevel: lvl }); delete v.episodeList; return v; };
    const result = {
      district: id, engine: W.VERSION, rules: W.RULES.id,
      calibration: [b0, b1], verification: [from, to],
      thresholds: { rp: model.rp, rain: model.rain, links: model.links },
      modelWarnings: model.warnings,
      points: inputs.meta,
      coverage: Object.fromEntries(Object.entries(inputs.series).map(([k, v]) => [k, +(v.filter(x => x != null).length / v.length).toFixed(3)])),
      scores: {
        watch: score(daily, events, 1),
        warning: score(daily, events, 2),
        severe: score(daily, events, 3),
        watchQualityA: score(daily, eventsA, 1),
        calendarReference: score(ref, events, 1)
      },
      episodes: { watch: W.verify(daily, events, { minLevel: 1 }).episodeList, warning: W.verify(daily, events, { minLevel: 2 }).episodeList },
      triggers: daily.reduce((o, d) => { if (d.by) o[d.by] = (o[d.by] || 0) + 1; return o; }, {}),
      daily: { start: daily.length ? daily[0].date : null, levels: daily.map(d => (d.level == null ? "-" : String(d.level))).join("") },
      seconds: (Date.now() - t0) / 1000
    };
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    res.status(200).json(result);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
