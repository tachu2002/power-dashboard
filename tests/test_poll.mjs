// サーバー側取得スクリプト(scripts/poll.mjs)の単体テスト。
//
// poll.mjs は読み込まれた時点で main() を実行し、スクリプトの1つ上の階層の data/ へ
// 書き込むため、リポジトリの data/ を汚さないよう一時ディレクトリへ複製して実行する。
// 外部通信は globalThis.fetch を差し替えて再現する。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createReporter } from "./harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);

const POWER_CSV_HEADER =
  "timestamp,id,name,source,status,detail,age_s,pv_mv,pv_ma,pv_w,bat_mv,bat_charge_ma," +
  "bat_discharge_ma,bat_net_ma,ld1_ma,ld2_ma,ld3_ma,load_w,gen_wh_today,load_wh_today";

function powerCsv(rows) {
  const d = (v, dflt) => (v === undefined ? dflt : v);
  return [POWER_CSV_HEADER].concat(rows.map((x) =>
    [x.ts, 0, x.name, "solar", "ok", "", 120, 18500, 600, x.pvW, x.batMv,
      d(x.chgMa, 700), d(x.disMa, 100), 600, 90, 5, 500,
      d(x.loadW, "10.4"), d(x.genWh, "0.0"), d(x.useWh, "0.0")].join(","))).join("\n") + "\n";
}

// 一時ディレクトリへ scripts/poll.mjs を複製する(data/ はその隣に作られる)
function makeSandbox(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poll-" + tag + "-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(path.join(REPO_ROOT, "scripts", "poll.mjs"), path.join(dir, "scripts", "poll.mjs"));
  return dir;
}

// fetch を差し替えて poll.mjs を1回実行する。cacheBust でモジュールキャッシュを避ける。
async function runPoll(sandbox, handler, cacheBust) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push(u);
    const res = handler(u, opts);
    if (!res) return { ok: false, status: 404, text: async () => "", json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    return Object.assign({
      ok: true, status: 200,
      text: async () => "", json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0)
    }, res);
  };
  try {
    const mod = await import(pathToFileURL(path.join(sandbox, "scripts", "poll.mjs")).href + "?v=" + cacheBust);
    await mod.runPromise;
    return { mod, calls };
  } finally {
    globalThis.fetch = original;
  }
}

// 実データと同じ「オフセット無しの日本時間」表記("2026/09/21 11:50")にする
function jstStamp(ms) {
  const d = new Date(ms + 9 * 3600000);
  const p2 = (n) => String(n).padStart(2, "0");
  return d.getUTCFullYear() + "/" + p2(d.getUTCMonth() + 1) + "/" + p2(d.getUTCDate()) +
    " " + p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes());
}

function readCsv(sandbox, name) {
  const p = path.join(sandbox, "data", name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l.trim().length);
}

export async function run() {
  const r = createReporter("test_poll");
  const now = Date.now();

  /* ============ 1回目: 全拠点の取得と各ファイルの生成 ============ */
  const sandbox = makeSandbox("basic");
  const relayRows = [
    { ts: new Date(now - 20 * 60000).toISOString(), name: "中郷第１樋管", pvW: "12.500", batMv: 12700 },
    { ts: new Date(now - 10 * 60000).toISOString(), name: "中郷第１樋管", pvW: "9.250", batMv: 12650 },
    { ts: new Date(now - 10 * 60000).toISOString(), name: "白滝公園", pvW: "3.750", batMv: 11600 },
    { ts: new Date(now - 10 * 60000).toISOString(), name: "開発室", pvW: "1.000", batMv: 13400 }
  ];
  const jpegBody = () => ({
    arrayBuffer: async () => TINY_JPEG.buffer.slice(TINY_JPEG.byteOffset, TINY_JPEG.byteOffset + TINY_JPEG.byteLength)
  });
  const handler = (u) => {
    // 画像は拡張子で先に判定する(matsuhisa配下のpic.jpgなども画像として返すため)
    if (/\.jpg(\?|$)/i.test(u)) return jpegBody();
    if (u.includes("mini.lhlab-vps.net/power/logs/")) return { text: async () => powerCsv(relayRows) };
    if (u.includes("matsuhisa.info")) {
      return { text: async () => 'PV=18500mV BAT=12600mV Measure Time=2026-09-19 20:00:00 Distance=120.5cm <img src="pic.jpg">' };
    }
    if (u.includes("www.river.go.jp") && u.includes("/tmlist/rn/")) {
      // 雨量計(10分雨量)。min10Valuesに過去の並び、obsValueに最新が入る実データの形に合わせる。
      // 観測時刻は実データと同じく「オフセット無しの日本時間」で返す(UTCで動く実行環境で
      // そのまま new Date() すると9時間ずれるため、そこも含めて検証する)。
      return { json: async () => ({
        min10Values: [
          { obsTime: jstStamp(now - 30 * 60000), rn10m: 0 },
          { obsTime: jstStamp(now - 20 * 60000), rn10m: 1.5 }
        ],
        obsValue: { obsTime: jstStamp(now - 10 * 60000), rn10m: 2.5 }
      }) };
    }
    if (u.includes("www.river.go.jp") && u.includes("swstg")) {
      return { json: async () => ({ obsValue: { stg: 26.29, stgHght: -1.27, obsTime: "2026-09-19T20:00:00+09:00" } }) };
    }
    if (u.includes("www.river.go.jp")) {
      return { json: async () => ({ obsValue: { stg: 9.99, obsTime: "2026-09-19T20:00:00+09:00" } }) };
    }
    if (u.includes("cam.shizuoka4.jp") && u.includes(".json")) {
      return { text: async () => '{"obsdate":"2026\\/09\\/19 20:04"}' };
    }
    return { text: async () => "" };
  };
  const first = await runPoll(sandbox, handler, "1");
  const calls1 = first.calls;

  const constants = {
    retention: first.mod.IMAGE_RETENTION_DAYS,
    sites: first.mod.SITES.length,
    kawabouWater: first.mod.KAWABOU_WATER_SITES.length,
    kawabouCamera: first.mod.KAWABOU_CAMERA_SITES.length,
    waterWindow: first.mod.WATER_RECENT_WINDOW_MS
  };
  r.check("s1-a 画像の保持期間が2日", constants.retention === 2, constants.retention);
  r.check("s1-b データ取得対象は38拠点(matsuhisa27 + 川の防災情報11)", constants.sites === 38, constants.sites);
  r.check("s1-c 画像専用拠点が8拠点", constants.kawabouCamera === 8, constants.kawabouCamera);
  r.check("s1-d 水位の保存期間は30日", constants.waterWindow === 30 * 24 * 60 * 60 * 1000, constants.waterWindow);

  const history = readCsv(sandbox, "history.csv");
  const recent = readCsv(sandbox, "recent.csv");
  const water = readCsv(sandbox, "recent_water.csv");
  const latest = JSON.parse(fs.readFileSync(path.join(sandbox, "data", "latest.json"), "utf8"));

  r.check("s2-a history.csvが作られる", !!history, history && history.length);
  r.check("s2-b recent.csvのヘッダーがPV(W)表記",
    recent[0] === "拠点,取得時刻,機器の計測時刻,PV(W),BAT(V),水位(m),取得方法", recent[0]);
  r.check("s2-c 38拠点ぶんの行が書かれる",
    recent.filter((l) => l.includes("サーバー(直接取得)") || l.includes("川の防災情報")).length === 38,
    recent.length);
  r.check("s2-d 中継サーバーの新規行(既知の3行)が追記される",
    recent.filter((l) => l.includes("mini.lhlab-vps.net")).length === 3,
    recent.filter((l) => l.includes("mini.lhlab-vps.net")));
  r.check("s2-e 中継サーバーにしか無い拠点(開発室)は書かれない",
    !recent.some((l) => l.includes("開発室")), recent.slice(-5));

  const relayLine = recent.find((l) => l.includes("mini.lhlab-vps.net") && l.startsWith("cam42,"));
  r.check("s2-f 白滝公園は桜川(cam42)として記録される", !!relayLine, relayLine);
  r.check("s2-g 中継サーバー行のPV列は電力(W)", relayLine && relayLine.split(",")[3] === "3.750", relayLine);
  r.check("s2-h 中継サーバー行のBAT列はV換算", relayLine && relayLine.split(",")[4] === "11.600", relayLine);
  r.check("s2-i 中継サーバー行には水位が入らない", relayLine && relayLine.split(",")[5] === "", relayLine);

  const matsuLine = recent.find((l) => l.startsWith("cam02,") && l.includes("サーバー(直接取得)"));
  r.check("s3-a matsuhisa由来の行のPV列は空(電圧を電力列へ混ぜない)",
    matsuLine && matsuLine.split(",")[3] === "", matsuLine);
  r.check("s3-b matsuhisa由来の行にBATが入る", matsuLine && matsuLine.split(",")[4] === "12.600", matsuLine);
  r.check("s3-c matsuhisa由来の行に水位が入る", matsuLine && /^\d/.test(matsuLine.split(",")[5]), matsuLine);

  r.check("s4-a recent_water.csvは水位のある行のみ",
    water.slice(1).every((l) => l.split(",")[5] !== ""), water.slice(1, 3));
  r.check("s4-b 電源のみの行は水位ファイルに入らない",
    !water.some((l) => l.includes("mini.lhlab-vps.net")), water.length);
  r.check("s4-c 水位を持つ拠点の行数が一致",
    water.length - 1 === recent.slice(1).filter((l) => l.split(",")[5] !== "").length, water.length);

  r.check("s5-a latest.jsonに全拠点が入る", Object.keys(latest.sites).length === 38, Object.keys(latest.sites).length);
  r.check("s5-b 中継サーバーの値がlatestへ反映される",
    latest.sites.cam02.pv === 9.25 && latest.sites.cam42.pv === 3.75,
    { cam02: latest.sites.cam02.pv, cam42: latest.sites.cam42.pv });
  r.check("s5-c 取り込み済みの最終時刻が記録される", !!latest.powerRelay.lastTs, latest.powerRelay);
  r.check("s5-d 拠点ごとに取得成否が記録される", latest.sites.cam02.lastFetchOk === true, latest.sites.cam02);

  const manifest = JSON.parse(fs.readFileSync(path.join(sandbox, "data", "images", "manifest.json"), "utf8"));
  r.check("s6-a 画像マニフェストが作られる", !!manifest.sites, Object.keys(manifest.sites).length);
  r.check("s6-b マニフェストの保持日数が2日", manifest.retentionDays === 2, manifest.retentionDays);
  // 画像を持つのは matsuhisa 27拠点 + 静岡県カメラ3拠点 + 画像専用8拠点 = 38拠点
  // (川の防災情報の水位のみの拠点にはカメラ画像が無い)
  r.check("s6-c 画像を持つ38拠点ぶんが保存される", Object.keys(manifest.sites).length === 38, Object.keys(manifest.sites).length);
  const anyFile = Object.values(manifest.sites)[0].files[0];
  r.check("s6-d 保存パスがdata/images配下", anyFile.file.startsWith("data/images/"), anyFile);
  r.check("s6-e 保存ファイルが実在する", fs.existsSync(path.join(sandbox, anyFile.file)), anyFile.file);

  /* ============ 2回目: 取り込み済みの行を重複させない ============ */
  const second = await runPoll(sandbox, handler, "2");
  const recent2 = readCsv(sandbox, "recent.csv");
  r.check("s7-a 同じ中継サーバーCSVを再取得しても行は増えない",
    recent2.filter((l) => l.includes("mini.lhlab-vps.net")).length === 3,
    recent2.filter((l) => l.includes("mini.lhlab-vps.net")).length);
  r.check("s7-b 通常拠点の行は毎回追記される",
    recent2.filter((l) => l.includes("サーバー(直接取得)") || l.includes("川の防災情報")).length === 76,
    recent2.length);

  /* ============ 3回目: 中継サーバーに新しい行が増えた場合 ============ */
  const relayRows3 = relayRows.concat([
    { ts: new Date(now + 5 * 60000).toISOString(), name: "中郷第１樋管", pvW: "15.000", batMv: 12800 }
  ]);
  const handler3 = (u) => (u.includes("mini.lhlab-vps.net/power/logs/")
    ? { text: async () => powerCsv(relayRows3) } : handler(u));
  await runPoll(sandbox, handler3, "3");
  const recent3 = readCsv(sandbox, "recent.csv");
  r.check("s7-c 新しい行だけが追記される",
    recent3.filter((l) => l.includes("mini.lhlab-vps.net")).length === 4,
    recent3.filter((l) => l.includes("mini.lhlab-vps.net")).length);
  const latest3 = JSON.parse(fs.readFileSync(path.join(sandbox, "data", "latest.json"), "utf8"));
  r.check("s7-d 最新の発電値がlatestへ反映される", latest3.sites.cam02.pv === 15, latest3.sites.cam02.pv);

  /* ============ 中継サーバーが落ちている場合 ============ */
  const sandbox2 = makeSandbox("relayfail");
  const handlerNoRelay = (u) => (u.includes("mini.lhlab-vps.net") ? null : handler(u));
  const failRun = await runPoll(sandbox2, handlerNoRelay, "4");
  const recentF = readCsv(sandbox2, "recent.csv");
  const latestF = JSON.parse(fs.readFileSync(path.join(sandbox2, "data", "latest.json"), "utf8"));
  r.check("s8-a 中継サーバーが落ちていても他拠点の取得は続く",
    recentF.filter((l) => l.includes("サーバー(直接取得)") || l.includes("川の防災情報")).length === 38, recentF.length);
  r.check("s8-b 中継サーバーの行は書かれない", !recentF.some((l) => l.includes("mini.lhlab-vps.net")), recentF.length);
  r.check("s8-c 発電(PV)はnullのまま", latestF.sites.cam02.pv === null, latestF.sites.cam02);
  r.check("s8-d 取り込み済み時刻はnull", latestF.powerRelay.lastTs === null, latestF.powerRelay);

  // 前回値の引き継ぎ: PVを持つlatest.jsonがある状態で中継サーバーが落ちても値が消えないこと
  const latestPath = path.join(sandbox2, "data", "latest.json");
  const patched = JSON.parse(fs.readFileSync(latestPath, "utf8"));
  patched.sites.cam02.pv = 8.88;
  fs.writeFileSync(latestPath, JSON.stringify(patched, null, 2) + "\n");
  await runPoll(sandbox2, handlerNoRelay, "5");
  const latestCarry = JSON.parse(fs.readFileSync(latestPath, "utf8"));
  r.check("s8-e 新しい行が無い回でも前回の発電値を引き継ぐ", latestCarry.sites.cam02.pv === 8.88, latestCarry.sites.cam02);

  /* ============ 画像の保持期間(2日)を超えた分の削除 ============ */
  const sandbox3 = makeSandbox("retention");
  const imagesDir = path.join(sandbox3, "data", "images", "cam02");
  fs.mkdirSync(imagesDir, { recursive: true });
  const oldRel = "data/images/cam02/old.jpg";
  const freshRel = "data/images/cam02/fresh.jpg";
  fs.writeFileSync(path.join(sandbox3, oldRel), TINY_JPEG);
  fs.writeFileSync(path.join(sandbox3, freshRel), TINY_JPEG);
  fs.writeFileSync(path.join(sandbox3, "data", "images", "manifest.json"), JSON.stringify({
    generatedAt: new Date(now - 5 * 24 * 3600000).toISOString(),
    retentionDays: 7,
    sites: {
      cam02: {
        name: "中郷第１樋管", files: [
          { ts: new Date(now - 5 * 24 * 3600000).toISOString(), file: oldRel },   // 2日より古い
          { ts: new Date(now - 3 * 3600000).toISOString(), file: freshRel }       // 2日以内
        ]
      }
    }
  }, null, 2) + "\n");

  await runPoll(sandbox3, handler, "6");
  const m3 = JSON.parse(fs.readFileSync(path.join(sandbox3, "data", "images", "manifest.json"), "utf8"));
  const cam02Files = m3.sites.cam02.files.map((f) => f.file);
  r.check("s11-a 2日より古い画像がマニフェストから消える", !cam02Files.includes(oldRel), cam02Files);
  r.check("s11-b 2日より古い画像の実体も削除される", !fs.existsSync(path.join(sandbox3, oldRel)), oldRel);
  r.check("s11-c 2日以内の画像は残る", cam02Files.includes(freshRel) && fs.existsSync(path.join(sandbox3, freshRel)), cam02Files);
  r.check("s11-d 今回取得した画像が追加される", cam02Files.length >= 2, cam02Files);
  r.check("s11-e 保持日数が2日へ更新される", m3.retentionDays === 2, m3.retentionDays);
  r.check("s11-f ファイル一覧が時刻の昇順",
    m3.sites.cam02.files.every((f, i) => i === 0 || Date.parse(f.ts) >= Date.parse(m3.sites.cam02.files[i - 1].ts)),
    m3.sites.cam02.files.map((f) => f.ts));
  r.check("s11-g 生成時刻が更新される", Date.parse(m3.generatedAt) > now - 60000, m3.generatedAt);

  /* ============ 画像の保存先・縮小・スキップ(2026-09-20の見直し) ============ */
  // マニフェストには「ダッシュボードが読むURL(file)」と「リポジトリ内の実体(path)」の両方が入る
  const m1 = JSON.parse(fs.readFileSync(path.join(sandbox, "data", "images", "manifest.json"), "utf8"));
  const anyEntry = Object.values(m1.sites).find((v) => v.files && v.files.length).files[0];
  r.check("s12-a 既定では従来どおり相対パス", anyEntry.file.startsWith("data/images/"), anyEntry);
  r.check("s12-b 実体の位置(path)も持つ", anyEntry.path && anyEntry.path.startsWith("data/images/"), anyEntry);

  // IMAGE_BASE_URL を指定すると、fileが専用ブランチのURLになる
  const sandbox4 = makeSandbox("imgbranch");
  const prevBase = process.env.IMAGE_BASE_URL;
  process.env.IMAGE_BASE_URL = "https://raw.githubusercontent.com/tachu2002/power-dashboard/images/";
  await runPoll(sandbox4, handler, "7");
  delete process.env.IMAGE_BASE_URL;
  if (prevBase) process.env.IMAGE_BASE_URL = prevBase;
  const m2 = JSON.parse(fs.readFileSync(path.join(sandbox4, "data", "images", "manifest.json"), "utf8"));
  const e2 = Object.values(m2.sites).find((v) => v.files && v.files.length).files[0];
  r.check("s12-c 指定するとimagesブランチのURLになる",
    e2.file.indexOf("raw.githubusercontent.com") >= 0 && e2.file.indexOf("/images/") >= 0, e2);
  r.check("s12-d URLの末尾が拠点ID/ファイル名", /\/images\/(cam|kw|kc)\w+\/\d{8}T\d{6}Z\.jpg$/.test(e2.file), e2.file);
  r.check("s12-e 実体の位置はリポジトリ内の相対パスのまま", e2.path.startsWith("data/images/"), e2);
  r.check("s12-f 実体が保存されている", fs.existsSync(path.join(sandbox4, e2.path)), e2.path);

  // SKIP_IMAGES=1 のときは画像を保存しない(データだけ更新する回)
  const sandbox5 = makeSandbox("skipimg");
  process.env.SKIP_IMAGES = "1";
  await runPoll(sandbox5, handler, "8");
  delete process.env.SKIP_IMAGES;
  r.check("s13-a SKIP_IMAGES=1では画像ディレクトリを作らない",
    !fs.existsSync(path.join(sandbox5, "data", "images", "cam02")), "cam02");
  r.check("s13-b データ(CSV)は通常どおり書かれる",
    (readCsv(sandbox5, "recent.csv") || []).length > 30, (readCsv(sandbox5, "recent.csv") || []).length);
  const latest5 = JSON.parse(fs.readFileSync(path.join(sandbox5, "data", "latest.json"), "utf8"));
  r.check("s13-c latest.jsonも通常どおり", Object.keys(latest5.sites).length === 38, Object.keys(latest5.sites).length);

  // 保持期間を過ぎた画像の削除は path を見て行う(fileがURLでも消せる)
  const sandbox6 = makeSandbox("urlretention");
  const dir6 = path.join(sandbox6, "data", "images", "cam02");
  fs.mkdirSync(dir6, { recursive: true });
  fs.writeFileSync(path.join(sandbox6, "data/images/cam02/old.jpg"), TINY_JPEG);
  fs.writeFileSync(path.join(sandbox6, "data", "images", "manifest.json"), JSON.stringify({
    generatedAt: new Date(now - 5 * 24 * 3600000).toISOString(), retentionDays: 2,
    sites: { cam02: { name: "中郷第１樋管", files: [
      { ts: new Date(now - 5 * 24 * 3600000).toISOString(),
        file: "https://raw.githubusercontent.com/tachu2002/power-dashboard/images/cam02/old.jpg",
        path: "data/images/cam02/old.jpg" }
    ] } }
  }, null, 2) + "\n");
  process.env.IMAGE_BASE_URL = "https://raw.githubusercontent.com/tachu2002/power-dashboard/images/";
  await runPoll(sandbox6, handler, "9");
  delete process.env.IMAGE_BASE_URL;
  const m6 = JSON.parse(fs.readFileSync(path.join(sandbox6, "data", "images", "manifest.json"), "utf8"));
  r.check("s14-a URL形式でも古い画像をマニフェストから外す",
    !m6.sites.cam02.files.some((f) => (f.path || "").indexOf("old.jpg") >= 0), m6.sites.cam02.files.map((f) => f.path));
  r.check("s14-b URL形式でも実体を削除する",
    !fs.existsSync(path.join(sandbox6, "data/images/cam02/old.jpg")), "old.jpg");

  fs.rmSync(sandbox4, { recursive: true, force: true });
  fs.rmSync(sandbox5, { recursive: true, force: true });
  fs.rmSync(sandbox6, { recursive: true, force: true });

  // 専用ブランチへ移す前の古いエントリ(相対パスで実体が無い)は一覧から外す。
  // ただし専用ブランチのURL形式のエントリは、その実行で取得していなくても残す。
  const sandbox7 = makeSandbox("legacyentries");
  fs.mkdirSync(path.join(sandbox7, "data", "images", "cam02"), { recursive: true });
  fs.writeFileSync(path.join(sandbox7, "data", "images", "manifest.json"), JSON.stringify({
    generatedAt: new Date(now - 3600000).toISOString(), retentionDays: 2,
    sites: { cam02: { name: "中郷第１樋管", files: [
      // 実体が無い古い形式 → 外れる
      { ts: new Date(now - 3600000).toISOString(), file: "data/images/cam02/gone.jpg" },
      // 専用ブランチのURL形式 → 今回取得していなくても残る
      { ts: new Date(now - 1800000).toISOString(),
        file: "https://raw.githubusercontent.com/tachu2002/power-dashboard/images/cam02/kept.jpg",
        path: "data/images/cam02/kept.jpg" }
    ] } }
  }, null, 2) + "\n");
  process.env.IMAGE_BASE_URL = "https://raw.githubusercontent.com/tachu2002/power-dashboard/images/";
  await runPoll(sandbox7, handler, "10");
  delete process.env.IMAGE_BASE_URL;
  const m7 = JSON.parse(fs.readFileSync(path.join(sandbox7, "data", "images", "manifest.json"), "utf8"));
  const f7 = m7.sites.cam02.files;
  r.check("s15-a 実体の無い古い相対パスのエントリは外す",
    !f7.some((f) => String(f.file).indexOf("gone.jpg") >= 0), f7.map((f) => f.file).slice(0, 4));
  r.check("s15-b 専用ブランチのURLのエントリは今回取得していなくても残る",
    f7.some((f) => String(f.file).indexOf("kept.jpg") >= 0), f7.map((f) => f.file).slice(0, 4));
  r.check("s15-c 今回取得した分も入っている", f7.length >= 2, f7.length);
  fs.rmSync(sandbox7, { recursive: true, force: true });

  // SKIP_MATSUHISA=1: 個人運用のCGI(matsuhisa.info)への負荷を抑えるため、その回は27拠点を取得しない
  const sandbox8 = makeSandbox("skipmatsu");
  await runPoll(sandbox8, handler, "11");          // 1回目は通常どおり全拠点
  process.env.SKIP_MATSUHISA = "1";
  await runPoll(sandbox8, handler, "12");          // 2回目はmatsuhisaをスキップ
  delete process.env.SKIP_MATSUHISA;
  const rec8 = readCsv(sandbox8, "recent.csv");
  const latest8 = JSON.parse(fs.readFileSync(path.join(sandbox8, "data", "latest.json"), "utf8"));
  const matsuRows = rec8.filter((l) => l.includes("サーバー(直接取得)")).length;
  const kawabouRows = rec8.filter((l) => l.includes("川の防災情報")).length;
  r.check("s16-a スキップ回はmatsuhisaの行が増えない(1回目の27行のまま)", matsuRows === 27, matsuRows);
  r.check("s16-b 国交省の拠点は両方の回で取得する(11×2)", kawabouRows === 22, kawabouRows);
  r.check("s16-c スキップした拠点もlatest.jsonから消えない",
    Object.keys(latest8.sites).length === 38, Object.keys(latest8.sites).length);
  r.check("s16-d スキップした拠点は前回の水位を引き継ぐ",
    typeof latest8.sites.cam02.waterLevelM === "number", latest8.sites.cam02);
  fs.rmSync(sandbox8, { recursive: true, force: true });

  /* ============ 純粋関数 ============ */
  const { parsePowerCsv, powerCsvUrlFor, POWER_SOURCE_NAME_TO_ID } = first.mod;
  const parsed = parsePowerCsv(powerCsv(relayRows));
  r.check("s9-a 既知の拠点のみ解釈する", parsed.length === 3, parsed.length);
  r.check("s9-b 時刻の昇順に並ぶ",
    parsed.every((p, i) => i === 0 || p.fetchedAt >= parsed[i - 1].fetchedAt), parsed.map((p) => p.fetchedAt));
  r.check("s9-c PVは電力(W)のまま", parsed[0].pv === 12.5, parsed[0]);
  r.check("s9-d BATはVへ換算", parsed[0].bat === 12.7, parsed[0]);
  r.check("s9-e 空文字は空配列", parsePowerCsv("").length === 0);
  r.check("s9-f 白滝公園が桜川(cam42)へ対応づく", POWER_SOURCE_NAME_TO_ID["白滝公園"] === "cam42");
  r.check("s9-g CSVのURLは日本時間の日付で決まる",
    powerCsvUrlFor(new Date("2026-09-19T23:30:00Z")).endsWith("power-2026-09-20.csv"),
    powerCsvUrlFor(new Date("2026-09-19T23:30:00Z")));

  const { kawabouWaterJsonUrl, kawabouSwstgJsonUrl } = first.mod;
  r.check("s9-h 川の防災情報のURLを組み立てられる",
    kawabouWaterJsonUrl("1234567890123", new Date("2026-09-19T03:00:00Z")).includes("1234567890123"),
    kawabouWaterJsonUrl("1234567890123", new Date("2026-09-19T03:00:00Z")));
  r.check("s9-i 危機管理型水位計のURLも組み立てられる",
    typeof kawabouSwstgJsonUrl("abc", new Date()) === "string");

  /* ============ 雨量(data/rainfall.json) ============ */
  // ブラウザからは取得できなくなった(プロキシがriver.go.jpを遮断)ため、サーバー側で取得して配る。
  const rainPath = path.join(sandbox, "data", "rainfall.json");
  const rain1 = fs.existsSync(rainPath) ? JSON.parse(fs.readFileSync(rainPath, "utf8")) : null;
  r.check("s17-a data/rainfall.jsonが作られる", !!rain1, rain1 && rain1.values.length);
  r.check("s17-b 10分雨量が3件入る(min10Values 2件 + obsValue 1件)", rain1 && rain1.values.length === 3, rain1 && rain1.values);
  r.check("s17-c 時刻の昇順で並ぶ",
    rain1 && rain1.values.every((v, i) => i === 0 || new Date(v.obsTime) > new Date(rain1.values[i - 1].obsTime)), rain1 && rain1.values);
  r.check("s17-d 観測所は「三島」", rain1 && rain1.stationName === "三島" && rain1.obsCd13 === "0563300100034", rain1);
  // オフセット無しの日本時間を9時間ずれずに解釈できていること(UTCで動く実行環境での取り違え防止)
  const expectedNewest = new Date(Math.floor((now - 10 * 60000) / 60000) * 60000);
  expectedNewest.setUTCSeconds(0, 0);
  r.check("s17-e2 日本時間(オフセット無し)を正しく解釈する",
    rain1 && Math.abs(new Date(rain1.values[rain1.values.length - 1].obsTime) - expectedNewest) < 61000,
    { stored: rain1 && rain1.values[rain1.values.length - 1].obsTime, expected: expectedNewest.toISOString() });
  r.check("s17-e3 未来の時刻にならない",
    rain1 && rain1.values.every((v) => new Date(v.obsTime).getTime() <= Date.now() + 60000),
    rain1 && rain1.values.map((v) => v.obsTime));
  r.check("s17-e 雨量のURLは10分区切り",
    calls1.some((u) => /\/tmlist\/rn\/\d{8}\/\d{2}[0-5]0\/0563300100034\.json$/.test(u)),
    calls1.filter((u) => u.includes("/tmlist/rn/")).slice(0, 3));

  // 前回値との併合と、保持期間(3日)を過ぎた値の切り捨て
  const rainSandbox = makeSandbox("rain");
  fs.mkdirSync(path.join(rainSandbox, "data"), { recursive: true });
  fs.writeFileSync(path.join(rainSandbox, "data", "rainfall.json"), JSON.stringify({
    generatedAt: new Date(now - 4 * 86400000).toISOString(),
    values: [
      { obsTime: new Date(now - 4 * 86400000).toISOString(), rn10m: 9 },   // 3日より古い→落ちる
      { obsTime: new Date(now - 60 * 60000).toISOString(), rn10m: 0.5 }    // 残る
    ]
  }), "utf8");
  await runPoll(rainSandbox, handler, "rain1");
  const rain2 = JSON.parse(fs.readFileSync(path.join(rainSandbox, "data", "rainfall.json"), "utf8"));
  r.check("s17-f 前回値と併合する", rain2.values.length === 4, rain2.values.length);
  r.check("s17-g 保持期間(3日)より古い値は落とす",
    !rain2.values.some((v) => Date.now() - new Date(v.obsTime).getTime() > 3 * 86400000), rain2.values.map((v) => v.obsTime));
  r.check("s17-h 前回の新しい値は残る", rain2.values.some((v) => v.rn10m === 0.5), rain2.values);

  // 雨量が取れなくてもデータ取得全体は続く
  const rainFailSandbox = makeSandbox("rainfail");
  const noRainHandler = (u) => (u.includes("/tmlist/rn/") ? null : handler(u));
  await runPoll(rainFailSandbox, noRainHandler, "rainfail1");
  const latestNoRain = JSON.parse(fs.readFileSync(path.join(rainFailSandbox, "data", "latest.json"), "utf8"));
  r.check("s17-i 雨量が取れなくても拠点データは書かれる",
    Object.keys(latestNoRain.sites).length === 38, Object.keys(latestNoRain.sites).length);
  r.check("s17-j 雨量が取れない場合はrainfall.jsonを作らない",
    !fs.existsSync(path.join(rainFailSandbox, "data", "rainfall.json")), "rainfall.json");


  /* ---- 後片付け ---- */
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(sandbox2, { recursive: true, force: true });
  fs.rmSync(sandbox3, { recursive: true, force: true });
  /* ====== バッテリーの持ち(data/power_daily.json → data/battery_health.json) ====== */
  // 実効容量は「1日の収支[Wh]」と「翌日の0時基準電圧の変化」の回帰から出す。
  // 検証用に、容量が既知(WH_PER_V)のバッテリーを想定した日次集計を直接置いて、
  // その容量を正しく復元できるかを見る。
  const healthSandbox = makeSandbox("health");
  fs.mkdirSync(path.join(healthSandbox, "data"), { recursive: true });
  const HOUR = 3600000;
  const dayKey = (ms) => { const d = new Date(ms + 9 * HOUR); return d.toISOString().slice(0, 10); };
  // 既知の容量: 500Wh/V。平均電圧12.3Vなら 500/12.3*1.34 ≒ 54.5Ah
  const WH_PER_V = 500;
  const OCV_SPAN = 12.70 - 11.36;
  const plan = {
    cam11: { v0: 12.40, nightA: 1.00, mains: false },   // 標準的な拠点
    cam03: { v0: 12.03, nightA: 0.96, mains: false },   // 残量が少ない拠点
    cam41: { v0: 12.58, nightA: 0.07, mains: false },   // 消費が極端に小さい拠点
    cam39: { v0: 13.45, nightA: 0.00, mains: true },    // 常時電源
    cam13: { v0: 12.58, nightA: 0.78, mains: false, noisy: true }  // 当てはまりが悪い拠点
  };
  // 14日ぶん。収支は日替わりで振り、電圧は「前日の収支 ÷ 容量」だけ動かす。
  const bal = [-60, 40, -55, 80, -70, 30, -45, 90, -65, 25, -50, 70, -60, 35];
  const daysOut = {};
  Object.keys(plan).forEach((id) => {
    let v = plan[id].v0;
    for (let back = bal.length; back >= 1; back--) {
      const k = dayKey(now - back * 24 * HOUR);
      const b = bal[bal.length - back];
      daysOut[k] = daysOut[k] || {};
      // noisy な拠点は電圧の動きを収支と無関係にして、相関が立たないようにする。
      // 収支(bal)は符号が交互に変わるため、交互の揺らぎを入れると逆に相関してしまう。
      // 収支の並びと周期が合わない別パターンを使う。
      const noise = plan[id].noisy ? [0.08, 0.05, -0.09, 0.07, -0.04, -0.08, 0.06][back % 7] : 0;
      daysOut[k][id] = { v0: Math.round(v * 1000) / 1000, balWh: b,
        nightA: plan[id].nightA || null, vmin: Math.round((v - 0.05) * 1000) / 1000 };
      v += (plan[id].noisy ? 0 : b / WH_PER_V) + noise;
    }
  });
  fs.writeFileSync(path.join(healthSandbox, "data", "power_daily.json"),
    JSON.stringify({ generatedAt: new Date(now).toISOString(), days: daysOut }, null, 2), "utf8");
  // 中継サーバーのCSVは当日ぶん(夜間の放電電流と当日の積算Wh)を返す
  const jstNow0 = new Date(now + 9 * HOUR);
  const todayStart = Date.UTC(jstNow0.getUTCFullYear(), jstNow0.getUTCMonth(), jstNow0.getUTCDate(), 0, 0, 0) - 9 * HOUR;
  const relayName = { cam11: "祇園大橋", cam03: "北沢アンダー", cam41: "こも池", cam39: "大場ポンプ場", cam13: "上町樋管" };
  const nightRows = [];
  Object.keys(plan).forEach((id) => {
    for (let m = 0; m < 4 * 60; m += 10) {   // 0:00〜4:00 を10分刻み
      nightRows.push({ ts: new Date(todayStart + m * 60000).toISOString(), name: relayName[id],
        pvW: "0.000", batMv: Math.round(plan[id].v0 * 1000),
        chgMa: 0, disMa: Math.round(plan[id].nightA * 1000),
        genWh: "0.0", useWh: (m / 60 * 12).toFixed(1) });
    }
  });
  const healthHandler = (u) => {
    if (u.includes("mini.lhlab-vps.net/power/logs/")) return { text: async () => powerCsv(nightRows) };
    return handler(u);
  };
  const hp = await runPoll(healthSandbox, healthHandler, "health1");
  const healthPath = path.join(healthSandbox, "data", "battery_health.json");
  const health = fs.existsSync(healthPath) ? JSON.parse(fs.readFileSync(healthPath, "utf8")) : null;
  const dailyPath = path.join(healthSandbox, "data", "power_daily.json");
  const daily = fs.existsSync(dailyPath) ? JSON.parse(fs.readFileSync(dailyPath, "utf8")) : null;

  r.check("s19-a data/battery_health.jsonが作られる", !!health, health && Object.keys(health.sites || {}).length);
  r.check("s19-b 方式の印と下限SOCを持つ",
    health && health.method === "endurance" && health.reserveSocPct === 20, health && { m: health.method, s: health.reserveSocPct });
  const h11 = health && health.sites.cam11, h03 = health && health.sites.cam03,
    h41 = health && health.sites.cam41, h39 = health && health.sites.cam39, h13 = health && health.sites.cam13;
  // 既知の容量を復元できるか(500Wh/V → 平均電圧で割って電圧幅を掛けた値)
  const expectAh = (v) => WH_PER_V / v * OCV_SPAN;
  r.check("s19-c 収支と0時電圧の回帰から実効容量を復元する",
    h11 && Math.abs(h11.capacityAh - expectAh(h11.v0)) / expectAh(h11.v0) < 0.15,
    h11 && { 実測: h11.capacityAh, 期待: +expectAh(h11.v0).toFixed(1), r: h11.fitR });
  // 遡って取りに行った日ぶんは同じCSVを返すため完全な直線にはならない。0.9以上あれば十分。
  r.check("s19-d 当てはまりの良さ(r)を持つ", h11 && h11.fitR >= 0.9, h11 && h11.fitR);
  r.check("s19-e 0時電圧から残量(SOC)を出す",
    h11 && h11.socPct >= 65 && h11.socPct <= 80 && h03 && h03.socPct < h11.socPct,
    { cam11: h11 && h11.socPct, cam03: h03 && h03.socPct });
  // 持ち時間 = 容量 × (残量% − 20%) ÷ 100 ÷ 夜間電流
  const wantH = (e) => e.capacityAh * (e.socPct - 20) / 100 / e.nightA;
  r.check("s19-f 持ち時間 = 使える容量 ÷ 夜間の消費電流",
    h11 && Math.abs(h11.enduranceH - wantH(h11)) < 0.2, h11);
  r.check("s19-g 消費が小さい拠点ほど長くもつ",
    h41 && h11 && h41.enduranceH > h11.enduranceH * 5, { こも池: h41 && h41.enduranceH, 祇園: h11 && h11.enduranceH });
  r.check("s19-h 残量が少ない拠点は短くなる",
    h03 && h11 && h03.enduranceH < h11.enduranceH, { 北沢: h03 && h03.enduranceH, 祇園: h11 && h11.enduranceH });
  r.check("s19-i 常時電源の拠点は持ち時間を出さない",
    h39 && h39.mains === true && h39.enduranceH === null && h39.capacityAh === null, h39);
  r.check("s19-j 当てはまりが悪い拠点は「測定中」(容量を出さない)",
    h13 && h13.capacityAh === null && h13.enduranceH === null && h13.fitR < 0.6, h13);
  r.check("s19-k 夜間の消費電流を実際の放電電流から出す",
    h11 && Math.abs(h11.nightA - 1.0) < 0.05 && h41 && Math.abs(h41.nightA - 0.07) < 0.02,
    { cam11: h11 && h11.nightA, cam41: h41 && h41.nightA });
  r.check("s19-l 日次集計に当日ぶんが追記される",
    daily && daily.days[dayKey(now)] && daily.days[dayKey(now)].cam11, daily && Object.keys(daily.days).length);
  r.check("s19-m 過去日を少しずつ遡って取りに行く",
    hp.calls.filter((u) => u.includes("/power/logs/")).length >= 2,
    hp.calls.filter((u) => u.includes("/power/logs/")).length);

  // 2回目はすぐには計算し直さない(1時間に1回)
  const firstGeneratedAt = health.generatedAt;
  await runPoll(healthSandbox, healthHandler, "health2");
  const health2 = JSON.parse(fs.readFileSync(healthPath, "utf8"));
  r.check("s19-n 1時間以内は再計算しない", health2.generatedAt === firstGeneratedAt, health2.generatedAt);
  fs.rmSync(healthSandbox, { recursive: true, force: true });

  /* ---- 後片付け ---- */
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(sandbox2, { recursive: true, force: true });
  fs.rmSync(sandbox3, { recursive: true, force: true });
  r.check("s10-a リポジトリのdata/を汚さない", !fs.existsSync(path.join(REPO_ROOT, "data")), "repo/data");

  return r.finish();
}

if (process.argv[1] && process.argv[1].endsWith("test_poll.mjs")) {
  run().then((c) => process.exit(c.fail ? 1 : 0));
}
