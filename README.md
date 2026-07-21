# EIA 통합 업무도구 (Unified Workbench)

환경영향평가 실무 도구를 단일 웹 UI로 통합하는 프로젝트입니다.
개별 HTML·exe·py로 흩어져 있던 도구들을 GitHub Pages 한 곳에서 쓰도록 재편합니다.

> 추적: `tasks/todo/SYS-29.json` · 설계: `tasks/specs/2026-07-20-통합업무도구-웹화-design.md`(2단계에서 작성)

## 구조 — 하이브리드

브라우저만으로 되는 것과 안 되는 것이 명확히 갈려서 2계층으로 갑니다.

```
[GitHub Pages 웹 UI]              ← 설치 불필요, URL만 열면 끝
   ├─ md 변환 (경량)
   ├─ EIASS 다운로더 (FILE_SEQ)
   └─ 건축물대장 조회            ← 브라우저 완결
              ↕ http://127.0.0.1
[로컬 브리지]                     ← 실행 중일 때만 활성화
   ├─ 한컴 2종 (hwp2pdf·hwpPageNum) ※차례·끼워넣기는 2026-07-20 기능 삭제
   ├─ md 변환 — 한글·스캔·일괄 (convert_core.py — HWP/HWPX·OCR·듀얼엔진)
   └─ EIASS 사업코드 자동탐색 (eiass_doc_resolver.py)
```

브리지가 꺼져 있어도 웹 3종은 정상 동작합니다. 기능이 사라지는 게 아니라 경량 모드로 내려갑니다.

### 왜 브리지가 필요한가

| 기능 | 브라우저 단독 | 사유 |
|---|---|---|
| 건축물대장 조회 | ✅ 가능 | vworld는 JSONP로 CORS 우회, data.go.kr은 `ACAO: *` |
| md 변환 (PDF) | ✅ 가능 | PDF.js 클라이언트사이드 |
| md 변환 (HWP·OCR) | ❌ 불가 | 한컴 포맷·OCR 엔진이 브라우저에 없음 |
| EIASS 사업코드 탐색 | ❌ 불가 | 검색 API가 `ACAO` 헤더를 2개 반환 — CORS 스펙 위반이라 브라우저가 무조건 거부 |
| 한컴 4종 | ❌ 불가 | 설치된 한글을 COM으로 조종. 쪽번호·차례는 한글 조판 엔진이 있어야 산출됨 |

## API 키 취급

**키를 코드에 넣지 않습니다.** 사용자가 자기 키를 직접 발급해 브라우저에 입력하고 localStorage에 보관합니다
(현행 건축물대장 exe의 `load_api_keys()`와 동일한 설계). 이 저장소는 Pages 무료 호스팅 때문에 Public이므로,
키를 코드에 두면 그대로 노출됩니다. `.gitignore`가 키 파일 계열을 차단합니다.

## 진행 상태 (SYS-29)

| 단계 | 상태 |
|---|---|
| 1. 브리지 통신 PoC | ✅ 실측 통과 — 진단 페이지 `poc/` |
| 2. 설계 스펙 | ✅ `tasks/specs/2026-07-20-통합업무도구-웹화-design.md` |
| 3. 디자인 시스템 | ✅ `shared/tokens.css` + `docs/design-system.md` |
| 4. 건축물대장 | ✅ 실브라우저 검증 통과 (SHP·주소 모드) |
| 5. md 변환 | ✅ 웹 경로 검증 통과 + 브리지 경로(한글·스캔·일괄) 연결 |
| 6. EIASS | ✅ 검증 통과 — FILE_SEQ·사업코드(절차 그룹핑)·사후(연도별 회차→PDF 선택) |
| 7. 로컬 브리지 | ✅ Windows 실검증 통과 — 원클릭 페어링(run_bridge.bat) |
| 8. 문서 | ✅ `사용법.md` |

### 구조

- `index.html` — 셸 (탭 5종·브리지 상태칩·테마·설정)
- `shared/` — tokens.css · ui.css · app.js · bridge.js(pollJob 포함) · geo.js(18케이스 검증)
- `modules/` — parcel(건축물대장) · md(웹+브리지 2경로) · eiass(FILE_SEQ+사업코드+사후회차) · hwp(pdf·pagenum)
- `bridge/` — bridge_server.py (기존 도구 import/서브프로세스 참조 — 복제 없음) + `run_bridge.bat`
- `vendor/` — shpjs·proj4·xlsx-js-style·pdf.js·mammoth·Pretendard (전부 동봉, 런타임 CDN 없음)

사용법: [사용법.md](사용법.md)

## 범위 제외

**EIAViewer**는 별도 배포합니다 — 단일 HTML이 71MB(임베딩 GeoJSON 62MB)라 저장소에 넣으면
빌드마다 히스토리가 영구 팽창하고, EIAGIS WFS가 HTTP(mixed content)·HTTPS(오리진 잠김) 양쪽 다
막혀 있어 별도 프록시 설계가 선행되어야 합니다.
