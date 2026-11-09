// api/analyst.js — AI reasoning layer for the GBM Observatory. Two modes:
//   mode "scan"     (default) — Command station: situation assessment over the system scan.
//   mode "bulletin"           — Early Warning station: a bilingual district bulletin for
//                               DC / UNO / PIO / DAE offices, written ONLY from the rule-based
//                               assessment the engine produced (the AI never sets the level).
// Calls Anthropic's Messages API server-side with ANTHROPIC_API_KEY (Vercel env var).
// The key never reaches the browser. Without a key it returns 501 so the page can explain.

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

function langLine(language) {
  return language === "bn"
    ? "Write the entire text in Bangla (formal administrative register used in district office circulars)."
    : language === "both"
      ? "Write the text in English first, then a faithful Bangla version (formal administrative register), separated by a line of ═ characters."
      : "Write the text in English.";
}

function scanPrompt(language) {
  return [
    "You are the duty analyst for the GBM Observatory, a public-data screening platform for the Ganges–Brahmaputra–Meghna river system in Bangladesh.",
    "You receive one system scan: sentinel points, each scored as a percentile against a 10-year same-season record. That scan is your ONLY evidence. Do not invent data, events, or current conditions beyond it; the scan timestamp is the 'now'.",
    "Write a concise operational assessment with exactly these sections:",
    "1. SYSTEM PICTURE — what pattern the sentinels form together (2-4 sentences; connect corridors: rain sentinels drive river sentinels with a lag of days; Meghalaya rain drives haors; headwater warmth drives Brahmaputra over 1-3 weeks).",
    "2. PRIORITY READ — what deserves attention first and why, referencing specific sentinel values.",
    "3. VERIFY — what must be checked against authoritative sources before acting (FFWC forecasts, BMD bulletins, BWDB gauges) and what specifically to look for.",
    "4. CAN WAIT — what is normal and needs no action now.",
    "5. CONFIDENCE — where the scan is thin, failed sentinels, and where percentiles alone could mislead (e.g., monsoon seasonality, proxy limitations noted in the labels).",
    "Rules: every recommendation names the owning agency (FFWC, BMD, BWDB, DDM, DPHE, DAE, DoE, district administration). If the data does not support a conclusion, say so plainly. You advise; FFWC and BMD hold operational authority — state this once at the end, in one sentence. No preamble, no flattery, under 450 words per language.",
    langLine(language)
  ].join("\n");
}

function bulletinPrompt(language) {
  return [
    "You draft a short early-warning bulletin for district and upazila officers in Bangladesh (Deputy Commissioner's office, UNO offices, Project Implementation Officer, Department of Agricultural Extension) taking part in the GBM Observatory early-warning PILOT.",
    "Your ONLY evidence is the JSON you receive: a rule-based assessment (level 0 Normal, 1 Watch, 2 Warning, 3 Severe) with its drivers — modelled river discharge compared with return-period thresholds, an upstream projection, GloFAS ensemble exceedance probabilities, and 3-day rainfall compared with local percentiles — plus a pilot checklist per role.",
    "Hard rules:",
    "- Never change, upgrade or downgrade the level. Report it exactly as given and explain which driver set it.",
    "- Never invent gauge readings in metres, danger-level figures, place names, dates or forecasts that are not in the JSON. Discharge is modelled (GloFAS), not a BWDB gauge reading — say 'modelled flow', not 'water level'.",
    "- Give times as dates from the JSON (validFor, expectedCrossing, startsOn). If no crossing date is given, do not make one up.",
    "- Actions come from the provided checklist for the current level; you may order and condense them, and tie each to the driver that motivates it. Do not add actions outside the checklist except 'verify with FFWC/BWDB'.",
    "- The level is pilot decision-support. The Flood Forecasting and Warning Centre (FFWC/BWDB) and BMD are the official warning authorities; the Department of Disaster Management (DDM) and the District Disaster Management Committee decide on response under the Standing Orders on Disaster. Say this in one sentence at the end.",
    "Format, plain text, no markdown headers, under 260 words per language:",
    "LINE 1: district — level name — one-line headline.",
    "WHAT THE DATA SHOWS: 2–3 sentences with the key numbers (ratio to the 2-year flow, ensemble probability, rain total vs. its threshold) and the lead time if given.",
    "NEXT 24–72 HOURS, BY OFFICE: one line each for DC office, UNO offices, PIO, DAE.",
    "CHECK BEFORE ACTING: what to confirm on FFWC's bulletin or the BWDB gauge, and where the data is thin.",
    langLine(language)
  ].join("\n");
}

async function callClaude(key, system, userText, maxTokens) {
  const base = { model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: userText }] };
  const send = body => fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body)
  });
  // Low effort keeps latency down for a short, constrained text. If an older model is configured
  // and rejects these fields, retry once with the plain request.
  let r = await send(Object.assign({ thinking: { type: "adaptive" }, output_config: { effort: "low" } }, base));
  let j = await r.json().catch(() => ({}));
  if (r.status === 400) { r = await send(base); j = await r.json().catch(() => ({})); }
  if (!r.ok) { const err = new Error((j && j.error && j.error.message) || ("upstream " + r.status)); err.status = r.status; throw err; }
  return (j.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
}

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(501).json({ error: "not_configured" }); return; }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== "object") { res.status(400).json({ error: "JSON body required" }); return; }
  const language = ["en", "bn", "both"].includes(body.language) ? body.language : "en";
  const mode = body.mode === "bulletin" ? "bulletin" : "scan";

  try {
    if (mode === "bulletin") {
      const a = body.assessment;
      if (!a || typeof a !== "object" || !Array.isArray(a.drivers) || a.drivers.length > 40) {
        res.status(400).json({ error: "expected {mode:'bulletin', assessment:{district, level, drivers[]}, checklist, language}" }); return;
      }
      const payload = JSON.stringify({ assessment: a, checklist: body.checklist || null }).slice(0, 60000);
      const text = await callClaude(key, bulletinPrompt(language), "Assessment JSON:\n" + payload, 3000);
      res.status(200).json({ text, model: MODEL, mode });
      return;
    }
    const scan = body.scan;
    if (!scan || !Array.isArray(scan.results) || scan.results.length > 40) {
      res.status(400).json({ error: "expected {scan:{at,results[]}, language}" }); return;
    }
    const text = await callClaude(key, scanPrompt(language), "System scan JSON:\n" + JSON.stringify(scan).slice(0, 60000), 4000);
    res.status(200).json({ text, model: MODEL, mode });
  } catch (err) {
    res.status(502).json({ error: String((err && err.message) || err) });
  }
};
