const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:8791";
const results = [];
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond, detail }); };

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 1500, height: 1100 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  await page.goto(`${BASE}/index.html#envdata`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ed-table thead th[data-col]");

  const fieldCount = await page.$$eval(".ed-field-btn", (els) => els.length);
  ok("0. 분야 드롭다운 7개(건강보호기준 제외, 지하수질 포함)", fieldCount === 7, `count=${fieldCount}`);

  // ── 지하수질(index 6) ──────────────────────────────────────────
  await page.click('.ed-field-btn[data-idx="6"]');
  await page.waitForTimeout(250);
  const gwCols = await page.$$eval("#ed-table thead th[data-col] .ed-col-label", (els) => els.length);
  ok("1. 지하수질 44항목 로드", gwCols === 44, `count=${gwCols}`);
  await page.evaluate(() => {
    const cell = document.querySelector("#ed-tbody tr .ed-cell[data-col]");
    cell.textContent = "0.02"; cell.dispatchEvent(new Event("input", { bubbles: true })); // 첫 항목=일반세균? 값체크는 생략, 렌더만 확인
  });

  // ── 토양 이중기준(우려/대책) ──────────────────────────────────────
  await page.click('.ed-field-btn[data-idx="3"]');
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const sel = document.querySelector(".ed-region-select");
    sel.value = "r1"; sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(100);
  // 카드뮴(우려4, 대책12) — 우려/대책 상시 동시판정은 2026-07-22 사용자 지시로 폐지되고
  // 표 상단 토글(우려기준/대책기준 중 하나만 판정)로 대체됐다. 값 8: 우려모드=exceed(4<8),
  // 대책모드=ok(8<12). 값 15: 우려모드=exceed, 대책모드=exceed2(12<15, 대책기준 초과는
  // 더 심각한 2단계로 표시).
  await page.evaluate(() => {
    const cell = document.querySelector("#ed-tbody tr .ed-cell[data-col]");
    cell.textContent = "8"; cell.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(100);
  const cls8concern = await page.evaluate(() => document.querySelector("#ed-tbody tr .ed-cell[data-col]").className);
  ok("2. 우려기준 모드에서 카드뮴8(우려4 초과) → ed-exceed(1단계)", cls8concern.includes("ed-exceed") && !cls8concern.includes("ed-exceed2"), cls8concern);

  await page.click('.ed-soil-mode-btn[data-mode="action"]');
  await page.waitForTimeout(100);
  const cls8action = await page.evaluate(() => document.querySelector("#ed-tbody tr .ed-cell[data-col]").className);
  ok("3. 대책기준 모드로 전환 시 같은 값 8이 정상(8<대책12)", cls8action.includes("ed-ok"), cls8action);

  await page.evaluate(() => {
    const cell = document.querySelector("#ed-tbody tr .ed-cell[data-col]");
    cell.textContent = "15"; cell.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(100);
  const cls15action = await page.evaluate(() => document.querySelector("#ed-tbody tr .ed-cell[data-col]").className);
  ok("4. 대책기준 모드에서 카드뮴15(대책12 초과) → ed-exceed2(2단계)", cls15action.includes("ed-exceed2"), cls15action);
  await page.click('.ed-soil-mode-btn[data-mode="concern"]'); // 이후 테스트에 영향 없도록 원복
  await page.waitForTimeout(100);

  // ── 행/열 전환 (대기질에서 테스트) ──────────────────────────────────
  await page.click('.ed-field-btn[data-idx="0"]');
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const cell = document.querySelectorAll("#ed-tbody tr")[0].querySelectorAll(".ed-cell")[0];
    cell.textContent = "0.09"; cell.dispatchEvent(new Event("input", { bubbles: true })); // SO2 exceed
  });
  await page.click("#ed-transpose");
  await page.waitForTimeout(200);
  const theadAfterT = await page.$$eval("#ed-thead-row th[data-row]", (els) => els.length);
  const tbodyRowsAfterT = await page.$$eval("#ed-tbody tr", (els) => els.length);
  ok("5. 전환 후 헤더에 지점수만큼 th(3개)", theadAfterT === 3, `count=${theadAfterT}`);
  ok("6. 전환 후 tbody 행수 = 항목수(8개)", tbodyRowsAfterT === 8, `count=${tbodyRowsAfterT}`);
  const firstRowLabel = await page.evaluate(() => document.querySelector("#ed-tbody tr .ed-row-label .ed-col-label")?.textContent.trim());
  ok("7. 전환 후 첫 행이 SO2 항목 라벨", firstRowLabel && firstRowLabel.includes("SO₂"), firstRowLabel);
  const transposedCellClass = await page.evaluate(() => document.querySelector("#ed-tbody tr .ed-cell[data-col]").className);
  ok("8. 전환 후에도 판정 유지(SO2 0.09 exceed)", transposedCellClass.includes("ed-exceed"), transposedCellClass);

  // 전환 상태에서 항목 드래그(행 순서 변경) — 실제 마우스
  const labelsBefore = await page.$$eval("#ed-tbody tr .ed-row-label .ed-col-label", (els) => els.map((e) => e.textContent.trim()));
  const row0 = page.locator("#ed-tbody tr").nth(0).locator(".ed-col-grip");
  const row1Box = await page.locator("#ed-tbody tr").nth(1).boundingBox();
  const row0Box = await row0.boundingBox();
  await page.mouse.move(row0Box.x + 3, row0Box.y + 3);
  await page.mouse.down();
  await page.mouse.move(row1Box.x + 3, row1Box.y + 3, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const labelsAfter = await page.$$eval("#ed-tbody tr .ed-row-label .ed-col-label", (els) => els.map((e) => e.textContent.trim()));
  ok("9. 전환모드에서도 항목(행) 드래그 재정렬 동작", labelsAfter[0] !== labelsBefore[0], `before=${labelsBefore[0]} after=${labelsAfter[0]}`);

  // 실제 Ctrl+V 붙여넣기 (전환모드) — 지점1열에 값 하나 붙여넣기
  await page.evaluate(async () => { await navigator.clipboard.writeText("0.5"); });
  await page.locator("#ed-tbody tr").nth(0).locator(".ed-cell[data-col]").first().click();
  await page.keyboard.press("Control+V");
  await page.waitForTimeout(150);
  const pastedVal = await page.evaluate(() => document.querySelector("#ed-tbody tr .ed-cell[data-col]").textContent);
  ok("10. 전환모드에서 Ctrl+V 붙여넣기 동작", pastedVal.trim() === "0.5", pastedVal);

  // 다시 전환(원복) 확인
  await page.click("#ed-transpose");
  await page.waitForTimeout(200);
  const backCols = await page.$$eval("#ed-table thead th[data-col] .ed-col-label", (els) => els.length);
  ok("11. 재전환(원복) 시 8항목 컬럼 정상", backCols === 8, `count=${backCols}`);

  ok("12. 콘솔 에러 없음", errors.length === 0, errors.join(" | "));

  await page.screenshot({ path: "/tmp/claude-1000/-mnt-d-claude/c7b738ad-7edf-491d-a806-8ac2192fad80/scratchpad/soil_dual_screenshot.png" });
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
