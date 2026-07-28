





















export function decodeTextBytes(bytes) {

  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  const head = bytes.subarray(0, Math.min(bytes.length, 4096));
  const count = (enc) => {
    try { return (new TextDecoder(enc).decode(head).match(/�/g) || []).length; }
    catch (_) { return Infinity; }
  };
  const utf8 = count("utf-8");
  if (utf8 === 0) return new TextDecoder("utf-8").decode(bytes);
  for (const enc of ["euc-kr", "windows-949"]) {
    if (count(enc) < utf8) return new TextDecoder(enc).decode(bytes);
  }
  return new TextDecoder("utf-8").decode(bytes);
}



export async function readWorkbook(XLSX, file) {
  const buf = await file.arrayBuffer();
  if (/\.(csv|txt|tsv)$/i.test(file.name || ""))
    return XLSX.read(decodeTextBytes(new Uint8Array(buf)), { type: "string" });
  return XLSX.read(buf, { type: "array" });
}
