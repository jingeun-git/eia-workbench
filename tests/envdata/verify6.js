const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:8791";
const results = [];
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond, detail }); };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  await page.goto(`${BASE}/index.html#envdata`, { waitUntil: "domcontentloaded", timeout: 10000 });
  await page.waitForSelector("#ed-table thead th[data-col]", { timeout: 10000 });
  console.log("loaded ok");

  // 사람건강보호기준 드롭다운 삭제(SYS-45) 이후 7개: 대기·소음·진동·토양·하천생활·호소생활·지하수
  const fieldCount = await page.$$eval(".ed-field-btn", (els) => els.length);
  ok("0. 분야 드롭다운 7개(건강보호기준 제외, 지하수질 포함)", fieldCount === 7, `count=${fieldCount}`);

  // ── 토양(index 3) ──────────────────────────────────────────────
  await page.click('.ed-field-btn[data-idx="3"]');
  await page.waitForTimeout(250);
  const soilAddVisible = await page.evaluate(() => getComputedStyle(document.querySelector("#ed-add-item").parentElement).display !== "none");
  ok("1. 토양 모드에서 '+ 항목 추가' 보임(columnsFixed:false)", soilAddVisible);

  // 토양은 대기질처럼 기본값으로 전 항목(23종)이 이미 채워져 있다(항목 추가는 삭제 후 재추가용)
  const soilCols = await page.$$eval("#ed-table thead th[data-col] .ed-col-label", (els) => els.map((e) => e.textContent.trim()));
  ok("2. 토양 기본 23항목 로드(카드뮴 포함)", soilCols.length === 23 && soilCols.some((c) => c.includes("카드뮴")), `count=${soilCols.length}`);

  // 1지역 선택 후 값 5(기준4) → exceed, 3지역 선택 시 같은 값이 ok(기준60)
  await page.evaluate(() => {
    const sel = document.querySelector(".ed-region-select");
    sel.value = "r1"; sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const cell = document.querySelector("#ed-tbody tr .ed-cell[data-col]");
    cell.textContent = "5"; cell.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(100);
  const cls1 = await page.evaluate(() => document.querySelector("#ed-tbody tr .ed-cell[data-col]").className);
  ok("3. 토양 1지역 카드뮴5(기준4) → exceed", cls1.includes("ed-exceed"), cls1);

  await page.evaluate(() => {
    const sel = document.querySelector(".ed-region-select");
    sel.value = "r3"; sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(100);
  const cls2 = await page.evaluate(() => document.querySelector("#ed-tbody tr .ed-cell[data-col]").className);
  ok("4. 같은값 3지역(기준60) → ok (지역 바뀌면 판정도 바뀜)", cls2.includes("ed-ok"), cls2);

  // 사람건강보호기준은 이제 드롭다운 항목이 아니라 배너로만 안내된다(SYS-45) — 별도 검증 없음

  // ── 하천 생활환경기준(index 4, region+columnsFixed:true, range/min) ──
  await page.click('.ed-field-btn[data-idx="4"]');
  await page.waitForTimeout(250);
  const riverLifeCols = await page.$$eval("#ed-table thead th[data-col] .ed-col-label", (els) => els.map((e) => e.textContent.trim()));
  ok("6. 하천생활환경 9항목(pH~분원성)", riverLifeCols.length === 9 && riverLifeCols[0].includes("pH"), JSON.stringify(riverLifeCols));

  // Ia등급 선택 후: pH 9(범위6.5~8.5 초과)→exceed, DO 5(기준7.5이상, min방향)→exceed, BOD 0.5(기준1이하)→ok
  await page.evaluate(() => {
    const sel = document.querySelector(".ed-region-select");
    sel.value = "Ia"; sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const cells = document.querySelectorAll("#ed-tbody tr")[0].querySelectorAll(".ed-cell");
    cells[0].textContent = "9"; cells[0].dispatchEvent(new Event("input", { bubbles: true }));   // pH
    cells[1].textContent = "0.5"; cells[1].dispatchEvent(new Event("input", { bubbles: true })); // BOD
    cells[5].textContent = "5"; cells[5].dispatchEvent(new Event("input", { bubbles: true }));   // DO(6번째 컬럼, idx5)
  });
  await page.waitForTimeout(100);
  const lifeClasses = await page.evaluate(() => [...document.querySelectorAll("#ed-tbody tr")[0].querySelectorAll(".ed-cell")].map((c) => c.className));
  ok("7. pH 9(범위6.5~8.5 벗어남) → exceed", lifeClasses[0].includes("ed-exceed"), lifeClasses[0]);
  ok("8. BOD 0.5(기준1 이하) → ok", lifeClasses[1].includes("ed-ok"), lifeClasses[1]);
  ok("9. DO 5(기준7.5 이상, min방향) → exceed", lifeClasses[5].includes("ed-exceed"), lifeClasses[5]);

  // ── 호소 생활환경기준(index 5) — 10항목 확인 ──────────────────────
  await page.click('.ed-field-btn[data-idx="5"]');
  await page.waitForTimeout(250);
  const lakeLifeCols = await page.$$eval("#ed-table thead th[data-col] .ed-col-label", (els) => els.length);
  ok("10. 호소생활환경 10항목(TN·Chl-a 포함)", lakeLifeCols === 10, `count=${lakeLifeCols}`);

  // ── 대기질(index 0) 복귀 회귀 ──────────────────────────────────
  await page.click('.ed-field-btn[data-idx="0"]');
  await page.waitForTimeout(250);
  const airCols = await page.$$eval("#ed-table thead th[data-col] .ed-col-label", (els) => els.length);
  const airStd = await page.$$eval("#ed-table thead th[data-col] .ed-std-input", (els) => els.map((e) => e.value));
  ok("11. 대기질 복귀 8항목·기준값 정상", airCols === 8 && airStd.every((v) => v !== ""), JSON.stringify(airStd));

  ok("12. 콘솔 에러 없음", errors.length === 0, errors.join(" | "));

  await page.screenshot({ path: "/tmp/claude-1000/-mnt-d-claude/c7b738ad-7edf-491d-a806-8ac2192fad80/scratchpad/soil_water_screenshot.png" });
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
