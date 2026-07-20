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
    // 이미 연결된 포트 우선, 아니면 순차 탐색
    const candidates = this.base
      ? [this.base, ...PORTS.map((p) => `http://127.0.0.1:${p}`).filter((b) => b !== this.base)]
      : PORTS.map((p) => `http://127.0.0.1:${p}`);

    for (const base of candidates) {
      try {
        const res = await this._fetch(`${base}/ping`, { timeoutMs: 1500 });
        if (res && res.ok) {
          const info = await res.json();
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
    this._setState("off");
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
    if (res.status === 401) throw new Error("토큰 불일치 — 브리지 트레이 메뉴에서 토큰을 복사해 설정에 입력하세요");
    if (!res.ok) throw new Error(`브리지 오류 HTTP ${res.status}`);
    return res.json();
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
