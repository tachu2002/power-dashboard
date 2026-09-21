// 電源監視ビューのテスト: 中継サーバーCSVの取り込み、カードの数値表示、
// 電池マーク(残量%)の描画位置、発電(W)の単位、取得失敗時の挙動。
import { setup, teardown, newPage, openDashboard, createReporter, buildPowerCsv, POWER_CSV_HEADER } from "./harness.mjs";

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
  r.check("p1-c 発電・BATのグラフが各23枚", cards.pvCharts === 23 && cards.batCharts === 23, cards);
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
