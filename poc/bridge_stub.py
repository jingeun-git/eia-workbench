#!/usr/bin/env python3
"""
SYS-29 1단계 PoC — 로컬 브리지 통신 실증 스텁

목적: HTTPS로 서비스되는 GitHub Pages 페이지가 http://127.0.0.1 로
      요청을 보낼 수 있는지를 실측한다. 검증 대상 2가지:

  ① Mixed Content 예외
     브라우저는 127.0.0.1/localhost를 "potentially trustworthy origin"으로
     취급해 HTTPS→HTTP 차단에서 면제한다고 알려져 있으나, 실측이 필요하다.

  ② Private Network Access (PNA) 프리플라이트
     Chrome은 public 주소공간(github.io) → local 주소공간(127.0.0.1) 요청에
     프리플라이트를 요구하고, 응답에 다음 헤더를 강제한다:
         Access-Control-Allow-Private-Network: true
     이 스텁은 그 헤더를 붙인 경우와 붙이지 않은 경우를 모두 제공해
     실제로 강제되는지를 가려낸다.

의존성 없음(표준 라이브러리만) — 어떤 Python 3.8+ 환경에서도 그대로 실행된다.

사용법:
    python3 bridge_stub.py                # 127.0.0.1:8765 로 기동
    python3 bridge_stub.py --port 9000

엔드포인트:
    GET /ping        PNA 헤더 O — 정상 동작해야 하는 경로
    GET /ping-nopna  PNA 헤더 X — PNA가 강제되면 여기만 실패해야 한다
    GET /version     브리지 메타 정보
"""

import argparse
import json
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer

BRIDGE_VERSION = "0.1.0-poc"

# 실제 브리지에서는 배포된 Pages 오리진만 허용하도록 좁힌다.
# PoC 단계에서는 어떤 오리진에서 시도해도 결과를 보기 위해 에코 방식을 쓴다.
ALLOW_ANY_ORIGIN = True

# 타입 힌트를 쓰지 않는다 — list[dict] 표기는 Python 3.8에서 TypeError를 낸다.
# 이 스텁은 사용자 PC의 임의 Python에서 그대로 돌아가야 한다.
_log = []


class Handler(BaseHTTPRequestHandler):
    # 기본 로그가 과하게 시끄러워 억제하고 필요한 것만 직접 찍는다
    def log_message(self, fmt, *args):
        pass

    # ── 공통 헤더 ────────────────────────────────────────────────────────
    def _cors(self, with_pna: bool):
        origin = self.headers.get("Origin", "*")
        self.send_header("Access-Control-Allow-Origin", origin if ALLOW_ANY_ORIGIN else origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Vary", "Origin")
        if with_pna:
            # 이 헤더가 PNA 프리플라이트의 핵심이다
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, payload: dict, status: int = 200, with_pna: bool = True):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors(with_pna)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _record(self, kind: str):
        entry = {
            "time": datetime.now().strftime("%H:%M:%S"),
            "kind": kind,
            "path": self.path,
            "origin": self.headers.get("Origin", "-"),
            "pna_request": self.headers.get("Access-Control-Request-Private-Network", "-"),
        }
        _log.append(entry)
        pna = entry["pna_request"]
        mark = "  [PNA 요청됨]" if pna == "true" else ""
        # flush 필수 — 버퍼링되면 사용자 터미널에 요청이 실시간으로 안 찍혀
        # "브라우저가 차단당한 것"과 구분이 안 된다. 이 스텁의 판정 근거가 바로 이 출력이다.
        print(f"  {entry['time']}  {kind:9s} {self.path:14s} origin={entry['origin']}{mark}", flush=True)

    # ── 프리플라이트 ─────────────────────────────────────────────────────
    def do_OPTIONS(self):
        self._record("PREFLIGHT")
        # /ping-nopna 만 의도적으로 PNA 헤더를 뺀다
        with_pna = not self.path.startswith("/ping-nopna")
        self.send_response(204)
        self._cors(with_pna)
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    # ── 본 요청 ──────────────────────────────────────────────────────────
    def do_GET(self):
        self._record("GET")

        if self.path.startswith("/ping-nopna"):
            self._json({
                "ok": True,
                "endpoint": "/ping-nopna",
                "pna_header_sent": False,
                "note": "이 응답이 보이면 PNA가 강제되지 않는 환경이다",
            }, with_pna=False)

        elif self.path.startswith("/ping"):
            self._json({
                "ok": True,
                "endpoint": "/ping",
                "pna_header_sent": True,
                "bridge_version": BRIDGE_VERSION,
                "note": "브리지 통신 성립",
            })

        elif self.path.startswith("/version"):
            self._json({
                "ok": True,
                "bridge_version": BRIDGE_VERSION,
                "request_log": _log[-20:],
            })

        else:
            self._json({"ok": False, "error": "unknown endpoint"}, status=404)


def main():
    ap = argparse.ArgumentParser(description="SYS-29 브리지 통신 PoC 스텁")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    srv = HTTPServer((args.host, args.port), Handler)
    print("=" * 62)
    print("  SYS-29 브리지 통신 PoC 스텁")
    print("=" * 62)
    print(f"  주소   : http://{args.host}:{args.port}")
    print(f"  버전   : {BRIDGE_VERSION}")
    print()
    print("  이 창을 켜 둔 채로, GitHub Pages에 올린 bridge_poc.html 을")
    print("  Chrome에서 열고 [전체 검사 실행]을 누르세요.")
    print()
    print("  아래에 요청이 찍히면 브라우저가 로컬 접근에 성공한 것입니다.")
    print("  아무것도 안 찍히면 브라우저 단계에서 차단된 것입니다.")
    print("  종료: Ctrl+C")
    print("-" * 62)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  종료했습니다.")


if __name__ == "__main__":
    main()
