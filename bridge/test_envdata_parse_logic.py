"""run_envdata_parse()의 표 선택 로직 유닛 테스트 (SYS-41 9단계, 2026-07-22).

실제 브리지(bridge_server.py 전체)는 Windows+한컴 COM이 필요해 이 저장소
환경에서 통째로 띄울 수 없다 — pdf2excel_core.scan/group을 가짜로 바꿔치기해
run_envdata_parse() 자체의 "표가 여럿이면 행이 가장 많은 것을 고른다" +
"aoa(2차원 배열) 구성" 로직만 검증한다. pdf2excel_core의 실제 PDF 파싱은
99.Tools/pdf2excel/test_pdf2excel.py에서 이미 검증됐다(SYS-30).

실행: python3 test_envdata_parse_logic.py
"""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "pdf2excel"))

import bridge_server as bs
import pdf2excel_core as pc


class FakeTable:
    def __init__(self, header, rows, caption=""):
        self.header = header
        self.rows = rows
        self.caption = caption
        self.page_label = "p.1"
        self.lost_chars = 0


class RunEnvdataParseTest(unittest.TestCase):
    def setUp(self):
        self._orig_scan, self._orig_group = pc.scan, pc.group
        self.fake_pdf = pathlib.Path("/tmp/test_envdata_parse_fake.pdf")
        self.fake_pdf.write_bytes(b"%PDF-1.4 fake")
        bs.ALLOWED_ROOTS.append(pathlib.Path("/tmp"))

    def tearDown(self):
        pc.scan, pc.group = self._orig_scan, self._orig_group
        self.fake_pdf.unlink(missing_ok=True)

    def test_picks_largest_table_and_builds_aoa(self):
        pc.scan = lambda path, spec, progress=None: ["raw1", "raw2"]
        pc.group = lambda raws: [
            FakeTable(["구분", "값"], [["범례", "1"]], caption="작은표(범례)"),
            FakeTable(["측정지점", "SO2"], [["지점1", "0.02"], ["지점2", "0.09"]], caption="본표(측정결과)"),
        ]
        job = {"log": [], "progress": None}
        bs.run_envdata_parse(job, {"path": str(self.fake_pdf)})
        self.assertEqual(job["result"]["aoa"],
                          [["측정지점", "SO2"], ["지점1", "0.02"], ["지점2", "0.09"]])
        self.assertEqual(job["result"]["tableCount"], 2)
        self.assertEqual(job["result"]["caption"], "본표(측정결과)")

    def test_no_tables_raises(self):
        pc.scan = lambda path, spec, progress=None: []
        pc.group = lambda raws: []
        job = {"log": [], "progress": None}
        with self.assertRaises(RuntimeError):
            bs.run_envdata_parse(job, {"path": str(self.fake_pdf)})

    def test_rejects_unsupported_extension(self):
        job = {"log": [], "progress": None}
        bad = pathlib.Path("/tmp/test_envdata_parse_fake.xlsx")
        bad.write_bytes(b"x")
        bs.ALLOWED_ROOTS.append(pathlib.Path("/tmp"))
        try:
            with self.assertRaises(RuntimeError):
                bs.run_envdata_parse(job, {"path": str(bad)})
        finally:
            bad.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
