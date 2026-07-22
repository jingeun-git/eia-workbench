const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:8791";
const results = [];
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond, detail }); };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1600 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  await page.goto(`${BASE}/index.html#envdata`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ed-table thead th[data-col]");

  // 0) 하천/호소 건강보호기준 삭제 확인
  const fieldLabels = await page.$$eval(".ed-field-btn", (els) => els.map((e) => e.textContent));
  ok("0. 하천/호소 사람건강보호기준 드롭다운 삭제됨", !fieldLabels.some((l) => l.includes("건강보호")), JSON.stringify(fieldLabels));

  // 항목 3개만 남기기(대기질 8종 중 5종 삭제) — 실사용 스크린샷(PM10·PM2.5·NO2 3열)과 동일 조건 재현
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => document.querySelectorAll(".ed-col-del")[0].click());
    await page.waitForTimeout(80);
  }
  const remainingLabels = await page.$$eval("#ed-table thead th[data-col] .ed-col-label", (els) => els.map((e) => e.textContent.trim()));
  ok("1. 5개 삭제 후 3개 컬럼만 남음", remainingLabels.length === 3, JSON.stringify(remainingLabels));

  // 1) 실제 HTML 표 붙여넣기 재현(text/plain은 고의로 tab 없이 깨진 형태)
  await page.evaluate(() => {
    const target = document.querySelectorAll("#ed-tbody tr")[0].querySelectorAll(".ed-cell")[0];
    target.focus();
    const dt = new DataTransfer();
    dt.setData("text/plain", "55\n41\n0.023\n57\n43\n0.021\n57\n42\n0.024"); // tab 없는 깨진 형태
    dt.setData("text/html", "<html><body><table><tr><td>55</td><td>41</td><td>0.023</td></tr><tr><td>57</td><td>43</td><td>0.021</td></tr><tr><td>57</td><td>42</td><td>0.024</td></tr></table></body></html>");
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
  });
  await page.waitForTimeout(200);
  const grid1 = await page.evaluate(() => {
    const rows = document.querySelectorAll("#ed-tbody tr");
    return [...rows].slice(0, 3).map((tr) => [...tr.querySelectorAll(".ed-cell")].slice(0, 3).map((c) => c.textContent));
  });
  ok("2. HTML 표 붙여넣기 → 3x3 정확히 배치(html 우선)", JSON.stringify(grid1) === JSON.stringify([["55","41","0.023"],["57","43","0.021"],["57","42","0.024"]]), JSON.stringify(grid1));

  // 2) HTML 없이 tab 없는 평문만 있을 때 재배열 휴리스틱 재현
  await page.click("#ed-reset");
  await page.waitForTimeout(150);
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => document.querySelectorAll(".ed-col-del")[0].click());
    await page.waitForTimeout(80);
  }
  await page.evaluate(() => {
    const target = document.querySelectorAll("#ed-tbody tr")[0].querySelectorAll(".ed-cell")[0];
    target.focus();
    const dt = new DataTransfer();
    dt.setData("text/plain", "10\n20\n0.5\n11\n21\n0.6\n12\n22\n0.7"); // tab 전혀 없음, 9개, 남은열3 → 3x3 재배열 기대
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
  });
  await page.waitForTimeout(200);
  const grid2 = await page.evaluate(() => {
    const rows = document.querySelectorAll("#ed-tbody tr");
    return [...rows].slice(0, 3).map((tr) => [...tr.querySelectorAll(".ed-cell")].slice(0, 3).map((c) => c.textContent));
  });
  ok("3. tab 없는 평문 9개값 → 3열 기준 재배열(3x3)", JSON.stringify(grid2) === JSON.stringify([["10","20","0.5"],["11","21","0.6"],["12","22","0.7"]]), JSON.stringify(grid2));

  // 3) 다중선택 드래그 + Delete
  await page.click("#ed-reset");
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#ed-tbody tr");
    for (let r = 0; r < 3; r++) {
      const cells = rows[r].querySelectorAll(".ed-cell");
      for (let c = 0; c < 3; c++) { cells[c].textContent = `${r}${c}`; cells[c].dispatchEvent(new Event("input", { bubbles: true })); }
    }
  });
  await page.waitForTimeout(150);
  const c00 = page.locator("#ed-tbody tr").nth(0).locator(".ed-cell").nth(0);
  const c11 = page.locator("#ed-tbody tr").nth(1).locator(".ed-cell").nth(1);
  await c11.scrollIntoViewIfNeeded(); // 헤더 패널이 커지면서 표가 아래로 밀릴 수 있어 드래그 전 반드시 스크롤
  const b00 = await c00.boundingBox(), b11 = await c11.boundingBox();
  await page.mouse.move(b00.x + 5, b00.y + 5);
  await page.mouse.down();
  await page.mouse.move(b11.x + 5, b11.y + 5, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const selectedCount = await page.$$eval(".ed-selected", (els) => els.length);
  ok("4. 드래그로 2x2=4개 셀 선택됨", selectedCount === 4, `count=${selectedCount}`);

  await page.keyboard.press("Delete");
  await page.waitForTimeout(150);
  const afterDelete = await page.evaluate(() => {
    const rows = document.querySelectorAll("#ed-tbody tr");
    return [...rows].slice(0, 2).map((tr) => [...tr.querySelectorAll(".ed-cell")].slice(0, 2).map((c) => c.textContent));
  });
  ok("5. Delete로 선택 범위(2x2) 값 삭제됨", afterDelete.every((line) => line.every((v) => v === "")), JSON.stringify(afterDelete));

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
