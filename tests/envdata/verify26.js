const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:8791";
const results = [];
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond, detail }); };

// "분석 요약" 기능(SYS-61, 2026-07-22) — 표와 그래프 사이. 단일분석/다중분석-지점슬라이스는
// 항목별 최소~최대+초과, 다중분석-항목슬라이스는 지점무시 전체 통합 + 지점별 세부.
// 목표등급(regionLabel==="목표등급"인 하천/호소만) 범위도 함께 표시.
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1300 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("dialog", (d) => d.accept());

  await page.goto(`${BASE}/index.html#envdata`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ed-table thead th[data-col]");

  // ── 1) 단일분석(소음) — 항목별 요약 + 초과 지점 표기 ──────────────────
  await page.click(".ed-field-btn:has-text('소음')");
  await page.waitForTimeout(300);
  await page.click(".ed-mode-btn[data-mode='single']");
  await page.waitForTimeout(200);
  const rows1 = page.locator("#ed-tbody tr");
  const labels1 = ["A-1", "A-2", "A-3"], vals1 = ["45", "60", "50"];
  for (let i = 0; i < 3; i++) {
    const lbl = rows1.nth(i).locator(".ed-row-label");
    await lbl.click(); await page.keyboard.type(labels1[i]); await lbl.dispatchEvent("input");
    const c = rows1.nth(i).locator("td.ed-cell").nth(0);
    await c.click(); await page.keyboard.type(vals1[i]); await c.dispatchEvent("input");
  }
  await page.waitForTimeout(600);
  const html1 = await page.locator("#ed-summary").innerHTML();
  ok("1. 단일분석 요약 노출 및 항목명·범위 포함(45~60)", html1.includes("45") && html1.includes("60"), html1.slice(0, 200));
  ok("2. 초과 지점(A-2)이 요약에 표기됨", html1.includes("A-2"), html1.slice(0, 200));

  // ── 2) 하천수질 단일분석 — 목표등급 범위 표시 확인 ─────────────────
  await page.click(".ed-field-btn:has-text('하천수질')");
  await page.waitForTimeout(300);
  await page.click(".ed-mode-btn[data-mode='single']");
  await page.waitForTimeout(200);
  const rows2 = page.locator("#ed-tbody tr");
  const grades = ["Ia", "III", "V"];
  for (let i = 0; i < 3; i++) {
    await rows2.nth(i).locator(".ed-region-select").selectOption(grades[i]);
    const c = rows2.nth(i).locator("td.ed-cell").nth(0);
    await c.click(); await page.keyboard.type("7.0"); await c.dispatchEvent("input");
  }
  await page.waitForTimeout(600);
  const html2 = await page.locator("#ed-summary").innerHTML();
  ok("3. 하천수질(목표등급 분야)에서 등급 범위(매우좋음~나쁨) 표시", html2.includes("매우좋음") && html2.includes("나쁨"), html2.slice(0, 300));

  // ── 3) 소음(지역구분 분야이나 '등급' 아님)에는 등급범위 줄이 없어야 함 ──
  ok("4. 소음처럼 목표등급이 아닌 지역구분 분야엔 등급범위 줄이 없음", !html1.includes("목표등급 범위"), html1.slice(0, 200));

  // ── 4) 토양 다중분석 항목슬라이스 — 지점무시 전체 + 지점별 세부 ────────
  await page.click(".ed-field-btn:has-text('토양오염도')");
  await page.waitForTimeout(300);
  await page.click(".ed-mode-btn[data-mode='multi']");
  await page.waitForTimeout(300);
  await page.click("#ed-project-add");
  await page.waitForTimeout(200);
  await page.fill("#ed-np-name", "요약검증");
  await page.fill("#ed-np-sites", "S-1, S-2");
  await page.evaluate(() => { document.querySelectorAll("#ed-np-items input[type=checkbox]").forEach((el) => { if (el.value !== "Cd") el.checked = false; }); });
  await page.click("#ed-np-create");
  await page.waitForTimeout(400);
  await page.click("#ed-round-add");
  await page.waitForTimeout(300);
  const r = page.locator("#ed-tbody tr");
  const c0 = r.nth(0).locator("td.ed-cell").nth(0);
  await c0.click(); await page.keyboard.type("15"); await c0.dispatchEvent("input");
  const c1 = r.nth(1).locator("td.ed-cell").nth(0);
  await c1.click(); await page.keyboard.type("3"); await c1.dispatchEvent("input");
  await page.waitForTimeout(500);
  await page.click("#ed-round-done"); // 회차 저장(완료) — newRound 모양(행=지점,열=항목)은
  await page.waitForTimeout(400);      // 항목슬라이스 판정에서 제외돼야 함(위에서 수정한 버그)
  await page.click(".ed-slice-btn[data-axis='item']"); // 실제 항목슬라이스 뷰(행=회차,열=지점) 진입
  await page.waitForTimeout(400);
  const html3 = await page.locator("#ed-summary").innerHTML();
  ok("5. 항목슬라이스에 '전체(지점 무시)' 통합범위(3~15) 표시", html3.includes("전체(지점 무시)") && html3.includes("3~15"), html3.slice(0, 400));
  ok("6. 항목슬라이스에 지점별 세부(S-1/S-2) 표시", html3.includes("S-1") && html3.includes("S-2"), html3.slice(0, 400));
  ok("7. 초과 지점(S-1, 카드뮴15>우려4)이 전체·지점별 양쪽에 표기", (html3.match(/초과/g) || []).length >= 2, html3.slice(0, 400));
  ok("8. 항목슬라이스 지점별 세부줄은 지점명을 반복하지 않음(회차명만, 2026-07-22 정리)", !html3.includes("초과: S-1 카드뮴") && html3.includes("초과: 1차"), html3.slice(0, 400));

  // ── 5) 단일분석에서 초과 지점이 여럿일 때 항목명이 지점마다 반복되지 않아야 함 ──
  await page.click(".ed-field-btn:has-text('소음')");
  await page.waitForTimeout(300);
  await page.click(".ed-mode-btn[data-mode='single']");
  await page.waitForTimeout(200);
  const rows5 = page.locator("#ed-tbody tr");
  for (let i = 0; i < 3; i++) {
    const lbl = rows5.nth(i).locator(".ed-row-label");
    await lbl.click(); await page.keyboard.type(`X-${i + 1}`); await lbl.dispatchEvent("input");
    const c = rows5.nth(i).locator("td.ed-cell").nth(0);
    await c.click(); await page.keyboard.type(String(70 + i * 10)); await c.dispatchEvent("input");
  }
  await page.waitForTimeout(600);
  const html5 = await page.locator("#ed-summary").innerHTML();
  ok("9. 다수 초과 시 항목명 반복 없이 지점명만 나열(X-1, X-2, X-3)", html5.includes("초과: X-1, X-2, X-3") && !html5.includes("X-1 낮"), html5.slice(0, 300));

  ok("10. 콘솔 에러 없음", errors.length === 0, errors.join(" | "));

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
