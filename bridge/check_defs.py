#!/usr/bin/env python3
"""모듈 안에서 호출되는 이름이 실제로 정의돼 있는지 검사한다.

`ast.parse`는 문법만 본다 — 함수를 통째로 지워도 "문법 OK"가 나온다.
실제로 2026-07-21 _set_pgct가 다른 치환에 휩쓸려 삭제된 채 배포됐고,
호출부만 남아 실행 시 NameError가 날 상태였다. 그 재발을 막는 검사다.
"""
import ast, builtins, sys
from pathlib import Path


def undefined_calls(path: Path):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    defined = {n.name for n in ast.walk(tree)
               if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
    defined |= {t.id for n in ast.walk(tree) if isinstance(n, ast.Assign)
                for t in n.targets if isinstance(t, ast.Name)}
    defined |= {a.asname or a.name.split(".")[0]
                for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))
                for a in n.names}
    for fn in (n for n in ast.walk(tree)
               if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))):
        defined |= {a.arg for a in fn.args.args + fn.args.kwonlyargs}
        defined |= {t.id for n in ast.walk(fn) if isinstance(n, ast.Assign)
                    for t in n.targets if isinstance(t, ast.Name)}
    known = defined | set(dir(builtins))
    bad = sorted({n.func.id for n in ast.walk(tree)
                  if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
                  and n.func.id not in known})
    return bad


if __name__ == "__main__":
    fail = False
    for p in map(Path, sys.argv[1:]):
        bad = undefined_calls(p)
        print(f"{p.name}: " + ("✗ 미정의 호출 " + ", ".join(bad) if bad else "정의 누락 없음"))
        fail |= bool(bad)
    sys.exit(1 if fail else 0)
