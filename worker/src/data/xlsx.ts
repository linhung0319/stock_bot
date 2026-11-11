// 極簡的 xlsx 讀取：只讀第一張工作表的儲存格文字與數字。
// xlsx 是 zip；用 Workers／Node 都內建的 DecompressionStream 解壓，不需要外部套件。

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Response(data).body!.pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 讀出 zip 裡指定路徑的檔案（文字）。找不到回傳 null。 */
export async function unzipText(zip: Uint8Array, wanted: string[]): Promise<Record<string, string>> {
  // End of central directory
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (u32(zip, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是 zip 檔（找不到中央目錄）');
  const count = u16(zip, eocd + 10);
  let p = u32(zip, eocd + 16);
  const out: Record<string, string> = {};
  const dec = new TextDecoder('utf-8');
  for (let n = 0; n < count; n++) {
    if (u32(zip, p) !== 0x02014b50) throw new Error('zip 中央目錄損壞');
    const method = u16(zip, p + 10);
    const compSize = u32(zip, p + 20);
    const nameLen = u16(zip, p + 28);
    const extraLen = u16(zip, p + 30);
    const commentLen = u16(zip, p + 32);
    const local = u32(zip, p + 42);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    if (wanted.includes(name)) {
      const lNameLen = u16(zip, local + 26);
      const lExtraLen = u16(zip, local + 28);
      const start = local + 30 + lNameLen + lExtraLen;
      const raw = zip.subarray(start, start + compSize);
      const bytes = method === 0 ? raw : method === 8 ? await inflateRaw(raw) : null;
      if (!bytes) throw new Error(`zip 壓縮方式 ${method} 不支援`);
      out[name] = dec.decode(bytes);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

export type Cell = string | number | null;

/** 第一張工作表的所有列（每列是儲存格陣列，空格是 null）。 */
export async function readFirstSheet(file: Uint8Array): Promise<Cell[][]> {
  const files = await unzipText(file, ['xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml']);
  const sheet = files['xl/worksheets/sheet1.xml'];
  if (!sheet) throw new Error('xlsx 裡沒有 sheet1');
  const strings: string[] = [];
  const sst = files['xl/sharedStrings.xml'] ?? '';
  for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const t of m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) text += t[1];
    strings.push(decodeXml(text));
  }
  const rows: Cell[][] = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: Cell[] = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      if (!ref) continue;
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const body = cm[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let val: Cell = null;
      if (type === 's' && v !== undefined) val = strings[Number(v)] ?? null;
      else if (type === 'inlineStr') val = decodeXml(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(body)?.[1] ?? '');
      else if (type === 'str' && v !== undefined) val = decodeXml(v);
      else if (v !== undefined) val = Number(v);
      const i = colIndex(ref);
      while (row.length < i) row.push(null);
      row[i] = val;
    }
    rows.push(row);
  }
  return rows;
}
