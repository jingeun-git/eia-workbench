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
  // 이전 세션의 localStorage 잔재 제거(테스트 격리)
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("eiaw.envdata.projects.")) localStorage.removeItem(k); });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ed-table thead th[data-col]");

  // 1) 모드 배너 존재 + 단일분석 기본
  const modeCount = await page.$$eval(".ed-mode-btn", (els) => els.length);
  ok("1. 분석모드 배너(단일/다중) 2개", modeCount === 2, `count=${modeCount}`);
  const singleActive = await page.$eval('.ed-mode-btn[data-mode="single"]', (el) => el.getAttribute("aria-pressed"));
  ok("2. 기본 활성 모드=단일분석", singleActive === "true", singleActive);

  // 2) 다중분석 전환 시 프로젝트 배너 노출 + 안내 placeholder
  await page.click('.ed-mode-btn[data-mode="multi"]');
  await page.waitForTimeout(200);
  const projBannerVisible = await page.$eval("#ed-project-banner", (el) => getComputedStyle(el).display !== "none");
  ok("3. 다중분석 전환 시 프로젝트 배너 노출", projBannerVisible);
  const placeholderText = await page.$eval(".ed-multi-placeholder", (el) => el.textContent);
  ok("4. 프로젝트 미선택 안내문구 표시", placeholderText.includes("새 프로젝트"), placeholderText);

  // 3) 프로젝트 생성(대기질: 4지점×3항목)
  await page.click("#ed-project-add");
  await page.waitForTimeout(150);
  await page.fill("#ed-np-name", "테스트 대기질 다중분석");
  await page.fill("#ed-np-sites", "A-1, A-2, A-3, A-4");
  await page.uncheck('#ed-np-items input[value="O3"]');
  await page.uncheck('#ed-np-items input[value="Pb"]');
  await page.uncheck('#ed-np-items input[value="Benzene"]');
  await page.uncheck('#ed-np-items input[value="CO"]');
  await page.uncheck('#ed-np-items input[value="PM25"]');
  // 남는 항목: SO2, NO2, PM10 (3개)
  await page.click("#ed-np-create");
  await page.waitForTimeout(200);
  const projBtnCount = await page.$$eval(".ed-project-btn[data-id]", (els) => els.length);
  ok("5. 프로젝트 생성 후 배너에 1개 표시", projBtnCount === 1, `count=${projBtnCount}`);
  const sliceVisible = await page.$eval("#ed-slice-banner", (el) => getComputedStyle(el).display !== "none");
  ok("6. 프로젝트 선택 시 슬라이스 배너 노출", sliceVisible);
  const siteBtnCount = await page.$$eval('.ed-slice-btn[data-axis="site"]', (els) => els.length);
  const itemBtnCount = await page.$$eval('.ed-slice-btn[data-axis="item"]', (els) => els.length);
  ok("7. 지점버튼 4개·항목버튼 3개 동적생성", siteBtnCount === 4 && itemBtnCount === 3, `site=${siteBtnCount} item=${itemBtnCount}`);

  // 4) 회차 추가(지점×항목 매트릭스, 수동 입력)
  await page.click("#ed-round-add");
  await page.waitForTimeout(200);
  const newRoundCols = await page.$$eval("#ed-table thead th[data-col]", (els) => els.length);
  const newRoundRows = await page.$$eval("#ed-tbody tr", (els) => els.length);
  ok("8. 새회차 입력폼: 열=3항목, 행=4지점", newRoundCols === 3 && newRoundRows === 4, `cols=${newRoundCols} rows=${newRoundRows}`);
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#ed-tbody tr");
    const vals = [[55, 0.02, 0.02], [57, 0.03, 0.04], [40, 0.01, 0.03], [61, 0.05, 0.02]];
    rows.forEach((tr, r) => {
      [...tr.querySelectorAll(".ed-cell")].forEach((cell, c) => {
        cell.textContent = String(vals[r][c]);
        cell.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });
  });
  await page.fill("#ed-round-label", "1차(2026-01-15)");
  await page.locator("#ed-round-label").dispatchEvent("change");
  await page.waitForTimeout(500); // scheduleCharts 디바운스(자동저장) 대기
  const toastAfterRound = await page.evaluate(() => document.querySelector(".toasts")?.textContent || "");
  ok("9. 회차 추가 토스트 노출", toastAfterRound.includes("회차를 추가"), toastAfterRound);
  await page.click("#ed-round-done");
  await page.waitForTimeout(150);

  // 추가로 2차 회차도 입력(트렌드 확인용)
  await page.click("#ed-round-add");
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#ed-tbody tr");
    const vals = [[58, 0.025, 0.025], [60, 0.035, 0.045], [42, 0.015, 0.035], [65, 0.055, 0.025]];
    rows.forEach((tr, r) => {
      [...tr.querySelectorAll(".ed-cell")].forEach((cell, c) => {
        cell.textContent = String(vals[r][c]);
        cell.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });
  });
  await page.fill("#ed-round-label", "2차(2026-02-15)");
  await page.locator("#ed-round-label").dispatchEvent("change");
  await page.waitForTimeout(500);
  await page.click("#ed-round-done");
  await page.waitForTimeout(150);

  // 5) 지점 슬라이스(A-1) — 행=회차(2), 열=항목(3)
  await page.click('.ed-slice-btn[data-axis="site"][data-key]');
  await page.waitForTimeout(200);
  const siteSliceCols = await page.$$eval("#ed-table thead th[data-col]", (els) => els.length);
  const siteSliceRows = await page.$$eval("#ed-tbody tr", (els) => els.length);
  ok("10. 지점 슬라이스: 열=3항목, 행=2회차", siteSliceCols === 3 && siteSliceRows === 2, `cols=${siteSliceCols} rows=${siteSliceRows}`);
  const siteRowLabels = await page.$$eval("#ed-tbody tr .ed-row-label", (els) => els.map((e) => e.textContent.trim()));
  ok("11. 지점 슬라이스 행 라벨=회차명", siteRowLabels.some((l) => l.includes("1차")) && siteRowLabels.some((l) => l.includes("2차")), JSON.stringify(siteRowLabels));
  const so2Vals = await page.$$eval("#ed-tbody tr", (trs) => trs.map((tr) => tr.querySelectorAll(".ed-cell")[0].textContent.trim()));
  ok("12. A-1 지점 SO2 값 정확(55, 58)", JSON.stringify(so2Vals) === JSON.stringify(["55", "58"]), JSON.stringify(so2Vals));

  // 6) 항목 슬라이스(SO2) — 행=회차(2), 열=지점(4)
  await page.click('.ed-slice-btn[data-axis="item"][data-key="SO2"]');
  await page.waitForTimeout(200);
  const itemSliceCols = await page.$$eval("#ed-table thead th[data-col]", (els) => els.length);
  ok("13. 항목 슬라이스: 열=4지점", itemSliceCols === 4, `cols=${itemSliceCols}`);
  const itemSliceColLabels = await page.$$eval("#ed-table thead th[data-col] .ed-col-label", (els) => els.map((e) => e.textContent.trim()));
  ok("14. 항목 슬라이스 열 라벨=지점명(A-1~A-4)", itemSliceColLabels.every((l) => /^A-\d/.test(l)), JSON.stringify(itemSliceColLabels));
  const round1So2Row = await page.$$eval("#ed-tbody tr", (trs) => [...trs[0].querySelectorAll(".ed-cell")].map((c) => c.textContent.trim()));
  ok("15. 1차 회차의 4지점 SO2 값 정확(55,57,40,61)", JSON.stringify(round1So2Row) === JSON.stringify(["55", "57", "40", "61"]), JSON.stringify(round1So2Row));

  // 7) 슬라이스 뷰에서 셀 수정 → 큐브에 되쓰기(과거 데이터 정정)
  await page.evaluate(() => {
    const cell = document.querySelectorAll("#ed-tbody tr")[0].querySelectorAll(".ed-cell")[0];
    cell.textContent = "99"; cell.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(500); // scheduleCharts 디바운스(350ms) 대기 — persistSliceEdits 반영
  const persisted = await page.evaluate(() => {
    const raw = localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith("eiaw.envdata.projects.air")));
    const projects = JSON.parse(raw);
    const a1 = projects[0].sites.find((s) => s.label === "A-1");
    return projects[0].rounds[0].values[a1.code].SO2;
  });
  ok("16. 슬라이스 셀 수정이 localStorage 큐브에 실제 반영됨", persisted === 99, `persisted=${persisted}`);

  // 8) 브라우저 재방문(reload) 시 프로젝트·회차 데이터가 그대로 남아있음(영속성 확인)
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ed-table thead th[data-col]");
  await page.click('.ed-mode-btn[data-mode="multi"]');
  await page.waitForTimeout(150);
  const projAfterReload = await page.$$eval(".ed-project-btn[data-id]", (els) => els.length);
  ok("17. 새로고침 후에도 프로젝트가 유지됨(영속성)", projAfterReload === 1, `count=${projAfterReload}`);

  // 9) 단일분석으로 복귀 시 원래 대기질 단일분석 표(8항목)가 그대로 복원되는지
  await page.click('.ed-mode-btn[data-mode="single"]');
  await page.waitForTimeout(200);
  const singleColsAfterReturn = await page.$$eval("#ed-table thead th[data-col]", (els) => els.length);
  ok("18. 단일분석 복귀 시 정상 표 렌더(8항목)", singleColsAfterReturn === 8, `count=${singleColsAfterReturn}`);

  ok("19. 콘솔 에러 없음", errors.length === 0, errors.join(" | "));

  await page.screenshot({ path: "/tmp/claude-1000/-mnt-d-claude/c7b738ad-7edf-491d-a806-8ac2192fad80/scratchpad/multi_analysis_screenshot.png", fullPage: true });
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
