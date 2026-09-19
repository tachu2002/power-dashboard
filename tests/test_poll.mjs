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
  return [POWER_CSV_HEADER].concat(rows.map((x) =>
    [x.ts, 0, x.name, "solar", "ok", "", 120, 18500, 600, x.pvW, x.batMv,
      700, 100, 600, 90, 5, 500, "10.4", "0.0", "0.0"].join(","))).join("\n") + "\n";
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
