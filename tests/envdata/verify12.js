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

  // 1) 기준 참조표 중앙정렬 + 단위 표시(대기질)
  const air = await page.evaluate(() => {
    const t = document.querySelector("#ed-ref-wrap .ed-ref-table");
    const firstTd = t.querySelector("tbody tr td");
    return { align: getComputedStyle(firstTd).textAlign, headHtml: t.querySelector("thead").textContent };
  });
  ok("1. 대기질 기준표 셀 중앙정렬", air.align === "center", air.align);

  // 2) 하천(생활환경기준, columnsFixed) — 단위 표시 확인(BOD/COD에 mg/L)
  await page.click('.ed-field-btn[data-idx="4"]');
  await page.waitForTimeout(200);
  const riverHead = await page.$eval("#ed-ref-wrap .ed-ref-table thead", (el) => el.textContent);
  ok("2. 하천 기준표 헤더에 단위(mg/L) 표시", riverHead.includes("mg/L"), riverHead);
  const riverAlign = await page.$eval("#ed-ref-wrap .ed-ref-table tbody tr td", (el) => getComputedStyle(el).textAlign);
  ok("3. 하천 기준표 셀 중앙정렬", riverAlign === "center", riverAlign);

  // 3) 소음(columnsFixed, period 자체 unit 없음 → 분야 공통 dB(A) fallback)
  await page.click('.ed-field-btn[data-idx="1"]');
  await page.waitForTimeout(200);
  const noiseHead = await page.$eval("#ed-ref-wrap .ed-ref-table thead", (el) => el.textContent);
  ok("4. 소음 기준표 헤더에 dB(A) 표시(분야 공통단위 폴백)", noiseHead.includes("dB(A)"), noiseHead);

  // 4) 토양(region+flexible) — 항목명에 단위(mg/kg) 표시
  await page.click('.ed-field-btn[data-idx="3"]');
  await page.waitForTimeout(200);
  const soilHead = await page.$eval("#ed-ref-wrap .ed-ref-table tbody", (el) => el.textContent);
  ok("5. 토양 기준표 항목명에 단위(mg/kg) 표시", soilHead.includes("mg/kg"), soilHead.slice(0, 80));
  await page.click('.ed-field-btn[data-idx="0"]');
  await page.waitForTimeout(200);

  // 5) 좁은 뷰포트에서 "글자크기" 라벨이 세로로 쪼개지지 않는지(실사용자 발견 버그)
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.waitForTimeout(200);
  const fontLabelBox = await page.locator(".ed-chk-label", { hasText: "글자크기" }).boundingBox();
  ok("6. 좁은 화면에서도 '글자크기' 라벨이 한 줄 높이(세로쪼개짐 없음)", fontLabelBox.height < 50, `height=${fontLabelBox.height}`);
  const fontLabelWS = await page.locator(".ed-chk-label", { hasText: "글자크기" }).evaluate((el) => getComputedStyle(el).whiteSpace);
  ok("7. 글자크기 라벨에 white-space:nowrap 적용", fontLabelWS === "nowrap", fontLabelWS);
  await page.setViewportSize({ width: 1600, height: 1400 });
  await page.waitForTimeout(200);

  // 6) PNG 내보내기 — 300dpi 이상 해상도(96dpi 대비 3.2배 이상) + 흰 배경
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#ed-tbody tr");
    for (let r = 0; r < 3; r++) {
      const cells = rows[r].querySelectorAll(".ed-cell");
      for (let c = 0; c < cells.length; c++) { cells[c].textContent = String(20 + r + c); cells[c].dispatchEvent(new Event("input", { bubbles: true })); }
    }
  });
  await page.waitForTimeout(500);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator(".ed-chart-card").nth(0).locator(".ed-chart-png").click(),
  ]);
  const dlPath = await download.path();
  const sizeInfo = await page.evaluate(async () => {
    const cardWidthCss = document.querySelector(".ed-chart-card").getBoundingClientRect().width;
    return { cardWidthCss };
  });
  const fs = require("fs");
  const buf = fs.readFileSync(dlPath);
  // PNG IHDR: 바이트 16~23이 width/height(big-endian 4바이트씩)
  const pngWidth = buf.readUInt32BE(16);
  const pngHeight = buf.readUInt32BE(20);
  const expectedMinWidth = Math.floor(sizeInfo.cardWidthCss * 3.0); // 여유 있게 3.0배 이상으로 판정(설정은 3.2배)
  ok("8. PNG 저장 해상도가 CSS폭 대비 3배 이상(≈300dpi)", pngWidth >= expectedMinWidth, `pngWidth=${pngWidth} cardCssW=${sizeInfo.cardWidthCss} expectedMin=${expectedMinWidth}`);

  // 흰 배경 확인 — PNG를 다시 이미지로 로드해서 (0,0) 픽셀 색상 검사
  const bgWhite = await page.evaluate(async (dataUrl) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const [r, g, b, a] = ctx.getImageData(2, 2, 1, 1).data;
        resolve({ r, g, b, a });
      };
      img.src = dataUrl;
    });
  }, "data:image/png;base64," + buf.toString("base64"));
  ok("9. PNG 배경이 흰색(라이트고정, 다크테마 무관)", bgWhite.r === 255 && bgWhite.g === 255 && bgWhite.b === 255 && bgWhite.a === 255, JSON.stringify(bgWhite));

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
