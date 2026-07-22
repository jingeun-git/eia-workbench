const { chromium } = require("playwright");
const path = require("path");
const BASE = "http://127.0.0.1:8791";
const results = [];
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond, detail }); };

// findRegionByAlias 정확일치 우선순위 버그(2026-07-22) — 짧은 등급명("좋음")이 배열상
// 먼저 나오는 긴 등급명("매우좋음")의 부분문자열이라, substring 매치가 나중에 나오는
// 정확일치("좋음"=Ib)를 가로채 Ia로 오판정했다. exact-core를 먼저 전부 훑도록 수정.
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  await page.goto(`${BASE}/index.html#envdata`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ed-table thead th[data-col]");
  await page.click(".ed-field-btn[data-idx='4']"); // 하천수질
  await page.waitForTimeout(300);
  await page.setInputFiles("#ed-file", path.join(__dirname, "fixtures", "river_life_region.xlsx"));
  await page.waitForTimeout(500);

  const regions = await page.$$eval("#ed-tbody tr .ed-region-select", (els) => els.map((e) => e.value));
  ok("1. '매우좋음'(접두어 없는 최상위 등급) → Ia 정확 매칭", regions[0] === "Ia", JSON.stringify(regions));
  ok("2. '좋음'(다른 등급명 '매우좋음'·'약간좋음'의 부분문자열) → Ib로 정확 매칭(Ia로 오판정 안 됨)", regions[1] === "Ib", JSON.stringify(regions));
  ok("3. '약간좋음' → II로 정확 매칭(Ib로 오판정 안 됨)", regions[2] === "II", JSON.stringify(regions));

  ok("4. 콘솔 에러 없음", errors.length === 0, errors.join(" | "));

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
