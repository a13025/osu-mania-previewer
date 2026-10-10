import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  Quality,
  canEncodeAudio,
  canEncodeVideo,
  type AudioCodec,
  type VideoCodec,
} from 'mediabunny';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import type { OsuChart } from './osu';
import { createFrameCanvas, H, W, type ChartRenderer } from './render';

export const AUDIO_RATE = 48000;
const VIDEO_BITRATE = 8_000_000;
const AUDIO_BITRATE = 192_000;

export class CancelledError extends Error {
  constructor() {
    super('已取消');
  }
}

// ---------------------------------------------------------------- 文件名

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const SPECIAL = /[#%&{}$!'`@+=^~;,[\]()]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeName(s: string): string {
  let r = s
    .replace(ILLEGAL, '_')
    .replace(SPECIAL, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._\s]+|[._\s]+$/g, '');
  if (!r) r = 'chart';
  if (RESERVED.test(r.split('.')[0])) r += '_';
  return r.slice(0, 120);
}

export function fmtSec(ms: number): string {
  return (ms / 1000).toFixed(3).replace(/\.?0+$/, '');
}

export function buildFileName(chart: OsuChart, fallbackTitle: string, tail: string, ext: string): string {
  const title = sanitizeName(chart.title || chart.titleUnicode || fallbackTitle);
  const version = sanitizeName(chart.version || 'diff');
  return `${title}_${version}_${tail}.${ext}`;
}

// ---------------------------------------------------------------- 保存

export interface SaveDir {
  handle: FileSystemDirectoryHandle;
  name: string;
}

type PermHandle = {
  queryPermission?: (d: { mode: string }) => Promise<string>;
  requestPermission?: (d: { mode: string }) => Promise<string>;
};
type WritableHandle = {
  createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void>; abort: () => Promise<void> }>;
};

/**
 * 写入：浏览器的 createWritable 先写入临时交换文件，close() 时原子替换目标文件；
 * 目标被其他程序占用（WinError 32 类问题）时自动改名重试。
 */
export async function saveBlob(blob: Blob, filename: string, dir: SaveDir | null): Promise<string> {
  if (dir) {
    const h = dir.handle as unknown as PermHandle;
    if (h.queryPermission && (await h.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      const r = h.requestPermission ? await h.requestPermission({ mode: 'readwrite' }) : 'denied';
      if (r !== 'granted') throw new Error('没有写入该目录的权限');
    }
    const dot = filename.lastIndexOf('.');
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : '';
    let lastErr: unknown = null;
    for (let n = 0; n < 30; n++) {
      const name = n === 0 ? filename : `${stem}_(${n})${ext}`;
      try {
        const fh = (await dir.handle.getFileHandle(name, { create: true })) as unknown as WritableHandle;
        const w = await fh.createWritable();
        try {
          await w.write(blob);
          await w.close();
        } catch (e) {
          await w.abort().catch(() => undefined);
          throw e;
        }
        return `${dir.name}/${name}`;
      } catch (e) {
        lastErr = e;
        if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) break;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('写入失败');
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
  return filename;
}

// ---------------------------------------------------------------- 音频

export async function decodeAudio(blob: Blob): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, 1, AUDIO_RATE);
  return await ctx.decodeAudioData(await blob.arrayBuffer());
}

/** 从整轨中截取 [startSample, startSample+n)，越界部分补静音，输出固定双声道 */
function audioChunk(src: AudioBuffer, startSample: number, n: number): AudioBuffer {
  const out = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: src.sampleRate });
  for (let ch = 0; ch < 2; ch++) {
    const s = src.getChannelData(Math.min(ch, src.numberOfChannels - 1));
    const d = out.getChannelData(ch);
    const from = Math.max(0, startSample);
    const to = Math.min(s.length, startSample + n);
    if (to > from) d.set(s.subarray(from, to), from - startSample);
  }
  return out;
}

// ---------------------------------------------------------------- 编码器选择

interface VideoChoice {
  codec: VideoCodec;
  full?: string;
  label: string;
}

const videoChoiceCache = new Map<number, VideoChoice | null>();

async function pickVideo(fps: number): Promise<VideoChoice | null> {
  if (videoChoiceCache.has(fps)) return videoChoiceCache.get(fps)!;
  let choice: VideoChoice | null = null;
  if (typeof VideoEncoder !== 'undefined') {
    const lvl = fps > 30 ? '2A' : '28'; // 1080p60 需要 Level 4.2
    const avc: [string, string][] = [
      [`avc1.6400${lvl}`, 'H.264'],
      [`avc1.4D40${lvl}`, 'H.264'],
      [`avc1.42E0${lvl}`, 'H.264'],
    ];
    for (const [full, label] of avc) {
      try {
        const r = await VideoEncoder.isConfigSupported({ codec: full, width: W, height: H, framerate: fps, bitrate: VIDEO_BITRATE });
        if (r.supported) {
          choice = { codec: 'avc', full, label };
          break;
        }
      } catch {
        /* next */
      }
    }
    if (!choice) {
      const q = new Quality({ bitrate: VIDEO_BITRATE });
      for (const [codec, label] of [
        ['avc', 'H.264'],
        ['vp9', 'VP9'],
        ['av1', 'AV1'],
        ['hevc', 'H.265'],
      ] as [VideoCodec, string][]) {
        try {
          if (await canEncodeVideo(codec, { width: W, height: H, frameRate: fps, quality: q })) {
            choice = { codec, label };
            break;
          }
        } catch {
          /* next */
        }
      }
    }
  }
  videoChoiceCache.set(fps, choice);
  return choice;
}

let aacPolyfilled = false;
let aacBroken = false; // 补丁编码器在当前环境无法运行（如禁止 Worker）时记住，后续直接用 Opus

async function pickAudio(avoidPolyfill: boolean): Promise<{ codec: AudioCodec; label: string; polyfill: boolean } | null> {
  const opts = { numberOfChannels: 2, sampleRate: AUDIO_RATE, quality: new Quality({ bitrate: AUDIO_BITRATE }) };
  if (!aacPolyfilled) {
    try {
      if (await canEncodeAudio('aac', opts)) return { codec: 'aac', label: 'AAC', polyfill: false };
    } catch {
      /* ignore */
    }
  }
  if (!avoidPolyfill && !aacBroken) {
    if (!aacPolyfilled) {
      try {
        registerAacEncoder();
        aacPolyfilled = true;
      } catch {
        /* ignore */
      }
    }
    try {
      if (aacPolyfilled && (await canEncodeAudio('aac', opts))) return { codec: 'aac', label: 'AAC', polyfill: true };
    } catch {
      /* ignore */
    }
  }
  try {
    if (await canEncodeAudio('opus', opts)) return { codec: 'opus', label: 'Opus', polyfill: false };
  } catch {
    /* ignore */
  }
  return null;
}

// ---------------------------------------------------------------- 视频导出

export interface ExportProgress {
  done: number;
  total: number;
  fps: number;
}

export interface VideoExportParams {
  renderer: ChartRenderer;
  startMs: number;
  durationMs: number;
  fps: number;
  audio: AudioBuffer | null;
  onProgress: (p: ExportProgress) => void;
  isCancelled: () => boolean;
}

export interface VideoExportResult {
  blob: Blob;
  codecLabel: string;
  frames: number;
}

const yieldToUI = (() => {
  const ch = new MessageChannel();
  const queue: (() => void)[] = [];
  ch.port1.onmessage = () => queue.shift()?.();
  return () =>
    new Promise<void>((r) => {
      queue.push(r);
      ch.port2.postMessage(0);
    });
})();

export async function exportVideo(p: VideoExportParams): Promise<VideoExportResult> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('当前浏览器不支持 WebCodecs 视频编码，请使用最新版 Chrome / Edge');
  }
  const video = await pickVideo(p.fps);
  if (!video) throw new Error('浏览器没有可用的视频编码器（H.264 / VP9 / AV1）');

  let audio = p.audio ? await pickAudio(false) : null;
  if (p.audio && !audio) throw new Error('浏览器没有可用的音频编码器，可取消勾选「背景音乐」后再导出');
  try {
    return await runExport(p, video, audio);
  } catch (e) {
    if (e instanceof CancelledError || !audio?.polyfill) throw e;
    // AAC 补丁编码器不可用时（例如受限环境禁止 Worker）改用 Opus 重试
    aacBroken = true;
    audio = await pickAudio(true);
    if (!audio) throw e;
    return await runExport(p, video, audio);
  }
}

async function runExport(
  p: VideoExportParams,
  video: VideoChoice,
  audio: { codec: AudioCodec; label: string } | null,
): Promise<VideoExportResult> {
  const { canvas, ctx } = createFrameCanvas();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  const vsrc = new CanvasSource(canvas, {
    codec: video.codec,
    fullCodecString: video.full,
    quality: new Quality({ bitrate: VIDEO_BITRATE }),
    keyFrameInterval: 2,
  });
  output.addVideoTrack(vsrc, { frameRate: p.fps });

  let asrc: AudioBufferSource | null = null;
  if (audio && p.audio) {
    asrc = new AudioBufferSource({ codec: audio.codec, quality: new Quality({ bitrate: AUDIO_BITRATE }) });
    output.addAudioTrack(asrc);
  }

  const total = Math.max(1, Math.round((p.durationMs * p.fps) / 1000));
  const sr = p.audio?.sampleRate ?? AUDIO_RATE;
  const audioStart = Math.round((p.startMs / 1000) * sr);
  const audioTotal = Math.round((total / p.fps) * sr); // 与视频时长严格一致
  let audioAdded = 0;
  const addAudioUntil = async (sample: number) => {
    if (!asrc || !p.audio) return;
    const target = Math.min(audioTotal, sample);
    while (audioAdded < target) {
      const n = Math.min(sr, target - audioAdded);
      await asrc.add(audioChunk(p.audio, audioStart + audioAdded, n));
      audioAdded += n;
    }
  };

  await output.start();
  const t0 = performance.now();
  let lastReport = 0;
  try {
    for (let i = 0; i < total; i++) {
      if (p.isCancelled()) throw new CancelledError();
      // 时间戳由帧序号直接计算，不累加浮点误差 => 帧率恒定、播放不卡顿
      p.renderer.draw(ctx, p.startMs + (i * 1000) / p.fps);
      await vsrc.add(i / p.fps, 1 / p.fps);
      // 音频与视频交错写入：按整秒分块，保持音频领先视频 1~2 秒
      await addAudioUntil((Math.ceil((i + 1) / p.fps) + 1) * sr);
      const now = performance.now();
      if (now - lastReport > 90 || i === total - 1) {
        lastReport = now;
        p.onProgress({ done: i + 1, total, fps: ((i + 1) * 1000) / Math.max(1, now - t0) });
        await yieldToUI();
      }
    }
    await addAudioUntil(audioTotal);
    await output.finalize();
  } catch (e) {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => undefined);
    throw e;
  }
  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new Error('编码失败：输出为空');
  return {
    blob: new Blob([buffer], { type: 'video/mp4' }),
    codecLabel: audio ? `${video.label} + ${audio.label}` : video.label,
    frames: total,
  };
}

// ---------------------------------------------------------------- 图片导出

export async function renderImage(renderer: ChartRenderer, t: number): Promise<Blob> {
  const { canvas, ctx } = createFrameCanvas();
  renderer.draw(ctx, t);
  return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG 编码失败'))), 'image/png'));
}
