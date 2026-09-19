// テスト用の静的ファイルサーバー。リポジトリのルート(index.html など)をそのまま配信する。
// 「テスト用にコピーしたHTML」ではなく本番と同じファイルを検証対象にするための仕組み。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
export const PORT = Number(process.env.TEST_PORT || 8971);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml"
};

export function startServer(port = PORT) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    // ルート外へのアクセスを防ぐ
    const filePath = path.normalize(path.join(ROOT, p));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

// 直接実行された場合はサーバーを起動したままにする(手動確認用)
if (process.argv[1] && process.argv[1].endsWith("server.mjs")) {
  startServer().then(() => console.log("test server on http://127.0.0.1:" + PORT));
}
