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

  await page.evaluate(() => {
    const rows = document.querySelectorAll("#ed-tbody tr");
    for (let r = 0; r < 3; r++) {
      const cells = rows[r].querySelectorAll(".ed-cell");
      for (let c = 0; c < cells.length; c++) { cells[c].textContent = String(0.0001 + r * 0.00001); cells[c].dispatchEvent(new Event("input", { bubbles: true })); }
    }
  });
  await page.waitForTimeout(500);
  await page.check("#ed-chart-bulk");
  await page.waitForTimeout(200);

  // 1) 드래그(연속 input 이벤트) 중 슬라이더 DOM 자체가 파괴/재생성되지 않아야 한다
  //    (renderCharts() 전체 재호출 시 발생하던 "드래그 중 깜빡임·재시도" 버그의 핵심 재현)
  await page.evaluate(() => { document.querySelector(".ed-chart-card .ed-c-width").__testMarker = "alive"; });
  for (const v of [400, 450, 500, 550, 600]) {
    await page.evaluate((val) => {
      const el = document.querySelector(".ed-chart-card .ed-c-width");
      el.value = String(val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, v);
    await page.waitForTimeout(30); // 드래그 중 짧은 간격의 연속 tick 시뮬레이션
  }
  const survived = await page.evaluate(() => document.querySelector(".ed-chart-card .ed-c-width").__testMarker === "alive");
  ok("1. 일괄적용 중 연속 드래그에도 슬라이더 DOM이 파괴되지 않음(깜빡임 버그 수정)", survived, `survived=${survived}`);
  const card1WidthFinal = await page.locator(".ed-chart-card").nth(0).evaluate((el) => el.style.width);
  ok("2. 연속 드래그 마지막 값(600)이 정확히 반영됨", card1WidthFinal === "600px", card1WidthFinal);

  // 2) 일괄적용 중 리더 폭 변경 → 팔로워 카드 폭도 함께 동기화(전체 재렌더 없이)
  const card2Width = await page.locator(".ed-chart-card").nth(1).evaluate((el) => el.style.width);
  ok("3. 일괄적용 중 팔로워 카드 폭도 리더와 동일하게 동기화", card2Width === "600px", card2Width);

  // 3) 색상 변경이 팔로워에도 실제로 반영되는지(사용자가 지적한 "색상 지정해도 안 바뀜" 재현·검증)
  await page.evaluate(() => {
    const el = document.querySelector(".ed-chart-card .ed-c-color");
    el.value = "#00ff00";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(150);
  const colorsAfter = await page.evaluate(() => {
    const canvases = document.querySelectorAll(".ed-chart-card canvas");
    return [...canvases].map((c) => Chart.getChart(c).data.datasets[0].backgroundColor.some((x) => String(x).toLowerCase() === "#00ff00"));
  });
  ok("4. 리더 색상 변경이 팔로워 차트에도 실제로 반영됨", colorsAfter.every(Boolean), JSON.stringify(colorsAfter));
  const followerColorInputVal = await page.locator(".ed-chart-card").nth(1).locator(".ed-c-color").inputValue();
  ok("5. 팔로워 카드의 색상 입력창 표시값도 동기화됨(비활성이라도 값은 맞음)", followerColorInputVal.toLowerCase() === "#00ff00", followerColorInputVal);

  // 4) line 타입 전환 시 막대굵기 비활성 → 팔로워에도 전파
  await page.locator(".ed-chart-card").nth(0).locator('[data-type="line"]').click();
  await page.waitForTimeout(150);
  const typesAfter = await page.evaluate(() => {
    const canvases = document.querySelectorAll(".ed-chart-card canvas");
    return [...canvases].map((c) => Chart.getChart(c).config.type);
  });
  ok("6. line 전환이 팔로워 전체에 전파됨", typesAfter.every((t) => t === "line"), JSON.stringify(typesAfter));

  ok("7. 콘솔 에러 없음", errors.length === 0, errors.join(" | "));

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
