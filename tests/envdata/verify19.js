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

  // 1) 대기질(단일 기준) — 탭 없음, 제목=해당 기준명
  const airHeading = await page.$eval("#ed-ref-heading", (el) => el.textContent);
  ok("1. 대기질(단일기준) 제목='환경기준'(고정문구 아님)", airHeading === "환경기준", airHeading);
  const airTabsVisible = await page.$eval("#ed-ref-tabs", (el) => getComputedStyle(el).display !== "none");
  ok("2. 대기질은 탭 버튼 숨김(기준 1개뿐)", !airTabsVisible);
  const airTableCount = await page.$$eval("#ed-ref-wrap .ed-ref-table", (els) => els.length);
  ok("3. 대기질은 표 1개만 노출(스택 안 함)", airTableCount === 1, `count=${airTableCount}`);

  // 2) 소음(4개 추가기준) — 탭 노출, 제목='관련 기준', 탭 클릭으로 콘텐츠 전환
  await page.click('.ed-field-btn[data-idx="1"]');
  await page.waitForTimeout(200);
  const noiseHeading = await page.$eval("#ed-ref-heading", (el) => el.textContent);
  ok("4. 소음(기준 5개) 제목='관련 기준'", noiseHeading === "관련 기준", noiseHeading);
  const tabLabels = await page.$$eval(".ed-ref-tab", (els) => els.map((e) => e.textContent.trim()));
  ok("5. 탭 5개: 환경기준/도로/철도/생활소음/축사", JSON.stringify(tabLabels) === JSON.stringify(["환경기준", "도로", "철도", "생활소음", "축사"]), JSON.stringify(tabLabels));
  const initialTableCount = await page.$$eval("#ed-ref-wrap .ed-ref-table", (els) => els.length);
  ok("6. 초기 상태는 첫 탭(환경기준) 표 1개만 노출(전체 스택 아님)", initialTableCount === 1, `count=${initialTableCount}`);

  await page.click('.ed-ref-tab:has-text("생활소음")');
  await page.waitForTimeout(150);
  const afterClickRows = await page.$$eval("#ed-ref-wrap tbody tr", (els) => els.length);
  ok("7. '생활소음' 탭 클릭 → 12행 표로 전환", afterClickRows === 12, `rows=${afterClickRows}`);
  const activeTab = await page.$eval('.ed-ref-tab[aria-pressed="true"]', (el) => el.textContent.trim());
  ok("8. 클릭한 탭이 활성 표시로 바뀜", activeTab === "생활소음", activeTab);

  await page.click('.ed-ref-tab:has-text("축사")');
  await page.waitForTimeout(150);
  const disputeVisible = await page.$eval("#ed-ref-wrap", (el) => el.textContent.includes("환경분쟁조정"));
  ok("9. '축사' 탭 클릭 → 축사 기준 내용으로 전환", disputeVisible);

  // 3) 다른 분야로 이동 후 되돌아오면 탭이 첫 화면(0번)으로 리셋되는지
  await page.click('.ed-field-btn[data-idx="0"]');
  await page.waitForTimeout(150);
  await page.click('.ed-field-btn[data-idx="1"]');
  await page.waitForTimeout(150);
  const resetTab = await page.$eval('.ed-ref-tab[aria-pressed="true"]', (el) => el.textContent.trim());
  ok("10. 분야 이탈 후 재진입 시 탭이 첫 번째(환경기준)로 리셋", resetTab === "환경기준", resetTab);

  // 4) 항목슬라이스 정보바 — 라벨이 한 줄로(세로 쪼개짐 없음), 높이 확인
  await page.click('.ed-mode-btn[data-mode="multi"]');
  await page.click("#ed-project-add");
  await page.waitForTimeout(100);
  await page.click("#ed-np-cancel"); // 소음은 폼이 열려도 지점만 필요 — 취소 후 아래에서 다시 시도
  await page.click('.ed-field-btn[data-idx="0"]'); // 대기질(항목모드)에서 확인
  await page.waitForTimeout(150);
  await page.click('.ed-mode-btn[data-mode="multi"]');
  await page.click("#ed-project-add");
  await page.waitForTimeout(100);
  await page.fill("#ed-np-name", "정보바테스트");
  await page.fill("#ed-np-sites", "A-1, A-2");
  await page.evaluate(() => { document.querySelectorAll("#ed-np-items input[type=checkbox]").forEach((el) => { if (el.value !== "CO") el.checked = false; }); });
  await page.click("#ed-np-create");
  await page.waitForTimeout(200);
  await page.click('.ed-slice-btn[data-axis="item"]');
  await page.waitForTimeout(200);
  const infoBox = await page.locator("#ed-item-slice-info").boundingBox();
  ok("11. 항목정보바 높이가 정상(세로 쪼개짐 없음, 40px 미만)", infoBox.height < 40, `height=${infoBox.height}`);
  const infoWhiteSpace = await page.$eval("#ed-item-slice-info", (el) => getComputedStyle(el).whiteSpace);
  ok("12. 항목정보바에 white-space:nowrap 적용", infoWhiteSpace === "nowrap", infoWhiteSpace);

  ok("13. 콘솔 에러 없음", errors.length === 0, errors.join(" | "));

  await page.screenshot({ path: "/tmp/claude-1000/-mnt-d-claude/c7b738ad-7edf-491d-a806-8ac2192fad80/scratchpad/ref_tabs_final.png", fullPage: true });
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
