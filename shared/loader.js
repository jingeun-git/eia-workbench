/* 공용 모듈 로더 — 캐시 무효화용 `?v=`를 붙이되, 실패해도 기능을 죽이지 않는다.
 *
 * 왜 필요한가: `import("../shared/x.js?v=3.32.0")`가 어떤 PC에서만 실패했다
 * (2026-07-21 타 PC 배포 테스트). 저장소·원격 파일·MIME·구문은 모두 정상이었고
 * 다른 PC에서는 같은 URL이 잘 열렸다 — 즉 **환경 쪽 요인**(사내 프록시·보안
 * 프로그램·확장 프로그램 등)이다. 그런 요인은 내가 없앨 수 없다.
 *
 * 없앨 수 없다면 **버티게** 만든다.
 *   ① 버전 붙인 URL로 시도
 *   ② 실패하면 쿼리 없는 URL로 재시도 — 캐시가 낡을 수는 있어도 화면은 뜬다
 *   ③ 둘 다 실패하면 **무엇이 왜 실패했는지** 그대로 올려보낸다.
 *      "모듈 로드 실패"만 보여주면 사용자도 나도 다음에 할 일이 없다.
 */
export async function loadShared(path, V) {
  const url = `../shared/${path}`;
  const attempts = V ? [`${url}?v=${V}`, url] : [url];
  const errs = [];
  for (const u of attempts) {
    try {
      return await import(/* @vite-ignore */ u);
    } catch (e) {
      errs.push(`${u} → ${e?.message || e}`);
    }
  }
  const err = new Error(
    `공용 모듈 ${path} 를 불러오지 못했습니다.\n` +
    `네트워크·보안 프로그램이 차단했을 수 있습니다.\n` + errs.join("\n"));
  err.attempts = errs;
  throw err;
}
