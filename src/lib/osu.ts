// .osu 解析 + SV（变速）位移映射
// 位置计算采用「方案 B」：按累计位移积分（sequential scroll），
// 任意时刻 note 的位置 = (D(noteTime) - D(now)) * speed，D 单调递增 => 不会出现 note 追及 / 交叉。

export interface HitNote {
  col: number;
  start: number; // ms
  end: number; // ms（普通 note 与 start 相同）
  ln: boolean;
}

export interface TimingPoint {
  time: number;
  beatLength: number;
  uninherited: boolean;
}

export interface OsuChart {
  title: string;
  titleUnicode: string;
  artist: string;
  artistUnicode: string;
  creator: string;
  version: string;
  mode: number;
  keys: number;
  audioFilename: string;
  bgFilename: string | null;
  timingPoints: TimingPoint[];
  notes: HitNote[];
  firstTime: number;
  lastTime: number;
}

// 背景事件：0,0,"bg.jpg",0,0（文件名可能带引号且含逗号）
const BG_RE = /^(?:0|Background)\s*,\s*[^,]*,\s*(?:"([^"]*)"|([^,]+))/;

export function parseOsu(text: string): OsuChart {
  const c: OsuChart = {
    title: '',
    titleUnicode: '',
    artist: '',
    artistUnicode: '',
    creator: '',
    version: '',
    mode: 0,
    keys: 4,
    audioFilename: '',
    bgFilename: null,
    timingPoints: [],
    notes: [],
    firstTime: 0,
    lastTime: 0,
  };
  let section = '';
  let cs = 4;
  const objects: string[] = [];

  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1).trim();
      continue;
    }
    if (section === 'General' || section === 'Metadata' || section === 'Difficulty') {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (section === 'General') {
        if (k === 'AudioFilename') c.audioFilename = v;
        else if (k === 'Mode') c.mode = parseInt(v, 10) || 0;
      } else if (section === 'Metadata') {
        if (k === 'Title') c.title = v;
        else if (k === 'TitleUnicode') c.titleUnicode = v;
        else if (k === 'Artist') c.artist = v;
        else if (k === 'ArtistUnicode') c.artistUnicode = v;
        else if (k === 'Creator') c.creator = v;
        else if (k === 'Version') c.version = v;
      } else if (k === 'CircleSize') {
        const n = parseFloat(v);
        if (Number.isFinite(n)) cs = n;
      }
    } else if (section === 'Events') {
      if (c.bgFilename === null) {
        const m = BG_RE.exec(line);
        if (m) {
          const name = (m[1] ?? m[2] ?? '').trim();
          if (name) c.bgFilename = name;
        }
      }
    } else if (section === 'TimingPoints') {
      const p = line.split(',');
      if (p.length < 2) continue;
      const time = parseFloat(p[0]);
      const beatLength = parseFloat(p[1]);
      if (!Number.isFinite(time)) continue;
      const uninherited = p.length >= 7 ? p[6].trim().startsWith('1') : beatLength > 0;
      c.timingPoints.push({ time, beatLength, uninherited });
    } else if (section === 'HitObjects') {
      objects.push(line);
    }
  }

  c.keys = Math.max(1, Math.round(cs));
  for (const line of objects) {
    const p = line.split(',');
    if (p.length < 4) continue;
    const x = parseFloat(p[0]);
    const start = parseFloat(p[2]);
    const type = parseInt(p[3], 10);
    if (!Number.isFinite(x) || !Number.isFinite(start) || !Number.isFinite(type)) continue;
    const col = Math.min(c.keys - 1, Math.max(0, Math.floor((x * c.keys) / 512)));
    let end = start;
    let ln = false;
    if (type & 128 && p.length >= 6) {
      const e = parseFloat(p[5].split(':')[0]);
      if (Number.isFinite(e) && e > start) {
        end = e;
        ln = true;
      }
    }
    c.notes.push({ col, start, end, ln });
  }
  c.notes.sort((a, b) => a.start - b.start || a.col - b.col);
  c.firstTime = c.notes.length ? c.notes[0].start : 0;
  c.lastTime = c.notes.reduce((m, n) => Math.max(m, n.end), 0);
  return c;
}

// ---------------------------------------------------------------- SV / BPM

export function clampBeatLength(bl: number): number {
  if (!Number.isFinite(bl)) return 500;
  return Math.min(60000, Math.max(6, bl));
}

/** 主 BPM（持续时间最长的 beatLength），与 osu! 计算 mania 滚动速度的方式一致 */
export function mostCommonBeatLength(chart: OsuChart): number | null {
  const reds = chart.timingPoints.filter((p) => p.uninherited).sort((a, b) => a.time - b.time);
  if (!reds.length) return null;
  const last = chart.notes.length ? chart.lastTime : reds[reds.length - 1].time;
  const acc = new Map<number, number>();
  reds.forEach((p, i) => {
    const key = Math.round(clampBeatLength(p.beatLength) * 1000) / 1000;
    let dur = 0;
    if (p.time <= last) {
      const cur = i === 0 ? 0 : p.time;
      const next = i === reds.length - 1 ? last : Math.min(reds[i + 1].time, last);
      dur = Math.max(0, next - cur);
    }
    acc.set(key, (acc.get(key) ?? 0) + dur);
  });
  let best = clampBeatLength(reds[0].beatLength);
  let bestDur = 0;
  for (const [bl, d] of acc) {
    if (d > bestDur) {
      best = bl;
      bestDur = d;
    }
  }
  return best;
}

export interface VelocitySegment {
  t: number;
  v: number;
}

/** 合并红线（BPM）与绿线（SV），得到分段恒定的速度倍率 v(t) */
export function buildVelocity(chart: OsuChart): VelocitySegment[] {
  const tps = chart.timingPoints
    .map((p, i) => ({ ...p, i }))
    .sort((a, b) => a.time - b.time || Number(b.uninherited) - Number(a.uninherited) || a.i - b.i);
  if (!tps.length) return [{ t: 0, v: 1 }];
  const firstRed = tps.find((p) => p.uninherited);
  const main = mostCommonBeatLength(chart) ?? (firstRed ? clampBeatLength(firstRed.beatLength) : 500);
  let bl = firstRed ? clampBeatLength(firstRed.beatLength) : main;
  let sv = 1;
  const segs: VelocitySegment[] = [];
  for (const p of tps) {
    if (p.uninherited) {
      bl = clampBeatLength(p.beatLength);
      sv = 1; // 红线重置 SV
    } else {
      sv = p.beatLength < 0 ? Math.min(10, Math.max(0.01, -100 / p.beatLength)) : 1;
    }
    const v = (sv * main) / bl;
    const last = segs[segs.length - 1];
    if (last && Math.abs(last.t - p.time) < 1e-9) last.v = v;
    else segs.push({ t: p.time, v });
  }
  return segs;
}

export class ScrollMap {
  private readonly ts: Float64Array;
  private readonly vs: Float64Array;
  private readonly ds: Float64Array;

  constructor(chart: OsuChart, useSV: boolean) {
    const segs = useSV ? buildVelocity(chart) : [{ t: 0, v: 1 }];
    const n = segs.length;
    this.ts = new Float64Array(n);
    this.vs = new Float64Array(n);
    this.ds = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.ts[i] = segs[i].t;
      this.vs[i] = segs[i].v;
      if (i > 0) this.ds[i] = this.ds[i - 1] + (this.ts[i] - this.ts[i - 1]) * this.vs[i - 1];
    }
  }

  /** 累计位移（单位：基准毫秒）。乘以 px/ms 即为像素 */
  pos(time: number): number {
    const ts = this.ts;
    if (time <= ts[0]) return this.ds[0] + (time - ts[0]) * this.vs[0];
    let lo = 0;
    let hi = ts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ts[mid] <= time) lo = mid;
      else hi = mid - 1;
    }
    return this.ds[lo] + (time - ts[lo]) * this.vs[lo];
  }

  get segmentCount(): number {
    return this.ts.length;
  }
}

export interface ChartStats {
  notes: number;
  lns: number;
  bpmMin: number;
  bpmMax: number;
  bpmMain: number;
  svPoints: number;
}

export function chartStats(chart: OsuChart): ChartStats {
  const reds = chart.timingPoints.filter((p) => p.uninherited);
  const bpms = reds.map((p) => 60000 / clampBeatLength(p.beatLength));
  const main = mostCommonBeatLength(chart);
  return {
    notes: chart.notes.length,
    lns: chart.notes.filter((n) => n.ln).length,
    bpmMin: bpms.length ? Math.min(...bpms) : 0,
    bpmMax: bpms.length ? Math.max(...bpms) : 0,
    bpmMain: main ? 60000 / main : 0,
    svPoints: chart.timingPoints.length - reds.length,
  };
}
