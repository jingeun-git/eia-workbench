/* 로컬 브리지 클라이언트 (SYS-29)
 * 실측 확정 사항(2026-07-20 PoC)을 그대로 구현한다:
 *  - fetch에 targetAddressSpace:'loopback' (Chrome, 'local' 아님 — 실측 ⓓ)
 *  - Origin 헤더는 신뢰·사용하지 않음 (경로상 변조 실측 ⓒ) → 토큰 인증
 *  - 캐시 금지 (PoC 캐시 오진 사고 재발 방지)
 */

const PORTS = [8765, 8766, 8767, 8768, 8769, 8770];
const PING_INTERVAL = 15000;

export class BridgeClient extends EventTarget {
  constructor() {
    super();
    this.base = null;          // 연결된 베이스 URL
    this.info = null;          // /ping 응답 (버전·기능 목록)
    this.state = "checking";   // checking | ok | off
    this._timer = null;
  }

  get token() { return localStorage.getItem("eiaw.bridge.token") || ""; }
  set token(v) { localStorage.setItem("eiaw.bridge.token", v || ""); }

  start() {
    this._probe();
    this._timer = setInterval(() => this._probe(), PING_INTERVAL);
  }

  async _probe() {
    // 우선순위: 연결 중 포트 → 페어링 힌트 포트 → 순차 탐색
    const hinted = localStorage.getItem("eiaw.bridge.port");
    const all = PORTS.map((p) => `http://127.0.0.1:${p}`);
    if (hinted) {
      const hb = `http://127.0.0.1:${hinted}`;
      if (!all.includes(hb)) all.unshift(hb);
      else all.sort((a, b) => (a === hb ? -1 : b === hb ? 1 : 0));
    }
    const candidates = this.base
      ? [this.base, ...all.filter((b) => b !== this.base)]
      : all;

    let stubFound = false;
    for (const base of candidates) {
      try {
        const res = await this._fetch(`${base}/ping`, { timeoutMs: 1500 });
        if (res && res.ok) {
          const info = await res.json();
          // features가 없으면 진짜 브리지가 아니라 PoC 진단 스텁이다 —
          // 실사고(2026-07-20): 스텁이 8765를 점유한 채 살아있어 칩은 "연결됨"인데
          // 모든 기능 호출이 Failed to fetch로 죽는 혼동 발생. 명시 구분한다.
          if (!info.features) { stubFound = true; continue; }
          const changed = this.state !== "ok" || this.base !== base;
          this.base = base;
          this.info = info;
          this._setState("ok", changed);
          return;
        }
      } catch (_) { /* 다음 포트 */ }
    }
    this.base = null;
    this.info = null;
    this._setState(stubFound ? "stub" : "off");
  }

  _setState(s, force = false) {
    if (this.state !== s || force) {
      this.state = s;
      this.dispatchEvent(new CustomEvent("change", { detail: { state: s, info: this.info } }));
    }
  }

  /** 브리지 API 호출 (토큰 자동 부착) */
  async call(path, { method = "GET", body, timeoutMs = 30000 } = {}) {
    if (!this.base) throw new Error("브리지 미연결");
    const res = await this._fetch(`${this.base}${path}`, {
      method, timeoutMs,
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { "Authorization": `Bearer ${this.token}` } : {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) throw new Error("토큰 불일치 — 브리지를 재시작하면 자동 재등록됩니다");
    if (!res.ok) {
      // 서버가 보낸 실제 사유를 살린다 — "HTTP 500"만 보여주면 원인 추적이 불가능
      // (2026-07-20 실사고: 구버전 브리지의 명확한 오류 메시지가 숫자에 가려짐)
      let detail = "";
      try { detail = (await res.json()).error || ""; } catch (_) {}
      throw new Error(detail || `브리지 오류 HTTP ${res.status}`);
    }
    return res.json();
  }

  /** 장시간 작업 폴링 — 새 로그 라인·진행 상태를 콜백으로 전달, 종료 시 resolve */
  async pollJob(jobId, { onLog, onProgress, intervalMs = 1000 } = {}) {
    let logOffset = 0;
    for (;;) {
      const j = await this.call(`/jobs/${jobId}?log_from=${logOffset}`, { timeoutMs: 15000 });
      for (const line of j.log || []) { onLog?.(line); logOffset++; }
      onProgress?.(j.progress || null);
      if (j.status === "done") return j;
      if (j.status === "error") throw new Error(j.error || "브리지 작업 실패");
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  _fetch(url, { timeoutMs = 5000, ...opts } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const init = { ...opts, cache: "no-store", signal: ctrl.signal };
    // Chrome 전용 옵션 — 미지원 브라우저는 무시됨. 'loopback'이 정답(실측 ⓓ).
    try { init.targetAddressSpace = "loopback"; } catch (_) {}
    return fetch(url, init).finally(() => clearTimeout(t));
  }
}

export const bridge = new BridgeClient();
