/* 브리지 호환 판정 검증 (2026-07-21 사용자 지적)
 *
 * 웹과 브리지는 별개 프로그램이라 버전이 따로 논다. 웹 v3.30.0 · 브리지
 * v3.24.0처럼 숫자가 다른 것이 **정상**인데, 화면이 숫자만 보여주니
 * "구버전 아니냐"는 오해가 생겼다. 실제로는 브리지가 최신이었다.
 *
 * 그래서 숫자가 아니라 **맞는지 아닌지**를 말해주도록 바꿨고, 그 판정이
 * 진짜로 동작하는지 여기서 확인한다.
 *
 * MIN_BRIDGE는 브리지 코드를 고칠 때만 올린다 — 웹 버전에 맞춰 올리면
 * 바뀐 것도 없는데 사용자에게 매번 재시작을 시키게 된다.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label} — ${e.message}`); failures++; }
};

/* 규칙은 소스에서 뽑아 쓴다 — 옮겨 적으면 두 벌이 되어 조용히 어긋난다 */
const src = readFileSync(join(HERE, "..", "shared", "app.js"), "utf-8");
const pick = (re, what) => {
  const m = src.match(re);
  if (!m) throw new Error(`app.js에서 ${what}을 찾지 못했습니다`);
  return m[1];
};
const MIN_BRIDGE = pick(/const MIN_BRIDGE = "([\d.]+)"/, "MIN_BRIDGE");
const cmpVer = eval(`(${pick(/const cmpVer = (\(a, b\) => \{[\s\S]*?\n\};)/, "cmpVer").replace(/;$/, "")})`);

console.log(`app.js MIN_BRIDGE = ${MIN_BRIDGE}`);

console.log("\n버전 비교");
const CASES = [
  ["3.24.0", "3.24.0", 0, "같은 버전"],
  ["3.25.0", "3.24.0", 1, "더 최신"],
  ["3.23.0", "3.24.0", -1, "더 오래됨"],
  ["3.4.0", "3.24.0", -1, "자릿수 함정 — 3.4 < 3.24 (문자열 비교였다면 반대로 나온다)"],
  ["3.24.1", "3.24.0", 1, "패치 버전"],
  ["4.0.0", "3.99.9", 1, "메이저 상승"],
  ["3.24", "3.24.0", 0, "패치 생략"],
];
for (const [a, b, want, why] of CASES) {
  check(`${a} vs ${b} → ${want > 0 ? "최신" : want < 0 ? "구버전" : "동일"} (${why})`, () => {
    const got = Math.sign(cmpVer(a, b));
    if (got !== want) throw new Error(`기대 ${want}, 실제 ${got}`);
  });
}

console.log("\n실제 상황 판정");

check("현재 브리지(v3.24.0)를 '갱신 필요'로 오판하지 않는다", () => {
  if (cmpVer("3.24.0", MIN_BRIDGE) < 0)
    throw new Error("최신 브리지인데 구버전으로 판정한다 — 헛경고가 뜬다");
});

check("진짜 구버전은 잡아낸다", () => {
  if (cmpVer("3.20.0", MIN_BRIDGE) >= 0)
    throw new Error("구버전을 통과시킨다 — 경고가 무의미하다");
});

check("MIN_BRIDGE가 웹 버전을 따라 올라가 있지 않다", () => {
  const V = pick(/export const V = "([\d.]+)"/, "V");
  if (MIN_BRIDGE === V)
    throw new Error(
      `MIN_BRIDGE(${MIN_BRIDGE})가 웹 버전과 같다. 브리지가 실제로 바뀌지 않았다면 `
      + `올리면 안 된다 — 바뀐 것도 없는데 사용자에게 재시작을 요구하게 된다`);
});

check("MIN_BRIDGE가 실제 브리지 소스의 버전을 넘지 않는다", () => {
  const bsrc = readFileSync(join(HERE, "..", "bridge", "bridge_server.py"), "utf-8");
  const m = bsrc.match(/BRIDGE_VERSION = "([\d.]+)"/);
  if (!m) throw new Error("bridge_server.py에서 BRIDGE_VERSION을 찾지 못했습니다");
  if (cmpVer(m[1], MIN_BRIDGE) < 0)
    throw new Error(
      `MIN_BRIDGE(${MIN_BRIDGE})가 실제 브리지(${m[1]})보다 높다 — `
      + `최신 브리지를 써도 영영 '갱신 필요'가 뜬다`);
});

console.log(failures ? `\n  ✗ ${failures}건 실패` : "\n  ✓ 전부 통과");
process.exit(failures ? 1 : 0);
