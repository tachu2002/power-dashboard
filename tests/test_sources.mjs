// 取得元まわりの頑健性テスト(2026-09-20の調査で見つかった4つの原因への対策)。
//  ① 危機管理型水位計(swstg)はCORS非対応 → プロキシへ退避できること
//  ② 国交省カメラが停止中(.jsonが案内画像を返す) → 配信停止中として扱い画像を出すこと
//  ③ 5分区切りのファイルが未公開(404) → 1つ前・2つ前の区切りへフォールバックすること
//  ④ 日本時間への変換 → URLが9時間ずれないこと(test_core.mjsのc10で検証)
//  ⑤ プロキシ(r.jina.ai)が river.go.jp を遮断(2026-09-21、403 AbuseAlleviationError)
//     → サーバー側が保存した最新値・雨量(同一オリジン)へ退避できること
import { setup, teardown, newPage, openDashboard, createReporter, buildServerLatest, buildServerRainfall } from "./harness.mjs";

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
  // kc01の判定も見るため、両方が pending を抜けるまで待つ
  // (kc03だけ待つと、kc01がまだ取得中のまま検証してしまうことがあった)
  await page4.waitForFunction(() => {
    const d = window.__dashboardDebug;
    return d.siteData.kc03 && d.siteData.kc03.lastState !== "pending" &&
      d.siteData.kc01 && d.siteData.kc01.lastState !== "pending";
  }, { timeout: 60000 });
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

  /* ===== ⑥ プロキシがriver.go.jpを遮断 → サーバー保存値へ退避 ===== */
  // 2026-09-21: r.jina.ai が www.river.go.jp への匿名アクセスを403で返すようになり、
  // 危機管理型水位計(CORS非対応)はブラウザから一切取得できなくなった。
  const blockProxy = (route) => {
    const url = route.request().url();
    if (url.indexOf("river.go.jp") >= 0) {
      return route.fulfill({ status: 403, contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ data: null, code: 403, name: "AbuseAlleviationError", status: 40305 }) });
    }
    route.fulfill({ contentType: "text/plain", headers: { "Access-Control-Allow-Origin": "*" },
      body: 'Markdown Content:\n{"obsdate":"2026\\/09\\/20 20:04"}' });
  };

  const page6 = await newPage(null, {
    nowMs: NOW,
    serverLatest: buildServerLatest({ nowMs: NOW, water: { kw05: -1.11, kw06: -2.4 } }),
    serverRainfall: buildServerRainfall({ nowMs: NOW, rn10m: 2.5 })
  });
  await page6.route("**/www.river.go.jp/kawabou/file/files/tmlist/swstg/**", (route) => route.abort("failed"));
  await page6.route("**/r.jina.ai/**", blockProxy);
  await openDashboard(page6);
  await page6.waitForFunction(() => {
    const d = window.__dashboardDebug;
    const s = d.siteStates.kw05;
    return s && s.points.some((p) => typeof p.waterLevelM === "number");
  }, { timeout: 60000 });
  const fallback = await page6.evaluate(() => {
    const d = window.__dashboardDebug;
    const last = d.lastPointWith(d.siteStates.kw05.points, "waterLevelM");
    return {
      value: last ? last.waterLevelM : null,
      via: last ? last.via : null,
      state: d.siteData.kw05.lastState,
      serverSites: Object.keys(d.getServerLatestState().sites).length,
      rain: d.getRainfallState().points.length,
      rainMm: d.getRainfallState().points.length ? d.getRainfallState().points[0].rn10m : null,
      label: d.VIA_LABEL_SERVER_FALLBACK
    };
  });
  r.check("x6-a プロキシが403でもサーバー保存値で水位を表示できる", fallback.value === -1.11, fallback);
  r.check("x6-b 拠点は正常扱いになる(赤の取得失敗にしない)", fallback.state === "ok", fallback);
  r.check("x6-c 取得経路が「サーバー保存値」と分かる", fallback.via === fallback.label, fallback);
  r.check("x6-d サーバー保存の最新値を読み込んでいる", fallback.serverSites === 2, fallback);
  r.check("x6-e 雨量もサーバー保存値から取り込める", fallback.rain > 0 && fallback.rainMm === 2.5, fallback);
  r.check("x6-f ページ例外にはならない", page6.errMsgs().length === 0, page6.errMsgs());

  // 古すぎるサーバー保存値は使わない(現在値として誤解させない)
  const stale = await page6.evaluate((maxAge) => {
    const d = window.__dashboardDebug;
    const st = d.getServerLatestState();
    const keep = st.sites.kw05.lastSuccessAt;
    st.sites.kw05.lastSuccessAt = new Date(Date.now() - maxAge - 60000).toISOString();
    const tooOld = d.serverLatestWaterReading(d.SITE_CATALOG.kw05);
    st.sites.kw05.lastSuccessAt = keep;
    const fresh = d.serverLatestWaterReading(d.SITE_CATALOG.kw05);
    const unknown = d.serverLatestWaterReading(d.SITE_CATALOG.cam02);
    return { tooOld, fresh: fresh ? fresh.waterLevelM : null, unknown };
  }, await page6.evaluate(() => window.__dashboardDebug.SERVER_LATEST_MAX_AGE_MS));
  r.check("x6-g 1時間より古い保存値は使わない", stale.tooOld === null, stale);
  r.check("x6-h 新しい保存値は使う", stale.fresh === -1.11, stale);
  r.check("x6-i 保存値が無い拠点はnull", stale.unknown === null, stale);
  await page6.close();

  // サーバー保存の雨量が無い場合は従来どおりプロキシ経由を試す
  const page7 = await newPage(null, { nowMs: NOW });
  await openDashboard(page7);
  const rainProxy = await page7.evaluate(async () => {
    const d = window.__dashboardDebug;
    let serverErr = null;
    try { await d.fetchRainfallFromServer(); } catch (e) { serverErr = e.message; }
    const pts = d.rainPointsFromKawabouJson({ min10Values: [{ obsTime: "2026-09-21T10:00:00+09:00", rn10m: 3 }],
      obsValue: { obsTime: "2026-09-21T10:10:00+09:00", rn10m: 4 } });
    return { serverErr, parsed: pts.length, last: pts[pts.length - 1].rn10m };
  });
  r.check("x6-j サーバー保存の雨量が無ければエラーになる(=プロキシへ退避する)", !!rainProxy.serverErr, rainProxy);
  r.check("x6-k 国交省JSONの10分雨量を解釈できる", rainProxy.parsed === 2 && rainProxy.last === 4, rainProxy);

  // 未来の観測時刻(取得元の時刻解釈の取り違えで混ざった場合)は取り込まない
  const futureRain = await page7.evaluate(() => {
    const d = window.__dashboardDebug;
    const st = d.getRainfallState();
    const keep = st.points.slice();
    st.points = [];
    const now = Date.now();
    d.mergeRainPoints([
      { time: new Date(now - 10 * 60000), rn10m: 1 },
      { time: new Date(now + 9 * 3600000), rn10m: 99 }   // 9時間先(時刻解釈の取り違え)
    ]);
    const after = st.points.map((p) => p.rn10m);
    st.points = keep;
    return { after, tolerance: d.RAIN_FUTURE_TOLERANCE_MS };
  });
  r.check("x6-l 未来の観測時刻は取り込まない",
    futureRain.after.length === 1 && futureRain.after[0] === 1, futureRain);
  await page7.close();

  return r.finish();
}

if (process.argv[1] && process.argv[1].endsWith("test_sources.mjs")) {
  run().then(async (c) => { await teardown(); process.exit(c.fail ? 1 : 0); });
}
