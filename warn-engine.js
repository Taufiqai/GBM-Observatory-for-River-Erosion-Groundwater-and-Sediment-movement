/* warn-engine.js — GBM Observatory · Early Warning engine (pilot)
 * One file, used in two places:
 *   • the browser (Early Warning station)            → window.GBMWarn
 *   • the Vercel functions (/api/warn, /api/hindcast, /api/cron-warn) → require("../warn-engine.js")
 * Keeping one engine means the dashboard, the daily log and the verification all apply
 * the same pre-registered rules. Nothing here talks to a server except through the fetch
 * function you pass in.
 *
 * Rules (EW-rules-v1, fixed before verification — see RULES):
 *   river level   discharge vs model-climate return periods (Gumbel on annual maxima)
 *                 ≥Q2 Watch · ≥Q5 Warning · ≥Q20 Severe            (GloFAS alert convention)
 *   upstream      log-linear projection from an upstream point at the best lag (1–7 d)
 *   flash (rain)  3-day rain total vs all-days percentiles of the calibration period
 *                 ≥P95 Watch · ≥P99 Warning · ≥P99.7 Severe
 *   live only     GloFAS ensemble: P(exceed Q20)≥0.5 Severe · P(Q5)≥0.5 Warning · P(Q2)≥0.5 Watch
 *                 forecast 3-day rain (flash districts) scored on the rain ladder
 *   district level = the highest level among its drivers.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GBMWarn = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const VERSION = "1.0.0";
  const RULES = {
    id: "EW-rules-v1",
    fixed: "2026-11-09",
    riverLadder: { watch: "Q2", warning: "Q5", severe: "Q20" },
    rainLadder: { watch: "P95", warning: "P99", severe: "P99.7" },
    ensembleProb: 0.5,
    ensembleHorizonDays: 10,
    rainWindowDays: 3,
    lagRange: [1, 7],
    linkMonths: [6, 7, 8, 9],
    minYearDays: 300
  };

  const LEVELS = [
    { k: 0, key: "normal",  en: "Normal",  bn: "স্বাভাবিক", cls: "r-low",  color: "#0F766E" },
    { k: 1, key: "watch",   en: "Watch",   bn: "সতর্ক নজর", cls: "r-mod",  color: "#8A5A00" },
    { k: 2, key: "warning", en: "Warning", bn: "প্রস্তুতি",  cls: "r-elev", color: "#B43A0B" },
    { k: 3, key: "severe",  en: "Severe",  bn: "জরুরি",     cls: "r-high", color: "#9F1239" }
  ];

  /* ---- pilot districts --------------------------------------------------------------
   * snap: half-width (degrees) of the search box used to find the main-channel GloFAS cell
   * (largest mean monsoon discharge). 0 = use the coordinate as given (small rivers that
   * sit next to a big one — snapping would jump channel).                               */
  const DISTRICTS = {
    sirajganj: {
      id: "sirajganj", en: "Sirajganj", bn: "সিরাজগঞ্জ", type: "riverine", center: [24.45, 89.70],
      upazilas: "Sirajganj Sadar, Kazipur, Belkuchi, Chauhali, Shahjadpur",
      targets: [
        { key: "q_jamuna_sir", en: "Jamuna at Sirajganj", bn: "সিরাজগঞ্জে যমুনা", lat: 24.45, lon: 89.70, snap: 0.1 }
      ],
      upstream: [
        { key: "q_jamuna_bah", for: "q_jamuna_sir", en: "Jamuna at Bahadurabad", bn: "বাহাদুরাবাদে যমুনা", lat: 25.18, lon: 89.67, snap: 0.1 }
      ],
      rain: []
    },
    kurigram: {
      id: "kurigram", en: "Kurigram", bn: "কুড়িগ্রাম", type: "riverine", center: [25.81, 89.64],
      upazilas: "Kurigram Sadar, Chilmari, Ulipur, Roumari, Rajibpur, Nageshwari",
      targets: [
        { key: "q_brahm_chil", en: "Brahmaputra at Chilmari", bn: "চিলমারীতে ব্রহ্মপুত্র", lat: 25.56, lon: 89.68, snap: 0.1 },
        { key: "q_dharla_kur", en: "Dharla at Kurigram", bn: "কুড়িগ্রামে ধরলা", lat: 25.82, lon: 89.64, snap: 0 }
      ],
      upstream: [
        { key: "q_brahm_dhub", for: "q_brahm_chil", en: "Brahmaputra at Dhubri (India)", bn: "ধুবড়িতে ব্রহ্মপুত্র (ভারত)", lat: 26.02, lon: 89.97, snap: 0.1 }
      ],
      rain: []
    },
    sunamganj: {
      id: "sunamganj", en: "Sunamganj", bn: "সুনামগঞ্জ", type: "flash", center: [25.07, 91.40],
      upazilas: "Sunamganj Sadar, Tahirpur, Dharmapasha, Jamalganj, Chhatak, Dowarabazar",
      targets: [
        { key: "q_surma_sun", en: "Surma at Sunamganj", bn: "সুনামগঞ্জে সুরমা", lat: 25.07, lon: 91.40, snap: 0.05 }
      ],
      upstream: [
        { key: "q_surma_kan", for: "q_surma_sun", en: "Surma at Kanaighat", bn: "কানাইঘাটে সুরমা", lat: 25.00, lon: 92.26, snap: 0.05 }
      ],
      rain: [
        { key: "r_cherra", en: "Meghalaya slope (Cherrapunji)", bn: "মেঘালয় ঢাল (চেরাপুঞ্জি)", lat: 25.27, lon: 91.73 },
        { key: "r_sunam",  en: "Sunamganj haor rain", bn: "সুনামগঞ্জ হাওরের বৃষ্টি", lat: 25.07, lon: 91.40 }
      ]
    }
  };

  /* ---- small numeric helpers -------------------------------------------------------- */
  const isNum = x => typeof x === "number" && isFinite(x);
  const d8 = d => d.toISOString().slice(0, 10);
  const parseD = s => new Date(s + "T00:00:00Z");
  const addDays = (s, n) => d8(new Date(parseD(s).getTime() + n * 864e5));
  const dayDiff = (a, b) => Math.round((parseD(b) - parseD(a)) / 864e5); // b - a in days
  const yearOf = s => +s.slice(0, 4);
  const monthOf = s => +s.slice(5, 7);

  function quantile(sorted, p) {
    if (!sorted.length) return null;
    const h = (sorted.length - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
  }
  function mean(a) { let s = 0, n = 0; for (const x of a) if (isNum(x)) { s += x; n++; } return n ? s / n : null; }
  function sd(a) {
    const m = mean(a); if (m == null) return null;
    let s = 0, n = 0; for (const x of a) if (isNum(x)) { s += (x - m) * (x - m); n++; }
    return n > 1 ? Math.sqrt(s / (n - 1)) : null;
  }
  function median(a) { const s = a.filter(isNum).sort((x, y) => x - y); return quantile(s, 0.5); }

  /* rolling sum over n days ending at i; null if more than 1 of the n values missing */
  function rollingSum(v, n) {
    const out = new Array(v.length).fill(null);
    for (let i = n - 1; i < v.length; i++) {
      let s = 0, miss = 0;
      for (let k = i - n + 1; k <= i; k++) { if (isNum(v[k])) s += v[k]; else miss++; }
      if (miss <= Math.floor(n / 3)) out[i] = s;
    }
    return out;
  }

  /* ---- statistics ------------------------------------------------------------------- */
  function annualMaxima(dates, v, y0, y1) {
    const by = new Map();
    for (let i = 0; i < dates.length; i++) {
      const y = yearOf(dates[i]); if (y < y0 || y > y1 || !isNum(v[i])) continue;
      const o = by.get(y) || { year: y, max: -Infinity, n: 0, at: null };
      o.n++; if (v[i] > o.max) { o.max = v[i]; o.at = dates[i]; }
      by.set(y, o);
    }
    return [...by.values()].filter(o => o.n >= RULES.minYearDays).sort((a, b) => a.year - b.year);
  }
  /* Gumbel (EV1) by the method of moments: β = s·√6/π, μ = x̄ − 0.5772β, Q_T = μ − β·ln(−ln(1−1/T)) */
  function gumbelFit(maxima) {
    const xs = maxima.map(o => o.max);
    if (xs.length < 8) return null;
    const m = mean(xs), s = sd(xs);
    const beta = s * Math.sqrt(6) / Math.PI, mu = m - 0.5772156649 * beta;
    return { mu, beta, n: xs.length, q: T => mu - beta * Math.log(-Math.log(1 - 1 / T)) };
  }
  function returnPeriods(dates, v, y0, y1) {
    const am = annualMaxima(dates, v, y0, y1);
    const g = gumbelFit(am);
    if (!g) return null;
    const doys = am.map(o => { const d = parseD(o.at); return Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5); });
    return {
      Q2: g.q(2), Q5: g.q(5), Q20: g.q(20), mu: g.mu, beta: g.beta, nYears: g.n,
      years: [am[0].year, am[am.length - 1].year],
      peakDoyMedian: Math.round(median(doys))
    };
  }
  function rainThresholds(dates, v, y0, y1, win, pWatch) {
    const r = rollingSum(v, win || RULES.rainWindowDays);
    const pool = [];
    for (let i = 0; i < dates.length; i++) { const y = yearOf(dates[i]); if (y >= y0 && y <= y1 && isNum(r[i])) pool.push(r[i]); }
    if (pool.length < 365 * 5) return null;
    pool.sort((a, b) => a - b);
    return { P95: quantile(pool, pWatch || 0.95), P99: quantile(pool, 0.99), P997: quantile(pool, 0.997), n: pool.length, window: win || RULES.rainWindowDays };
  }
  /* upstream → downstream link: choose lag L in [1,7] maximising r of ln(up_t) vs ln(down_{t+L})
     over monsoon months of the calibration years, then OLS in log space. */
  function fitLink(dates, up, down, y0, y1) {
    let best = null;
    for (let L = RULES.lagRange[0]; L <= RULES.lagRange[1]; L++) {
      const xs = [], ys = [];
      for (let i = 0; i + L < dates.length; i++) {
        const y = yearOf(dates[i]); if (y < y0 || y > y1) continue;
        if (!RULES.linkMonths.includes(monthOf(dates[i]))) continue;
        const a = up[i], b = down[i + L];
        if (isNum(a) && isNum(b) && a > 0 && b > 0) { xs.push(Math.log(a)); ys.push(Math.log(b)); }
      }
      if (xs.length < 200) continue;
      const mx = mean(xs), my = mean(ys);
      let sxy = 0, sxx = 0, syy = 0;
      for (let k = 0; k < xs.length; k++) { sxy += (xs[k] - mx) * (ys[k] - my); sxx += (xs[k] - mx) ** 2; syy += (ys[k] - my) ** 2; }
      if (!sxx || !syy) continue;
      const r = sxy / Math.sqrt(sxx * syy), b = sxy / sxx, a = my - b * mx;
      // residual sd in log space → used to say how uncertain a projection is
      let ss = 0; for (let k = 0; k < xs.length; k++) ss += (ys[k] - (a + b * xs[k])) ** 2;
      const se = Math.sqrt(ss / Math.max(1, xs.length - 2));
      if (!best || r > best.r + 1e-9) best = { lag: L, r, a, b, se, n: xs.length };
    }
    return best;
  }

  /* ---- levels ------------------------------------------------------------------------ */
  function levelOfQ(q, rp) {
    if (!isNum(q) || !rp) return null;
    if (q >= rp.Q20) return 3; if (q >= rp.Q5) return 2; if (q >= rp.Q2) return 1; return 0;
  }
  function levelOfRain(r, rt) {
    if (!isNum(r) || !rt) return null;
    if (r >= rt.P997) return 3; if (r >= rt.P99) return 2; if (r >= rt.P95) return 1; return 0;
  }

  /* ---- calibration ------------------------------------------------------------------- */
  /* inputs: { dates:[YYYY-MM-DD], series:{key:[number|null]}, meta:{key:{...}} } */
  function calibrate(districtId, inputs, y0, y1) {
    const D = DISTRICTS[districtId]; if (!D) throw new Error("unknown district " + districtId);
    const m = { district: districtId, rules: RULES.id, version: VERSION, calibration: [y0, y1], rp: {}, links: [], rain: {}, warnings: [] };
    for (const t of D.targets) {
      const rp = returnPeriods(inputs.dates, inputs.series[t.key] || [], y0, y1);
      if (rp) m.rp[t.key] = rp; else m.warnings.push("not enough data to fit return periods for " + t.en);
    }
    for (const u of D.upstream) {
      const ln = fitLink(inputs.dates, inputs.series[u.key] || [], inputs.series[u.for] || [], y0, y1);
      if (ln && ln.r >= 0.6) m.links.push(Object.assign({ key: u.key, for: u.for }, ln));
      else m.warnings.push("upstream link " + u.en + " → not used (" + (ln ? "r=" + ln.r.toFixed(2) : "insufficient data") + ")");
    }
    for (const r of D.rain) {
      const rt = rainThresholds(inputs.dates, inputs.series[r.key] || [], y0, y1);
      if (rt) m.rain[r.key] = rt; else m.warnings.push("not enough rain data for " + r.en);
    }
    return m;
  }

  /* ---- assessment on day index i (observed state only — what a hindcast can test) ---- */
  function assessIndex(model, inputs, i, rain3Cache) {
    const D = DISTRICTS[model.district];
    const drivers = [];
    for (const t of D.targets) {
      const q = (inputs.series[t.key] || [])[i], rp = model.rp[t.key];
      const lv = levelOfQ(q, rp);
      if (lv != null) drivers.push({ kind: "river", key: t.key, en: t.en, bn: t.bn, value: q, unit: "m³/s", level: lv, ratioQ2: q / rp.Q2 });
    }
    for (const ln of model.links) {
      const up = (inputs.series[ln.key] || [])[i];
      if (!isNum(up) || up <= 0) continue;
      const qp = Math.exp(ln.a + ln.b * Math.log(up));
      const rp = model.rp[ln.for]; const lv = levelOfQ(qp, rp);
      const src = D.upstream.find(u => u.key === ln.key), dst = D.targets.find(t => t.key === ln.for);
      if (lv != null) drivers.push({ kind: "upstream", key: ln.key, for: ln.for, en: src.en + " → " + dst.en, bn: src.bn + " → " + dst.bn,
        value: qp, unit: "m³/s", level: lv, lagDays: ln.lag, validFor: addDays(inputs.dates[i], ln.lag), ratioQ2: qp / rp.Q2 });
    }
    for (const r of D.rain) {
      const rr = rain3Cache && rain3Cache[r.key] ? rain3Cache[r.key][i] : rollingSum((inputs.series[r.key] || []).slice(Math.max(0, i - 2), i + 1), 3).pop();
      const lv = levelOfRain(rr, model.rain[r.key]);
      if (lv != null) drivers.push({ kind: "rain", key: r.key, en: r.en + " · 3-day rain", bn: r.bn + " · ৩ দিনের বৃষ্টি", value: rr, unit: "mm", level: lv, ratioP95: rr / model.rain[r.key].P95 });
    }
    const level = drivers.length ? Math.max(...drivers.map(d => d.level)) : null;
    return { date: inputs.dates[i], level, drivers };
  }

  /* ---- hindcast over a date range ----------------------------------------------------- */
  function hindcast(model, inputs, from, to) {
    const D = DISTRICTS[model.district];
    const cache = {};
    for (const r of D.rain) cache[r.key] = rollingSum(inputs.series[r.key] || [], RULES.rainWindowDays);
    const out = [];
    for (let i = 0; i < inputs.dates.length; i++) {
      const s = inputs.dates[i]; if (s < from || s > to) continue;
      const a = assessIndex(model, inputs, i, cache);
      const top = a.drivers.length ? a.drivers.reduce((x, y) => (y.level > x.level ? y : x)) : null;
      out.push({ date: s, level: a.level, by: top && a.level > 0 ? top.kind : null });
    }
    return out;
  }

  /* reference forecast for skill comparison: a fixed calendar ("it's flood season") —
     Watch every day within ±30 days of the calibration-period median date of the annual peak */
  function calendarReference(model, dates) {
    const doys = Object.values(model.rp).map(rp => rp.peakDoyMedian).filter(isNum);
    return dates.map(s => {
      const d = parseD(s), doy = Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5);
      const on = doys.some(p => Math.min(Math.abs(doy - p), 365 - Math.abs(doy - p)) <= 30);
      return { date: s, level: on ? 1 : 0 };
    });
  }

  /* ---- verification ------------------------------------------------------------------ */
  function episodes(daily, minLevel, mergeGap) {
    const gap = mergeGap == null ? 5 : mergeGap;
    const eps = []; let cur = null;
    for (const d of daily) {
      const on = d.level != null && d.level >= minLevel;
      if (on) {
        if (cur && dayDiff(cur.end, d.date) <= gap + 1) { cur.end = d.date; cur.peak = Math.max(cur.peak, d.level); }
        else { cur = { start: d.date, end: d.date, peak: d.level }; eps.push(cur); }
      }
    }
    return eps;
  }
  /* events: [{id, date (first documented exceedance), until? (last documented), quality, audit?}]
     audit events (found by checking unmatched warnings afterwards) only re-classify warning
     episodes; they never count toward detection, so the audit cannot inflate the hit rate. */
  function verify(daily, events, opt) {
    const o = Object.assign({ minLevel: 1, pre: 7, post: 2, matchPre: 2, matchPost: 7, mergeGap: 5, leadCap: 21 }, opt || {});
    const byDate = new Map(daily.map(d => [d.date, d]));
    const first = daily.length ? daily[0].date : null, last = daily.length ? daily[daily.length - 1].date : null;
    const evAll = events.filter(e => first && e.date >= first && e.date <= last);
    const evIn = evAll.filter(e => !e.audit);
    const eps = episodes(daily, o.minLevel, o.mergeGap);
    const per = evIn.map(e => {
      const until = e.until || e.date;
      let firstOn = null;
      for (let k = -o.pre; k <= dayDiff(e.date, until) + o.post; k++) {
        const d = byDate.get(addDays(e.date, k));
        if (d && d.level != null && d.level >= o.minLevel) { firstOn = addDays(e.date, k); break; }
      }
      let lead = null;
      if (firstOn) {
        if (firstOn <= e.date) {
          const ep = eps.find(p => p.start <= firstOn && p.end >= firstOn);
          const start = ep ? (dayDiff(ep.start, e.date) > o.leadCap ? addDays(e.date, -o.leadCap) : ep.start) : firstOn;
          lead = dayDiff(start, e.date);
        } else lead = -dayDiff(e.date, firstOn);
      }
      return { id: e.id, date: e.date, quality: e.quality, hit: !!firstOn, firstOn, lead };
    });
    // an episode is matched when the documented flood period [date, until] overlaps [start − 2 d, end + 7 d]
    const matchedBy = eps.map(p => evAll.filter(e => (e.until || e.date) >= addDays(p.start, -o.matchPre) && e.date <= addDays(p.end, o.matchPost)));
    const matched = matchedBy.map(m => m.length > 0);
    const byAuditOnly = matchedBy.filter(m => m.length && m.every(e => e.audit)).length;
    const nYears = first ? (yearOf(last) - yearOf(first) + 1) : 0;
    const hits = per.filter(x => x.hit);
    const leads = hits.map(x => x.lead).filter(isNum);
    const warnDays = daily.filter(d => d.level != null && d.level >= o.minLevel).length;
    return {
      minLevel: o.minLevel, events: evIn.length, hits: hits.length, misses: evIn.length - hits.length,
      pod: evIn.length ? hits.length / evIn.length : null,
      episodes: eps.length, unmatchedEpisodes: matched.filter(x => !x).length, matchedByAuditOnly: byAuditOnly,
      farUpperBound: eps.length ? matched.filter(x => !x).length / eps.length : null,
      medianLeadDays: leads.length ? median(leads) : null,
      leadDays: leads,
      warnDaysPerYear: nYears ? warnDays / nYears : null,
      perEvent: per,
      episodeList: eps.map((p, k) => Object.assign({ matched: matched[k], by: matchedBy[k].map(e => e.id) }, p))
    };
  }

  /* ---- data access (Open-Meteo) -------------------------------------------------------- */
  const FLOOD = "https://flood-api.open-meteo.com/v1/flood";
  const ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
  const FORECAST = "https://api.open-meteo.com/v1/forecast";

  async function getJSON(fetchFn, url) {
    const r = await fetchFn(url);
    if (!r.ok) {
      let msg = "HTTP " + r.status;
      try { const j = await r.json(); if (j && j.reason) msg += " — " + j.reason; } catch (e) { /* ignore */ }
      throw new Error(msg + " for " + url.split("?")[0]);
    }
    return r.json();
  }
  const asArray = j => (Array.isArray(j) ? j : [j]);
  function snapGrid(p) {
    const s = p.snap || 0; if (!s) return [[p.lat, p.lon]];
    const steps = Math.round(s / 0.05), pts = [];
    for (let a = -steps; a <= steps; a++) for (let b = -steps; b <= steps; b++) pts.push([+(p.lat + a * 0.05).toFixed(3), +(p.lon + b * 0.05).toFixed(3)]);
    return pts;
  }
  /* choose the GloFAS cell with the largest mean Jul–Sep discharge near each point */
  const _snapCache = {};
  async function snapPoints(points, fetchFn) {
    const out = {};
    for (const p of points) {
      const ck = p.lat + "," + p.lon + "," + (p.snap || 0);
      if (_snapCache[ck]) { out[p.key] = _snapCache[ck]; continue; }
      const grid = snapGrid(p);
      if (grid.length === 1) { out[p.key] = _snapCache[ck] = { lat: p.lat, lon: p.lon, meanQ: null, searched: 1 }; continue; }
      const url = FLOOD + "?latitude=" + grid.map(g => g[0]).join(",") + "&longitude=" + grid.map(g => g[1]).join(",") +
        "&daily=river_discharge&start_date=2020-07-01&end_date=2020-09-30";
      const arr = asArray(await getJSON(fetchFn, url));
      let best = null;
      arr.forEach((j, k) => {
        const m = mean((j.daily && j.daily.river_discharge) || []);
        if (m != null && (!best || m > best.meanQ)) best = { lat: grid[k][0], lon: grid[k][1], meanQ: m, searched: grid.length };
      });
      out[p.key] = _snapCache[ck] = best || { lat: p.lat, lon: p.lon, meanQ: null, searched: grid.length };
    }
    return out;
  }
  function dailyIndex(start, end) { const out = []; for (let s = start; s <= end; s = addDays(s, 1)) out.push(s); return out; }
  function alignTo(dates, times, vals) {
    const m = new Map(); (times || []).forEach((t, k) => m.set(t, vals[k] == null ? null : +vals[k]));
    return dates.map(d => (m.has(d) ? m.get(d) : null));
  }
  /* history for calibration / hindcast: river discharge (GloFAS reanalysis/consolidated) and ERA5 daily rain */
  async function fetchHistory(districtId, start, end, fetchFn) {
    const D = DISTRICTS[districtId];
    const qPts = D.targets.concat(D.upstream);
    const snapped = await snapPoints(qPts, fetchFn);
    const dates = dailyIndex(start, end);
    const series = {}, meta = {};
    const qUrl = FLOOD + "?latitude=" + qPts.map(p => snapped[p.key].lat).join(",") + "&longitude=" + qPts.map(p => snapped[p.key].lon).join(",") +
      "&daily=river_discharge&start_date=" + start + "&end_date=" + end;
    const qArr = asArray(await getJSON(fetchFn, qUrl));
    qPts.forEach((p, k) => {
      const j = qArr[k] || {};
      series[p.key] = alignTo(dates, j.daily && j.daily.time, (j.daily && j.daily.river_discharge) || []);
      meta[p.key] = { en: p.en, asked: [p.lat, p.lon], used: [snapped[p.key].lat, snapped[p.key].lon], cell: [j.latitude, j.longitude], searched: snapped[p.key].searched };
    });
    if (D.rain.length) {
      const rUrl = ARCHIVE + "?latitude=" + D.rain.map(p => p.lat).join(",") + "&longitude=" + D.rain.map(p => p.lon).join(",") +
        "&daily=precipitation_sum&timezone=Asia%2FDhaka&start_date=" + start + "&end_date=" + end;
      const rArr = asArray(await getJSON(fetchFn, rUrl));
      D.rain.forEach((p, k) => {
        const j = rArr[k] || {};
        series[p.key] = alignTo(dates, j.daily && j.daily.time, (j.daily && j.daily.precipitation_sum) || []);
        meta[p.key] = { en: p.en, asked: [p.lat, p.lon], cell: [j.latitude, j.longitude] };
      });
    }
    return { district: districtId, dates, series, meta, start, end };
  }

  /* live inputs: recent + forecast GloFAS (with ensemble when the service provides it) and forecast rain */
  async function fetchLive(districtId, fetchFn, todayISO) {
    const D = DISTRICTS[districtId];
    const today = todayISO || d8(new Date());
    const qPts = D.targets.concat(D.upstream);
    const snapped = await snapPoints(qPts, fetchFn);
    const lat = qPts.map(p => snapped[p.key].lat).join(","), lon = qPts.map(p => snapped[p.key].lon).join(",");
    let arr, ensemble = true;
    try {
      arr = asArray(await getJSON(fetchFn, FLOOD + "?latitude=" + lat + "&longitude=" + lon + "&daily=river_discharge&ensemble=true&past_days=45&forecast_days=16"));
    } catch (e) {
      ensemble = false;
      arr = asArray(await getJSON(fetchFn, FLOOD + "?latitude=" + lat + "&longitude=" + lon + "&daily=river_discharge&past_days=45&forecast_days=16"));
    }
    const river = {};
    qPts.forEach((p, k) => {
      const d = (arr[k] && arr[k].daily) || {};
      const members = Object.keys(d).filter(n => /^river_discharge_member\d+$/.test(n)).map(n => d[n].map(x => (x == null ? null : +x)));
      const control = (d.river_discharge || []).map(x => (x == null ? null : +x));
      river[p.key] = { time: d.time || [], control, members };
      if (!members.length) ensemble = ensemble && false;
    });
    const rain = {};
    if (D.rain.length) {
      const j = asArray(await getJSON(fetchFn, FORECAST + "?latitude=" + D.rain.map(p => p.lat).join(",") + "&longitude=" + D.rain.map(p => p.lon).join(",") +
        "&daily=precipitation_sum&past_days=14&forecast_days=7&timezone=Asia%2FDhaka"));
      D.rain.forEach((p, k) => { const d = (j[k] && j[k].daily) || {}; rain[p.key] = { time: d.time || [], v: (d.precipitation_sum || []).map(x => (x == null ? null : +x)) }; });
    }
    return { district: districtId, today, river, rain, ensemble };
  }

  /* ---- live assessment: observed state + upstream + ensemble + forecast rain ---------- */
  function assessLive(model, live) {
    const D = DISTRICTS[model.district];
    const today = live.today;
    const drivers = [];
    const H = RULES.ensembleHorizonDays;
    for (const t of D.targets) {
      const s = live.river[t.key], rp = model.rp[t.key]; if (!s || !rp) continue;
      const i0 = s.time.indexOf(today);
      const iNow = i0 >= 0 ? i0 : s.time.length - 16;
      const qNow = s.control[iNow];
      const lvNow = levelOfQ(qNow, rp);
      if (lvNow != null) drivers.push({ kind: "river", key: t.key, en: t.en, bn: t.bn, value: qNow, unit: "m³/s", level: lvNow, ratioQ2: qNow / rp.Q2 });
      // forecast: control max and ensemble exceedance within horizon
      const fIdx = []; for (let k = iNow + 1; k <= Math.min(s.time.length - 1, iNow + H); k++) fIdx.push(k);
      const ctlMax = Math.max(...fIdx.map(k => s.control[k]).filter(isNum), -Infinity);
      if (s.members.length >= 10) {
        const pEx = thr => s.members.filter(mb => fIdx.some(k => isNum(mb[k]) && mb[k] >= thr)).length / s.members.length;
        const p2 = pEx(rp.Q2), p5 = pEx(rp.Q5), p20 = pEx(rp.Q20);
        const pr = RULES.ensembleProb;
        const lv = p20 >= pr ? 3 : p5 >= pr ? 2 : p2 >= pr ? 1 : 0;
        // first day when at least half of the members exceed Q2 → expected crossing date
        let cross = null;
        for (const k of fIdx) { const f = s.members.filter(mb => isNum(mb[k]) && mb[k] >= rp.Q2).length / s.members.length; if (f >= pr) { cross = s.time[k]; break; } }
        const band = fIdx.map(k => { const xs = s.members.map(mb => mb[k]).filter(isNum).sort((a, b) => a - b); return { date: s.time[k], p10: quantile(xs, 0.1), p50: quantile(xs, 0.5), p90: quantile(xs, 0.9) }; });
        drivers.push({ kind: "ensemble", key: t.key, en: t.en + " · GloFAS ensemble (" + H + " d)", bn: t.bn + " · GloFAS এনসেম্বল (" + H + " দিন)",
          value: isFinite(ctlMax) ? ctlMax : null, unit: "m³/s", level: lv, probQ2: p2, probQ5: p5, probQ20: p20, members: s.members.length,
          expectedCrossing: cross, leadDays: cross ? dayDiff(today, cross) : null, band });
      } else if (isFinite(ctlMax)) {
        const lv = levelOfQ(ctlMax, rp);
        let cross = null; for (const k of fIdx) if (isNum(s.control[k]) && s.control[k] >= rp.Q2) { cross = s.time[k]; break; }
        drivers.push({ kind: "forecast", key: t.key, en: t.en + " · GloFAS control (" + H + " d)", bn: t.bn + " · GloFAS নিয়ন্ত্রণ (" + H + " দিন)",
          value: ctlMax, unit: "m³/s", level: lv, expectedCrossing: cross, leadDays: cross ? dayDiff(today, cross) : null });
      }
    }
    for (const ln of model.links) {
      const s = live.river[ln.key]; if (!s) continue;
      const i0 = s.time.indexOf(today); const iNow = i0 >= 0 ? i0 : s.time.length - 16;
      const up = s.control[iNow]; if (!isNum(up) || up <= 0) continue;
      const qp = Math.exp(ln.a + ln.b * Math.log(up)), rp = model.rp[ln.for];
      const src = D.upstream.find(u => u.key === ln.key), dst = D.targets.find(t => t.key === ln.for);
      drivers.push({ kind: "upstream", key: ln.key, for: ln.for, en: src.en + " → " + dst.en, bn: src.bn + " → " + dst.bn,
        value: qp, unit: "m³/s", level: levelOfQ(qp, rp), lagDays: ln.lag, validFor: addDays(today, ln.lag), ratioQ2: qp / rp.Q2 });
    }
    for (const r of D.rain) {
      const s = live.rain[r.key], rt = model.rain[r.key]; if (!s || !rt) continue;
      const iT = s.time.indexOf(today); if (iT < 0) continue;
      const sum = (a, b) => { let x = 0, miss = 0; for (let k = a; k <= b; k++) { if (isNum(s.v[k])) x += s.v[k]; else miss++; } return miss > 1 ? null : x; };
      const past3 = sum(iT - 2, iT); // includes today's (partly forecast) total
      let fut3 = null, futDate = null;
      for (let k = iT + 1; k + 2 < s.v.length && k <= iT + 5; k++) { const x = sum(k, k + 2); if (x != null && (fut3 == null || x > fut3)) { fut3 = x; futDate = s.time[k]; } }
      const lvP = levelOfRain(past3, rt), lvF = levelOfRain(fut3, rt);
      if (lvP != null) drivers.push({ kind: "rain", key: r.key, en: r.en + " · last 3 days", bn: r.bn + " · গত ৩ দিন", value: past3, unit: "mm", level: lvP, ratioP95: past3 / rt.P95 });
      if (lvF != null) drivers.push({ kind: "rainForecast", key: r.key, en: r.en + " · wettest 3 days ahead", bn: r.bn + " · সামনের সবচেয়ে ভেজা ৩ দিন", value: fut3, unit: "mm", level: lvF,
        startsOn: futDate, leadDays: futDate ? dayDiff(today, futDate) : null, ratioP95: fut3 / rt.P95 });
    }
    const valid = drivers.filter(d => d.level != null);
    const level = valid.length ? Math.max(...valid.map(d => d.level)) : null;
    valid.sort((a, b) => b.level - a.level || (b.ratioQ2 || b.ratioP95 || 0) - (a.ratioQ2 || a.ratioP95 || 0));
    const leads = level > 0 ? valid.filter(d => d.level === level && isNum(d.leadDays)).map(d => d.leadDays) : [];
    return {
      district: model.district, en: D.en, bn: D.bn, today, level, levelInfo: level == null ? null : LEVELS[level],
      drivers: valid, earliestLeadDays: leads.length ? Math.min(...leads) : null, ensemble: !!live.ensemble,
      thresholds: { rp: model.rp, rain: model.rain, links: model.links.map(l => ({ key: l.key, for: l.for, lag: l.lag, r: l.r })) },
      calibration: model.calibration, rules: RULES.id, version: VERSION
    };
  }

  /* convenience: calibrate on the last 20 complete years and assess today */
  async function runLive(districtId, fetchFn, opt) {
    const o = opt || {};
    const today = o.today || d8(new Date());
    const y1 = yearOf(today) - 1, y0 = y1 - 19;
    const hist = o.history || await fetchHistory(districtId, y0 + "-01-01", y1 + "-12-31", fetchFn);
    const model = calibrate(districtId, hist, y0, y1);
    const live = await fetchLive(districtId, fetchFn, today);
    const out = assessLive(model, live);
    out.modelWarnings = model.warnings;
    out.recent = recentSeries(districtId, live);
    return out;
  }
  function recentSeries(districtId, live) {
    const D = DISTRICTS[districtId]; const t = D.targets[0]; const s = live.river[t.key] || { time: [], control: [] };
    const r = D.rain[0] ? live.rain[D.rain[0].key] : null;
    return { key: t.key, en: t.en, time: s.time, control: s.control, rainKey: D.rain[0] ? D.rain[0].key : null, rainTime: r ? r.time : [], rain: r ? r.v : [] };
  }

  return {
    VERSION, RULES, LEVELS, DISTRICTS,
    util: { quantile, mean, sd, median, rollingSum, addDays, dayDiff, d8 },
    annualMaxima, gumbelFit, returnPeriods, rainThresholds, fitLink, levelOfQ, levelOfRain,
    calibrate, assessIndex, hindcast, calendarReference, episodes, verify,
    snapPoints, fetchHistory, fetchLive, assessLive, runLive
  };
});
