/* API 키 접근자 — 브라우저 localStorage에만 보관한다.
 *
 * app.js에서 분리한 이유: app.js는 탭 생성 등 **부수효과가 있는 진입점**이라,
 * 다른 모듈이 app.js를 import하면 URL이 조금만 달라져도(캐시 무효화용 ?v= 등)
 * 별개 인스턴스로 두 번 실행돼 탭이 중복 생성된다(2026-07-20 실사고).
 * 공유 값은 부수효과 없는 모듈에 둔다.
 */
export const keys = {
  get vworld()  { return localStorage.getItem("eiaw.key.vworld") || ""; },
  get pubdata() { return localStorage.getItem("eiaw.key.pubdata") || ""; },
};
