// テスト共通の土台。
//  - Playwrightのブラウザ起動
//  - 外部への通信をすべてモックしたページの生成(ネットワークに依存せず再現性を保つ)
//  - フィクスチャ生成(中継サーバーの電源CSV / Open-Meteoの1時間データ / 画像マニフェスト)
//  - 合否カウントとレポート
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, PORT } from "./server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BASE = "http://127.0.0.1:" + PORT;

const fakeLeafletJs = fs.readFileSync(path.join(__dirname, "fake-leaflet.js"), "utf8");
// 1x1のJPEG(画像取得の成功を模す)
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);

/* ---------------- フィクスチャ ---------------- */

// 中継サーバー(mini.lhlab-vps.net)が公開している電源CSVと同じ形式のデータ。
export const POWER_CSV_HEADER =
  "timestamp,id,name,source,status,detail,age_s,pv_mv,pv_ma,pv_w,bat_mv,bat_charge_ma," +
  "bat_discharge_ma,bat_net_ma,ld1_ma,ld2_ma,ld3_ma,load_w,gen_wh_today,load_wh_today";

// 既定の拠点セット(中継サーバー側の実際の表記に合わせる)。
// 「開発室」「宗光寺」はダッシュボードに存在しない拠点で、無視されることの確認用。
export const DEFAULT_POWER_NAMES = [
  ["中郷第１樋管", 12700], ["祇園大橋", 12500], ["うるおい広場", 12100],
  ["白滝公園", 11600], ["こも池", 12600], ["竹倉用水路", 12300],
  ["ほたるの里", 12000], ["北沢アンダー", 12100], ["多呂樋管", 12100],
  ["開発室", 13400], ["宗光寺", 11700]
];

export function buildPowerCsv(opts) {
  opts = opts || {};
  const now = opts.nowMs || Date.now();
  const count = opts.count || 30;
  const stepMs = opts.stepMs || 10 * 60 * 1000;
  const names = opts.names || DEFAULT_POWER_NAMES;
  const endOffsetMs = opts.endOffsetMs || 0;
  const lines = [POWER_CSV_HEADER];
  for (let i = count - 1; i >= 0; i--) {
    const t = new Date(now - endOffsetMs - i * stepMs).toISOString();
    names.forEach(([name, batMv], idx) => {
      const pvW = (1 + idx * 0.5 + (count - i) * 0.01).toFixed(3);
      lines.push([t, idx, name, "solar", "ok", "", 120, 18500, 600, pvW, batMv,
        700, 100, 600, 90, 5, 500, "10.4", "0.0", "0.0"].join(","));
    });
  }
  return lines.join("\n") + "\n";
}

// Open-Meteoの1時間ごとデータ(過去48時間 + 未来36時間)。
// 日射量はテスト実行時刻に依存しないよう、現在時刻からの相対時間で山形に生成する
// (実行が夜間だと過去の日射量が全て0になり、発電の回帰が成立しなくなるため)。
export function buildHourly(opts) {
  opts = opts || {};
  const now = opts.nowMs || Date.now();
  const time = [], precipitation = [], shortwave_radiation = [], temperature_2m = [], cloud_cover = [];
  const p2 = (n) => String(n).padStart(2, "0");
  for (let h = -48; h <= 36; h++) {
    const jst = new Date(now + h * 3600000 + 9 * 3600000);
    time.push(`${jst.getUTCFullYear()}-${p2(jst.getUTCMonth() + 1)}-${p2(jst.getUTCDate())}T${p2(jst.getUTCHours())}:00`);
    precipitation.push(opts.rain === false ? 0 : (h >= 2 && h <= 5 ? 3.0 : 0));
    shortwave_radiation.push(Math.max(20, 500 - Math.abs(((h % 24) + 24) % 24 - 12) * 40));
    temperature_2m.push(25 + (h % 5));
    cloud_cover.push(40);
  }
  return { time, precipitation, shortwave_radiation, temperature_2m, cloud_cover };
}

export function buildImageManifest(opts) {
  opts = opts || {};
  const now = opts.nowMs || Date.now();
  const siteIds = opts.siteIds || ["cam02", "cam03"];
  const count = opts.count || 5;
  const stepMs = opts.stepMs || 30 * 60 * 1000;
  const sites = {};
  siteIds.forEach((id) => {
    sites[id] = {
      name: id,
      files: Array.from({ length: count }, (_, i) => ({
        ts: new Date(now - (count - i) * stepMs).toISOString(),
        file: "data/images/" + id + "/f" + i + ".jpg"
      }))
    };
  });
  return { generatedAt: new Date(now).toISOString(), retentionDays: 2, sites };
}

/* ---------------- ブラウザ ---------------- */

let browser = null;
let server = null;

export async function setup() {
  if (!server) server = await startServer();
  if (!browser) browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  return { browser, server };
}

export async function teardown() {
  if (browser) { await browser.close(); browser = null; }
  if (server) { await new Promise((r) => server.close(r)); server = null; }
}

// 外部通信をすべてモックしたページを返す。opts で個別に差し替えられる。
export async function newPage(viewport, opts) {
  opts = opts || {};
  const page = await browser.newPage({ viewport: viewport || { width: 1400, height: 1000 } });
  const errMsgs = [];
  page.on("pageerror", (err) => { errMsgs.push(err.message); console.log("PAGE EXCEPTION:", err.message); });
  page.errMsgs = () => errMsgs;

  const nowMs = opts.nowMs || Date.now();

  await page.route("**/leaflet*.js", (r) => r.fulfill({ contentType: "application/javascript", body: fakeLeafletJs }));
  await page.route("**/leaflet*.css", (r) => r.fulfill({ contentType: "text/css", body: "" }));
  await page.route("**/jszip*.js", (r) => r.abort());
  await page.route("**/*.tile.openstreetmap.org/**", (r) => r.fulfill({ contentType: "image/png", body: TINY_JPEG }));

  // matsuhisa.info 系(水位・画像・旧PV/BAT)
  await page.route("**/matsuhisa.info/**/test.cgi", (r) => r.fulfill({
    contentType: "text/html",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: opts.matsuhisaBody ||
      'PV=13200mV BAT=12600mV Measure Time=2026-09-19 20:00:00 Distance=120.5cm <img src="pic.jpg">'
  }));
  await page.route("**/pic.jpg*", (r) => r.fulfill({ contentType: "image/jpeg", body: TINY_JPEG }));
  await page.route("**/mishima-waterdx.com/**", (r) => r.fulfill({ contentType: "image/jpeg", body: TINY_JPEG }));

  // 国交省「川の防災情報」(水位)。swstg は stgHght を返す必要があるため先に汎用→後で個別に上書き。
  await page.route("**/www.river.go.jp/kawabou/file/files/tmlist/**", (r) => r.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ obsValue: { stg: 9.99, obsTime: new Date(nowMs).toISOString() } })
  }));
  await page.route("**/www.river.go.jp/kawabou/file/files/tmlist/swstg/**", (r) => r.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      obsValue: { stg: 26.29, stgHght: -1.27, obsTime: new Date(nowMs).toISOString(), tmObsTime: new Date(nowMs).toISOString() }
    })
  }));

  // カメラ(国交省・静岡県)
  await page.route("**/cam.river.go.jp/cam/now/*.json", (r) => r.fulfill({
    contentType: "application/json", body: JSON.stringify({ get_time: new Date(nowMs).toISOString() })
  }));
  await page.route("**/cam.river.go.jp/cam/**/*.jpg*", (r) => r.fulfill({ contentType: "image/jpeg", body: TINY_JPEG }));
  await page.route("**/www.cam.shizuoka4.jp/cam/*.json*", (r) => r.fulfill({
    contentType: "application/json", body: JSON.stringify({ obsdate: "2026/09/19 20:04" })
  }));
  await page.route("**/www.cam.shizuoka4.jp/**/*.jpg*", (r) => r.fulfill({ contentType: "image/jpeg", body: TINY_JPEG }));

  await page.route("**/hitscounter.dev/**", (r) => r.fulfill({ contentType: "image/svg+xml", body: "<svg></svg>" }));

  // 気象庁ナウキャスト
  const jmaNow = new Date(Math.floor(nowMs / 300000) * 300000);
  const jmaStr = (d) => {
    const p2 = (n) => String(n).padStart(2, "0");
    return String(d.getUTCFullYear()) + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) +
      p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + "00";
  };
  // ナウキャストのタイル画像。targetTimes_*.json と同じ配下にあるため、
  // より限定的な targetTimes のルートを後に登録して優先させる(Playwrightのルートは後勝ち)。
  await page.route("**/jmatile/data/nowc/**", (r) => r.fulfill({ contentType: "image/png", body: TINY_JPEG }));

  await page.route("**/targetTimes_N1.json*", (r) => r.fulfill({
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(opts.nowcastN1 || [{ basetime: jmaStr(jmaNow), validtime: jmaStr(jmaNow), elements: ["hrpns"] }])
  }));
  await page.route("**/targetTimes_N2.json*", (r) => {
    if (opts.nowcastN2) return r.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(opts.nowcastN2) });
    const frames = [];
    for (let i = 1; i <= 12; i++) {
      frames.push({ basetime: jmaStr(jmaNow), validtime: jmaStr(new Date(jmaNow.getTime() + i * 300000)), elements: ["hrpns"] });
    }
    r.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(frames) });
  });

  // Open-Meteo(4日間天気 + 1時間ごとの実績/予報)
  await page.route("**/api.open-meteo.com/**", (r) => {
    if (opts.openMeteoStatus && opts.openMeteoStatus !== 200) {
      return r.fulfill({ status: opts.openMeteoStatus, body: "error" });
    }
    r.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        daily: {
          time: ["2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21"],
          weathercode: [1, 61, 0, 3],
          temperature_2m_max: [30.5, 27.2, 33.1, 29.4],
          temperature_2m_min: [23.1, 22.5, 24.0, 23.8],
          precipitation_sum: [0, 12.4, 0, 1.2]
        },
        hourly: opts.hourly || buildHourly({ nowMs })
      })
    });
  });

  // 中継サーバーの電源CSV
  await page.route("**/mini.lhlab-vps.net/power/logs/**", (r) => {
    if (opts.powerCsvStatus && opts.powerCsvStatus !== 200) {
      return r.fulfill({ status: opts.powerCsvStatus, body: "not found" });
    }
    if (opts.powerCsvHandler) return opts.powerCsvHandler(r);
    r.fulfill({
      contentType: "text/csv",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: opts.powerCsv || buildPowerCsv({ nowMs })
    });
  });

  // サーバー保存データ(既定は未作成=404)
  await page.route("**/data/recent.csv*", (r) => opts.recentCsv
    ? r.fulfill({ contentType: "text/csv", body: opts.recentCsv })
    : r.fulfill({ status: 404, body: "not found" }));
  await page.route("**/data/recent_water.csv*", (r) => opts.recentWaterCsv
    ? r.fulfill({ contentType: "text/csv", body: opts.recentWaterCsv })
    : r.fulfill({ status: 404, body: "not found" }));
  await page.route("**/data/images/manifest.json*", (r) => {
    if (opts.manifestStatus && opts.manifestStatus !== 200) return r.fulfill({ status: opts.manifestStatus, body: "not found" });
    r.fulfill({ contentType: "application/json", body: JSON.stringify(opts.manifest || buildImageManifest({ nowMs })) });
  });
  await page.route("**/data/images/*/*.jpg*", (r) => r.fulfill({ contentType: "image/jpeg", body: TINY_JPEG }));

  // r.jina.ai プロキシ。URLの中に本来の取得先(例: mini.lhlab-vps.net/power/logs/...)を含むため、
  // 他のルートより後に登録して最優先にする(Playwrightのルートは後勝ち)。
  await page.route("**/r.jina.ai/**", (r) => r.fulfill({
    contentType: "text/plain",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: opts.jinaBody || 'Markdown Content:\n{"obsdate":"2026\\/09\\/19 20:04"}'
  }));


  return page;
}

// ダッシュボードの初期化完了(デバッグフックの公開)を待つ
export async function openDashboard(page, waitFor) {
  await page.goto(BASE + "/index.html", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__dashboardDebug, { timeout: 15000 });
  if (waitFor) await page.waitForFunction(waitFor, { timeout: 15000 });
  return page;
}

/* ---------------- 合否 ---------------- */

export function createReporter(suiteName) {
  let pass = 0, fail = 0;
  return {
    check(label, cond, extra) {
      if (cond) { pass++; console.log("PASS:", label); }
      else { fail++; console.log("FAIL:", label, extra !== undefined ? JSON.stringify(extra) : ""); }
    },
    finish() {
      console.log(`\n==== ${suiteName}: ${pass} passed, ${fail} failed ====`);
      return { pass, fail };
    },
    get counts() { return { pass, fail }; }
  };
}
