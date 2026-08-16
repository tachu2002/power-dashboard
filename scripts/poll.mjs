// 三島カメラ 電源監視ダッシュボード - サーバー側データ取得スクリプト
// GitHub Actions のスケジュール実行から呼び出され、全拠点のページを直接取得し
// (サーバー側実行のためブラウザのようなCORS制限を受けない)、結果を
// data/history.csv（全期間・追記のみ）、data/recent.csv（直近26時間のみ・毎回作り直し）、
// data/latest.json（各拠点の最新状態・失敗時は前回成功値を保持）へ書き込む。
"use strict";

import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const HISTORY_CSV_PATH = path.join(DATA_DIR, "history.csv");
const RECENT_CSV_PATH = path.join(DATA_DIR, "recent.csv");
const LATEST_JSON_PATH = path.join(DATA_DIR, "latest.json");

const CSV_HEADER = "拠点,取得時刻,機器の計測時刻,PV(V),BAT(V),取得方法";
const VIA_LABEL = "サーバー(直接取得)";
const FETCH_TIMEOUT_MS = 15000;
const RECENT_WINDOW_MS = 26 * 60 * 60 * 1000; // グラフの24時間表示に2時間の余裕を持たせる

// ---- 拠点一覧(ダッシュボード本体と同じもの) ----
const SITES = [
  { id: "cam01", name: "三島カメラ01", url: "https://matsuhisa.info/mishima-cam01/test.cgi" },
  { id: "cam02", name: "三島カメラ02", url: "https://matsuhisa.info/mishima-cam02/test.cgi" },
  { id: "cam03", name: "三島カメラ03", url: "https://matsuhisa.info/mishima-cam03/test.cgi" },
  { id: "cam04", name: "三島カメラ04", url: "https://matsuhisa.info/mishima-cam04/test.cgi" },
  { id: "cam08", name: "三島カメラ08", url: "https://matsuhisa.info/mishima-cam08/test.cgi" },
  { id: "cam09", name: "三島カメラ09", url: "https://matsuhisa.info/mishima-cam09/test.cgi" },
  { id: "cam11", name: "三島カメラ11", url: "https://matsuhisa.info/mishima-cam11/test.cgi" },
  { id: "cam12", name: "三島カメラ12", url: "https://matsuhisa.info/mishima-cam12/test.cgi" },
  { id: "cam13", name: "三島カメラ13", url: "https://matsuhisa.info/mishima-cam13/test.cgi" },
  { id: "cam14", name: "三島カメラ14", url: "https://matsuhisa.info/mishima-cam14/test.cgi" },
  { id: "cam36", name: "三島カメラ36", url: "https://matsuhisa.info/mishima-cam36/test.cgi" },
  { id: "cam40", name: "三島カメラ40", url: "https://matsuhisa.info/mishima-cam40/test.cgi" },
  { id: "cam42", name: "三島カメラ42", url: "https://matsuhisa.info/mishima-cam42/test.cgi" },
  { id: "cam43", name: "三島カメラ43", url: "https://matsuhisa.info/mishima-cam43/test.cgi" },
  { id: "cam46", name: "三島カメラ46", url: "https://matsuhisa.info/mishima-cam46/test.cgi" },
  { id: "cam47", name: "三島カメラ47", url: "https://matsuhisa.info/mishima-cam47/test.cgi" },
  { id: "cam52", name: "三島カメラ52", url: "https://matsuhisa.info/mishima-cam52/test.cgi" },
  { id: "cam53", name: "三島カメラ53", url: "https://matsuhisa.info/mishima-cam53/test.cgi" },
  { id: "cam54", name: "三島カメラ54", url: "https://matsuhisa.info/mishima-cam54/test.cgi" },
  { id: "cam55", name: "三島カメラ55", url: "https://matsuhisa.info/mishima-cam55/test.cgi" }
];

// ---- ページ本文からの数値・画像URL抽出(ダッシュボード本体と同一ロジック) ----
function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractImageUrl(rawText, baseUrl) {
  var candidates = [];

  var imgTagRegex = /<img\b[^>]*>/gi;
  var srcAttrRegex = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
  var tagMatch;
  while ((tagMatch = imgTagRegex.exec(rawText)) !== null) {
    var srcMatch = srcAttrRegex.exec(tagMatch[0]);
    if (srcMatch) {
      var src = srcMatch[1] || srcMatch[2] || srcMatch[3];
      if (src) candidates.push(src);
    }
  }

  if (!candidates.length) {
    var mdImgRegex = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
    var mdMatch;
    while ((mdMatch = mdImgRegex.exec(rawText)) !== null) {
      if (mdMatch[1]) candidates.push(mdMatch[1]);
    }
  }

  if (!candidates.length) {
    var bareUrlRegex = /(?:https?:\/\/[^\s"'<>()]+?\.jpe?g(?:\?[^\s"'<>()]*)?|[A-Za-z0-9_\-./]+\.jpe?g(?:\?[^\s"'<>()]*)?)(?=[\s"'<>)]|$)/gi;
    var bareMatch;
    while ((bareMatch = bareUrlRegex.exec(rawText)) !== null) {
      candidates.push(bareMatch[0]);
    }
  }

  if (!candidates.length) return null;

  var jpgCandidates = candidates.filter(function (src) {
    return /\.jpe?g(\?|#|$)/i.test(src);
  });
  var chosen = jpgCandidates.length ? jpgCandidates[jpgCandidates.length - 1] : candidates[candidates.length - 1];

  try {
    return new URL(chosen, baseUrl).href;
  } catch (e) {
    return null;
  }
}

function parseReading(rawText, baseUrl) {
  var imageUrl = extractImageUrl(rawText, baseUrl);
  var text = stripTags(rawText);
  var pvMatch = text.match(/PV\s*[=＝]\s*(-?\d+(?:\.\d+)?)\s*m?V/i);
  var batMatch = text.match(/BAT\s*[=＝]\s*(-?\d+(?:\.\d+)?)\s*m?V/i);
  var timeMatch = text.match(/Measure\s*Time\s*[=＝]\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/i);

  if (!pvMatch || !batMatch) {
    throw new Error("ページ内に PV= / BAT= の数値が見つかりませんでした");
  }
  return {
    pv: parseFloat(pvMatch[1]) / 1000,
    bat: parseFloat(batMatch[1]) / 1000,
    measureTime: timeMatch ? timeMatch[1] : null,
    imageUrl: imageUrl
  };
}

// ---- 取得(サーバー実行のためCORSプロキシは不要、直接取得のみ) ----
async function fetchRaw(targetUrl) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(targetUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MishimaPowerMonitor/1.0)" }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    if (!text || !text.trim()) throw new Error("空の応答");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ---- データファイルの初期化 ----
async function ensureDataFiles() {
  await mkdir(DATA_DIR, { recursive: true });
  for (const p of [HISTORY_CSV_PATH, RECENT_CSV_PATH]) {
    try {
      await readFile(p, "utf8");
    } catch (e) {
      await writeFile(p, CSV_HEADER + "\n", "utf8");
    }
  }
}

async function readJsonSafe(p, fallback) {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch (e) {
    return fallback;
  }
}

// data/recent.csv は「直近26時間分のみ」を毎回作り直す(全期間分のhistory.csvは
// 追記のみで読み返さないため、拠点数×5分間隔が積み重なっても取得処理は軽いまま)。
async function rebuildRecentCsv(newRows) {
  let existingLines = [];
  try {
    const text = await readFile(RECENT_CSV_PATH, "utf8");
    existingLines = text.split(/\r?\n/).filter(function (l) { return l.trim().length; });
    if (existingLines.length && existingLines[0].indexOf("拠点") === 0) existingLines.shift();
  } catch (e) {
    existingLines = [];
  }
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const kept = existingLines.filter(function (line) {
    const cols = line.split(",");
    const t = Date.parse(cols[1]);
    return !isNaN(t) && t >= cutoff;
  });
  const combined = kept.concat(newRows);
  await writeFile(RECENT_CSV_PATH, CSV_HEADER + "\n" + combined.join("\n") + (combined.length ? "\n" : ""), "utf8");
}

async function main() {
  await ensureDataFiles();
  const previousLatest = await readJsonSafe(LATEST_JSON_PATH, { sites: {} });
  const latest = { generatedAt: new Date().toISOString(), sites: {} };
  const newCsvRows = [];

  for (const site of SITES) {
    const prev = (previousLatest.sites && previousLatest.sites[site.id]) || {};
    const fetchedAt = new Date();
    try {
      const text = await fetchRaw(site.url);
      const reading = parseReading(text, site.url);
      newCsvRows.push([
        site.id,
        fetchedAt.toISOString(),
        reading.measureTime || "",
        reading.pv.toFixed(3),
        reading.bat.toFixed(3),
        VIA_LABEL
      ].join(","));
      latest.sites[site.id] = {
        pv: reading.pv,
        bat: reading.bat,
        measureTime: reading.measureTime,
        imageUrl: reading.imageUrl,
        via: VIA_LABEL,
        lastSuccessAt: fetchedAt.toISOString(),
        lastFetchAt: fetchedAt.toISOString(),
        lastFetchOk: true,
        lastError: null
      };
      console.log("[OK] " + site.id + ": PV=" + reading.pv.toFixed(3) + "V BAT=" + reading.bat.toFixed(3) + "V");
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      latest.sites[site.id] = {
        pv: typeof prev.pv === "number" ? prev.pv : null,
        bat: typeof prev.bat === "number" ? prev.bat : null,
        measureTime: prev.measureTime || null,
        imageUrl: prev.imageUrl || null,
        via: prev.via || null,
        lastSuccessAt: prev.lastSuccessAt || null,
        lastFetchAt: fetchedAt.toISOString(),
        lastFetchOk: false,
        lastError: message
      };
      console.warn("[NG] " + site.id + ": " + message);
    }
  }

  if (newCsvRows.length) {
    await appendFile(HISTORY_CSV_PATH, newCsvRows.join("\n") + "\n", "utf8");
  }
  await rebuildRecentCsv(newCsvRows);
  await writeFile(LATEST_JSON_PATH, JSON.stringify(latest, null, 2) + "\n", "utf8");

  const okCount = Object.values(latest.sites).filter(function (s) { return s.lastFetchOk; }).length;
  console.log(okCount + "/" + SITES.length + " 拠点の取得に成功しました。");
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
