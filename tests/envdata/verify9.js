const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:8791";
const results = [];
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond, detail }); };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  await page.goto(`${BASE}/index.html#envdata`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ed-table thead th[data-col]");

  // 대기질 기본 데이터 입력 → 차트 카드 생성 확인
  // 컬럼마다 단위·기준값 스케일이 판이하므로(ppm vs µg/m³) 극소값을 써서 어느 컬럼도
  // 기준 초과로 판정되지 않게 한다 — 색상 옵션 검증이 판정색(초과) 오버라이드에 가려지지 않도록.
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#ed-tbody tr");
    for (let r = 0; r < 3; r++) {
      const cells = rows[r].querySelectorAll(".ed-cell");
      for (let c = 0; c < cells.length; c++) {
        cells[c].textContent = String(0.0001 + r * 0.00001);
        cells[c].dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  });
  await page.waitForTimeout(500); // scheduleCharts 디바운스(350ms) 대기

  const cardCount = await page.$$eval(".ed-chart-card", (els) => els.length);
  ok("1. 데이터 입력 후 차트 카드 생성됨", cardCount > 0, `count=${cardCount}`);

  // 첫 카드 컨트롤 존재 확인
  const card1 = page.locator(".ed-chart-card").nth(0);
  ok("2. 첫 카드에 타입 세그먼트 존재", await card1.locator("[data-type]").count() === 2);
  ok("3. 첫 카드에 색상/폭/높이/굵기 컨트롤 존재",
    (await card1.locator(".ed-c-color").count() === 1) &&
    (await card1.locator(".ed-c-width").count() === 1) &&
    (await card1.locator(".ed-c-height").count() === 1) &&
    (await card1.locator(".ed-c-thick").count() === 1));

  // 둘째 카드 존재 시 서로 다른 옵션을 줘서 "개별 적용" 검증
  const card2 = page.locator(".ed-chart-card").nth(1);
  const card2Exists = (await card2.count()) === 1;
  ok("4. 두 번째 차트 카드 존재(개별설정 검증용)", card2Exists, `cardCount=${cardCount}`);

  if (card2Exists) {
    // 카드1: line 타입으로 변경, 카드2는 그대로 bar 유지 → 서로 달라야 함
    await card1.locator('[data-type="line"]').click();
    await page.waitForTimeout(150);
    const type1 = await page.evaluate(() => {
      const canvases = document.querySelectorAll(".ed-chart-card canvas");
      return Chart.getChart(canvases[0]).config.type;
    });
    const type2 = await page.evaluate(() => {
      const canvases = document.querySelectorAll(".ed-chart-card canvas");
      return Chart.getChart(canvases[1]).config.type;
    });
    ok("5. 카드1만 line으로 변경, 카드2는 bar 유지(개별 적용)", type1 === "line" && type2 === "bar", `type1=${type1} type2=${type2}`);

    // 카드1 가로폭 슬라이더 조정 → 카드1만 width 변경, 카드2는 그대로
    const w1before = await card1.evaluate((el) => el.getBoundingClientRect().width);
    const w2before = await card2.evaluate((el) => el.getBoundingClientRect().width);
    await card1.locator(".ed-c-width").evaluate((el) => {
      el.value = "600";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(150);
    const w1after = await card1.evaluate((el) => el.getBoundingClientRect().width);
    const w2after = await card2.evaluate((el) => el.getBoundingClientRect().width);
    ok("6. 카드1 가로폭만 변경, 카드2는 불변", Math.abs(w1after - 600) < 5 && Math.abs(w2after - w2before) < 2,
      `w1before=${w1before} w1after=${w1after} w2before=${w2before} w2after=${w2after}`);
  }

  // 색상 변경 → 데이터셋 backgroundColor 반영(초과판정 막대는 판정색이 우선이므로, 셋 중 하나라도 지정색이면 통과)
  await card1.locator(".ed-c-color").evaluate((el) => { el.value = "#00ff00"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForTimeout(150);
  const bgArr = await page.evaluate(() => {
    const canvas = document.querySelectorAll(".ed-chart-card canvas")[0];
    return Chart.getChart(canvas).data.datasets[0].backgroundColor;
  });
  ok("7. 색상 변경이 정상판정 막대 중 하나 이상에 반영됨", bgArr.some((c) => String(c).toLowerCase() === "#00ff00"), JSON.stringify(bgArr));

  // 수치표시(datalabels) 체크 → plugins.datalabels.display true
  await card1.locator(".ed-c-labels").check();
  await page.waitForTimeout(150);
  const dl = await page.evaluate(() => {
    const canvas = document.querySelectorAll(".ed-chart-card canvas")[0];
    return Chart.getChart(canvas).options.plugins.datalabels?.display;
  });
  ok("8. 수치표시 체크 → datalabels.display=true", dl === true, `dl=${dl}`);

  // line 타입에서는 막대굵기가 무의미하므로 자동 비활성화되어야 한다(사용자 지시, 2026-07-22)
  const thickDisabledOnLine = await card1.locator(".ed-c-thick").isDisabled();
  ok("8b. line 타입에서 막대굵기 컨트롤 자동 비활성화", thickDisabledOnLine);

  // bar로 되돌린 뒤 막대굵기 조정 → dataset.barThickness 반영
  await card1.locator('[data-type="bar"]').click();
  await page.waitForTimeout(100);
  await card1.locator(".ed-c-thick").fill("30");
  await card1.locator(".ed-c-thick").dispatchEvent("input");
  await page.waitForTimeout(150);
  const thick = await page.evaluate(() => {
    const canvas = document.querySelectorAll(".ed-chart-card canvas")[0];
    return Chart.getChart(canvas).data.datasets[0].barThickness;
  });
  ok("9. 막대굵기 슬라이더 → barThickness=30", thick === 30, `thick=${thick}`);

  // Y축 직접설정
  await card1.locator(".ed-c-ymanual").check();
  await card1.locator(".ed-c-ymin").fill("10");
  await card1.locator(".ed-c-ymin").dispatchEvent("change");
  await card1.locator(".ed-c-ymax").fill("200");
  await card1.locator(".ed-c-ymax").dispatchEvent("change");
  await page.waitForTimeout(150);
  const yopts = await page.evaluate(() => {
    const canvas = document.querySelectorAll(".ed-chart-card canvas")[0];
    const y = Chart.getChart(canvas).options.scales.y;
    return { min: y.min, max: y.max };
  });
  ok("10. Y축 직접설정 min/max 반영", yopts.min === 10 && yopts.max === 200, JSON.stringify(yopts));

  // 제목/범례 토글
  await card1.locator(".ed-c-title").uncheck();
  await card1.locator(".ed-c-legend").check();
  await page.waitForTimeout(150);
  const tl = await page.evaluate(() => {
    const canvas = document.querySelectorAll(".ed-chart-card canvas")[0];
    const p = Chart.getChart(canvas).options.plugins;
    return { title: p.title.display, legend: p.legend.display };
  });
  ok("11. 제목 끄기/범례 켜기 반영", tl.title === false && tl.legend === true, JSON.stringify(tl));

  // 다른 분야로 전환 후 되돌아와도(같은 세션 내) 옵션 유지되는지는 컬럼 객체가 재생성되므로 검증 대상 아님 — 콘솔 에러만 확인
  ok("12. 콘솔 에러 없음", errors.length === 0, errors.join(" | "));

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
