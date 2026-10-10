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

  /* ===== バッテリーの持ち(無日射で何時間もつか) ＋ カードのレイアウト ===== */
  // 日射予報を落として「日射ゼロ時」の表示(見通しが出せないときの控え)を検証する。
  // 予報込みの見通しそのものは test_forecast.mjs の f7-* で見る。
  const pageH = await newPage(null, {
    nowMs: NOW, matsuhisaBody: NO_BAT_BODY, openMeteoStatus: 500,
    batteryHealth: buildBatteryHealth({ nowMs: NOW })
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
        sub: s.healthSubEl.textContent, title: s.healthValueEl.parentElement.title.slice(0, 220) };
    };
    const mini = d.siteStates.cam02.thumbSlot;
    const kids = Array.from(mini.children).map((c) => c.className || "");
    const gaugeIdx = kids.findIndex((c) => String(c).indexOf("battery-gauge") >= 0);
    const healthIdx = kids.findIndex((c) => String(c).indexOf("battery-health") >= 0);
    const thumbIdx = kids.findIndex((c) => String(c).indexOf("site-thumb") >= 0);
    const svg = d.siteStates.cam02.batteryGaugeEl.querySelector("svg");
    return {
      ok: read("cam11"), warn: read("cam03"), bad: read("cam09"), long: read("cam41"),
      mains: read("cam12"), pending: read("cam13"), none: read("cam02"),
      kids, gaugeIdx, healthIdx, thumbIdx,
      gaugeW: svg ? Number(svg.getAttribute("width")) : null,
      count: document.querySelectorAll("#sitesGrid .battery-health").length,
      label: document.querySelector("#sitesGrid .battery-health .stat-label").textContent
    };
  });
  r.check("p8-a 全23拠点に持ちの表示がある", health.count === 23, health.count);
  r.check("p8-b 電池マークと拠点画像の間に置かれる",
    health.gaugeIdx >= 0 && health.healthIdx === health.gaugeIdx + 1 && health.thumbIdx === health.healthIdx + 1, health.kids);
  r.check("p8-c 電池マークを小さくしてある(幅84)", health.gaugeW === 84, health.gaugeW);
  r.check("p8-d 見出しは「持ち」", health.label === "持ち", health.label);
  // 50Ah × (80% − 下限11.5V相当の9.3%) ÷ 1.00A = 35h
  r.check("p8-e 持ち時間を時間で出す（丸一日以上は既定色）",
    health.ok.text === "35h" && health.ok.sub === "日射ゼロ時" && health.ok.cls === "", health.ok);
  // 放電末期の見積りは実測(多呂樋管 9/30: 11.28→10.55V で容量の約1割)に合わせて 10.5V=−10%・9.0V=−12%。
  // 北沢は下限9.5V(=残量−11.3%)なので 50Ah × (30+11.3)% ÷ 0.96A = 22h → 24h未満は注意色
  r.check("p8-f 丸一日もたない拠点は注意色", health.warn.text === "22h" && health.warn.cls === "warn", health.warn);
  // 梅名2号は下限10.5V(=残量−10%)なので 15Ah × (50+10)% ÷ 1.60A = 5.6h → 12h未満は危険色
  r.check("p8-g 一晩もたない拠点は危険色", health.bad.text === "5.6h" && health.bad.cls === "critical", health.bad);
  // 14Ah × (86-20)% ÷ 0.07A = 132h → 48時間を超えたら「日」表記
  r.check("p8-h 2日以上もつ拠点は「日」表記で良好色",
    health.long.text.endsWith("日") && health.long.cls === "ok", health.long);
  r.check("p8-i 常時電源の拠点は「常時」と出す",
    health.mains.text === "常時" && health.mains.sub === "常時電源" && health.mains.cls === "ok", health.mains);
  r.check("p8-j 日数が足りない拠点は「測定中」",
    health.pending.text === "測定中" && health.pending.cls === "muted", health.pending);
  r.check("p8-k 指標に出ていない拠点は「—」",
    health.none.text === "—" && health.none.cls === "muted" && health.none.sub === "データなし", health.none);
  r.check("p8-m 算出根拠(容量・夜間電流・残量・下限電圧)をtitleに出す",
    health.ok.title.indexOf("実効容量") >= 0 && health.ok.title.indexOf("夜間の平均消費") >= 0
    && health.ok.title.indexOf("残量") >= 0 && health.ok.title.indexOf("下限 11.50V") >= 0, health.ok.title);
  r.check("p8-m3 下限電圧が低い拠点はその電圧をtitleに出す",
    health.warn.title.indexOf("下限 9.50V") >= 0, health.warn.title.slice(0, 80));
  r.check("p8-m2 測定中の理由をtitleで説明する",
    health.pending.title.indexOf("日数がたまるまで") >= 0, health.pending.title);

  // 書式と色分けの単体確認
  const fmt = await pageH.evaluate(() => {
    const d = window.__dashboardDebug;
    return {
      f: [d.fmtEndurance(9.46), d.fmtEndurance(23.2), d.fmtEndurance(47.9), d.fmtEndurance(132), d.fmtEndurance(null)],
      c: [d.enduranceClass(11.9), d.enduranceClass(12), d.enduranceClass(23.9), d.enduranceClass(24),
        d.enduranceClass(47.9), d.enduranceClass(48), d.enduranceClass(null)]
    };
  });
  r.check("p8-n 書式: 9.5h / 23h / 48h / 5.5日 / —",
    JSON.stringify(fmt.f) === JSON.stringify(["9.5h", "23h", "48h", "5.5日", "—"]), fmt.f);
  r.check("p8-o 色分けの境目(12h未満=危険・24h未満=注意・48h以上=良好)",
    JSON.stringify(fmt.c) === JSON.stringify(["critical", "warn", "warn", "", "", "ok", "muted"]), fmt.c);

  // 上段の「バッテリーの持ち比較」= あと何時間もつかの横棒。短い順に並べる。
  const bars = await pageH.evaluate(() => {
    const box = document.getElementById("healthScatter");
    const svg = box.querySelector("svg");
    const texts = Array.from(svg.querySelectorAll("text")).map((t) => t.textContent);
    const barEls = Array.from(svg.querySelectorAll("rect.endurance-bar"));
    return {
      bars: barEls.length,
      order: barEls.map((b) => b.getAttribute("data-site")),
      widths: barEls.map((b) => Math.round(Number(b.getAttribute("width")))),
      names: Array.from(svg.querySelectorAll("text.endurance-name")).map((t) => t.textContent),
      values: Array.from(svg.querySelectorAll("text.endurance-value")).map((t) => t.textContent),
      thresholds: ["12h", "1日", "2日"].filter((t) => texts.includes(t)).length,
      hasNow: texts.includes("今"),
      note: document.getElementById("healthScatterNote").textContent,
      boxH: Math.round(box.getBoundingClientRect().height)
    };
  });
  r.check("p8-s 値が出ている拠点ぶんの横棒が並ぶ(4拠点)", bars.bars === 4, bars);
  r.check("p8-t 危ない順(短い順)に上から並べる",
    JSON.stringify(bars.order) === JSON.stringify(["cam09", "cam03", "cam11", "cam41"]), bars.order);
  r.check("p8-t2 持ちが短い拠点ほど棒が短い",
    bars.widths[0] < bars.widths[1] && bars.widths[1] < bars.widths[2], bars.widths);
  r.check("p8-u 12時間・24時間・48時間の目盛りがある",
    bars.thresholds === 3 && bars.hasNow, bars);
  r.check("p8-u2 拠点名と値を並べて出す",
    bars.names.length === 4 && bars.values.length === 4
    && bars.values[0].indexOf("5.6h") === 0 && bars.values[3].indexOf("日") > 0, bars);
  r.check("p8-v 読み方と更新間隔を説明する",
    bars.note.indexOf("あと何時間もつか") >= 0 && bars.note.indexOf("短い順") >= 0
    && bars.note.indexOf("10分ごとに計算し直しています") >= 0, bars.note.slice(0, 140));
  r.check("p8-x 常時電源の拠点は対象外と明記する",
    bars.note.indexOf("常時電源") >= 0, bars.note.slice(-60));
  r.check("p8-x2 拠点数に合わせて高さを決める", bars.boxH >= 160, bars.boxH);
  r.check("p8-x3 日射ゼロ前提の拠点は※印で区別し、説明を添える",
    bars.values.every((v) => v.indexOf("※") > 0) && bars.note.indexOf("※印") >= 0, bars.values);

  /* ===== いま見るべき拠点(2026-10 デザイン見直し) =====
     持ち比較と同じ判定で、先頭に「停止中／12時間もたない／24時間もたない／余裕あり」を並べる。
     カードの並びは河川順が既定で、「並び：危ない順」で持ち比較と同じ順になる。 */
  const strip = await pageH.evaluate(async () => {
    const box = document.getElementById("attentionStrip");
    const tiles = Array.from(box.querySelectorAll(".attention-tile")).map((t) => ({
      title: t.querySelector(".attention-title").textContent,
      n: Number(t.querySelector(".attention-count .n").textContent),
      chips: Array.from(t.querySelectorAll(".attention-chip .nm")).map((c) => c.textContent),
      lit: t.classList.contains("has-items")
    }));
    const barOrder = Array.from(document.querySelectorAll("#healthScatter rect.endurance-bar")).map((b) => b.getAttribute("data-site"));
    const grid = document.getElementById("sitesGrid");
    const orderOf = () => Array.from(grid.children).filter((c) => c.style.order !== "")
      .sort((a, b) => Number(a.style.order) - Number(b.style.order))
      .map((c) => c.querySelector("#" + CSS.escape(c.querySelector(".chart-box").id)).id.replace("pchart-bat-", ""));
    const btn = document.getElementById("powerSortBtn");
    const before = { label: btn.textContent, ordered: orderOf().length };
    btn.click();
    const after = { label: btn.textContent, order: orderOf().slice(0, barOrder.length) };
    btn.click();
    const back = { label: btn.textContent, ordered: orderOf().length };
    const first = grid.querySelector('[data-endurance="critical"]');
    return { hidden: box.hidden, tiles, barOrder, before, after, back,
      critCard: !!first, total: tiles.reduce((m, t) => m + t.n, 0) };
  });
  r.check("d1-a 先頭に4つの区分(停止中・12時間・24時間・余裕あり)を言葉で出す",
    !strip.hidden && JSON.stringify(strip.tiles.map((t) => t.title))
      === JSON.stringify(["停止中", "12時間もたない", "24時間もたない", "余裕あり"]), strip.tiles);
  r.check("d1-b 区分の件数の合計は持ち比較の本数と同じ", strip.total === strip.barOrder.length, strip);
  r.check("d1-c 12時間もたない拠点(梅名樋管2号 5.6h)は名前のチップで出し、その区分だけ色を付ける",
    strip.tiles[1].n >= 1 && strip.tiles[1].chips.some((c) => c.indexOf("梅名樋管2号") === 0) && strip.tiles[1].lit
    && !strip.tiles[0].lit, strip.tiles);
  r.check("d1-d カードに区分を持たせる(上端の色帯・「12h未満」の札に使う)", strip.critCard, strip);
  r.check("d1-e カードの並びは河川順が既定で、「危ない順」にすると持ち比較と同じ順になり、戻せる",
    strip.before.label === "並び：河川順" && strip.before.ordered === 0
    && strip.after.label === "並び：危ない順" && JSON.stringify(strip.after.order) === JSON.stringify(strip.barOrder)
    && strip.back.label === "並び：河川順" && strip.back.ordered === 0, strip);

  /* ===== バッテリー健全性の一覧(「健全性の一覧」ボタン) =====
     天気・夜間降下を織り込んだ持ち時間を先頭に、実測(最低電圧・深放電)と
     容量の変化を1つの表にまとめたもの。劣化率は季節の影響と切り分けられないため、
     参考値である旨を画面に明記していることまで含めて検証する。 */
  const pageHT = await newPage(null, {
    nowMs: NOW, matsuhisaBody: NO_BAT_BODY, openMeteoStatus: 500,
    batteryHealth: buildBatteryHealth({
      nowMs: NOW, days: 109, longTermFrom: "2026-06-13", longTermTo: "2026-09-29",
      sites: {
        // 下限11.5V・深放電が増えている拠点(要対応)
        cam11: { capacityAh: 50, nightA: 1.00, socPct: 80, vmin: 11.85, deep: 13, deepPrev: 2,
          capacityInitialAh: 71, capacityNowAh: 50, genWhPerDay: 96, loadWhPerDay: 81,
          pvPeakNowW: 18.0, pvPeakInitialW: 18.2 },
        // 下限9.5V。余裕は大きいが持ち時間は短い
        cam03: { capacityAh: 50, nightA: 0.96, socPct: 30, vmin: 12.05, deep: 0, deepPrev: 0,
          capacityInitialAh: 62, capacityNowAh: 50, genWhPerDay: 75, loadWhPerDay: 88,
          pvPeakNowW: 12.1, pvPeakInitialW: 15.3, mvPerAhNow: 31.4, mvPerAhPrev: 25.0 },
        // 下限10.5V。持ちが12時間未満
        cam09: { capacityAh: 15, nightA: 1.60, socPct: 50, vmin: 11.90, deep: 5, deepPrev: 9,
          genWhPerDay: 90, loadWhPerDay: 117, lastSwapAt: "2026-09-11" },
        // 良好
        cam41: { capacityAh: 14, nightA: 0.07, socPct: 86, vmin: 12.46, deep: 0, deepPrev: 0,
          capacityInitialAh: 19.7, capacityNowAh: 14, genWhPerDay: 28, loadWhPerDay: 16,
          mvPerAhNow: 66.0, mvPerAhPrev: 65.0 },
        cam12: { mains: true, v0: 13.45 },
        cam13: { fitR: 0.41 }
      }
    })
  });
  await openDashboard(pageHT, () => {
    const st = window.__dashboardDebug.getBatteryHealthState();
    return st && Object.keys(st.sites || {}).length > 0;
  });
  await pageHT.evaluate(() => window.__dashboardDebug.showView("power"));
  await pageHT.waitForTimeout(400);
  const ht0 = await pageHT.evaluate(() => ({
    hidden: !document.getElementById("healthTableCard").classList.contains("show"),
    btn: document.getElementById("healthTableBtn").textContent
  }));
  r.check("p8-h1 一覧は既定では畳んである", ht0.hidden && ht0.btn === "健全性の一覧", ht0);
  const ht = await pageHT.evaluate(() => {
    document.getElementById("healthTableBtn").click();
    const card = document.getElementById("healthTableCard");
    const rows = Array.from(document.querySelectorAll("#healthTableBody tr"));
    const cellsOf = (tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent.trim());
    return {
      shown: card.classList.contains("show"),
      btn: document.getElementById("healthTableBtn").textContent,
      order: rows.map((tr) => tr.getAttribute("data-site")),
      pills: rows.map((tr) => tr.querySelector(".ht-pill") && tr.querySelector(".ht-pill").textContent),
      cells: rows.map(cellsOf),
      headers: Array.from(document.querySelectorAll(".health-table th")).map((th) => th.textContent),
      caveat: document.getElementById("healthTableCaveat").textContent,
      note: document.getElementById("healthTableNote").textContent,
      explain: document.querySelector(".health-note").textContent
    };
  });
  const rowOf = (id) => ht.cells[ht.order.indexOf(id)];
  r.check("p8-h2 ボタンで開き、常時電源(cam12)を除いた拠点が並ぶ",
    ht.shown && ht.btn === "一覧を隠す" && ht.order.indexOf("cam12") < 0 && ht.order.length === 5, ht.order);
  r.check("p8-h3 危ない順(持ち時間の短い順)に並べる",
    ht.order[0] === "cam09" && ht.order[1] === "cam03" && ht.order.indexOf("cam13") === ht.order.length - 1, ht.order);
  r.check("p8-h4 下限までの余裕は拠点ごとの下限で出す(cam03は9.5V基準で2.55V)",
    rowOf("cam03")[4].indexOf("2.55") >= 0 && rowOf("cam03")[4].indexOf("下限9.5V") > 0, rowOf("cam03").slice(3, 5));
  r.check("p8-h5 深放電した日を前30日と比べて増減の向きを出す",
    rowOf("cam11")[5].indexOf("13日") === 0 && rowOf("cam11")[5].indexOf("▲") > 0
    && rowOf("cam11")[5].indexOf("2日") > 0 && rowOf("cam09")[5].indexOf("▼") > 0,
    [rowOf("cam11")[5], rowOf("cam09")[5]]);
  r.check("p8-h6 実効容量は実測値と推定定格を並べて出す",
    rowOf("cam11")[8].indexOf("50Ah") === 0 && rowOf("cam11")[8].indexOf("定格 50Ah") > 0, rowOf("cam11")[8]);
  r.check("p8-h7 定格比(SOH)を%で出す",
    rowOf("cam11")[9] === "100%" && rowOf("cam41")[9] === "70%", [rowOf("cam11")[9], rowOf("cam41")[9]]);
  r.check("p8-h8 1日の収支と消費を出す(cam09は−27Wh/117Wh)",
    rowOf("cam09")[6] === "-27" && rowOf("cam09")[7] === "117", rowOf("cam09").slice(6, 8));
  r.check("p8-h9 へたり(1Ahあたりの降下)は増えていれば▲を付ける",
    rowOf("cam03")[10].indexOf("31") === 0 && rowOf("cam03")[10].indexOf("▲") > 0
    && rowOf("cam03")[10].indexOf("25") > 0 && rowOf("cam41")[10].indexOf("▲") < 0,
    [rowOf("cam03")[10], rowOf("cam41")[10]]);
  r.check("p8-h9b 交換を検出した拠点は日付を出す",
    rowOf("cam09")[11].indexOf("09/11") === 0 && rowOf("cam11")[11] === "—",
    [rowOf("cam09")[11], rowOf("cam11")[11]]);
  r.check("p8-h10 状態は要対応/注意/良好で示す",
    ht.pills[ht.order.indexOf("cam11")] === "要対応" && ht.pills[ht.order.indexOf("cam41")] === "良好",
    ht.pills);
  r.check("p8-h11 劣化の目安が参考値であることと、季節の影響を画面に明記する",
    ht.caveat.indexOf("参考値") >= 0 && ht.caveat.indexOf("夏") >= 0 && ht.caveat.indexOf("秋") >= 0
    && ht.caveat.indexOf("下限までの余裕") >= 0 && ht.caveat.indexOf("深放電した日") >= 0, ht.caveat.slice(0, 120));
  r.check("p8-h12 各列の根拠を説明する",
    ht.explain.indexOf("直近35日") >= 0 && ht.explain.indexOf("11.8V") >= 0
    && ht.explain.indexOf("下限は拠点ごとに異なります") >= 0, ht.explain.slice(0, 120));
  r.check("p8-h13 日次データの日数を添える", ht.note.indexOf("109日分") >= 0, ht.note);
  r.check("p8-h14 ページ例外にはならない", pageHT.errMsgs().length === 0, pageHT.errMsgs());
  await pageHT.close();

  // グラフが枠に対して引き伸ばされていないこと(発電グラフを外して幅が広がった際の不具合対策)
  const aspect = await pageH.evaluate(() => {
    const box = document.getElementById("pchart-bat-cam02");
    const svg = box.querySelector("svg");
    const vb = (svg.getAttribute("viewBox") || "").split(" ").map(Number);
    const rect = box.getBoundingClientRect();
    return { ratio: (vb[2] / vb[3]) / (rect.width / rect.height), vb: vb.slice(2), box: [Math.round(rect.width), Math.round(rect.height)] };
  });
  r.check("p8-y BATのグラフが横に伸びない(枠と同じ縦横比)", Math.abs(aspect.ratio - 1) < 0.02, aspect);

  /* ===== 案B: 余白を捨てないカードレイアウト(数値2段＋画像ぶち抜き) ===== */
  // 以前は1行のflexで、幅が足りないと画像だけが次行へ折り返し、その左に196×62pxの空白ができていた。
  const layout = await pageH.evaluate(() => {
    const SRC = "data:image/svg+xml;utf8," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#7fa98c"/></svg>');
    const card = document.querySelector("#sitesGrid .card");
    const mini = card.querySelector(".mini-stats");
    let img = mini.querySelector(".site-thumb");
    if (!img) { img = document.createElement("img"); img.className = "site-thumb"; mini.appendChild(img); }
    img.src = SRC;
    return new Promise((resolve) => setTimeout(() => {
      const mb = mini.getBoundingClientRect();
      const rows = {};
      Array.from(mini.children).forEach((c) => {
        const b = c.getBoundingClientRect();
        const key = Math.round((b.top - mb.top) / 10);
        (rows[key] = rows[key] || []).push(String(c.className || c.tagName).split(" ")[0]);
      });
      const t = img.getBoundingClientRect();
      resolve({
        display: getComputedStyle(mini).display,
        cols: getComputedStyle(mini).gridTemplateColumns.split(" ").length,
        miniH: Math.round(mb.height),
        thumb: { w: Math.round(t.width), h: Math.round(t.height), left: Math.round(t.left - mb.left) },
        rowCount: Object.keys(rows).length,
        cardH: Math.round(card.getBoundingClientRect().height),
        hasUrlLine: !!card.querySelector(".site-card-header > .site-title-wrap > a.site-link"),
        titleIsLink: !!card.querySelector(".site-card-header h2 a.site-link")
      });
    }, 500));
  });
  r.check("p8-z1 数値はgridで2段に置く", layout.display === "grid" && layout.cols === 3, layout);
  // 画像がまだ来ていない拠点でも並びが変わらないこと(自動配置だと電池マークが繰り上がる)
  const noImg = await pageH.evaluate(() => {
    const card = Array.from(document.querySelectorAll("#sitesGrid .card"))
      .find((c) => !c.querySelector(".site-thumb"));
    if (!card) return { skipped: true };
    const mini = card.querySelector(".mini-stats");
    const mb = mini.getBoundingClientRect();
    const g = mini.querySelector(".battery-gauge").getBoundingClientRect();
    const first = mini.children[0].getBoundingClientRect();
    return { gaugeLeft: Math.round(g.left - mb.left), gaugeTop: Math.round(g.top - mb.top),
      firstLeft: Math.round(first.left - mb.left), firstTop: Math.round(first.top - mb.top) };
  });
  r.check("p8-z1b 画像が無い拠点でも電池マークは2段目の左に留まる",
    noImg.skipped || (noImg.gaugeLeft === noImg.firstLeft && noImg.gaugeTop > noImg.firstTop), noImg);
  r.check("p8-z2 画像は右に2段ぶち抜き（折り返さない）",
    layout.thumb.w === 116 && layout.thumb.h === 88 && layout.thumb.h <= layout.miniH, layout.thumb);
  r.check("p8-z3 数値行の高さが中身ぶんに収まる(以前は131px)", layout.miniH <= 115, layout.miniH);
  r.check("p8-z4 カード全体が短くなる(以前は389px)", layout.cardH <= 345, layout.cardH);
  r.check("p8-z5 URLは別行に出さず拠点名をリンクにする",
    layout.hasUrlLine === false && layout.titleIsLink === true, layout);

  // 縦軸は「実データ＋定格線」に薄く余白を足した範囲。以前はキリの良い値まで広げて上下6割が空白だった。
  const axis = await pageH.evaluate(() => {
    const svg = document.getElementById("pchart-bat-cam02").querySelector("svg");
    const texts = Array.from(svg.querySelectorAll("text")).map((t) => t.textContent);
    const nums = texts.filter((t) => /^\d+\.\d\d$/.test(t)).map(Number);
    const ratedEl = Array.from(svg.querySelectorAll("text")).find((t) => t.textContent.indexOf("定格") === 0);
    return { ticks: nums,
      ratedAnchor: ratedEl ? ratedEl.getAttribute("text-anchor") : null,
      ratedX: ratedEl ? Number(ratedEl.getAttribute("x")) : null,
      vbW: Number((svg.getAttribute("viewBox") || "0 0 0 0").split(" ")[2]) };
  });
  r.check("p8-z6 目盛りが粗くなりすぎない(4本以上)", axis.ticks.length >= 4, axis.ticks);
  r.check("p8-z7 定格線のラベルは右端に置く",
    axis.ratedAnchor === "end" && axis.ratedX > axis.vbW * 0.6, axis);

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
