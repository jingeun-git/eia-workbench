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

  await page.goto(`${BASE}/index.html#envdata`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ed-table thead th[data-col]");
  await page.waitForTimeout(300);

  // 1) 기본 로드 = 대기질, 8항목
  const airHeaders = await page.$$eval("#ed-table thead th[data-col] .ed-col-label", (els) => els.map((e) => e.textContent.trim()));
  ok("1. 기본 로드 = 대기질 8항목", airHeaders.length === 8, JSON.stringify(airHeaders));

  // 2) 소음으로 전환
  await page.click('.ed-field-btn[data-idx="1"]');
  await page.waitForTimeout(300);
  const noiseHeaders = await page.$$eval("#ed-table thead th[data-col] .ed-col-label", (els) => els.map((e) => e.textContent.trim()));
  ok("2. 소음 전환 시 낮/밤 2컬럼", noiseHeaders.length === 2 && noiseHeaders.some((h) => h.includes("낮")), JSON.stringify(noiseHeaders));

  // 3) 지역구분 셀렉트 존재
  const regionSelectCount = await page.$$eval(".ed-region-select", (els) => els.length);
  ok("3. 지역구분 선택 UI 등장(행마다)", regionSelectCount === 3, `count=${regionSelectCount}`);

  // 4) 지역구분(일반지역 가: 낮50/밤40) 선택 + 판정
  await page.evaluate(() => {
    const sel = document.querySelectorAll(".ed-region-select")[0];
    sel.value = "gen_ga";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const row = document.querySelectorAll("#ed-tbody tr")[0];
    const cells = row.querySelectorAll(".ed-cell");
    cells[0].textContent = "45"; cells[0].dispatchEvent(new Event("input", { bubbles: true })); // 낮 45 < 50 → ok
    cells[1].textContent = "45"; cells[1].dispatchEvent(new Event("input", { bubbles: true })); // 밤 45 > 40 → exceed
  });
  await page.waitForTimeout(100);
  const classes = await page.evaluate(() => {
    const row = document.querySelectorAll("#ed-tbody tr")[0];
    return [...row.querySelectorAll(".ed-cell")].map((c) => c.className);
  });
  ok("4. 낮 45(기준50) → ed-ok", classes[0].includes("ed-ok"), classes[0]);
  ok("5. 밤 45(기준40) → ed-exceed", classes[1].includes("ed-exceed"), classes[1]);

  // 5) 진동으로 전환
  await page.click('.ed-field-btn[data-idx="2"]');
  await page.waitForTimeout(300);
  const vibHeaders = await page.$$eval("#ed-table thead th[data-col] .ed-col-label", (els) => els.map((e) => e.textContent.trim()));
  const vibRegions = await page.$$eval(".ed-region-select option", (els) => [...new Set(els.map((e) => e.textContent))]);
  ok("6. 진동 전환 시 주간/심야 2컬럼", vibHeaders.length === 2, JSON.stringify(vibHeaders));
  ok("7. 진동 지역구분 2종", vibRegions.length === 2, JSON.stringify(vibRegions));

  // 6. 대기질로 복귀 — 상태 초기화 확인
  await page.click('.ed-field-btn[data-idx="0"]');
  await page.waitForTimeout(300);
  const backHeaders = await page.$$eval("#ed-table thead th[data-col] .ed-col-label", (els) => els.map((e) => e.textContent.trim()));
  const stdBack = await page.$$eval("#ed-table thead th[data-col] .ed-std-input", (els) => els.map((e) => e.value));
  ok("8. 대기질 복귀 시 8항목·기준값 정상", backHeaders.length === 8 && stdBack.every((v) => v !== ""), JSON.stringify(stdBack));

  // 7) 헤더-바디 정합(region 모드 포함 회귀 방지) — 소음 모드에서 재확인
  await page.click('.ed-field-btn[data-idx="1"]');
  await page.waitForTimeout(200);
  const theadN = await page.$$eval("#ed-thead-row th", (els) => els.length);
  const tbodyN = await page.$$eval("#ed-tbody tr:first-child td", (els) => els.length);
  ok("9. 소음 모드 헤더·바디 컬럼 수 일치", theadN === tbodyN, `thead=${theadN} tbody=${tbodyN}`);

  ok("10. 콘솔 에러 없음", errors.length === 0, errors.join(" | "));

  await page.screenshot({ path: "/tmp/claude-1000/-mnt-d-claude/c7b738ad-7edf-491d-a806-8ac2192fad80/scratchpad/noise_screenshot.png", fullPage: true });

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
