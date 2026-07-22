const { chromium } = require("playwright");
const path = require("path");
const BASE = "http://127.0.0.1:8791";
const FIX = path.join(__dirname, "fixtures");
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

  // ── 1) 대기질: 안내문 2행 + 판정/비고 관리열이 섞인 실무형 xlsx ──────────────
  await page.setInputFiles("#ed-file", path.join(FIX, "messy_air.xlsx"));
  await page.waitForTimeout(400);
  const airLabels = await page.$$eval("#ed-table thead th[data-col] .ed-col-label", (els) => els.map((e) => e.textContent.trim()));
  ok("1. 안내문·관리열 있는 대기질 파일 → PM10·PM2.5·NO2 3항목만 인식(판정·비고 제외)",
    airLabels.length === 3 && airLabels.some((l) => l.includes("PM₁₀")) && airLabels.some((l) => l.includes("PM₂.₅")) && airLabels.some((l) => l.includes("NO₂")),
    JSON.stringify(airLabels));
  const airRowLabels = await page.$$eval("#ed-tbody tr .ed-row-label", (els) => els.map((e) => e.textContent.trim()));
  ok("2. 지점명 3개 정상 인식(안내문 행이 지점으로 섞이지 않음)",
    airRowLabels.length === 3 && airRowLabels.every((l) => /^지점\d$/.test(l)), JSON.stringify(airRowLabels));
  const airVals = await page.$$eval("#ed-tbody tr", (trs) => trs.map((tr) => [...tr.querySelectorAll(".ed-cell")].map((c) => c.textContent.trim())));
  ok("3. 대기질 수치값 정확히 배치(45/20/0.02 등)", JSON.stringify(airVals) === JSON.stringify([["45","20","0.02"],["52","25","0.03"],["48","22","0.021"]]), JSON.stringify(airVals));
  const toast1 = await page.evaluate(() => document.querySelector(".toasts")?.textContent || "");
  ok("4. 토스트에 헤더행 인식·관리열 제외 안내 포함", toast1.includes("헤더로 인식") && toast1.includes("관리열"), toast1);

  // ── 2) 소음: 항목(낮/밤)이 행, 지점이 열로 뒤집힌 실무형 xlsx ────────────────
  await page.click('.ed-field-btn[data-idx="1"]'); // noise
  await page.waitForTimeout(200);
  await page.setInputFiles("#ed-file", path.join(FIX, "flipped_noise.xlsx"));
  await page.waitForTimeout(400);
  const noiseRowLabels = await page.$$eval("#ed-tbody tr .ed-row-label", (els) => els.map((e) => e.textContent.trim()));
  ok("5. 뒤집힌 소음 파일 → 지점 3개(1/2/3구간)가 행으로 정상 배치", noiseRowLabels.length === 3 && noiseRowLabels.every((l) => /구간$/.test(l)), JSON.stringify(noiseRowLabels));
  const noiseVals = await page.$$eval("#ed-tbody tr", (trs) => trs.map((tr) => [...tr.querySelectorAll(".ed-cell")].map((c) => c.textContent.trim())));
  ok("6. 소음 낮/밤 값이 열 순서 그대로 매핑(55/45, 60/50, 58/48)",
    JSON.stringify(noiseVals) === JSON.stringify([["55","45"],["60","50"],["58","48"]]), JSON.stringify(noiseVals));
  const toast2 = await page.evaluate(() => document.querySelector(".toasts")?.textContent || "");
  ok("7. 토스트에 '행/열이 뒤집힌 표' 자동전환 안내 포함", toast2.includes("뒤집힌"), toast2);

  // ── 3) 하천 생활환경기준: 지역구분 열 + 안내문 1행 + 비고 관리열 ──────────────
  await page.click('.ed-field-btn[data-idx="4"]'); // river_life
  await page.waitForTimeout(200);
  await page.setInputFiles("#ed-file", path.join(FIX, "river_life_region.xlsx"));
  await page.waitForTimeout(400);
  const riverRowLabels = await page.$$eval("#ed-tbody tr .ed-row-label .ed-col-label, #ed-tbody tr .ed-row-label", (els) => els.map((e) => e.textContent.trim()).filter(Boolean));
  const riverRegions = await page.$$eval("#ed-tbody tr .ed-region-select", (els) => els.map((e) => e.value));
  ok("8. 하천 지역구분 열 자동인식(매우좋음→Ia, Ib, II)", JSON.stringify(riverRegions) === JSON.stringify(["Ia", "Ib", "II"]), JSON.stringify(riverRegions));
  const riverVals = await page.$$eval("#ed-tbody tr", (trs) => trs.map((tr) => [...tr.querySelectorAll(".ed-cell")].slice(0, 3).map((c) => c.textContent.trim())));
  ok("9. 하천 pH/BOD/COD 값 정확 배치(비고열 침범 없음)",
    JSON.stringify(riverVals) === JSON.stringify([["7","0.8","1.5"],["7.2","1.5","3"],["6.9","2.5","4"]]), JSON.stringify(riverVals));
  const toast3 = await page.evaluate(() => document.querySelector(".toasts")?.textContent || "");
  ok("10. 토스트에 지역구분 자동인식 건수 표시", toast3.includes("지역구분") && toast3.includes("자동인식"), toast3);

  // ── 4) 회귀: 기존 정형 파일(헤더=1행, 지점명=1열)도 여전히 정상 동작 ─────────
  await page.click('.ed-field-btn[data-idx="0"]'); // air
  await page.waitForTimeout(200);
  await page.setInputFiles("#ed-file", path.join(FIX, "messy_air.xlsx")); // 재사용(형태만 확인)
  await page.waitForTimeout(400);
  const regressionCols = await page.$$eval("#ed-table thead th[data-col]", (els) => els.length);
  ok("11. 재업로드 회귀 없음(컬럼 재생성 정상)", regressionCols === 3, `count=${regressionCols}`);

  ok("12. 콘솔 에러 없음", errors.length === 0, errors.join(" | "));

  await page.screenshot({ path: "/tmp/claude-1000/-mnt-d-claude/c7b738ad-7edf-491d-a806-8ac2192fad80/scratchpad/xlsx_smart_screenshot.png" });
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
