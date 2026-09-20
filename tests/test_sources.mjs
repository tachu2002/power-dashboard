// 取得元まわりの頑健性テスト(2026-09-20の調査で見つかった4つの原因への対策)。
//  ① 危機管理型水位計(swstg)はCORS非対応 → プロキシへ退避できること
//  ② 国交省カメラが停止中(.jsonが案内画像を返す) → 配信停止中として扱い画像を出すこと
//  ③ 5分区切りのファイルが未公開(404) → 1つ前・2つ前の区切りへフォールバックすること
//  ④ 日本時間への変換 → URLが9時間ずれないこと(test_core.mjsのc10で検証)
import { setup, teardown, newPage, openDashboard, createReporter } from "./harness.mjs";

const NOW = Date.now();
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);

export async function run() {
  const r = createReporter("test_sources");
  await setup();

  /* ===== ① 危機管理型水位計(swstg): 直接取得はCORSで失敗 → プロキシへ退避 ===== */
  const seen = { directSwstg: 0, proxySwstg: 0 };
  const page = await newPage(null, { nowMs: NOW });
  // 直接アクセスは必ず失敗させる(実際のブラウザでのCORSブロックと同じ挙動)
  await page.route("**/www.river.go.jp/kawabou/file/files/tmlist/swstg/**", (route) => {
    seen.directSwstg++;
    route.abort("failed");
  });
  // プロキシ経由(r.jina.ai)は本物と同じMarkdown包装で返す
  await page.route("**/r.jina.ai/**", (route) => {
    const url = route.request().url();
    if (url.indexOf("/swstg/") >= 0) {
      seen.proxySwstg++;
      return route.fulfill({
        contentType: "text/plain",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: 'Markdown Content:\n{"dspFlg":0,"obsValue":{"stg":26.32,"tmObsTime":"2026/09/20 09:00","obsTime":"2026/09/20 09:00","stgHght":-1.24}}'
      });
    }
    route.fulfill({ contentType: "text/plain", headers: { "Access-Control-Allow-Origin": "*" },
      body: 'Markdown Content:\n{"obsdate":"2026\\/09\\/20 20:04"}' });
  });
  await openDashboard(page);
  await page.waitForFunction(() => {
    const d = window.__dashboardDebug;
    const s = d.siteStates.kw05;
    return s && s.points.some((p) => typeof p.waterLevelM === "number");
  }, { timeout: 20000 });

  const sw = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const s = d.siteStates.kw05;
    const last = d.lastPointWith(s.points, "waterLevelM");
    return {
      value: last ? last.waterLevelM : null,
      state: d.siteData.kw05.lastState,
      kind: d.SITE_CATALOG.kw05.kind,
      swstgSites: d.ALL_SITES.filter((x) => x.kind === "swstg").map((x) => x.id)
    };
  });
  r.check("x1-a 危機管理型はプロキシ経由で取得できる", sw.value === -1.24, sw);
  r.check("x1-b 直接取得も試みている(将来CORS開放されたら直接取れる)", seen.directSwstg > 0, seen);
  r.check("x1-c プロキシへ退避している", seen.proxySwstg > 0, seen);
  r.check("x1-d 拠点は正常扱いになる", sw.state === "ok", sw);
  r.check("x1-e 堤防天端からの高さ(マイナス値)をそのまま採用", sw.value < 0, sw.value);
  r.check("x1-f 危機管理型は4拠点", sw.swstgSites.length === 4, sw.swstgSites);

  await page.waitForFunction(() => {
    const d = window.__dashboardDebug;
    return ["kw06", "kw07", "kw09"].every((id) => d.siteData[id].lastState !== "pending");
  }, { timeout: 90000 });
  const others = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    return ["kw06", "kw07", "kw09"].map((id) => ({
      id, state: d.siteData[id].lastState,
      hasWater: d.siteStates[id].points.some((p) => typeof p.waterLevelM === "number")
    }));
  });
  r.check("x1-g 他の危機管理型3拠点も取得できる",
    others.every((o) => o.state === "ok" && o.hasWater), others);
  r.check("x1-h ページ例外が出ない", page.errMsgs().length === 0, page.errMsgs());
  await page.close();

  /* ===== ③ 5分区切りのフォールバック ===== */
  const tried = [];
  const page2 = await newPage(null, { nowMs: NOW });
  await page2.route("**/www.river.go.jp/kawabou/file/files/tmlist/stg/**", (route) => {
    const url = route.request().url();
    const m = /\/stg\/(\d{8})\/(\d{4})\//.exec(url);
    const bucket = m ? m[2] : "?";
    if (tried.indexOf(bucket) < 0) tried.push(bucket);
    // 「いちばん新しい区切りはまだ公開されていない」状態を再現する(最初に来た区切りだけ404)
    if (bucket === tried[0]) return route.fulfill({ status: 404, body: "not found" });
    route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ obsValue: { stg: 0.75, obsTime: "2026/09/20 21:10" } })
    });
  });
  await openDashboard(page2);
  await page2.waitForFunction(() => {
    const d = window.__dashboardDebug;
    return d.siteStates.kw04.points.some((p) => typeof p.waterLevelM === "number");
  }, { timeout: 20000 });
  const fb = await page2.evaluate(() => {
    const d = window.__dashboardDebug;
    const last = d.lastPointWith(d.siteStates.kw04.points, "waterLevelM");
    return { value: last ? last.waterLevelM : null, state: d.siteData.kw04.lastState };
  });
  r.check("x2-a 最新の区切りが404でも1つ前の区切りで取得できる", fb.value === 0.75, fb);
  r.check("x2-b 拠点は正常扱いになる", fb.state === "ok", fb);
  r.check("x2-c 2つ以上の区切りを試している", tried.length >= 2, tried);
  r.check("x2-d 試す区切りは新しい順", tried.length >= 2 ? tried[0] > tried[1] : true, tried);
  await page2.close();

  /* ===== 区切りをすべて試しても取れない場合は従来どおり失敗扱い ===== */
  const page3 = await newPage(null, { nowMs: NOW });
  await page3.route("**/www.river.go.jp/kawabou/file/files/tmlist/stg/**",
    (route) => route.fulfill({ status: 404, body: "not found" }));
  await page3.route("**/r.jina.ai/**", (route) => route.fulfill({ status: 404, body: "not found" }));
  await openDashboard(page3);
  await page3.waitForFunction(() => {
    const d = window.__dashboardDebug;
    return d.siteData.kw04 && d.siteData.kw04.lastState !== "pending";
  }, { timeout: 90000 });
  const allFail = await page3.evaluate(() => ({
    state: window.__dashboardDebug.siteData.kw04.lastState,
    ticker: (document.getElementById("errorTickerTrack") || {}).textContent || ""
  }));
  r.check("x3-a すべての区切りで取れなければ取得失敗として扱う", allFail.state === "err", allFail.state);
  r.check("x3-b 失敗した拠点がティッカーに出る", allFail.ticker.indexOf("青木橋") >= 0, allFail.ticker.slice(0, 120));
  r.check("x3-c ページ例外にはならない", page3.errMsgs().length === 0, page3.errMsgs());
  await page3.close();

  /* ===== ② 国交省カメラが停止中(.jsonが案内画像を返す) ===== */
  const page4 = await newPage(null, { nowMs: NOW });
  await page4.route("**/cam.river.go.jp/cam/now/121826016.json*", (route) =>
    route.fulfill({ contentType: "image/jpeg", body: TINY_JPEG }));
  await openDashboard(page4);
  await page4.waitForFunction(() => {
    const d = window.__dashboardDebug;
    return d.siteData.kc03 && d.siteData.kc03.lastState !== "pending";
  }, { timeout: 20000 });
  const cam = await page4.evaluate(() => {
    const d = window.__dashboardDebug;
    return {
      kc03: { state: d.siteData.kc03.lastState, unavailable: !!d.siteData.kc03.cameraUnavailable,
        hasImage: !!d.siteData.kc03.imageUrl },
      kc01: { state: d.siteData.kc01.lastState, unavailable: !!d.siteData.kc01.cameraUnavailable },
      dot: d.siteStates.kc03.camDotEl ? d.siteStates.kc03.camDotEl.className : null,
      label: d.siteStates.kc03.camLabelEl ? d.siteStates.kc03.camLabelEl.textContent : null,
      alertFrame: d.siteStates.kc03.camCardEl ? d.siteStates.kc03.camCardEl.classList.contains("fetch-alert-frame") : null,
      ticker: (document.getElementById("errorTickerTrack") || {}).textContent || ""
    };
  });
  r.check("x4-a カメラ停止中と判定される", cam.kc03.unavailable === true, cam.kc03);
  r.check("x4-b 状態は「配信停止中」になる", cam.kc03.state === "unavailable", cam.kc03);
  r.check("x4-c 画像は表示対象として残る(案内画像が見える)", cam.kc03.hasImage === true, cam.kc03);
  r.check("x4-d 正常なカメラは従来どおり", cam.kc01.state === "ok" && cam.kc01.unavailable === false, cam.kc01);
  r.check("x4-e 停止中は取得失敗(赤)と別の印になる", cam.dot === "dot unavailable", cam.dot);
  r.check("x4-f ラベルに「配信停止中」と出る", (cam.label || "").indexOf("配信停止中") >= 0, cam.label);
  r.check("x4-g こちらの取得失敗ではないので赤枠にはしない", cam.alertFrame === false, cam.alertFrame);
  r.check("x4-h ティッカーには「（配信停止中）」付きで流す",
    cam.ticker.indexOf("配信停止中") >= 0, cam.ticker.slice(0, 160));
  r.check("x4-i ページ例外にはならない", page4.errMsgs().length === 0, page4.errMsgs());
  await page4.close();

  /* ===== 画像アーカイブの説明文(実データから作る) ===== */
  const page5 = await newPage(null, {
    nowMs: NOW,
    manifest: {
      generatedAt: new Date(NOW).toISOString(),
      retentionDays: 2,
      sites: {
        cam02: { name: "cam02", files: [0, 180, 360, 540].map((m, i) => ({
          ts: new Date(NOW - (540 - m) * 60000).toISOString(), file: "data/images/cam02/f" + i + ".jpg" })) }
      }
    }
  });
  await openDashboard(page5, () => !!window.__dashboardDebug.getImageManifest());
  const disc = await page5.evaluate(() => {
    const d = window.__dashboardDebug;
    d.showView("imagedata");
    return {
      summary: d.imageArchiveSummary(),
      text: document.getElementById("imageDataDisclaimer").textContent,
      fmt: [d.fmtIntervalMin(20), d.fmtIntervalMin(180), d.fmtIntervalMin(0)]
    };
  });
  r.check("x5-a 保持日数をマニフェストから読む", disc.summary.retentionDays === 2, disc.summary);
  r.check("x5-b 実際の保存間隔(中央値)を算出する", disc.summary.medianMin === 180, disc.summary);
  r.check("x5-c 説明文に実際の間隔が入る", disc.text.indexOf("約3時間ごと") >= 0, disc.text.slice(0, 260));
  r.check("x5-d 説明文に保持日数が入る", disc.text.indexOf("直近2日分") >= 0, disc.text.slice(0, 260));
  r.check("x5-e 説明文に枚数が入る", disc.text.indexOf("4枚") >= 0, disc.text.slice(0, 260));
  r.check("x5-f 60分未満は「約N分ごと」", disc.fmt[0] === "約20分ごと", disc.fmt);
  r.check("x5-g 60分以上は「約N時間ごと」", disc.fmt[1] === "約3時間ごと", disc.fmt);
  r.check("x5-h 算出できない場合は「不明」", disc.fmt[2] === "不明", disc.fmt);
  await page5.close();

  return r.finish();
}

if (process.argv[1] && process.argv[1].endsWith("test_sources.mjs")) {
  run().then(async (c) => { await teardown(); process.exit(c.fail ? 1 : 0); });
}
