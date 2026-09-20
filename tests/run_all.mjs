// テストを一括実行する。個別に実行したい場合は各ファイルを直接 node で実行する。
//   node tests/run_all.mjs            … 全件
//   node tests/run_all.mjs power core … 指定したスイートのみ
import { teardown } from "./harness.mjs";

const SUITES = [
  ["core", "./test_core.mjs"],
  ["power", "./test_power.mjs"],
  ["sources", "./test_sources.mjs"],
  ["forecast", "./test_forecast.mjs"],
  ["views", "./test_views.mjs"],
  ["playback", "./test_playback.mjs"],
  ["history", "./test_history.mjs"],
  ["poll", "./test_poll.mjs"]
];

const only = process.argv.slice(2);
const targets = only.length ? SUITES.filter(([name]) => only.includes(name)) : SUITES;

if (!targets.length) {
  console.error("該当するテストがありません。指定可能: " + SUITES.map(([n]) => n).join(", "));
  process.exit(2);
}

const results = [];
let total = { pass: 0, fail: 0 };

for (const [name, file] of targets) {
  console.log("\n########## " + name + " ##########");
  try {
    const mod = await import(file);
    const counts = await mod.run();
    results.push({ name, ...counts });
    total.pass += counts.pass;
    total.fail += counts.fail;
  } catch (err) {
    console.error("スイートの実行中にエラー:", err && err.stack ? err.stack : err);
    results.push({ name, pass: 0, fail: 1, error: String(err && err.message ? err.message : err) });
    total.fail += 1;
  }
}

await teardown();

console.log("\n================ 集計 ================");
results.forEach(function (x) {
  console.log((x.fail ? "NG  " : "ok  ") + x.name.padEnd(10) + " " + x.pass + " passed, " + x.fail + " failed" +
    (x.error ? "  (" + x.error + ")" : ""));
});
console.log("-------------------------------------");
console.log("合計: " + total.pass + " passed, " + total.fail + " failed");
process.exit(total.fail ? 1 : 0);
