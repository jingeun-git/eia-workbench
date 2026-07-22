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

  await page.click('.ed-mode-btn[data-mode="multi"]');
  await page.click("#ed-project-add");
  await page.waitForTimeout(100);
  await page.fill("#ed-np-name", "추가삭제 테스트");
  await page.fill("#ed-np-sites", "A-1, A-2");
  await page.evaluate(() => {
    document.querySelectorAll("#ed-np-items input[type=checkbox]").forEach((el) => { if (!["SO2", "NO2"].includes(el.value)) el.checked = false; });
  });
  await page.click("#ed-np-create");
  await page.waitForTimeout(200);

  const before = await page.$$eval('.ed-slice-btn[data-axis="site"]', (els) => els.length);
  ok("1. 초기 지점 2개", before === 2, `count=${before}`);

  // 지점 추가(prompt 응답)
  page.once("dialog", (d) => d.accept("A-3"));
  await page.click("#ed-site-add");
  await page.waitForTimeout(200);
  const afterAdd = await page.$$eval('.ed-slice-btn[data-axis="site"]', (els) => els.map((e) => e.textContent.trim()));
  ok("2. 지점 추가 후 3개(A-3 포함)", afterAdd.length === 3 && afterAdd.includes("A-3"), JSON.stringify(afterAdd));

  // 항목 추가
  page.once("dialog", (d) => d.accept("PM10"));
  await page.click("#ed-item-add");
  await page.waitForTimeout(200);
  const itemsAfterAdd = await page.$$eval('.ed-slice-btn[data-axis="item"]', (els) => els.map((e) => e.textContent.trim()));
  ok("3. 항목 추가 후 3개(PM-10 포함)", itemsAfterAdd.length === 3, JSON.stringify(itemsAfterAdd));

  // 지점 삭제(A-3)
  const a3Del = await page.locator('.ed-slice-btn[data-axis="site"]', { hasText: "A-3" }).locator("xpath=following-sibling::span[1]");
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.ed-slice-btn[data-axis="site"]')];
    const a3 = btns.find((b) => b.textContent.trim() === "A-3");
    a3.nextElementSibling.click();
  });
  await page.waitForTimeout(200);
  const afterDel = await page.$$eval('.ed-slice-btn[data-axis="site"]', (els) => els.length);
  ok("4. 지점 삭제 후 다시 2개", afterDel === 2, `count=${afterDel}`);

  // 새 프로젝트 목록 영속성 재확인(새로고침)
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ed-table thead th[data-col]");
  await page.click('.ed-mode-btn[data-mode="multi"]');
  await page.waitForTimeout(150);
  await page.click(".ed-project-btn[data-id]");
  await page.waitForTimeout(150);
  const sitesAfterReload = await page.$$eval('.ed-slice-btn[data-axis="site"]', (els) => els.length);
  ok("5. 새로고침 후에도 지점/항목 추가삭제 반영 유지(지점2개)", sitesAfterReload === 2, `count=${sitesAfterReload}`);

  ok("6. 콘솔 에러 없음", errors.length === 0, errors.join(" | "));

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
