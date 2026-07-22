const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:8791";
const results = [];
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond, detail }); };

// 사용자가 스크린샷으로 지적한 버그(2026-07-22): 다중분석 항목슬라이스 모드에서
// 표 헤더의 "이산화질소(NO2) | 24시간 | 기준 0.06 ppm" 정보바가 "글자크기" 컨트롤과
// 겹쳐 보였다. 원인은 select.ed-item-slice-avg가 전역 select{width:100%}를 그대로
// 물려받았는데, 부모(.ed-item-slice-info)가 flex-shrink 보호가 없어 순환 축소되면서
// select가 337px까지 부풀어 우측 글자크기 컨트롤 위로 넘쳤던 것 — ui.css에
// flex-shrink:0(컨테이너)+width:auto(select) 추가로 수정.
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  await page.goto(`${BASE}/index.html#envdata`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ed-table thead th[data-col]");
  await page.click('.ed-mode-btn[data-mode="multi"]');
  await page.click("#ed-project-add");
  await page.fill("#ed-np-name", "t");
  await page.fill("#ed-np-sites", "A-1, A-2, A-3, A-4");
  await page.evaluate(() => {
    document.querySelectorAll("#ed-np-items input[type=checkbox]").forEach((el) => {
      if (el.value !== "NO2") el.checked = false;
    });
  });
  await page.click("#ed-np-create");
  await page.waitForTimeout(300);
  await page.click('.ed-slice-btn[data-axis="item"]');
  await page.waitForTimeout(300);

  const m = await page.evaluate(() => {
    const info = document.querySelector("#ed-item-slice-info");
    const sel = info.querySelector("select.ed-item-slice-avg");
    const fontLabel = [...document.querySelectorAll("label")].find((l) => l.textContent.includes("글자크기"));
    return {
      infoOffsetWidth: info.offsetWidth,
      infoScrollWidth: info.scrollWidth,
      selectWidth: sel.getBoundingClientRect().width,
      infoRight: info.getBoundingClientRect().right,
      fontLeft: fontLabel.getBoundingClientRect().left,
    };
  });

  ok("1. 항목슬라이스 정보바가 자기 콘텐츠 폭 이상으로 오버플로하지 않음(scrollWidth<=offsetWidth)", m.infoScrollWidth <= m.infoOffsetWidth, JSON.stringify(m));
  ok("2. 평균시간 select가 비정상 확장(337px)되지 않고 콘텐츠 크기로 유지됨(<150px)", m.selectWidth < 150, "selectWidth=" + m.selectWidth);
  ok("3. 정보바 우측 끝이 글자크기 라벨 좌측 시작점을 넘지 않음(겹침 없음)", m.infoRight <= m.fontLeft, JSON.stringify(m));

  // 좁은 폭에서도 겹침 없이 줄바꿈되는지(오버플로 대신 wrap)
  await page.setViewportSize({ width: 700, height: 1600 });
  await page.waitForTimeout(200);
  const m2 = await page.evaluate(() => {
    const info = document.querySelector("#ed-item-slice-info");
    return { offsetWidth: info.offsetWidth, scrollWidth: info.scrollWidth };
  });
  ok("4. 700px 좁은 폭에서도 정보바 오버플로 없음(줄바꿈으로 대응)", m2.scrollWidth <= m2.offsetWidth, JSON.stringify(m2));

  ok("5. 콘솔 에러 없음", errors.length === 0, errors.join(" | "));

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
