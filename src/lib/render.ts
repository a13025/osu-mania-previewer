import { ScrollMap, type OsuChart } from './osu';

// ---------------------------------------------------------------- 皮肤规范（1920×1080 基准）
export const W = 1920;
export const H = 1080;
export const KEYS = 4;
export const LANE_W = 146; // 单轨宽
export const STAGE_W = LANE_W * KEYS; // 584
export const STAGE_X = (W - STAGE_W) / 2; // 668，水平居中
export const NOTE_H = 58; // note 厚度
export const JUDGE_FROM_BOTTOM = 89; // 判定线距底端
export const JUDGE_T = 6; // 判定线厚度
export const JUDGE_BOTTOM = H - JUDGE_FROM_BOTTOM; // 991
export const HIT_Y = JUDGE_BOTTOM - JUDGE_T; // 985：note 底边落到此处即被接住
export const GLOW_H = 28;
export const STAGE_BACK_ALPHA = 0.85; // 勾选背景图时，轨道区域的黑色底

export const LANE_RGB: [number, number, number][] = [
  [255, 255, 255],
  [0x50, 0xdf, 0xfd],
  [0x50, 0xdf, 0xfd],
  [255, 255, 255],
];
const BODY_FACTOR = 0.72; // 长条身体亮度
const css = (c: number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;
export const LANE_COLORS = LANE_RGB.map(css);
export const BODY_COLORS = LANE_RGB.map((c) => css(c.map((v) => Math.round(v * BODY_FACTOR))));

export interface RenderOptions {
  speed: number; // px/ms
  showSV: boolean;
  bg: ImageBitmap | null;
  bgDim: number; // 0..1
}

interface RNote {
  start: number;
  end: number;
  ln: boolean;
  ps: number; // 累计位移（start）
  pe: number; // 累计位移（end）
  gone: number; // 消失时刻：普通 note = start，LN = end
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** 静态层：纯黑背景 / 背景图 + 判定线。每帧只需 drawImage 一次 */
function buildStaticLayer(bg: ImageBitmap | null, dim: number): HTMLCanvasElement {
  const c = makeCanvas(W, H);
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  if (bg && bg.width > 0 && bg.height > 0) {
    const s = Math.max(W / bg.width, H / bg.height);
    const dw = bg.width * s;
    const dh = bg.height * s;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    try {
      g.drawImage(bg, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } catch {
      /* 位图已释放时忽略 */
    }
    if (dim > 0) {
      g.fillStyle = `rgba(0,0,0,${dim})`;
      g.fillRect(0, 0, W, H);
    }
    g.fillStyle = `rgba(0,0,0,${STAGE_BACK_ALPHA})`;
    g.fillRect(STAGE_X, 0, STAGE_W, H);
  }
  // 判定线：上方柔光 + 实线
  const grd = g.createLinearGradient(0, HIT_Y - GLOW_H, 0, HIT_Y);
  grd.addColorStop(0, 'rgba(255,255,255,0)');
  grd.addColorStop(1, 'rgba(255,255,255,0.16)');
  g.fillStyle = grd;
  g.fillRect(STAGE_X, HIT_Y - GLOW_H, STAGE_W, GLOW_H);
  g.fillStyle = '#ffffff';
  g.fillRect(STAGE_X, HIT_Y, STAGE_W, JUDGE_T);
  return c;
}

export class ChartRenderer {
  readonly map: ScrollMap;
  readonly speed: number;
  private readonly cols: RNote[][];
  private readonly pref: Float64Array[];
  private readonly layer: HTMLCanvasElement;

  constructor(chart: OsuChart, opts: RenderOptions) {
    this.speed = opts.speed;
    this.map = new ScrollMap(chart, opts.showSV);
    this.cols = Array.from({ length: KEYS }, () => [] as RNote[]);
    for (const n of chart.notes) {
      if (n.col < 0 || n.col >= KEYS) continue;
      this.cols[n.col].push({
        start: n.start,
        end: n.end,
        ln: n.ln,
        ps: this.map.pos(n.start),
        pe: this.map.pos(n.end),
        gone: n.ln ? n.end : n.start,
      });
    }
    // 前缀最大消失时间，用于二分定位第一个仍存活的 note（容错重叠 note）
    this.pref = this.cols.map((arr) => {
      const a = new Float64Array(arr.length);
      let m = -Infinity;
      arr.forEach((n, i) => {
        m = Math.max(m, n.gone);
        a[i] = m;
      });
      return a;
    });
    this.layer = buildStaticLayer(opts.bg, opts.bgDim);
  }

  /** 统计某时刻屏幕上可见的物件数量 */
  visibleCount(t: number): number {
    const pt = this.map.pos(t);
    const rd = (HIT_Y + 2) / this.speed;
    let count = 0;
    for (let c = 0; c < KEYS; c++) {
      const arr = this.cols[c];
      for (let i = this.firstAlive(c, t); i < arr.length; i++) {
        const n = arr[i];
        if (n.ps - pt > rd) break;
        if (t < n.gone) count++;
      }
    }
    return count;
  }

  private firstAlive(c: number, t: number): number {
    const pref = this.pref[c];
    let lo = 0;
    let hi = pref.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pref[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  draw(ctx: CanvasRenderingContext2D, t: number): void {
    ctx.drawImage(this.layer, 0, 0);
    const pt = this.map.pos(t);
    const sp = this.speed;
    const rd = (HIT_Y + 2) / sp;
    for (let c = 0; c < KEYS; c++) {
      const arr = this.cols[c];
      if (!arr.length) continue;
      const x = STAGE_X + c * LANE_W;
      const head = LANE_COLORS[c];
      const body = BODY_COLORS[c];
      for (let i = this.firstAlive(c, t); i < arr.length; i++) {
        const n = arr[i];
        if (n.ps - pt > rd) break; // 之后的 note 都在屏幕上方
        if (t >= n.gone) continue; // 已到达判定线 => 立刻消失
        if (n.ln) {
          // 按住期间头部固定在判定线，身体随尾部缩短；结束后立刻消失
          const hy = t < n.start ? HIT_Y - (n.ps - pt) * sp : HIT_Y;
          const top = Math.round(HIT_Y - (n.pe - pt) * sp);
          const bb = Math.round(hy - NOTE_H / 2);
          if (top < bb) {
            const y0 = Math.max(0, top);
            const y1 = Math.min(HIT_Y, bb);
            if (y1 > y0) {
              ctx.fillStyle = body;
              ctx.fillRect(x, y0, LANE_W, y1 - y0);
            }
          }
          const hb = Math.round(hy);
          const y0 = Math.max(0, hb - NOTE_H);
          const y1 = Math.min(HIT_Y, hb);
          if (y1 > y0) {
            ctx.fillStyle = head;
            ctx.fillRect(x, y0, LANE_W, y1 - y0);
          }
        } else {
          const hb = Math.round(HIT_Y - (n.ps - pt) * sp);
          const y0 = Math.max(0, hb - NOTE_H);
          const y1 = Math.min(HIT_Y, hb);
          if (y1 > y0) {
            ctx.fillStyle = head;
            ctx.fillRect(x, y0, LANE_W, y1 - y0);
          }
        }
      }
    }
  }
}

export function createFrameCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  return { canvas, ctx };
}
