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

  // ── 소음: 단일분석, 지점별 관련기준 선택 ──────────────────────────────
  await page.click('.ed-field-btn:has-text("소음")');
  await page.waitForTimeout(200);

  // 헤더에 "관련기준" 열이 있는지
  const headers = await page.$$eval("#ed-thead-row th", (els) => els.map((e) => e.textContent.trim()));
  ok("1. 소음 표 헤더에 '관련기준' 열 존재", headers.includes("관련기준"), JSON.stringify(headers));

  // 1행의 관련기준을 "환경기준"(기본)에서 값 확인 — 낮 기준값 60(일반지역"나" 기본이 아니라 첫 옵션이므로 실제 확인)
  const firstRowStdSel = page.locator("#ed-tbody tr").first().locator(".ed-standard-select");
  const initialStdVal = await firstRowStdSel.inputValue();
  ok("2. 1행 관련기준 기본값이 main(환경기준)", initialStdVal === "main", initialStdVal);

  // 관련기준을 "축사"로 변경 → 지역구분 select가 비활성화되는지 + 기준값이 60(dB(A))인지
  await firstRowStdSel.selectOption("livestock");
  await page.waitForTimeout(100);
  const regionSelAfterLivestock = page.locator("#ed-tbody tr").first().locator(".ed-region-select");
  const isDisabled = await regionSelAfterLivestock.isDisabled();
  ok("3. 관련기준=축사 선택 시 지역구분 select 비활성화", isDisabled);
  const firstRowStdInput = await page.$eval("#ed-tbody tr:first-child td.ed-cell", (el) => el.title);
  ok("4. 축사 선택 시 툴팁에 기준 60dB(A) 반영", firstRowStdInput.includes("60"), firstRowStdInput);

  // 관련기준을 "도로"로 변경 → 지역구분 select가 가/나 2개로 바뀌는지
  await firstRowStdSel.selectOption("road");
  await page.waitForTimeout(100);
  const roadRegionOpts = await page.locator("#ed-tbody tr").first().locator(".ed-region-select option").allTextContents();
  ok("5. 관련기준=도로 선택 시 지역구분이 가/나 2개(regionLegend 기반)", roadRegionOpts.length === 2, JSON.stringify(roadRegionOpts));
  const roadTip = await page.$eval("#ed-tbody tr:first-child td.ed-cell", (el) => el.title);
  ok("6. 도로 선택 시 낮 기준 68dB(A)(가지역 기본) 반영", roadTip.includes("68"), roadTip);

  // 관련기준을 "생활소음"으로 변경 → 소음원 select 등장
  await firstRowStdSel.selectOption("living");
  await page.waitForTimeout(100);
  const noiseSrcVisible = await page.locator("#ed-tbody tr").first().locator(".ed-noisesource-select").isVisible();
  ok("7. 관련기준=생활소음 선택 시 소음원 select 노출", noiseSrcVisible);
  const livingTip1 = await page.$eval("#ed-tbody tr:first-child td.ed-cell", (el) => el.title);
  ok("8. 생활소음 기본 소음원(확성기-옥외설치)·가지역 낮 기준 65dB 반영", livingTip1.includes("65"), livingTip1);

  // 소음원을 "공사장"으로 변경 — 원문(별표8) 가지역 공사장: 아침저녁60/주간65/야간50,
  // 열은 주간→낮(day)이므로 65가 맞다(확성기-옥외설치도 65라 값이 같아 보이지만 이는
  // 원문상 우연의 일치 — 소음원이 실제로 바뀌었는지는 야간 값 60→50 변화로 재확인).
  const srcSel = page.locator("#ed-tbody tr").first().locator(".ed-noisesource-select");
  await srcSel.selectOption("공사장::—");
  await page.waitForTimeout(100);
  const livingTip2Night = await page.$$eval("#ed-tbody tr:first-child td.ed-cell", (els) => els[1].title);
  ok("9. 소음원=공사장 변경 시 가지역 야간 기준 50dB로 변경(확성기-옥외설치의 60과 구분)", livingTip2Night.includes("50"), livingTip2Night);

  // 관련기준을 "철도"로 변경
  await firstRowStdSel.selectOption("rail");
  await page.waitForTimeout(100);
  const railTip = await page.$eval("#ed-tbody tr:first-child td.ed-cell", (el) => el.title);
  ok("10. 철도 선택 시 가지역 낮 기준 70dB 반영", railTip.includes("70"), railTip);

  // 환경기준으로 되돌리면 지역구분이 다시 가~라(7개) 옵션으로
  await firstRowStdSel.selectOption("main");
  await page.waitForTimeout(100);
  const mainRegionOpts = await page.locator("#ed-tbody tr").first().locator(".ed-region-select option").allTextContents();
  ok("11. main으로 복귀 시 지역구분 7개 옵션(가~라·도로변)으로 복귀", mainRegionOpts.length === 7, JSON.stringify(mainRegionOpts));

  // ── 진동: 생활소음 옵션이 없어야 함 ──────────────────────────────────
  await page.click('.ed-field-btn:has-text("진동")');
  await page.waitForTimeout(200);
  const vibStdOpts = await page.locator("#ed-tbody tr").first().locator(".ed-standard-select option").allTextContents();
  ok("12. 진동 관련기준 목록은 4개(생활진동규제기준/도로/철도/축사), 생활소음 없음", vibStdOpts.length === 4 && !vibStdOpts.includes("생활소음"), JSON.stringify(vibStdOpts));

  // ── 토양: 우려/대책기준 토글 ─────────────────────────────────────────
  await page.click('.ed-field-btn:has-text("토양")');
  await page.waitForTimeout(200);
  const soilToggleVisible = await page.locator("#ed-soil-mode").isVisible();
  ok("13. 토양 필드에서 우려/대책기준 토글 노출", soilToggleVisible);
  // 카드뮴 1지역: 우려=4, 대책=12
  const cell00 = "#ed-tbody tr:first-child td.ed-cell";
  const concernTip = await page.$eval(cell00, (el) => el.title);
  ok("14. 우려기준 모드일 때 카드뮴 1지역 기준 4 표시", concernTip.includes("4"), concernTip);
  await page.click('.ed-soil-mode-btn[data-mode="action"]');
  await page.waitForTimeout(100);
  const actionTip = await page.$eval(cell00, (el) => el.title);
  ok("15. 대책기준 모드로 전환 시 카드뮴 1지역 기준 12로 변경", actionTip.includes("12"), actionTip);

  // ── 소음이 아닌 다른 필드(대기)에는 관련기준 열이 없어야 함 ──────────
  await page.click('.ed-field-btn:has-text("대기질")');
  await page.waitForTimeout(200);
  const airHeaders = await page.$$eval("#ed-thead-row th", (els) => els.map((e) => e.textContent.trim()));
  ok("16. 대기질에는 관련기준 열 없음(소음·진동 전용)", !airHeaders.includes("관련기준"), JSON.stringify(airHeaders));

  ok("17. 콘솔 에러 없음", errors.length === 0, errors.join(" | "));

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
