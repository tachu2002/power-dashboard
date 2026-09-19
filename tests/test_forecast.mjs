// 未来予測(Phase L / O)のテスト。
//  - Open-Meteoの1時間データの取り込み(JST文字列の解釈)
//  - 水位・バッテリー・発電の予測系列
//  - 予測が「最新の実測値からの続き」になっていること(Phase Oの修正点)
//  - グラフ右側が点線で描かれること
import { setup, teardown, newPage, openDashboard, createReporter, buildHourly, buildPowerCsv } from "./harness.mjs";

const NOW = Date.now();

// 予測に必要な点数(MIN_POINTS_FOR_REGRESSION=12)を満たす実測履歴をサーバー保存CSVとして与える。
function buildRecentCsv(siteId, count, stepMs, nowMs, opts) {
  opts = opts || {};
  const lines = ["拠点,取得時刻,機器の計測時刻,PV(W),BAT(V),水位(m),取得方法"];
  for (let i = count - 1; i >= 0; i--) {
    const t = new Date(nowMs - i * stepMs).toISOString();
    const bat = (12.0 + (count - i) * 0.01).toFixed(3);
    const pv = (5 + (count - i) * 0.1).toFixed(3);
    const water = (0.5 + (count - i) * 0.001).toFixed(3);
    lines.push([siteId, t, "", pv, bat, opts.noWater ? "" : water,
      "サーバー(mini.lhlab-vps.net 電源CSV)"].join(","));
  }
  return lines.join("\n") + "\n";
}

export async function run() {
  const r = createReporter("test_forecast");
  await setup();

  const recent = buildRecentCsv("cam02", 40, 30 * 60 * 1000, NOW);
  const page = await newPage(null, { nowMs: NOW, recentCsv: recent, recentWaterCsv: recent });
  await openDashboard(page, () => {
    const d = window.__dashboardDebug;
    return d.getForecastState().hours.length > 0;
  });

  /* ---- 1. 気象データの取り込み ---- */
  const fc = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const st = d.getForecastState();
    const now = Date.now();
    return {
      count: st.hours.length,
      error: st.error,
      past: st.hours.filter((h) => h.t < now).length,
      future: st.hours.filter((h) => h.t > now).length,
      sample: st.hours[0],
      parsed: d.parseLocalHour("2026-09-19T14:00"),
      expected: Date.UTC(2026, 8, 19, 5, 0),
      bad: d.parseLocalHour("not-a-time")
    };
  });
  r.check("f1-a 1時間データを取り込める", fc.count > 0, fc.count);
  r.check("f1-b エラーが無い", fc.error === null, fc.error);
  r.check("f1-c 過去と未来の両方が含まれる", fc.past > 0 && fc.future > 0, { past: fc.past, future: fc.future });
  r.check("f1-d 各コマに雨量・日射量が入る",
    typeof fc.sample.rain === "number" && typeof fc.sample.rad === "number", fc.sample);
  r.check("f1-e Open-Meteoの時刻文字列を日本時間として解釈する", fc.parsed === fc.expected, fc);
  r.check("f1-f 解釈できない文字列はNaN", Number.isNaN(fc.bad), fc.bad);

  /* ---- 2. 予測系列 ---- */
  await page.waitForFunction(() => {
    const d = window.__dashboardDebug;
    return d.siteStates.cam02.points.filter((p) => typeof p.bat === "number").length >= 12;
  }, { timeout: 15000 });

  const pred = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const site = d.SITE_CATALOG.cam02;
    d.clearPredictionCache();
    const bat = d.predictBatterySeries(site);
    const water = d.predictWaterSeries(site);
    const pv = d.predictPvSeries(site);
    const lastBat = d.lastPointWith(d.siteStates.cam02.points, "bat");
    const lastWater = d.lastPointWith(d.siteStates.cam02.points, "waterLevelM");
    return {
      batLen: bat.length, waterLen: water.length, pvLen: pv.length,
      batFirst: bat[0], batLast: bat[bat.length - 1],
      waterFirst: water[0],
      allPredicted: bat.every((p) => p.predicted === true) && water.every((p) => p.predicted === true),
      ascendingBat: bat.every((p, i) => i === 0 || p.t > bat[i - 1].t),
      lastBatValue: lastBat ? lastBat.bat : null,
      lastBatTime: lastBat ? lastBat.fetchedAt.getTime() : null,
      lastWaterValue: lastWater ? lastWater.waterLevelM : null,
      horizon: d.PREDICTION_HORIZON_MS,
      inRange: bat.every((p) => p.value >= 10.5 && p.value <= 14.2)
    };
  });
  r.check("f2-a バッテリーの予測が生成される", pred.batLen > 0, pred.batLen);
  r.check("f2-b 水位の予測が生成される", pred.waterLen > 0, pred.waterLen);
  r.check("f2-c 発電(PV)の予測が生成される", pred.pvLen > 0, pred.pvLen);
  r.check("f2-d 予測は12時間先までに収まる", pred.batLen <= 13, pred.batLen);
  r.check("f2-e 予測点にpredictedフラグが立つ", pred.allPredicted, pred.batFirst);
  r.check("f2-f 予測は時刻昇順", pred.ascendingBat, pred.batFirst);
  r.check("f2-g 予測は最新実測より未来の時刻から始まる",
    pred.batFirst.t > pred.lastBatTime, { first: pred.batFirst.t, last: pred.lastBatTime });
  r.check("f2-h バッテリー予測が想定電圧レンジに収まる", pred.inRange, pred.batLast);

  // Phase O: 最初のコマが最新実測値から不自然に飛ばないこと(1コマ0.6Vの上限内)
  r.check("f2-i 予測の1コマ目が最新実測値の近傍から始まる",
    Math.abs(pred.batFirst.value - pred.lastBatValue) <= 0.6 + 1e-9,
    { first: pred.batFirst.value, last: pred.lastBatValue });
  r.check("f2-j 水位予測も最新実測値の近傍から始まる",
    Math.abs(pred.waterFirst.value - pred.lastWaterValue) <= 1.0,
    { first: pred.waterFirst.value, last: pred.lastWaterValue });

  /* ---- 3. 予測キャッシュは最新実測点に紐づく(Phase Oの修正) ---- */
  const cache = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const site = d.SITE_CATALOG.cam02;
    d.clearPredictionCache();
    const before = d.cachedPrediction(site, "bat");
    const cached = d.cachedPrediction(site, "bat"); // 実測が変わらなければ同一(キャッシュが効く)
    // 新しい実測値が届いた状況を再現する
    const s = d.siteStates.cam02;
    const lastT = s.points[s.points.length - 1].fetchedAt.getTime();
    s.points.push({ fetchedAt: new Date(lastT + 10 * 60 * 1000), measureTime: null,
      pv: 9.9, bat: 11.75, pvVoltage: null, waterLevelM: null, via: "mini.lhlab-vps.net" });
    const after = d.cachedPrediction(site, "bat");
    return {
      sameWhenUnchanged: before === cached,
      recomputed: after !== before,
      beforeFirst: before[0] ? before[0].value : null,
      afterFirst: after[0] ? after[0].value : null,
      newLast: 11.75
    };
  });
  r.check("f3-a 実測が変わらない間はキャッシュを再利用する", cache.sameWhenUnchanged, cache);
  r.check("f3-b 新しい実測値が届くと予測を計算し直す", cache.recomputed, cache);
  r.check("f3-c 計算し直した予測は新しい実測値の続きになる",
    Math.abs(cache.afterFirst - cache.newLast) <= 0.6 + 1e-9, cache);
  r.check("f3-d 古い予測とは異なる値になる", cache.afterFirst !== cache.beforeFirst, cache);

  /* ---- 4. グラフの点線表示 ---- */
  await page.evaluate(() => window.__dashboardDebug.showView("power"));
  await page.waitForTimeout(500);
  const svg = await page.evaluate(() => {
    const box = document.getElementById("pchart-bat-cam02");
    const el = box ? box.querySelector("svg") : null;
    if (!el) return null;
    const paths = Array.from(el.querySelectorAll("path"));
    return {
      total: paths.length,
      dashed: paths.filter((p) => p.getAttribute("stroke-dasharray")).length,
      solid: paths.filter((p) => !p.getAttribute("stroke-dasharray") && p.getAttribute("d")).length,
      title: (document.querySelector("#pchart-bat-cam02") || {}).parentElement.querySelector(".chart-legend").textContent
    };
  });
  r.check("f4-a バッテリーのグラフが描画される", svg && svg.total > 0, svg);
  r.check("f4-b 予測部分が点線(stroke-dasharray)で描かれる", svg && svg.dashed >= 1, svg);
  r.check("f4-c 実測部分は実線で描かれる", svg && svg.solid >= 1, svg);

  const pvSvg = await page.evaluate(() => {
    const box = document.getElementById("pchart-pv-cam02");
    const el = box ? box.querySelector("svg") : null;
    if (!el) return null;
    const paths = Array.from(el.querySelectorAll("path"));
    return { dashed: paths.filter((p) => p.getAttribute("stroke-dasharray")).length, total: paths.length };
  });
  r.check("f4-d 発電のグラフにも予測の点線が入る", pvSvg && pvSvg.dashed >= 1, pvSvg);

  // グラフの時刻ラベルに秒が含まれないこと(Phase M)
  const labels = await page.evaluate(() => {
    const el = document.querySelector("#pchart-bat-cam02 svg");
    return Array.from(el.querySelectorAll("text")).map((t) => t.textContent);
  });
  const timeLabels = labels.filter((t) => /^\d{2}:\d{2}/.test(t));
  r.check("f4-e 時刻ラベルが存在する", timeLabels.length > 0, labels);
  r.check("f4-f 時刻ラベルに秒が含まれない", timeLabels.every((t) => !/^\d{2}:\d{2}:\d{2}/.test(t)), timeLabels);

  r.check("f4-g ページ例外が発生しない", page.errMsgs().length === 0, page.errMsgs());
  await page.close();

  /* ---- 5. 気象データが取れない場合 ---- */
  const page2 = await newPage(null, { nowMs: NOW, openMeteoStatus: 500, recentCsv: recent, recentWaterCsv: recent });
  await openDashboard(page2);
  await page2.waitForTimeout(1500);
  const noFc = await page2.evaluate(() => {
    const d = window.__dashboardDebug;
    const site = d.SITE_CATALOG.cam02;
    return {
      hours: d.getForecastState().hours.length,
      error: !!d.getForecastState().error,
      bat: d.predictBatterySeries(site).length,
      water: d.predictWaterSeries(site).length,
      pv: d.predictPvSeries(site).length
    };
  });
  r.check("f5-a 気象データが無ければ予測は空になる",
    noFc.bat === 0 && noFc.water === 0 && noFc.pv === 0, noFc);
  r.check("f5-b エラーが記録される", noFc.error, noFc);
  r.check("f5-c 予測が無くてもページ例外にはならない", page2.errMsgs().length === 0, page2.errMsgs());
  await page2.close();

  return r.finish();
}

if (process.argv[1] && process.argv[1].endsWith("test_forecast.mjs")) {
  run().then(async (c) => { await teardown(); process.exit(c.fail ? 1 : 0); });
}
