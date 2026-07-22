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

  // 측정업체가 헤더에 유니코드 첨자를 이미 써서 보낸 실무 시나리오("SO₂","PM₁₀","PM₂.₅")
  // — 표시용 첨자가 아니라 원본 파일에 박혀있는 문자다. xlsx 스마트업로드 경로
  // (applyAoaToGrid→findItemByAlias→norm())가 여전히 매칭하는지 확인.
  const fs = require("fs");
  const { execSync } = require("child_process");
  const fixtureDir = "/tmp/claude-1000/-mnt-d-claude/c7b738ad-7edf-491d-a806-8ac2192fad80/scratchpad/pw_test/fixtures";
  fs.mkdirSync(fixtureDir, { recursive: true });
  const pyScript = `
import openpyxl
wb = openpyxl.Workbook()
ws = wb.active
rows = [
    ["측정지점", "SO₂(ppm)", "PM₁₀(µg/m3)", "PM₂.₅(µg/m3)"],
    ["A-1", 0.02, 55, 22],
    ["A-2", 0.03, 57, 24],
]
for r in rows:
    ws.append(r)
wb.save("${fixtureDir}/subscript_header.xlsx")
`;
  fs.writeFileSync("/tmp/mk_subscript_xlsx.py", pyScript);
  execSync("python3 /tmp/mk_subscript_xlsx.py");

  await page.setInputFiles("#ed-file", `${fixtureDir}/subscript_header.xlsx`);
  await page.waitForTimeout(400);
  const labels = await page.$$eval("#ed-table thead th[data-col] .ed-col-label", (els) => els.map((e) => e.textContent.trim()));
  ok("1. 첨자 유니코드 헤더(SO₂·PM₁₀·PM₂.₅)도 정상 매칭되어 3항목 인식", labels.length === 3, JSON.stringify(labels));
  ok("2. SO2 항목 인식(아황산가스)", labels.some((l) => l.includes("아황산가스")), JSON.stringify(labels));
  ok("3. PM10 항목 인식(미세먼지)", labels.some((l) => l.includes("미세먼지") && !l.includes("초")), JSON.stringify(labels));
  ok("4. PM2.5 항목 인식(초미세먼지)", labels.some((l) => l.includes("초미세먼지")), JSON.stringify(labels));
  const toastText = await page.evaluate(() => document.querySelector(".toasts")?.textContent || "");
  ok("5. 미인식 항목 없음(전부 표준 항목으로 매칭됨)", !toastText.includes("미인식"), toastText);
  const values = await page.$$eval("#ed-tbody tr", (trs) => trs.map((tr) => [...tr.querySelectorAll(".ed-cell")].map((c) => c.textContent.trim())));
  ok("6. 값도 정확히 배치됨(0.02/55/22 등)", JSON.stringify(values[0]) === JSON.stringify(["0.02", "55", "22"]), JSON.stringify(values));

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
