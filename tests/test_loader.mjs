/* shared/loader.js 검증 — 버전 붙인 import가 실패해도 기능이 살아남는가
 *
 * 2026-07-21 타 PC 배포 테스트에서 지오코딩 탭이 통째로 안 떴다.
 *   Failed to fetch dynamically imported module: .../shared/geocode.js?v=3.32.0
 * 저장소·원격 파일·MIME·구문은 전부 정상이었고 다른 PC에서는 같은 URL이 잘
 * 열렸다 — 환경 요인(사내망·보안 프로그램 등)이라 내가 없앨 수 없다.
 *
 * 없앨 수 없으면 버티게 만든다. 이 테스트가 확인하는 것:
 *   ① 정상일 때 버전 붙인 URL로 부른다 (캐시 무효화가 살아 있어야 한다)
 *   ② 그게 실패하면 쿼리 없는 URL로 재시도해 **기능이 살아난다**
 *   ③ 둘 다 실패하면 시도한 URL과 원인을 **그대로** 올려보낸다
 *      — "모듈 로드 실패"만 남기면 사용자도 나도 다음에 할 일이 없다
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label} — ${e.message}`); failures++; }
};

/* loader.js의 실제 소스를 가져와 import만 가로챈다 — 규칙을 옮겨 적으면
   두 벌이 되어 한쪽만 고쳐진다. */
const src = readFileSync(join(HERE, "..", "shared", "loader.js"), "utf-8");
const body = src.replace(/^export /m, "").replace("export async function", "async function");

function makeLoader(importer) {
  // `import(u)` 호출만 주입한 importer로 바꿔치기한다
  const patched = body.replace(/await import\([^)]*\)/, "await __imp(u)");
  const fn = new Function("__imp", `${patched}; return loadShared;`);
  return fn(importer);
}

console.log("loader.js");

await check("정상일 때 버전 붙인 URL로 부른다", async () => {
  const seen = [];
  const load = makeLoader(async (u) => { seen.push(u); return { ok: true }; });
  const m = await load("geocode.js", "3.32.0");
  if (!m.ok) throw new Error("모듈을 못 받았다");
  if (seen.length !== 1) throw new Error(`시도 ${seen.length}회 — 1회여야 한다`);
  if (!seen[0].endsWith("../shared/geocode.js?v=3.32.0"))
    throw new Error(`URL이 다르다: ${seen[0]}`);
});

await check("버전 URL이 막히면 쿼리 없는 URL로 되살아난다 (타 PC 증상)", async () => {
  const seen = [];
  const load = makeLoader(async (u) => {
    seen.push(u);
    if (u.includes("?v=")) throw new TypeError("Failed to fetch dynamically imported module");
    return { ok: true, viaFallback: true };
  });
  const m = await load("geocode.js", "3.32.0");
  if (!m.viaFallback) throw new Error("폴백으로 살아나지 않았다");
  if (seen.length !== 2) throw new Error(`시도 ${seen.length}회 — 2회여야 한다`);
});

await check("둘 다 막히면 시도한 URL과 원인을 모두 전달한다", async () => {
  const load = makeLoader(async () => {
    throw new TypeError("Failed to fetch dynamically imported module");
  });
  try {
    await load("geocode.js", "3.32.0");
    throw new Error("예외가 나지 않았다 — 조용히 넘어가면 원인을 알 수 없다");
  } catch (e) {
    if (!Array.isArray(e.attempts) || e.attempts.length !== 2)
      throw new Error(`시도 내역이 없다: ${JSON.stringify(e.attempts)}`);
    if (!/\?v=3\.32\.0/.test(e.attempts[0]) || /\?v=/.test(e.attempts[1]))
      throw new Error(`시도 URL이 이상하다: ${e.attempts.join(" | ")}`);
    if (!/Failed to fetch/.test(e.message))
      throw new Error("원래 오류 문구가 사라졌다 — 사용자가 전달할 정보가 없어진다");
    if (!/geocode\.js/.test(e.message))
      throw new Error("어느 모듈인지 안 나온다");
  }
});

await check("V가 없으면 쿼리 없이 한 번만 부른다", async () => {
  const seen = [];
  const load = makeLoader(async (u) => { seen.push(u); return {}; });
  await load("keys.js", undefined);
  if (seen.length !== 1 || seen[0].includes("?"))
    throw new Error(`시도: ${seen.join(" | ")}`);
});

console.log(failures ? `\n  ✗ ${failures}건 실패` : "\n  ✓ 전부 통과");
process.exit(failures ? 1 : 0);
