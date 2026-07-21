---
tags: [워크벤치, 환경질측정, 기준DB, 요약]
aliases: [river_life.json 요약]
---

# 하천수질 생활환경기준 DB — `river_life.json` 요약

> 원본: [[river_life.json|river_life.json]] (이 문서는 인덱스 요약본)

- **근거법령**: 환경정책기본법 시행령 별표1(하천 가목2, 제2조 관련), 개정 2025-10-01
- **검증 방법**: `law_client.py annex --mst 280511 --no 0001` 원문 직접 조회(2026-07-22)
- **구조**: `type: "region", columnsFixed: true` — 소음·진동과 같은 패턴이지만 "지역구분" 대신
  **"목표등급"**(Ia~V, 6단계)을 지점마다 고른다. 컬럼은 9개 고정 항목(pH·BOD·COD·TOC·SS·DO·T-P·
  총대장균군·분원성대장균군).
- **판정 방향이 항목마다 다르다** — pH는 범위(6.5~8.5 등), DO는 "이상"(낮으면 초과), 나머지는
  "이하"(높으면 초과). `periods[].direction`: `range`|`min`|`max`로 구분.
- VI(매우나쁨)등급은 목표로 선택할 수 없게 뺐다(V 초과 판정용이라 목표가 될 수 없음).

관련: [[project_unified_workbench]] · [[river_health.md|하천 사람건강보호기준]] · [[lake_life.md|호소 생활환경기준]] · [[tasks/specs/2026-07-22-환경질측정데이터분석도구-마스터플랜|마스터플랜]]
