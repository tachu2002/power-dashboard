// 電源監視ビューのテスト: 中継サーバーCSVの取り込み、カードの数値表示、
// 電池マーク(残量%)の描画位置、発電(W)の単位、取得失敗時の挙動。
import { setup, teardown, newPage, openDashboard, createReporter, buildPowerCsv, buildBatteryHealth, POWER_CSV_HEADER } from "./harness.mjs";

const NOW = Date.now();
// 中継サーバー由来のBATが拠点ごとに正しく振り分けられることを確かめたいので、
// matsuhisa.info側はBATを返さない応答にしておく(実運用では両方から届くが、
// ここでは中継サーバーの値だけが残る状態にして対応関係を検証する)。
const NO_BAT_BODY = 'PV=13200mV Measure Time=2026-09-19 20:00:00 Distance=120.5cm <img src="pic.jpg">';

export async function run() {
  const r = createReporter("test_power");
  await setup();

  /* ================= 1. 中継サーバーCSVの取り込みと表示 ================= */
  const page = await newPage(null, { nowMs: NOW, matsuhisaBody: NO_BAT_BODY });
  await openDashboard(page, () => {
    const d = window.__dashboardDebug;
    return d.siteStates.cam02 && d.siteStates.cam02.points.some((p) => typeof p.pv === "number");
  });
  await page.evaluate(() => window.__dashboardDebug.showView("power"));

  const cards = await page.evaluate(() => {
    const grid = document.getElementById("sitesGrid");
    return {
      count: grid.querySelectorAll(".card").length,
      gauges: grid.querySelectorAll(".battery-gauge").length,
      pvCharts: grid.querySelectorAll('[id^="pchart-pv-"]').length,
      batCharts: grid.querySelectorAll('[id^="pchart-bat-"]').length,
      titles: Array.from(grid.querySelectorAll(".card h2")).map((h) => h.textContent)
    };
  });
  r.check("p1-a カードが23枚描画される", cards.count === 23, cards.count);
  r.check("p1-b すべてのカードに電池マークがある", cards.gauges === 23, cards.gauges);
  r.check("p1-c 発電のグラフは表示せず、BATのグラフのみ23枚", cards.pvCharts === 0 && cards.batCharts === 23, cards);
  r.check("p1-d Phase Qの3拠点がカードとして並ぶ",
    ["こも池", "竹倉用水路", "ほたるの里"].every((n) => cards.titles.some((t) => t.indexOf(n) === 0)), cards.titles);

  const card = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const s = d.siteStates.cam02;
    const mini = s.thumbSlot;
    const kids = Array.from(mini.children).map((c) => c.className || c.querySelector(".stat-label").textContent);
    const gaugeIdx = kids.findIndex((c) => String(c).indexOf("battery-gauge") >= 0);
    return {
      pvText: s.pvValueEl.textContent,
      batText: s.batValueEl.textContent,
      gaugeHtml: s.batteryGaugeEl.innerHTML,
      kids, gaugeIdx,
      lastPv: d.lastPointWith(s.points, "pv"),
      lastBat: d.lastPointWith(s.points, "bat"),
      unit: s.pvValueEl.querySelector(".unit") ? s.pvValueEl.querySelector(".unit").textContent : null
    };
  });
  r.check("p2-a 発電の数値がカードに表示される", /\d/.test(card.pvText), card.pvText);
  r.check("p2-b 発電の単位がW(電力)", card.unit === "W", card.unit);
  r.check("p2-c BATの数値が表示される", /\d/.test(card.batText), card.batText);
  r.check("p2-d 電池マークに残量%が入る", /\d+%/.test(card.gaugeHtml), card.gaugeHtml.slice(0, 200));
  r.check("p2-e 電池マークの見出しが「バッテリー残量」", card.gaugeHtml.includes("バッテリー残量"), card.gaugeHtml.slice(0, 80));
  r.check("p2-f 電池マークはBATの数値より後ろ(=数値と拠点画像の間)にある", card.gaugeIdx === 2, card.kids);
  r.check("p2-g 実測点に発電(W)が入っている", card.lastPv && typeof card.lastPv.pv === "number", card.lastPv);
  r.check("p2-h 実測点にBAT(V)が入っている", card.lastBat && typeof card.lastBat.bat === "number", card.lastBat);

  // 中継サーバーの拠点名(中郷第１樋管=cam02 / BAT 12.700V)が正しい拠点へ入っていること
  const mapped = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const pick = (id) => {
      const p = d.lastPointWith(d.siteStates[id].points, "bat");
      return p ? Math.round(p.bat * 1000) / 1000 : null;
    };
    return { cam02: pick("cam02"), cam42: pick("cam42"), cam41: pick("cam41"), cam45: pick("cam45"), cam44: pick("cam44") };
  });
  r.check("p2-i 中郷第１樋管のBATが12.7V", mapped.cam02 === 12.7, mapped);
  r.check("p2-j 白滝公園の値が桜川(cam42)へ入る", mapped.cam42 === 11.6, mapped);
  r.check("p2-k こも池(cam41)が12.6V", mapped.cam41 === 12.6, mapped);
  r.check("p2-l 竹倉用水路(cam45)が12.3V", mapped.cam45 === 12.3, mapped);
  r.check("p2-m ほたるの里(cam44)が12.0V", mapped.cam44 === 12.0, mapped);

  const pct = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const read = (id) => {
      const t = d.siteStates[id].batteryGaugeEl.querySelector(".battery-pct-text");
      return t ? t.textContent : null;
    };
    return { cam02: read("cam02"), cam41: read("cam41"), cam45: read("cam45"), cam44: read("cam44"), cam03: read("cam03") };
  });
  r.check("p3-a 12.7V→100.00%", pct.cam02 === "100.00%", pct);
  r.check("p3-b こも池 12.6V→91.67%", pct.cam41 === "91.67%", pct);
  r.check("p3-c 竹倉用水路 12.3V→66.67%", pct.cam45 === "66.67%", pct);
  r.check("p3-d ほたるの里 12.0V→41.67%", pct.cam44 === "41.67%", pct);
  r.check("p3-e 北沢アンダーパス 12.1V→81.25%(下限9.5V)", pct.cam03 === "81.25%", pct);

  // 表示順が河川別拠点一覧(上流→下流)と同じであること
  const order = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const ids = d.POWER_SITES_DISPLAY_ORDER.map((s) => s.id);
    const riverIds = d.RIVER_ORDER_SITES.map((s) => s.id).filter((id) => ids.includes(id));
    return { ids, riverIds };
  });
  r.check("p3-f カードの並びが河川順(上流→下流)と一致",
    JSON.stringify(order.ids) === JSON.stringify(order.riverIds), order);

  /* ---- Request V: 表示桁数(小数第2位)と差分の色(上昇=青 / 下降=赤) ---- */
  const digits = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const s = d.siteStates.cam02;
    const read = (diff) => {
      d.setStatDelta(s.pvDeltaEl, diff, "W");
      const cs = getComputedStyle(s.pvDeltaEl);
      return { text: s.pvDeltaEl.textContent, cls: s.pvDeltaEl.className, color: cs.color, weight: cs.fontWeight };
    };
    const up = read(0.5), down = read(-1.25), flat = read(0), tiny = read(-0.004);
    const svgTexts = Array.from(document.querySelectorAll("#pchart-bat-cam02 svg text")).map((t) => t.textContent);
    const tableRow = (document.querySelector("#tableBody tr") || { textContent: "" }).textContent;
    return {
      pv: s.pvValueEl.textContent, bat: s.batValueEl.textContent,
      gauge: s.batteryGaugeEl.querySelector(".battery-pct-text").textContent,
      up, down, flat, tiny, svgTexts, tableRow
    };
  });
  r.check("p7-a 発電(W)が小数第2位まで", /^\d+\.\d{2}W$/.test(digits.pv.replace(/\s/g, "")), digits.pv);
  r.check("p7-b BAT(V)が小数第2位まで", /^\d+\.\d{2}V$/.test(digits.bat.replace(/\s/g, "")), digits.bat);
  r.check("p7-c 残量%が小数第2位まで", /^\d+\.\d{2}%$/.test(digits.gauge), digits.gauge);
  r.check("p7-d グラフの目盛・端点ラベルも小数第2位",
    digits.svgTexts.some((t) => /^\d+\.\d{2}$/.test(t)) && digits.svgTexts.some((t) => /^\d+\.\d{2} V$/.test(t)), digits.svgTexts);
  r.check("p7-e 上昇は▲で青", digits.up.text.indexOf("▲") === 0 && digits.up.cls.includes("up"), digits.up);
  r.check("p7-f 下降は▼で赤", digits.down.text.indexOf("▼") === 0 && digits.down.cls.includes("down"), digits.down);
  r.check("p7-g 上昇と下降で色が違う", digits.up.color !== digits.down.color, { up: digits.up.color, down: digits.down.color });
  r.check("p7-h 変化なしは±で色を付けない",
    digits.flat.text.indexOf("±") === 0 && !digits.flat.cls.includes("up") && !digits.flat.cls.includes("down"), digits.flat);
  r.check("p7-i 差分の数値も小数第2位", /1\.25 W$/.test(digits.down.text) && /0\.50 W$/.test(digits.up.text), [digits.up.text, digits.down.text]);

  // 中継サーバーは約5分おきに行を追加するが機器側の更新は約11分おきのため、
  // 直前の点と同じ値になることが多い。増減が読み取れるよう、値が変わった点まで戻って比べる。
  const prevChanged = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const s = d.siteStates.cam02;
    const keep = s.points.slice();
    const now = Date.now();
    const mk = (minAgo, pv) => ({ fetchedAt: new Date(now - minAgo * 60000), measureTime: null,
      pv: pv, bat: 12.0, pvVoltage: null, waterLevelM: null, via: "t" });
    s.points = [mk(30, 5.0), mk(20, 6.5), mk(10, 7.25), mk(5, 7.25), mk(0, 7.25)];
    const last = d.lastPointWith(s.points, "pv");
    const changed = d.prevChangedPointWith(s.points, "pv", last);
    // 同じ値しか無い場合は比較先が無い
    s.points = [mk(10, 7.25), mk(5, 7.25), mk(0, 7.25)];
    const flatLast = d.lastPointWith(s.points, "pv");
    const flatPrev = d.prevChangedPointWith(s.points, "pv", flatLast);
    // さかのぼるのは既定で3時間まで
    s.points = [mk(400, 5.0), mk(10, 7.25), mk(0, 7.25)];
    const oldLast = d.lastPointWith(s.points, "pv");
    const tooOld = d.prevChangedPointWith(s.points, "pv", oldLast);
    s.points = keep;
    return { changed: changed ? changed.pv : null, flatPrev, tooOld, lookbackH: d.DELTA_LOOKBACK_MS / 3600000 };
  });
  r.check("p7-m 小数第2位で0.00になる差は「変化なし」扱い",
    digits.tiny.text.indexOf("±") === 0 && !digits.tiny.cls.includes("down"), digits.tiny);

  r.check("p7-j 同じ値が続く間はさかのぼって比較する", prevChanged.changed === 6.5, prevChanged);
  r.check("p7-k 同じ値しか無ければ比較先は無い", prevChanged.flatPrev === null, prevChanged);
  r.check("p7-l さかのぼるのは3時間まで", prevChanged.tooOld === null && prevChanged.lookbackH === 3, prevChanged);

  await page.close();

  /* ========== Request X: バッテリー劣化の指標(祇園大橋比の差の割合) ========== */
  const pageH = await newPage(null, {
    nowMs: NOW, matsuhisaBody: NO_BAT_BODY,
    batteryHealth: buildBatteryHealth({ nowMs: NOW, diff: { cam03: 0, cam02: 35, cam11: -20, cam04: 60, cam08: 20, cam41: 300 },
      loadW: { cam41: 0.6 } })
  });
  await openDashboard(pageH, () => {
    const d = window.__dashboardDebug;
    const st = d.getBatteryHealthState();
    return st && Object.keys(st.sites || {}).length > 0;
  });
  await pageH.evaluate(() => window.__dashboardDebug.showView("power"));
  await pageH.waitForTimeout(400);
  const health = await pageH.evaluate(() => {
    const d = window.__dashboardDebug;
    const read = (id) => {
      const s = d.siteStates[id];
      return { text: s.healthValueEl.textContent, cls: s.healthValueEl.className.replace("health-value", "").trim(),
        sub: s.healthSubEl.textContent, title: s.healthValueEl.parentElement.title.slice(0, 40) };
    };
    const mini = d.siteStates.cam02.thumbSlot;
    const kids = Array.from(mini.children).map((c) => c.className || "");
    const gaugeIdx = kids.findIndex((c) => String(c).indexOf("battery-gauge") >= 0);
    const healthIdx = kids.findIndex((c) => String(c).indexOf("battery-health") >= 0);
    const thumbIdx = kids.findIndex((c) => String(c).indexOf("site-thumb") >= 0);
    const svg = d.siteStates.cam02.batteryGaugeEl.querySelector("svg");
    return {
      ref: read("cam03"), up: read("cam02"), down: read("cam11"), bad: read("cam04"), none: read("cam09"),
      low: read("cam41"),
      kids, gaugeIdx, healthIdx, thumbIdx,
      gaugeW: svg ? Number(svg.getAttribute("width")) : null,
      count: document.querySelectorAll("#sitesGrid .battery-health").length,
      label: document.querySelector("#sitesGrid .battery-health .stat-label").textContent
    };
  });
  r.check("p8-a 全23拠点に劣化の表示がある", health.count === 23, health.count);
  r.check("p8-b 電池マークと拠点画像の間に置かれる",
    health.gaugeIdx >= 0 && health.healthIdx === health.gaugeIdx + 1 && health.thumbIdx === health.healthIdx + 1, health.kids);
  r.check("p8-c 電池マークを小さくしてある(幅84)", health.gaugeW === 84, health.gaugeW);
  r.check("p8-d 見出しは「劣化」", health.label === "劣化", health.label);
  r.check("p8-e 基準拠点(北沢アンダーパス)は「±0%」と「基準拠点」表記",
    health.ref.text === "±0%" && health.ref.sub === "基準拠点", health.ref);
  r.check("p8-f 基準より劣化はプラス表記", health.up.text === "+35%", health.up);
  r.check("p8-g 基準より持ちが良い場合はマイナス表記", health.down.text === "−20%", health.down);
  r.check("p8-h 大きく劣化は危険色", health.bad.cls === "critical", health.bad);
  r.check("p8-i 軽い劣化は注意色", health.up.cls === "warn", health.up);
  r.check("p8-j 基準より良い場合は良好色", health.down.cls === "ok", health.down);
  r.check("p8-k データが無い拠点は「—」", health.none.text === "—" && health.none.cls === "muted", health.none);
  r.check("p8-l 何との比較かを併記", health.up.sub === "基準比", health.up.sub);
  r.check("p8-m 算出根拠をtitleに出す", health.up.title.indexOf("前夜") === 0, health.up.title);
  r.check("p8-m2 消費が小さい拠点は参考値として淡色にする",
    health.low.cls === "muted" && health.low.text === "+300%", health.low);
  r.check("p8-m3 参考値には消費電力を併記する", health.low.sub === "参考 0.6W", health.low.sub);

  // 書式と色分けの単体確認
  const fmt = await pageH.evaluate(() => {
    const d = window.__dashboardDebug;
    return {
      f: [d.fmtBatteryHealth(0), d.fmtBatteryHealth(12), d.fmtBatteryHealth(-8), d.fmtBatteryHealth(null)],
      c: [d.batteryHealthClass(0, true), d.batteryHealthClass(5, false), d.batteryHealthClass(15, false),
        d.batteryHealthClass(40, false), d.batteryHealthClass(-10, false), d.batteryHealthClass(null, false),
        d.batteryHealthClass(300, false, true)]
    };
  });
  r.check("p8-n 書式: ±0% / +12% / −8% / —",
    JSON.stringify(fmt.f) === JSON.stringify(["±0%", "+12%", "−8%", "—"]), fmt.f);
  r.check("p8-o 色分けの境目(15%で注意・40%で危険・-10%で良好・低消費は参考)",
    JSON.stringify(fmt.c) === JSON.stringify(["", "", "warn", "critical", "ok", "muted", "muted"]), fmt.c);
  // 散布図(横軸=消費W / 縦軸=夜間降下V / 破線=全拠点の傾向)
  const scatter = await pageH.evaluate(() => {
    const box = document.getElementById("healthScatter");
    const svg = box.querySelector("svg");
    const texts = Array.from(svg.querySelectorAll("text")).map((t) => t.textContent);
    return {
      dots: svg.querySelectorAll("circle").length,
      dashed: svg.querySelectorAll('line[stroke-dasharray]').length,
      axisX: texts.includes("前夜の消費電力（W）"),
      axisY: texts.includes("前夜の電圧降下（V）"),
      fitLabel: texts.includes("全拠点の傾向"),
      note: document.getElementById("healthScatterNote").textContent
    };
  });
  r.check("p8-s 散布図に拠点の点が描かれる(指標のある6拠点)", scatter.dots === 6, scatter.dots);
  r.check("p8-t 傾向線を破線で引く", scatter.dashed >= 1 && scatter.fitLabel, scatter);
  r.check("p8-u 軸の意味を明記する", scatter.axisX && scatter.axisY, scatter);
  r.check("p8-v 読み方と対象の夜を説明する",
    scatter.note.indexOf("線より上") >= 0 && scatter.note.indexOf("前夜") >= 0, scatter.note.slice(0, 90));
  r.check("p8-w 傾向線の式を併記する", scatter.note.indexOf("降下 = ") >= 0, scatter.note.slice(-60));
  r.check("p8-x 基準拠点名を説明に出す", scatter.note.indexOf("基準: 北沢アンダーパス") >= 0, scatter.note.slice(0, 120));

  // グラフが枠に対して引き伸ばされていないこと(発電グラフを外して幅が広がった際の不具合対策)
  const aspect = await pageH.evaluate(() => {
    const box = document.getElementById("pchart-bat-cam02");
    const svg = box.querySelector("svg");
    const vb = (svg.getAttribute("viewBox") || "").split(" ").map(Number);
    const rect = box.getBoundingClientRect();
    return { ratio: (vb[2] / vb[3]) / (rect.width / rect.height) };
  });
  r.check("p8-y BATのグラフが横に伸びない(枠と同じ縦横比)", Math.abs(aspect.ratio - 1) < 0.02, aspect);

  r.check("p8-p ページ例外にはならない", pageH.errMsgs().length === 0, pageH.errMsgs());
  await pageH.close();

  // 指標のファイルが無くても電源監視は表示できる
  const pageH2 = await newPage(null, { nowMs: NOW, matsuhisaBody: NO_BAT_BODY });
  await openDashboard(pageH2);
  await pageH2.evaluate(() => window.__dashboardDebug.showView("power"));
  await pageH2.waitForTimeout(600);
  const noHealth = await pageH2.evaluate(() => {
    const d = window.__dashboardDebug;
    return { text: d.siteStates.cam02.healthValueEl.textContent,
      err: !!d.getBatteryHealthState().lastError,
      cards: document.querySelectorAll("#sitesGrid .card").length };
  });
  r.check("p8-q 指標が無い場合も画面は出る", noHealth.cards === 23 && noHealth.text === "—", noHealth);
  r.check("p8-r 読み込み失敗は記録される", noHealth.err, noHealth);
  await pageH2.close();

  /* ================= 2. Rangeリクエスト(末尾のみ取得) ================= */
  const seen = { head: 0, ranged: 0, full: 0, ranges: [] };
  const bigCsv = buildPowerCsv({ nowMs: NOW, count: 400 });
  const page2 = await newPage(null, {
    nowMs: NOW, matsuhisaBody: NO_BAT_BODY,
    powerCsvHandler: (route) => {
      const req = route.request();
      const range = req.headers()["range"];
      if (req.method() === "HEAD") {
        seen.head++;
        return route.fulfill({ status: 200, headers: { "Content-Length": String(Buffer.byteLength(bigCsv)), "Access-Control-Allow-Origin": "*" }, body: "" });
      }
      if (range) {
        seen.ranged++; seen.ranges.push(range);
        const start = parseInt(range.replace("bytes=", "").split("-")[0], 10);
        return route.fulfill({ status: 206, contentType: "text/csv", headers: { "Access-Control-Allow-Origin": "*" }, body: bigCsv.slice(start) });
      }
      seen.full++;
      route.fulfill({ contentType: "text/csv", headers: { "Access-Control-Allow-Origin": "*" }, body: bigCsv });
    }
  });
  await openDashboard(page2, () => {
    const d = window.__dashboardDebug;
    return d.siteStates.cam02 && d.siteStates.cam02.points.some((p) => typeof p.pv === "number");
  });
  r.check("p4-a 初回は全文を取得する", seen.full >= 1, seen);
  // 2回目以降は末尾のみ(HEADでサイズを調べてからRange)
  await page2.evaluate(() => window.__dashboardDebug.pollPowerSource({ tail: true }));
  await page2.waitForTimeout(300);
  r.check("p4-b 2回目はHEADでサイズを確認する", seen.head >= 1, seen);
  r.check("p4-c Rangeは「bytes=開始-」形式(CORSの単純リクエスト)",
    seen.ranges.length > 0 && seen.ranges.every((x) => /^bytes=\d+-$/.test(x)), seen.ranges);
  const rangeState = await page2.evaluate(() => window.__dashboardDebug.getPowerSourceState());
  r.check("p4-d Range対応と判定される", rangeState.rangeSupported === true, rangeState);
  r.check("p4-e 取得成功時刻が記録される", !!rangeState.lastOkAt, rangeState);
  await page2.close();

  /* ================= 3. プロキシへの退避 ================= */
  const proxyCsv = "Title: power\nMarkdown Content:\n" + buildPowerCsv({ nowMs: NOW, count: 3 });
  const page3 = await newPage(null, { nowMs: NOW, matsuhisaBody: NO_BAT_BODY, powerCsvStatus: 500, jinaBody: proxyCsv });
  await openDashboard(page3, () => {
    const d = window.__dashboardDebug;
    return d.siteStates.cam02 && d.siteStates.cam02.points.some((p) => typeof p.pv === "number");
  });
  const viaProxy = await page3.evaluate(() => {
    const d = window.__dashboardDebug;
    const p = d.lastPointWith(d.siteStates.cam02.points, "pv");
    return p ? { pv: p.pv, via: p.via } : null;
  });
  r.check("p5-a 直接取得が失敗してもプロキシ経由で取り込める", viaProxy && typeof viaProxy.pv === "number", viaProxy);
  r.check("p5-b プロキシ経由でも取得経路は中継サーバー扱い", viaProxy && viaProxy.via.includes("mini.lhlab-vps.net"), viaProxy);
  await page3.close();

  /* ================= 4. 取得できない場合 ================= */
  const page4 = await newPage(null, { nowMs: NOW, matsuhisaBody: NO_BAT_BODY, powerCsvStatus: 404, jinaBody: "Markdown Content:\nnot found" });
  await openDashboard(page4);
  await page4.waitForTimeout(1200);
  const noData = await page4.evaluate(() => {
    const d = window.__dashboardDebug;
    const s = d.siteStates.cam02;
    const t = s.batteryGaugeEl.querySelector(".battery-pct-text");
    return {
      pvPoints: s.points.filter((p) => typeof p.pv === "number").length,
      gauge: t ? t.textContent : null,
      error: d.getPowerSourceState().lastError,
      pvText: s.pvValueEl.textContent
    };
  });
  r.check("p6-a 発電(PV)の点は増えない", noData.pvPoints === 0, noData);
  r.check("p6-b 電池マークはデータ無し表示のまま", noData.gauge === "–", noData);
  r.check("p6-c エラーが記録される", !!noData.error, noData);
  r.check("p6-d ページ例外にはならない", page4.errMsgs().length === 0, page4.errMsgs());
  await page4.close();

  return r.finish();
}

if (process.argv[1] && process.argv[1].endsWith("test_power.mjs")) {
  run().then(async (c) => { await teardown(); process.exit(c.fail ? 1 : 0); });
}
