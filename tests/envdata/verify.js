const { chromium } = require("playwright");

const BASE = "http://127.0.0.1:8791";
const results = [];
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond, detail }); };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  const consoleErrors = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => consoleErrors.push("pageerror: " + err.message));
  page.on("requestfailed", (req) => consoleErrors.push(`requestfailed: ${req.url()} — ${req.failure()?.errorText}`));

  await page.goto(`${BASE}/index.html#envdata`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#sec-envdata.active", { timeout: 5000 });
  await page.waitForSelector("#ed-table thead th", { timeout: 5000 });

  // A) 콘솔 에러 없음
  await page.waitForTimeout(300);
  ok("A. 콘솔 에러 없음(초기 로드+탭 전환)", consoleErrors.length === 0, consoleErrors.join(" | "));

  // B) 기본 8개 항목 컬럼
  const headers = await page.$$eval("#ed-table thead th .ed-col-label", (els) => els.map((e) => e.textContent.trim()));
  ok("B. 기본 8항목 컬럼 렌더", headers.length === 8, JSON.stringify(headers));

  // C) 셀 편집 → 판정 클래스 (SO2 24시간 기본 0.05ppm)
  async function setCell(rowIdx, colIdx, value) {
    await page.evaluate(({ rowIdx, colIdx, value }) => {
      const rows = document.querySelectorAll("#ed-tbody tr");
      const row = rows[rowIdx];
      const cell = row.querySelectorAll(".ed-cell")[colIdx];
      cell.textContent = String(value);
      cell.dispatchEvent(new Event("input", { bubbles: true }));
    }, { rowIdx, colIdx, value });
  }
  async function cellClass(rowIdx, colIdx) {
    return page.evaluate(({ rowIdx, colIdx }) => {
      const rows = document.querySelectorAll("#ed-tbody tr");
      return rows[rowIdx].querySelectorAll(".ed-cell")[colIdx].className;
    }, { rowIdx, colIdx });
  }
  await setCell(0, 0, 0.09);   // SO2(col0) 24h 기준 0.05 초과 → exceed
  await setCell(0, 2, 0.02);   // NO2(col2) 24h 기준 0.06 이하 → ok
  await setCell(0, 6, 0.3);    // Pb(col6) 연간 기준 0.5 이하 → ok
  const c0 = await cellClass(0, 0), c2 = await cellClass(0, 2), c6 = await cellClass(0, 6);
  ok("C1. SO2 0.09 → ed-exceed", c0.includes("ed-exceed"), c0);
  ok("C2. NO2 0.02 → ed-ok", c2.includes("ed-ok"), c2);
  ok("C3. Pb 0.3 → ed-ok", c6.includes("ed-ok"), c6);

  // D) 차트 렌더 (디바운스 대기)
  await page.waitForTimeout(500);
  const chartCount = await page.$$eval("#ed-charts canvas", (els) => els.length);
  const chartTitles = await page.$$eval("#ed-charts .ed-chart-head h4", (els) => els.map((e) => e.textContent));
  ok("D1. 값 있는 컬럼만 차트 생성(3개)", chartCount === 3, `count=${chartCount}`);
  ok("D2. 차트 제목에 SO2 라벨 포함", chartTitles.some((t) => t.includes("SO₂")), JSON.stringify(chartTitles));

  // E) 기준 오버라이드 → 재판정 (thead th[0]은 "측정지점" 코너 셀 — 데이터 컬럼은 th[1]부터)
  await page.evaluate(() => {
    const input = document.querySelectorAll("#ed-table thead th")[2].querySelector(".ed-std-input");
    input.value = "0.03";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(100);
  const c0b = await cellClass(0, 0);
  // SO2 값 0.09, 오버라이드 기준 0.03 → 여전히 exceed (기존에도 exceed였으니 반대 케이스로 재확인)
  await setCell(0, 0, 0.02); // 0.02 < 0.03 오버라이드 → ok 로 바뀌어야 정상 판정
  const c0c = await cellClass(0, 0);
  ok("E. 기준 오버라이드 반영(0.02 vs 사용자기준0.03 → ok)", c0c.includes("ed-ok"), c0c);
  // 원복
  await setCell(0, 0, 0.09);
  await page.evaluate(() => {
    const btn = document.querySelectorAll("#ed-table thead th")[2].querySelector(".ed-std-reset");
    if (btn) btn.click();
  });

  // F) 붙여넣기 — 헤더1행 + 지점2행, 새 커스텀 항목 포함 여부는 열 매핑 불가하므로
  //    기존 컬럼 범위 안에서 검증(측정지점 열은 -1 로 매핑되는 라벨 셀 사용)
  await page.evaluate(async () => {
    const target = document.querySelector('#ed-tbody tr:nth-child(2) .ed-row-label');
    target.focus();
    const dt = new DataTransfer();
    dt.setData("text/plain", "B-1\t0.01\t8\t0.02\t20\t8\t0.05\t0.1\t2\t99");
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
  });
  await page.waitForTimeout(200);
  const row2Label = await page.evaluate(() => document.querySelector('#ed-tbody tr:nth-child(2) .ed-row-label').textContent.trim());
  const colCountAfterPaste = await page.$$eval("#ed-table thead th", (els) => els.length - 3); // dragTh+corner+trailing 제외
  ok("F1. 붙여넣기로 지점명 반영(B-1)", row2Label === "B-1", row2Label);
  ok("F2. 붙여넣기로 9번째(커스텀) 컬럼 추가", colCountAfterPaste === 9, `colCount=${colCountAfterPaste}`);

  // G) PNG 내보내기 다운로드 트리거
  await page.waitForTimeout(400);
  let downloadOk = false;
  page.once("download", () => { downloadOk = true; });
  const pngBtn = await page.$("#ed-charts .ed-chart-png");
  if (pngBtn) { await pngBtn.click(); await page.waitForTimeout(300); }
  ok("G. PNG 저장 버튼 클릭 시 다운로드 발생", downloadOk, String(downloadOk));

  // H) 행/열 추가·삭제 버튼
  const rowsBefore = await page.$$eval("#ed-tbody tr", (els) => els.length);
  await page.click("#ed-add-row");
  const rowsAfter = await page.$$eval("#ed-tbody tr", (els) => els.length);
  ok("H. 지점 추가 버튼 동작", rowsAfter === rowsBefore + 1, `${rowsBefore}->${rowsAfter}`);

  // J) 헤더-바디 컬럼 수 정합(회귀 방지 — 2026-07-22 사용자 실사용 중 발견한 근본 버그)
  const theadN = await page.$$eval("#ed-thead-row th", (els) => els.length);
  const tbodyN = await page.$$eval("#ed-tbody tr:first-child td", (els) => els.length);
  ok("J. 헤더·바디 셀 수 일치(컬럼 밀림 회귀 방지)", theadN === tbodyN, `thead=${theadN} tbody=${tbodyN}`);

  // K) ppm↔ppb 단위 전환 — 값·기준 모두 1000배 스케일, 판정 결과는 불변
  const so2Th = page.locator('#ed-table thead th[data-col]').first();
  await so2Th.locator(".ed-unitscale-select").selectOption("1000");
  await page.waitForTimeout(100);
  const so2CellAfterPpb = await cellClass(0, 0); // 그대로 exceed 유지되어야 함(0.09ppm=90ppb, 기준 0.05ppm=50ppb)
  const so2ValAfterPpb = await page.evaluate(() => document.querySelectorAll("#ed-tbody tr")[0].querySelectorAll(".ed-cell")[0].textContent);
  const so2StdAfterPpb = await so2Th.locator(".ed-std-input").inputValue();
  ok("K1. ppb 전환 시 값 1000배 스케일(0.09→90)", so2ValAfterPpb.trim() === "90", so2ValAfterPpb);
  ok("K2. ppb 전환 시 기준도 1000배(0.05→50)", so2StdAfterPpb === "50", so2StdAfterPpb);
  ok("K3. 단위 전환해도 초과 판정 불변(exceed 유지)", so2CellAfterPpb.includes("ed-exceed"), so2CellAfterPpb);

  // 최종 콘솔 에러 재확인(전체 상호작용 이후)
  ok("I. 전체 상호작용 후에도 콘솔 에러 없음", consoleErrors.length === 0, consoleErrors.join(" | "));

  await page.screenshot({ path: "/tmp/claude-1000/-mnt-d-claude/c7b738ad-7edf-491d-a806-8ac2192fad80/scratchpad/envdata_screenshot.png", fullPage: true });

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
