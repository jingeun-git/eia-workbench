# envdata(환경질 측정 데이터 분석) Playwright 회귀 스위트

`modules/envdata.js`(SYS-41~61) 전용 브라우저 회귀 테스트 26개 파일, 총 271건.
2026-07-22까지 매 변경마다 이 스위트 전체를 실행해 실패 0건을 확인한 뒤 배포했다.
그동안 세션 임시 스크래치패드(`/tmp`)에만 있어 세션이 끝나면 사라지는 상태였다 — 이번에 저장소로 이관.

`fixtures/` — verify10.js·verify24.js가 쓰는 xlsx 실물 파일 3개(messy_air·flipped_noise·
river_life_region). 저장소 이관 당시 이 파일들만 누락돼 있었던 걸 발견해 재생성했다
(2026-07-22) — 재생성 중 실제 매칭 버그(findRegionByAlias exact-match 우선순위, 아래 참조)를
하나 더 찾아냈으니, 이 파일들을 지우고 다시 만들 때는 raw 등급명(코드 접미사 없이 "좋음"처럼
다른 등급명의 부분문자열이 되는 값)으로 꼭 검증할 것.

## 실행 방법

다른 `tests/*.mjs`(jsdom 기반 `dom_harness.mjs`)와 달리 이 스위트는 **실제 브라우저**(Playwright
Chromium)로 돌린다 — select 옵션 전환·flex 레이아웃 오버플로처럼 jsdom이 재현 못 하는 렌더링
버그(SYS-53 등)를 잡으려면 실제 렌더가 필요했기 때문이다.

```bash
# 1) 정적 서버로 unified_workbench를 띄운다 (포트는 자유, 아래는 예시)
cd 99.Tools/unified_workbench && python3 -m http.server 8791 &

# 2) Playwright 설치(최초 1회) — WSL은 libasound.so.2가 시스템에 없어 Chromium이
#    기동 실패할 수 있다. apt로 설치 권한이 없으면 .deb를 받아 직접 풀어 LD_LIBRARY_PATH로 지정.
npm install playwright   # 또는 이미 있는 node_modules 재사용

# 3) 각 파일을 개별 실행 (BASE 상수가 http://127.0.0.1:8791로 고정돼 있음 — 포트 바꾸면 파일 내 수정)
cd tests/envdata
LD_LIBRARY_PATH=<libasound.so.2가 있는 경로> node verify.js
```

각 파일은 `process.exit(fail ? 1 : 0)`으로 종료하므로 CI 연동 시 그대로 셸 종료코드를 쓸 수 있다.

## 파일별 범위 (대략 첫 검증 항목으로 요약, 상세는 파일 내 `ok(...)` 라벨 참조)

| 파일 | 건수 | 범위 |
|---|---|---|
| verify.js | 17 | 초기 로드·탭 전환·콘솔 에러, ppm/ppb 단위전환 |
| verify2.js | 9 | 기준값 pristine 로드 회귀 |
| verify4.js | 10 | 분야 전환(대기질 기본 8항목) |
| verify5.js | 7 | 소음 값 입력 시 차트(낮/밤) 생성 |
| verify6.js | 12 | 분야 목록 7개(건강보호기준 제외), 호소생활환경 10항목 |
| verify7.js | 13 | 지하수질 44항목, 토양 우려/대책기준 판정(SYS-56 토글 방식으로 보정됨), 행/열 전환 |
| verify8.js | 7 | 하천/호소 사람건강보호기준 드롭다운 삭제 확인, 셀 드래그선택·Delete |
| verify9.js | 13 | 차트 카드 생성, Y축 수동설정, 제목/범례 토글 |
| verify10.js | 12 | xlsx 스마트업로드 헤더 인식(관리열 제외), 하천 지역구분 자동인식 |
| verify11.js | 18 | 필드선택 UI 개편, 그래프 일괄적용 실시간 전파 |
| verify12.js | 10 | 기준표 셀 정렬, PNG 내보내기 해상도·배경색 |
| verify13.js | 7 | 그래프 컨트롤 슬라이더 DOM 안정성, line 전환 전파 |
| verify14.js | 19 | 다중분석 모드 배너, 새로고침 후 프로젝트 영속 |
| verify15.js | 10 | 다중분석 지점슬라이스, 토양 항목슬라이스 fixedRegion(SYS-56 토글 방식으로 보정됨), 엑셀 내보내기 |
| verify16.js | 6 | 다중분석 지점 추가/삭제, 새로고침 영속 |
| verify17.js | 10 | 자동저장 안내문구, 항목정보바(SO2 등) 텍스트, 회차 삭제 |
| verify18.js | 15 | 관련기준 참고패널(SYS-51 탭구조 + SYS-54 편집성 멘트 제거 반영) — 도로/철도/생활소음/축사 각 탭 내용 |
| verify19.js | 13 | 참고패널 탭 리셋, 항목슬라이스 정보바 줄바꿈 |
| verify20.js | 7 | 첨자 유니코드 헤더(SO₂·PM₁₀·PM₂.₅) xlsx 업로드 매칭(SYS-52) |
| verify21.js | 5 | 항목슬라이스 정보바-글자크기 컨트롤 오버플로 수정 검증(SYS-53) |
| verify22.js | 17 | **소음/진동 지점별 관련기준 선택 + 지역구분 연동, 토양 우려/대책 토글**(SYS-56 핵심) |
| verify23.js | 6 | **다중분석에서 관련기준이 조사지점 단위로 유지**(지점슬라이스·새회차 재진입·새로고침 영속, SYS-56) |
| verify24.js | 4 | **findRegionByAlias exact-match 우선순위 버그**(SYS-59) — "좋음"이 "매우좋음"의 부분문자열이라 Ib 대신 Ia로 오판정되던 것 수정 |
| verify25.js | 6 | **다중분석에 행/열전환 버튼 부재 + 단일→다중 전환 시 상태 누출**(SYS-60) — 버튼 자체가 다중분석엔 없었고, 있었어도 전환 이력이 기본값으로 안 리셋되던 버그 수정 |
| verify26.js | 12 | **"분석 요약" 신규 기능**(SYS-61) — 표와 그래프 사이, 단일/지점슬라이스=항목별, 항목슬라이스=지점무시 전체+지점별 세부, 목표등급 분야만 등급범위 표시. 한 표에 관련기준(소음·진동의 환경기준/축사 등)이 섞이면 기준별로 나눠 범위를 잡음(전체를 한 범위로 뭉치지 않음). 검증 중 newRound 입력폼 stale sliceAxis 오분류·다수초과 중복표기 버그도 발견·수정 |
| verify27.js | 6 | **브리지 HWP·PDF 자동인식 프론트엔드 배선**(SYS-41 6단계) — `/ping`·`/pick`·`/jobs`(POST+GET)를 모두 mock해 브리지 연결 감지→"문서 선택…" 버튼 노출→pick→job 등록→poll→`applyAoaToGrid`까지 전 구간 검증. 브리지 쪽 `run_envdata_parse()`의 "가장 큰 표 선택" 로직은 `bridge/test_envdata_parse_logic.py`(파이썬 유닛, 별도)로 검증 — 실제 한컴 COM 경로(HWP→PDF)는 Windows 전용이라 이 환경에서 종단 검증 불가 |

## 알아둘 것

- `verify.js`의 마지막 콘솔에러 검사 2건은 브리지(포트 8765~8770) 미연결 폴링 노이즈라 무관 — 항상 FAIL로 뜨는 게 정상이다.
- verify7·verify15는 원래 토양 우려/대책기준을 **항상 동시 판정**하던 구 방식을 검증했으나, SYS-56에서
  표 상단 토글(우려기준/대책기준 중 하나만 판정)로 바뀌면서 토글 전환 단계를 추가해 보정했다.
- 새 검증을 추가할 때는 `verify27.js`부터 이어서 번호를 매기고, 이 표에 한 줄 추가할 것.
- `bridge/test_envdata_parse_logic.py`(파이썬)는 이 스위트(JS/Playwright)와 별개다 — 브리지 서버 로직은 `bridge/` 안에서 `python3 test_envdata_parse_logic.py -v`로 돌린다.
