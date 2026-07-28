












export async function loadShared(path, V) {
  const url = `../shared/${path}`;
  const attempts = V ? [`${url}?v=${V}`, url] : [url];
  const errs = [];
  for (const u of attempts) {
    try {
      return await import( u);
    } catch (e) {
      errs.push(`${u} → ${e?.message || e}`);
    }
  }
  const err = new Error(
    `공용 모듈 ${path} 를 불러오지 못했습니다.\n` +
    `네트워크·보안 프로그램이 차단했을 수 있습니다.\n` + errs.join("\n"));
  err.attempts = errs;
  throw err;
}
