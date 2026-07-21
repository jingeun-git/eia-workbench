/* 탭 중복 회귀 — 진입점이 두 번 실행되면 탭이 두 벌 생긴다.
   원인: 도구 모듈이 shared/app.js를 import하면 URL이 다를 때 별개 인스턴스가 된다.
   공유 값은 부수효과 없는 shared/keys.js에 두고, app.js는 아무도 import하지 않아야 한다. */
import { nav } from "./dom_harness.mjs";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
await import(join(ROOT, "shared/app.js"));
await new Promise((r) => setTimeout(r, 30));

// 내비가 그룹으로 묶이면서 탭이 한 단계 안쪽으로 들어갔다(2026-07-21)
const tabs = nav.children.flatMap((g) =>
  (g.children || []).filter((c) => c.classList?.contains("tab")).map((c) => c.textContent));
const dup = tabs.filter((t, i) => tabs.indexOf(t) !== i);
const importers = readdirSync(join(ROOT, "modules"))
  .filter((f) => readFileSync(join(ROOT, "modules", f), "utf8").includes("shared/app.js"));

let fail = 0;
const groups = nav.children.length;
console.log(`그룹 ${groups}개 · 탭 ${tabs.length}개: ${tabs.join(" · ")}`);
if (dup.length) { console.log(`✗ 중복: ${[...new Set(dup)].join(", ")}`); fail = 1; }
else console.log("✓ 중복 없음");
if (importers.length) { console.log(`✗ app.js를 import하는 모듈: ${importers}`); fail = 1; }
else console.log("✓ app.js import 없음 — 단일 인스턴스 보장");
process.exit(fail);
