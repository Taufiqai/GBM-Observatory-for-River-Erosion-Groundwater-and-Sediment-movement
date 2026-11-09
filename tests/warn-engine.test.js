// Unit tests for warn-engine.js — run with:  node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const W = require("../warn-engine.js");
const { addDays, quantile } = W.util;

// deterministic pseudo-random generator so tests are repeatable
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function gumbelDraw(u, mu, beta) { return mu - beta * Math.log(-Math.log(u)); }

function days(start, end) { const o = []; for (let s = start; s <= end; s = addDays(s, 1)) o.push(s); return o; }

// synthetic river: base flow + a monsoon hump whose annual peak follows Gumbel(mu, beta)
function synthRiver(dates, mu, beta, seed) {
  const r = rng(seed), peaks = {};
  const v = new Array(dates.length);
  for (let i = 0; i < dates.length; i++) {
    const y = +dates[i].slice(0, 4);
    if (!(y in peaks)) peaks[y] = gumbelDraw(Math.min(0.999, Math.max(0.001, r())), mu, beta);
    const d = new Date(dates[i] + "T00:00:00Z"), doy = (d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5;
    const hump = Math.exp(-0.5 * ((doy - 210) / 25) ** 2); // peak late July
    v[i] = 3000 + (peaks[y] - 3000) * hump;
  }
  return { v, peaks };
}

test("Gumbel return periods recover the generating distribution", () => {
  const dates = days("1950-01-01", "2049-12-31");
  const { v } = synthRiver(dates, 60000, 12000, 7);
  const rp = W.returnPeriods(dates, v, 1950, 2049);
  const trueQ = T => 60000 - 12000 * Math.log(-Math.log(1 - 1 / T));
  assert.ok(Math.abs(rp.Q2 - trueQ(2)) / trueQ(2) < 0.05, "Q2 within 5%");
  assert.ok(Math.abs(rp.Q5 - trueQ(5)) / trueQ(5) < 0.07, "Q5 within 7%");
  assert.ok(rp.Q2 < rp.Q5 && rp.Q5 < rp.Q20, "ladder is ordered");
  assert.equal(rp.nYears, 100);
  assert.ok(Math.abs(rp.peakDoyMedian - 210) <= 1, "median peak day ≈ 210");
});

test("annual maxima ignore years with too few valid days", () => {
  const dates = days("2000-01-01", "2002-12-31");
  const v = dates.map((d, i) => (d.startsWith("2001") && i % 2 ? null : 100 + i));
  const am = W.annualMaxima(dates, v, 2000, 2002);
  assert.deepEqual(am.map(o => o.year), [2000, 2002]);
});

test("rolling sum tolerates one missing day in three, not two", () => {
  const r = W.util.rollingSum([1, 2, null, 4, null, null, 7], 3);
  assert.deepEqual(r, [null, null, 3, 6, null, null, null]);
});

test("level ladders", () => {
  const rp = { Q2: 100, Q5: 150, Q20: 220 };
  assert.equal(W.levelOfQ(99, rp), 0);
  assert.equal(W.levelOfQ(100, rp), 1);
  assert.equal(W.levelOfQ(180, rp), 2);
  assert.equal(W.levelOfQ(500, rp), 3);
  assert.equal(W.levelOfQ(null, rp), null);
  const rt = { P95: 50, P99: 120, P997: 200 };
  assert.equal(W.levelOfRain(10, rt), 0);
  assert.equal(W.levelOfRain(60, rt), 1);
  assert.equal(W.levelOfRain(150, rt), 2);
  assert.equal(W.levelOfRain(250, rt), 3);
});

test("upstream link finds the true travel time", () => {
  const dates = days("1995-01-01", "2014-12-31");
  const r = rng(3);
  const up = dates.map((d, i) => 20000 + 15000 * Math.sin(i / 9) ** 2 + 2000 * r());
  const lag = 3;
  const down = dates.map((d, i) => (i >= lag ? 1.1 * up[i - lag] + 500 * r() : null));
  const ln = W.fitLink(dates, up, down, 1995, 2014);
  assert.equal(ln.lag, lag);
  assert.ok(ln.r > 0.95);
  assert.ok(Math.abs(ln.b - 1) < 0.1, "log-slope ≈ 1 for a proportional relation");
});

test("episodes merge short gaps", () => {
  const dates = days("2020-07-01", "2020-07-30");
  const lv = dates.map((d, i) => ((i >= 2 && i <= 4) || (i >= 8 && i <= 9) || (i >= 20 && i <= 21) ? 1 : 0));
  const daily = dates.map((d, i) => ({ date: d, level: lv[i] }));
  const eps = W.episodes(daily, 1, 5);
  assert.equal(eps.length, 2);
  assert.equal(eps[0].start, "2020-07-03");
  assert.equal(eps[0].end, "2020-07-10");
});

test("verify: hits, lead time, late detection, misses and unmatched episodes", () => {
  const dates = days("2020-01-01", "2021-12-31");
  const lv = new Map();
  const on = (a, b, l) => { for (let s = a; s <= b; s = addDays(s, 1)) lv.set(s, l); };
  on("2020-07-05", "2020-07-20", 1);  // warns 5 days before event A
  on("2020-09-01", "2020-09-03", 2);  // nothing documented → unmatched episode
  on("2021-06-12", "2021-06-14", 1);  // starts 2 days after event B → late hit (lead −2)
  const daily = dates.map(d => ({ date: d, level: lv.get(d) || 0 }));
  const events = [
    { id: "A", date: "2020-07-10" },
    { id: "B", date: "2021-06-10" },
    { id: "C", date: "2021-08-15" },   // never warned → miss
    { id: "X", date: "2019-07-01" }    // outside the period → ignored
  ];
  const v = W.verify(daily, events, { minLevel: 1 });
  assert.equal(v.events, 3);
  assert.equal(v.hits, 2);
  assert.equal(v.misses, 1);
  const A = v.perEvent.find(e => e.id === "A"), B = v.perEvent.find(e => e.id === "B");
  assert.equal(A.lead, 5);
  assert.equal(B.lead, -2);
  assert.equal(v.episodes, 3);
  assert.equal(v.unmatchedEpisodes, 1);
  assert.ok(Math.abs(v.farUpperBound - 1 / 3) < 1e-9);
  // at Warning level only the September episode counts
  const v2 = W.verify(daily, events, { minLevel: 2 });
  assert.equal(v2.hits, 0);
  assert.equal(v2.episodes, 1);
});

test("verify caps lead time at 21 days for long episodes", () => {
  const dates = days("2020-05-01", "2020-08-31");
  const daily = dates.map(d => ({ date: d, level: d >= "2020-05-10" ? 1 : 0 }));
  const v = W.verify(daily, [{ id: "E", date: "2020-07-20" }]);
  assert.equal(v.perEvent[0].lead, 21);
});

test("calibrate + hindcast end-to-end on synthetic flash district", () => {
  const dates = days("1995-01-01", "2024-12-31");
  const r = rng(11);
  const series = {};
  series.q_surma_sun = synthRiver(dates, 2500, 600, 5).v;
  series.q_surma_kan = series.q_surma_sun.map((x, i) => (i + 1 < dates.length ? series.q_surma_sun[i + 1] / 1.2 : null));
  const rain = dates.map(() => (r() < 0.6 ? 0 : 40 * -Math.log(r())));
  rain[dates.indexOf("2022-06-14")] = 600; rain[dates.indexOf("2022-06-15")] = 500;
  series.r_cherra = rain; series.r_sunam = rain.map(x => x * 0.4);
  const inputs = { dates, series };
  const m = W.calibrate("sunamganj", inputs, 1995, 2014);
  assert.ok(m.rp.q_surma_sun && m.rain.r_cherra, "thresholds fitted");
  assert.equal(m.links.length, 1);
  assert.equal(m.links[0].lag, 1);
  const daily = W.hindcast(m, inputs, "2016-01-01", "2024-12-31");
  assert.equal(daily[0].date, "2016-01-01");
  const d = daily.find(x => x.date === "2022-06-15");
  assert.equal(d.level, 3, "a 1100 mm two-day burst is Severe on the rain ladder");
  assert.equal(d.by, "rain");
  const ref = W.calendarReference(m, dates.slice(0, 400));
  assert.ok(ref.some(x => x.level === 1) && ref.some(x => x.level === 0));
});

// minimal fetch mock that answers Open-Meteo style requests
function mockFetch(handler) {
  const calls = [];
  const f = async url => { calls.push(url); const body = handler(url); return { ok: true, status: 200, json: async () => body }; };
  f.calls = calls; return f;
}

test("fetchHistory snaps to the largest-flow cell and aligns series to the calendar", async () => {
  const f = mockFetch(url => {
    const u = new URL(url);
    const lats = u.searchParams.get("latitude").split(","), lons = u.searchParams.get("longitude").split(",");
    const start = u.searchParams.get("start_date"), end = u.searchParams.get("end_date");
    const t = days(start, end);
    const make = (la, lo) => {
      const big = Math.abs(+la - 24.5) < 1e-6 && Math.abs(+lo - 89.75) < 1e-6 ? 10 : 1; // one cell is the main channel
      return { latitude: +la, longitude: +lo, daily: { time: t.slice(1), river_discharge: t.slice(1).map(() => 1000 * big) } };
    };
    if (u.hostname.startsWith("flood")) return lats.length === 1 ? make(lats[0], lons[0]) : lats.map((la, k) => make(la, lons[k]));
    return lats.map((la, k) => ({ latitude: +la, longitude: +lons[k], daily: { time: t, precipitation_sum: t.map(() => 1) } }));
  });
  const h = await W.fetchHistory("sirajganj", "2020-01-01", "2020-01-10", f);
  assert.deepEqual(h.meta.q_jamuna_sir.used, [24.5, 89.75]);
  assert.equal(h.dates.length, 10);
  assert.equal(h.series.q_jamuna_sir[0], null, "missing first day is null, not shifted");
  assert.equal(h.series.q_jamuna_sir[1], 10000);
  assert.ok(f.calls.some(c => c.includes("start_date=2020-07-01")), "snap search uses a monsoon window");
});

test("assessLive reads the GloFAS ensemble and forecast rain", () => {
  const model = {
    district: "sunamganj", calibration: [2005, 2024],
    rp: { q_surma_sun: { Q2: 100, Q5: 150, Q20: 220 } },
    links: [], rain: { r_cherra: { P95: 100, P99: 250, P997: 400 }, r_sunam: { P95: 60, P99: 120, P997: 200 } }
  };
  const today = "2026-06-10";
  const time = days(addDays(today, -45), addDays(today, 15));
  const it = time.indexOf(today);
  const control = time.map((d, i) => (i <= it ? 80 : 80 + 10 * (i - it)));
  const members = Array.from({ length: 50 }, (_, k) => time.map((d, i) => (i <= it ? 80 : 80 + (k < 30 ? 12 : 4) * (i - it))));
  const rt = days(addDays(today, -14), addDays(today, 6));
  const rv = rt.map((d, i) => (d === addDays(today, 2) || d === addDays(today, 3) ? 150 : 5));
  const live = { today, ensemble: true, river: { q_surma_sun: { time, control, members } }, rain: { r_cherra: { time: rt, v: rv }, r_sunam: { time: rt, v: rt.map(() => 1) } } };
  const a = W.assessLive(model, live);
  const ens = a.drivers.find(d => d.kind === "ensemble");
  assert.ok(Math.abs(ens.probQ2 - 1) < 1e-9);
  assert.ok(Math.abs(ens.probQ5 - 0.6) < 1e-9);  // only the 30 fast members pass Q5 within 10 days
  assert.equal(ens.level, 2);
  assert.equal(ens.expectedCrossing, addDays(today, 2)); // 80+12·2=104 ≥ Q2 for 60% of members on day 2
  const rf = a.drivers.find(d => d.kind === "rainForecast" && d.key === "r_cherra");
  assert.equal(rf.level, 2, "305 mm in 3 days ahead is a Warning on the rain ladder");
  assert.equal(a.level, 2);
  assert.equal(a.levelInfo.en, "Warning");
  assert.equal(a.drivers[0].level, 2, "drivers sorted with the highest level first");
});
