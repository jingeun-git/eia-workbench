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

  // 1) 최상단 안내문구
  const topNote = await page.$eval(".ed-toppage-note", (el) => el.textContent);
  ok("1. 최상단 자동저장 안내문구 존재", topNote.includes("자동 저장"), topNote);

  // 2) 하천/호소 사람건강보호기준 안내박스 제거
  await page.click('.ed-field-btn[data-idx="4"]'); // river_life
  await page.waitForTimeout(150);
  const healthBannerGone = (await page.$(".ed-banner")) === null;
  ok("2. 하천수질 사람건강보호기준 안내박스 완전 제거", healthBannerGone);
  await page.click('.ed-field-btn[data-idx="0"]');
  await page.waitForTimeout(150);

  // 3) 회차 저장 버튼 완전 제거(자동저장으로 통합)
  const saveBtnGone = (await page.$("#ed-round-save")) === null;
  const cancelBtnGone = (await page.$("#ed-round-cancel")) === null;
  ok("3. 회차저장/취소 버튼 완전 제거(완료/삭제만 존재)", saveBtnGone && cancelBtnGone);

  // 4) 다중분석 프로젝트+회차 생성 후 항목슬라이스 헤더 간소화 확인
  await page.click('.ed-mode-btn[data-mode="multi"]');
  await page.click("#ed-project-add");
  await page.waitForTimeout(100);
  await page.fill("#ed-np-name", "헤더테스트");
  await page.fill("#ed-np-sites", "A-1, A-2");
  await page.evaluate(() => {
    document.querySelectorAll("#ed-np-items input[type=checkbox]").forEach((el) => { if (el.value !== "SO2") el.checked = false; });
  });
  await page.click("#ed-np-create");
  await page.waitForTimeout(200);

  // 회차추가 즉시 자동생성(별도 저장버튼 없이) 확인
  await page.click("#ed-round-add");
  await page.waitForTimeout(200);
  const roundsAfterAddOnly = await page.evaluate(() => {
    const raw = localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith("eiaw.envdata.projects.air")));
    return JSON.parse(raw)[0].rounds.length;
  });
  ok("4. '+회차추가' 클릭 즉시 큐브에 회차 생성(저장버튼 없이도)", roundsAfterAddOnly === 1, `rounds=${roundsAfterAddOnly}`);

  // 셀 입력 없이 바로 완료 눌러도(저장 누락 걱정 없이) 회차가 남아있는지 확인
  await page.evaluate(() => {
    const cell = document.querySelectorAll("#ed-tbody tr")[0].querySelectorAll(".ed-cell")[0];
    cell.textContent = "42"; cell.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(500);
  await page.click("#ed-round-done"); // "저장" 없이 "완료"만
  await page.waitForTimeout(150);
  const persistedNoSaveClick = await page.evaluate(() => {
    const raw = localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith("eiaw.envdata.projects.air")));
    const proj = JSON.parse(raw)[0];
    const a1 = proj.sites.find((s) => s.label === "A-1");
    return proj.rounds[0].values[a1.code]?.SO2;
  });
  ok("5. 별도 저장버튼 없이 셀 입력만으로 데이터가 큐브에 남음(데이터 손실 버그 재현·수정 확인)", persistedNoSaveClick === 42, `val=${persistedNoSaveClick}`);

  // 항목슬라이스 헤더 간소화(기준·평균시간·단위가 컬럼헤더에 없고, 표 상단에 1회만)
  await page.click('.ed-slice-btn[data-axis="item"]');
  await page.waitForTimeout(200);
  const colHeaderHasStd = await page.$$eval("#ed-table thead th[data-col]", (els) => els.some((th) => th.querySelector(".ed-std-input") || th.querySelector(".ed-col-sub")));
  ok("6. 항목슬라이스 컬럼헤더에 기준·평균시간 UI 없음(간소화)", !colHeaderHasStd);
  const infoVisible = await page.$eval("#ed-item-slice-info", (el) => getComputedStyle(el).display !== "none");
  ok("7. 표 상단에 공통 항목정보(기준·평균시간) 1회 표시", infoVisible);
  const infoText = await page.$eval("#ed-item-slice-info", (el) => el.textContent);
  ok("8. 상단 항목정보에 아황산가스(SO2) 및 기준 텍스트 포함", infoText.includes("아황산가스"), infoText);

  // 회차 삭제 기능
  await page.click("#ed-round-add");
  await page.waitForTimeout(200);
  const roundsBeforeDel = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith("eiaw.envdata.projects.air"))))[0].rounds.length);
  await page.click("#ed-round-delete");
  await page.waitForTimeout(150);
  const roundsAfterDel = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith("eiaw.envdata.projects.air"))))[0].rounds.length);
  ok("9. '이 회차 삭제'로 방금 만든 회차 제거됨", roundsAfterDel === roundsBeforeDel - 1, `before=${roundsBeforeDel} after=${roundsAfterDel}`);

  ok("10. 콘솔 에러 없음", errors.length === 0, errors.join(" | "));

  await page.screenshot({ path: "/tmp/claude-1000/-mnt-d-claude/c7b738ad-7edf-491d-a806-8ac2192fad80/scratchpad/multi_v2_screenshot.png", fullPage: true });
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
