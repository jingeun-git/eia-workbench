---
tags: [워크벤치, 환경질측정, 기준DB, 요약]
aliases: [lake_life.json 요약]
---

# 호소수질 생활환경기준 DB — `lake_life.json` 요약

> 원본: [[lake_life.json|lake_life.json]] (이 문서는 인덱스 요약본)

- **근거법령**: 환경정책기본법 시행령 별표1(호소 나목2, 제2조 관련), 개정 2025-10-01
- **검증 방법**: `law_client.py annex --mst 280511 --no 0001` 원문 직접 조회(2026-07-22)
- **구조**: [[river_life.md|하천 생활환경기준]]과 동일한 `region + columnsFixed:true` 패턴이지만
  항목이 다르다 — BOD 대신 COD, **총질소(T-N)·클로로필-a(Chl-a) 추가**로 10개 컬럼.
- 판정 방향: pH=range, DO=min, 나머지=max (하천과 동일한 규칙).

관련: [[project_unified_workbench]] · [[river_life.md|하천 생활환경기준]] · [[tasks/specs/2026-07-22-환경질측정데이터분석도구-마스터플랜|마스터플랜]]
