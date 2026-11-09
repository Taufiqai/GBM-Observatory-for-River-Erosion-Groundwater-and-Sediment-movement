// api/feedback.js — anonymous pilot responses from officers (feedback after a bulletin,
// tabletop-drill timings, actions taken). POST JSON; only whitelisted fields are kept and
// free text is scrubbed of phone numbers and e-mail addresses so the store holds no
// personal identifiers. Stored at pilot/feedback/YYYY-MM/<timestamp>.json in Vercel Blob.

const store = require("./_store.js");

const DISTRICTS = ["sirajganj", "kurigram", "sunamganj"];
const ROLES = ["dc", "uno", "pio", "dae", "bwdb", "other"];
const KINDS = ["bulletin", "drill", "action", "season"];
const YNU = ["yes", "no", "unsure", "planned"];

const clampInt = (x, lo, hi) => { const n = Math.round(Number(x)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
const pick = (x, list) => (list.includes(x) ? x : null);
function scrub(t, max) {
  return String(t || "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email removed]")
    .replace(/(\+?88)?[\s-]?0?1[3-9]\d{2}[\s-]?\d{3}[\s-]?\d{3}/g, "[phone removed]")
    .replace(/\b\d{9,}\b/g, "[number removed]")
    .slice(0, max);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  let b = req.body;
  if (typeof b === "string") { if (b.length > 6000) { res.status(413).json({ error: "too large" }); return; } try { b = JSON.parse(b); } catch (e) { b = null; } }
  if (!b || typeof b !== "object") { res.status(400).json({ error: "JSON body required" }); return; }
  const rec = {
    kind: pick(b.kind, KINDS) || "bulletin",
    district: pick(b.district, DISTRICTS),
    role: pick(b.role, ROLES) || "other",
    levelShown: clampInt(b.levelShown, 0, 3),
    assessmentDate: /^\d{4}-\d{2}-\d{2}$/.test(String(b.assessmentDate || "")) ? b.assessmentDate : null,
    clarity: clampInt(b.clarity, 1, 5),
    usefulness: clampInt(b.usefulness, 1, 5),
    trust: clampInt(b.trust, 1, 5),
    actedOn: pick(b.actedOn, YNU),
    leadEnough: pick(b.leadEnough, YNU),
    actions: Array.isArray(b.actions) ? b.actions.slice(0, 12).map(a => scrub(a, 60)) : [],
    minutesToDecision: clampInt(b.minutesToDecision, 0, 600),
    drillScenario: b.drillScenario ? scrub(b.drillScenario, 40) : null,
    drillDecisionCorrect: typeof b.drillDecisionCorrect === "boolean" ? b.drillDecisionCorrect : null,
    observedFlood: pick(b.observedFlood, YNU),
    comment: scrub(b.comment, 800),
    lang: pick(b.lang, ["en", "bn"]) || "en",
    received: new Date().toISOString(),
    engineRules: "EW-rules-v1"
  };
  if (!rec.district) { res.status(400).json({ error: "district must be one of " + DISTRICTS.join(", ") }); return; }
  if (!store.configured()) { res.status(503).json({ stored: false, reason: "storage_not_configured", record: rec }); return; }
  try {
    const month = rec.received.slice(0, 7);
    const name = "pilot/feedback/" + month + "/" + rec.received.replace(/[:.]/g, "-") + "-" + Math.random().toString(36).slice(2, 8) + ".json";
    await store.putJSON(name, rec, { random: false });
    res.status(200).json({ stored: true });
  } catch (e) {
    res.status(500).json({ stored: false, reason: String((e && e.message) || e), record: rec });
  }
};
