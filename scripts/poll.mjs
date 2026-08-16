// 三島カメラ 水位・電源監視ダッシュボード - サーバー側データ取得スクリプト
// GitHub Actions のスケジュール実行から呼び出され、全27拠点(電源監視20拠点+水位監視26拠点、
// 重複を除くと27拠点)のページを直接取得し(サーバー側実行のためブラウザのようなCORS制限を受けない)、
// 結果を data/history.csv（全期間・追記のみ）、data/recent.csv（直近26時間のみ・毎回作り直し）、
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

const CSV_HEADER = "拠点,取得時刻,機器の計測時刻,PV(V),BAT(V),水位(m),取得方法";
const VIA_LABEL = "サーバー(直接取得)";
const FETCH_TIMEOUT_MS = 15000;
const RECENT_WINDOW_MS = 26 * 60 * 60 * 1000; // グラフの24時間表示に2時間の余裕を持たせる

// ---- 拠点一覧(ダッシュボード本体=index.htmlのSITE_CATALOGと同じもの、27拠点) ----
// correction/opがnullの拠点(cam01)は水位センサーを搭載していないため、水位は常にnullとなる。
const SITES = [
  { id: "cam02", name: "中郷第１樋管（大場川 / 御園）", lat: 35.076968, lon: 138.92336, correction: 5510, op: "-", hasPower: true },
  { id: "cam03", name: "北沢アンダーパス（大場川 / 北沢）", lat: 35.104197, lon: 138.93567, correction: -4600, op: "+", hasPower: true },
  { id: "cam04", name: "中郷第２樋管（大場川 / 安久）", lat: 35.080086, lon: 138.927194, correction: 5370, op: "-", hasPower: true },
  { id: "cam11", name: "祇園大橋（大場川 / 大宮町）", lat: 35.128488, lon: 138.919897, correction: 14404, op: "-", hasPower: true },
  { id: "cam12", name: "安間樋管（大場川 / 安久）", lat: 35.086723, lon: 138.935544, correction: 4605, op: "-", hasPower: true },
  { id: "cam13", name: "上町樋管（大場川 / 大場）", lat: 35.091256929022705, lon: 138.93490398807066, correction: 4296, op: "-", hasPower: true },
  { id: "cam14", name: "多呂樋管（大場川 / 多呂）", lat: 35.097909, lon: 138.93508, correction: 4807, op: "-", hasPower: true },
  { id: "cam42", name: "桜川（大宮町）", lat: 35.122811, lon: 138.914822, correction: -30, op: "+", hasPower: true },
  { id: "cam41", name: "こも池（桜川 / 大宮町）", lat: 35.124868, lon: 138.915501, correction: 2940, op: "-", hasPower: false },
  { id: "cam43", name: "芝橋（源兵衛川 / 芝本町）", lat: 35.121895, lon: 138.912451, correction: 3630, op: "-", hasPower: true },
  { id: "cam44", name: "ほたるの里（蓮沼川 / 泉町）", lat: 35.121932, lon: 138.911685, correction: 50, op: "+", hasPower: false },
  { id: "cam46", name: "清住緑地（境川 / 清住町）", lat: 35.112959, lon: 138.905928, correction: 3960, op: "-", hasPower: true },
  { id: "cam47", name: "中郷温水池（源兵衛川 / 富田町）", lat: 35.107445, lon: 138.917487, correction: 20, op: "+", hasPower: true },
  { id: "cam40", name: "藤代橋（御殿川 / 藤代町）", lat: 35.106978, lon: 138.925618, correction: 2622, op: "-", hasPower: true },
  { id: "cam45", name: "竹倉用水路（竹倉）", lat: 35.115677, lon: 138.942655, correction: 4230, op: "-", hasPower: false },
  { id: "cam39", name: "大場ポンプ場流入水路（大場川 / 大場）", lat: 35.092981, lon: 138.935395, correction: 5010, op: "-", hasPower: false },
  { id: "cam36", name: "梅名樋管1号（御殿川 / 梅名）", lat: 35.092307, lon: 138.932658, correction: 2544, op: "-", hasPower: true },
  { id: "cam48", name: "伊豆島田浄水場（裾野市伊豆島田）", lat: 35.159549, lon: 138.906186, correction: -30000, op: "+", hasPower: false },
  { id: "cam08", name: "宮川橋（観音川 / 大場）", lat: 35.09088, lon: 138.941, correction: 5610, op: "-", hasPower: true },
  { id: "cam09", name: "梅名樋管2号（御殿川 / 梅名）", lat: 35.0941, lon: 138.9308, correction: 4220, op: "-", hasPower: true },
  { id: "cam50", name: "徳倉都市下水路", lat: 35.141042, lon: 138.915697, correction: 4580, op: "-", hasPower: false },
  { id: "cam51", name: "神川都市下水路", lat: 35.126626, lon: 138.923361, correction: 5100, op: "-", hasPower: false },
  { id: "cam52", name: "中村橋（大場川 / 佐野）", lat: 35.16927, lon: 138.9242, correction: 5100, op: "-", hasPower: true },
  { id: "cam53", name: "中島樋管1号（大場川 / 中島）", lat: 35.0967, lon: 138.934, correction: 3230, op: "-", hasPower: true },
  { id: "cam55", name: "幸原山橋（大場川 / 徳倉）", lat: 35.137205, lon: 138.915409, correction: 8540, op: "-", hasPower: true },
  { id: "cam54", name: "中島樋管３号（御殿川 / 中島）", lat: 35.094852, lon: 138.931886, correction: 3350, op: "-", hasPower: true },
  { id: "cam01", name: "うるおい広場（大場川 / 東町）", lat: 35.117832, lon: 138.927083, correction: null, op: null, hasPower: true }
  ].map(function (s) {
      return Object.assign({}, s, {
            url: "https://matsuhisa.info/mishima-" + s.id + "/test.cgi",
            normalImageUrl: "https://mishima-waterdx.com/pic/normal/mishima-" + s.id + ".jpg"
      });
  });

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

// PV/BATが無くても例外を投げない(水位専用拠点はページにPV/BATが無いことがある)。同様にSencer/Distance
// が無くても例外を投げない(電源専用拠点=cam01はページに水位センサー値が無い)。何ひとつ取得できなかった
// (pv, bat, waterLevelM, imageUrl のすべてがnull/未取得)場合のみ、そのサイクルの失敗として例外を投げる。
function parseReading(rawText, baseUrl, site) {
    var imageUrl = extractImageUrl(rawText, baseUrl);
    var text = stripTags(rawText);
    var pvMatch = text.match(/PV\s*[=＝]\s*(-?\d+(?:\.\d+)?)\s*m?V/i);
    var batMatch = text.match(/BAT\s*[=＝]\s*(-?\d+(?:\.\d+)?)\s*m?V/i);
    var timeMatch = text.match(/Measure\s*Time\s*[=＝]\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/i);
    var sensorMatch = text.match(/(?:Sencer|Distance)\s*[=＝]\s*(-?\d+(?:\.\d+)?)\s*cm/i);

  var pv = pvMatch ? parseFloat(pvMatch[1]) / 1000 : null;
    var bat = batMatch ? parseFloat(batMatch[1]) / 1000 : null;

  var waterLevelM = null;
    if (sensorMatch && site && typeof site.correction === "number" && site.op) {
          var rawCm = parseFloat(sensorMatch[1]);
          waterLevelM = (site.op === "-" ? (site.correction - rawCm * 10) : (site.correction + rawCm * 10)) / 1000;
    }

  if (pv === null && bat === null && waterLevelM === null && !imageUrl) {
        throw new Error("ページ内にPV/BAT/水位/画像のいずれも見つかりませんでした");
  }

  return {
        pv: pv,
        bat: bat,
        measureTime: timeMatch ? timeMatch[1] : null,
        imageUrl: imageUrl,
        waterLevelM: waterLevelM
  };
}

// ---- 取得(サーバー実行のためCORSプロキシは不要、直接取得のみ・1サイクルにつき1回のみ試行) ----
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
    // ---- 後方互換のヘッダー移行 ----
  // history.csv / recent.csv は旧6列ヘッダー("拠点,取得時刻,機器の計測時刻,PV(V),BAT(V),取得方法")のまま
  // 何千行ものデータ行を35回以上のコミットにわたって蓄積してきている可能性がある。ファイルが既に存在する
  // (上のtry/catchでは新規作成されない)場合、先頭行だけを新しい7列ヘッダーに書き換え、2行目以降の既存
  // データ行には一切手を加えない(旧6列の行は永久にそのまま残ってよい。読み込み側=index.htmlのparseCsvRows
  // が行ごとの列数で6列/7列を判別して両対応する設計になっている)。
  // 上のtry/catchは「ファイルが存在しない場合の新規作成」しかカバーしないため、これは独立した処理として
  // 明示的に行う必要がある。
  for (const p of [HISTORY_CSV_PATH, RECENT_CSV_PATH]) {
        const text = await readFile(p, "utf8");
        const newlineIdx = text.indexOf("\n");
        const firstLine = newlineIdx >= 0 ? text.slice(0, newlineIdx) : text;
        if (firstLine !== CSV_HEADER) {
                const rest = newlineIdx >= 0 ? text.slice(newlineIdx + 1) : "";
                await writeFile(p, CSV_HEADER + "\n" + rest, "utf8");
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
                const reading = parseReading(text, site.url, site);
                newCsvRows.push([
                          site.id,
                          fetchedAt.toISOString(),
                          reading.measureTime || "",
                          reading.pv !== null ? reading.pv.toFixed(3) : "",
                          reading.bat !== null ? reading.bat.toFixed(3) : "",
                          reading.waterLevelM !== null ? reading.waterLevelM.toFixed(2) : "",
                          VIA_LABEL
                        ].join(","));
                latest.sites[site.id] = {
                          pv: reading.pv,
                          bat: reading.bat,
                          waterLevelM: reading.waterLevelM,
                          measureTime: reading.measureTime,
                          imageUrl: reading.imageUrl,
                          via: VIA_LABEL,
                          lastSuccessAt: fetchedAt.toISOString(),
                          lastFetchAt: fetchedAt.toISOString(),
                          lastFetchOk: true,
                          lastError: null
                };
                console.log("[OK] " + site.id + ": PV=" + (reading.pv !== null ? reading.pv.toFixed(3) + "V" : "-") +
                                    " BAT=" + (reading.bat !== null ? reading.bat.toFixed(3) + "V" : "-") +
                                    " 水位=" + (reading.waterLevelM !== null ? reading.waterLevelM.toFixed(2) + "m" : "-"));
        } catch (err) {
                const message = err && err.message ? err.message : String(err);
                latest.sites[site.id] = {
                          pv: typeof prev.pv === "number" ? prev.pv : null,
                          bat: typeof prev.bat === "number" ? prev.bat : null,
                          waterLevelM: typeof prev.waterLevelM === "number" ? prev.waterLevelM : null,
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
