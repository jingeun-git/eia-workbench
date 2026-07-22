const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:8791";
const results = [];
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond, detail }); };

// 브리지로 HWP·PDF 등록문서 자동인식(SYS-41 9단계, 2026-07-22). 실제 브리지는 Windows+
// 한컴 COM이 필요해 이 환경에서 띄울 수 없으므로, /ping·/pick·/jobs를 그대로 흉내 내
// bridge.js의 정상 접속 감지 경로(자체 프로빙)부터 applyAoaToGrid까지 프론트엔드
// 전체 배선을 검증한다. 브리지 쪽 run_envdata_parse의 "가장 큰 표 선택" 로직은
// bridge/test_envdata_parse_logic.py(별도, 파이썬 유닛)로 검증했다.
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1200 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  const FAKE_AOA = [["측정지점", "SO2(ppm)"], ["지점1", "0.02"], ["지점2", "0.09"]];
  const jobState = { status: "queued", log: [], progress: null, result: null };

  await page.route("http://127.0.0.1:*/**", (route) => {
    const req = route.request();
    const url = req.url();
    if (url.endsWith("/ping")) {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ bridge_version: "9.9.9", features: { pdf2excel: true, hwp2pdf: true } }) });
    }
    if (url.endsWith("/pick") && req.method() === "POST") {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, path: "C:\\fake\\측정결과.pdf", paths: ["C:\\fake\\측정결과.pdf"] }) });
    }
    if (url.endsWith("/jobs") && req.method() === "POST") {
      jobState.status = "done";
      jobState.log = ["표 추출 중: 측정결과.pdf", "─── 추출 완료: 2행 × 2열"];
      jobState.result = { aoa: FAKE_AOA, tableCount: 1 };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, job_id: "fakejob123" }) });
    }
    if (/\/jobs\//.test(url) && req.method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(jobState) });
    }
    route.continue();
  });

  await page.goto(`${BASE}/index.html#envdata`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ed-table thead th[data-col]");
  await page.waitForTimeout(1500); // bridge._probe() 완료 대기

  const fieldDisplay = await page.evaluate(() => getComputedStyle(document.querySelector("#ed-bridge-parse-field")).display);
  ok("1. 브리지 연결 감지 시 '문서 선택' 버튼이 노출됨", fieldDisplay !== "none", fieldDisplay);
  const lockedDisplay = await page.evaluate(() => getComputedStyle(document.querySelector("#ed-bridge-parse-locked")).display);
  ok("2. 브리지 연결 시 잠금 안내문구는 숨겨짐", lockedDisplay === "none", lockedDisplay);

  await page.click("#ed-bridge-parse");
  await page.waitForTimeout(1500);

  const colLabels = await page.$$eval("#ed-table thead th[data-col] .ed-col-label", (els) => els.map((e) => e.textContent.trim()));
  const rowLabels = await page.$$eval("#ed-tbody tr .ed-row-label", (els) => els.map((e) => e.textContent.trim()));
  const statusText = await page.$eval("#ed-bridge-parse-status", (el) => el.textContent);

  ok("3. /pick→/jobs→poll로 받은 aoa가 항목 별칭(SO2)으로 정상 인식(아황산가스)", colLabels.some((l) => l.includes("아황산가스")), JSON.stringify(colLabels));
  ok("4. 지점명(지점1/지점2)이 행으로 정상 반영", rowLabels.includes("지점1") && rowLabels.includes("지점2"), JSON.stringify(rowLabels));
  ok("5. 처리 완료 상태문구 표시", statusText.includes("인식 완료"), statusText);

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
