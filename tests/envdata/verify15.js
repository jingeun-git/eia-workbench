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
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("eiaw.envdata.projects.")) localStorage.removeItem(k); });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ed-table thead th[data-col]");

  // ── 1) 소음(columnsFixed:true) — 항목슬라이스 버튼이 없어야 한다(고정컬럼이라 축이 없음) ──
  await page.click('.ed-field-btn[data-idx="1"]');
  await page.waitForTimeout(150);
  await page.click('.ed-mode-btn[data-mode="multi"]');
  await page.waitForTimeout(150);
  await page.click("#ed-project-add");
  await page.waitForTimeout(100);
  const itemsFieldVisible = await page.$eval("#ed-np-items-field", (el) => getComputedStyle(el).display !== "none");
  ok("1. 소음(고정컬럼) 프로젝트 생성폼엔 항목선택 없음", !itemsFieldVisible);
  await page.fill("#ed-np-name", "소음 다중분석");
  await page.fill("#ed-np-sites", "지점1, 지점2");
  await page.click("#ed-np-create");
  await page.waitForTimeout(200);
  const noiseItemBtns = await page.$$eval('.ed-slice-btn[data-axis="item"]', (els) => els.length);
  const noiseSiteBtns = await page.$$eval('.ed-slice-btn[data-axis="site"]', (els) => els.length);
  ok("2. 소음 다중분석: 항목축 버튼 0개, 지점축 버튼 2개", noiseItemBtns === 0 && noiseSiteBtns === 2, `item=${noiseItemBtns} site=${noiseSiteBtns}`);

  await page.click("#ed-round-add");
  await page.waitForTimeout(200);
  const noiseNewCols = await page.$$eval("#ed-table thead th[data-col]", (els) => els.length);
  ok("3. 소음 새회차 입력폼 열=2(낮/밤 고정컬럼)", noiseNewCols === 2, `cols=${noiseNewCols}`);
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#ed-tbody tr");
    const sel1 = rows[0].querySelector(".ed-region-select"); if (sel1) sel1.value = "gen_na", sel1.dispatchEvent(new Event("change", { bubbles: true }));
    const vals = [[55, 42], [60, 48]]; // 지점1: 낮55/밤42(밤 기준45 초과), 지점2: 낮60/밤48
    rows.forEach((tr, r) => {
      [...tr.querySelectorAll(".ed-cell")].forEach((cell, c) => {
        cell.textContent = String(vals[r][c]);
        cell.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });
  });
  await page.fill("#ed-round-label", "1차");
  await page.locator("#ed-round-label").dispatchEvent("change");
  await page.waitForTimeout(500);
  await page.click("#ed-round-done");
  await page.waitForTimeout(150);

  await page.click('.ed-slice-btn[data-axis="site"]');
  await page.waitForTimeout(200);
  const noiseSliceVal = await page.$$eval("#ed-tbody tr", (trs) => [...trs[0].querySelectorAll(".ed-cell")].map((c) => c.textContent.trim()));
  ok("4. 소음 지점슬라이스: 저장한 낮/밤 값 정확", JSON.stringify(noiseSliceVal) === JSON.stringify(["55", "42"]), JSON.stringify(noiseSliceVal));
  const noiseSliceClass = await page.$$eval("#ed-tbody tr", (trs) => [...trs[0].querySelectorAll(".ed-cell")].map((c) => c.className));
  ok("5. 소음 지점슬라이스: 지역구분(gen_na, 밤45) 판정 정상 반영(밤42=ok)", noiseSliceClass[1].includes("ed-ok"), JSON.stringify(noiseSliceClass));

  // ── 2) 토양(region+flexible, dualStandard) — 항목슬라이스에서 col.fixedRegion으로 판정 ──
  await page.click('.ed-field-btn[data-idx="3"]');
  await page.waitForTimeout(150);
  await page.click('.ed-mode-btn[data-mode="multi"]');
  await page.waitForTimeout(150);
  await page.click("#ed-project-add");
  await page.waitForTimeout(100);
  await page.fill("#ed-np-name", "토양 다중분석");
  await page.fill("#ed-np-sites", "S-1, S-2");
  // 카드뮴만 남기고 나머지 항목 체크 해제(간단화)
  await page.evaluate(() => {
    document.querySelectorAll("#ed-np-items input[type=checkbox]").forEach((el) => { if (el.value !== "Cd") el.checked = false; });
  });
  await page.click("#ed-np-create");
  await page.waitForTimeout(200);
  const soilItemBtns = await page.$$eval('.ed-slice-btn[data-axis="item"]', (els) => els.length);
  ok("6. 토양(가변컬럼)은 항목슬라이스 버튼도 있음(카드뮴 1개)", soilItemBtns === 1, `count=${soilItemBtns}`);

  await page.click("#ed-round-add");
  await page.waitForTimeout(200);
  // S-1은 r1지역(우려4/대책12), S-2는 r3지역(우려60/대책180)으로 설정 — 같은 가치(15)가 지역에 따라 다르게 판정되어야 함
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#ed-tbody tr");
    rows[0].querySelector(".ed-region-select").value = "r1"; rows[0].querySelector(".ed-region-select").dispatchEvent(new Event("change", { bubbles: true }));
    rows[1].querySelector(".ed-region-select").value = "r3"; rows[1].querySelector(".ed-region-select").dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#ed-tbody tr");
    rows.forEach((tr) => { const cell = tr.querySelector(".ed-cell"); cell.textContent = "15"; cell.dispatchEvent(new Event("input", { bubbles: true })); });
  });
  await page.fill("#ed-round-label", "1차");
  await page.locator("#ed-round-label").dispatchEvent("change");
  await page.waitForTimeout(500);
  await page.click("#ed-round-done");
  await page.waitForTimeout(150);

  // 항목 슬라이스(카드뮴) — 열=지점(S-1,S-2), S-1은 r1지역이라 15가 대책초과(exceed2), S-2는 r3지역이라 15가 정상(ok)
  // 우려/대책 상시 동시판정은 폐지되고 표 상단 토글로 바뀌었으므로(2026-07-22)
  // 대책기준 모드로 전환해야 이 시나리오(대책기준 초과 여부)를 확인할 수 있다.
  await page.click('.ed-slice-btn[data-axis="item"]');
  await page.waitForTimeout(200);
  await page.click('.ed-soil-mode-btn[data-mode="action"]');
  await page.waitForTimeout(150);
  const soilItemSliceClass = await page.$$eval("#ed-tbody tr", (trs) => [...trs[0].querySelectorAll(".ed-cell")].map((c) => c.className));
  ok("7. 항목슬라이스: 같은 값(15)이 지점별 지역에 따라 다르게 판정(S-1=exceed2, S-2=ok) — col.fixedRegion 검증",
    soilItemSliceClass[0].includes("ed-exceed2") && soilItemSliceClass[1].includes("ed-ok"), JSON.stringify(soilItemSliceClass));

  // ── 3) 엑셀 내보내기 — 실제 파일 다운로드 + 데이터 정확성 ──
  await page.click('.ed-mode-btn[data-mode="single"]');
  await page.click('.ed-field-btn[data-idx="0"]');
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#ed-tbody tr");
    rows[0].querySelectorAll(".ed-cell")[0].textContent = "0.03";
    rows[0].querySelectorAll(".ed-cell")[0].dispatchEvent(new Event("input", { bubbles: true }));
  });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#ed-export-xlsx"),
  ]);
  const xlsxPath = await download.path();
  const fs = require("fs");
  ok("8. 엑셀 파일이 실제로 생성됨(0바이트 아님)", fs.existsSync(xlsxPath) && fs.statSync(xlsxPath).size > 0, xlsxPath);
  const cellValue = await page.evaluate(async (base64) => {
    const buf = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1 });
    return aoa[1]; // 첫 데이터 행
  }, fs.readFileSync(xlsxPath).toString("base64"));
  ok("9. 엑셀 내보낸 데이터가 표 값과 일치(0.03 포함)", cellValue.includes(0.03), JSON.stringify(cellValue));

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
