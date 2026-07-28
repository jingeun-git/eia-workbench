






















export const ROMAN_TO_ASCII = {
  "Ⅰ": "I", "Ⅱ": "II", "Ⅲ": "III", "Ⅳ": "IV", "Ⅴ": "V", "Ⅵ": "VI", "Ⅶ": "VII", "Ⅷ": "VIII", "Ⅸ": "IX", "Ⅹ": "X",
  "ⅰ": "I", "ⅱ": "II", "ⅲ": "III", "ⅳ": "IV", "ⅴ": "V", "ⅵ": "VI", "ⅶ": "VII", "ⅷ": "VIII", "ⅸ": "IX", "ⅹ": "X",
};
export function romanToAscii(s) {
  return String(s ?? "").replace(/[Ⅰ-Ⅹⅰ-ⅹ]/g, (c) => ROMAN_TO_ASCII[c] || c);
}



export function isExceed(std, value) {
  if (!std || value == null) return false;
  const dir = std.direction || "max";
  if (dir === "range") { const [mn, mx] = std.value; return value < mn || value > mx; }
  if (dir === "min") return value < std.value;
  return value > std.value;
}


export function hasGradeScale(standards) {
  return !!standards && standards.type === "region"
    && standards.columnsFixed !== false && standards.regionLabel === "목표등급";
}






export function achievedGrade(standards, code, value) {
  if (!hasGradeScale(standards) || value == null || Number.isNaN(value)) return null;
  const period = (standards.periods || []).find((p) => p.code === code);
  if (!period) return null;
  const regions = standards.regions || [];
  let lastDefined = -1;
  for (let i = 0; i < regions.length; i++) {
    const raw = regions[i][code];


    if (raw == null) continue;
    lastDefined = i;
    const std = { value: raw, direction: Array.isArray(raw) ? "range" : (period.direction || "max") };
    if (!isExceed(std, value)) return { rank: i, code: regions[i].code, label: regions[i].label, over: false };
  }
  if (lastDefined < 0) return null;



  if (lastDefined === regions.length - 1 && standards.worstGrade)
    return { rank: regions.length, code: standards.worstGrade.code, label: standards.worstGrade.label, over: false };
  return { rank: lastDefined + 0.5, code: regions[lastDefined].code,
           label: `${regions[lastDefined].label} 초과`, over: true };
}


export function gradeCellText(standards, code, value) {
  const g = achievedGrade(standards, code, value);
  if (!g) return "";
  return g.over ? `(${g.code}등급 초과)` : `(${g.code}등급)`;
}


export const GRADE_NONE_TEXT = "( - )";
