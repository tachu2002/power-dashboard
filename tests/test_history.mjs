// サーバー保存データ(data/recent.csv・data/recent_water.csv)の読み込みと統合のテスト。
//  - CSVの列解釈(7列形式・旧6列形式)
//  - 発電(PV)の単位切り替え対策: 中継サーバー由来の行だけをPV(W)として採用する(Phase L)
//  - 中継サーバーCSVとの統合(同時刻の点を壊さない)
import { setup, teardown, newPage, openDashboard, createReporter } from "./harness.mjs";

const NOW = Date.now();
const HEADER = "拠点,取得時刻,機器の計測時刻,PV(W),BAT(V),水位(m),取得方法";
const VIA_RELAY = "サーバー(mini.lhlab-vps.net 電源CSV)";
const VIA_DIRECT = "サーバー(直接取得)";

function row(siteId, tMs, pv, bat, water, via) {
  return [siteId, new Date(tMs).toISOString(), "", pv, bat, water, via].join(",");
}

export async function run() {
  const r = createReporter("test_history");
  await setup();

  const t0 = NOW - 6 * 60 * 60 * 1000;
  const step = 10 * 60 * 1000;
  const lines = [HEADER];
  for (let i = 0; i < 20; i++) {
    // 水位はmatsuhisa側(直接取得)、電源は中継サーバー側の行として交互に記録される実運用を再現
    lines.push(row("cam02", t0 + i * step, "", "12.4", (0.8 + i * 0.01).toFixed(3), VIA_DIRECT));
    lines.push(row("cam02", t0 + i * step, (4 + i * 0.1).toFixed(3), "12.5", "", VIA_RELAY));
  }
  lines.push(row("cam99", t0, "1.0", "12.0", "0.5", VIA_RELAY)); // 未知の拠点
  const recent = lines.join("\n") + "\n";

  const waterLines = [HEADER];
  for (let i = 0; i < 30; i++) {
    waterLines.push(row("cam02", t0 - (30 - i) * 60 * 60 * 1000, "", "", (0.7 + i * 0.002).toFixed(3), VIA_DIRECT));
  }
  const recentWater = waterLines.join("\n") + "\n";

  const page = await newPage(null, { nowMs: NOW, recentCsv: recent, recentWaterCsv: recentWater, powerCsvStatus: 404 });
  await openDashboard(page, () => {
    const d = window.__dashboardDebug;
    return d.siteStates.cam02 && d.siteStates.cam02.points.length > 20;
  });

  /* ---- 1. CSVの解釈 ---- */
  const parsed = await page.evaluate((args) => {
    const d = window.__dashboardDebug;
    const rows = d.parseCsvRows(args.csv);
    const old6 = d.parseCsvRows("拠点,取得時刻,機器の計測時刻,PV(V),BAT(V),取得方法\n" +
      "cam02,2026-09-19T00:00:00.000Z,,18.500,12.400,サーバー(直接取得)");
    return {
      count: rows.length,
      relay: rows.find((x) => x.via.indexOf("mini.lhlab-vps.net") >= 0),
      direct: rows.find((x) => x.via === "サーバー(直接取得)"),
      unknown: rows.filter((x) => x.siteId === "cam99").length,
      old6First: old6[0]
    };
  }, { csv: recent });
  r.check("h1-a 7列形式のCSVを解釈できる", parsed.count === 41, parsed.count);
  r.check("h1-b 中継サーバー由来の行はPVを電力(W)として採用",
    typeof parsed.relay.pv === "number" && parsed.relay.pvVoltage === null, parsed.relay);
  r.check("h1-c 中継サーバー以外の行のPVは採用しない(単位が違うため)",
    parsed.direct.pv === null, parsed.direct);
  r.check("h1-d 水位は水位列から取る", typeof parsed.direct.waterLevelM === "number", parsed.direct);
  r.check("h1-e BATはどちらの経路でも採用する", typeof parsed.direct.bat === "number", parsed.direct);
  r.check("h1-f 旧6列形式のPVは発電電圧として扱う",
    parsed.old6First.pv === null && parsed.old6First.pvVoltage === 18.5, parsed.old6First);
  r.check("h1-g 未知の拠点の行も解釈自体はできる(統合時に落とす)", parsed.unknown === 1, parsed.unknown);

  /* ---- 2. 状態への統合 ---- */
  const merged = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const s = d.siteStates.cam02;
    const times = s.points.map((p) => p.fetchedAt.getTime());
    return {
      total: s.points.length,
      sorted: times.every((t, i) => i === 0 || t >= times[i - 1]),
      unique: new Set(times).size === times.length,
      water: s.points.filter((p) => typeof p.waterLevelM === "number").length,
      pv: s.points.filter((p) => typeof p.pv === "number").length,
      bat: s.points.filter((p) => typeof p.bat === "number").length,
      unknownSite: !!d.siteStates.cam99,
      baseline: s.baselineLevelM,
      fixedBaseline: d.FIXED_BASELINE_OVERRIDE.cam14,
      max: d.MAX_STORED_POINTS
    };
  });
  r.check("h2-a 取り込んだ点が時刻順に並ぶ", merged.sorted, merged);
  r.check("h2-b 同一時刻の点が重複しない", merged.unique, merged);
  r.check("h2-c 水位1か月分(30点)も取り込まれる", merged.water >= 30, merged);
  r.check("h2-d 発電(W)の点が取り込まれる", merged.pv >= 20, merged);
  r.check("h2-e BATの点が取り込まれる", merged.bat >= 20, merged);
  r.check("h2-f 未知の拠点は無視される", merged.unknownSite === false, merged);
  r.check("h2-g 基準(最低)水位が再計算される", typeof merged.baseline === "number", merged.baseline);
  r.check("h2-i 基準水位が実測の最小値になる", merged.baseline <= 0.8 + 1e-9, merged.baseline);
  r.check("h2-j 多呂樋管は固定の基準水位を使う", merged.fixedBaseline === 0.06, merged.fixedBaseline);
  r.check("h2-h 保持点数の上限が設定されている", merged.max > 0, merged.max);

  /* ---- 3. 中継サーバーCSVとの統合(同時刻の点を壊さない) ---- */
  const combined = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const s = d.siteStates.cam02;
    // 水位だけを持つ既存の点と同じ時刻で、電源だけを持つ行を取り込む
    const target = s.points.filter((p) => typeof p.waterLevelM === "number").pop();
    const t = target.fetchedAt.getTime();
    const before = { water: target.waterLevelM, pv: target.pv, bat: target.bat };
    d.mergePowerHistory([{ siteId: "cam02", fetchedAt: new Date(t), pv: 33.3, bat: 12.34, pvVoltage: 18.1, loadW: 10, via: "mini.lhlab-vps.net" }]);
    const after = s.points.find((p) => p.fetchedAt.getTime() === t);
    return { before, after: { water: after.waterLevelM, pv: after.pv, bat: after.bat } };
  });
  r.check("h3-a 同時刻の点へ電源値を上書きできる",
    combined.after.pv === 33.3 && combined.after.bat === 12.34, combined);
  r.check("h3-b 既存の水位は消えない", combined.after.water === combined.before.water, combined);

  const inserted = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const s = d.siteStates.cam02;
    const n = s.points.length;
    const t = Date.now() - 60 * 1000;
    d.mergePowerHistory([{ siteId: "cam02", fetchedAt: new Date(t), pv: 7.7, bat: 12.6, pvVoltage: null, loadW: null, via: "mini.lhlab-vps.net" }]);
    const p = s.points.find((x) => x.fetchedAt.getTime() === t);
    return { grew: s.points.length === n + 1, found: !!p, pv: p && p.pv, bat: p && p.bat, water: p && p.waterLevelM };
  });
  r.check("h3-c 既存に無い時刻は新しい点として追加される", inserted.grew, inserted);
  r.check("h3-d 追加された点は電源値のみを持つ",
    inserted.pv === 7.7 && inserted.bat === 12.6 && inserted.water === null, inserted);

  /* ---- 4. グラフへの反映 ---- */
  await page.evaluate(() => window.__dashboardDebug.showView("graphlist"));
  await page.waitForTimeout(400);
  const graph = await page.evaluate(() => {
    const cards = document.querySelectorAll("#graphGrid .simple-card");
    const svgs = document.querySelectorAll("#graphGrid svg");
    return { cards: cards.length, svgs: svgs.length };
  });
  r.check("h4-a 水位グラフ一覧が描画される", graph.cards > 0, graph);
  r.check("h4-b グラフが描かれている拠点がある", graph.svgs > 0, graph);

  const table = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    d.showView("waterdata");
    return document.querySelectorAll("#waterTableBody tr").length;
  });
  r.check("h4-c 水位データ一覧に行が並ぶ", table > 0, table);

  r.check("h5-a ページ例外が発生しない", page.errMsgs().length === 0, page.errMsgs());
  await page.close();

  /* ---- 5. サーバー保存データが無い場合(初回セットアップ前) ---- */
  const page2 = await newPage(null, { nowMs: NOW, powerCsvStatus: 404 });
  await openDashboard(page2);
  await page2.waitForTimeout(1200);
  const none = await page2.evaluate(() => {
    const d = window.__dashboardDebug;
    return { loaded: typeof d.loadServerHistory === "function", points: d.siteStates.cam02.points.length };
  });
  r.check("h6-a CSVが存在しなくても起動する", none.loaded, none);
  r.check("h6-b ページ例外にはならない", page2.errMsgs().length === 0, page2.errMsgs());
  const retZero = await page2.evaluate(async () => {
    const d = window.__dashboardDebug;
    return [await d.loadServerHistory(), await d.loadServerWaterHistory()];
  });
  r.check("h6-c 読み込み失敗時は0件として扱う", retZero[0] === 0 && retZero[1] === 0, retZero);
  await page2.close();

  return r.finish();
}

if (process.argv[1] && process.argv[1].endsWith("test_history.mjs")) {
  run().then(async (c) => { await teardown(); process.exit(c.fail ? 1 : 0); });
}
