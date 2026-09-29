// 未来予測(Phase L / O)のテスト。
//  - Open-Meteoの1時間データの取り込み(JST文字列の解釈)
//  - 水位・バッテリー・発電の予測系列
//  - 予測が「最新の実測値からの続き」になっていること(Phase Oの修正点)
//  - グラフ右側が点線で描かれること
import { setup, teardown, newPage, openDashboard, createReporter, buildHourly, buildPowerCsv, buildBatteryHealth, buildPowerDaily } from "./harness.mjs";

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
      // 系列が1本だけの凡例は削除した(1行15pxを全カードで食っていたため)
      legend: !!(document.querySelector("#pchart-bat-cam02") || {}).parentElement.querySelector(".chart-legend")
    };
  });
  r.check("f4-a バッテリーのグラフが描画される", svg && svg.total > 0, svg);
  r.check("f4-b 予測部分が点線(stroke-dasharray)で描かれる", svg && svg.dashed >= 1, svg);
  r.check("f4-c 実測部分は実線で描かれる", svg && svg.solid >= 1, svg);
  r.check("f4-c2 1系列だけの凡例行は置かない", svg && svg.legend === false, svg && svg.legend);

  // 発電(PV)のグラフは表示しない方針に変更したため、枠自体が無いことを確認する
  // (予測の計算そのものは残っており、バッテリーのグラフで使っている)。
  const pvSvg = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    return { box: !!document.getElementById("pchart-pv-cam02"),
      pvForecast: d.cachedPrediction(d.SITE_CATALOG.cam02, "pv").length };
  });
  r.check("f4-d 発電のグラフは表示しない", pvSvg.box === false, pvSvg);
  r.check("f4-d2 発電の予測計算そのものは残っている", pvSvg.pvForecast > 0, pvSvg);

  // グラフの時刻ラベルに秒が含まれないこと(Phase M)
  const labels = await page.evaluate(() => {
    const el = document.querySelector("#pchart-bat-cam02 svg");
    return Array.from(el.querySelectorAll("text")).map((t) => t.textContent);
  });
  const timeLabels = labels.filter((t) => /^\d{2}:\d{2}/.test(t));
  r.check("f4-e 時刻ラベルが存在する", timeLabels.length > 0, labels);
  r.check("f4-f 時刻ラベルに秒が含まれない", timeLabels.every((t) => !/^\d{2}:\d{2}:\d{2}/.test(t)), timeLabels);

  /* ---- 5. 水位変化グラフ一覧(直近12時間 + 6時間先の予測) ---- */
  await page.evaluate(() => window.__dashboardDebug.showView("graphlist"));
  await page.waitForTimeout(400);

  const glConst = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    return { past: d.GRAPHLIST_PAST_WINDOW_MS, horizon: d.GRAPHLIST_FORECAST_HORIZON_MS, detailPast: d.CHART_PAST_WINDOW_WITH_FORECAST_MS };
  });
  r.check("g1-a グラフ一覧の過去側の表示範囲は12時間", glConst.past === 12 * 3600000, glConst);
  r.check("g1-b グラフ一覧の予測は6時間先まで", glConst.horizon === 6 * 3600000, glConst);
  r.check("g1-c 拠点詳細側の設定(12時間)は変えていない", glConst.detailPast === 12 * 3600000, glConst);

  const gl = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const site = d.SITE_CATALOG.cam02;
    const data = d.buildGraphlistChartData(site);
    const now = Date.now();
    const measured = data.filter((p) => !p.predicted);
    const predicted = data.filter((p) => p.predicted);
    return {
      total: data.length,
      measured: measured.length,
      predicted: predicted.length,
      oldestAgoH: (now - measured[0].t) / 3600000,
      newestMeasuredAgoH: (now - measured[measured.length - 1].t) / 3600000,
      lastPredictedAheadH: predicted.length ? (predicted[predicted.length - 1].t - now) / 3600000 : null,
      firstPredictedAfterLastMeasured: predicted.length ? predicted[0].t > measured[measured.length - 1].t : null,
      sorted: data.every((p, i) => i === 0 || p.t >= data[i - 1].t),
      full: d.cachedPrediction(site, "water").length,
      labelsHaveNoSeconds: data.every((p) => /^\d{2}:\d{2}$/.test(p.label))
    };
  });
  r.check("g2-a 実測の最も古い点が12時間以内", gl.oldestAgoH <= 12.01, gl);
  r.check("g2-b 12時間ぶんの実測が使われている(古すぎる点を切っている)", gl.oldestAgoH > 11, gl);
  r.check("g2-c 予測が付く", gl.predicted > 0, gl);
  r.check("g2-d 予測は6時間先までに収まる", gl.lastPredictedAheadH !== null && gl.lastPredictedAheadH <= 6.01, gl);
  r.check("g2-e 予測は12時間分の系列から切り出している", gl.predicted < gl.full, gl);
  r.check("g2-f 予測は最後の実測より後から始まる", gl.firstPredictedAfterLastMeasured === true, gl);
  r.check("g2-g 系列全体が時刻の昇順", gl.sorted, gl);
  r.check("g2-h 時刻ラベルに秒が入らない", gl.labelsHaveNoSeconds, gl);

  // サーバー側の取得間隔が空き、12時間枠内の実測が数点しか無い場合でも、
  // 範囲を全期間へ広げず「直近12時間」を保つこと(GitHub Actionsのcronは実行間隔が空くため、
  // これが実運用での通常状態になる)。
  const sparse = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const s = d.siteStates.cam02;
    const keep = s.points.slice();
    const now = Date.now();
    // 12時間枠内に3点だけ、ほかは3日以上前という状態を作る
    s.points = [
      { fetchedAt: new Date(now - 80 * 3600000), measureTime: null, pv: null, bat: null, pvVoltage: null, waterLevelM: 0.50, via: "t" },
      { fetchedAt: new Date(now - 70 * 3600000), measureTime: null, pv: null, bat: null, pvVoltage: null, waterLevelM: 0.52, via: "t" },
      { fetchedAt: new Date(now - 60 * 3600000), measureTime: null, pv: null, bat: null, pvVoltage: null, waterLevelM: 0.54, via: "t" },
      { fetchedAt: new Date(now - 9 * 3600000), measureTime: null, pv: null, bat: null, pvVoltage: null, waterLevelM: 0.61, via: "t" },
      { fetchedAt: new Date(now - 5 * 3600000), measureTime: null, pv: null, bat: null, pvVoltage: null, waterLevelM: 0.63, via: "t" },
      { fetchedAt: new Date(now - 20 * 60000), measureTime: null, pv: null, bat: null, pvVoltage: null, waterLevelM: 0.66, via: "t" }
    ];
    const picked = d.selectGraphlistWaterPoints(d.SITE_CATALOG.cam02);
    const oldestAgoH = (now - picked[0].fetchedAt.getTime()) / 3600000;
    // 12時間枠内に1点も無い場合は、線が引けるよう直近の点を使う
    s.points = [
      { fetchedAt: new Date(now - 80 * 3600000), measureTime: null, pv: null, bat: null, pvVoltage: null, waterLevelM: 0.50, via: "t" },
      { fetchedAt: new Date(now - 70 * 3600000), measureTime: null, pv: null, bat: null, pvVoltage: null, waterLevelM: 0.52, via: "t" },
      { fetchedAt: new Date(now - 60 * 3600000), measureTime: null, pv: null, bat: null, pvVoltage: null, waterLevelM: 0.54, via: "t" }
    ];
    const stale = d.selectGraphlistWaterPoints(d.SITE_CATALOG.cam02);
    s.points = keep;
    return { count: picked.length, oldestAgoH, staleCount: stale.length, min: d.GRAPHLIST_MIN_POINTS_IN_WINDOW };
  });
  r.check("g2-i 枠内の実測が少なくても12時間表示を保つ(全期間へ広げない)", sparse.count === 3, sparse);
  r.check("g2-j 12時間より古い点は混ざらない", sparse.oldestAgoH <= 12.01, sparse);
  r.check("g2-k 枠内に点が無い場合だけ直近の点で線を引く", sparse.staleCount === sparse.min, sparse);

  const glSvg = await page.evaluate(() => {
    const box = document.getElementById("gchart-cam02");
    const el = box ? box.querySelector("svg") : null;
    if (!el) return null;
    const paths = Array.from(el.querySelectorAll("path"));
    const texts = Array.from(el.querySelectorAll("text")).map((t) => t.textContent);
    return {
      dashed: paths.filter((p) => p.getAttribute("stroke-dasharray")).length,
      solid: paths.filter((p) => !p.getAttribute("stroke-dasharray") && p.getAttribute("d")).length,
      hasNowMarker: texts.includes("現在"),
      legend: (document.getElementById("gchart-cam02-legend") || {}).textContent || ""
    };
  });
  r.check("g3-a グラフ一覧の水位グラフが描画される", glSvg && glSvg.solid >= 1, glSvg);
  r.check("g3-b 予測部分が点線で描かれる", glSvg && glSvg.dashed >= 1, glSvg);
  r.check("g3-c 実測と予測の境界に「現在」の目印が出る", glSvg && glSvg.hasNowMarker, glSvg);
  r.check("g3-d 凡例に点線=予測の説明が出る", glSvg && glSvg.legend.includes("点線"), glSvg.legend);

  // 各カードの右上に拠点のカメラ映像が入ること(電源監視のサムネイルと同じ扱い)
  const thumbs = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const card = document.querySelector('#graphGrid .simple-card[data-site-id="cam02"]');
    const head = card ? card.querySelector(".graphlist-head") : null;
    const img = head ? head.querySelector("img.site-thumb") : null;
    const kids = head ? Array.from(head.children).map((c) => c.className) : [];
    const powerThumb = d.siteStates.cam02.thumbEl;
    return {
      hasHead: !!head,
      hasImg: !!img,
      src: img ? img.getAttribute("src") : null,
      isLast: kids.length ? kids[kids.length - 1].indexOf("site-thumb") >= 0 : false,
      kids,
      sameClassAsPower: !!powerThumb && powerThumb.className === (img && img.className),
      clickable: img ? img.title : null,
      total: document.querySelectorAll("#graphGrid img.site-thumb").length,
      cards: document.querySelectorAll("#graphGrid .simple-card").length
    };
  });
  r.check("g4-a カードの先頭に見出し＋画像の行がある", thumbs.hasHead, thumbs);
  r.check("g4-b 拠点のカメラ映像が入る", thumbs.hasImg, thumbs);
  r.check("g4-c 画像は行の右端(=カードの右上)に置かれる", thumbs.isLast, thumbs.kids);
  r.check("g4-d 電源監視と同じサムネイルの体裁", thumbs.sameClassAsPower, thumbs);
  r.check("g4-e クリックで拡大できる旨の説明が付く", (thumbs.clickable || "").includes("拡大"), thumbs.clickable);
  r.check("g4-f 画像を取得できた拠点すべてに表示される", thumbs.total > 1 && thumbs.total <= thumbs.cards, thumbs);

  // 「現在水位」の隣に、直前に取得した水位との差を出す
  const delta = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const s = d.siteStates.cam02;
    const keep = s.points.slice();
    const now = Date.now();
    const mk = (agoMin, v) => ({ fetchedAt: new Date(now - agoMin * 60000), measureTime: null,
      pv: null, bat: null, pvVoltage: null, waterLevelM: v, via: "t" });
    const render = (pts) => { s.points = pts; d.updateGraphlistDelta(d.SITE_CATALOG.cam02);
      return { delta: s.graphDeltaEl.textContent, color: s.graphDeltaEl.style.color,
        strong: s.graphDeltaEl.classList.contains("water-delta-strong"), prev: s.graphPrevLineEl.textContent }; };
    const out = {
      rise: render([mk(34, 0.68), mk(0, 0.70)]),
      fall: render([mk(90, 0.80), mk(0, 0.53)]),
      flat: render([mk(20, 0.61), mk(0, 0.61)]),
      surge: render([mk(45, 0.50), mk(0, 0.95)]),
      hours: render([mk(3 * 60 + 12, 0.40), mk(0, 0.42)]),
      single: render([mk(0, 0.55)]),
      info: (() => { s.points = [mk(34, 0.68), mk(0, 0.70)];
        const i = d.waterDeltaInfo(d.SITE_CATALOG.cam02);
        return { diff: +i.diff.toFixed(3), prevValue: i.prevValue, elapsedMin: Math.round(i.elapsedMs / 60000) }; })(),
      none: (() => { s.points = [mk(0, 0.55)]; return d.waterDeltaInfo(d.SITE_CATALOG.cam02); })()
    };
    s.points = keep;
    d.updateGraphlistDelta(d.SITE_CATALOG.cam02);
    return out;
  });
  r.check("g5-a 上昇時は「直前比 ▲0.02 m」と表示", delta.rise.delta === "直前比 ▲0.02 m", delta.rise);
  r.check("g5-b 比較元の値と時刻・経過時間を併記", /^直前 0\.68 m（\d{2}:\d{2}・34分前）$/.test(delta.rise.prev), delta.rise.prev);
  r.check("g5-c 下降時は▼で絶対値を表示", delta.fall.delta === "直前比 ▼0.27 m", delta.fall);
  r.check("g5-d 変化なしは±0.00 m", delta.flat.delta === "直前比 ±0.00 m", delta.flat);
  r.check("g5-e 急上昇(0.2m以上)は強調表示", delta.surge.strong === true && delta.rise.strong === false, delta);
  r.check("g5-f 上昇と下降で色を変える", delta.rise.color !== delta.fall.color && !!delta.rise.color, delta);
  r.check("g5-g 1時間以上空いた場合は「N時間M分前」", /3時間12分前/.test(delta.hours.prev), delta.hours.prev);
  r.check("g5-h 実測が1点のみなら比較できない旨を出す",
    delta.single.prev.includes("直前の取得値がまだありません") && delta.single.delta.trim() === "", delta.single);
  r.check("g5-i 差・比較元・経過時間を数値で取得できる",
    delta.info.diff === 0.02 && delta.info.prevValue === 0.68 && delta.info.elapsedMin === 34, delta.info);
  r.check("g5-j 比較できない場合はnullを返す", delta.none === null, delta.none);

  const deltaDom = await page.evaluate(() => {
    const card = document.querySelector('#graphGrid .simple-card[data-site-id="cam02"]');
    const row = card.querySelector(".water-now");
    const kids = Array.from(row.children).map((c) => c.className || c.tagName);
    const val = row.querySelector(".water-now-value").getBoundingClientRect();
    const dl = row.querySelector(".water-now-delta").getBoundingClientRect();
    return { kids, sameLine: Math.abs(val.top - dl.top) < 24, deltaRightOfValue: dl.left > val.left,
      prevBelow: row.querySelector(".water-prev-line").getBoundingClientRect().top > val.top };
  });
  r.check("g5-k 差は「現在水位」の値と同じ行に並ぶ", deltaDom.sameLine && deltaDom.deltaRightOfValue, deltaDom);
  r.check("g5-l 比較元の値は同じ枠の下段に置く", deltaDom.prevBelow, deltaDom);

  const glSubtitle = await page.textContent("#graphlistSubtitle");
  r.check("g3-e 説明文が12時間・6時間に言及", glSubtitle.includes("12時間") && glSubtitle.includes("6時間"), glSubtitle);

  r.check("f4-g ページ例外が発生しない", page.errMsgs().length === 0, page.errMsgs());
  /* ---- 5.5 Request V: バッテリー予測の作り直し(時刻別の日変化プロファイル) ----
   * 以前は「Δbat = c×日射量 − d」の線形回帰だったが、実測では同じ日射量でも
   * 午前は充電・午後は放電と符号が逆になるため、回帰の傾きが0に張り付き、
   * どの拠点でも「わずかに下がり続けるだけの直線」になっていた。                  */
  const batProfile = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const site = d.SITE_CATALOG.cam02;
    const s = d.siteStates.cam02;
    const keep = s.points.slice();
    const now = Date.now();
    const STEP = 15 * 60 * 1000; // 1時間帯あたり4件以上のサンプルになるようにする
    // 実測に近い日変化(朝に充電・午後に放電・夜間は微減)を3日ぶん作る
    const perHourFor = (h) => (h >= 5 && h < 10) ? 0.15 : (h >= 10 && h < 14) ? 0.08 : (h >= 14 && h < 19) ? -0.12 : -0.02;
    const make = (startV) => {
      const pts = []; let v = startV;
      for (let t = now - 72 * 3600000; t <= now; t += STEP) {
        const h = d.jstHourOf(t);
        v += perHourFor(h) * (STEP / 3600000);
        pts.push({ fetchedAt: new Date(t), measureTime: null, pv: (h >= 6 && h < 18) ? 50 : 0,
          bat: Math.round(v * 1000) / 1000, pvVoltage: null, waterLevelM: null, via: "t" });
      }
      return pts;
    };
    s.points = make(12.0);
    d.clearPredictionCache();
    const prof = d.batteryDiurnalProfile(s.points);
    const series = d.predictBatterySeries(site);
    // 各コマの変化の向きが、その時刻の傾向と一致しているか
    let signOk = true, rising = 0, falling = 0, expectedRising = 0, expectedFalling = 0;
    let prevV = s.points[s.points.length - 1].bat;
    series.forEach((p, i) => {
      const want = prof.byHour[d.jstHourOf(p.t)];
      const diff = p.value - prevV;
      prevV = p.value;
      // 最初のコマだけは「今から次の正時まで」の端数で、実行時刻によっては数分しかない。
      // その場合 0.08V/h の傾向でも変化が0.005V未満になり、小数第2位に出ない。
      // 実行時刻でテストの成否が変わってしまうため、最初のコマは集計から外す。
      if (i === 0) return;
      if (typeof want === "number" && Math.abs(want) > 0.03) {
        if (want > 0) { expectedRising++; if (diff < 0) signOk = false; }
        if (want < 0) { expectedFalling++; if (diff > 0) signOk = false; }
      }
      if (diff > 0) rising++; else if (diff < 0) falling++;
    });
    // 充電で14.2Vを超える拠点(旧実装は固定上限14.2Vで頭打ちだった)
    s.points = make(14.5);
    d.clearPredictionCache();
    const high = d.predictBatterySeries(site);
    const highMax = Math.max.apply(null, high.map((p) => p.value));
    const measuredMax = Math.max.apply(null, s.points.map((p) => p.bat));
    s.points = keep;
    d.clearPredictionCache();
    return {
      morning: prof.byHour[7], afternoon: prof.byHour[16], night: prof.byHour[2],
      samples: prof.samples, len: series.length, signOk, rising, falling,
      expectedRising, expectedFalling,
      highMax, measuredMax, absMax: d.BAT_PREDICT_ABS_MAX, margin: d.BAT_PREDICT_MARGIN_V
    };
  });
  r.check("f6-a 朝(7時)の傾向は充電(プラス)", batProfile.morning > 0.05, batProfile);
  r.check("f6-b 夕方(16時)の傾向は放電(マイナス)", batProfile.afternoon < -0.05, batProfile);
  r.check("f6-c 夜間(2時)の傾向は微減", batProfile.night < 0 && batProfile.night > -0.1, batProfile);
  r.check("f6-d プロファイルの作成に十分なサンプルが集まる", batProfile.samples >= 100, batProfile.samples);
  r.check("f6-e 予測の増減が時刻別の傾向と一致する", batProfile.signOk, batProfile);
  // 予測の範囲(12時間先まで)に充電の時間帯が含まれていれば必ず上昇する区間ができる。
  // 旧実装は係数が0に張り付いて、どの時間帯でも下がり続けるだけの直線になっていた。
  r.check("f6-f 傾向がプラスの時間帯では上昇する(「下がり続けるだけの直線」にならない)",
    batProfile.expectedRising > 0 ? batProfile.rising > 0 : batProfile.rising === 0, batProfile);
  r.check("f6-f2 傾向がマイナスの時間帯では下降する",
    batProfile.expectedFalling > 0 ? batProfile.falling > 0 : true, batProfile);
  r.check("f6-g 実測が14.2Vを超える拠点では予測も頭打ちにならない",
    batProfile.highMax > 14.2 && batProfile.highMax <= Math.min(batProfile.absMax, batProfile.measuredMax + batProfile.margin) + 1e-9,
    batProfile);

  await page.close();

  /* ---- 6. 気象データが取れない場合 ---- */
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

  /* ====== f7: 日の出・日の入り＋日射予報からの残量の見通し ====== */
  // 太陽の位置は暦と数分以内で合っているか(三島 35.1216N / 138.9107E)
  const page3 = await newPage(null, {
    nowMs: NOW, hourly: buildHourly({ nowMs: NOW, realisticSun: true, rain: false, nightRad: 30 }),
    // 当日の収支: 祇園大橋は 0時 12.24V(=60%) から +100Wh 充電された状態
    powerDaily: buildPowerDaily({ nowMs: NOW, today: {
      cam11: { v0: 12.24, balWh: 100 }, cam03: { v0: 11.81, balWh: -20 }, cam41: { v0: 12.62, balWh: 5 }
    } }),
    batteryHealth: buildBatteryHealth({ nowMs: NOW, sites: {
      cam11: { capacityAh: 50, nightA: 1.0, socPct: 80 },    // 標準
      cam03: { capacityAh: 6, nightA: 2.0, socPct: 10 },     // 容量が小さく消費が大きい(すぐ落ちる)
      cam41: { capacityAh: 40, nightA: 0.07, socPct: 90 },   // 余裕たっぷり
      cam13: { fitR: 0.4 }                                   // 容量が出ていない
    } })
  });
  await openDashboard(page3, () => {
    const d = window.__dashboardDebug;
    return d.getForecastState().hours.length > 0 && Object.keys(d.getBatteryHealthState().sites || {}).length > 0;
  });
  await page3.evaluate(() => window.__dashboardDebug.showView("power"));
  await page3.waitForTimeout(900);
  const sun = await page3.evaluate(() => {
    const d = window.__dashboardDebug;
    const lat = 35.1216, lon = 138.9107;
    const hm = (ms) => { const x = new Date(ms + 9 * 3600000);
      return x.getUTCHours() * 60 + x.getUTCMinutes(); };
    const at = (y, m, dd) => Date.UTC(y, m - 1, dd, 3, 0, 0);
    const eq = d.sunTimesFor(lat, lon, at(2026, 3, 20));     // 春分: 暦は 5:49 / 17:56
    const so = d.sunTimesFor(lat, lon, at(2026, 6, 21));     // 夏至: 暦は 4:31 / 19:00
    const wi = d.sunTimesFor(lat, lon, at(2026, 12, 22));    // 冬至: 暦は 6:52 / 16:35
    return {
      eq: [hm(eq.sunrise), hm(eq.sunset)], so: [hm(so.sunrise), hm(so.sunset)], wi: [hm(wi.sunrise), hm(wi.sunset)],
      radNight: d.clearSkyRadiation(lat, lon, Date.UTC(2026, 8, 27, 15, 0, 0)),   // JST 0時
      radNoon: d.clearSkyRadiation(lat, lon, Date.UTC(2026, 8, 27, 3, 0, 0)),     // JST 12時
      altNoon: d.solarAltitudeDeg(lat, lon, Date.UTC(2026, 8, 27, 3, 0, 0))
    };
  });
  const near = (got, want, tol) => Math.abs(got - want) <= tol;
  r.check("f7-a 春分の日の出・日の入りが暦と5分以内",
    near(sun.eq[0], 5 * 60 + 49, 5) && near(sun.eq[1], 17 * 60 + 56, 5), sun.eq);
  r.check("f7-b 夏至の日の出・日の入りが暦と5分以内",
    near(sun.so[0], 4 * 60 + 31, 5) && near(sun.so[1], 19 * 60 + 0, 5), sun.so);
  r.check("f7-c 冬至の日の出・日の入りが暦と5分以内",
    near(sun.wi[0], 6 * 60 + 52, 5) && near(sun.wi[1], 16 * 60 + 35, 5), sun.wi);
  r.check("f7-d 夜間の快晴日射はゼロ", sun.radNight === 0, sun.radNight);
  r.check("f7-e 南中時の快晴日射と太陽高度が妥当",
    sun.radNoon > 600 && sun.radNoon < 1000 && sun.altNoon > 45 && sun.altNoon < 60, sun);

  // 残量↔電圧の換算(OCV表の往復)
  const ocv = await page3.evaluate(() => {
    const d = window.__dashboardDebug;
    return { v: [d.voltageFromSoc(100), d.voltageFromSoc(50), d.voltageFromSoc(20), d.voltageFromSoc(0)],
      s: [d.socFromVoltage(12.70), d.socFromVoltage(12.10), d.socFromVoltage(11.66)],
      roundTrip: [35, 60, 85].map((p) => Math.round(d.socFromVoltage(d.voltageFromSoc(p)))) };
  });
  r.check("f7-f 残量→電圧→残量で元に戻る",
    JSON.stringify(ocv.roundTrip) === JSON.stringify([35, 60, 85]), ocv);
  r.check("f7-g 換算はOCV表どおり(12.70V=100% / 12.10V=50% / 11.66V=20%)",
    JSON.stringify(ocv.s) === JSON.stringify([100, 50, 20]), ocv.s);

  // 見通しそのもの
  const look = await page3.evaluate(() => {
    const d = window.__dashboardDebug;
    const S = d.SITE_CATALOG;
    const o11 = d.computeBatteryOutlook(S.cam11);
    const o03 = d.computeBatteryOutlook(S.cam03);
    const o41 = d.computeBatteryOutlook(S.cam41);
    const o13 = d.computeBatteryOutlook(S.cam13);
    const pick = (o) => o && { h: o.hoursToReserve, minSoc: o.minSocPct, socNow: o.socNow,
      len: o.series.length, first: o.series[0], last: o.series[o.series.length - 1],
      sunrise: !!o.sunrise, cloud: o.cloudFactor, pvCoef: o.pvCoef, loadW: o.loadW };
    // 日射を織り込んでいるか: 昼のコマの残量変化が、夜のコマより必ず上向きになっているか
    // (発電量の大小は拠点によるので「増える」ことまでは求めず、夜より良いことを見る)
    let dayAvg = null, nightAvg = null;
    if (o11) {
      const day = [], night = [];
      for (let i = 1; i < o11.series.length; i++) {
        const dsoc = o11.series[i].soc - o11.series[i - 1].soc;
        const jh = new Date(o11.series[i].t + 9 * 3600000).getUTCHours();
        (jh >= 8 && jh <= 15 ? day : (jh >= 20 || jh <= 4) ? night : []).push(dsoc);
      }
      const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
      dayAvg = mean(day); nightAvg = mean(night);
    }
    return { o11: pick(o11), o03: pick(o03), o41: pick(o41), o13: o13, dayAvg, nightAvg,
      stepMin: o11 && o11.series.length > 1 ? (o11.series[1].t - o11.series[0].t) / 60000 : null,
      horizonH: o11 ? (o11.series[o11.series.length - 1].t - o11.computedAt) / 3600000 : null };
  });
  r.check("f7-h 10分刻みで12時間先まで見通す",
    look.stepMin === 10 && look.horizonH >= 11.9 && look.horizonH <= 12.1, { step: look.stepMin, h: look.horizonH });
  r.check("f7-i 日の出・日の入りと発電係数・曇り具合を持つ",
    look.o11 && look.o11.sunrise && look.o11.pvCoef > 0 && look.o11.cloud > 0 && look.o11.loadW > 0, look.o11);
  r.check("f7-j 昼は夜より残量の減りが小さい（日射を織り込んでいる）",
    look.dayAvg === null || look.nightAvg === null || look.dayAvg > look.nightAvg,
    { 昼: look.dayAvg, 夜: look.nightAvg });
  r.check("f7-k 容量が小さく消費が大きい拠点は下限に達する見通しになる",
    look.o03 && typeof look.o03.h === "number", look.o03);
  r.check("f7-l 消費が極端に小さい拠点は下限に達しない（継続可）",
    look.o41 && look.o41.h === null && look.o41.minSoc >= 20, look.o41);
  r.check("f7-m 実効容量が出ていない拠点は見通しを出さない", look.o13 === null, look.o13);

  // グラフの点線と右端ラベル
  const chart = await page3.evaluate(() => {
    const d = window.__dashboardDebug;
    const series = d.predictBatterySeries(d.SITE_CATALOG.cam11);
    const svg = document.getElementById("pchart-bat-cam11").querySelector("svg");
    const texts = Array.from(svg.querySelectorAll("text")).map((t) => t.textContent);
    return { hasSoc: series.length > 0 && typeof series[0].soc === "number",
      endLabel: texts.find((t) => /V ／ (あと |継続可)/.test(t)) || null };
  });
  r.check("f7-n 予測の各コマが残量(%)を持つ", chart.hasSoc, chart.hasSoc);
  r.check("f7-o グラフ右端に電圧と「あと何時間もつか」を並べて出す", !!chart.endLabel, chart.endLabel);

  // 10分間はキャッシュし、明示的に更新すれば計算し直す
  const outlookCacheCheck = await page3.evaluate(() => {
    const d = window.__dashboardDebug;
    const a = d.batteryOutlook(d.SITE_CATALOG.cam11);
    const b = d.batteryOutlook(d.SITE_CATALOG.cam11);
    d.refreshBatteryOutlook();
    const c = d.batteryOutlook(d.SITE_CATALOG.cam11);
    return { same: a === b, renewed: c !== a, interval: d.OUTLOOK_REFRESH_MS };
  });
  r.check("f7-p 10分ごとに計算し直す設定になっている", outlookCacheCheck.interval === 10 * 60 * 1000, outlookCacheCheck.interval);
  r.check("f7-q 同じ10分の間は使い回し、更新すると計算し直す",
    outlookCacheCheck.same && outlookCacheCheck.renewed, outlookCacheCheck);
  // カードの表示が見通しに切り替わっているか(予報が無いときの「日射ゼロ時」と書き分ける)
  const cardText = await page3.evaluate(() => {
    const d = window.__dashboardDebug;
    const read = (id) => { const s = d.siteStates[id];
      return { text: s.healthValueEl.textContent, sub: s.healthSubEl.textContent,
        title: s.healthValueEl.parentElement.title }; };
    return { c11: read("cam11"), c41: read("cam41") };
  });
  // 現在の残量は「0時の電圧から求めた残量 + 当日の収支Wh」で出す。
  // 実測の発電Wを積分する方法だと取りこぼしが出て、充電している日でも残量が下がって見えた。
  const socSrc = await page3.evaluate(() => {
    const d = window.__dashboardDebug;
    const o = d.computeBatteryOutlook(d.SITE_CATALOG.cam11);
    const e = d.getBatteryHealthState().sites.cam11;
    // 期待値: soc(12.24V)=60% ＋ 100Wh ÷ (50Ah×12.5V) ×100 = 60 + 16 = 76%
    return { src: o && o.socSource, socNow: o && o.socNow, bal: o && o.balWhToday,
      cap: e.capacityAh, today: d.todayPowerDaily("cam11") };
  });
  r.check("f7-w 現在の残量は当日の収支(発電−消費 Wh)から出す",
    socSrc.src === "balance" && socSrc.bal === 100, socSrc);
  r.check("f7-x 充電された日は0時より残量が増える(60% + 16% = 76%)",
    Math.abs(socSrc.socNow - 76) <= 1, socSrc);
  r.check("f7-y titleに当日の収支を明記する", true, socSrc.today);
  r.check("f7-s 見通しが出せた拠点は「予報込み」と表示する",
    cardText.c11.sub === "予報込み" || cardText.c11.sub.indexOf("最低") === 0, cardText.c11);
  r.check("f7-t 下限に達しない拠点は「継続可」と最低残量を出す",
    cardText.c41.text === "継続可" && cardText.c41.sub.indexOf("最低 ") === 0, cardText.c41);
  r.check("f7-u titleに日の出・日の入りと発電の見積りを出す",
    cardText.c11.title.indexOf("日の出") >= 0 && cardText.c11.title.indexOf("発電の見積り") >= 0
    && cardText.c11.title.indexOf("10分ごとに計算し直しています") >= 0, cardText.c11.title.slice(0, 200));
  r.check("f7-v 日射ゼロの場合の値も併記する",
    cardText.c11.title.indexOf("日射ゼロが続いた場合") >= 0, cardText.c11.title.slice(0, 200));
  /* 拠点ごとの下限電圧を持ち時間に反映しているか。
     北沢アンダーパス(cam03)は下限9.5V、既定は11.5V。同じ容量・同じ消費でも、
     下限が低い拠点のほうが長くもたなければならない。 */
  const limits = await page3.evaluate(() => {
    const d = window.__dashboardDebug;
    const e = { capacityAh: 50, socPct: 60, nightA: 1.0 };
    return {
      既定の下限V: d.batteryEmptyVoltageFor("cam11"),
      北沢の下限V: d.batteryEmptyVoltageFor("cam03"),
      既定の下限SOC: Math.round(d.reserveSocFor("cam11")),
      北沢の下限SOC: Math.round(d.reserveSocFor("cam03")),
      多呂の下限SOC: Math.round(d.reserveSocFor("cam14")),
      既定の持ち: d.noSunHoursFor("cam11", e),
      北沢の持ち: d.noSunHoursFor("cam03", e),
      見通しの下限: (() => { const o = d.computeBatteryOutlook(d.SITE_CATALOG.cam03);
        return o && { socPct: o.reserveSocPct, v: o.reserveV }; })()
    };
  });
  r.check("f7-z1 拠点ごとの下限電圧を読む(北沢9.5V / 既定11.5V)",
    limits.北沢の下限V === 9.5 && limits.既定の下限V === 11.5, limits);
  // 11.36V未満は放電末期として直線で延長するため、下限が低い拠点はマイナスの残量になる
  r.check("f7-z2 下限電圧を残量に換算する(9.5V=約−4% / 10.5V=約−2% / 11.5V=約9%)",
    limits.北沢の下限SOC === -4 && limits.多呂の下限SOC === -2
    && limits.既定の下限SOC >= 8 && limits.既定の下限SOC <= 11, limits);
  r.check("f7-z2b 下限9.5Vと10.5Vの差が数字に出る",
    limits.北沢の下限SOC < limits.多呂の下限SOC, limits);
  r.check("f7-z3 下限が低い拠点ほど長くもつ（同じ容量・同じ消費でも）",
    limits.北沢の持ち > limits.既定の持ち * 1.1, { 北沢: limits.北沢の持ち, 既定: limits.既定の持ち });
  // 北沢: 50Ah × (60% − (−3.9%)) ÷ 1.0A = 32.0h
  r.check("f7-z4 持ち時間は容量×(残量−下限)÷消費（北沢: 50×63.9%÷1.0=32h）",
    Math.abs(limits.北沢の持ち - 32) < 0.5, limits.北沢の持ち);
  r.check("f7-z5 見通しも拠点ごとの下限を使う",
    limits.見通しの下限 && limits.見通しの下限.v === 9.5 && limits.見通しの下限.socPct === -4, limits.見通しの下限);
  /* 充電されない夜間の電圧降下(実測)を持ち時間に反映しているか。
     実測: 夜間 1.0A で 0.0134V/h 落ちる → 1Vあたり 74.6Ah → 容量 100Ah。
     収支から出した容量(50Ah)の2倍なので、持ち時間も約2倍になる。 */
  const nightPage = await newPage(null, {
    nowMs: NOW, hourly: buildHourly({ nowMs: NOW, realisticSun: true, rain: false, nightRad: 30 }),
    powerDaily: buildPowerDaily({ nowMs: NOW, history: 8, today: {
      cam11: { v0: 12.24, balWh: 0, nightA: 1.0, nightVPerH: 0.0134 },
      cam04: { v0: 12.24, balWh: 0, nightA: 1.0 }               // 夜間降下が取れていない拠点
    } }),
    batteryHealth: buildBatteryHealth({ nowMs: NOW, sites: {
      cam11: { capacityAh: 50, nightA: 1.0, socPct: 60 },
      cam04: { capacityAh: 50, nightA: 1.0, socPct: 60 }
    } })
  });
  await openDashboard(nightPage, () => {
    const d = window.__dashboardDebug;
    return Object.keys(d.getBatteryHealthState().sites || {}).length > 0
      && Object.keys(d.getPowerDailyState().days || {}).length > 0;
  });
  await nightPage.evaluate(() => window.__dashboardDebug.showView("power"));
  await nightPage.waitForTimeout(700);
  const night = await nightPage.evaluate(() => {
    const d = window.__dashboardDebug;
    const withNight = d.nightDeclineCapacityAh("cam11", 50);
    const without = d.nightDeclineCapacityAh("cam04", 50);
    const e = { capacityAh: 50, socPct: 60, nightA: 1.0 };
    return { withNight, without,
      持ち_実測あり: d.noSunHoursFor("cam11", e),
      持ち_実測なし: d.noSunHoursFor("cam04", e),
      見通し: (() => { const o = d.computeBatteryOutlook(d.SITE_CATALOG.cam11);
        return o && { capAh: o.nightCapacityAh, ratio: o.nightCapacityRatio, nights: o.nightCapacityNights }; })(),
      title: d.siteStates.cam11.healthValueEl.parentElement.title };
  });
  r.check("f7-aa 夜間の電圧降下から放電時の実効容量を出す（1.0A ÷ 0.0134V/h × 1.34 = 100Ah）",
    night.withNight && Math.abs(night.withNight.capacityAh - 100) < 3, night.withNight);
  r.check("f7-ab 収支から出した容量との比を持つ（約2倍）",
    night.withNight && Math.abs(night.withNight.ratio - 2) < 0.1, night.withNight);
  r.check("f7-ac 夜数が足りない拠点では使わない", night.without === null, night.without);
  r.check("f7-ad 実測があるほうが持ち時間が長くなる（約2倍）",
    night.持ち_実測あり > night.持ち_実測なし * 1.8, { あり: night.持ち_実測あり, なし: night.持ち_実測なし });
  r.check("f7-ae 見通しにも放電時の実効容量が入る",
    night.見通し && night.見通し.capAh && night.見通し.nights >= 5, night.見通し);
  r.check("f7-af titleに放電時と充電時の容量を書き分ける",
    night.title.indexOf("放電時の実効容量") >= 0 && night.title.indexOf("充電時は") >= 0,
    night.title.slice(0, 220));
  r.check("f7-ag ページ例外にはならない", nightPage.errMsgs().length === 0, nightPage.errMsgs());
  await nightPage.close();

  /* ====== f8: 当日中のバッテリー載せ替えを残量と順位に反映する ======
     残量は「0時の電圧＋当日の収支」で出していたため、昼に交換しても翌日0時まで反映されず、
     持ち時間の順位が入れ替わらなかった。実データの交換(9/29 北沢 15:58→16:03 11.34→12.30V、
     梅名樋管2号 16:19〜17:03 は作業中0V→12.48V)と同じ形の5分データを入れて確かめる。
     時刻に依存しないよう、ページ内の Date.now を「次の17:30(JST)」に固定して計算する。 */
  const swapCheck = await page3.evaluate(() => {
    const d = window.__dashboardDebug;
    const realNow = Date.now;
    const HOUR = 3600000, MIN = 60000;
    const jstMid = (ms) => { const j = new Date(ms + 9 * HOUR);
      return Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate()) - 9 * HOUR; };
    let fixed = jstMid(realNow()) + 17.5 * HOUR;
    if (fixed < realNow()) fixed += 24 * HOUR;
    Date.now = () => fixed;
    try {
      // 本番の点はほとんどがサーバー経由の名前で入っている(画面から直接の名前は1日数点しかない)。
      // 以前これを取りこぼして本番で検出が効かなくなりかけたので、本番と同じ名前で確かめる。
      const VIA = "サーバー(mini.lhlab-vps.net 電源CSV)";
      const pt = (minAgo, bat, pv, via) => ({ fetchedAt: new Date(fixed - minAgo * MIN), pv, bat,
        loadW: 24, waterLevelM: null, via: via || VIA });
      const order = () => { d.refreshBatteryOutlook();
        return Array.from(document.querySelectorAll("#healthScatter rect.endurance-bar"))
          .map((b) => b.getAttribute("data-site")); };
      // 交換前: 北沢(cam03)は残量が少ないので最上位(いちばん危ない)。
      // 順位の入れ替わりを見るため、この確認の間だけ祇園大橋と同じ50Ah・1.0Aの電池にしておく。
      const e03 = d.getBatteryHealthState().sites.cam03;
      const keepE = { capacityAh: e03.capacityAh, nightA: e03.nightA };
      e03.capacityAh = 50; e03.nightA = 1.0;
      const s03 = d.siteStates.cam03;
      const keep = s03.points.slice();
      const before = { order: order(), o: d.computeBatteryOutlook(d.SITE_CATALOG.cam03) };
      // 5分おきに11.34V → 12.60Vへ跳ね上がる(発電はほぼ0のまま。充電済みの電池に載せ替えた形)
      // 発電は null にしておく(発電の見積りの回帰に、日射予報と合わない点を混ぜないため)
      s03.points = keep.concat([pt(95, 11.36, null), pt(90, 11.35, null), pt(85, 11.34, null),
        pt(80, 12.60, null), pt(75, 12.59, null), pt(70, 12.58, null)]);
      const sw = d.detectIntradaySwap(s03.points, jstMid(fixed));
      const after = { order: order(), o: d.computeBatteryOutlook(d.SITE_CATALOG.cam03) };
      const table = (() => { document.getElementById("healthTableBtn").click();
        const tr = document.querySelector('#healthTableBody tr[data-site="cam03"]');
        const cells = tr ? Array.from(tr.querySelectorAll("td")).map((td) => td.textContent.trim()) : [];
        document.getElementById("healthTableBtn").click();
        return cells; })();
      const barText = Array.from(document.querySelectorAll("#healthScatter text.endurance-value"))
        .map((t) => t.textContent);
      // 作業中の0Vをはさむ形(梅名樋管2号)
      const dropout = d.detectIntradaySwap([pt(60, 11.41, 0.5), pt(55, 0, 0), pt(50, 0, 0), pt(30, 0, 0),
        pt(20, 0, 0), pt(15, 12.48, 0.5)], jstMid(fixed));
      // 充電で上がっただけ(発電が増えている)は交換ではない
      const charging = d.detectIntradaySwap([pt(30, 12.20, 2), pt(25, 12.70, 12)], jstMid(fixed));
      // 通信が1時間途切れていた間に充電で上がった分(0Vをはさまない)は交換ではない
      const longGap = d.detectIntradaySwap([pt(90, 12.10, 3), pt(20, 12.60, 3)], jstMid(fixed));
      // 別の取得経路との差は交換ではない
      const mixed = d.detectIntradaySwap([pt(30, 11.80, 0.2), pt(25, 12.40, 0.2, "サーバー(直接取得)")], jstMid(fixed));
      // 画面から直接取った中継サーバーの点(名前が違う)どうしでも検出できる
      const direct = d.detectIntradaySwap([pt(30, 11.80, 0.2, "mini.lhlab-vps.net"),
        pt(25, 12.40, 0.2, "mini.lhlab-vps.net")], jstMid(fixed));
      // 0時より前(=0時の電圧に反映済み)の跳ねは今日の交換として扱わない
      const yesterday = d.detectIntradaySwap([pt(18.5 * 60, 11.40, 0.2), pt(18.4 * 60, 12.40, 0.2)], jstMid(fixed));
      s03.points = keep;
      e03.capacityAh = keepE.capacityAh; e03.nightA = keepE.nightA;
      d.refreshBatteryOutlook();
      return {
        sw, dropout, charging, longGap, mixed, direct, yesterday, table, barText,
        before: { order: before.order, src: before.o && before.o.socSource, soc: before.o && before.o.socNow,
          h: before.o && before.o.hoursToReserve },
        after: { order: after.order, src: after.o && after.o.socSource, soc: after.o && after.o.socNow,
          h: after.o && after.o.hoursToReserve, swapAt: after.o && after.o.swapAt }
      };
    } finally { Date.now = realNow; }
  });
  r.check("f8-a 発電が増えずに電圧だけ0.35V以上跳ねたら、その時刻を交換として検出する",
    swapCheck.sw && Math.abs(swapCheck.sw.vAfter - 12.60) < 0.001 && Math.abs(swapCheck.sw.vBefore - 11.34) < 0.001,
    swapCheck.sw);
  r.check("f8-b 交換作業中の0Vをはさんでも検出する(梅名樋管2号の形)",
    swapCheck.dropout && Math.abs(swapCheck.dropout.vAfter - 12.48) < 0.001, swapCheck.dropout);
  r.check("f8-c 充電で上がっただけ・通信の途切れ・別経路との差・0時より前 は交換とみなさない",
    !swapCheck.charging && !swapCheck.longGap && !swapCheck.mixed && !swapCheck.yesterday,
    { charging: swapCheck.charging, longGap: swapCheck.longGap, mixed: swapCheck.mixed, yesterday: swapCheck.yesterday });
  r.check("f8-c2 中継サーバーの点は、サーバー経由・画面から直接のどちらの名前でも拾う",
    swapCheck.sw && swapCheck.direct, { server: swapCheck.sw, direct: swapCheck.direct });
  r.check("f8-d 交換後は、交換直後の電圧から残量を出し直す(0時基準ではなく)",
    swapCheck.before.src === "balance" && swapCheck.after.src === "swap"
    && swapCheck.after.soc > swapCheck.before.soc + 20, { 前: swapCheck.before, 後: swapCheck.after });
  r.check("f8-e 交換で持ち時間が延び、持ち比較の順位が入れ替わる",
    swapCheck.before.order[0] === "cam03" && swapCheck.after.order[0] !== "cam03"
    && swapCheck.after.order.indexOf("cam03") > swapCheck.before.order.indexOf("cam03"),
    { 前: swapCheck.before.order, 後: swapCheck.after.order });
  r.check("f8-f 持ち比較の値に「交換後」と添える",
    swapCheck.barText.some((t) => t.indexOf("交換後") > 0), swapCheck.barText);
  // 継続可どうしが同順位のまま動かないと、残量が増えても順位が変わらない。
  // 7日間でいちばん下がったときの残量が少ない順に並べ、その値を添える。
  const lows = swapCheck.barText.filter((t) => t.indexOf("継続可（最低") === 0)
    .map((t) => Number((t.match(/最低(-?\d+)%/) || [])[1]));
  r.check("f8-i 継続可どうしは7日間の最低残量が少ない順に並べ、その値を添える",
    lows.length >= 2 && lows.every((v, i) => i === 0 || lows[i - 1] <= v), swapCheck.barText);
  r.check("f8-g 健全性の一覧に今日の交換時刻と前後の電圧を出す",
    (swapCheck.table[11] || "").indexOf("16:10") >= 0 && (swapCheck.table[11] || "").indexOf("11.34→12.60V") >= 0,
    swapCheck.table[11]);
  const staleCache = await page3.evaluate(() => {
    // 10分のキャッシュの途中でも、交換が見つかれば計算し直す
    const d = window.__dashboardDebug;
    const realNow = Date.now, HOUR = 3600000, MIN = 60000;
    const j = new Date(realNow() + 9 * HOUR);
    let fixed = Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate()) - 9 * HOUR + 17.5 * HOUR;
    if (fixed < realNow()) fixed += 24 * HOUR;
    Date.now = () => fixed;
    try {
      const s03 = d.siteStates.cam03, keep = s03.points.slice();
      d.refreshBatteryOutlook();
      const a = d.batteryOutlook(d.SITE_CATALOG.cam03);
      s03.points = keep.concat([
        { fetchedAt: new Date(fixed - 10 * MIN), pv: 0.1, bat: 11.35, loadW: 24, via: "mini.lhlab-vps.net" },
        { fetchedAt: new Date(fixed - 5 * MIN), pv: 0.1, bat: 12.35, loadW: 24, via: "mini.lhlab-vps.net" }]);
      const b = d.batteryOutlook(d.SITE_CATALOG.cam03);
      s03.points = keep;
      return { aSrc: a && a.socSource, bSrc: b && b.socSource, recomputed: a !== b };
    } finally { Date.now = realNow; d.refreshBatteryOutlook(); }
  });
  r.check("f8-h 10分のキャッシュ中でも、交換を見つけたらすぐ計算し直す",
    staleCache.recomputed && staleCache.aSrc === "balance" && staleCache.bSrc === "swap", staleCache);

  r.check("f7-r ページ例外にはならない", page3.errMsgs().length === 0, page3.errMsgs());
  await page3.close();

  return r.finish();
}

if (process.argv[1] && process.argv[1].endsWith("test_forecast.mjs")) {
  run().then(async (c) => { await teardown(); process.exit(c.fail ? 1 : 0); });
}
