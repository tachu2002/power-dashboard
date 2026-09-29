// 三島カメラ 水位・電源監視ダッシュボード - サーバー側データ取得スクリプト
// GitHub Actions のスケジュール実行から呼び出され、水位・電源データを持つ全拠点
// (matsuhisa.info系27拠点 + 国交省「川の防災情報」水位11拠点 = 計38拠点)へ
// サーバー側から直接アクセスし(ブラウザのようなCORS制限を受けない)、結果を
// data/history.csv（全期間・追記のみ）、data/recent.csv（直近3日分のみ・毎回作り直し）、
// data/recent_water.csv（水位(m)列が入っている行のみを対象に、直近1か月分を毎回作り直し。
// ダッシュボード起動直後に水位データだけ長めの過去分を読み込めるようにするためのもの。
// グラフの表示範囲自体は従来通り直近1日分のまま変更しない)、
// data/latest.json（各拠点の最新状態・失敗時は前回成功値を保持）へ書き込む。
//
// あわせて、水位・電源データを持たない画像専用拠点(kc01〜kc08)を含む全46拠点の
// カメラ画像を取得し、data/images/<拠点ID>/配下へ保存する(直近IMAGE_RETENTION_DAYS日分のみ保持、
// それより古いものは自動削除)。画像の実体はmainではなく履歴を持たない専用ブランチ(images)へ
// 置く(scripts/publish-images.sh)。data/images/manifest.jsonだけはmainに置き、各画像の
// 「ダッシュボードが読むURL(file)」と「リポジトリ内の実体の位置(path)」を記録する。
// ダッシュボードのタイムラプス再生と「データダウンロード」画面はこのマニフェストを使う。
"use strict";

import { readFile, writeFile, appendFile, mkdir, unlink, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const HISTORY_CSV_PATH = path.join(DATA_DIR, "history.csv");
const RECENT_CSV_PATH = path.join(DATA_DIR, "recent.csv");
const WATER_RECENT_CSV_PATH = path.join(DATA_DIR, "recent_water.csv");
const LATEST_JSON_PATH = path.join(DATA_DIR, "latest.json");
// 雨量計(国交省「川の防災情報」)の10分雨量。ブラウザからは直接もプロキシ経由でも取得できなくなったため
// (2026-09-21: r.jina.ai が www.river.go.jp への匿名アクセスを403で遮断)、サーバー側で取得して配る。
const RAINFALL_JSON_PATH = path.join(DATA_DIR, "rainfall.json");
// バッテリーの劣化指標(祇園大橋を100%とした相対的な残存容量比)。
// 夜間(日射が無い時間帯)の電圧の下がり方を、拠点ごとの消費電力で割って比べる。
const BATTERY_HEALTH_JSON_PATH = path.join(DATA_DIR, "battery_health.json");
const IMAGES_DIR = path.join(DATA_DIR, "images");
const IMAGE_MANIFEST_PATH = path.join(IMAGES_DIR, "manifest.json");
// 画像は直近2日分のみ保持する(タイムラプス再生の対象が直近2日間のため)。
// 画像はmainではなく履歴を持たない専用ブランチ(images)へ置く運用に変更した(2026-09-20)。
// mainへ画像をコミットし続けると、削除しても過去コミットに画像バイトが残るため .git が
// 際限なく増える(実測: 約5週間でリポジトリ2.81GB)。専用ブランチ側は定期的に履歴を畳むことで
// 常に「直近2日分の実体」だけを保持する。scripts/publish-images.sh を参照。
const IMAGE_RETENTION_DAYS = Number(process.env.IMAGE_RETENTION_DAYS || 2);
const IMAGE_RETENTION_MS = IMAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3MB(異常な応答を保存しないための安全上限)
const IMAGE_CONCURRENCY = 5;
// アーカイブ画像は長辺をIMAGE_MAX_WIDTHへ縮小して保存する(タイムラプス表示には十分で、
// 元のまま(1920px・約200KB)保存すると高頻度化したときに容量が膨らみすぎるため)。
// 画面に出ている「現在のライブ映像」は取得元から直接読み込むので、この縮小の影響を受けない。
const IMAGE_MAX_WIDTH = Number(process.env.IMAGE_MAX_WIDTH || 640);
const IMAGE_QUALITY = Number(process.env.IMAGE_QUALITY || 72);
// 画像の公開URLの先頭(専用ブランチのraw URL)。未指定ならmain配下の相対パス(従来どおり)。
const IMAGE_BASE_URL = process.env.IMAGE_BASE_URL || "";
// データ(CSV)だけ更新して画像アーカイブは行わない回に使う(データ10分・画像20分などの使い分け)。
const SKIP_IMAGES = process.env.SKIP_IMAGES === "1";
// matsuhisa.info系27拠点だけを今回は取得しない(この取得元への負荷を抑えるため、
// 国交省の拠点より低い頻度で回す回に使う)。前回値はlatest.jsonへそのまま引き継ぐ。
const SKIP_MATSUHISA = process.env.SKIP_MATSUHISA === "1";

// 拠点,取得時刻,機器の計測時刻,PV(W),BAT(V),水位(m),取得方法 の7列
// (旧バージョンは水位(m)列が無い6列だったため、recent.csv再構築時に旧形式の行は破棄する)
// PV列は発電電圧(V)から発電電力(W)へ変更した(中継サーバー mini.lhlab-vps.net の「発電(PV)」に合わせる)。
const CSV_HEADER = "拠点,取得時刻,機器の計測時刻,PV(W),BAT(V),水位(m),取得方法";
const CSV_COLUMNS = 7;
const VIA_LABEL_MATSUHISA = "サーバー(直接取得)";
const VIA_LABEL_KAWABOU = "サーバー(国交省 川の防災情報)";
const VIA_LABEL_POWER_RELAY = "サーバー(mini.lhlab-vps.net 電源CSV)";
const FETCH_TIMEOUT_MS = 15000;
const RECENT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 水位グラフに十分な直近3日分を保持
const WATER_RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 水位データのみ直近1か月分を別途保持
const CONCURRENCY = 5;

// ---- 拠点一覧(ダッシュボード本体 mishima_dashboard_v1.html の SITE_CATALOG と同じもの) ----
// matsuhisa.info系: correction/opがある拠点は水位も計算する。cam01のみ電源専用(水位計算なし)。
const MATSUHISA_SITES = [
  { id: "cam01", name: "うるおい広場（大場川 / 東町）" },
  { id: "cam02", name: "中郷第１樋管（大場川 / 御園）", correction: 5510, op: "-" },
  { id: "cam03", name: "北沢アンダーパス（大場川 / 北沢）", correction: -4600, op: "+" },
  { id: "cam04", name: "中郷第２樋管（大場川 / 安久）", correction: 5370, op: "-" },
  { id: "cam08", name: "宮川橋（観音川 / 大場）", correction: 5610, op: "-" },
  { id: "cam09", name: "梅名樋管2号（御殿川 / 梅名）", correction: 4220, op: "-" },
  { id: "cam11", name: "祇園大橋（大場川 / 大宮町）", correction: 14404, op: "-" },
  { id: "cam12", name: "安間樋管（大場川 / 安久）", correction: 4605, op: "-" },
  { id: "cam13", name: "上町樋管（大場川 / 大場）", correction: 4296, op: "-" },
  { id: "cam14", name: "多呂樋管（大場川 / 多呂）", correction: 4807, op: "-" },
  { id: "cam36", name: "梅名樋管1号（御殿川 / 梅名）", correction: 2544, op: "-" },
  { id: "cam39", name: "大場ポンプ場流入水路（大場川 / 大場）", correction: 5010, op: "-" },
  { id: "cam40", name: "藤代橋（御殿川 / 藤代町）", correction: 2622, op: "-" },
  { id: "cam41", name: "こも池（桜川 / 大宮町）", correction: 2940, op: "-" },
  { id: "cam42", name: "桜川（大宮町）", correction: -30, op: "+" },
  { id: "cam43", name: "芝橋（源兵衛川 / 芝本町）", correction: 3630, op: "-" },
  { id: "cam44", name: "ほたるの里（蓮沼川 / 泉町）", correction: 50, op: "+" },
  { id: "cam45", name: "竹倉用水路（竹倉）", correction: 4230, op: "-" },
  { id: "cam46", name: "清住緑地（境川 / 清住町）", correction: 3960, op: "-" },
  { id: "cam47", name: "中郷温水池（源兵衛川 / 富田町）", correction: 20, op: "+" },
  { id: "cam48", name: "伊豆島田浄水場（裾野市伊豆島田）", correction: -30000, op: "+" },
  { id: "cam50", name: "徳倉都市下水路", correction: 4580, op: "-" },
  { id: "cam51", name: "神川都市下水路", correction: 5100, op: "-" },
  { id: "cam52", name: "中村橋（大場川 / 佐野）", correction: 5100, op: "-" },
  { id: "cam53", name: "中島樋管1号（大場川 / 中島）", correction: 3230, op: "-" },
  { id: "cam54", name: "中島樋管３号（御殿川 / 中島）", correction: 3350, op: "-" },
  { id: "cam55", name: "幸原山橋（大場川 / 徳倉）", correction: 8540, op: "-" }
].map(function (s) {
  return Object.assign({ sourceType: "matsuhisa", url: "https://matsuhisa.info/mishima-" + s.id + "/test.cgi" }, s);
});

// 国交省「川の防災情報」水位拠点(水位は計算式による補正を行わない生値)
// shizuokaCamtypeは、この拠点の画像取得(静岡県「川の防災情報」河川監視カメラ)に使う識別子。
// kind省略(既定"stg")=通常の水位観測所(obsCd13使用)。kind:"swstg"=危機管理型水位計(obsCd使用、
// URLパスが"stg"ではなく"swstg"、値はobsValue.stgHght(堤防天端からの高さ)を採用。ダッシュボード
// 本体(mishima_dashboard_v1.html)のfetchKawabouWaterReadingと同じ仕様)。
const KAWABOU_WATER_SITES = [
  { id: "kw01", name: "下神川橋（大場川 / 三島市加茂川町）", obsCd13: "0563300400016", shizuokaCamtype: "2036" },
  { id: "kw02", name: "中村橋（大場川 / 三島市中）", obsCd13: "0563300400156", shizuokaCamtype: "2089" },
  { id: "kw03", name: "下御殿橋（御殿川 / 三島市青木）", obsCd13: "0563300400157", shizuokaCamtype: "2090" },
  // --- ここから8拠点追加(2026-08-22、国土交通省「川の防災情報」より。カメラ画像は無くいずれも水位のみ) ---
  { id: "kw04", name: "青木橋（大場川 / 長泉町中土狩）", obsCd13: "0563300400020" },
  { id: "kw05", name: "境川（境川 / 栄町）", kind: "swstg", obsCd: "2200000022" },
  { id: "kw06", name: "島田橋（三島山田川 / 川原ケ谷）", kind: "swstg", obsCd: "2200000031" },
  { id: "kw07", name: "夏梅木橋（夏梅木川 / 谷田）", kind: "swstg", obsCd: "2200000025" },
  { id: "kw08", name: "大場（大場川 / 函南町間宮）", obsCd13: "2182600400010" },
  { id: "kw09", name: "大場川左岸2.3k+44（大場川 / 函南町間宮）", kind: "swstg", obsCd: "8500000282" },
  { id: "kw10", name: "間宮（函南観音川 / 函南町間宮）", obsCd13: "0563300400169" },
  { id: "kw11", name: "徳倉（狩野川 / 清水町下徳倉）", obsCd13: "2182600400007" }
].map(function (s) {
  return Object.assign({ sourceType: "kawabou-water", kind: s.kind || "stg" }, s);
});

const SITES = MATSUHISA_SITES.concat(KAWABOU_WATER_SITES);

// 画像専用拠点(kc01〜kc08、水位・電源データを持たないためSITESには含めない。画像アーカイブのみ対象)。
const KAWABOU_CAMERA_SITES = [
  { id: "kc01", name: "境川排水機場屋上（狩野川 / 三島市）", liveImageUrl: "https://cam.river.go.jp/cam/now/cctv_220001_51C04874.jpg" },
  { id: "kc02", name: "大場川 0.0k+152 右岸（大場川 / 三島市御園）", liveImageUrl: "https://cam.river.go.jp/cam/now/121826024.jpg" },
  { id: "kc03", name: "大場川左岸 2k200（大場川 / 函南町間宮）", liveImageUrl: "https://cam.river.go.jp/cam/now/121826016.jpg" },
  { id: "kc04", name: "大場川（狩野川 / 沼津市大平）", liveImageUrl: "https://cam.river.go.jp/cam/now/cctv_220001_51C03436.jpg" },
  { id: "kc05", name: "狩野川左岸 11k000（狩野川 / 沼津市大平）", liveImageUrl: "https://cam.river.go.jp/cam/now/121826006.jpg" },
  { id: "kc06", name: "函南観音川排水機場 屋上（大場川 / 函南町）", liveImageUrl: "https://cam.river.go.jp/cam/now/cctv_220001_51C04876.jpg" },
  { id: "kc07", name: "狩野川 8.6k+17（狩野川 / 清水町徳倉）", liveImageUrl: "https://cam.river.go.jp/cam/now/121826023.jpg" },
  { id: "kc08", name: "狩野川左岸 7k050（狩野川 / 清水町徳倉）", liveImageUrl: "https://cam.river.go.jp/cam/now/121826004.jpg" }
].map(function (s) {
  return Object.assign({ sourceType: "kawabou-camera" }, s);
});

// ---- matsuhisa.info test.cgi の応答からPV/BAT/計測時刻/水位を抽出 ----
function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// matsuhisa.info test.cgi応答内の<img src>から画像URLを抽出する
// (ダッシュボード本体のextractImageUrlと同等。CORS制限のないサーバー側では追加の取得なしで
// このデータ取得と同じレスポンスから画像URLだけ抜き出せるため効率が良い)。
function extractImageUrl(rawText, baseUrl) {
  const candidates = [];
  const imgTagRegex = /<img\b[^>]*>/gi;
  const srcAttrRegex = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
  let tagMatch;
  while ((tagMatch = imgTagRegex.exec(rawText)) !== null) {
    const srcMatch = srcAttrRegex.exec(tagMatch[0]);
    if (srcMatch) {
      const src = srcMatch[1] || srcMatch[2] || srcMatch[3];
      if (src) candidates.push(src);
    }
  }
  if (!candidates.length) {
    const mdImgRegex = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
    let mdMatch;
    while ((mdMatch = mdImgRegex.exec(rawText)) !== null) {
      if (mdMatch[1]) candidates.push(mdMatch[1]);
    }
  }
  if (!candidates.length) {
    const bareUrlRegex = /(?:https?:\/\/[^\s"'<>()]+?\.jpe?g(?:\?[^\s"'<>()]*)?|[A-Za-z0-9_\-./]+\.jpe?g(?:\?[^\s"'<>()]*)?)(?=[\s"'<>)]|$)/gi;
    let bareMatch;
    while ((bareMatch = bareUrlRegex.exec(rawText)) !== null) {
      candidates.push(bareMatch[0]);
    }
  }
  if (!candidates.length) return null;
  const jpgCandidates = candidates.filter(function (src) { return /\.jpe?g(\?|#|$)/i.test(src); });
  const chosen = jpgCandidates.length ? jpgCandidates[jpgCandidates.length - 1] : candidates[candidates.length - 1];
  try {
    return new URL(chosen, baseUrl).href;
  } catch (e) {
    return null;
  }
}

function parseMatsuhisaReading(rawText, site) {
  const text = stripTags(rawText);
  const pvMatch = text.match(/PV\s*[=＝]\s*(-?\d+(?:\.\d+)?)\s*m?V/i);
  const batMatch = text.match(/BAT\s*[=＝]\s*(-?\d+(?:\.\d+)?)\s*m?V/i);
  const timeMatch = text.match(/Measure\s*Time\s*[=＝]\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/i);
  const sensorMatch = text.match(/(?:Sencer|Distance)\s*[=＝]\s*(-?\d+(?:\.\d+)?)\s*cm/i);

  let waterLevelM = null;
  if (sensorMatch && typeof site.correction === "number" && site.op) {
    const rawMm = parseFloat(sensorMatch[1]) * 10;
    const resultMm = site.op === "+" ? (site.correction + rawMm) : (site.correction - rawMm);
    waterLevelM = resultMm / 1000;
  }
  if (!pvMatch && !batMatch && waterLevelM === null) {
    throw new Error("ページ内にPV=/BAT=/水位の数値が見つかりませんでした");
  }
  return {
    // 発電(PV)は中継サーバー(mini.lhlab-vps.net)の電力(W)を正とするため、
    // matsuhisa.info側のPV値(電圧V)はpvには入れず、pvVoltageとして別に保持する。
    pv: null,
    pvVoltage: pvMatch ? parseFloat(pvMatch[1]) / 1000 : null,
    bat: batMatch ? parseFloat(batMatch[1]) / 1000 : null,
    measureTime: timeMatch ? timeMatch[1] : null,
    waterLevelM: waterLevelM,
    imageUrl: extractImageUrl(rawText, site.url)
  };
}

// ---- 国交省「川の防災情報」水位JSON(5分値、CORS開放済み・サーバー側は直接取得可) ----
// ある瞬間の日本時間(JST=UTC+9)の年月日時分を返す。
// 以前は getTimezoneOffset() で補正してから+9時間していたが、これはUTC以外のタイムゾーンで
// 動かすと相殺されてずれる(日本時間で動かすと結果がUTCになる)。GitHub ActionsはUTCのため
// 従来も結果は正しかったが、ローカル実行やタイムゾーン設定の変更で壊れないようにしておく。
function toJstParts(d) {
  const jst = new Date(d.getTime() + 9 * 3600000);
  return { y: jst.getUTCFullYear(), mo: jst.getUTCMonth(), day: jst.getUTCDate(), h: jst.getUTCHours(), mi: jst.getUTCMinutes() };
}
function kawabouWaterJsonUrl(obsCd13, d) {
  const p = toJstParts(d);
  const flooredMin = p.mi - (p.mi % 5);
  const p2 = function (n) { return String(n).padStart(2, "0"); };
  const datePart = p.y + p2(p.mo + 1) + p2(p.day);
  const timePart = p2(p.h) + p2(flooredMin);
  return "https://www.river.go.jp/kawabou/file/files/tmlist/stg/" + datePart + "/" + timePart + "/" + obsCd13 + ".json";
}
// 危機管理型水位計(kind:"swstg")用。URLパスが"stg"ではなく"swstg"、コードも13桁のobsCd13ではなく
// 生のobsCd(10桁)を使う点のみ通常拠点と異なる(2026-08-22 8拠点追加分)。
function kawabouSwstgJsonUrl(obsCd, d) {
  const p = toJstParts(d);
  const flooredMin = p.mi - (p.mi % 5);
  const p2 = function (n) { return String(n).padStart(2, "0"); };
  const datePart = p.y + p2(p.mo + 1) + p2(p.day);
  const timePart = p2(p.h) + p2(flooredMin);
  return "https://www.river.go.jp/kawabou/file/files/tmlist/swstg/" + datePart + "/" + timePart + "/" + obsCd + ".json";
}
// "2026-08-19T13:25:01+09:00" 形式 → "2026-08-19 13:25:01" に整形(他拠点のmeasureTime表記に合わせる)
function fmtKawabouIsoTime(iso) {
  if (!iso) return null;
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return iso;
  return m[1] + "-" + m[2] + "-" + m[3] + " " + m[4] + ":" + m[5] + ":" + m[6];
}

// ---- 取得(サーバー実行のためCORSプロキシは不要、直接取得のみ) ----
// ---- 電源データ(発電PV[W]/バッテリ[V])の取得元: 中継サーバー mini.lhlab-vps.net ----
// 全拠点分の電源データが1日1本のCSV(約5分間隔・1行=1拠点×1チェック)で公開されているため、
// 1回のリクエストで当日分の全拠点・全時刻をまとめて取得できる。GitHub Actionsのスケジュール実行が
// 遅延しても、実行できた回に当日分の履歴をまとめて取り込めるのでグラフが疎にならない。
const POWER_CSV_BASE_URL = "https://mini.lhlab-vps.net/power/logs/";
const POWER_CSV_FIELDS = ["timestamp", "id", "name", "source", "status", "detail", "age_s",
  "pv_mv", "pv_ma", "pv_w", "bat_mv", "bat_charge_ma", "bat_discharge_ma", "bat_net_ma",
  "ld1_ma", "ld2_ma", "ld3_ma", "load_w", "gen_wh_today", "load_wh_today"];
// 中継サーバーの拠点名 → このダッシュボードの拠点ID(中継側にしか無い拠点は対象外)。
const POWER_SOURCE_NAME_TO_ID = {
  "うるおい広場": "cam01", "中郷第１樋管": "cam02", "中郷第1樋管": "cam02",
  "北沢アンダー": "cam03", "中郷第２樋管": "cam04", "中郷第2樋管": "cam04",
  "宮川橋": "cam08", "梅名樋管２号": "cam09", "梅名樋管2号": "cam09",
  "祇園大橋": "cam11", "安間樋管": "cam12", "上町樋管": "cam13", "多呂樋管": "cam14",
  "梅名樋管１号": "cam36", "梅名樋管1号": "cam36", "大場ポンプ場": "cam39",
  "藤代橋": "cam40", "こも池": "cam41", "芝橋": "cam43", "ほたるの里": "cam44",
  "竹倉用水路": "cam45", "清住緑地": "cam46", "中郷温水地": "cam47", "中郷温水池": "cam47",
  "島田浄水場": "cam48", "徳倉下水路": "cam50", "神川下水路": "cam51", "中村橋": "cam52",
  "中島樋管第１": "cam53", "中島樋管第1": "cam53", "幸原山橋": "cam55", "中島樋管３号": "cam54",
  "中島樋管3号": "cam54",
// 中継サーバーの「白滝公園」はダッシュボードのcam42(桜川（大宮町）)に対応する。
// 名称が一致しないため当初は対象外になっており、桜川だけ発電が表示されなかった。
// 実データで次の通り確認済み:
//   ・対照: 中継の「こも池」01:19JST=12.568V に対し、cam41は23:20JST=12.590V→04:20JST=12.537V(整合)
//   ・中継の「白滝公園」01:19JST=11.574V に対し、cam42は23:10JST=11.627V→04:20JST=11.508V(内挿で約11.57V)
//   ・cam42は全拠点中で最も電圧が低く、中継側でも「白滝公園」が最も低い
//   ・桜川は白滝公園を水源とする川で、cam42の座標も白滝公園の位置と一致する
//   ・これにより当方の27拠点がすべて中継側の拠点と1対1で対応する(残りは中継側のみの開発室・宗光寺)
  "白滝公園": "cam42"
};
function powerCsvUrlFor(d) {
  const p = toJstParts(d);
  const p2 = function (n) { return String(n).padStart(2, "0"); };
  return POWER_CSV_BASE_URL + "power-" + p.y + "-" + p2(p.mo + 1) + "-" + p2(p.day) + ".csv";
}
function parsePowerCsv(text) {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/).filter(function (l) { return l.trim() !== ""; });
  if (!lines.length) return [];
  const idx = {};
  let startAt = 0;
  const first = lines[0].split(",");
  if (first[0] === "timestamp") {
    first.forEach(function (c, i) { idx[c.trim()] = i; });
    startAt = 1;
  } else {
    POWER_CSV_FIELDS.forEach(function (c, i) { idx[c] = i; });
  }
  const out = [];
  for (let i = startAt; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < POWER_CSV_FIELDS.length) continue;
    const siteId = POWER_SOURCE_NAME_TO_ID[(cols[idx["name"]] || "").trim()];
    if (!siteId) continue;
    const ts = new Date((cols[idx["timestamp"]] || "").trim());
    if (!isFinite(ts.getTime())) continue;
    const pvW = parseFloat(cols[idx["pv_w"]]);
    const batMv = parseFloat(cols[idx["bat_mv"]]);
    const loadW = parseFloat(cols[idx["load_w"]]);
    const chgMa = parseFloat(cols[idx["bat_charge_ma"]]);
    const disMa = parseFloat(cols[idx["bat_discharge_ma"]]);
    const genWh = parseFloat(cols[idx["gen_wh_today"]]);
    const useWh = parseFloat(cols[idx["load_wh_today"]]);
    if (!isFinite(pvW) && !isFinite(batMv)) continue;
    out.push({
      siteId: siteId,
      fetchedAt: ts,
      pv: isFinite(pvW) ? pvW : null,
      bat: isFinite(batMv) ? batMv / 1000 : null,
      // 消費(負荷)の瞬時電力[W]。
      loadW: isFinite(loadW) ? loadW : null,
      // バッテリーの実際の充放電電流[mA]。「夜間に何Ah取り出したか」がこれで分かる。
      chgMa: isFinite(chgMa) ? chgMa : null,
      disMa: isFinite(disMa) ? disMa : null,
      // 当日ぶんの積算[Wh]。1日の収支(発電−消費)から実効容量を出すのに使う。
      genWh: isFinite(genWh) ? genWh : null,
      useWh: isFinite(useWh) ? useWh : null
    });
  }
  out.sort(function (a, b) { return a.fetchedAt - b.fetchedAt; });
  return out;
}
async function fetchPowerRelayRows() {
  const res = await fetchWithTimeout(powerCsvUrlFor(new Date()));
  const text = await res.text();
  return parsePowerCsv(text);
}

async function fetchWithTimeout(targetUrl, extraHeaders) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(targetUrl, {
      signal: controller.signal,
      headers: Object.assign({ "User-Agent": "Mozilla/5.0 (compatible; MishimaWaterDashboard/1.0)" }, extraHeaders || {})
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMatsuhisaReading(site) {
  const res = await fetchWithTimeout(site.url);
  const text = await res.text();
  if (!text || !text.trim()) throw new Error("空の応答");
  const reading = parseMatsuhisaReading(text, site);
  return Object.assign({ via: VIA_LABEL_MATSUHISA }, reading);
}

// 川の防災情報のURLは「5分区切りの時刻」を含むが、その区切りのファイルは区切り時刻ちょうどには
// まだ公開されていない(実測で約2分の遅れ)。この対策が無いと、区切り直後に実行した回は
// 11拠点すべてがHTTP 404になる(実測: 直近21回のうち11回が全滅)。
// 現在の区切りで取れなければ1つ前・2つ前の区切りを順に試す。
const KAWABOU_BUCKET_FALLBACK_MIN = [0, 5, 10];
function parseKawabouWaterJson(json, isSwstg) {
  const v = json && json.obsValue;
  if (isSwstg) {
    // 危機管理型水位計は堤防天端からの高さ(stgHght, m)を「水位」として採用する(ダッシュボード表示の主要数値と同じ)。
    if (!v || typeof v.stgHght !== "number") return null;
    return { pv: null, bat: null, measureTime: fmtKawabouIsoTime(v.obsTime || v.tmObsTime), waterLevelM: v.stgHght, via: VIA_LABEL_KAWABOU };
  }
  if (!v || typeof v.stg !== "number") return null;
  return { pv: null, bat: null, measureTime: fmtKawabouIsoTime(v.obsTime), waterLevelM: v.stg, via: VIA_LABEL_KAWABOU };
}
async function fetchKawabouWaterReading(site) {
  const isSwstg = site.kind === "swstg";
  const nowMs = Date.now();
  let firstError = null;
  for (const backMin of KAWABOU_BUCKET_FALLBACK_MIN) {
    const at = new Date(nowMs - backMin * 60000);
    const url = isSwstg ? kawabouSwstgJsonUrl(site.obsCd, at) : kawabouWaterJsonUrl(site.obsCd13, at);
    try {
      const res = await fetchWithTimeout(url, { "Accept": "application/json" });
      const reading = parseKawabouWaterJson(await res.json(), isSwstg);
      if (reading) return reading;
      if (!firstError) firstError = new Error("水位データなし");
    } catch (err) {
      if (!firstError) firstError = err;
    }
  }
  throw firstError || new Error("水位データなし");
}

function fetchReading(site) {
  return site.sourceType === "kawabou-water" ? fetchKawabouWaterReading(site) : fetchMatsuhisaReading(site);
}

// ---- 雨量計(「三島」観測所)の10分雨量 ----
// ダッシュボードは水位グラフに雨量を重ねて表示するが、その取得元(river.go.jp の /tmlist/rn/)は
// CORS非対応で、退避先にしていた r.jina.ai も 2026-09-21 に www.river.go.jp を遮断した
// (403 AbuseAlleviationError)。サーバー側には制約が無いため、ここで取得して data/rainfall.json に
// 書き出し、ダッシュボードは同一オリジンのそのファイルを読む。
const MISHIMA_RAIN_OBS_CD13 = "0563300100034";
const RAINFALL_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 保持する期間(3日)
const RAINFALL_MAX_POINTS = 500;
function rainfallJsonUrl(d) {
  const p = toJstParts(d);
  const p2 = function (n) { return String(n).padStart(2, "0"); };
  const flooredMin = Math.floor(p.mi / 10) * 10;
  const datePart = p.y + p2(p.mo + 1) + p2(p.day);
  const timePart = p2(p.h) + p2(flooredMin);
  return "https://www.river.go.jp/kawabou/file/files/tmlist/rn/" + datePart + "/" + timePart + "/" + MISHIMA_RAIN_OBS_CD13 + ".json";
}
// 観測時刻は "2026-09-21T11:50:00+09:00" のようにオフセット付きのこともあれば、
// "2026/09/21 11:50" のようにオフセット無し(=日本時間)のこともある。
// オフセットが無い文字列を new Date() に渡すと「実行環境のローカル時刻」として解釈されるため、
// UTCで動くGitHub Actions上では9時間ずれる(2026-09-21に実測)。無い場合は日本時間として解釈する。
function parseJstTime(s) {
  const str = String(s || "").trim();
  if (!str) return null;
  if (/(?:[+-]\d{2}:?\d{2}|Z)$/.test(str)) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }
  const m = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5], +(m[6] || 0)));
}
function parseRainfallJson(json) {
  const out = [];
  const push = function (v) {
    if (v && v.obsTime && typeof v.rn10m === "number") {
      const t = parseJstTime(v.obsTime);
      if (t) out.push({ obsTime: t.toISOString(), rn10m: v.rn10m });
    }
  };
  if (json && Array.isArray(json.min10Values)) json.min10Values.forEach(push);
  if (json && json.obsValue) push(json.obsValue);
  return out;
}
// 10分区切りのファイルも公開に少し遅れがあるため、現在・10分前・20分前の順に試す。
const RAINFALL_BUCKET_FALLBACK_MIN = [0, 10, 20];
async function fetchRainfallPoints() {
  const nowMs = Date.now();
  let firstError = null;
  for (const backMin of RAINFALL_BUCKET_FALLBACK_MIN) {
    try {
      const res = await fetchWithTimeout(rainfallJsonUrl(new Date(nowMs - backMin * 60000)), { "Accept": "application/json" });
      const points = parseRainfallJson(await res.json());
      if (points.length) return points;
      if (!firstError) firstError = new Error("雨量データなし");
    } catch (err) {
      if (!firstError) firstError = err;
    }
  }
  throw firstError || new Error("雨量データなし");
}
// 前回までの値と併合し、保持期間を過ぎた古い点を落として書き出す。
async function updateRainfallFile() {
  const prev = await readJsonSafe(RAINFALL_JSON_PATH, { values: [] });
  const byTime = {};
  (Array.isArray(prev.values) ? prev.values : []).forEach(function (v) {
    if (v && v.obsTime && typeof v.rn10m === "number") byTime[v.obsTime] = v;
  });
  const fetched = await fetchRainfallPoints();
  fetched.forEach(function (v) { byTime[v.obsTime] = v; });
  const cutoff = Date.now() - RAINFALL_WINDOW_MS;
  // 明らかに未来の観測時刻(時刻解釈の取り違えなど)も残さない。
  // 10分雨量の観測時刻が現在より先になることは無いため、余裕を30分だけ見る。
  const future = Date.now() + 30 * 60 * 1000;
  let values = Object.keys(byTime).map(function (k) { return byTime[k]; })
    .filter(function (v) { const t = new Date(v.obsTime).getTime(); return t >= cutoff && t <= future; })
    .sort(function (a, b) { return new Date(a.obsTime) - new Date(b.obsTime); });
  if (values.length > RAINFALL_MAX_POINTS) values = values.slice(values.length - RAINFALL_MAX_POINTS);
  await writeFile(RAINFALL_JSON_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(), obsCd13: MISHIMA_RAIN_OBS_CD13, stationName: "三島", values: values
  }, null, 2) + "\n", "utf8");
  return { total: values.length, fetched: fetched.length };
}

/* =====================================================================
 * バッテリーの持ち(無日射で何時間もつか)
 * ---------------------------------------------------------------------
 * 【以前の方式と、なぜ変えたか】
 * 以前は「夜間の電圧降下 ÷ 消費W」を全拠点の傾向線と比べていた。しかし中継サーバーの
 * 実測(2026-09-27・7夜)を見ると、祇園大橋は毎晩ほぼ同じ 5.92〜6.17Ah を取り出しているのに、
 * 電圧降下は 0.048〜0.101V と2倍以上ばらついていた。表面電荷の抜け方と開始SOCで変わるだけで、
 * バッテリーの状態をほとんど表していない。つまり天候を測っているような指標だった。
 * また「持ち」を実際に決めているのは主に消費電流で、こも池 0.073A に対し祇園大橋 1.027A と
 * 14倍の差がある。旧指標はこも池を62%(悪い側)と出していたが、実際は最も余裕がある。
 *
 * 【新しい考え方】
 * 中継サーバーのCSVには、使っていなかった次の列がある。
 *   bat_charge_ma / bat_discharge_ma … バッテリーの実際の充放電電流
 *   gen_wh_today  / load_wh_today    … 当日の発電量・消費量[Wh]
 * これを使って、次の2つを実測する。
 *
 *  (1) 実効容量[Ah]
 *      1日の収支(発電−消費)[Wh]だけバッテリーに出入りすると、翌日の「0:00基準電圧」が
 *      どれだけ動くか。その比が容量である。
 *        翌日の0時電圧 − 当日の0時電圧 = α + β × その日の収支[Wh]
 *        容量[Wh/V] = 1/β       容量[Ah] = 容量[Wh/V] ÷ 平均電圧 × (満充電V − 空V)
 *      前日との差分で見るので、積算値の系統的なズレはαに吸収される。
 *      0:00は日没から5時間ほど経ち充電の下駄が抜けているため、素の電圧として使える
 *      (中継サーバー自身も「0:00基準の電圧が下がる→劣化のサイン」と説明している)。
 *      28日ぶんで相関 r=0.85〜0.96、容量は標準的な拠点で38〜52Ah、小型拠点で14〜24Ahと
 *      物理的に筋の通る値に収束することを確認済み(2026-09-27)。
 *
 *  (2) 夜間の平均消費電流[A]
 *      日射ゼロ(pv_w<0.5)の時間帯に bat_discharge_ma − bat_charge_ma を積分して時間で割る。
 *      瞬時Wと違い、カメラのON/OFFをならした実効値になる。
 *
 * 【表示する指標】
 *      持ち[h] = 実効容量[Ah] × (現在のSOC% − 下限SOC%) ÷ 100 ÷ 夜間平均電流[A]
 *      = 「日射ゼロが続いたとき、下限(既定20%)まで何時間もつか」。
 *      容量と消費の両方が1つの数字に入り、そのまま運用判断に使える。
 *
 * 【対象外】
 *      常時電源の拠点(0時電圧が常に13.2Vを超える。大場ポンプ場・島田浄水場・
 *      徳倉下水路・神川下水路)はバッテリー運用をしていないので「常時電源」と表示する。
 *      回帰の相関が低い拠点(r<0.6)は日数が足りないだけなので「測定中」と表示する。
 * ===================================================================== */
const POWER_DAILY_JSON_PATH = path.join(DATA_DIR, "power_daily.json");
const POWER_DAILY_KEEP_DAYS = 45;        // 日次集計を残す日数
const POWER_DAILY_BACKFILL_PER_RUN = 6;  // 1回の実行で遡って取りに行く日数(負荷を分散する)
const BATTERY_NIGHT_END_H = 4;           // 夜間帯の終わり(JST)。0:00〜4:00を使う
const BATTERY_V0_WINDOW_MIN = 40;        // 「0時基準電圧」を平均する幅(分)
const BATTERY_MIN_DAYS = 10;             // 容量の回帰に必要な日数
const BATTERY_MIN_R = 0.6;               // これ未満は「測定中」扱い
const BATTERY_MAINS_V = 13.2;            // 0時電圧がこれを超え続ける拠点は常時電源
const BATTERY_MAINS_RATIO = 0.8;
const BATTERY_RESERVE_SOC = 20;          // ここまでを「使える量」とする(鉛蓄電池の推奨下限)
const BATTERY_MIN_NIGHT_A = 0.01;        // これ未満の電流では持ち時間を出さない
const BATTERY_CAP_RANGE_AH = [3, 200];   // 現実的な容量の範囲。外れたら測定中扱い
const BATTERY_HEALTH_REFRESH_MS = 60 * 60 * 1000;   // 再計算の間隔(1時間)
// ---- 長期日次(中継サーバーのAPI)と気温 ----
// 5分CSVは中継サーバー側で約30日で消えるが、/api/power/daily?id=N は観測開始
// (2026-06-13)からの日次集計を返す。列は date / bat_ref_v(0時の基準電圧) /
// bat_min_v / bat_max_v / gen_wh / load_wh / charge_wh / pv_peak_w / partial。
// bat_ref_v と (gen_wh − load_wh) が当方のv0・balWhと一致することは実データで確認済み
// (祇園大橋・北沢アンダー・安間樋管ほかで小数2桁まで一致)。これで容量の回帰に使える
// 日数が45日→109日に増え、「観測開始ごろ」と「直近」を比べられるようになる。
const POWER_LONGTERM_JSON_PATH = path.join(DATA_DIR, "power_longterm.json");
const POWER_LONGTERM_API_BASE = "https://mini.lhlab-vps.net/api/power/daily?id=";
const POWER_LONGTERM_MAX_ID = 30;                   // 中継側の拠点番号は1..28。余裕を見て30まで
const POWER_LONGTERM_REFRESH_MS = 12 * 60 * 60 * 1000;   // 1日2回でよい(1回で28リクエスト)
const TEMP_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const TEMP_POINT = { lat: 35.12, lon: 138.92 };     // 三島市中心部。全拠点が半径10km以内
const BATTERY_TEMP_COEF = 0.006;    // 鉛蓄電池の容量の温度係数(1℃あたり+0.6%)
const BATTERY_TEMP_REF_C = 25;      // 定格の基準温度
const BATTERY_WINDOW_DAYS = 35;     // 容量を1回測るのに使う日数
const BATTERY_DEGRADE_MIN_SPAN = 70;// これだけ日数がないと「初期」と「直近」を比べない
const BATTERY_VMIN_KEEP_DAYS = 60;  // 画面側で深放電日を数えるために渡す最低電圧の日数
const BATTERY_NIGHT_WINDOW = 15;    // へたり具合(mV/Ah)を比べる夜数
// 鉛蓄電池(12V)の休止時開回路電圧 → 残量(SOC)。0:00は充電の下駄が抜けているのでこの表が使える。
const BATTERY_OCV_TABLE = [
  [11.36, 0], [11.51, 10], [11.66, 20], [11.81, 30], [11.96, 40], [12.10, 50],
  [12.24, 60], [12.37, 70], [12.50, 80], [12.62, 90], [12.70, 100]
];
const BATTERY_OCV_SPAN_V = BATTERY_OCV_TABLE[BATTERY_OCV_TABLE.length - 1][0] - BATTERY_OCV_TABLE[0][0];

function socFromRestingVoltage(v) {
  if (!isFinite(v)) return null;
  const t = BATTERY_OCV_TABLE;
  if (v <= t[0][0]) return 0;
  if (v >= t[t.length - 1][0]) return 100;
  for (let i = 1; i < t.length; i++) {
    if (v <= t[i][0]) {
      const lo = t[i - 1], hi = t[i];
      return lo[1] + (v - lo[0]) / (hi[0] - lo[0]) * (hi[1] - lo[1]);
    }
  }
  return 100;
}
function medianOf(list) {
  if (!list.length) return null;
  const s = list.slice().sort(function (a, b) { return a - b; });
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
// 最小二乗で y = a + b x。相関係数(r)と点数も返す。
function fitLine(points) {
  const pts = points.filter(function (p) { return isFinite(p.x) && isFinite(p.y); });
  if (pts.length < 3) return null;
  const n = pts.length;
  const mx = pts.reduce(function (a, p) { return a + p.x; }, 0) / n;
  const my = pts.reduce(function (a, p) { return a + p.y; }, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  pts.forEach(function (p) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) * (p.x - mx); syy += (p.y - my) * (p.y - my); });
  if (!sxx || !syy) return null;
  const b = sxy / sxx;
  return {
    a: Math.round((my - b * mx) * 100000) / 100000,
    b: Math.round(b * 1000000) / 1000000,
    r: Math.round((sxy / Math.sqrt(sxx * syy)) * 1000) / 1000,
    sites: n
  };
}

/* その日のうちのバッテリー載せ替えを、5分ごとの電圧から見つける(画面側と同じ判定)。
 * 実データ(9/28〜9/29)の交換はどれも「発電が増えていないのに、1回の計測の間に電圧が
 * 0.5〜1V跳ね上がる」形で残っていた(北沢 9/29 15:58→16:03 11.34→12.30V、梅名樋管2号
 * 16:19〜17:03 は作業中0V→12.48V、清住緑地 9/28 15:41→15:44 11.90→12.71V など)。
 * 発電が増えずに電圧だけ上がるのは載せ替え以外に起こらない。0V付近は作業中の欠測として飛ばし、
 * 20分を超えて間が空いた2点は、途中が0Vでつながっている場合だけ比べる。 */
const SWAP_STEP_V = 0.35;
const SWAP_MAX_PV_RISE_W = 1;
const SWAP_NORMAL_GAP_MS = 20 * 60 * 1000;
const SWAP_WORK_GAP_MS = 3 * 60 * 60 * 1000;
const SWAP_MIN_VALID_V = 5;
function findIntradaySwap(rows) {
  let found = null, prev = null, sawDropout = false;
  rows.forEach(function (p) {
    if (typeof p.bat !== "number") return;
    if (p.bat < SWAP_MIN_VALID_V) { if (prev) sawDropout = true; return; }
    if (prev) {
      const gap = p.fetchedAt - prev.fetchedAt;
      const gapOk = gap <= SWAP_NORMAL_GAP_MS || (sawDropout && gap <= SWAP_WORK_GAP_MS);
      const pvA = typeof prev.pv === "number" ? prev.pv : 0;
      const pvB = typeof p.pv === "number" ? p.pv : 0;
      if (gapOk && p.bat - prev.bat >= SWAP_STEP_V && pvB - pvA <= SWAP_MAX_PV_RISE_W) {
        found = { at: p.fetchedAt.toISOString(), vBefore: prev.bat, vAfter: p.bat };
      }
    }
    prev = p; sawDropout = false;
  });
  return found;
}

// 中継サーバーの1日ぶんのCSV行から、拠点ごとの日次集計を作る。
//   v0     … 0:00〜0:40 JST の平均電圧(充電の下駄が抜けた素の電圧)
//   balWh  … その日の収支(発電Wh − 消費Wh)。積算の最終値どうしの差
//   nightA … 0:00〜4:00 JST の平均放電電流[A]
//   vmin   … その日の最低電圧
function summarizePowerDay(rows) {
  const bySite = {};
  rows.forEach(function (r) {
    if (!r.siteId) return;
    (bySite[r.siteId] = bySite[r.siteId] || []).push(r);
  });
  const out = {};
  Object.keys(bySite).forEach(function (id) {
    const seg = bySite[id].slice().sort(function (a, b) { return a.fetchedAt - b.fetchedAt; });
    const v0s = [], nights = [];
    let vmin = null;
    seg.forEach(function (r) {
      const p = toJstParts(r.fetchedAt);
      if (typeof r.bat === "number") {
        if (vmin === null || r.bat < vmin) vmin = r.bat;
        if (p.h === 0 && p.mi < BATTERY_V0_WINDOW_MIN) v0s.push(r.bat);
      }
      if (p.h < BATTERY_NIGHT_END_H && typeof r.pv === "number" && r.pv < 0.5
        && typeof r.chgMa === "number" && typeof r.disMa === "number") {
        nights.push(r);
      }
    });
    // 夜間に取り出した電気量[Ah]を、実際の放電電流を時間で積分して出す
    let ah = 0, hours = 0;
    for (let i = 1; i < nights.length; i++) {
      const dt = (nights[i].fetchedAt - nights[i - 1].fetchedAt) / 3600000;
      if (!(dt > 0) || dt > 0.5) continue;
      const a1 = (nights[i].disMa - nights[i].chgMa) / 1000;
      const a0 = (nights[i - 1].disMa - nights[i - 1].chgMa) / 1000;
      ah += (a1 + a0) / 2 * dt;
      hours += dt;
    }
    // 夜間の電圧降下の速さ[V/h]。最小二乗の傾きで出す(端点2点の引き算だとノイズが乗るため)。
    // 「充電されない夜間に実際どれだけ電圧が落ちるか」で、持ち時間の見通しを実測に合わせるのに使う。
    let vPerH = null;
    const vs = nights.filter(function (r) { return typeof r.bat === "number"; });
    if (vs.length >= 10) {
      const n2 = vs.length;
      const mx = vs.reduce(function (a, r) { return a + r.fetchedAt.getTime(); }, 0) / n2;
      const my = vs.reduce(function (a, r) { return a + r.bat; }, 0) / n2;
      let num = 0, den = 0;
      vs.forEach(function (r) {
        const dx = r.fetchedAt.getTime() - mx;
        num += dx * (r.bat - my); den += dx * dx;
      });
      if (den > 0) vPerH = -(num / den) * 3600000;   // 下がっていればプラス
    }
    const last = seg[seg.length - 1];
    const bal = (last && typeof last.genWh === "number" && typeof last.useWh === "number")
      ? last.genWh - last.useWh : null;
    const r3 = function (x) { return Math.round(x * 1000) / 1000; };
    const swap = findIntradaySwap(seg);
    out[id] = {
      // その日のうちにバッテリーを載せ替えた時刻(5分データの電圧の跳ねから)。無ければ付けない。
      swapChecked: true,
      swapAt: swap ? swap.at : undefined,
      swapVBefore: swap ? r3(swap.vBefore) : undefined,
      swapVAfter: swap ? r3(swap.vAfter) : undefined,
      v0: v0s.length ? r3(v0s.reduce(function (a, b) { return a + b; }, 0) / v0s.length) : null,
      balWh: bal === null ? null : Math.round(bal * 10) / 10,
      nightA: hours > 2 ? r3(ah / hours) : null,
      // 夜間の電圧降下[V/h]。小さい値なので桁を多めに残す。
      nightVPerH: (hours > 2 && vPerH !== null) ? Math.round(vPerH * 100000) / 100000 : null,
      vmin: vmin === null ? null : r3(vmin)
    };
  });
  return out;
}
// data/power_daily.json を更新する。当日ぶんは毎回上書きし、足りない過去日は少しずつ取りに行く。
async function updatePowerDailyFile(todayRows) {
  const store = await readJsonSafe(POWER_DAILY_JSON_PATH, null) || { generatedAt: null, days: {} };
  if (!store.days) store.days = {};
  const nowMs = Date.now();
  const p2 = function (n) { return String(n).padStart(2, "0"); };
  const keyFor = function (d) { const p = toJstParts(d); return p.y + "-" + p2(p.mo + 1) + "-" + p2(p.day); };
  const todayKey = keyFor(new Date(nowMs));
  if (todayRows && todayRows.length) store.days[todayKey] = summarizePowerDay(todayRows);

  // 過去日の穴埋め(1回の実行で数日ぶんだけ)。昨日より前で、まだ無い日を古い順に埋めていく。
  // 集計項目を増やしたときは、古い形式の日も取り直す(needsRefill)。
  const needsRefill = function (day) {
    if (!day) return true;
    const ids = Object.keys(day);
    if (!ids.length) return false;                       // データ自体が無い日は空のまま
    // nightVPerH(夜間の電圧降下)・swapChecked(当日の載せ替え検出)を持たない古い形式の日は取り直す
    return ids.every(function (id) { return day[id].nightVPerH === undefined || day[id].swapChecked !== true; });
  };
  let filled = 0;
  for (let back = 1; back <= POWER_DAILY_KEEP_DAYS && filled < POWER_DAILY_BACKFILL_PER_RUN; back++) {
    const d = new Date(nowMs - back * 24 * 3600000);
    const k = keyFor(d);
    if (!needsRefill(store.days[k])) continue;
    try {
      const res = await fetchWithTimeout(powerCsvUrlFor(d));
      const text = await res.text();
      const rows = parsePowerCsv(text);
      if (rows.length) { store.days[k] = summarizePowerDay(rows); filled++; }
      else store.days[k] = {};   // その日はデータ自体が無い。空で埋めて再取得しない
    } catch (err) {
      break;   // 取れないときは次の実行に回す
    }
  }
  // 古い日を落とす
  const cutoff = keyFor(new Date(nowMs - POWER_DAILY_KEEP_DAYS * 24 * 3600000));
  Object.keys(store.days).forEach(function (k) { if (k < cutoff) delete store.days[k]; });
  store.generatedAt = new Date(nowMs).toISOString();
  await writeFile(POWER_DAILY_JSON_PATH, JSON.stringify(store, null, 2) + "\n", "utf8");
  return { days: Object.keys(store.days).length, filled: filled };
}

// 中継サーバーの長期日次API(観測開始からの全日)を拠点IDごとにまとめる。
// 中継側の拠点番号とダッシュボードの拠点IDは対応表が無いので、APIが返す name で突き合わせる。
async function fetchLongTermDaily() {
  const days = {};
  let hit = 0, missed = [];
  const num = function (x) { return typeof x === "number" && isFinite(x) ? x : null; };
  for (let id = 1; id <= POWER_LONGTERM_MAX_ID; id++) {
    let j = null;
    try {
      const res = await fetchWithTimeout(POWER_LONGTERM_API_BASE + id);
      if (!res.ok) continue;
      j = await res.json();
    } catch (err) { continue; }
    if (!j || !Array.isArray(j.rows) || !j.rows.length) continue;
    const siteId = POWER_SOURCE_NAME_TO_ID[String(j.name || "").trim()];
    if (!siteId) { missed.push(String(j.name || id)); continue; }
    hit++;
    j.rows.forEach(function (r) {
      // partial は当日ぶんの途中集計。収支が丸1日ぶんにならないので容量の回帰には使えない。
      if (!r || !r.date || r.partial) return;
      const gen = num(r.gen_wh), use = num(r.load_wh);
      const e = {
        v0: num(r.bat_ref_v),
        balWh: (gen === null || use === null) ? null : Math.round((gen - use) * 10) / 10,
        vmin: num(r.bat_min_v),
        vmax: num(r.bat_max_v),
        genWh: gen,
        loadWh: use,
        pvPeakW: num(r.pv_peak_w)
      };
      if (e.v0 === null && e.balWh === null && e.vmin === null) return;
      (days[r.date] = days[r.date] || {})[siteId] = e;
    });
  }
  return { days: days, sites: hit, unmatched: missed };
}
// 三島の日平均気温(過去分)。鉛蓄電池の容量は暖かいほど大きく出るので、
// 「初期」と「直近」を比べるときに25℃相当へ揃えるために使う。
async function fetchDailyMeanTemps(fromKey, toKey) {
  const url = TEMP_ARCHIVE_URL + "?latitude=" + TEMP_POINT.lat + "&longitude=" + TEMP_POINT.lon
    + "&start_date=" + fromKey + "&end_date=" + toKey
    + "&daily=temperature_2m_mean&timezone=Asia%2FTokyo";
  const res = await fetchWithTimeout(url);
  const j = await res.json();
  const out = {};
  if (j && j.daily && Array.isArray(j.daily.time)) {
    j.daily.time.forEach(function (d, i) {
      const v = j.daily.temperature_2m_mean[i];
      if (typeof v === "number" && isFinite(v)) out[d] = Math.round(v * 10) / 10;
    });
  }
  return out;
}
// data/power_longterm.json を更新する。長期APIは重い(28リクエスト)ので1日2回だけ。
async function updatePowerLongTermFile() {
  const prev = await readJsonSafe(POWER_LONGTERM_JSON_PATH, null);
  const nowMs = Date.now();
  if (prev && prev.generatedAt && nowMs - Date.parse(prev.generatedAt) < POWER_LONGTERM_REFRESH_MS) {
    return { skipped: true, days: Object.keys(prev.days || {}).length };
  }
  const got = await fetchLongTermDaily();
  const keys = Object.keys(got.days).sort();
  if (!keys.length) return { skipped: false, days: 0, sites: 0, reason: "長期APIから取得できませんでした" };
  const p2 = function (n) { return String(n).padStart(2, "0"); };
  const jp = toJstParts(new Date(nowMs));
  const todayKey = jp.y + "-" + p2(jp.mo + 1) + "-" + p2(jp.day);
  const tempC = (prev && prev.tempC) || {};
  try {
    // 気温は前日ぶんまでが確定。まだ持っていない日だけ取りに行く。
    const need = keys.filter(function (k) { return tempC[k] === undefined && k < todayKey; });
    if (need.length) {
      const fresh = await fetchDailyMeanTemps(need[0], need[need.length - 1]);
      Object.keys(fresh).forEach(function (k) { tempC[k] = fresh[k]; });
    }
  } catch (err) { /* 気温が取れなくても容量計算は続ける(温度補正なしになるだけ) */ }
  await writeFile(POWER_LONGTERM_JSON_PATH, JSON.stringify({
    generatedAt: new Date(nowMs).toISOString(),
    source: "relay-daily-api",
    sites: got.sites,
    from: keys[0], to: keys[keys.length - 1],
    tempC: tempC,
    days: got.days
  }, null, 2) + "\n", "utf8");
  return { skipped: false, days: keys.length, sites: got.sites, unmatched: got.unmatched };
}

// 長期日次(109日)と5分CSV由来の日次(45日)を1本の系列にまとめる。
// v0・balWh・vmin は両者で一致するため、夜間の実測(nightA/nightVPerH)を持つCSV側を上に重ねる。
// 値がnullの項目では上書きしない(CSVが欠けている日でも長期側の値を残す)。
function mergeDailyStores(store, longTerm) {
  const days = {};
  const put = function (src) {
    Object.keys(src || {}).forEach(function (k) {
      const day = src[k] || {};
      const dst = days[k] = days[k] || {};
      Object.keys(day).forEach(function (id) {
        const cur = dst[id] = dst[id] || {};
        const add = day[id] || {};
        Object.keys(add).forEach(function (f) {
          if (add[f] !== null && add[f] !== undefined) cur[f] = add[f];
        });
      });
    });
  };
  put(longTerm && longTerm.days);
  put(store && store.days);
  return days;
}

// 日次の並び(連続した日付)から実効容量[Ah]を出す。
//   「翌日の0時電圧 − 当日の0時電圧」 = α + β × 「当日の収支[Wh]」
// の回帰で 1/β = 「1Vあたり何Wh入るか」が求まる。これを0%→100%の電圧幅(1.34V)に換算する。
// 毎日の待機消費のような系統的な偏りはαが吸収するので、差分で取るのが要点。
function capacityFromSeries(series, tempC) {
  const pts = [], temps = [];
  for (let i = 0; i < series.length - 1; i++) {
    const a = series[i], b = series[i + 1];
    if ((Date.parse(b.day) - Date.parse(a.day)) !== 86400000) continue;   // 日が飛んだらまたがせない
    if (typeof a.d.v0 !== "number" || typeof b.d.v0 !== "number" || typeof a.d.balWh !== "number") continue;
    pts.push({ x: a.d.balWh, y: b.d.v0 - a.d.v0 });
    const t = tempC ? tempC[a.day] : null;
    if (typeof t === "number") temps.push(t);
  }
  if (pts.length < BATTERY_MIN_DAYS) return null;
  const fit = fitLine(pts);
  if (!fit || !(fit.b > 1e-6)) return null;
  const vs = series.map(function (p) { return p.d.v0; })
    .filter(function (v) { return typeof v === "number"; });
  if (!vs.length) return null;
  const vAvg = vs.reduce(function (a, b) { return a + b; }, 0) / vs.length;
  const capAh = (1 / fit.b) / vAvg * BATTERY_OCV_SPAN_V;
  const tMean = temps.length ? temps.reduce(function (a, b) { return a + b; }, 0) / temps.length : null;
  // 25℃相当に揃えた値。初期と直近を比べるときはこちらを使う。
  const cap25 = tMean === null ? capAh : capAh / (1 + BATTERY_TEMP_COEF * (tMean - BATTERY_TEMP_REF_C));
  return {
    capAh: capAh, cap25Ah: cap25, r: fit.r, pairs: pts.length,
    tempC: tMean === null ? null : Math.round(tMean * 10) / 10,
    from: series[0].day, to: series[series.length - 1].day
  };
}

/* バッテリー交換の検出
 * -----------------------------------------------------------------------
 * 現場では「もちそうにない拠点のバッテリーを載せ替える」運用をしているため、
 * 交換をまたいで容量を測ると、劣化率も持ち時間もでたらめになる。
 * 交換日は記録が残っていないので、データから見つける。
 *   交換の痕跡 = 「その日の収支では説明できないほど0時電圧が跳ね上がり、
 *                 しかもその水準が翌日以降も続く」日
 * 収支で説明できる分は回帰(α + β×収支)で差し引き、残差だけを見る。しきい値は
 * その拠点の残差のばらつき(MAD)の5倍か0.35Vの大きいほう。晴天の充電で戻った日を
 * 拾わないよう、収支が+20Wh以下の日に限る。
 *
 * 【載せ替えた電池が新品とは限らない】
 * 臨時の予備電池を入れている拠点もあり、交換後のほうが弱いことがある。そのため
 * 「満充電近くまで戻ったか」では判定せず、段差が続くかどうかで見る(天気による
 * 一日限りの跳ねは翌日に戻るが、載せ替えなら電圧の水準そのものが変わる)。
 * 同じ理由で、交換を「回復」とは扱わない。容量はその日以降で測り直すだけで、
 * 結果が前より小さくなることもある。
 * 判定はあくまで「交換の可能性」として画面に日付を出し、断定はしない。 */
const BATTERY_SWAP_MIN_JUMP_V = 0.35;   // これ未満の跳ねは交換とみなさない
const BATTERY_SWAP_MAD_K = 5;           // 残差のばらつきの何倍を異常とするか
const BATTERY_SWAP_MAX_BAL_WH = 20;     // この収支を超える日は充電で説明できるので除く
const BATTERY_SWAP_LEVEL_V = 0.20;      // 段差が続いたと認める電圧差
const BATTERY_SWAP_LEVEL_DAYS = 5;      // 段差の前後を平均する日数
// 段差が「続いた」と言うには、その日以降に最低これだけの日数が要る。
// 直近1〜2日の跳ねは続くかどうかまだ分からないので、確定するまで交換とみなさない
// (運用初日に、当日の跳ねを交換と誤判定した拠点が2つ出たための対策)。
const BATTERY_SWAP_CONFIRM_DAYS = 3;
const BATTERY_SWAP_MERGE_DAYS = 2;      // 連続した検出は1回の交換にまとめる
function detectBatterySwaps(series) {
  const pairs = [];
  for (let i = 0; i < series.length - 1; i++) {
    const a = series[i], b = series[i + 1];
    if ((Date.parse(b.day) - Date.parse(a.day)) !== 86400000) continue;
    if (typeof a.d.v0 !== "number" || typeof b.d.v0 !== "number" || typeof a.d.balWh !== "number") continue;
    pairs.push({ day: b.day, at: i + 1, x: a.d.balWh, y: b.d.v0 - a.d.v0, v: b.d.v0 });
  }
  if (pairs.length < BATTERY_MIN_DAYS) return [];
  const fit = fitLine(pairs);
  if (!fit) return [];
  const res = pairs.map(function (p) { return p.y - (fit.a + fit.b * p.x); });
  const mad = medianOf(res.map(Math.abs)) || 0;
  const thr = Math.max(BATTERY_SWAP_MIN_JUMP_V, BATTERY_SWAP_MAD_K * mad);
  // 前後それぞれ数日の平均をとって、跳ねが「その日だけ」か「水準の変化」かを見分ける
  const v0sIn = function (from, to) {
    const v = [];
    for (let i = Math.max(0, from); i < Math.min(series.length, to); i++) {
      if (typeof series[i].d.v0 === "number") v.push(series[i].d.v0);
    }
    return v;
  };
  const mean = function (v) { return v.reduce(function (a, b) { return a + b; }, 0) / v.length; };
  const hits = [];
  pairs.forEach(function (p, i) {
    if (!(res[i] > thr) || p.x > BATTERY_SWAP_MAX_BAL_WH) return;
    const after = v0sIn(p.at, p.at + BATTERY_SWAP_LEVEL_DAYS);
    const before = v0sIn(p.at - BATTERY_SWAP_LEVEL_DAYS, p.at);
    if (after.length < BATTERY_SWAP_CONFIRM_DAYS || !before.length) return;   // まだ続くか分からない
    if (mean(after) - mean(before) >= BATTERY_SWAP_LEVEL_V) hits.push(p.day);
  });
  const events = [];
  hits.forEach(function (d) {
    const last = events[events.length - 1];
    if (last && (Date.parse(d) - Date.parse(last)) <= BATTERY_SWAP_MERGE_DAYS * 86400000) return;
    events.push(d);
  });
  return events;
}
/* 定格容量(50Ah / 20Ah)の推定
 * -----------------------------------------------------------------------
 * 拠点ごとの定格の一覧は無いので、その拠点で測れた容量のうち最大のもの
 * (＝いちばん元気だったときの値)を手がかりに、50Ahか20Ahの近いほうへ寄せる。
 * 比で見たいので対数距離で判定する(35Ahなら50、27Ahなら20)。 */
const BATTERY_RATED_CANDIDATES = [20, 50];
function snapRatedAh(bestAh) {
  if (!(bestAh > 0)) return null;
  let best = null, bestD = Infinity;
  BATTERY_RATED_CANDIDATES.forEach(function (c) {
    const d = Math.abs(Math.log(bestAh / c));
    if (d < bestD) { bestD = d; best = c; }
  });
  return best;
}
// 35日窓を10日ずつずらして、その拠点で測れた容量の最大値を探す。
function bestCapacityAh(series, tempC) {
  let best = null;
  for (let s = 0; s + BATTERY_MIN_DAYS < series.length; s += 10) {
    const seg = series.slice(s, s + BATTERY_WINDOW_DAYS);
    const c = capacityFromSeries(seg, tempC);
    if (!c || c.r < BATTERY_MIN_R) continue;
    if (c.cap25Ah < BATTERY_CAP_RANGE_AH[0] || c.cap25Ah > BATTERY_CAP_RANGE_AH[1]) continue;
    if (best === null || c.cap25Ah > best) best = c.cap25Ah;
  }
  return best;
}

// 日次集計から、拠点ごとの実効容量と「無日射で何時間もつか」を出す。
function computeBatteryEndurance(store, longTerm) {
  const dayMap = mergeDailyStores(store, longTerm);
  const tempC = (longTerm && longTerm.tempC) || {};
  const days = Object.keys(dayMap).sort();
  const ids = {};
  days.forEach(function (k) { Object.keys(dayMap[k] || {}).forEach(function (id) { ids[id] = 1; }); });
  const sites = {};
  Object.keys(ids).forEach(function (id) {
    const series = days.map(function (k) { return { day: k, d: (dayMap[k] || {})[id] || null }; })
      .filter(function (p) { return p.d; });
    const v0s = series.map(function (p) { return p.d.v0; }).filter(function (v) { return typeof v === "number"; });
    if (!v0s.length) return;
    // 常時電源(0時でも13.2Vを超え続ける)はバッテリー運用をしていない
    const mainsRatio = v0s.filter(function (v) { return v > BATTERY_MAINS_V; }).length / v0s.length;
    const nightAs = series.map(function (p) { return p.d.nightA; })
      .filter(function (a) { return typeof a === "number" && a > 0; });
    const nightA = medianOf(nightAs);
    const lastWithV0 = series.filter(function (p) { return typeof p.d.v0 === "number"; }).pop();
    const v0Now = lastWithV0 ? lastWithV0.d.v0 : null;
    const entry = {
      days: series.length,
      mains: mainsRatio > BATTERY_MAINS_RATIO,
      v0: v0Now,
      socPct: v0Now === null ? null : Math.round(socFromRestingVoltage(v0Now)),
      nightA: nightA === null ? null : Math.round(nightA * 1000) / 1000,
      vmin: medianOf(series.map(function (p) { return p.d.vmin; })
        .filter(function (v) { return typeof v === "number"; })),
      capacityAh: null, fitR: null, whPerV: null, enduranceH: null, usableAh: null,
      // 劣化の目安。観測開始ごろと直近で、同じ方法で測った容量を25℃相当に揃えて比べる。
      capacityInitialAh: null, capacityNowAh: null, degradePct: null,
      capWindow: null, initialWindow: null, spanDays: series.length,
      pvPeakNowW: null, pvPeakInitialW: null,
      loadWhPerDay: null, genWhPerDay: null,
      vminFrom: null, vminDays: null,
      // バッテリー交換(現場で載せ替えている)の検出と、定格容量に対する比
      swaps: [], lastSwapAt: null, lastSwapTime: null, lastSwapVBefore: null, lastSwapVAfter: null,
      capAfterSwap: false, capStale: false, capDaysAfterSwap: null,
      mvSpansSwap: false,
      ratedAh: null, sohPct: null,
      // 「1Ah取り出すと何V下がるか」= 夜間の実測だけで出る、季節に左右されないへたり具合
      mvPerAhNow: null, mvPerAhPrev: null, nightNights: null, nightGenMaxWh: null
    };
    if (entry.vmin !== null) entry.vmin = Math.round(entry.vmin * 1000) / 1000;

    // 現場でのバッテリー交換をまたぐと容量がでたらめになるので、交換以降だけで測る。
    // 交換日は2通りで見つける。
    //  ・5分データの電圧の跳ね(当日中に時刻まで分かる。確認を待たずにすぐ確定)
    //  ・日次の0時電圧の段差(5分データが残っていない古い日のため。続くのを3日確かめてから確定)
    // 前者で見つけた交換の前後2日にある後者は、同じ交換の二重検出なので捨てる。
    const DAY = 86400000;
    const keyOfMs = function (ms) {
      const d = new Date(ms);
      return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-"
        + String(d.getUTCDate()).padStart(2, "0");
    };
    // 当日中の交換は「翌日」から新しい電池の日として数える(その日の0時電圧は交換前の電池のもの)
    const intraday = series.filter(function (p) { return typeof p.d.swapAt === "string"; })
      .map(function (p) { return { day: keyOfMs(Date.parse(p.day) + DAY), at: p.d.swapAt,
        vBefore: p.d.swapVBefore, vAfter: p.d.swapVAfter }; });
    const daily = detectBatterySwaps(series).filter(function (d) {
      return !intraday.some(function (x) { return Math.abs(Date.parse(x.day) - Date.parse(d)) <= 2 * DAY; });
    }).map(function (d) { return { day: d, at: null }; });
    const events = intraday.concat(daily).sort(function (a, b) { return a.day < b.day ? -1 : 1; });
    const swaps = events.map(function (x) { return x.day; });
    entry.swaps = swaps;
    entry.lastSwapAt = swaps.length ? swaps[swaps.length - 1] : null;
    const lastEv = events.length ? events[events.length - 1] : null;
    entry.lastSwapTime = lastEv && lastEv.at ? lastEv.at : null;          // 時刻まで分かっている場合
    entry.lastSwapVBefore = lastEv && lastEv.at ? lastEv.vBefore : null;
    entry.lastSwapVAfter = lastEv && lastEv.at ? lastEv.vAfter : null;
    const afterSwap = entry.lastSwapAt
      ? series.filter(function (p) { return p.day >= entry.lastSwapAt; }) : series;
    entry.capDaysAfterSwap = entry.lastSwapAt ? afterSwap.length : null;

    // 容量は「交換以降の直近35日」で測る。3.5ヶ月で2〜3割落ちている拠点があり、
    // 全期間で均すと持ち時間を実態より長く見積もってしまうため、必ず直近の値を使う。
    // 交換後の電池が前より弱いこともあるため、交換後の日数が足りないうちは
    // 交換前の値で代用していることを画面に伝える(capStale)。
    const afterCap = capacityFromSeries(afterSwap.slice(-BATTERY_WINDOW_DAYS), tempC);
    // 仮置きの容量は「交換より前」の日だけで測る。交換をまたぐと、交換日の電圧の跳ね(+1V前後)が
    // 回帰を壊して当てはまりが0.6を切り、容量が出せなくなる。実際に9/30 0時の電圧(交換後)が
    // 届いた時点で、前日に交換した4拠点(北沢・梅名2号・中村橋・中郷第１)が持ち比較から消えた。
    const beforeSwap = entry.lastSwapAt
      ? series.filter(function (p) { return p.day < entry.lastSwapAt; }) : series;
    const recent = afterCap || capacityFromSeries(beforeSwap.slice(-BATTERY_WINDOW_DAYS), tempC);
    const whole = recent ? null : capacityFromSeries(beforeSwap, tempC);
    const cap = recent || whole;
    entry.capAfterSwap = !!afterCap;
    entry.capStale = !!(entry.lastSwapAt && !afterCap);
    if (cap && !entry.mains) {
      const capAh = cap.capAh;
      entry.fitR = Math.round(cap.r * 1000) / 1000;
      entry.whPerV = Math.round(capAh * (v0s.reduce(function (a, b) { return a + b; }, 0) / v0s.length) / BATTERY_OCV_SPAN_V);
      entry.capWindow = { from: cap.from, to: cap.to, days: cap.pairs, tempC: cap.tempC, whole: !recent };
      if (cap.r >= BATTERY_MIN_R && capAh >= BATTERY_CAP_RANGE_AH[0] && capAh <= BATTERY_CAP_RANGE_AH[1]) {
        entry.capacityAh = Math.round(capAh * 10) / 10;
        entry.capacityNowAh = Math.round(cap.cap25Ah * 10) / 10;
        if (entry.socPct !== null) {
          const usable = capAh * Math.max(0, entry.socPct - BATTERY_RESERVE_SOC) / 100;
          entry.usableAh = Math.round(usable * 100) / 100;
          if (nightA !== null && nightA >= BATTERY_MIN_NIGHT_A) {
            entry.enduranceH = Math.round(usable / nightA * 10) / 10;
          }
        }
        // 定格容量(50Ah / 20Ah)は一覧が無いので、その拠点で測れた最大の容量から推定する。
        const best = bestCapacityAh(series, tempC);
        entry.ratedAh = snapRatedAh(best === null ? cap.cap25Ah : Math.max(best, cap.cap25Ah));
        if (entry.ratedAh) entry.sohPct = Math.round(cap.cap25Ah / entry.ratedAh * 100);
        // 観測開始ごろの35日との比較。交換していない拠点だけ(交換をまたぐと比較にならない)。
        if (series.length >= BATTERY_DEGRADE_MIN_SPAN && !entry.lastSwapAt) {
          const init = capacityFromSeries(series.slice(0, BATTERY_WINDOW_DAYS), tempC);
          if (init && init.r >= BATTERY_MIN_R
            && init.cap25Ah >= BATTERY_CAP_RANGE_AH[0] && init.cap25Ah <= BATTERY_CAP_RANGE_AH[1]) {
            entry.capacityInitialAh = Math.round(init.cap25Ah * 10) / 10;
            entry.initialWindow = { from: init.from, to: init.to, days: init.pairs, tempC: init.tempC };
            entry.degradePct = Math.round(cap.cap25Ah / init.cap25Ah * 100);
          }
        }
      }
    }
    /* 放電の速さ(へたり具合)「1Ah取り出すと何V下がるか」[mV/Ah]
       -------------------------------------------------------------------
       電圧降下[V/h] ÷ 放電電流[A]。充電されない夜間だけの実測なので、日射も季節も
       気温もほとんど効かない。容量に反比例するので、同じ拠点で増えていればへたりが進行。

       【前日が晴れた夜は使わない】
       よく晴れた日の夜は、充電直後の「表面電荷」が抜けていく分だけ電圧が余計に下がり、
       放電が速く見える。実データ(直近12夜)で前日の発電量が中央値より多い夜と少ない夜に
       分けると、見かけの容量が 祇園89Ah↔128Ah、北沢64Ah↔129Ah と4割以上ずれた。
       この影響を除かないと、へたり具合ではなく前日の天気を測ってしまう。
       そこで「前日の発電量がその拠点の中央値以下だった夜」だけを使う。 */
    const genList = series.map(function (p) { return p.d.genWh; })
      .filter(function (g) { return typeof g === "number" && g > 0; });
    const genMid = medianOf(genList);
    const prevGenOf = {};
    for (let i = 1; i < series.length; i++) {
      if ((Date.parse(series[i].day) - Date.parse(series[i - 1].day)) !== 86400000) continue;
      prevGenOf[series[i].day] = series[i - 1].d.genWh;
    }
    const mvSeries = series.map(function (p) {
      const d = p.d;
      if (typeof d.nightVPerH !== "number" || typeof d.nightA !== "number") return null;
      if (!(d.nightVPerH > 0.0008) || !(d.nightA >= BATTERY_MIN_NIGHT_A)) return null;
      // 前日の発電量が分かっていて、かつ中央値を超えている夜は表面電荷の影響が乗るので外す
      const pg = prevGenOf[p.day];
      if (genMid !== null && typeof pg === "number" && pg > genMid) return null;
      return { day: p.day, mv: d.nightVPerH / d.nightA * 1000 };
    }).filter(Boolean);
    entry.nightGenMaxWh = genMid === null ? null : Math.round(genMid);
    entry.nightNights = mvSeries.length;
    const mvNowSeg = mvSeries.slice(-BATTERY_NIGHT_WINDOW);
    const mvPrevSeg = mvSeries.slice(-BATTERY_NIGHT_WINDOW * 2, -BATTERY_NIGHT_WINDOW);
    const mvNow = medianOf(mvNowSeg.map(function (x) { return x.mv; }));
    const mvPrev = medianOf(mvPrevSeg.map(function (x) { return x.mv; }));
    // 比べている2つの期間の間に交換が入っている場合、この比較は「交換前 vs 交換後」になる。
    // 載せ替えた電池のほうが弱ければここで放電が速くなるので、画面でそう分かるようにする。
    if (entry.lastSwapAt && mvPrevSeg.length && mvNowSeg.length
      && mvPrevSeg[0].day < entry.lastSwapAt && mvNowSeg[mvNowSeg.length - 1].day >= entry.lastSwapAt) {
      entry.mvSpansSwap = true;
    }
    if (mvNow !== null) entry.mvPerAhNow = Math.round(mvNow * 10) / 10;
    if (mvPrev !== null) entry.mvPerAhPrev = Math.round(mvPrev * 10) / 10;
    // 発電ピークの初期比。パネルの汚れ・日陰・季節を合わせて見るための参考。
    const peakOf = function (seg) {
      const v = seg.map(function (p) { return p.d.pvPeakW; })
        .filter(function (x) { return typeof x === "number" && x > 0; });
      const m = medianOf(v);
      return m === null ? null : Math.round(m * 10) / 10;
    };
    entry.pvPeakNowW = peakOf(series.slice(-BATTERY_WINDOW_DAYS));
    if (series.length >= BATTERY_DEGRADE_MIN_SPAN) entry.pvPeakInitialW = peakOf(series.slice(0, BATTERY_WINDOW_DAYS));
    // 直近の1日あたりの発電量・消費量(中央値)。表で「何に食われているか」を見るのに使う。
    const medField = function (f) {
      const v = series.slice(-BATTERY_WINDOW_DAYS).map(function (p) { return p.d[f]; })
        .filter(function (x) { return typeof x === "number"; });
      const m = medianOf(v);
      return m === null ? null : Math.round(m * 10) / 10;
    };
    entry.genWhPerDay = medField("genWh");
    entry.loadWhPerDay = medField("loadWh");
    // 最低電圧の日ごとの並び。拠点ごとに違う下限電圧は画面側が持っているので、
    // 「下限を割った日が何日あったか」は画面側で数えられるよう日付を揃えて渡す。
    if (days.length) {
      const lastDay = days[days.length - 1];
      const from = new Date(Date.parse(lastDay) - (BATTERY_VMIN_KEEP_DAYS - 1) * 86400000);
      const p2 = function (n) { return String(n).padStart(2, "0"); };
      const keyOf = function (d) {
        return d.getUTCFullYear() + "-" + p2(d.getUTCMonth() + 1) + "-" + p2(d.getUTCDate());
      };
      const arr = [];
      for (let i = 0; i < BATTERY_VMIN_KEEP_DAYS; i++) {
        const k = keyOf(new Date(from.getTime() + i * 86400000));
        const d = (dayMap[k] || {})[id];
        arr.push(d && typeof d.vmin === "number" ? Math.round(d.vmin * 1000) / 1000 : null);
      }
      if (arr.some(function (x) { return x !== null; })) {
        entry.vminFrom = keyOf(from);
        entry.vminDays = arr;
      }
    }
    sites[id] = entry;
  });
  return sites;
}
async function updateBatteryHealthFile() {
  const prev = await readJsonSafe(BATTERY_HEALTH_JSON_PATH, null);
  const nowMs = Date.now();
  if (prev && prev.generatedAt && nowMs - Date.parse(prev.generatedAt) < BATTERY_HEALTH_REFRESH_MS) {
    return { skipped: true, sites: prev.sites ? Object.keys(prev.sites).length : 0 };
  }
  const store = await readJsonSafe(POWER_DAILY_JSON_PATH, null);
  const longTerm = await readJsonSafe(POWER_LONGTERM_JSON_PATH, null);
  if ((!store || !store.days) && (!longTerm || !longTerm.days)) {
    return { skipped: false, sites: 0, rated: 0, reason: "日次集計がありません" };
  }
  const sites = computeBatteryEndurance(store || { days: {} }, longTerm);
  const spanDays = Object.keys(mergeDailyStores(store, longTerm)).length;
  await writeFile(BATTERY_HEALTH_JSON_PATH, JSON.stringify({
    generatedAt: new Date(nowMs).toISOString(),
    method: "endurance",         // 旧方式(持ち率%)と区別するための印
    reserveSocPct: BATTERY_RESERVE_SOC,
    nightEndHourJst: BATTERY_NIGHT_END_H,
    days: spanDays,
    // 劣化の目安がどういう条件で出ているかを画面側に伝える
    capWindowDays: BATTERY_WINDOW_DAYS,
    tempRefC: BATTERY_TEMP_REF_C,
    tempCoefPerC: BATTERY_TEMP_COEF,
    longTermFrom: (longTerm && longTerm.from) || null,
    longTermTo: (longTerm && longTerm.to) || null,
    sites: sites
  }, null, 2) + "\n", "utf8");
  const rated = Object.keys(sites).filter(function (id) { return typeof sites[id].enduranceH === "number"; }).length;
  return { skipped: false, sites: Object.keys(sites).length, rated: rated };
}

// ---- 画像アーカイブ(全46拠点、直近IMAGE_RETENTION_DAYS日分のみ保持) ----

// 静岡県「川の防災情報」河川監視カメラ(cam.shizuoka4.jp)のライブ画像URLをobsdateから組み立てる
// (kw01〜kw03専用。ダッシュボード本体のshizuokaLiveImageUrlFromObsdateと同等)。
function shizuokaLiveImageUrlFromObsdate(camtype, obsdate) {
  const m = String(obsdate).match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})/);
  if (!m) return null;
  const y = m[1], mo = m[2], d = m[3], h = m[4], mi = m[5];
  return "https://www.cam.shizuoka4.jp/cam/" + camtype + "/" + y + "/" + mo + "/" + d + "/" + y + mo + d + h + mi + "00_01.jpg";
}

// サーバー実行のためCORS制限を受けず、クライアント側のようなr.jina.aiプロキシは不要で直接取得できる。
async function fetchShizuokaLiveImageUrl(camtype) {
  const res = await fetchWithTimeout("https://www.cam.shizuoka4.jp/cam/" + camtype + ".json?_=" + Date.now());
  const text = await res.text();
  const m = text.match(/"obsdate"\s*:\s*"([^"]+)"/);
  if (!m) throw new Error("静岡県カメラ: obsdate取得失敗");
  const obsdate = m[1].replace(/\\\//g, "/");
  const url = shizuokaLiveImageUrlFromObsdate(camtype, obsdate);
  if (!url) throw new Error("静岡県カメラ: 日時解析失敗");
  return url;
}

function pad2(n) { return String(n).padStart(2, "0"); }
// ファイルシステム/URLで安全な文字のみで構成したファイル名(コロン・ドットを含まない圧縮ISO形式、UTC)。
function imageFileNameFor(fetchedAt) {
  const y = fetchedAt.getUTCFullYear(), mo = pad2(fetchedAt.getUTCMonth() + 1), d = pad2(fetchedAt.getUTCDate());
  const h = pad2(fetchedAt.getUTCHours()), mi = pad2(fetchedAt.getUTCMinutes()), s = pad2(fetchedAt.getUTCSeconds());
  return y + mo + d + "T" + h + mi + s + "Z.jpg";
}

async function fetchImageBuffer(url) {
  const res = await fetchWithTimeout(url);
  const arrayBuffer = await res.arrayBuffer();
  if (arrayBuffer.byteLength === 0) throw new Error("空の画像応答");
  if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) throw new Error("画像サイズが上限を超えています(" + arrayBuffer.byteLength + " bytes)");
  const buffer = Buffer.from(arrayBuffer);
  // JPEGのマジックバイト(FFD8)を確認し、エラーページ等のHTML応答を誤って画像として保存しないようにする
  if (buffer.length < 2 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error("応答がJPEG画像ではありません");
  }
  return buffer;
}

async function fileExists(p) {
  try { await stat(p); return true; } catch (e) { return false; }
}
async function readManifest() {
  const fallback = { generatedAt: null, retentionDays: IMAGE_RETENTION_DAYS, sites: {} };
  try {
    const json = JSON.parse(await readFile(IMAGE_MANIFEST_PATH, "utf8"));
    if (!json || typeof json !== "object" || !json.sites) return fallback;
    return json;
  } catch (e) {
    return fallback;
  }
}

// ImageMagickで縮小する。コマンド名は環境によって "magick"(v7) と "convert"(v6) のどちらかなので
// 両方を順に試し、どちらも使えない環境では縮小せずそのまま保存する(機能は落とさない)。
const IMAGE_RESIZE_COMMANDS = ["magick", "convert"];
let imageResizeCmd = null;      // 使えると分かったコマンド
let imageResizeUnusable = false; // どれも使えないと分かった
function runResize(cmd, buffer) {
  return new Promise(function (resolve) {
    let settled = false;
    const done = function (buf) { if (!settled) { settled = true; resolve(buf); } };
    try {
      const child = execFile(cmd,
        ["-", "-resize", IMAGE_MAX_WIDTH + ">", "-quality", String(IMAGE_QUALITY), "-strip", "jpg:-"],
        { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
        function (err, stdout) {
          if (err) return done(null);
          // JPEG以外が返った場合や、かえって大きくなった場合は縮小しなかったことにする
          if (stdout && stdout.length > 2 && stdout[0] === 0xff && stdout[1] === 0xd8 && stdout.length < buffer.length) return done(stdout);
          done(null);
        });
      child.on("error", function () { done(null); });
      child.stdin.on("error", function () { done(null); });
      child.stdin.end(buffer);
    } catch (e) { done(null); }
  });
}
async function shrinkJpeg(buffer) {
  if (!(IMAGE_MAX_WIDTH > 0) || imageResizeUnusable) return buffer;
  const candidates = imageResizeCmd ? [imageResizeCmd] : IMAGE_RESIZE_COMMANDS;
  for (const cmd of candidates) {
    const out = await runResize(cmd, buffer);
    if (out) { imageResizeCmd = cmd; return out; }
  }
  if (!imageResizeCmd) {
    imageResizeUnusable = true;
    console.warn("画像の縮小をスキップします(ImageMagickが使えません: " + IMAGE_RESIZE_COMMANDS.join(" / ") + ")");
  }
  return buffer;
}
async function saveSiteImage(site, buffer, fetchedAt) {
  const siteDir = path.join(IMAGES_DIR, site.id);
  await mkdir(siteDir, { recursive: true });
  const fileName = imageFileNameFor(fetchedAt);
  const saved = await shrinkJpeg(buffer);
  await writeFile(path.join(siteDir, fileName), saved);
  // path: リポジトリ内の実体の位置(保持期間を過ぎた分の削除に使う)
  // url : ダッシュボードが読み込むURL(専用ブランチのraw URL、未設定なら相対パス)
  const relPath = "data/images/" + site.id + "/" + fileName;
  return { path: relPath, url: IMAGE_BASE_URL ? (IMAGE_BASE_URL + site.id + "/" + fileName) : relPath };
}

// 全46拠点(matsuhisa 27 + kawabou-water 11 + kawabou-camera 8)の画像取得・保存・
// 直近IMAGE_RETENTION_DAYS日分以外の削除・manifest更新を行う。データ本体の取得成否とは独立した
// ベストエフォート処理であり、拠点単位の失敗はログのみで全体を失敗させない。
// readingsBySiteId: matsuhisa拠点についてはメインのデータ取得で既に得たimageUrlを再利用する
// (同じレスポンスから抽出済みのため、画像だけのために追加リクエストを発生させない)。
async function archiveImages(readingsBySiteId) {
  await mkdir(IMAGES_DIR, { recursive: true });
  const manifest = await readManifest();
  manifest.retentionDays = IMAGE_RETENTION_DAYS;
  const fetchedAt = new Date();

  const tasks = [];
  if (!SKIP_MATSUHISA) {
    MATSUHISA_SITES.forEach(function (site) {
      const reading = readingsBySiteId[site.id];
      if (reading && reading.imageUrl) {
        tasks.push({ site: site, resolveUrl: async function () { return reading.imageUrl; } });
      }
    });
  }
  KAWABOU_WATER_SITES.forEach(function (site) {
    if (site.shizuokaCamtype) {
      tasks.push({ site: site, resolveUrl: function () { return fetchShizuokaLiveImageUrl(site.shizuokaCamtype); } });
    }
  });
  KAWABOU_CAMERA_SITES.forEach(function (site) {
    tasks.push({ site: site, resolveUrl: async function () { return site.liveImageUrl; } });
  });

  let okCount = 0, ngCount = 0;
  await mapWithConcurrency(tasks, IMAGE_CONCURRENCY, async function (task) {
    try {
      const url = await task.resolveUrl();
      if (!url) throw new Error("画像URLを解決できませんでした");
      const buffer = await fetchImageBuffer(url);
      const saved = await saveSiteImage(task.site, buffer, fetchedAt);
      if (!manifest.sites[task.site.id]) manifest.sites[task.site.id] = { name: task.site.name, files: [] };
      manifest.sites[task.site.id].name = task.site.name;
      manifest.sites[task.site.id].files.push({ ts: fetchedAt.toISOString(), file: saved.url, path: saved.path });
      okCount++;
    } catch (err) {
      ngCount++;
      console.warn("[画像NG] " + task.site.id + ": " + (err && err.message ? err.message : String(err)));
    }
  });

  // 直近IMAGE_RETENTION_DAYS日より古いエントリをmanifestとディスクの両方から削除する
  // (gitの性質上、削除しても過去コミットの履歴には残り続けるが、以後のチェックアウト・
  // GitHub Pages配信・クローンのサイズは直近分のみに保たれる)。
  const cutoff = Date.now() - IMAGE_RETENTION_MS;
  for (const siteId of Object.keys(manifest.sites)) {
    const entry = manifest.sites[siteId];
    const kept = [], removed = [];
    for (const f of (entry.files || [])) {
      const t = Date.parse(f.ts);
      if (isNaN(t) || t < cutoff) { removed.push(f); continue; }
      // 画像を専用ブランチへ移す前の古いエントリ(fileが相対パス)は、main側に実体が無くなっているため
      // ダッシュボードから読み込めない。実体が残っていないものはここで一覧から外す
      // (専用ブランチのURL形式のエントリは、この実行で取得していなくても有効なので必ず残す)。
      if (!/^https?:/i.test(String(f.file || "")) && !(await fileExists(path.join(ROOT, f.path || f.file || "")))) {
        continue;
      }
      kept.push(f);
    }
    kept.sort(function (a, b) { return Date.parse(a.ts) - Date.parse(b.ts); });
    entry.files = kept;
    for (const f of removed) {
      // 古い形式(fileが相対パス)のマニフェストも扱えるようにpathが無ければfileを使う
      const rel = f.path || f.file;
      if (!rel || /^https?:/i.test(rel)) continue;
      try { await unlink(path.join(ROOT, rel)); } catch (e) { /* 既に削除済みの場合は無視 */ }
    }
  }

  manifest.generatedAt = new Date().toISOString();
  await writeFile(IMAGE_MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(okCount + "/" + tasks.length + " 拠点の画像取得に成功しました(" + ngCount + "件失敗)。");
}

// ---- データファイルの初期化 ----
async function ensureDataFiles() {
  await mkdir(DATA_DIR, { recursive: true });
  for (const p of [HISTORY_CSV_PATH, RECENT_CSV_PATH, WATER_RECENT_CSV_PATH]) {
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

function csvEscape(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsvRow(site, fetchedAt, reading) {
  return [
    site.id,
    fetchedAt.toISOString(),
    reading.measureTime || "",
    typeof reading.pv === "number" ? reading.pv.toFixed(3) : "",
    typeof reading.bat === "number" ? reading.bat.toFixed(3) : "",
    typeof reading.waterLevelM === "number" ? reading.waterLevelM.toFixed(3) : "",
    reading.via
  ].map(csvEscape).join(",");
}

// data/recent.csv は「直近分のみ」を毎回作り直す(全期間分のhistory.csvは
// 追記のみで読み返さないため、拠点数×実行回数が積み重なっても取得処理は軽いまま)。
// 旧バージョン(水位(m)列が無い6列形式)の行は列数が合わないため自動的に破棄される。
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
    if (cols.length !== CSV_COLUMNS) return false; // 旧形式(6列)の行は破棄
    const t = Date.parse(cols[1]);
    return !isNaN(t) && t >= cutoff;
  });
  const combined = kept.concat(newRows);
  await writeFile(RECENT_CSV_PATH, CSV_HEADER + "\n" + combined.join("\n") + (combined.length ? "\n" : ""), "utf8");
}

// data/recent_water.csv は、水位(m)列(7列中6列目、0始まりindex5)に値が入っている行だけを
// 対象に、直近1か月分を毎回作り直す(recent.csvと同じ7列フォーマットを流用し、クライアント側の
// 既存パーサー(parseCsvRows)をそのまま再利用できるようにしている)。電源のみの拠点(cam01等)や、
// 水位が取得できなかった行は自然に除外される。data/history.csv自体は従来通り全期間・無制限に
// 保持し続けるため、この関数はあくまで「起動直後にクライアントへ渡す水位の窓」を作るためのもの。
function isWaterRow(line) {
  const cols = line.split(",");
  if (cols.length !== CSV_COLUMNS) return false; // 旧形式(6列)の行は対象外
  return cols[5] !== undefined && cols[5] !== "";
}
async function rebuildRecentWaterCsv(newRows) {
  let existingLines = [];
  try {
    const text = await readFile(WATER_RECENT_CSV_PATH, "utf8");
    existingLines = text.split(/\r?\n/).filter(function (l) { return l.trim().length; });
    if (existingLines.length && existingLines[0].indexOf("拠点") === 0) existingLines.shift();
  } catch (e) {
    existingLines = [];
  }
  const cutoff = Date.now() - WATER_RECENT_WINDOW_MS;
  const kept = existingLines.filter(function (line) {
    if (!isWaterRow(line)) return false;
    const cols = line.split(",");
    const t = Date.parse(cols[1]);
    return !isNaN(t) && t >= cutoff;
  });
  const newWaterRows = newRows.filter(isWaterRow);
  const combined = kept.concat(newWaterRows);
  await writeFile(WATER_RECENT_CSV_PATH, CSV_HEADER + "\n" + combined.join("\n") + (combined.length ? "\n" : ""), "utf8");
}

// 同時実行数を絞って全拠点を取得する(サーバー側相手に過度な同時アクセスをしないため)
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(runOne());
  await Promise.all(runners);
  return results;
}

async function main() {
  await ensureDataFiles();
  const previousLatest = await readJsonSafe(LATEST_JSON_PATH, { sites: {} });
  const latest = { generatedAt: new Date().toISOString(), sites: {} };
  const newCsvRows = [];
  const readingsBySiteId = {}; // 画像アーカイブでmatsuhisa拠点のimageUrlを再利用するため保持

  // matsuhisaをスキップする回は、その拠点の前回状態をそのまま引き継ぐ(一覧から消えないようにする)
  const targetSites = SKIP_MATSUHISA ? SITES.filter(function (s) { return s.sourceType !== "matsuhisa"; }) : SITES;
  if (SKIP_MATSUHISA) {
    SITES.forEach(function (site) {
      if (site.sourceType !== "matsuhisa") return;
      const prev = (previousLatest.sites && previousLatest.sites[site.id]) || {};
      latest.sites[site.id] = Object.assign({}, prev);
    });
    console.log("matsuhisa.info系" + (SITES.length - targetSites.length) + "拠点は今回スキップしました(SKIP_MATSUHISA=1)。");
  }
  await mapWithConcurrency(targetSites, CONCURRENCY, async function (site) {
    const prev = (previousLatest.sites && previousLatest.sites[site.id]) || {};
    const fetchedAt = new Date();
    try {
      const reading = await fetchReading(site);
      readingsBySiteId[site.id] = reading;
      newCsvRows.push({ order: site.id, row: toCsvRow(site, fetchedAt, reading) });
      latest.sites[site.id] = {
        // 発電(PV)は中継サーバーのCSVからのみ入る(この後の取り込み処理で上書きされる)。
        // 新しい行が無かった回でも値が消えないよう、前回値を引き継いでおく。
        pv: typeof prev.pv === "number" ? prev.pv : null,
        bat: typeof reading.bat === "number" ? reading.bat : (typeof prev.bat === "number" ? prev.bat : null),
        measureTime: reading.measureTime,
        waterLevelM: reading.waterLevelM,
        via: reading.via,
        lastSuccessAt: fetchedAt.toISOString(),
        lastFetchAt: fetchedAt.toISOString(),
        lastFetchOk: true,
        lastError: null
      };
      console.log("[OK] " + site.id + ": PV=" + (typeof reading.pv === "number" ? reading.pv.toFixed(3) + "V" : "-") +
        " BAT=" + (typeof reading.bat === "number" ? reading.bat.toFixed(3) + "V" : "-") +
        " 水位=" + (typeof reading.waterLevelM === "number" ? reading.waterLevelM.toFixed(3) + "m" : "-"));
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      latest.sites[site.id] = {
        pv: typeof prev.pv === "number" ? prev.pv : null,
        bat: typeof prev.bat === "number" ? prev.bat : null,
        measureTime: prev.measureTime || null,
        waterLevelM: typeof prev.waterLevelM === "number" ? prev.waterLevelM : null,
        via: prev.via || null,
        lastSuccessAt: prev.lastSuccessAt || null,
        lastFetchAt: fetchedAt.toISOString(),
        lastFetchOk: false,
        lastError: message
      };
      console.warn("[NG] " + site.id + ": " + message);
    }
  });

  // ---- 電源データ(発電PV[W]/バッテリ[V])を中継サーバーのCSVからまとめて取り込む ----
  // 当日分の全時刻が毎回返ってくるため、前回取り込み済みの最終時刻より新しい行だけを追記する。
  const prevPowerTs = previousLatest.powerRelay && previousLatest.powerRelay.lastTs
    ? new Date(previousLatest.powerRelay.lastTs).getTime() : 0;
  let newestPowerTs = prevPowerTs;
  let relayRows = [];   // バッテリー劣化指標(消費電力)の算出にも使う
  try {
    const powerRows = await fetchPowerRelayRows();
    relayRows = powerRows;
    const freshRows = powerRows.filter(function (r) { return r.fetchedAt.getTime() > prevPowerTs; });
    freshRows.forEach(function (r) {
      if (r.fetchedAt.getTime() > newestPowerTs) newestPowerTs = r.fetchedAt.getTime();
      newCsvRows.push({
        order: r.siteId,
        orderTs: r.fetchedAt.getTime(),
        row: [r.siteId, r.fetchedAt.toISOString(), "",
          typeof r.pv === "number" ? r.pv.toFixed(3) : "",
          typeof r.bat === "number" ? r.bat.toFixed(3) : "",
          "", VIA_LABEL_POWER_RELAY].map(csvEscape).join(",")
      });
      const entry = latest.sites[r.siteId];
      if (entry) {
        if (typeof r.pv === "number") entry.pv = r.pv;
        if (typeof r.bat === "number") entry.bat = r.bat;
      }
    });
    console.log("[OK] 電源CSV(mini.lhlab-vps.net): " + powerRows.length + "行中 " + freshRows.length + "行を新規取り込み");
  } catch (err) {
    console.warn("[NG] 電源CSV(mini.lhlab-vps.net)の取得に失敗しました: " + (err && err.message ? err.message : String(err)));
  }
  latest.powerRelay = { lastTs: newestPowerTs ? new Date(newestPowerTs).toISOString() : null };

  // SITES本来の順番で書き込む(並行実行のため完了順はバラつくため)
  const orderIndex = {};
  SITES.forEach(function (s, i) { orderIndex[s.id] = i; });
  newCsvRows.sort(function (a, b) {
    const ta = a.orderTs || 0, tb = b.orderTs || 0;
    if (ta !== tb) return ta - tb;
    return (orderIndex[a.order] || 0) - (orderIndex[b.order] || 0);
  });
  const rowStrings = newCsvRows.map(function (r) { return r.row; });

  if (rowStrings.length) {
    await appendFile(HISTORY_CSV_PATH, rowStrings.join("\n") + "\n", "utf8");
  }
  await rebuildRecentCsv(rowStrings);
  await rebuildRecentWaterCsv(rowStrings);
  await writeFile(LATEST_JSON_PATH, JSON.stringify(latest, null, 2) + "\n", "utf8");

  const okCount = Object.values(latest.sites).filter(function (s) { return s.lastFetchOk; }).length;
  console.log(okCount + "/" + targetSites.length + " 拠点の取得に成功しました。");

  // 雨量(ダッシュボードが水位グラフに重ねる)。失敗してもデータ取得全体は継続する。
  try {
    const rain = await updateRainfallFile();
    console.log("[OK] 雨量計(三島): " + rain.fetched + "件取得 / 保持 " + rain.total + "件");
  } catch (err) {
    console.warn("[NG] 雨量計(三島)の取得に失敗しました: " + (err && err.message ? err.message : String(err)));
  }

  // 電源の日次集計(0時基準電圧・収支Wh・夜間電流)。毎回、当日ぶんを上書きし、
  // 足りない過去日を少しずつ遡って埋める。バッテリーの持ちはこれを元に出す。
  try {
    const daily = await updatePowerDailyFile(relayRows);
    console.log("[OK] 電源の日次集計: " + daily.days + "日分"
      + (daily.filled ? "（過去 " + daily.filled + "日分を追加取得）" : ""));
  } catch (err) {
    console.warn("[NG] 電源の日次集計に失敗しました: " + (err && err.message ? err.message : String(err)));
  }

  // 長期日次(中継サーバーのAPI・観測開始からの全日)。1日2回だけ取りに行く。
  // 容量の回帰に使える日数が増え、「観測開始ごろ」と「直近」で容量を比べられるようになる。
  try {
    const lt = await updatePowerLongTermFile();
    if (lt.skipped) console.log("長期日次は前回取得から12時間未満のためスキップしました。");
    else console.log("[OK] 長期日次: " + lt.days + "日分 / " + lt.sites + "拠点"
      + (lt.reason ? "（" + lt.reason + "）" : "")
      + (lt.unmatched && lt.unmatched.length ? "（対象外: " + lt.unmatched.join("・") + "）" : ""));
  } catch (err) {
    console.warn("[NG] 長期日次の取得に失敗しました: " + (err && err.message ? err.message : String(err)));
  }

  // バッテリーの持ち(無日射で何時間もつか)。1時間に1回だけ計算し直す。
  try {
    const health = await updateBatteryHealthFile();
    if (health.skipped) console.log("バッテリーの持ちは前回計算から1時間未満のためスキップしました。");
    else console.log("[OK] バッテリーの持ち: " + health.rated + "/" + health.sites + "拠点を算出しました。"
      + (health.reason ? "（" + health.reason + "）" : ""));
  } catch (err) {
    console.warn("[NG] バッテリーの持ちの算出に失敗しました: " + (err && err.message ? err.message : String(err)));
  }

  // 画像アーカイブはデータ取得(上記)とは独立したベストエフォート処理とし、
  // ここで失敗してもデータ取得自体の成功/終了コードには影響させない。
  if (SKIP_IMAGES) {
    console.log("画像アーカイブはスキップしました(SKIP_IMAGES=1)。");
    return;
  }
  try {
    await archiveImages(readingsBySiteId);
  } catch (err) {
    console.warn("画像アーカイブ処理全体でエラーが発生しました:", err && err.message ? err.message : String(err));
  }
}

// main()の完了をテストコードから待ち受けられるようにexportしておく
// (通常のCLI実行では未使用。挙動は従来通り、失敗時はprocess.exit(1)する)。
const runPromise = main();
runPromise.catch(function (err) {
  console.error(err);
  process.exit(1);
});
export {
  runPromise, SITES, main, KAWABOU_CAMERA_SITES, KAWABOU_WATER_SITES, IMAGE_RETENTION_DAYS, IMAGES_DIR, IMAGE_MANIFEST_PATH,
  fetchKawabouWaterReading, kawabouWaterJsonUrl, kawabouSwstgJsonUrl,
  WATER_RECENT_CSV_PATH, WATER_RECENT_WINDOW_MS,
  parsePowerCsv, powerCsvUrlFor, POWER_SOURCE_NAME_TO_ID, POWER_CSV_BASE_URL,
  RAINFALL_JSON_PATH, rainfallJsonUrl, parseRainfallJson, parseJstTime, MISHIMA_RAIN_OBS_CD13,
  BATTERY_HEALTH_JSON_PATH, POWER_DAILY_JSON_PATH, BATTERY_RESERVE_SOC, BATTERY_MIN_R,
  BATTERY_MIN_DAYS, BATTERY_MAINS_V, BATTERY_OCV_TABLE,
  socFromRestingVoltage, summarizePowerDay, updatePowerDailyFile,
  computeBatteryEndurance, updateBatteryHealthFile, medianOf, fitLine,
  POWER_LONGTERM_JSON_PATH, POWER_LONGTERM_API_BASE, POWER_LONGTERM_MAX_ID,
  BATTERY_WINDOW_DAYS, BATTERY_DEGRADE_MIN_SPAN, BATTERY_VMIN_KEEP_DAYS,
  BATTERY_TEMP_COEF, BATTERY_TEMP_REF_C,
  fetchLongTermDaily, fetchDailyMeanTemps, updatePowerLongTermFile,
  mergeDailyStores, capacityFromSeries,
  detectBatterySwaps, snapRatedAh, bestCapacityAh, findIntradaySwap,
  BATTERY_RATED_CANDIDATES, BATTERY_NIGHT_WINDOW
};
