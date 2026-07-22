const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:8791";
const results = [];
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond, detail }); };

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("ERR_CONNECTION_REFUSED") && !m.text().includes("Failed to load resource")) errors.push(m.text()); });

  await page.goto(`${BASE}/index.html#envdata`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ed-table thead th[data-col]");
  await page.waitForTimeout(300);

  // 1) 기준값 pristine 표시 (회귀 확인)
  const stdVals = await page.$$eval("#ed-table thead th[data-col] .ed-std-input", (els) => els.map((e) => e.value));
  ok("1. 기준값 pristine 전부 채워짐(회귀 없음)", stdVals.every((v) => v !== ""), JSON.stringify(stdVals));

  // 2) 레이아웃: 그래프가 표 아래로 이동(SYS-46) — 표 패널이 그래프 패널보다 위에 있고, 둘 다 전체너비
  const layoutInfo = await page.evaluate(() => {
    const main = document.querySelector(".ed-main");
    const charts = document.querySelector("#ed-charts").closest(".panel");
    return {
      mainTop: main.getBoundingClientRect().top,
      chartsTop: charts.getBoundingClientRect().top,
      mainW: main.getBoundingClientRect().width,
      chartsW: charts.getBoundingClientRect().width,
    };
  });
  ok("2. 표 패널이 그래프 패널보다 위에 위치(세로 스택)", layoutInfo.mainTop < layoutInfo.chartsTop, JSON.stringify(layoutInfo));
  ok("2b. 표·그래프 패널 둘 다 유사한 전체너비(60:40 분할 폐기)", Math.abs(layoutInfo.mainW - layoutInfo.chartsW) < 5, JSON.stringify(layoutInfo));

  // 3) 텍스트 중앙정렬
  const align = await page.evaluate(() => getComputedStyle(document.querySelector(".ed-cell")).textAlign);
  ok("3. 셀 텍스트 중앙정렬", align === "center", align);

  // 4) 열 너비 드래그 리사이즈
  const th0 = page.locator("#ed-table thead th[data-col]").first();
  const wBefore = (await th0.boundingBox()).width;
  const resizer = th0.locator(".ed-resizer");
  const rBox = await resizer.boundingBox();
  await page.mouse.move(rBox.x + 3, rBox.y + 10);
  await page.mouse.down();
  await page.mouse.move(rBox.x + 80, rBox.y + 10, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const wAfter = (await th0.boundingBox()).width;
  ok("4. 열 너비 드래그로 조절됨", wAfter > wBefore + 50, `before=${wBefore.toFixed(0)} after=${wAfter.toFixed(0)}`);

  // 5) 리사이즈 후에도 열 드래그(순서변경)가 오작동 안 하는지 — 리사이저 아닌 라벨에서 드래그
  const labelsBefore = await page.$$eval("#ed-table thead th[data-col] .ed-col-label", (els) => els.map((e) => e.textContent));
  const th1 = page.locator("#ed-table thead th[data-col]").nth(1);
  const labelBox = await th1.locator(".ed-col-label").boundingBox();
  const th0box = await th0.boundingBox();
  await page.mouse.move(labelBox.x + 5, labelBox.y + 5);
  await page.mouse.down();
  await page.mouse.move(th0box.x + 5, th0box.y + 5, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const labelsAfter = await page.$$eval("#ed-table thead th[data-col] .ed-col-label", (els) => els.map((e) => e.textContent));
  ok("5. 리사이즈 후에도 열 드래그 정상", labelsAfter[0] !== labelsBefore[0], `before=${labelsBefore.join(",")} after=${labelsAfter.join(",")}`);

  // 6) 실제 Ctrl+V 붙여넣기 (재확인)
  await page.evaluate(async () => { await navigator.clipboard.writeText("16\t8\t0.002"); });
  await page.locator(".ed-cell[data-col]").first().click();
  await page.keyboard.press("Control+V");
  await page.waitForTimeout(200);
  const pasted = await page.evaluate(() => [...document.querySelectorAll("#ed-tbody tr")[0].querySelectorAll(".ed-cell")].slice(0, 3).map((td) => td.textContent));
  ok("6. 실제 Ctrl+V 붙여넣기 정상(재확인)", pasted.join(",") === "16,8,0.002", pasted.join(","));

  // 7) 헤더-바디 컬럼 수 정합(회귀 방지)
  const theadN = await page.$$eval("#ed-thead-row th", (els) => els.length);
  const tbodyN = await page.$$eval("#ed-tbody tr:first-child td", (els) => els.length);
  ok("7. 헤더·바디 컬럼 수 일치(회귀 없음)", theadN === tbodyN, `thead=${theadN} tbody=${tbodyN}`);

  ok("8. 콘솔 에러 없음(브리지 폴링 제외)", errors.length === 0, errors.join(" | "));

  await page.screenshot({ path: "/tmp/claude-1000/-mnt-d-claude/c7b738ad-7edf-491d-a806-8ac2192fad80/scratchpad/layout_screenshot.png", fullPage: true });

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
