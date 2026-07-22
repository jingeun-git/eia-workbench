const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:8791";
const results = [];
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond, detail }); };

// 행/열전환(transpose)이 단일분석에만 있고 다중분석엔 버튼 자체가 없던 문제 +
// 단일분석에서 전환한 상태가 다중분석으로 넘어와도 리셋 안 되던 버그(2026-07-22 사용자 지적).
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1200 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  await page.goto(`${BASE}/index.html#envdata`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ed-table thead th[data-col]");
  await page.click(".ed-field-btn:has-text('소음')");
  await page.waitForTimeout(300);
  await page.click(".ed-mode-btn[data-mode='single']");
  await page.waitForTimeout(200);
  await page.click("#ed-transpose");
  await page.waitForTimeout(200);
  const pressedSingle = await page.locator("#ed-transpose").getAttribute("aria-pressed");
  ok("1. 단일분석에서 전환 클릭 시 aria-pressed=true", pressedSingle === "true", pressedSingle);

  await page.click(".ed-mode-btn[data-mode='multi']");
  await page.waitForTimeout(300);
  const existsMulti = await page.locator("#ed-transpose").count();
  ok("2. 다중분석에도 행/열전환 버튼이 존재함(과거엔 이 행 전체가 숨겨져 없었음)", existsMulti === 1, `count=${existsMulti}`);
  const pressedMulti = await page.locator("#ed-transpose").getAttribute("aria-pressed");
  ok("3. 다중분석 전환 시 이전(단일) 전환 상태가 새어나오지 않고 기본값(false)으로 리셋", pressedMulti === "false", pressedMulti);

  await page.click("#ed-project-add");
  await page.waitForTimeout(200);
  await page.fill("#ed-np-name", "회귀테스트");
  await page.fill("#ed-np-sites", "A-1, A-2");
  await page.click("#ed-np-create");
  await page.waitForTimeout(400);
  await page.click("#ed-round-add");
  await page.waitForTimeout(400);
  await page.click("#ed-transpose");
  await page.waitForTimeout(300);
  const siteThCount = await page.locator("#ed-thead-row th[data-row]").count();
  ok("4. 다중분석에서도 전환 버튼이 실제로 동작(지점이 열로 뒤집힘, 2개)", siteThCount === 2, `count=${siteThCount}`);

  await page.click(".ed-field-btn:has-text('진동')");
  await page.waitForTimeout(300);
  const pressedAfterFieldSwitch = await page.locator("#ed-transpose").getAttribute("aria-pressed");
  ok("5. 분야 전환 시에도 전환 상태가 리셋됨", pressedAfterFieldSwitch === "false", pressedAfterFieldSwitch);

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
