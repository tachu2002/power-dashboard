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
    if (!isFinite(pvW) && !isFinite(batMv)) continue;
    out.push({
      siteId: siteId,
      fetchedAt: ts,
      pv: isFinite(pvW) ? pvW : null,
      bat: isFinite(batMv) ? batMv / 1000 : null
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
  try {
    const powerRows = await fetchPowerRelayRows();
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
  parsePowerCsv, powerCsvUrlFor, POWER_SOURCE_NAME_TO_ID, POWER_CSV_BASE_URL
};
