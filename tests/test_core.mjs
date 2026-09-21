// 基礎部分のテスト: 拠点カタログ・純粋関数(バッテリー換算 / 電源CSV解析 / 気象庁時刻 /
// グラフ座標計算 / 最小二乗法 / グラフ用点の抽出)。
// すべてリポジトリ直下の実物の index.html を読み込んで検証する。
import { setup, teardown, newPage, openDashboard, createReporter, buildPowerCsv, POWER_CSV_HEADER } from "./harness.mjs";

export async function run() {
  const r = createReporter("test_core");
  await setup();
  const page = await newPage();
  await openDashboard(page);

  /* ---- 1. 拠点カタログ ---- */
  const catalog = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    return {
      all: d.ALL_SITES.length,
      power: d.POWER_SITES.length,
      powerOrder: d.POWER_SITES_DISPLAY_ORDER.map((s) => s.id),
      map: d.MAP_SITES.length,
      camlist: d.CAMLIST_SITES.length,
      riverOrder: d.RIVER_ORDER_SITES.length,
      hasKomoike: !!d.SITE_CATALOG.cam41,
      hasHotaru: !!d.SITE_CATALOG.cam44,
      hasTakekura: !!d.SITE_CATALOG.cam45
    };
  });
  r.check("c1-a 電源監視の拠点数が23", catalog.power === 23, catalog.power);
  r.check("c1-b Phase Qで追加した3拠点が電源監視に含まれる",
    ["cam41", "cam44", "cam45"].every((id) => catalog.powerOrder.includes(id)), catalog.powerOrder);
  r.check("c1-c 追加3拠点が拠点カタログに存在する",
    catalog.hasKomoike && catalog.hasHotaru && catalog.hasTakekura, catalog);
  r.check("c1-d 表示順の要素数が電源拠点数と一致", catalog.powerOrder.length === catalog.power, catalog.powerOrder.length);
  r.check("c1-e 表示順に重複が無い", new Set(catalog.powerOrder).size === catalog.powerOrder.length);
  r.check("c1-f 全拠点数が電源拠点数を上回る(水位専用/画像専用を含む)", catalog.all > catalog.power, catalog.all);
  r.check("c1-g 地図・カメラ一覧の拠点が登録されている", catalog.map > 0 && catalog.camlist > 0, catalog);

  const subtitle = await page.textContent("#powerSubtitle");
  r.check("c1-h 電源監視の説明文に拠点数23が反映される", subtitle.includes("23拠点"), subtitle);
  r.check("c1-i 説明文が10分間隔・発電(PV)のW表示に言及", subtitle.includes("10分") && subtitle.includes("W"), subtitle);

  /* ---- 2. バッテリー残量(%) ---- */
  const bat = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const f = d.batteryPercentFor;
    return {
      full: d.BATTERY_FULL_VOLTAGE,
      emptyDefault: d.BATTERY_EMPTY_VOLTAGE_DEFAULT,
      override: d.BATTERY_EMPTY_VOLTAGE_OVERRIDE,
      def: { v115: f("cam02", 11.5), v121: f("cam02", 12.1), v127: f("cam02", 12.7), v135: f("cam02", 13.5), v110: f("cam02", 11.0) },
      kitazawa: { v95: f("cam03", 9.5), v111: f("cam03", 11.1), v127: f("cam03", 12.7) },
      taro: { v105: f("cam14", 10.5), v116: f("cam14", 11.6), v127: f("cam14", 12.7) },
      umena: f("cam09", 10.5), shibahashi: f("cam43", 10.5),
      nulls: [f("cam02", null), f("cam02", undefined), f("cam02", NaN), f("cam02", "12.0")],
      emptyOf: [d.batteryEmptyVoltageFor("cam02"), d.batteryEmptyVoltageFor("cam03"), d.batteryEmptyVoltageFor("cam41")]
    };
  });
  r.check("c2-a 満充電電圧が12.7V", bat.full === 12.7, bat.full);
  r.check("c2-b 既定の下限が11.5V", bat.emptyDefault === 11.5, bat.emptyDefault);
  r.check("c2-c 既定拠点 11.5V=0%", bat.def.v115 === 0, bat.def);
  r.check("c2-d 既定拠点 12.1V=50%", bat.def.v121 === 50, bat.def);
  r.check("c2-e 既定拠点 12.7V=100%", bat.def.v127 === 100, bat.def);
  r.check("c2-f 12.7Vを超えても100%にクリップ", bat.def.v135 === 100, bat.def);
  r.check("c2-g 下限未満は0%にクリップ", bat.def.v110 === 0, bat.def);
  r.check("c2-h 北沢アンダーパス 9.5V=0% / 11.1V=50% / 12.7V=100%",
    bat.kitazawa.v95 === 0 && bat.kitazawa.v111 === 50 && bat.kitazawa.v127 === 100, bat.kitazawa);
  r.check("c2-i 多呂樋管 10.5V=0% / 11.6V=50% / 12.7V=100%",
    bat.taro.v105 === 0 && bat.taro.v116 === 50 && bat.taro.v127 === 100, bat.taro);
  r.check("c2-j 梅名樋管2号・芝橋の下限も10.5V", bat.umena === 0 && bat.shibahashi === 0, [bat.umena, bat.shibahashi]);
  r.check("c2-k 数値以外はnull", bat.nulls.every((v) => v === null), bat.nulls);
  r.check("c2-l 下限の上書き表が4拠点", Object.keys(bat.override).length === 4, bat.override);
  r.check("c2-m Phase Q追加拠点(こも池)の下限は既定の11.5V", bat.emptyOf[2] === 11.5, bat.emptyOf);

  const mono = await page.evaluate(() => {
    const f = window.__dashboardDebug.batteryPercentFor;
    let ok = true, prev = -1;
    for (let v = 11.0; v <= 13.2; v += 0.05) {
      const p = f("cam02", Math.round(v * 100) / 100);
      if (p < prev) ok = false;
      prev = p;
    }
    return ok;
  });
  r.check("c2-n 電圧に対して残量が単調非減少", mono);

  const gauge = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    return { p100: d.batteryGaugeSvg(100), p0: d.batteryGaugeSvg(0), pNull: d.batteryGaugeSvg(null), p50: d.batteryGaugeSvg(50) };
  });
  r.check("c2-o 電池マークSVGに残量%が小数第2位まで入る", gauge.p50.includes(">50.00%<"), gauge.p50.slice(0, 120));
  r.check("c2-p データ無しは「–」表示", gauge.pNull.includes(">–<"), gauge.pNull.slice(0, 120));
  r.check("c2-q 0%のとき塗りつぶし幅が0", /battery-fill[^>]*width="0\.0"/.test(gauge.p0), gauge.p0.slice(0, 160));
  r.check("c2-r 100%の塗りつぶし幅が80(=88-4*2)", /battery-fill[^>]*width="80\.0"/.test(gauge.p100), gauge.p100.slice(0, 160));
  r.check("c2-s 桁数に応じて文字サイズを調整する(50.00%は15px / 100.00%は13px)",
    gauge.p50.includes('font-size="15"') && gauge.p100.includes('font-size="13"'), [gauge.p50.slice(0, 200), gauge.p100.slice(0, 200)]);

  /* ---- 2.5 Request V: 基準(最低)水位の固定値 ---- */
  const fixedBase = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const ov = d.FIXED_BASELINE_OVERRIDE;
    const s = d.siteStates.cam39;
    const keep = s.points.slice();
    // 実測に固定値より低い値があっても、固定値のままであること
    s.points = [{ fetchedAt: new Date(), measureTime: null, pv: null, bat: null,
      pvVoltage: null, waterLevelM: -0.55, via: "t" }];
    d.recomputeBaseline(d.SITE_CATALOG.cam39);
    const fixedStays = s.baselineLevelM;
    s.points = keep;
    d.recomputeBaseline(d.SITE_CATALOG.cam39);
    // 固定値が無い拠点は実測の最小値から算出されること
    const auto = d.siteStates.cam02;
    const autoKeep = auto.points.slice();
    auto.points = [
      { fetchedAt: new Date(), measureTime: null, pv: null, bat: null, pvVoltage: null, waterLevelM: 0.42, via: "t" },
      { fetchedAt: new Date(), measureTime: null, pv: null, bat: null, pvVoltage: null, waterLevelM: 0.31, via: "t" }
    ];
    d.recomputeBaseline(d.SITE_CATALOG.cam02);
    const autoMin = auto.baselineLevelM;
    auto.points = autoKeep;
    d.recomputeBaseline(d.SITE_CATALOG.cam02);
    return { ov, fixedStays, autoMin, names: {
      cam39: d.SITE_CATALOG.cam39.name, cam12: d.SITE_CATALOG.cam12.name, cam09: d.SITE_CATALOG.cam09.name } };
  });
  r.check("c2-t 大場ポンプ場流入水路(cam39)の基準水位が0.01m", fixedBase.ov.cam39 === 0.01, fixedBase.ov);
  r.check("c2-u 安間樋管(cam12)の基準水位が-0.08m", fixedBase.ov.cam12 === -0.08, fixedBase.ov);
  r.check("c2-v 梅名樋管2号(cam09)の基準水位が0.01m", fixedBase.ov.cam09 === 0.01, fixedBase.ov);
  r.check("c2-w 多呂樋管(cam14)の基準水位は0.06mのまま", fixedBase.ov.cam14 === 0.06, fixedBase.ov);
  r.check("c2-x 固定値の拠点は実測がそれより低くても固定値を使う", fixedBase.fixedStays === 0.01, fixedBase);
  r.check("c2-y 固定値が無い拠点は実測の最小値を使う", fixedBase.autoMin === 0.31, fixedBase);
  r.check("c2-z 対象拠点名が想定どおり",
    fixedBase.names.cam39.indexOf("大場ポンプ場") === 0 && fixedBase.names.cam12.indexOf("安間樋管") === 0 &&
    fixedBase.names.cam09.indexOf("梅名樋管2号") === 0, fixedBase.names);

  /* ---- 3. 中継サーバー電源CSVの解析 ---- */
  const csv = await page.evaluate((header) => {
    const d = window.__dashboardDebug;
    const csv = [
      header,
      "2026-09-19T10:00:00.000Z,0,中郷第１樋管,solar,ok,,120,18500,600,12.5,12700,700,100,600,90,5,500,10.4,0.0,0.0",
      "2026-09-19T10:00:00.000Z,1,白滝公園,solar,ok,,120,18000,600,3.25,11600,700,100,600,90,5,500,10.4,0.0,0.0",
      "2026-09-19T10:00:00.000Z,2,開発室,solar,ok,,120,18000,600,9.9,13400,700,100,600,90,5,500,10.4,0.0,0.0",
      "2026-09-19T10:00:00.000Z,3,こも池,solar,ok,,120,18000,600,4.4,12600,700,100,600,90,5,500,10.4,0.0,0.0",
      "壊れた行,途中で,切れている",
      "2026-09-19T10:00:00.000Z,4,中郷第１樋管,solar,ok,,120,,,,,,,,,,,,,"
    ].join("\n");
    const parsed = d.parsePowerCsvRows(csv, false);
    const partial = d.parsePowerCsvRows(
      "5,0,中郷第１樋管,solar,ok,,120,18500,600,9.9,12000,700,100,600,90,5,500,10.4,0.0,0.0\n" +
      "2026-09-19T11:00:00.000Z,0,中郷第１樋管,solar,ok,,120,18500,600,7.5,12300,700,100,600,90,5,500,10.4,0.0,0.0", true);
    return {
      ids: parsed.map((p) => p.siteId),
      first: { pv: parsed[0].pv, bat: parsed[0].bat, pvVoltage: parsed[0].pvVoltage, via: parsed[0].via, loadW: parsed[0].loadW },
      sakuragawa: parsed.find((p) => p.siteId === "cam42") || null,
      partialCount: partial.length,
      partialPv: partial.length ? partial[0].pv : null,
      empty: d.parsePowerCsvRows("", false).length,
      nameMapHasSakuragawa: d.POWER_SOURCE_NAME_TO_ID["白滝公園"] === "cam42",
      nameMapCount: Object.keys(d.POWER_SOURCE_NAME_TO_ID).length
    };
  }, POWER_CSV_HEADER);
  r.check("c3-a 既知の拠点のみ取り込む(開発室などは無視)", !csv.ids.includes(undefined) && !csv.ids.includes("開発室"), csv.ids);
  r.check("c3-b 発電(PV)は電力(W)としてpvへ入る", csv.first.pv === 12.5, csv.first);
  r.check("c3-c バッテリはmVからVへ換算", csv.first.bat === 12.7, csv.first);
  r.check("c3-d 発電電圧(pv_mv)はpvVoltageへ分離", csv.first.pvVoltage === 18.5, csv.first);
  r.check("c3-e 取得経路に中継サーバー名が入る", csv.first.via.includes("mini.lhlab-vps.net"), csv.first);
  r.check("c3-f 負荷電力(load_w)も取り込む", csv.first.loadW === 10.4, csv.first);
  r.check("c3-g 壊れた行・値が空の行・未知の拠点を捨てて3行になる", csv.ids.length === 3, csv.ids);
  r.check("c3-h 「白滝公園」は桜川(cam42)として取り込む(Phase N)", csv.sakuragawa && csv.sakuragawa.pv === 3.25, csv.sakuragawa);
  r.check("c3-i 値がすべて空の行は捨てる", !csv.ids.includes("cam02") || csv.ids.filter((i) => i === "cam02").length === 1, csv.ids);
  r.check("c3-j Range取得時は先頭の欠けた行を捨てる", csv.partialCount === 1 && csv.partialPv === 7.5, csv);
  r.check("c3-k 空文字は空配列", csv.empty === 0, csv.empty);
  r.check("c3-l 拠点名の変換表に白滝公園が登録済み", csv.nameMapHasSakuragawa, csv.nameMapHasSakuragawa);

  const allMapped = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const mapped = new Set(Object.values(d.POWER_SOURCE_NAME_TO_ID));
    return d.POWER_SITES.map((s) => s.id).filter((id) => !mapped.has(id));
  });
  r.check("c3-m 電源監視の全拠点が中継サーバーの名称変換表に存在する", allMapped.length === 0, allMapped);

  const url = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    // 2026-09-19 23:30 UTC は JST では 2026-09-20 08:30 → JSTの日付でファイル名が決まる
    return {
      jstCross: d.powerCsvUrlFor(new Date("2026-09-19T23:30:00Z")),
      normal: d.powerCsvUrlFor(new Date("2026-09-19T03:00:00Z")),
      base: d.POWER_CSV_BASE_URL
    };
  });
  r.check("c3-n CSVのURLは日本時間の日付で決まる", url.jstCross.endsWith("power-2026-09-20.csv"), url);
  r.check("c3-o 通常時のURLも日本時間基準", url.normal.endsWith("power-2026-09-19.csv"), url);
  r.check("c3-p 取得先が中継サーバーのlogs配下", url.base === "https://mini.lhlab-vps.net/power/logs/", url.base);

  const jina = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    return {
      ok: d.extractCsvFromJinaProxyText("Title: x\nMarkdown Content:\ntimestamp,id,name\n2026-01-01T00:00:00Z,0,中郷第１樋管"),
      none: d.extractCsvFromJinaProxyText("Markdown Content:\nエラーページです")
    };
  });
  r.check("c3-q プロキシ応答からCSV本体を取り出せる", jina.ok && jina.ok.startsWith("timestamp,"), jina.ok);
  r.check("c3-r CSVが含まれない応答はnull", !jina.none, jina.none);

  /* ---- 4. 気象庁ナウキャストの時刻(Phase M) ---- */
  const jma = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    return {
      ms: d.parseJmaTimeMs("20260913123500"),
      expected: Date.UTC(2026, 8, 13, 12, 35, 0),
      short: d.parseJmaTimeMs("2026091312"),
      bad: d.parseJmaTimeMs(12345),
      label: d.fmtNowcastValidTime("20260913123500"),
      localLabel: (() => { const dd = new Date(Date.UTC(2026, 8, 13, 12, 35)); const p = (n) => String(n).padStart(2, "0"); return p(dd.getHours()) + ":" + p(dd.getMinutes()); })()
    };
  });
  r.check("c4-a 気象庁の時刻文字列をUTCとして解釈する", jma.ms === jma.expected, jma);
  r.check("c4-b 短すぎる文字列はNaN", Number.isNaN(jma.short), jma.short);
  r.check("c4-c 文字列以外はNaN", Number.isNaN(jma.bad), jma.bad);
  r.check("c4-d 表示はローカル時刻へ変換される", jma.label === jma.localLabel, jma);
  r.check("c4-e 表示形式がHH:MM", /^\d{2}:\d{2}$/.test(jma.label), jma.label);

  /* ---- 5. 時刻表示から秒を除く(Phase M) ---- */
  const clock = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const t = new Date(2026, 8, 19, 7, 5, 43);
    return { hm: d.fmtClockHm(t), hms: d.fmtClock(t) };
  });
  r.check("c5-a グラフ用の時刻は HH:MM(秒なし)", clock.hm === "07:05", clock);
  r.check("c5-b 従来の時計表示は秒まで残る", clock.hms === "07:05:43", clock);

  /* ---- 6. グラフの座標計算(時間軸配置・実線/点線分割) ---- */
  const chart = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const base = Date.UTC(2026, 8, 19, 0, 0, 0);
    // 不等間隔(0分・10分・60分)でも時間に比例した位置になること
    const pts = [
      { t: base, value: 1 },
      { t: base + 10 * 60000, value: 2 },
      { t: base + 60 * 60000, value: 3 }
    ];
    const xs = d.computeXPositions(pts, 40, 600);
    const noTime = d.computeXPositions([{ value: 1 }, { value: 2 }, { value: 3 }], 40, 600);
    const single = d.computeXPositions([{ t: base, value: 1 }], 40, 600);
    const mixed = [
      { t: base, value: 1 }, { t: base + 3600000, value: 2 },
      { t: base + 7200000, value: 3, predicted: true }, { t: base + 10800000, value: 4, predicted: true }
    ];
    const mx = d.computeXPositions(mixed, 40, 600);
    const split = d.buildSplitPathData(mixed, mx, (v) => v * 10);
    const allSolid = d.buildSplitPathData(pts, xs, (v) => v * 10);
    return {
      xs, noTime, single,
      firstLast: [xs[0], xs[2]],
      proportional: Math.abs(xs[1] - (40 + (10 / 60) * 600)) < 0.001,
      split, allSolid
    };
  });
  r.check("c6-a X座標が時間に比例する", chart.proportional, chart.xs);
  r.check("c6-b 左端・右端がプロット領域の端になる",
    Math.abs(chart.firstLast[0] - 40) < 1e-6 && Math.abs(chart.firstLast[1] - 640) < 1e-6, chart.firstLast);
  r.check("c6-c 時刻が無い場合は等間隔に配置", Math.abs(chart.noTime[1] - 340) < 1e-6, chart.noTime);
  r.check("c6-d 点が1つのときは中央", Math.abs(chart.single[0] - 340) < 1e-6, chart.single);
  r.check("c6-e 予測の開始位置を境界として返す", chart.split.boundaryIndex === 2, chart.split.boundaryIndex);
  r.check("c6-f 実測部分は実線パスに入る", chart.split.solid.startsWith("M") && chart.split.solid.split("L").length === 2, chart.split.solid);
  r.check("c6-g 予測部分は点線パスに入る", chart.split.dashed.startsWith("M"), chart.split.dashed);
  r.check("c6-h 点線は実測の最終点から始まり線が途切れない",
    chart.split.dashed.startsWith("M" + chart.split.solid.split(" ").pop().replace(/^L/, "")), chart.split.dashed);
  r.check("c6-i 予測が無ければ点線は空", chart.allSolid.dashed === "" && chart.allSolid.boundaryIndex === -1, chart.allSolid);

  /* ---- 7. 最小二乗法 ---- */
  const lsq = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    // y = 2*x1 + 3*x2 を厳密に満たすサンプル
    const samples = [
      { x1: 1, x2: 0, y: 2 }, { x1: 0, x2: 1, y: 3 }, { x1: 1, x2: 1, y: 5 }, { x1: 2, x2: 1, y: 7 }
    ];
    const sol = d.solveLeastSquares2(samples);
    const degenerate = d.solveLeastSquares2([{ x1: 1, x2: 1, y: 2 }, { x1: 2, x2: 2, y: 4 }]);
    return { sol, degenerate };
  });
  r.check("c7-a 係数を正しく求められる",
    lsq.sol && Math.abs(lsq.sol.a - 2) < 1e-6 && Math.abs(lsq.sol.b - 3) < 1e-6, lsq.sol);
  r.check("c7-b 解けない場合はnull", lsq.degenerate === null, lsq.degenerate);

  /* ---- 8. グラフ用の点の抽出 ---- */
  const sel = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const now = Date.now();
    const mk = (agoMs, v) => ({ fetchedAt: new Date(now - agoMs), bat: v });
    const many = [];
    for (let i = 0; i < 20; i++) many.push(mk(i * 60 * 60 * 1000, 12 + i * 0.01)); // 0〜19時間前
    many.reverse();
    const few = [mk(48 * 3600000, 12.0), mk(47 * 3600000, 12.1), mk(1 * 3600000, 12.2)]; // 24h枠内は1点
    const withFn = (p) => typeof p.bat === "number";
    return {
      inWindow: d.selectRecentForChart(many, withFn, 24 * 3600000),
      expanded: d.selectRecentForChart(few, withFn, 24 * 3600000),
      minPoints: d.MIN_MEANINGFUL_CHART_POINTS,
      maxPoints: d.MAX_CHART_POINTS,
      windowMs: d.CHART_WINDOW_MS
    };
  });
  r.check("c8-a 24時間枠に十分な点があれば枠内のみ使う",
    sel.inWindow.expanded === false && sel.inWindow.points.length === 20, sel.inWindow.points.length);
  r.check("c8-b 枠内の点が少なければ過去へ広げる",
    sel.expanded.expanded === true && sel.expanded.points.length === 3, sel.expanded);
  r.check("c8-c グラフに必要な最小点数は6", sel.minPoints === 6, sel.minPoints);
  r.check("c8-d グラフの既定表示幅は24時間", sel.windowMs === 24 * 3600000, sel.windowMs);
  r.check("c8-e グラフの最大点数が設定されている", sel.maxPoints > 0, sel.maxPoints);

  /* ---- 9. 取得間隔(Phase L) ---- */
  const intervals = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    return {
      normal: d.FETCH_INTERVAL_MS, fast: d.FAST_POLL_INTERVAL_MS, fastIds: d.FAST_POLL_SITE_IDS,
      timelapse: d.TIMELAPSE_WINDOW_MS, horizon: d.PREDICTION_HORIZON_MS
    };
  });
  r.check("c9-a 通常の取得間隔は10分", intervals.normal === 10 * 60 * 1000, intervals.normal);
  r.check("c9-b 高頻度拠点は2分間隔", intervals.fast === 2 * 60 * 1000, intervals.fast);
  r.check("c9-c 高頻度拠点は3拠点(提婆・神川・徳倉)",
    intervals.fastIds.length === 3 && ["cam39", "cam50", "cam51"].every((i) => intervals.fastIds.includes(i)), intervals.fastIds);
  r.check("c9-d タイムラプスの対象は直近2日", intervals.timelapse === 2 * 24 * 60 * 60 * 1000, intervals.timelapse);
  r.check("c9-e 予測は12時間先まで", intervals.horizon === 12 * 60 * 60 * 1000, intervals.horizon);

  /* ---- 10. 日本時間(JST)への変換(2026-09-20修正) ---- */
  const jst = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    // 2026-09-20T12:25:00Z は日本時間で 2026-09-20 21:25
    const t = new Date("2026-09-20T12:25:00Z");
    const p = d.toJstParts(t);
    // 日付をまたぐ場合: 2026-09-20T15:30:00Z → 日本時間 2026-09-21 00:30
    const p2 = d.toJstParts(new Date("2026-09-20T15:30:00Z"));
    return {
      y: p.y, mo: p.mo, day: p.day, h: p.h, mi: p.mi,
      cross: { y: p2.y, mo: p2.mo, day: p2.day, h: p2.h },
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offsetMin: t.getTimezoneOffset(),
      stgUrl: d.kawabouWaterJsonUrl("0563300400020", t),
      swstgUrl: d.kawabouSwstgJsonUrl("2200000022", t),
      powerCsv: d.powerCsvUrlFor(new Date("2026-09-20T18:30:00Z")) // JST 9/21 03:30
    };
  });
  r.check("c10-a 日本時間の時分に変換される(21:25)", jst.h === 21 && jst.mi === 25, jst);
  r.check("c10-b 日付も日本時間(9/20)", jst.y === 2026 && jst.mo === 8 && jst.day === 20, jst);
  r.check("c10-c UTCで日付をまたぐ時刻も日本時間の翌日になる",
    jst.cross.day === 21 && jst.cross.h === 0, jst.cross);
  r.check("c10-d 水位URLの時分が日本時間の5分区切り(2125)",
    jst.stgUrl.indexOf("/20260920/2125/") >= 0, jst.stgUrl);
  r.check("c10-e 危機管理型水位計のURLも同じ区切り",
    jst.swstgUrl.indexOf("/20260920/2125/") >= 0, jst.swstgUrl);
  r.check("c10-f 電源CSVは日本時間の日付で決まる(深夜も当日分)",
    jst.powerCsv.endsWith("power-2026-09-21.csv"), jst.powerCsv);

  /* ---- 11. 川の防災情報の5分区切りフォールバック(2026-09-20追加) ---- */
  const bucket = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const t = new Date("2026-09-20T12:25:00Z"); // JST 21:25
    return {
      list: d.KAWABOU_BUCKET_FALLBACK_MIN,
      urls: d.KAWABOU_BUCKET_FALLBACK_MIN.map((m) =>
        d.kawabouWaterJsonUrl("0563300400020", new Date(t.getTime() - m * 60000))),
      parsedStg: d.parseKawabouWaterJson({ obsValue: { stg: 0.75, obsTime: "2026/09/20 21:10" } }, false),
      parsedSw: d.parseKawabouWaterJson({ obsValue: { stgHght: -1.24, tmObsTime: "2026/09/20 09:00" } }, true),
      emptyStg: d.parseKawabouWaterJson({ obsValue: {} }, false),
      emptySw: d.parseKawabouWaterJson({ obsValue: { stg: 26.3 } }, true),
      nullJson: d.parseKawabouWaterJson(null, false)
    };
  });
  r.check("c11-a 現在・5分前・10分前の3つを試す",
    bucket.list.length === 3 && bucket.list[0] === 0 && bucket.list[1] === 5 && bucket.list[2] === 10, bucket.list);
  r.check("c11-b フォールバック先のURLが1つ前の区切りになる",
    bucket.urls[1].indexOf("/2120/") >= 0 && bucket.urls[2].indexOf("/2115/") >= 0, bucket.urls);
  r.check("c11-c 通常の水位計はstgを採用", bucket.parsedStg.waterLevelM === 0.75, bucket.parsedStg);
  r.check("c11-d 危機管理型は堤防天端からの高さ(stgHght)を採用",
    bucket.parsedSw.waterLevelM === -1.24, bucket.parsedSw);
  r.check("c11-e 危機管理型はtmObsTimeも計測時刻として使える",
    !!bucket.parsedSw.measureTime, bucket.parsedSw);
  r.check("c11-f 値が無い応答はnull(次の区切りへ進む)",
    bucket.emptyStg === null && bucket.emptySw === null && bucket.nullJson === null, bucket);

  /* ---- 10. ページ例外が無いこと ---- */
  r.check("c10-a 読み込み時にページ例外が発生しない", page.errMsgs().length === 0, page.errMsgs());

  await page.close();
  return r.finish();
}

if (process.argv[1] && process.argv[1].endsWith("test_core.mjs")) {
  run().then(async (c) => { await teardown(); process.exit(c.fail ? 1 : 0); });
}
