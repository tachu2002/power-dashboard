// タイムラプス再生のテスト。
//  - 再生対象は直近2日分の画像に限る(Phase L)
//  - ライブカメラ一覧のタイムラプス(Phase N)。同時に再生できるのは1拠点のみ
//  - 拠点詳細のタイムラプス(従来機能の回帰確認)
import { setup, teardown, newPage, openDashboard, createReporter, buildImageManifest } from "./harness.mjs";

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

// 直近2日以内の画像5枚 + 5日前の古い画像3枚を持つマニフェスト
function manifestWithOldFiles(nowMs) {
  const mk = (id, offsets) => ({
    name: id,
    files: offsets.map((h, i) => ({ ts: new Date(nowMs - h * HOUR).toISOString(), file: "data/images/" + id + "/f" + i + ".jpg" }))
  });
  return {
    generatedAt: new Date(nowMs).toISOString(),
    retentionDays: 2,
    sites: {
      cam02: mk("cam02", [120, 118, 116, 20, 15, 10, 5, 1]), // 先頭3枚は5日前相当(=2日より古い)
      cam03: mk("cam03", [200, 196, 192]),                   // すべて2日より古い
      cam04: { name: "cam04", files: [] }                    // 保存画像なし
    }
  };
}

export async function run() {
  const r = createReporter("test_playback");
  await setup();

  const page = await newPage(null, { nowMs: NOW, manifest: manifestWithOldFiles(NOW) });
  await openDashboard(page, () => !!window.__dashboardDebug.getImageManifest());

  /* ---- 1. 再生対象は直近2日分 ---- */
  const files = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    const f2 = d.getSortedPlaybackFiles("cam02");
    const f3 = d.getSortedPlaybackFiles("cam03");
    const f4 = d.getSortedPlaybackFiles("cam04");
    const fx = d.getSortedPlaybackFiles("cam99");
    const cutoff = Date.now() - d.TIMELAPSE_WINDOW_MS;
    return {
      cam02: f2.length,
      cam02AllRecent: f2.every((f) => new Date(f.ts).getTime() >= cutoff),
      cam02Sorted: f2.every((f, i) => i === 0 || new Date(f.ts) >= new Date(f2[i - 1].ts)),
      cam03: f3.length,
      cam04: f4.length,
      cam99: fx ? fx.length : null,
      window: d.TIMELAPSE_WINDOW_MS
    };
  });
  r.check("b1-a 2日より古い画像は再生対象から外れる", files.cam02 === 5, files);
  r.check("b1-b 残った画像はすべて2日以内", files.cam02AllRecent, files);
  r.check("b1-c 再生順は時刻の昇順", files.cam02Sorted, files);
  r.check("b1-d 2日以内が1枚も無い場合は保存分をそのまま返す(サーバー停止時の保険)", files.cam03 === 3, files);
  r.check("b1-e 保存画像が無い拠点は空", files.cam04 === 0, files);
  r.check("b1-f マニフェストに無い拠点も空配列(例外にしない)", files.cam99 === 0, files);
  r.check("b1-g 再生対象の期間は2日", files.window === 2 * 24 * HOUR, files.window);

  const notLoaded = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    return d.getSortedPlaybackFiles !== undefined;
  });
  r.check("b1-h 再生対象の抽出関数が公開されている", notLoaded, notLoaded);

  /* ---- 2. ライブカメラ一覧のタイムラプス(Phase N) ---- */
  await page.evaluate(() => window.__dashboardDebug.showView("camlist"));
  const ui = await page.evaluate(() => {
    const grid = document.getElementById("camGrid");
    const cards = grid.querySelectorAll(".simple-card");
    const first = cards[0];
    return {
      cards: cards.length,
      playBtns: grid.querySelectorAll(".camlist-play-btn").length,
      seeks: grid.querySelectorAll(".playback-seek").length,
      badges: grid.querySelectorAll(".playback-badge").length,
      label: first.querySelector(".camlist-play-btn").textContent,
      siteCount: window.__dashboardDebug.CAMLIST_SITES.length
    };
  });
  r.check("b2-a 一覧の全カードに再生ボタンがある", ui.playBtns === ui.cards && ui.cards > 0, ui);
  r.check("b2-b 全カードにシークバーがある", ui.seeks === ui.cards, ui);
  r.check("b2-c 全カードに時刻バッジがある", ui.badges === ui.cards, ui);
  r.check("b2-d ボタンの初期表示は「▶ 再生」", ui.label === "▶ 再生", ui.label);
  r.check("b2-e カード数が対象拠点数と一致", ui.cards === ui.siteCount, ui);

  const play = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    d.startCamlistPlayback("cam02");
    const s = d.siteStates.cam02;
    const st = d.getCamlistPlaybackState();
    return {
      siteId: st.siteId, active: st.active, index: st.index,
      label: s.camPlayBtnEl.textContent,
      badge: s.camBadgeEl.textContent, badgeShown: s.camBadgeEl.style.display,
      status: s.camPlayStatusEl.textContent,
      src: s.camImgEl.getAttribute("src"),
      seekMax: s.camSeekEl.max, seekDisabled: s.camSeekEl.disabled
    };
  });
  r.check("b3-a 再生が開始される", play.active === true && play.siteId === "cam02", play);
  r.check("b3-b ボタンが「■ 停止」へ変わる", play.label === "■ 停止", play.label);
  r.check("b3-c 保存画像が表示される", /data\/images\/cam02\//.test(play.src || ""), play.src);
  r.check("b3-d 撮影時刻バッジが表示される", play.badgeShown === "block" && /\d/.test(play.badge), play);
  r.check("b3-e 「n / N枚を再生中」と表示される", /1 \/ 5枚を再生中/.test(play.status), play.status);
  r.check("b3-f シークバーの上限が枚数-1", play.seekMax === "4" && play.seekDisabled === false, play);

  // コマ送りされること
  await page.waitForTimeout(1300);
  const advanced = await page.evaluate(() => window.__dashboardDebug.getCamlistPlaybackState().index);
  r.check("b3-g 時間経過でコマが進む", advanced >= 1, advanced);

  // 別拠点を再生すると前の拠点は停止してライブへ戻る
  const switched = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    d.startCamlistPlayback("cam03");
    const st = d.getCamlistPlaybackState();
    const prev = d.siteStates.cam02;
    return {
      siteId: st.siteId, active: st.active,
      prevLabel: prev.camPlayBtnEl.textContent,
      prevBadge: prev.camBadgeEl.style.display,
      prevStatus: prev.camPlayStatusEl.textContent
    };
  });
  r.check("b4-a 別拠点の再生へ切り替わる", switched.siteId === "cam03" && switched.active, switched);
  r.check("b4-b 前の拠点のボタンが再生表示へ戻る", switched.prevLabel === "▶ 再生", switched);
  r.check("b4-c 前の拠点のバッジが消える", switched.prevBadge === "none", switched);
  r.check("b4-d 前の拠点の状態表示が消える", switched.prevStatus === "", switched);

  const toggled = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    d.toggleCamlistPlayback("cam03"); // 再生中に押す=停止
    const st = d.getCamlistPlaybackState();
    return { active: st.active, siteId: st.siteId, label: d.siteStates.cam03.camPlayBtnEl.textContent };
  });
  r.check("b4-e 再生中に押すと停止する", toggled.active === false && toggled.siteId === null, toggled);
  r.check("b4-f 停止でボタンが戻る", toggled.label === "▶ 再生", toggled);

  const noImages = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    d.startCamlistPlayback("cam04");
    return {
      status: d.siteStates.cam04.camPlayStatusEl.textContent,
      active: d.getCamlistPlaybackState().active
    };
  });
  r.check("b5-a 保存画像が無ければその旨を表示する", noImages.status.includes("保存済みの画像がありません"), noImages);
  r.check("b5-b 保存画像が無ければ再生しない", noImages.active === false, noImages);

  // 一覧から離れると再生が止まる
  const leave = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    d.startCamlistPlayback("cam02");
    d.showView("power");
    const st = d.getCamlistPlaybackState();
    return { siteId: st.siteId, active: st.active };
  });
  r.check("b5-c 別ビューへ移ると再生が止まる", leave.active === false && leave.siteId === null, leave);

  /* ---- 3. 拠点詳細のタイムラプス ---- */
  const detail = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    d.openSiteDetail("cam02");
    d.showView("site");
    d.startLivePlayback();
    return {
      active: d.isLivePlaybackActive(),
      siteId: d.getLivePlaybackSiteId(),
      status: document.getElementById("livePlaybackStatus").textContent,
      badge: document.getElementById("livePlaybackBadge").style.display,
      src: document.getElementById("liveImg").getAttribute("src"),
      seekMax: d.getLivePlaybackSeekEl().max
    };
  });
  r.check("b6-a 拠点詳細でも再生できる", detail.active === true && detail.siteId === "cam02", detail);
  r.check("b6-b 保存画像が表示される", /data\/images\/cam02\//.test(detail.src || ""), detail.src);
  r.check("b6-c 再生枚数も直近2日分の5枚", detail.seekMax === "4", detail);
  r.check("b6-d 撮影時刻バッジが出る", detail.badge === "block", detail);
  r.check("b6-e 状態表示に枚数が入る", /5枚/.test(detail.status), detail.status);

  const stopDetail = await page.evaluate(() => {
    const d = window.__dashboardDebug;
    d.stopLivePlayback(true);
    return { active: d.isLivePlaybackActive() };
  });
  r.check("b6-f 停止できる", stopDetail.active === false, stopDetail);

  r.check("b7-a 一連の再生操作でページ例外が発生しない", page.errMsgs().length === 0, page.errMsgs());
  await page.close();

  /* ---- 4. マニフェストをまだ読み込めていない場合 ---- */
  const page2 = await newPage(null, { nowMs: NOW });
  // 応答を返さないことで「読み込み中」の状態を再現する(後から登録したルートが優先される)
  await page2.route("**/data/images/manifest.json*", () => {});
  await openDashboard(page2);
  await page2.waitForTimeout(500);
  const loading = await page2.evaluate(() => {
    const d = window.__dashboardDebug;
    d.showView("camlist");
    d.startCamlistPlayback("cam02");
    return {
      files: d.getSortedPlaybackFiles("cam02"),
      status: d.siteStates.cam02.camPlayStatusEl.textContent,
      active: d.getCamlistPlaybackState().active
    };
  });
  r.check("b8-a 読み込み前はnullを返す(「画像が無い」と区別する)", loading.files === null, loading.files);
  r.check("b8-b 読み込み中である旨を表示する", loading.status.includes("読み込み中"), loading.status);
  r.check("b8-c 読み込み前は再生を始めない", loading.active === false, loading);
  await page2.close();

  /* ---- 5. マニフェストの取得に失敗した場合 ---- */
  const page3 = await newPage(null, { nowMs: NOW, manifestStatus: 404 });
  await openDashboard(page3);
  await page3.waitForTimeout(800);
  const failed = await page3.evaluate(() => {
    const d = window.__dashboardDebug;
    d.showView("camlist");
    d.startCamlistPlayback("cam02");
    return {
      files: d.getSortedPlaybackFiles("cam02"),
      status: d.siteStates.cam02.camPlayStatusEl.textContent,
      active: d.getCamlistPlaybackState().active
    };
  });
  r.check("b9-a 取得に失敗したら空一覧として扱う", Array.isArray(failed.files) && failed.files.length === 0, failed.files);
  r.check("b9-b 「保存済みの画像がありません」と表示する", failed.status.includes("保存済みの画像がありません"), failed.status);
  r.check("b9-c 再生は始まらない", failed.active === false, failed);
  r.check("b9-d ページ例外にはならない", page3.errMsgs().length === 0, page3.errMsgs());
  await page3.close();

  return r.finish();
}

if (process.argv[1] && process.argv[1].endsWith("test_playback.mjs")) {
  run().then(async (c) => { await teardown(); process.exit(c.fail ? 1 : 0); });
}
