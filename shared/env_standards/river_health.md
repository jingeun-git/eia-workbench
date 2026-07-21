---
tags: [워크벤치, 환경질측정, 기준DB, 요약]
aliases: [river_health.json 요약]
---

# 하천수질 사람건강보호기준 DB — `river_health.json` 요약

> 원본: [[river_health.json|river_health.json]] (이 문서는 인덱스 요약본)

- **근거법령**: 환경정책기본법 시행령 별표1(하천 가목1, 제2조 관련), 개정 2025-10-01
- **검증 방법**: `law_client.py annex --mst 280511 --no 0001` 원문 직접 조회(2026-07-22)
- **구조**: `type: "item"` — 대기질과 동일한 단순 임계값 방식, 20개 유해물질(mg/L)
- 시안·수은·유기인·PCB 4종은 원문상 "검출되어서는 안 됨"(정성적) — 판정 편의상 0으로 코딩
- **호소수질의 사람건강보호기준과 완전히 동일**(원문이 "가목1)과 같다"고 준용 규정만 둠) → [[lake_health.md]]

관련: [[project_unified_workbench]] · [[river_life.md|하천 생활환경기준]] · [[tasks/specs/2026-07-22-환경질측정데이터분석도구-마스터플랜|마스터플랜]]
