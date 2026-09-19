// 画面(ビュー)まわりのテスト: 表示切り替え、地図の「初期表示に戻す」ボタン(Phase M)、
// ナウキャスト予測再生の時刻(Phase M)、サイドバー、天気ストリップ。
import { setup, teardown, newPage, openDashboard, createReporter } from "./harness.mjs";

const NOW = Date.now();

export async function run() {
  const r = createReporter("test_views");
  await setup();

  const page = await newPage(null, { nowMs: NOW });
  await openDashboard(page);

  /* ---- 1. ビューの切り替え ---- */
  const views = ["power", "allmap", "river", "camlist", "graphlist", "waterdata", "voltagedata", "imagedata", "site"];
  const shown = [];
  for (const v of views) {
    if (v === "site") continue;
    const visible = await page.evaluate((name) => {
      window.__dashboardDebug.showView(name);
      const el = document.getElementById("view-" + name);
      const others = Array.from(document.querySelectorAll('[id^="view-"]'))
        .filter((e) => e.id !== "view-" + name && e.classList.contains("show")).length;
      return { active: !!el && el.classList.contains("show"), others };
    }, v);
    shown.push({ v, ...visible });
  }
  r.check("v1-a すべてのビューへ切り替えられる", shown.every((s) => s.active), shown);
  r.check("v1-b 同時に表示されるビューは1つだけ", shown.every((s) => s.others === 0), shown);

  await page.evaluate(() => window.__dashboardDebug.showView("power"));
  const detail = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    d.openSiteDetail("cam02");
    d.showView("site");
    return {
      visible: document.getElementById("view-site").classList.contains("show"),
      title: document.getElementById("siteDetailTitle").textContent,
      activeId: d.getActiveDetailSiteId()
    };
  });
  r.check("v1-c 拠点詳細を開ける", detail.visible && detail.activeId === "cam02", detail);
  r.check("v1-d 拠点名が見出しに入る", detail.title.includes("中郷第１樋管"), detail.title);

  /* ---- 2. 地図の「初期表示に戻す」ボタン(Phase M) ---- */
  const maps = await page.evaluate(async () => {
    const d = window.__dashboardDebug;
    d.showView("allmap"); d.ensureAllSitesMap();
    d.showView("river"); d.ensureRiverMap();
    d.openSiteDetail("cam02"); d.showView("site"); d.ensureSiteDetailMap();
    const btn = (id) => {
      const c = document.getElementById(id);
      const b = c ? c.querySelector(".map-reset-btn") : null;
      return b ? { text: b.textContent, title: b.title, tag: b.tagName, type: b.type } : null;
    };
    return { all: btn("allSitesMap"), river: btn("riverMap"), site: btn("siteMap") };
  });
  r.check("v2-a 全拠点マップにリセットボタンがある", !!maps.all, maps.all);
  r.check("v2-b 河川マップにリセットボタンがある", !!maps.river, maps.river);
  r.check("v2-c 拠点詳細マップにリセットボタンがある", !!maps.site, maps.site);
  r.check("v2-d ボタンの文言が「初期表示に戻す」",
    maps.all && maps.all.text.includes("初期表示に戻す"), maps.all);
  r.check("v2-e 送信扱いにならないbutton要素",
    maps.all && maps.all.tag === "BUTTON" && maps.all.type === "button", maps.all);

  const resetBehavior = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    d.showView("allmap");
    const map = d.getAllSitesMap();
    const before = { zoom: map.getZoom(), fit: map._fitBounds };
    map.setZoom(18);
    map.panTo([35.0, 138.0]);
    const btn = document.getElementById("allSitesMap").querySelector(".map-reset-btn");
    const fitCountBefore = map._fitBounds;
    btn.click();
    return {
      zoomedTo: 18, zoomAfterClick: map.getZoom(),
      refitted: map._fitBounds !== null,
      hadPadding: !!(map._fitBoundsOpts && map._fitBoundsOpts.padding),
      before
    };
  });
  r.check("v2-f リセットで初期の表示範囲へ戻す(fitBoundsが呼ばれる)", resetBehavior.refitted, resetBehavior);
  r.check("v2-g 戻すときに余白(padding)を指定している", resetBehavior.hadPadding, resetBehavior);

  const noBubble = await page.evaluate(() => {
    const btn = document.getElementById("allSitesMap").querySelector(".map-reset-btn");
    let reached = 0;
    const onMap = () => { reached++; };
    document.getElementById("allSitesMap").addEventListener("mousedown", onMap);
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.getElementById("allSitesMap").removeEventListener("mousedown", onMap);
    return reached;
  });
  r.check("v2-h ボタン操作が地図へ伝わらない(伝播を止めている)", noBubble === 0, noBubble);

  const idempotent = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    d.addMapResetButton("allSitesMap", function () {});
    d.addMapResetButton("allSitesMap", function () {});
    return document.getElementById("allSitesMap").querySelectorAll(".map-reset-btn").length;
  });
  r.check("v2-i ボタンは重複して追加されない", idempotent === 1, idempotent);

  /* ---- 3. ナウキャスト予測再生の時刻(Phase M) ---- */
  await page.evaluate(() => { window.__dashboardDebug.showView("allmap"); });
  await page.evaluate(() => document.getElementById("nowcastPlayBtn").click());
  await page.waitForFunction(() => /予測時刻/.test(document.getElementById("nowcastPlayStatus").textContent), { timeout: 10000 });
  const play = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const txt = document.getElementById("nowcastPlayStatus").textContent;
    const m = /予測時刻 (\d{2}):(\d{2})/.exec(txt);
    const now = new Date();
    return {
      txt,
      hh: m ? +m[1] : null, mm: m ? +m[2] : null,
      nowHH: now.getHours(), nowMM: now.getMinutes(),
      active: d.isNowcastPlaybackActive()
    };
  });
  r.check("v3-a 予測再生が始まる", play.active, play);
  r.check("v3-b 予測時刻が表示される", play.hh !== null, play.txt);
  const frameMin = play.hh * 60 + play.mm;
  const nowMin = play.nowHH * 60 + play.nowMM;
  const diff = ((frameMin - nowMin) + 1440) % 1440;
  r.check("v3-c 表示される予測時刻が現在時刻以降(未来)である", diff <= 70, { diff, play });
  r.check("v3-d 予測時刻が現在時刻から9時間ずれていない(UTC誤表示でない)",
    !(diff >= 14 * 60 && diff <= 16 * 60), { diff, play });

  await page.evaluate(() => document.getElementById("nowcastPlayBtn").click());
  const stopped = await page.evaluate(() => ({
    active: window.__dashboardDebug.isNowcastPlaybackActive(),
    label: document.getElementById("nowcastPlayBtn").textContent
  }));
  r.check("v3-e もう一度押すと停止する", stopped.active === false, stopped);
  r.check("v3-f 停止後はボタンが再生表示へ戻る", stopped.label.includes("再生"), stopped);

  /* ---- 4. サイドバー ---- */
  const sidebar = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    d.setSidebarCollapsed(true);
    const collapsed = document.getElementById("appLayout").classList.contains("sidebar-collapsed");
    d.setSidebarCollapsed(false);
    const expanded = !document.getElementById("appLayout").classList.contains("sidebar-collapsed");
    return { collapsed, expanded };
  });
  r.check("v4-a サイドバーを畳める", sidebar.collapsed, sidebar);
  r.check("v4-b サイドバーを戻せる", sidebar.expanded, sidebar);

  /* ---- 5. 天気ストリップ ---- */
  await page.waitForFunction(() => document.querySelectorAll("#weatherStrip .weather-day, #weatherStrip > div").length > 0, { timeout: 10000 }).catch(() => {});
  const weather = await page.evaluate(() => {
    const el = document.getElementById("weatherStrip");
    return { html: el.innerHTML.length, text: el.textContent.slice(0, 120) };
  });
  r.check("v5-a 天気予報が描画される", weather.html > 0, weather);
  r.check("v5-b 気温が表示される", /\d+/.test(weather.text), weather);

  /* ---- 6. 拠点数の表示 ---- */
  const counts = await page.evaluate(() => ({
    camlist: document.getElementById("camlistSubtitle").textContent,
    graphlist: document.getElementById("graphlistSubtitle").textContent,
    power: document.getElementById("powerSubtitle").textContent
  }));
  r.check("v6-a カメラ一覧に拠点数が表示される", /\d+拠点/.test(counts.camlist), counts.camlist);
  r.check("v6-b グラフ一覧に拠点数が表示される", /\d+拠点/.test(counts.graphlist), counts.graphlist);
  r.check("v6-c いずれの説明文も10分間隔に言及",
    counts.camlist.includes("10分") && counts.graphlist.includes("10分") && counts.power.includes("10分"), counts);

  r.check("v7-a 一連の操作でページ例外が発生しない", page.errMsgs().length === 0, page.errMsgs());

  await page.close();
  return r.finish();
}

if (process.argv[1] && process.argv[1].endsWith("test_views.mjs")) {
  run().then(async (c) => { await teardown(); process.exit(c.fail ? 1 : 0); });
}
