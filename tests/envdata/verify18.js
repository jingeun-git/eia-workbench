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

  // ── 소음: 탭을 하나씩 눌러가며 각 패널 내용을 확인 ──────────────────────
  await page.click('.ed-field-btn[data-idx="1"]');
  await page.waitForTimeout(200);

  // 메인(환경기준) 탭 — notes(적용제외 비고) + intro 안내문
  const mainText = await page.$eval("#ed-ref-wrap", (el) => el.textContent);
  ok("1. 메인 환경기준 표에 '항공기소음' 적용제외 비고 노출", mainText.includes("항공기소음"), mainText.includes("항공기소음"));
  ok("2. additionalStandardsIntro 안내문(근거 법령이 다름 안내) 노출", mainText.includes("근거 법령이 다른"), mainText.includes("근거 법령이 다른"));

  await page.click('.ed-ref-tab:has-text("도로")');
  await page.waitForTimeout(150);
  const roadValues = await page.$$eval("#ed-ref-wrap tbody td", (els) => els.map((td) => td.textContent.trim()));
  ok("3. 교통소음(도로) 표 값 정확(68,58,73,63)", JSON.stringify(roadValues) === JSON.stringify(["68", "58", "73", "63"]), JSON.stringify(roadValues));

  await page.click('.ed-ref-tab:has-text("철도")');
  await page.waitForTimeout(150);
  const railText = await page.$eval("#ed-ref-wrap", (el) => el.textContent);
  ok("4. 철도 표에 '정거장은 적용하지 않는다' 비고 + 경고(⚠) 노출", railText.includes("정거장") && railText.includes("⚠"), railText.slice(0, 150));

  await page.click('.ed-ref-tab:has-text("생활소음")');
  await page.waitForTimeout(150);
  const livingRows = await page.$eval("#ed-ref-wrap", (el) => el.querySelectorAll("tbody tr").length);
  const livingText = await page.$eval("#ed-ref-wrap", (el) => el.textContent);
  ok("5. 생활소음 규제기준 12행 전부 렌더", livingRows === 12, `rows=${livingRows}`);
  ok("6. 생활소음 표에 보정(+10dB 등) 노출", livingText.includes("보정") && livingText.includes("+10dB"), livingText.includes("보정"));
  ok("7. 생활소음 표에 지역범례(주거지역/그 밖의 지역) 노출", livingText.includes("주거지역") && livingText.includes("그 밖의 지역"), livingText.slice(0, 150));

  await page.click('.ed-ref-tab:has-text("축사")');
  await page.waitForTimeout(150);
  const disputeText = await page.$eval("#ed-ref-wrap", (el) => el.textContent);
  ok("8. 축사 기준에 환경분쟁조정 출처 노출", disputeText.includes("환경분쟁조정") && disputeText.includes("중앙환경분쟁조정위원회"), disputeText.slice(0, 100));
  ok("9. 소음 탭에서는 축사 표에 진동 항목(가축피해 진동)이 섞여 나오지 않음", !disputeText.includes("가축피해 진동"), disputeText.slice(0, 200));
  ok("10. 소음 탭 축사에는 진동 전용 참고표(nested table)가 섞여 나오지 않음(필드 분리)", !disputeText.includes("공사장 발파"), disputeText.includes("공사장 발파"));
  ok("11. 소음 탭 축사에는 sourceBadge(내부기준 배지)가 없음(원문 아닌 메모라 제거됨, 2026-07-22)", (await page.$("#ed-ref-wrap .ed-ref-badge")) === null, "badge element found?");

  // ── 진동: 메인표(생활진동)에 보정+criticalFlag, 도로/철도/축사 탭 ──────────
  await page.click('.ed-field-btn[data-idx="2"]');
  await page.waitForTimeout(200);
  const vibMainText = await page.$eval("#ed-ref-wrap", (el) => el.textContent);
  ok("12. 진동 메인표(생활진동)에 보정조항(+10dB 등) 노출", vibMainText.includes("보정") && vibMainText.includes("+10dB"), vibMainText.includes("+10dB"));
  const vibTabLabels = await page.$$eval(".ed-ref-tab", (els) => els.map((e) => e.textContent.trim()));
  ok("13. 진동 탭 4개: 생활진동규제기준/도로/철도/축사", JSON.stringify(vibTabLabels) === JSON.stringify(["생활진동규제기준", "도로", "철도", "축사"]), JSON.stringify(vibTabLabels));

  await page.click('.ed-ref-tab:has-text("축사")');
  await page.waitForTimeout(150);
  const vibDisputeText = await page.$eval("#ed-ref-wrap", (el) => el.textContent);
  ok("14. 진동에도 축사 피해인정기준 동일하게 표시(진동 전용 행만, 소음 항목은 섞이지 않음)", vibDisputeText.includes("가축피해 진동") && !vibDisputeText.includes("가축피해 소음"), vibDisputeText.slice(0, 200));

  ok("15. 콘솔 에러 없음", errors.length === 0, errors.join(" | "));

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
