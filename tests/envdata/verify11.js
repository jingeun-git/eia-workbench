const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:8791";
const results = [];
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond, detail }); };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1400 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  await page.goto(`${BASE}/index.html#envdata`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ed-table thead th[data-col]");

  // 1) 분야 드롭다운 → 클릭형 배너
  ok("1. #ed-field-select 드롭다운 완전 제거됨", (await page.$("#ed-field-select")) === null);
  const btnCount = await page.$$eval(".ed-field-btn", (els) => els.length);
  ok("2. 분야 배너 버튼 7개", btnCount === 7, `count=${btnCount}`);
  const activeBefore = await page.$eval('.ed-field-btn[aria-pressed="true"]', (el) => el.textContent);
  ok("3. 초기 활성 배너=대기질", activeBefore === "대기질", activeBefore);
  await page.click('.ed-field-btn[data-idx="3"]'); // 토양
  await page.waitForTimeout(200);
  const activeAfter = await page.$eval('.ed-field-btn[aria-pressed="true"]', (el) => el.textContent);
  ok("4. 클릭 후 활성 배너=토양오염도", activeAfter === "토양오염도", activeAfter);
  const soilCols = await page.$$eval("#ed-table thead th[data-col]", (els) => els.length);
  ok("5. 배너 클릭으로 실제 분야 전환됨(토양 23항목)", soilCols === 23, `count=${soilCols}`);
  await page.click('.ed-field-btn[data-idx="0"]'); // 대기질로 복귀
  await page.waitForTimeout(200);

  // 6) 분야별 기준값 참고표
  const refRows = await page.$$eval("#ed-ref-wrap .ed-ref-table tbody tr", (els) => els.length);
  ok("6. 대기질 기준표 8행(8항목) 렌더", refRows === 8, `rows=${refRows}`);
  const refText = await page.$eval("#ed-ref-wrap", (el) => el.textContent);
  ok("7. 기준표에 출처(법령/고시일) 표시", refText.includes("출처") && refText.includes("2025-10-01"), refText.slice(-120));

  await page.click('.ed-field-btn[data-idx="3"]'); // 토양(dual standard) 참고표 확인
  await page.waitForTimeout(200);
  const soilRefText = await page.$eval("#ed-ref-wrap", (el) => el.textContent);
  ok("8. 토양 기준표에 우려/대책 표기 안내", soilRefText.includes("우려기준") && soilRefText.includes("대책기준"), soilRefText.slice(0, 200));
  await page.click('.ed-field-btn[data-idx="0"]');
  await page.waitForTimeout(200);

  // 9) 표 글자크기 슬라이더 ↔ 숫자입력 양방향 동기화
  await page.fill("#ed-font-size-num", "130");
  await page.locator("#ed-font-size-num").dispatchEvent("change");
  await page.waitForTimeout(100);
  const rangeVal = await page.$eval("#ed-font-size", (el) => el.value);
  const zoomVal = await page.$eval("#ed-scroll", (el) => el.style.zoom);
  ok("9. 글자크기 숫자입력 → 슬라이더·zoom 동기화", rangeVal === "130" && zoomVal === "130%", `range=${rangeVal} zoom=${zoomVal}`);

  // 데이터 입력 → 차트 카드 생성
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#ed-tbody tr");
    for (let r = 0; r < 3; r++) {
      const cells = rows[r].querySelectorAll(".ed-cell");
      for (let c = 0; c < cells.length; c++) { cells[c].textContent = String(0.0001 + r * 0.00001); cells[c].dispatchEvent(new Event("input", { bubbles: true })); }
    }
  });
  await page.waitForTimeout(500);

  // 10) 그래프 조절바 옆 숫자입력(가로폭)
  const card1 = page.locator(".ed-chart-card").nth(0);
  await card1.locator(".ed-c-width-num").fill("500");
  await card1.locator(".ed-c-width-num").dispatchEvent("change");
  await page.waitForTimeout(150);
  const cardW = await card1.evaluate((el) => el.getBoundingClientRect().width);
  const rangeW = await card1.locator(".ed-c-width").evaluate((el) => el.value);
  ok("10. 그래프 가로폭 숫자입력 → 슬라이더·카드폭 동기화", Math.abs(cardW - 500) < 5 && rangeW === "500", `cardW=${cardW} rangeW=${rangeW}`);

  // 11) Y축 활성/비활성 시 opacity 애니메이션 클래스
  const yMinOpacityOff = await card1.locator(".ed-c-ymin").evaluate((el) => getComputedStyle(el).opacity);
  await card1.locator(".ed-c-ymanual").check();
  await page.waitForTimeout(250); // transition 완료 대기
  const yMinOpacityOn = await card1.locator(".ed-c-ymin").evaluate((el) => getComputedStyle(el).opacity);
  ok("11. Y축 직접설정 체크 시 min입력 opacity 변화(흐림→진함)", parseFloat(yMinOpacityOff) < parseFloat(yMinOpacityOn), `off=${yMinOpacityOff} on=${yMinOpacityOn}`);
  const hasTransition = await card1.locator(".ed-c-ymin").evaluate((el) => getComputedStyle(el).transitionDuration !== "0s");
  ok("12. Y축 입력에 transition(애니메이션) 적용됨", hasTransition);

  // 12) 그래프 카드 배치가 표 아래로, 세로 스택(가로로 나란히 안 붙음)
  const cardCount = await page.$$eval(".ed-chart-card", (els) => els.length);
  if (cardCount >= 2) {
    const card2 = page.locator(".ed-chart-card").nth(1);
    const t1 = await card1.evaluate((el) => el.getBoundingClientRect().top);
    const t2 = await card2.evaluate((el) => el.getBoundingClientRect().top);
    ok("13. 그래프 카드가 세로로 순차 스택(카드2가 카드1보다 아래)", t2 > t1, `t1=${t1} t2=${t2}`);
  }

  // 13) 일괄적용 체크박스 — 카드1 타입을 line으로 바꾼 뒤 체크하면 전체가 line으로
  await card1.locator('[data-type="line"]').click();
  await page.waitForTimeout(150);
  await page.check("#ed-chart-bulk");
  await page.waitForTimeout(200);
  const typesAfterBulk = await page.evaluate(() => {
    const canvases = document.querySelectorAll(".ed-chart-card canvas");
    return [...canvases].map((c) => Chart.getChart(c).config.type);
  });
  ok("14. 일괄적용 체크 → 전체 카드가 1번 카드(line) 설정으로 통일", typesAfterBulk.every((t) => t === "line"), JSON.stringify(typesAfterBulk));
  const follower2Disabled = await page.locator(".ed-chart-card").nth(1).locator(".ed-c-color").isDisabled();
  ok("15. 일괄적용 중 팔로워 카드 컨트롤 비활성화", follower2Disabled);

  // 1번 카드에서 bar로 되돌리면 전체가 다시 bar로(전파 확인)
  await page.locator(".ed-chart-card").nth(0).locator('[data-type="bar"]').click();
  await page.waitForTimeout(200);
  const typesAfterPropagate = await page.evaluate(() => {
    const canvases = document.querySelectorAll(".ed-chart-card canvas");
    return [...canvases].map((c) => Chart.getChart(c).config.type);
  });
  ok("16. 일괄적용 중 1번 카드 변경이 전체에 실시간 전파", typesAfterPropagate.every((t) => t === "bar"), JSON.stringify(typesAfterPropagate));

  await page.uncheck("#ed-chart-bulk");
  await page.waitForTimeout(200);
  const follower2EnabledAfterUncheck = await page.locator(".ed-chart-card").nth(1).locator(".ed-c-color").isDisabled();
  ok("17. 일괄적용 해제 시 팔로워 카드 컨트롤 다시 활성화", !follower2EnabledAfterUncheck);

  ok("18. 콘솔 에러 없음", errors.length === 0, errors.join(" | "));

  await page.screenshot({ path: "/tmp/claude-1000/-mnt-d-claude/c7b738ad-7edf-491d-a806-8ac2192fad80/scratchpad/sys46_screenshot.png", fullPage: true });
  await browser.close();
  console.log("\n=== 결과 ===");
  let fail = 0;
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"} — ${r.name}${r.pass ? "" : "  [" + r.detail + "]"}`);
    if (!r.pass) fail++;
  }
  console.log(`\n총 ${results.length}건 중 실패 ${fail}건`);
  process.exit(fail ? 1 : 0);
})();
