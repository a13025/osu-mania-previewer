import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import pyCode from './python/osumania_preview_v0.7.py?raw';
import { Btn, CheckBox, inputCls, Row } from './components/ui';
import { filesFromDrop, filesFromInput, findAsset, loadBundle, type Bundle, type PickedFile } from './lib/archive';
import {
  buildFileName,
  CancelledError,
  decodeAudio,
  exportVideo,
  fmtSec,
  renderImage,
  saveBlob,
  type SaveDir,
} from './lib/exporter';
import { chartStats } from './lib/osu';
import { ChartRenderer, H, W } from './lib/render';
import { cn } from './utils/cn';

const VERSION = 'v0.7';
const PY_NAME = 'osumania_preview_v0.7.py';

type Tone = 'info' | 'ok' | 'err' | 'busy';
type Busy = null | 'load' | 'video' | 'image';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function fmtClock(ms: number): string {
  const tenths = Math.floor(Math.max(0, ms) / 100);
  const m = Math.floor(tenths / 600);
  const s = (tenths % 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export default function App() {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [chartKey, setChartKey] = useState('');
  const [speedText, setSpeedText] = useState('2.5');
  const [fps, setFps] = useState(60);
  const [startText, setStartText] = useState('0');
  const [durText, setDurText] = useState('30');
  const [renderAll, setRenderAll] = useState(false);
  const [music, setMusic] = useState(true);
  const [bgOn, setBgOn] = useState(false);
  const [bgDim, setBgDim] = useState(0.4);
  const [showSV, setShowSV] = useState(true);
  const [saveDir, setSaveDir] = useState<SaveDir | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState('');
  const [status, setStatus] = useState<{ text: string; tone: Tone }>({
    text: '导入 .osz、.osu 或整个铺面文件夹（支持拖放）',
    tone: 'info',
  });
  const [bgBitmap, setBgBitmap] = useState<ImageBitmap | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioDur, setAudioDur] = useState(0);
  const [previewMs, setPreviewMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const dirRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const cancelRef = useRef(false);
  const decodedRef = useRef<{ blob: Blob; buf: AudioBuffer } | null>(null);
  const previewRef = useRef(0);
  const autoSeekRef = useRef(false);

  const entry = useMemo(() => bundle?.charts.find((c) => c.key === chartKey) ?? null, [bundle, chartKey]);
  const chart = entry?.usable ? entry.chart : null;
  const stats = useMemo(() => (chart ? chartStats(chart) : null), [chart]);
  const audioAsset = useMemo(
    () => (bundle && chart ? findAsset(bundle, chart.audioFilename, 'audio') : null),
    [bundle, chart],
  );
  const bgAsset = useMemo(() => (bundle && chart ? findAsset(bundle, chart.bgFilename, 'image') : null), [bundle, chart]);

  const speedNum = parseFloat(speedText);
  const speedOk = Number.isFinite(speedNum) && speedNum >= 0.1 && speedNum <= 50;
  const speed = speedOk ? speedNum : 2.5;

  const renderer = useMemo(
    () => (chart ? new ChartRenderer(chart, { speed, showSV, bg: bgOn ? bgBitmap : null, bgDim }) : null),
    [chart, speed, showSV, bgOn, bgBitmap, bgDim],
  );
  const endMs = chart ? Math.max(chart.lastTime + 1500, audioDur) : 0;

  const rendererRef = useRef(renderer);
  const endRef = useRef(endMs);
  const musicRef = useRef(music);
  useEffect(() => {
    rendererRef.current = renderer;
  }, [renderer]);
  useEffect(() => {
    endRef.current = endMs;
  }, [endMs]);
  useEffect(() => {
    musicRef.current = music;
    if (audioRef.current) audioRef.current.muted = !music;
  }, [music, audioUrl]);
  useEffect(() => {
    previewRef.current = previewMs;
  }, [previewMs]);

  // 背景图解码
  useEffect(() => {
    setBgBitmap(null);
    if (!bgAsset) return;
    let alive = true;
    let bmp: ImageBitmap | null = null;
    createImageBitmap(bgAsset.blob)
      .then((b) => {
        if (alive) {
          bmp = b;
          setBgBitmap(b);
        } else b.close();
      })
      .catch(() => {
        if (alive) setStatus({ text: '背景图解码失败', tone: 'err' });
      });
    return () => {
      alive = false;
      bmp?.close();
    };
  }, [bgAsset]);

  // 预览用音频
  useEffect(() => {
    setAudioDur(0);
    if (!audioAsset) {
      setAudioUrl(null);
      return;
    }
    const u = URL.createObjectURL(audioAsset.blob);
    setAudioUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [audioAsset]);

  // 切换难度：停止播放并自动定位到物件较密集的位置
  useEffect(() => {
    setPlaying(false);
    autoSeekRef.current = true;
  }, [chart]);
  useEffect(() => {
    if (!renderer || !chart || !autoSeekRef.current) return;
    autoSeekRef.current = false;
    let best = chart.firstTime;
    let bestN = -1;
    const limit = Math.min(chart.lastTime, chart.firstTime + 30000);
    for (let t = chart.firstTime; t <= limit; t += 100) {
      const n = renderer.visibleCount(t);
      if (n > bestN) {
        bestN = n;
        best = t;
      }
    }
    previewRef.current = Math.round(best);
    setPreviewMs(Math.round(best));
  }, [renderer, chart]);

  // 静止画面
  useEffect(() => {
    if (playing) return;
    const ctx = canvasRef.current?.getContext('2d', { alpha: false });
    if (!ctx) return;
    if (renderer) renderer.draw(ctx, previewMs);
    else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
    }
  }, [renderer, previewMs, playing]);

  // 播放：以音频时钟为准，帧间用 performance.now() 平滑外推
  useEffect(() => {
    if (!playing) return;
    const ctx = canvasRef.current?.getContext('2d', { alpha: false });
    if (!ctx) return;
    const audio = audioRef.current;
    const hasAudio = !!(audio && audio.getAttribute('src'));
    let clockPerf = performance.now();
    let clockMedia = previewRef.current >= endRef.current - 50 ? 0 : previewRef.current;
    let lastAudio = -1;
    if (hasAudio && audio) {
      audio.muted = !musicRef.current;
      try {
        audio.currentTime = clockMedia / 1000;
      } catch {
        /* ignore */
      }
      audio.play().catch(() => undefined);
    }
    let raf = 0;
    let lastUi = 0;
    const tick = () => {
      const now = performance.now();
      if (hasAudio && audio && !audio.paused && !audio.seeking && audio.readyState >= 2) {
        const at = audio.currentTime * 1000;
        if (at !== lastAudio) {
          lastAudio = at;
          clockPerf = now;
          clockMedia = at;
        }
      }
      const t = clockMedia + (now - clockPerf);
      rendererRef.current?.draw(ctx, t);
      previewRef.current = t;
      if (now - lastUi > 80) {
        lastUi = now;
        setPreviewMs(Math.round(t));
      }
      if (t >= endRef.current) {
        previewRef.current = endRef.current;
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      audio?.pause();
      setPreviewMs(Math.round(previewRef.current));
    };
  }, [playing]);

  // 空格键播放 / 暂停
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
      if (!rendererRef.current) return;
      e.preventDefault();
      setPlaying((p) => !p);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ------------------------------------------------------------------ 导入
  const handlePicked = useCallback(async (picked: PickedFile[]) => {
    if (!picked.length) return;
    setPlaying(false);
    setBusy('load');
    setStatus({ text: '正在读取…', tone: 'busy' });
    try {
      const b = await loadBundle(picked);
      decodedRef.current = null;
      const usable = b.charts.filter((c) => c.usable);
      setBundle(b);
      setChartKey((usable[0] ?? b.charts[0]).key);
      setProgress(0);
      if (!usable.length) {
        setStatus({ text: `已读取 ${b.sourceName}，但没有可用的 4K mania 难度`, tone: 'err' });
      } else {
        const hasAudio = [...b.files.keys()].some((k) => /\.(mp3|ogg|wav|m4a|flac|aac|opus)$/.test(k));
        setStatus({
          text:
            `已导入 ${b.sourceName} · ${usable.length} 个 4K 难度` +
            (hasAudio ? '' : '（未包含音频：如需背景音乐 / 背景图，请导入 osz 或整个铺面文件夹）'),
          tone: 'ok',
        });
      }
    } catch (e) {
      setStatus({ text: `导入失败：${errMsg(e)}`, tone: 'err' });
    } finally {
      setBusy(null);
    }
  }, []);

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (busy) return;
    const pending = filesFromDrop(e.dataTransfer); // 必须在事件同步阶段读取
    pending.then(handlePicked).catch((err) => setStatus({ text: `导入失败：${errMsg(err)}`, tone: 'err' }));
  };

  // ------------------------------------------------------------------ 导出
  const computeRange = (): { start: number; dur: number; label: string } | null => {
    if (!chart) return null;
    if (renderAll) return { start: 0, dur: chart.lastTime + 1500, label: 'full' };
    const s = parseFloat(startText);
    const d = parseFloat(durText);
    if (!Number.isFinite(s) || s < 0 || !Number.isFinite(d) || d <= 0) {
      setStatus({ text: '渲染区间无效：起始秒 ≥ 0，渲染秒数 > 0', tone: 'err' });
      return null;
    }
    return { start: s * 1000, dur: d * 1000, label: `${fmtSec(s * 1000)}s-${fmtSec((s + d) * 1000)}s` };
  };

  const fallbackTitle = bundle ? bundle.sourceName.replace(/\.[^.]+$/, '') : 'chart';

  /** 勾选背景图时确保背景已解码，保证导出结果中一定包含背景图 */
  const getExportRenderer = async (): Promise<ChartRenderer> => {
    if (!chart || !renderer) throw new Error('请先导入并选择 4K mania 难度');
    if (!bgOn || !bgAsset || bgBitmap) return renderer;
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(bgAsset.blob);
    } catch {
      throw new Error('背景图解码失败，可取消勾选「背景图」后再导出');
    }
    return new ChartRenderer(chart, { speed, showSV, bg: bmp, bgDim });
  };

  const onExportVideo = async () => {
    if (!chart || !renderer || !bundle || busy) return;
    if (!speedOk) {
      setStatus({ text: '下落速度无效（0.1 ~ 50 px/ms）', tone: 'err' });
      return;
    }
    const range = computeRange();
    if (!range) return;
    setPlaying(false);
    cancelRef.current = false;
    setBusy('video');
    setProgress(0);
    setProgressText('准备中…');
    setStatus({ text: '正在导出视频…', tone: 'busy' });
    const t0 = performance.now();
    try {
      let audio: AudioBuffer | null = null;
      if (music && audioAsset) {
        setProgressText('解码音频…');
        if (decodedRef.current?.blob !== audioAsset.blob) {
          try {
            decodedRef.current = { blob: audioAsset.blob, buf: await decodeAudio(audioAsset.blob) };
          } catch {
            throw new Error('音频解码失败，可取消勾选「背景音乐」后再导出');
          }
        }
        audio = decodedRef.current.buf;
      }
      const exportRenderer = await getExportRenderer();
      const res = await exportVideo({
        renderer: exportRenderer,
        startMs: range.start,
        durationMs: range.dur,
        fps,
        audio,
        onProgress: ({ done, total, fps: rate }) => {
          setProgress(done / total);
          setProgressText(
            `${done}/${total} 帧 · ${rate.toFixed(0)} fps · 剩余 ${Math.ceil((total - done) / Math.max(1, rate))}s`,
          );
        },
        isCancelled: () => cancelRef.current,
      });
      setProgressText('写入文件…');
      const name = buildFileName(chart, fallbackTitle, range.label, 'mp4');
      const saved = await saveBlob(res.blob, name, saveDir);
      setProgress(1);
      setStatus({
        text: `✓ 视频已导出：${saved}（${(res.blob.size / 1048576).toFixed(1)} MB · ${res.codecLabel} · 用时 ${(
          (performance.now() - t0) /
          1000
        ).toFixed(1)} 秒）`,
        tone: 'ok',
      });
    } catch (e) {
      if (e instanceof CancelledError) {
        setProgress(0);
        setStatus({ text: '已取消导出', tone: 'info' });
      } else {
        setStatus({ text: `导出失败：${errMsg(e)}`, tone: 'err' });
      }
    } finally {
      setBusy(null);
      setProgressText('');
    }
  };

  const onExportImage = async () => {
    if (!chart || !renderer || !bundle || busy) return;
    setPlaying(false);
    setBusy('image');
    setProgress(0.2);
    try {
      const t = Math.round(previewRef.current);
      const blob = await renderImage(await getExportRenderer(), t);
      setProgress(0.7);
      const saved = await saveBlob(blob, buildFileName(chart, fallbackTitle, `${fmtSec(t)}s`, 'png'), saveDir);
      setProgress(1);
      setStatus({ text: `✓ 图片已导出：${saved}（${fmtClock(t)} 处画面）`, tone: 'ok' });
    } catch (e) {
      setProgress(0);
      setStatus({ text: `导出图片失败：${errMsg(e)}`, tone: 'err' });
    } finally {
      setBusy(null);
    }
  };

  const onChooseDir = async () => {
    const w = window as unknown as {
      showDirectoryPicker?: (o?: { mode?: string; id?: string }) => Promise<FileSystemDirectoryHandle>;
    };
    if (!w.showDirectoryPicker) {
      setStatus({ text: '当前浏览器不支持自定义导出目录，文件将保存到浏览器默认下载目录', tone: 'info' });
      return;
    }
    try {
      const h = await w.showDirectoryPicker({ mode: 'readwrite', id: 'omp-export' });
      setSaveDir({ handle: h, name: h.name });
      setStatus({ text: `导出位置：${h.name}`, tone: 'ok' });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setStatus({ text: `无法使用自定义目录（${errMsg(e)}），将保存到浏览器默认下载目录`, tone: 'err' });
    }
  };

  const onDownloadPy = () => {
    void saveBlob(new Blob([pyCode], { type: 'text/x-python;charset=utf-8' }), PY_NAME, null);
    setStatus({ text: `已下载 Python 版 ${PY_NAME}（依赖：pip install numpy pillow imageio-ffmpeg）`, tone: 'ok' });
  };

  const bpmText = stats
    ? Math.abs(stats.bpmMax - stats.bpmMin) < 0.01
      ? `${Math.round(stats.bpmMain)}`
      : `${Math.round(stats.bpmMain)}（${Math.round(stats.bpmMin)}–${Math.round(stats.bpmMax)}）`
    : '';
  const locked = busy !== null;

  return (
    <div
      className="min-h-screen bg-white text-[13px] text-zinc-800"
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <div className="mx-auto max-w-[1080px] px-4 py-3">
        <header className="flex items-center justify-between border-b border-zinc-200 pb-2">
          <h1 className="text-[16px] font-bold tracking-tight text-zinc-900">osu!mania预览工具</h1>
          <button
            type="button"
            onClick={onDownloadPy}
            className="rounded-md border border-zinc-200 px-2 py-0.5 text-[12px] text-zinc-600 transition-colors hover:bg-zinc-50"
          >
            Python 版 {VERSION} ↓
          </button>
        </header>

        <div className="mt-3 grid gap-4 md:grid-cols-[340px_minmax(0,1fr)]">
          {/* ---------------- 控制面板 ---------------- */}
          <section className="space-y-2.5">
            <Row label="铺面">
              <Btn onClick={() => fileRef.current?.click()} disabled={locked}>
                导入 osu/osz
              </Btn>
              <Btn onClick={() => dirRef.current?.click()} disabled={locked}>
                文件夹
              </Btn>
            </Row>
            <div className="truncate pl-[68px] text-[12px] text-zinc-500" title={bundle?.sourceName}>
              {bundle ? bundle.sourceName : '未导入'}
            </div>

            <Row label="难度">
              <select
                className={cn(inputCls, 'w-full min-w-0 pr-1')}
                value={chartKey}
                onChange={(e) => setChartKey(e.target.value)}
                disabled={!bundle || locked}
              >
                {!bundle && <option value="">—</option>}
                {bundle?.charts.map((c) => (
                  <option key={c.key} value={c.key} disabled={!c.usable}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Row>
            {entry && !entry.usable && (
              <div className="pl-[68px] text-[12px] text-red-600">该难度不是 4K mania，无法渲染</div>
            )}
            {chart && stats && (
              <div className="pl-[68px] text-[12px] leading-5 text-zinc-500">
                <div>
                  {stats.notes} 物件（LN {stats.lns}）· BPM {bpmText} · SV {stats.svPoints}
                </div>
                <div className="truncate">
                  音频 {audioAsset ? '✓' : '×'} · 背景 {bgAsset ? '✓' : '×'} · {entry?.fileName}
                </div>
              </div>
            )}

            <Row label="下落速度">
              <input
                className={cn(inputCls, 'w-16 text-center', !speedOk && 'border-red-400')}
                value={speedText}
                inputMode="decimal"
                onChange={(e) => setSpeedText(e.target.value)}
                disabled={locked}
              />
              <span className="text-zinc-500">px/ms</span>
              <span className="ml-auto text-zinc-500">帧率</span>
              <select
                className={cn(inputCls, 'w-[58px] px-1')}
                value={fps}
                onChange={(e) => setFps(Number(e.target.value))}
                disabled={locked}
              >
                <option value={30}>30</option>
                <option value={60}>60</option>
              </select>
            </Row>

            <Row label="区间">
              <span>从</span>
              <input
                className={cn(inputCls, 'w-14 text-center')}
                value={startText}
                inputMode="decimal"
                onChange={(e) => setStartText(e.target.value)}
                disabled={locked || renderAll}
              />
              <span>秒开始，渲染</span>
              <input
                className={cn(inputCls, 'w-14 text-center')}
                value={durText}
                inputMode="decimal"
                onChange={(e) => setDurText(e.target.value)}
                disabled={locked || renderAll}
              />
              <span>秒</span>
            </Row>

            <div className="flex flex-wrap gap-x-4 gap-y-1 pl-[68px]">
              <CheckBox checked={renderAll} onChange={setRenderAll} label="渲染全部" disabled={locked} />
              <CheckBox
                checked={music}
                onChange={setMusic}
                label="背景音乐"
                disabled={locked || (!!chart && !audioAsset)}
                title={chart && !audioAsset ? '未找到音频文件' : undefined}
              />
              <CheckBox
                checked={bgOn}
                onChange={setBgOn}
                label="背景图"
                disabled={locked || (!!chart && !bgAsset)}
                title={chart && !bgAsset ? '未找到背景图' : undefined}
              />
              <CheckBox checked={showSV} onChange={setShowSV} label="显示 SV" disabled={locked} />
            </div>

            {bgOn && (
              <Row label="背景暗度">
                <input
                  type="range"
                  min={0}
                  max={0.9}
                  step={0.05}
                  value={bgDim}
                  onChange={(e) => setBgDim(Number(e.target.value))}
                  disabled={locked}
                  className="h-1 flex-1 accent-zinc-800"
                />
                <span className="w-9 text-right text-zinc-500 tabular-nums">{Math.round(bgDim * 100)}%</span>
              </Row>
            )}

            <Row label="导出位置">
              <div
                className="flex h-7 min-w-0 flex-1 items-center truncate rounded-md border border-zinc-200 bg-zinc-50 px-2 text-[12px] text-zinc-600"
                title={saveDir ? saveDir.name : '浏览器默认下载目录'}
              >
                {saveDir ? saveDir.name : '默认下载目录'}
              </div>
              <Btn onClick={onChooseDir} disabled={locked}>
                选择
              </Btn>
              {saveDir && (
                <Btn onClick={() => setSaveDir(null)} disabled={locked}>
                  重置
                </Btn>
              )}
            </Row>

            <div className="flex gap-2 pt-1 pl-[68px]">
              <Btn onClick={onExportImage} disabled={!renderer || locked}>
                导出图片
              </Btn>
              <Btn variant="primary" onClick={onExportVideo} disabled={!renderer || locked}>
                {busy === 'video' ? '导出中…' : '导出视频'}
              </Btn>
              {busy === 'video' && <Btn onClick={() => (cancelRef.current = true)}>取消</Btn>}
            </div>
          </section>

          {/* ---------------- 预览 ---------------- */}
          <section className="min-w-0">
            <div className="relative overflow-hidden rounded-md border border-zinc-200 bg-black">
              <canvas ref={canvasRef} width={W} height={H} className="block aspect-video h-auto w-full" />
              {!chart && (
                <div className="absolute inset-0 grid place-items-center text-[12px] text-zinc-500">
                  拖放 .osz / .osu / 铺面文件夹到此处
                </div>
              )}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPlaying((p) => !p)}
                disabled={!renderer || locked}
                className="grid h-7 w-8 shrink-0 place-items-center rounded-md border border-zinc-300 bg-white text-[11px] text-zinc-800 transition-colors hover:bg-zinc-50 disabled:text-zinc-300"
                aria-label={playing ? '暂停' : '播放'}
              >
                {playing ? '❚❚' : '▶'}
              </button>
              <input
                type="range"
                min={0}
                max={Math.max(1, Math.round(endMs))}
                step={1}
                value={Math.min(previewMs, Math.max(1, Math.round(endMs)))}
                disabled={!renderer || locked}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  previewRef.current = v;
                  setPlaying(false);
                  setPreviewMs(v);
                }}
                className="h-1 min-w-0 flex-1 accent-[#2bb8d6]"
              />
              <span className="w-[92px] shrink-0 text-right text-[12px] text-zinc-500 tabular-nums">
                {fmtClock(previewMs)} / {fmtClock(endMs)}
              </span>
            </div>
          </section>
        </div>

        {/* ---------------- 进度 / 状态 ---------------- */}
        <footer className="mt-3 border-t border-zinc-200 pt-2.5">
          <div className="flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-100">
              <div
                className="h-full rounded-full bg-[#50dffd] transition-[width] duration-150"
                style={{ width: `${Math.round(progress * 1000) / 10}%` }}
              />
            </div>
            <span className="w-10 text-right text-[12px] text-zinc-500 tabular-nums">{Math.round(progress * 100)}%</span>
          </div>
          <div className="mt-1.5 flex justify-between gap-3 text-[12px]">
            <span
              className={cn(
                'min-w-0 break-all',
                status.tone === 'ok' && 'text-green-700',
                status.tone === 'err' && 'text-red-600',
                status.tone === 'info' && 'text-zinc-500',
                status.tone === 'busy' && 'text-zinc-700',
              )}
            >
              {status.text}
            </span>
            <span className="shrink-0 text-zinc-400 tabular-nums">{progressText}</span>
          </div>
        </footer>
      </div>

      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".osu,.osz,.zip,.mp3,.ogg,.wav,.m4a,.flac,.jpg,.jpeg,.png"
        className="hidden"
        onChange={(e) => {
          const picked = filesFromInput(e.target.files);
          e.target.value = '';
          void handlePicked(picked);
        }}
      />
      <input
        ref={(el) => {
          dirRef.current = el;
          el?.setAttribute('webkitdirectory', '');
        }}
        type="file"
        className="hidden"
        onChange={(e) => {
          const picked = filesFromInput(e.target.files);
          e.target.value = '';
          void handlePicked(picked);
        }}
      />
      <audio
        ref={audioRef}
        src={audioUrl ?? undefined}
        preload="auto"
        className="hidden"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d)) setAudioDur(d * 1000);
        }}
      />
      {dragOver && (
        <div className="pointer-events-none fixed inset-0 z-50 border-2 border-dashed border-[#50dffd] bg-cyan-50/30" />
      )}
    </div>
  );
}
