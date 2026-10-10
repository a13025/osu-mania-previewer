import { unzipSync } from 'fflate';
import { parseOsu, type OsuChart } from './osu';

export interface PickedFile {
  file: File;
  path: string;
}

export interface BundleFile {
  name: string;
  blob: Blob;
}

export interface ChartEntry {
  key: string;
  fileName: string;
  chart: OsuChart | null;
  usable: boolean;
  label: string;
}

export interface Bundle {
  sourceName: string;
  kind: 'osz' | 'folder' | 'files';
  files: Map<string, BundleFile>;
  charts: ChartEntry[];
}

const AUDIO_EXT = ['mp3', 'ogg', 'wav', 'm4a', 'flac', 'aac', 'opus'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'bmp', 'webp', 'gif'];
const SKIP_EXT = /\.(mp4|avi|flv|mkv|wmv|mov|webm|m4v|mpg|mpeg)$/i; // 背景视频不需要，跳过以节省内存

export function normPath(p: string): string {
  let s = p.replace(/\\/g, '/').trim();
  while (s.startsWith('./')) s = s.slice(2);
  return s.replace(/^\/+/, '').toLowerCase();
}

export function baseName(p: string): string {
  const s = p.replace(/\\/g, '/');
  return s.slice(s.lastIndexOf('/') + 1);
}

function extOf(p: string): string {
  const b = baseName(p);
  const i = b.lastIndexOf('.');
  return i >= 0 ? b.slice(i + 1).toLowerCase() : '';
}

/** fflate 对未标记 UTF-8 的文件名按 latin1 解码，这里尝试还原为 UTF-8 / GBK / Shift_JIS */
function recoverName(name: string): string {
  if (!/[\u0080-\u00ff]/.test(name) || /[^\u0000-\u00ff]/.test(name)) return name;
  const bytes = Uint8Array.from(name, (ch) => ch.charCodeAt(0));
  for (const enc of ['utf-8', 'gbk', 'shift_jis']) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(bytes);
    } catch {
      /* try next */
    }
  }
  return name;
}

export function filesFromInput(list: FileList | null): PickedFile[] {
  if (!list) return [];
  return Array.from(list).map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
}

/** 拖放：支持文件与整个文件夹（必须在 drop 事件同步阶段调用 webkitGetAsEntry） */
export async function filesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const entries: FileSystemEntry[] = [];
  for (const it of Array.from(dt.items ?? [])) {
    const e = it.kind === 'file' ? it.webkitGetAsEntry?.() : null;
    if (e) entries.push(e);
  }
  const plain = Array.from(dt.files).map((f) => ({ file: f, path: f.name }));
  if (!entries.length) return plain;
  const out: PickedFile[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, path: entry.fullPath.replace(/^\/+/, '') || file.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out.length ? out : plain;
}

export async function loadBundle(picked: PickedFile[]): Promise<Bundle> {
  if (!picked.length) throw new Error('未选择文件');
  const files = new Map<string, BundleFile>();
  let sourceName = '';
  let kind: Bundle['kind'] = 'files';

  const archive = picked.find((p) => /\.(osz|zip)$/i.test(p.file.name));
  if (archive) {
    kind = 'osz';
    sourceName = archive.file.name;
    const data = new Uint8Array(await archive.file.arrayBuffer());
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(data, { filter: (f) => !SKIP_EXT.test(f.name) });
    } catch (e) {
      throw new Error('压缩包解析失败：' + (e instanceof Error ? e.message : String(e)));
    }
    for (const [rawName, bytes] of Object.entries(entries)) {
      if (rawName.endsWith('/')) continue;
      const name = recoverName(rawName);
      files.set(normPath(name), { name, blob: new Blob([bytes as BlobPart]) });
    }
  } else {
    const paths = picked.map((p) => p.path.replace(/\\/g, '/'));
    const firstSeg = paths[0].includes('/') ? paths[0].split('/')[0] : '';
    const sameRoot = firstSeg !== '' && paths.every((p) => p.startsWith(firstSeg + '/'));
    if (sameRoot) {
      kind = 'folder';
      sourceName = firstSeg;
    }
    picked.forEach((p, i) => {
      const rel = sameRoot ? paths[i].slice(firstSeg.length + 1) : paths[i];
      files.set(normPath(rel), { name: rel, blob: p.file });
    });
    if (!sourceName) sourceName = picked.find((p) => /\.osu$/i.test(p.file.name))?.file.name ?? picked[0].file.name;
  }

  const charts: ChartEntry[] = [];
  for (const [key, f] of files) {
    if (extOf(key) !== 'osu') continue;
    const fileName = baseName(f.name);
    try {
      const chart = parseOsu(await f.blob.text());
      const usable = chart.mode === 3 && chart.keys === 4;
      const tag = chart.mode !== 3 ? '非 mania' : `${chart.keys}K`;
      charts.push({
        key,
        fileName,
        chart,
        usable,
        label: `${chart.version || fileName}（${tag}${usable ? ` · ${chart.notes.length} 物件` : ' · 不支持'}）`,
      });
    } catch {
      charts.push({ key, fileName, chart: null, usable: false, label: `${fileName}（解析失败）` });
    }
  }
  charts.sort(
    (a, b) =>
      Number(b.usable) - Number(a.usable) ||
      (a.chart?.notes.length ?? 0) - (b.chart?.notes.length ?? 0) ||
      a.label.localeCompare(b.label),
  );
  if (!charts.length) throw new Error('没有找到 .osu 铺面文件');
  return { sourceName, kind, files, charts };
}

/** 读取铺面指定的音频 / 背景图；找不到时按文件名 audio.* 或最大文件兜底 */
export function findAsset(bundle: Bundle, wanted: string | null, kind: 'audio' | 'image'): BundleFile | null {
  const exts = kind === 'audio' ? AUDIO_EXT : IMAGE_EXT;
  if (wanted) {
    const k = normPath(wanted);
    const hit = bundle.files.get(k);
    if (hit) return hit;
    const b = baseName(k);
    for (const [key, f] of bundle.files) if (baseName(key) === b) return f;
  }
  const cands = [...bundle.files.entries()].filter(([k]) => exts.includes(extOf(k)));
  if (!cands.length) return null;
  if (kind === 'audio') {
    const named = cands.find(([k]) => baseName(k).replace(/\.[^.]+$/, '') === 'audio');
    if (named) return named[1];
  }
  cands.sort((a, b) => b[1].blob.size - a[1].blob.size);
  return cands[0][1];
}
