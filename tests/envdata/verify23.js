const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:8791";
const results = [];
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond, detail }); };

// 사용자 강조사항(2026-07-22): 관련기준은 "조사지점"별로 적용되어야 하며, 항목별·조사시기(회차)별
// 로 적용되면 안 된다. 다중분석에서 지점은 site-slice(행=회차)일 때는 ROW로, item-slice
// (행=회차, 열=지점)일 때는 COLUMN으로 나타나므로 두 경로 모두 지점 단위 일관성을 검증한다.
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1400 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  await page.goto(`${BASE}/index.html#envdata`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ed-table thead th[data-col]");
  await page.click('.ed-field-btn:has-text("소음")');
  await page.waitForTimeout(200);
  await page.click('.ed-mode-btn[data-mode="multi"]');
  await page.click("#ed-project-add");
  await page.fill("#ed-np-name", "표준테스트");
  await page.fill("#ed-np-sites", "A-1, A-2, A-3");
  await page.click("#ed-np-create");
  await page.waitForTimeout(300);

  // 1) 새 회차 추가 화면 — 지점(행)마다 관련기준을 다르게 설정
  await page.click("#ed-round-add");
  await page.waitForTimeout(200);
  const newRoundRows = page.locator("#ed-tbody tr");
  await newRoundRows.nth(0).locator(".ed-standard-select").selectOption("road"); // A-1 = 도로
  await page.waitForTimeout(500);
  await newRoundRows.nth(1).locator(".ed-standard-select").selectOption("livestock"); // A-2 = 축사
  await page.waitForTimeout(500);
  // A-3은 main 유지
  await page.fill("#ed-round-label", "1차");
  await page.click("#ed-round-done");
  await page.waitForTimeout(300);

  // 2) 지점슬라이스(A-1)로 들어가서 관련기준이 "도로"로 유지되는지 확인
  await page.click('.ed-slice-btn[data-axis="site"][data-key]'); // 첫 지점 버튼
  await page.waitForTimeout(200);
  const siteSliceTitle = await page.$eval(".ed-slice-banner, #ed-title", (el) => el.textContent || "");
  const a1StdVal = await page.locator("#ed-tbody tr").first().locator(".ed-standard-select").inputValue();
  ok("1. 지점슬라이스 진입 시 그 지점(첫 지점=A-1)의 관련기준이 저장한 대로 유지(road)", a1StdVal === "road", `val=${a1StdVal}`);

  // 3) 항목슬라이스(NO2든 뭐든 소음은 항목축이 없다 — columnsFixed라 showItemAxis=false).
  //    소음·진동은 항목슬라이스 자체가 없으므로, 대신 "새 회차" 화면에 다시 들어가서
  //    A-1행이 여전히 road, A-2행이 여전히 livestock으로 남아있는지(항목/열 구조와
  //    무관하게 지점 값이 유지되는지) 재확인한다.
  await page.click('.ed-slice-btn[data-axis="site"][aria-pressed="true"]'); // 슬라이스 나가기(토글)
  await page.waitForTimeout(200);
  await page.click("#ed-round-add");
  await page.waitForTimeout(200);
  const rows2 = page.locator("#ed-tbody tr");
  const a1Again = await rows2.nth(0).locator(".ed-standard-select").inputValue();
  const a2Again = await rows2.nth(1).locator(".ed-standard-select").inputValue();
  const a3Again = await rows2.nth(2).locator(".ed-standard-select").inputValue();
  ok("2. 새 회차 재진입 시 A-1=road 유지(지점 속성 — 회차마다 리셋 안 됨)", a1Again === "road", a1Again);
  ok("3. 새 회차 재진입 시 A-2=livestock 유지", a2Again === "livestock", a2Again);
  ok("4. A-3(설정 안 한 지점)은 main 그대로", a3Again === "main", a3Again);
  await page.click("#ed-round-delete");
  await page.waitForTimeout(200);

  // 4) 새로고침 후에도(localStorage 영속) 지점별 관련기준이 유지되는지
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ed-table thead th[data-col]");
  await page.click('.ed-field-btn:has-text("소음")');
  await page.waitForTimeout(200);
  await page.click('.ed-mode-btn[data-mode="multi"]');
  await page.waitForTimeout(200);
  await page.click('.ed-project-btn:has-text("표준테스트")');
  await page.waitForTimeout(200);
  await page.click("#ed-round-add");
  await page.waitForTimeout(200);
  const rows3 = page.locator("#ed-tbody tr");
  const a1Persist = await rows3.nth(0).locator(".ed-standard-select").inputValue();
  ok("5. 새로고침 후에도 A-1 관련기준(road) 영속", a1Persist === "road", a1Persist);

  ok("6. 콘솔 에러 없음", errors.length === 0, errors.join(" | "));

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
