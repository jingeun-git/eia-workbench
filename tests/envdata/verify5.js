const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:8791";
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
  await page.click('.ed-field-btn[data-idx="1"]'); // 소음
  await page.waitForTimeout(200);

  // 3개 지점에 서로 다른 지역구분 + 값 입력
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#ed-tbody tr");
    const regions = ["gen_ga", "gen_na", "road_ra"];
    const dayVals = [45, 52, 68];
    const nightVals = [42, 30, 72];
    rows.forEach((tr, i) => {
      const sel = tr.querySelector(".ed-region-select");
      sel.value = regions[i]; sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#ed-tbody tr");
    const dayVals = [45, 52, 68];
    const nightVals = [42, 30, 72];
    rows.forEach((tr, i) => {
      const cells = tr.querySelectorAll(".ed-cell");
      cells[0].textContent = String(dayVals[i]); cells[0].dispatchEvent(new Event("input", { bubbles: true }));
      cells[1].textContent = String(nightVals[i]); cells[1].dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
  await page.waitForTimeout(500);

  const chartCount = await page.$$eval("#ed-charts canvas", (els) => els.length);
  ok("1. 소음 값 입력 시 차트 2개(낮/밤) 생성", chartCount === 2, `count=${chartCount}`);

  const classes = await page.evaluate(() => {
    const rows = document.querySelectorAll("#ed-tbody tr");
    return [...rows].map((tr) => [...tr.querySelectorAll(".ed-cell")].map((c) => c.className));
  });
  // gen_ga(50/40): day45→ok, night42→exceed(>40)
  // gen_na(55/45): day52→ok(52<55), night30→ok
  // road_ra(75/70): day68→ok, night72→exceed(>70)
  ok("2. 지점1(가) 낮45 ok", classes[0][0].includes("ed-ok"), classes[0][0]);
  ok("3. 지점1(가) 밤42 exceed", classes[0][1].includes("ed-exceed"), classes[0][1]);
  ok("4. 지점2(나) 낮52 ok", classes[1][0].includes("ed-ok"), classes[1][0]);
  ok("5. 지점2(나) 밤30 ok", classes[1][1].includes("ed-ok"), classes[1][1]);
  ok("6. 지점3(도로라) 밤72 exceed", classes[2][1].includes("ed-exceed"), classes[2][1]);

  ok("7. 콘솔 에러 없음", errors.length === 0, errors.join(" | "));

  await page.screenshot({ path: "/tmp/claude-1000/-mnt-d-claude/c7b738ad-7edf-491d-a806-8ac2192fad80/scratchpad/noise_data_screenshot.png", fullPage: true });
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
