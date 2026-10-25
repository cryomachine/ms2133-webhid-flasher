import React, { useCallback, useEffect, useRef, useState } from "react";

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: VideoFrameCallbackMetadata) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

type LatencySample = {
  latency: number;
  sourceTimestamp: number;
  receivedAt: number;
};

type LatencyStats = {
  current: number | null;
  minimum: number | null;
  median: number | null;
  p95: number | null;
  maximum: number | null;
  average: number | null;
  fps: number | null;
  matched: number;
  invalid: number;
};

type LatencyTestProps = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  stream: MediaStream | null;
  activeCrop: number | null;
};

const MARKER_GRID = 8;
const MARKER_DATA_BITS = 36;
const MARKER_MODULUS = 0x1000000;
const MARKER_SPAN_RATIO = 0.18;
// The UVC square modes are centered on the HDMI frame. Keeping the marker at
// the geometric center prevents the 192/256/320 crops from clipping its lower
// rows and keeps the 416 mode aligned with the decoder's ROI.
const MARKER_CENTER_Y = 0.5;
const DISPLAY_TIMER_CYCLE_MS = 10_000;
const MAX_SOURCE_HISTORY = 1200;
const MAX_SAMPLES = 1200;

function bitAt(value: number, bit: number): number {
  return (value >>> bit) & 1;
}

function markerBits(timestamp: number, sequence: number): number[] {
  const value = (timestamp & 0xffffff) | ((sequence & 0xff) << 24);
  const bits: number[] = [];
  for (let bit = 0; bit < MARKER_DATA_BITS - 4; bit += 1) bits.push(bitAt(value, bit));
  let checksum = 0;
  for (const bit of bits) checksum = (checksum + bit) & 0xf;
  for (let bit = 0; bit < 4; bit += 1) bits.push(bitAt(checksum, bit));
  return bits;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function formatMs(value: number | null): string {
  return value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(2)} ms`;
}

function markerSpanRatio(cropPixels: number | null): number {
  return cropPixels != null && cropPixels <= 320 ? 0.14 : MARKER_SPAN_RATIO;
}

function sourceRoiRatio(cropPixels: number | null): number {
  const cropScale = cropPixels == null ? 1 : cropPixels / 416;
  return Math.min(0.82, Math.max(0.45, 0.52 * cropScale));
}

function capturedMarkerRatio(cropPixels: number | null): number {
  return cropPixels == null ? markerSpanRatio(null) : markerSpanRatio(cropPixels) / sourceRoiRatio(cropPixels);
}

function displayTimer(timestamp: number): string {
  const cycle = ((timestamp % DISPLAY_TIMER_CYCLE_MS) + DISPLAY_TIMER_CYCLE_MS) % DISPLAY_TIMER_CYCLE_MS;
  return Math.floor(cycle).toString();
}

function drawMarker(context: CanvasRenderingContext2D, width: number, height: number, timestamp: number, sequence: number, referenceUnit = Math.min(width, height), centerY = height * MARKER_CENTER_Y, spanRatio = MARKER_SPAN_RATIO): void {
  const span = referenceUnit * spanRatio;
  const cell = span / MARKER_GRID;
  const left = (width - span) / 2;
  const top = centerY - span / 2;
  const bits = markerBits(timestamp, sequence);
  let dataIndex = 0;
  context.save();
  context.imageSmoothingEnabled = false;
  for (let row = 0; row < MARKER_GRID; row += 1) {
    for (let column = 0; column < MARKER_GRID; column += 1) {
      const border = row === 0 || row === MARKER_GRID - 1 || column === 0 || column === MARKER_GRID - 1;
      const value = border ? ((row + column) % 2 === 0 ? 255 : 0) : (bits[dataIndex++] ? 255 : 0);
      context.fillStyle = value ? "#fff" : "#000";
      context.fillRect(Math.floor(left + column * cell), Math.floor(top + row * cell), Math.ceil(cell + 0.5), Math.ceil(cell + 0.5));
    }
  }
  context.restore();
}

function drawFloatingSourceFrame(context: CanvasRenderingContext2D, timestamp: number, sequence: number, cropPixels: number | null): void {
  const { canvas } = context;
  const width = canvas.width;
  const height = canvas.height;
  const unit = Math.min(height, width * 9 / 16);
  const roiRatio = sourceRoiRatio(cropPixels);
  const roiSide = unit * roiRatio;
  const boxLeft = (width - roiSide) / 2;
  const boxTop = height * MARKER_CENTER_Y - roiSide * 0.56;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#06120ddd";
  context.fillRect(boxLeft, boxTop, roiSide, roiSide);
  context.strokeStyle = "#86d7ac";
  context.lineWidth = Math.max(2, unit * 0.004);
  context.strokeRect(boxLeft, boxTop, roiSide, roiSide);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#eafff1";
  context.font = `700 ${Math.max(28, Math.round(roiSide * 0.16))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  context.fillText(`${displayTimer(timestamp)} ms`, width / 2, boxTop + roiSide * 0.25);
  context.fillStyle = "#8dd9b1";
  context.font = `600 ${Math.max(11, Math.round(roiSide * 0.034))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  context.fillText(`MS2133 · ${cropPixels ? `${cropPixels}²` : "LATENCY SOURCE"}`, width / 2, boxTop + roiSide * 0.10);
  context.fillStyle = "#b9d9c7";
  context.font = `500 ${Math.max(10, Math.round(roiSide * 0.026))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  context.fillText("中心 ROI · 原画面仍保持可见", width / 2, boxTop + roiSide * 0.93);
  drawMarker(context, width, height, Math.floor(timestamp), sequence, unit, height * MARKER_CENTER_Y, markerSpanRatio(cropPixels));
}

function decodeMarker(context: CanvasRenderingContext2D, width: number, height: number, cropPixels: number | null, receivedEpoch: number): { timestamp: number; sequence: number } | null {
  const expectedSpan = Math.min(width, height) * capturedMarkerRatio(cropPixels);
  const centerX = width / 2;
  const centerY = height * MARKER_CENTER_Y;
  const searchSpan = Math.max(8, Math.ceil(expectedSpan * 1.65));
  const sampleLeft = Math.max(0, Math.min(width - searchSpan, Math.floor(centerX - searchSpan / 2)));
  const sampleTop = Math.max(0, Math.min(height - searchSpan, Math.floor(centerY - searchSpan / 2)));
  const image = context.getImageData(sampleLeft, sampleTop, searchSpan, searchSpan).data;
  const scaleCandidates = [0.72, 0.84, 1, 1.16, 1.3];
  const offsetCandidates = [-0.1, 0, 0.1];
  const candidates: Array<{ marker: { timestamp: number; sequence: number }; score: number }> = [];
  const readPixelLuminance = (x: number, y: number): number => {
    const offset = (y * searchSpan + x) * 4;
    return image[offset] * 0.299 + image[offset + 1] * 0.587 + image[offset + 2] * 0.114;
  };
  for (const scale of scaleCandidates) {
    const span = expectedSpan * scale;
    const cell = span / MARKER_GRID;
    for (const offsetX of offsetCandidates) {
      for (const offsetY of offsetCandidates) {
        const left = centerX - span / 2 + offsetX * expectedSpan;
        const top = centerY - span / 2 + offsetY * expectedSpan;
        const cells: number[] = [];
        let pixelScore = 0;
        let pixelCount = 0;
        for (let row = 0; row < MARKER_GRID; row += 1) {
          for (let column = 0; column < MARKER_GRID; column += 1) {
            const expected = (row + column) % 2 === 0 ? 1 : 0;
            const cellLeft = Math.max(0, Math.floor(left + column * cell));
            const cellTop = Math.max(0, Math.floor(top + row * cell));
            const cellRight = Math.min(width, Math.ceil(left + (column + 1) * cell));
            const cellBottom = Math.min(height, Math.ceil(top + (row + 1) * cell));
            let white = 0;
            let dark = 0;
            // Sample a 4×4 interior grid. This is still pixel-level matching,
            // while keeping the work bounded at high frame rates (the source
            // can be 240 fps and a full cell-area scan would be excessive).
            for (let sampleY = 1; sampleY <= 4; sampleY += 1) {
              for (let sampleX = 1; sampleX <= 4; sampleX += 1) {
                const x = cellLeft + Math.floor((cellRight - cellLeft) * sampleX / 5);
                const y = cellTop + Math.floor((cellBottom - cellTop) * sampleY / 5);
                const localX = x - sampleLeft;
                const localY = y - sampleTop;
                if (localX < 0 || localY < 0 || localX >= searchSpan || localY >= searchSpan) continue;
                const isWhite = readPixelLuminance(localX, localY) >= 128;
                if (isWhite) white += 1; else dark += 1;
                pixelCount += 1;
              }
            }
            const value = white >= dark ? 1 : 0;
            cells.push(value);
            if (value === expected) pixelScore += Math.max(white, dark);
          }
        }
        let borderScore = 0;
        for (let row = 0; row < MARKER_GRID; row += 1) {
          for (let column = 0; column < MARKER_GRID; column += 1) {
            if (row !== 0 && row !== MARKER_GRID - 1 && column !== 0 && column !== MARKER_GRID - 1) continue;
            if (cells[row * MARKER_GRID + column] === ((row + column) % 2 === 0 ? 1 : 0)) borderScore += 1;
          }
        }
        const score = borderScore * 1000 + (pixelCount ? pixelScore / pixelCount : 0);
        if (borderScore < 22) continue;
        const bits: number[] = [];
        for (let dataRow = 1; dataRow < MARKER_GRID - 1; dataRow += 1) {
          for (let dataColumn = 1; dataColumn < MARKER_GRID - 1; dataColumn += 1) bits.push(cells[dataRow * MARKER_GRID + dataColumn]);
        }
        let value = 0;
        for (let bit = 0; bit < 32; bit += 1) value |= bits[bit] << bit;
        let checksum = 0;
        for (let bit = 0; bit < 32; bit += 1) checksum = (checksum + bits[bit]) & 0xf;
        let encodedChecksum = 0;
        for (let bit = 0; bit < 4; bit += 1) encodedChecksum |= bits[32 + bit] << bit;
        if (checksum === encodedChecksum) {
          candidates.push({ marker: { timestamp: value & 0xffffff, sequence: (value >>> 24) & 0xff }, score });
        }
      }
    }
  }
  if (candidates.length === 0) return null;
  // Recursive browser captures can contain several valid markers at different
  // scales. Pick the marker whose unwrapped timestamp is closest to this
  // received frame, rather than whichever candidate happened to score first.
  candidates.sort((first, second) => Math.abs(unwrapTimestamp(first.marker.timestamp, receivedEpoch) - receivedEpoch) - Math.abs(unwrapTimestamp(second.marker.timestamp, receivedEpoch) - receivedEpoch) || second.score - first.score);
  return candidates[0].marker;
}

function unwrapTimestamp(encoded: number, receivedEpoch: number): number {
  const base = Math.floor(receivedEpoch / MARKER_MODULUS) * MARKER_MODULUS;
  const candidates = [base + encoded, base - MARKER_MODULUS + encoded, base + MARKER_MODULUS + encoded];
  return candidates.reduce((closest, candidate) => Math.abs(candidate - receivedEpoch) < Math.abs(closest - receivedEpoch) ? candidate : closest, candidates[0]);
}

function initialStats(): LatencyStats {
  return { current: null, minimum: null, median: null, p95: null, maximum: null, average: null, fps: null, matched: 0, invalid: 0 };
}

export function LatencyTest({ videoRef, stream, activeCrop }: LatencyTestProps) {
  const sourceCanvasRef = useRef<HTMLCanvasElement>(null);
  const sourceOverlayRef = useRef<HTMLDivElement>(null);
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceHistoryRef = useRef<Map<number, number>>(new Map());
  const sourceSequenceRef = useRef(0);
  const sourceAnimationRef = useRef<number | null>(null);
  const frameCallbackRef = useRef<number | null>(null);
  const fallbackFrameTimerRef = useRef<number | null>(null);
  const samplesRef = useRef<LatencySample[]>([]);
  const invalidRef = useRef(0);
  const captureFramesRef = useRef(0);
  const captureStartedRef = useRef(0);
  const [running, setRunning] = useState(false);
  const [sourceVisible, setSourceVisible] = useState(false);
  const [sourceFullscreen, setSourceFullscreen] = useState(false);
  const [stats, setStats] = useState<LatencyStats>(initialStats);
  const [message, setMessage] = useState("");

  const stopSource = useCallback(() => {
    if (sourceAnimationRef.current != null) window.cancelAnimationFrame(sourceAnimationRef.current);
    sourceAnimationRef.current = null;
  }, []);

  const startSource = useCallback(() => {
    stopSource();
    const canvas = sourceCanvasRef.current;
    if (!canvas) return;
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(640, Math.floor(window.innerWidth * pixelRatio));
    canvas.height = Math.max(360, Math.floor(window.innerHeight * pixelRatio));
    const context = canvas.getContext("2d");
    if (!context) return;
    const draw = (now: number) => {
      const epoch = performance.timeOrigin + now;
      const encoded = Math.floor(epoch) & 0xffffff;
      const sequence = sourceSequenceRef.current = (sourceSequenceRef.current + 1) & 0xff;
      drawFloatingSourceFrame(context, epoch, sequence, activeCrop);
      const history = sourceHistoryRef.current;
      history.set(encoded, epoch);
      while (history.size > MAX_SOURCE_HISTORY) {
        const first = history.keys().next().value;
        if (first == null) break;
        history.delete(first);
      }
      sourceAnimationRef.current = window.requestAnimationFrame(draw);
    };
    sourceAnimationRef.current = window.requestAnimationFrame(draw);
  }, [activeCrop, stopSource]);

  const updateStats = useCallback(() => {
    const values = samplesRef.current.map(sample => sample.latency);
    const totalSeconds = captureStartedRef.current ? Math.max(0.001, (performance.now() - captureStartedRef.current) / 1000) : 0;
    const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    setStats({
      current: values.length ? values[values.length - 1] : null,
      minimum: values.length ? Math.min(...values) : null,
      median: median(values),
      p95: percentile(values, 0.95),
      maximum: values.length ? Math.max(...values) : null,
      average,
      fps: totalSeconds ? captureFramesRef.current / totalSeconds : null,
      matched: values.length,
      invalid: invalidRef.current,
    });
  }, []);

  const processFrame = useCallback((video: VideoWithFrameCallback, frameMetadata?: VideoFrameCallbackMetadata) => {
    if (!running) return;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return;
    let canvas = sampleCanvasRef.current;
    if (!canvas) {
      canvas = document.createElement("canvas");
      sampleCanvasRef.current = canvas;
    }
    const sampleWidth = Math.min(640, width);
    const sampleHeight = Math.max(1, Math.round(sampleWidth * height / width));
    if (canvas.width !== sampleWidth || canvas.height !== sampleHeight) {
      canvas.width = sampleWidth;
      canvas.height = sampleHeight;
    }
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.drawImage(video, 0, 0, sampleWidth, sampleHeight);
    captureFramesRef.current += 1;
    const receivedNow = frameMetadata?.expectedDisplayTime ?? performance.now();
    const receivedEpoch = performance.timeOrigin + receivedNow;
    const marker = decodeMarker(context, sampleWidth, sampleHeight, activeCrop, receivedEpoch);
    if (!marker) {
      invalidRef.current += 1;
      return;
    }
    // requestVideoFrameCallback() invokes the handler after the frame has
    // entered the compositor. `performance.now()` measures handler dispatch
    // time and adds a vsync/scheduling delay (about 10 ms in the 240 fps
    // capture path). Use the browser's expected presentation timestamp so the
    // result matches the frame that is visibly on screen.
    const sourceEpoch = sourceHistoryRef.current.get(marker.timestamp) ?? unwrapTimestamp(marker.timestamp, receivedEpoch);
    const latency = receivedEpoch - sourceEpoch;
    if (!Number.isFinite(latency) || latency < -100 || latency > 60000) {
      invalidRef.current += 1;
      return;
    }
    const sample: LatencySample = { latency, sourceTimestamp: sourceEpoch, receivedAt: receivedEpoch };
    samplesRef.current.push(sample);
    if (samplesRef.current.length > MAX_SAMPLES) samplesRef.current.shift();
  }, [activeCrop, running]);

  const stopFrameLoop = useCallback(() => {
    const video = videoRef.current as VideoWithFrameCallback | null;
    if (video && frameCallbackRef.current != null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameCallbackRef.current);
    frameCallbackRef.current = null;
    if (fallbackFrameTimerRef.current != null) window.clearTimeout(fallbackFrameTimerRef.current);
    fallbackFrameTimerRef.current = null;
  }, [videoRef]);

  const startFrameLoop = useCallback(() => {
    stopFrameLoop();
    const video = videoRef.current as VideoWithFrameCallback | null;
    if (!video) return;
    const next = () => {
      if (!running) return;
      if (video.requestVideoFrameCallback) {
        frameCallbackRef.current = video.requestVideoFrameCallback((_now, metadata) => {
          processFrame(video, metadata);
          void next();
        });
      } else {
        processFrame(video);
        fallbackFrameTimerRef.current = window.setTimeout(next, 16);
      }
    };
    if (video.requestVideoFrameCallback) frameCallbackRef.current = video.requestVideoFrameCallback((_now, metadata) => {
      processFrame(video, metadata);
      void next();
    });
    else next();
  }, [processFrame, running, stopFrameLoop, videoRef]);

  useEffect(() => {
    if (!running) {
      stopFrameLoop();
      stopSource();
      return;
    }
    startSource();
    startFrameLoop();
    const statsTimer = window.setInterval(updateStats, 250);
    return () => {
      window.clearInterval(statsTimer);
      stopFrameLoop();
      stopSource();
    };
  }, [running, startFrameLoop, startSource, stopFrameLoop, stopSource, updateStats]);

  useEffect(() => {
    if (sourceVisible && !running) startSource();
    if (!sourceVisible && !running) stopSource();
    return () => { if (!running) stopSource(); };
  }, [running, sourceVisible, startSource, stopSource]);

  useEffect(() => {
    const onFullscreen = () => setSourceFullscreen(document.fullscreenElement === sourceOverlayRef.current);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  const begin = () => {
    if (!stream || !videoRef.current) {
      setMessage("请先启动采集预览，并把本页面的源计时器显示到 HDMI 输入屏幕。");
      return;
    }
    samplesRef.current = [];
    sourceHistoryRef.current.clear();
    sourceSequenceRef.current = 0;
    invalidRef.current = 0;
    captureFramesRef.current = 0;
    captureStartedRef.current = performance.now();
    setStats(initialStats());
    setMessage("测试中：源计时器必须在采集卡 HDMI 输入画面内可见。");
    setSourceVisible(true);
    setRunning(true);
  };

  const stop = () => {
    setRunning(false);
    updateStats();
    setMessage("测试已停止。统计值保留在本页，可重新开始覆盖。");
  };

  const toggleFullscreen = async () => {
    const panel = sourceOverlayRef.current;
    if (!panel) return;
    try {
      if (document.fullscreenElement === panel) await document.exitFullscreen();
      else await panel.requestFullscreen();
    } catch (error) {
      setMessage(`无法进入全屏源计时器：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const clear = () => {
    samplesRef.current = [];
    invalidRef.current = 0;
    captureFramesRef.current = 0;
    captureStartedRef.current = 0;
    setStats(initialStats());
    setMessage("");
  };

  const displayMode = activeCrop ? `${activeCrop} × ${activeCrop}` : "当前完整输入帧";
  return <section className="panel latency-test" aria-labelledby="latency-test-heading">
    <div className="section-heading">
      <div className="heading-title"><h3 id="latency-test-heading">全链路延迟测试</h3></div>
      <span className="quiet-tag">画面时间戳 · {displayMode}</span>
    </div>
    <div className="latency-test-layout">
      <div className="latency-source-preview">
        <div className="latency-source-preview-icon">＋</div>
        <strong>{sourceVisible ? "中心浮窗已显示" : "中心浮窗未显示"}</strong>
        <span>浮窗只覆盖屏幕中心的计时器和编码标记，周围原画面保持可见；当前 {displayMode}，边框会随裁剪档位缩放。</span>
      </div>
      <div className="latency-controls">
        <p className="latency-explanation">网页在源画面中绘制毫秒计时器和校验标记，再从采集卡回传帧中识别同一标记，统计源画面到 UVC 帧到达的时间差。</p>
        <div className="latency-actions"><button className="button small" onClick={() => setSourceVisible(value => !value)} disabled={running}>{sourceVisible ? "隐藏源计时器" : "显示源计时器"}</button><button className="button small" onClick={() => void toggleFullscreen()} disabled={!sourceVisible}>{sourceFullscreen ? "退出全屏" : "全屏源计时器"}</button></div>
        <div className="latency-actions"><button className="button primary-button small" onClick={begin} disabled={running || !stream}>{running ? "测试中" : "开始延迟测试"}</button><button className="button small" onClick={stop} disabled={!running}>停止</button><button className="button small" onClick={clear} disabled={running}>清空</button></div>
        <dl className="latency-stats"><div><dt>当前</dt><dd>{formatMs(stats.current)}</dd></div><div><dt>中位数</dt><dd>{formatMs(stats.median)}</dd></div><div><dt>P95</dt><dd>{formatMs(stats.p95)}</dd></div><div><dt>最小 / 最大</dt><dd>{formatMs(stats.minimum)} / {formatMs(stats.maximum)}</dd></div><div><dt>平均 / 观测</dt><dd>{formatMs(stats.average)} · {stats.fps == null ? "—" : `${stats.fps.toFixed(1)} fps`}</dd></div><div><dt>匹配 / 无效</dt><dd>{stats.matched} / {stats.invalid}</dd></div></dl>
      </div>
    </div>
    {sourceVisible && <div ref={sourceOverlayRef} className={`latency-floating-overlay ${sourceFullscreen ? "fullscreen" : ""}`} aria-label="HDMI 源计时器浮窗"><canvas ref={sourceCanvasRef} aria-label="HDMI 源计时器"/><span className="latency-floating-badge">SOURCE TIMER · CENTER</span></div>}
    <p className="latency-message" role="status">{message || "测试需要同一台源机上的页面计时器和采集卡回传流；跨主机时钟存在偏差，结果应作为相对延迟参考。"}</p>
  </section>;
}

