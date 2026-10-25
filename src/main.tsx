import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { callBackend as invoke, requestWebDevice, webMode } from "./backend";
import "./webhid-protocol";
import type { DeviceInfo, FirmwareInfo, FirmwareInterface, LogEntry, OperationState, ScanResult } from "./types";
import type { RecoverySummary } from "./storage";
import { runSixModeCaptureTest, SIX_CAPTURE_TEST_MODES } from "./video-mode-test";
import type { SixCaptureTestResult, VideoModeDescriptor } from "./video-mode-test";
import { LatencyTest } from "./latency-test";
import "./style.css";

function Icon({ name, spin = false }: { name: "usb" | "refresh" | "file" | "download" | "upload" | "restore" | "check" | "alert" | "stop" | "export"; spin?: boolean }) {
  const paths: Record<string, React.ReactNode> = {
    usb: <><path d="M12 21V3m0 0L9 6m3-3 3 3M12 15l-6-4V8m6 4 6-4V5"/><circle cx="6" cy="6" r="2"/><path d="M16 3h4v4h-4z"/><circle cx="12" cy="19" r="2"/></>,
    refresh: <><path d="M20 7a8 8 0 1 0 1 8M20 3v5h-5"/></>,
    file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5"/></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/></>,
    upload: <><path d="M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4"/></>,
    restore: <><path d="M4 10a8 8 0 1 1 1 8M4 4v6h6M12 7v5l3 2"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    alert: <><path d="m12 3 10 18H2zM12 9v5m0 3v.1"/></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
    export: <><path d="M14 3h7v7m0-7L11 13M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/></>,
  };
  return <svg className={spin ? "icon spin" : "icon"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
const hex = (value?: number | null) => value == null ? "—" : `0x${value.toString(16).toUpperCase().padStart(4, "0")}`;
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
const statusName: Record<DeviceInfo["status"], string> = { enumerated: "已枚举", reachable: "可通信", update: "升级接口", busy: "接口占用", error: "探测异常" };
const firmwareInterfaceName: Record<FirmwareInterface, string> = { stock: "原厂固件", roi: "ROI裁剪固件", rom: "ROM恢复接口", unknown: "固件类型未确认" };
const errorText = (e: unknown) => typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
type NativeVideoConstraints = MediaTrackConstraints & { resizeMode?: ConstrainDOMString };
type ExtendedMediaTrackCapabilities = MediaTrackCapabilities & { resizeMode?: string[] };

function waitForPreviewFrame(video: HTMLVideoElement, pixels: number, timeoutMs = 1500): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + timeoutMs;
    let poll = 0;
    let timeout = 0;
    let framePending = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearInterval(poll);
      window.clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", check);
      video.removeEventListener("resize", check);
      error ? reject(error) : resolve();
    };
    const check = () => {
      if (settled || framePending) return;
      if (video.videoWidth !== pixels || video.videoHeight !== pixels) {
        if (performance.now() >= deadline) finish(new Error(`视频解码尺寸未稳定为 ${pixels} × ${pixels}`));
        return;
      }
      framePending = true;
      if ("requestVideoFrameCallback" in video) {
        video.requestVideoFrameCallback(() => finish());
      } else {
        window.setTimeout(() => finish(), 120);
      }
    };
    timeout = window.setTimeout(() => finish(new Error(`等待 ${pixels} × ${pixels} 首帧超时`)), timeoutMs);
    poll = window.setInterval(check, 40);
    video.addEventListener("loadedmetadata", check);
    video.addEventListener("resize", check);
    check();
  });
}

function applyTrackConstraintsWithTimeout(track: MediaStreamTrack, constraints: NativeVideoConstraints, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(`UVC 模式切换超时（${timeoutMs}ms）`)); }
    }, timeoutMs);
    track.applyConstraints(constraints).then(() => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve();
    }).catch(error => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      reject(error);
    });
  });
}

function FirmwareCard({ info }: { info: FirmwareInfo | null }) {
  if (!info) return <div className="firmware-placeholder"><Icon name="file"/><div><strong>尚未选择文件</strong><p>选择文件后，将检查镜像结构与校验和。</p></div></div>;
  return <div className="firmware-info">
    <div className="firmware-title"><Icon name="file"/><strong>{info.path.split(/[\\/]/).pop()}</strong><span className={`status-pill ${info.valid ? "reachable" : "error"}`}>{info.valid ? "文件校验通过" : "校验失败"}</span></div>
    <dl className="file-meta"><div><dt>写入镜像</dt><dd>{size(info.size)}</dd></div><div><dt>目标配置</dt><dd>{info.target}</dd></div></dl>
    {info.bootImageExtracted && <p className="section-note">已从 {size(info.sourceSize ?? 0)} 整片备份提取开头的 98356 字节启动镜像；写入时保留设备当前尾部。</p>}
    <details className="technical-details"><summary>文件路径与校验信息</summary><dl className="detail-list"><div><dt>文件路径</dt><dd>{info.path}</dd></div><div><dt>SHA-256</dt><dd className="mono">{info.sha256}</dd></div></dl></details>
    {info.errors.length > 0 && <ul className="validation-errors">{info.errors.map((message, i) => <li key={i}>{message}</li>)}</ul>}
  </div>;
}

const HARDWARE_CROP_MODES = [192, 256, 320, 416, 512, 640] as const;

type PreviewStats = { width: number; height: number; frameRate: number | null; label: string; state: string };

function capabilityRange(value: MediaSettingsRange | undefined): string {
  if (!value) return "未声明";
  return `${value.min}–${value.max}`;
}

function resizeModeNames(value: string[] | undefined): string {
  if (!value?.length) return "未声明";
  return value.join("、");
}

function CapturePreview({ requestedCrop, switching, onCropSettled, onBusyChange }: {
  requestedCrop: number | null;
  switching: boolean;
  onCropSettled: (pixels: number, ok: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [stats, setStats] = useState<PreviewStats | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [loading, setLoading] = useState(false);
  const [renderedCrop, setRenderedCrop] = useState<number | null>(null);
  const [testRunning, setTestRunning] = useState(false);
  const [testProgress, setTestProgress] = useState<{ index: number; total: number; mode: VideoModeDescriptor } | null>(null);
  const [testResults, setTestResults] = useState<SixCaptureTestResult[]>([]);
  const [capabilities, setCapabilities] = useState<ExtendedMediaTrackCapabilities | null>(null);
  const stableCropRef = useRef<number | null>(null);
  const recoveredCropRef = useRef<number | null | undefined>(undefined);
  const recoveryPendingRef = useRef(false);

  const stop = useCallback(() => {
    stream?.getTracks().forEach(track => track.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    setStream(null);
    setStats(null);
    setCapabilities(null);
  }, [stream]);

  const enumerateVideoDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setPreviewError("当前浏览器没有提供视频设备枚举接口。");
      return [];
    }
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "videoinput");
    setVideoDevices(devices);
    if (!selectedDeviceId && devices.length === 1) setSelectedDeviceId(devices[0].deviceId);
    return devices;
  }, [selectedDeviceId]);

  const start = async (): Promise<MediaStream | null> => {
    setLoading(true); setPreviewError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器没有提供视频采集接口。");
      stop();
      const video: NativeVideoConstraints = {
        width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 240, max: 240 },
        resizeMode: { exact: "none" },
        ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
      };
      const next = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      setStream(next);
      const devices = await enumerateVideoDevices();
      const track = next.getVideoTracks()[0];
      setCapabilities((track?.getCapabilities?.() as ExtendedMediaTrackCapabilities | undefined) ?? null);
      const settings = track?.getSettings();
      setStats({ width: settings?.width ?? 0, height: settings?.height ?? 0, frameRate: settings?.frameRate ?? null, label: track?.label || devices.find(item => item.deviceId === selectedDeviceId)?.label || "视频输入", state: "采集中" });
      return next;
    } catch (error) {
      setPreviewError(errorText(error));
      stop();
      return null;
    } finally { setLoading(false); }
  };

  const runSixTest = async () => {
    if (testRunning) return;
    setTestRunning(true); onBusyChange?.(true); setTestResults([]); setTestProgress(null); setPreviewError("");
    try {
      const activeStream = stream ?? await start();
      if (!activeStream) throw new Error("无法启动视频输入，六档测试未执行。");
      let video = videoRef.current;
      if (!video) throw new Error("预览视频元素尚未挂载，请稍后重试。");
      const results = await runSixModeCaptureTest(activeStream, video, (mode, index, total) => setTestProgress({ mode, index, total }));
      setTestResults(results);
      const failed = results.filter(result => result.status === "failed").length;
      setPreviewError(failed ? `六档测试完成：${failed} 档未通过，请查看结果表。` : "六档测试完成：全部档位收到视频帧。");
    } catch (error) {
      setPreviewError(`六档测试未完成：${errorText(error)}`);
    } finally { setTestRunning(false); onBusyChange?.(false); setTestProgress(null); }
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    const syncVideoDimensions = () => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) return;
      setStats(previous => previous ? { ...previous, width, height } : previous);
    };
    const play = () => {
      syncVideoDimensions();
      void video.play().then(syncVideoDimensions).catch(error => setPreviewError(errorText(error)));
    };
    video.addEventListener("loadedmetadata", play, { once: true });
    video.addEventListener("resize", syncVideoDimensions);
    if (video.readyState >= 1) play();
    return () => {
      video.removeEventListener("loadedmetadata", play);
      video.removeEventListener("resize", syncVideoDimensions);
      if (video.srcObject === stream) video.srcObject = null;
    };
  }, [stream]);

  useEffect(() => { void enumerateVideoDevices(); return () => { stream?.getTracks().forEach(track => track.stop()); }; }, [enumerateVideoDevices, stream]);
  useEffect(() => {
    if (!stream) return;
    const id = window.setInterval(() => {
      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings();
      if (track) setStats(previous => ({ width: settings?.width ?? previous?.width ?? 0, height: settings?.height ?? previous?.height ?? 0, frameRate: settings?.frameRate ?? previous?.frameRate ?? null, label: track.label || previous?.label || "视频输入", state: track.readyState === "live" ? "采集中" : "已停止" }));
    }, 1000);
    return () => window.clearInterval(id);
  }, [stream]);

  useEffect(() => {
    if (!requestedCrop) {
      setRenderedCrop(null);
      if (recoveryPendingRef.current && recoveredCropRef.current === null) recoveryPendingRef.current = false;
      return;
    }
    if (!stream) {
      // A mode can be selected before the user starts the preview. There is
      // no video negotiation to wait for in that case.
      setRenderedCrop(requestedCrop);
      if (!recoveryPendingRef.current) onCropSettled(requestedCrop, true);
      return;
    }
    const track = stream.getVideoTracks()[0];
    if (!track?.applyConstraints) {
      setRenderedCrop(null);
      onCropSettled(requestedCrop, false);
      return;
    }
    let cancelled = false;
    setRenderedCrop(null);
    const apply = async () => {
      if (recoveryPendingRef.current) {
        if (recoveredCropRef.current === requestedCrop) {
          recoveryPendingRef.current = false;
          recoveredCropRef.current = undefined;
          stableCropRef.current = requestedCrop;
          setRenderedCrop(requestedCrop);
        }
        // A recovery stream is already being reopened. Do not issue the
        // failed request again while the parent is rolling back its selected
        // crop; this was the source of late green frames and stuck buttons.
        return;
      }
      // A failed transaction can leave the UVC bridge with a partially
      // renegotiated decoder. Reopening the stream is the only reliable way
      // to flush that state; do not issue a second constraint request on the
      // same track while the first one is unwinding.
      if (recoveredCropRef.current === requestedCrop) {
        recoveredCropRef.current = undefined;
        stableCropRef.current = requestedCrop;
        setRenderedCrop(requestedCrop);
        return;
      }
      try {
        await applyTrackConstraintsWithTimeout(track, {
          width: { exact: requestedCrop },
          height: { exact: requestedCrop },
          frameRate: { ideal: 240, max: 240 },
          resizeMode: { exact: "none" },
        }, 4000);
        if (cancelled) return;
        const settings = track.getSettings();
        setStats(previous => previous ? {
          ...previous,
          width: settings.width ?? previous.width,
          height: settings.height ?? previous.height,
          frameRate: settings.frameRate ?? previous.frameRate,
        } : previous);
        if (settings.width !== requestedCrop || settings.height !== requestedCrop) {
          throw new Error(`设备返回 ${settings.width ?? "未知"} × ${settings.height ?? "未知"}`);
        }
        const video = videoRef.current;
        if (!video || video.srcObject !== stream) throw new Error("预览视频元素未绑定当前采集流");
        if (video.srcObject === stream) {
          video.pause();
          video.srcObject = null;
          // The UVC bridge can still drain frames from the previous mode after
          // applyConstraints() resolves. Keep the stream detached long enough
          // for the device and decoder to cross the mode boundary cleanly.
          await new Promise<void>(resolve => window.setTimeout(resolve, 120));
          if (!cancelled) {
            video.srcObject = stream;
            await video.play();
          }
        }
        if (!cancelled) {
          await waitForPreviewFrame(video, requestedCrop);
          if (cancelled) return;
          setRenderedCrop(requestedCrop);
          stableCropRef.current = requestedCrop;
          setPreviewError("");
          onCropSettled(requestedCrop, true);
        }
      } catch (error) {
        if (!cancelled) {
          setRenderedCrop(null);
          const fallbackCrop = stableCropRef.current;
          recoveryPendingRef.current = true;
          try {
            const video = videoRef.current;
            if (video) {
              video.pause();
              video.srcObject = null;
            }
            stream.getTracks().forEach(currentTrack => currentTrack.stop());
            setStream(null);
            setStats(null);
            await new Promise<void>(resolve => window.setTimeout(resolve, 180));
            if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器无法重新打开视频输入");
            const recoveryVideo: NativeVideoConstraints = fallbackCrop
              ? { width: { exact: fallbackCrop }, height: { exact: fallbackCrop }, frameRate: { ideal: 240, max: 240 }, resizeMode: { exact: "none" } }
              : { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 240, max: 240 }, resizeMode: { exact: "none" } };
            if (selectedDeviceId) recoveryVideo.deviceId = { exact: selectedDeviceId };
            const next = await navigator.mediaDevices.getUserMedia({ video: recoveryVideo, audio: false });
            recoveredCropRef.current = fallbackCrop;
            setStream(next);
            const nextTrack = next.getVideoTracks()[0];
            setCapabilities((nextTrack?.getCapabilities?.() as ExtendedMediaTrackCapabilities | undefined) ?? null);
            const nextSettings = nextTrack?.getSettings();
            setStats({ width: nextSettings?.width ?? 0, height: nextSettings?.height ?? 0, frameRate: nextSettings?.frameRate ?? null, label: nextTrack?.label || "视频输入", state: "采集中" });
            // Wait for the replacement stream to bind and present a real
            // frame before resolving the parent transaction. Until then the
            // crop buttons stay locked and the preview overlay remains up.
            await new Promise<void>(resolve => window.setTimeout(resolve, 80));
            const recoveryPreview = videoRef.current;
            if (recoveryPreview && recoveryPreview.srcObject !== next) {
              recoveryPreview.srcObject = next;
              await recoveryPreview.play();
            }
            if (fallbackCrop && recoveryPreview) await waitForPreviewFrame(recoveryPreview, fallbackCrop);
            setPreviewError(`切换到 ${requestedCrop} × ${requestedCrop} 超时，已重启采集流并恢复上一档。`);
            onCropSettled(requestedCrop, false);
          } catch (recoveryError) {
            recoveryPendingRef.current = false;
            setPreviewError(`切换到 ${requestedCrop} × ${requestedCrop} 失败：${errorText(error)}；恢复采集流失败：${errorText(recoveryError)}`);
            onCropSettled(requestedCrop, false);
          }
        }
      }
    };
    void apply();
    return () => { cancelled = true; };
  }, [onCropSettled, requestedCrop, stream]);

  const actualSquare = stats && stats.width === stats.height && (HARDWARE_CROP_MODES as readonly number[]).includes(stats.width)
    ? stats.width
    : null;
  const displayCrop = renderedCrop ?? actualSquare;
  const previewStyle = displayCrop ? {
    "--crop-size": `${displayCrop}px`,
    aspectRatio: "1 / 1",
    width: "min(100%, var(--crop-size))",
    maxWidth: "640px",
  } as React.CSSProperties : undefined;

  return <section className="panel capture-preview" aria-labelledby="capture-preview-heading">
    <div className="section-heading"><div className="heading-title"><Icon name="refresh"/><h2 id="capture-preview-heading">六档采集 · 实时预览测试</h2></div><div className="preview-heading-actions"><span className="quiet-tag">USB3 Video</span><button className="button small" onClick={() => void runSixTest()} disabled={loading || testRunning}><Icon name="refresh" spin={testRunning}/>{testRunning ? testProgress ? `测试 ${testProgress.index + 1}/${testProgress.total}` : "准备测试" : "开始六档测试"}</button></div></div>
    <div className="capture-preview-layout">
      <div className={`capture-video-frame ${displayCrop ? "crop-preview-active" : ""} ${switching ? "crop-preview-switching" : ""}`} style={previewStyle}>{stream ? <video ref={videoRef} autoPlay playsInline muted aria-label="采集视频预览"/> : <div className="capture-video-empty"><Icon name="usb"/><strong>尚未开始预览</strong><span>点击“开始预览”，选择浏览器可用的视频输入。</span></div>}{switching && <div className="capture-switch-overlay" role="status"><Icon name="refresh" spin/><span>切换画面中…</span></div>}{stream && <span className="capture-live-badge"><i/>LIVE</span>}{displayCrop && <span className="capture-crop-badge">中心预览 {displayCrop} × {displayCrop}</span>}</div>
      <div className="capture-preview-controls">
        <label className="preview-select-label" htmlFor="video-device">视频输入</label>
        <select id="video-device" value={selectedDeviceId} onChange={event => setSelectedDeviceId(event.target.value)} disabled={loading || Boolean(stream)}><option value="">浏览器默认视频设备</option>{videoDevices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label || `视频设备 ${device.deviceId.slice(0, 6)}`}</option>)}</select>
        <div className="preview-actions"><button className="button small" onClick={() => void start()} disabled={loading || Boolean(stream) || testRunning}><Icon name="refresh" spin={loading}/>{loading ? "请求权限" : "开始预览"}</button>{stream && <button className="button small" onClick={stop} disabled={testRunning}>停止预览</button>}</div>
        {stats && <dl className="capture-stats"><div><dt>输入设备</dt><dd>{stats.label}</dd></div><div><dt>实际画面</dt><dd>{stats.width && stats.height ? `${stats.width} × ${stats.height}` : "等待首帧"}</dd></div><div><dt>轨道帧率</dt><dd>{stats.frameRate ? `${stats.frameRate.toFixed(2)} fps` : "未提供"}</dd></div><div><dt>当前模式</dt><dd>{displayCrop ? `${displayCrop} × ${displayCrop}` : "完整输入帧"}</dd></div><div><dt>状态</dt><dd>{stats.state}</dd></div></dl>}
        {previewError && <p className="preview-error" role="alert">{previewError}</p>}
      </div>
    </div>
    {testResults.length > 0 && <div className="capture-test-results"><div className="section-heading"><div className="heading-title"><Icon name="check"/><h3>六档测试结果</h3></div><span className="quiet-tag">{testResults.filter(result => result.status === "passed").length}/{testResults.length} 通过</span></div><div className="capture-test-table-wrap"><table className="capture-test-table"><thead><tr><th>目标</th><th>实际画面</th><th>轨道 fps</th><th>观测 fps</th><th>帧数</th><th>结果</th></tr></thead><tbody>{testResults.map((result, index) => <tr key={`${result.width}-${result.height}-${index}`}><td>{result.width} × {result.height} @ {result.frameRate}</td><td>{result.actualWidth && result.actualHeight ? `${result.actualWidth} × ${result.actualHeight}` : "—"}</td><td>{result.actualFrameRate ? result.actualFrameRate.toFixed(2) : "—"}</td><td>{result.observedFrameRate ? result.observedFrameRate.toFixed(2) : "—"}</td><td>{result.frameCount}</td><td><span className={`status-pill ${result.status === "passed" ? "reachable" : "error"}`}>{result.status === "passed" ? "通过" : result.error || "失败"}</span></td></tr>)}</tbody></table></div></div>}
    <LatencyTest videoRef={videoRef} stream={stream} activeCrop={displayCrop}/>
    <div className="capture-declared-modes">
      <div className="section-heading"><div className="heading-title"><Icon name="check"/><h3>声明的采集画面列表</h3></div><span className="quiet-tag">resizeMode: none</span></div>
      <p className="section-note">浏览器通常只声明宽高范围，不提供 UVC 离散模式表。下面列出当前轨道能力和本页逐档请求的原生配置；测试禁止浏览器缩放。</p>
      <dl className="mode-enum-details capture-capability-details"><div><dt>宽度范围</dt><dd>{capabilityRange(capabilities?.width)}</dd></div><div><dt>高度范围</dt><dd>{capabilityRange(capabilities?.height)}</dd></div><div><dt>帧率范围</dt><dd>{capabilityRange(capabilities?.frameRate)}</dd></div><div><dt>缩放模式</dt><dd>{resizeModeNames(capabilities?.resizeMode)}</dd></div></dl>
      <div className="capture-test-table-wrap"><table className="capture-declared-table"><thead><tr><th>原生配置</th><th>请求帧率</th><th>测试状态</th><th>实际返回</th></tr></thead><tbody>{SIX_CAPTURE_TEST_MODES.map(mode => { const result = testResults.find(item => item.width === mode.width && item.height === mode.height && item.frameRate === mode.frameRate); return <tr key={`${mode.width}-${mode.height}-${mode.frameRate}`}><td>{mode.width} × {mode.height}</td><td>{mode.frameRate} fps</td><td>{result ? <span className={`status-pill ${result.status === "passed" ? "reachable" : "error"}`}>{result.status === "passed" ? "原生通过" : result.error || "不支持"}</span> : <span className="status-pill">未测试</span>}</td><td>{result?.actualWidth && result?.actualHeight ? `${result.actualWidth} × ${result.actualHeight}` : "—"}</td></tr>; })}</tbody></table></div>
    </div>
  </section>;
}

function LabPreview({ devices, selectedId, onSelect, onRefresh, scanning }: {
  devices: DeviceInfo[];
  selectedId: string;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  scanning: boolean;
}) {
  const [activeCrop, setActiveCrop] = useState<number | null>(null);
  const [pendingCrop, setPendingCrop] = useState<number | null>(null);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [cropError, setCropError] = useState("");
  const previewSettleRef = useRef<{
    pixels: number;
    previous: number | null;
    resolve: () => void;
  } | null>(null);

  const onCropSettled = useCallback((pixels: number, ok: boolean) => {
    const pending = previewSettleRef.current;
    if (!pending || pending.pixels !== pixels) return;
    previewSettleRef.current = null;
    if (!ok) {
      setActiveCrop(pending.previous);
      setCropError(`预览未稳定切换到 ${pixels} × ${pixels}，已恢复上一档。`);
    }
    pending.resolve();
  }, []);

  const waitForPreviewSettle = (pixels: number, previous: number | null): Promise<void> => new Promise(resolve => {
    const timeout = window.setTimeout(() => {
      if (previewSettleRef.current?.pixels === pixels) {
        previewSettleRef.current = null;
        setActiveCrop(previous);
        setCropError(`等待 ${pixels} × ${pixels} 预览稳定超时，已恢复上一档。`);
      }
      resolve();
    // UVC renegotiation can take several seconds on macOS. A failed request
    // also gets a full stream restart, so leave enough time for that recovery
    // before rolling the UI state back and unlocking the controls.
    }, 10000);
    previewSettleRef.current = {
      pixels,
      previous,
      resolve: () => {
        window.clearTimeout(timeout);
        resolve();
      },
    };
  });

  const selectCrop = async (pixels: number) => {
    if (pendingCrop !== null || activeCrop === pixels) return;
    const previousCrop = activeCrop;
    setPendingCrop(pixels);
    setCropError("");
    try {
      // The six sizes are real UVC modes advertised by the MS2133 device.
      // Let CapturePreview negotiate the hardware mode through the track;
      // do not send guessed register writes through the unrelated Flash HID
      // interface.
      const settled = waitForPreviewSettle(pixels, previousCrop);
      setActiveCrop(pixels);
      await settled;
    } catch (error) {
      setActiveCrop(previousCrop);
      previewSettleRef.current = null;
      setCropError(`切换到 ${pixels} × ${pixels} 失败：${errorText(error)}`);
    } finally {
      setPendingCrop(null);
    }
  };
  return <div className="lab-page">
    <div className="lab-grid">
      <section className="panel lab-card" aria-labelledby="lab-device-heading">
        <div className="section-heading"><div className="heading-title"><Icon name="usb"/><h2 id="lab-device-heading">已连接设备</h2></div><button className="button small" onClick={onRefresh} disabled={scanning}><Icon name="refresh" spin={scanning}/>{scanning ? "读取中" : "刷新"}</button></div>
        {devices.length === 0 ? <div className="empty-state"><Icon name="usb"/><h3>尚未连接设备</h3><p>连接采集卡后点击刷新。</p></div> : <div className="lab-device-list">{devices.map(device => <button key={device.id} className={`lab-device-row ${selectedId === device.id ? "selected" : ""}`} onClick={() => onSelect(device.id)}><div><strong>{device.product || "MS213x 设备"}</strong><span>VID {hex(device.vendorId)} · PID {hex(device.productId)}</span></div><span className="lab-device-status"><span className={`status-pill firmware-type ${device.firmwareType ?? "unknown"}`}>{firmwareInterfaceName[device.firmwareType ?? "unknown"]}</span><span className={`status-pill ${device.status}`}>{statusName[device.status]}</span></span></button>)}</div>}
      </section>
      <section className="panel lab-card" aria-labelledby="lab-roi-heading">
        <div className="section-heading"><div className="heading-title"><Icon name="check"/><h2 id="lab-roi-heading">硬件裁剪模式检测</h2></div></div>
        <div className="roi-preview-grid">{HARDWARE_CROP_MODES.map(pixels => <button className={`roi-preview-row ${activeCrop === pixels ? "active" : ""} ${pendingCrop === pixels ? "pending" : ""}`} key={pixels} type="button" onClick={() => void selectCrop(pixels)} disabled={pendingCrop !== null || captureBusy} aria-pressed={activeCrop === pixels} aria-label={`切换到 ${pixels} × ${pixels}`}>{pixels} × {pixels}</button>)}</div>
        {cropError && <p className="preview-error crop-switch-error" role="status">{cropError}</p>}
      </section>
    </div>
    <CapturePreview requestedCrop={activeCrop} switching={pendingCrop !== null} onCropSettled={onCropSettled} onBusyChange={setCaptureBusy}/>
  </div>;
}

function App() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [firmware, setFirmware] = useState<FirmwareInfo | null>(null);
  const [flashSource, setFlashSource] = useState<"container" | "backup" | "factory">("container");
  const [task, setTask] = useState<"backup" | "flash" | "factory">("backup");
  const [view, setView] = useState<"flasher" | "lab">("flasher");
  const [guideOpen, setGuideOpen] = useState(false);
  const [recovery, setRecovery] = useState<RecoverySummary>({ available: false });
  const [operation, setOperation] = useState<OperationState | null>(null);
  const [scanning, setScanning] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [localLogs, setLocalLogs] = useState<LogEntry[]>([]);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [exportPath, setExportPath] = useState("");
  const mounted = useRef(true);
  const pollBusy = useRef(false);
  const logEnd = useRef<HTMLDivElement>(null);
  const running = operation?.status === "running";
  const busy = Boolean(running || pending || scanning);
  const device = devices.find(d => d.id === selectedId);
  const log = useCallback((message: string, level: LogEntry["level"] = "info") => setLocalLogs(previous => [...previous.slice(-99), { timestamp: new Date().toISOString(), level, message }]), []);
  const fail = useCallback((e: unknown) => { const message = errorText(e); setError(message); log(message, "error"); }, [log]);

  const scan = useCallback(async () => {
    setScanning(true); setError("");
    try {
      const result = await invoke<ScanResult>("scan_devices");
      if (!mounted.current) return;
      setDevices(result.devices); setDiagnostics(result.diagnostics ?? []);
      setSelectedId(old => result.devices.some(d => d.id === old) ? old : result.devices.length === 1 ? result.devices[0].id : "");
      log(`扫描完成：发现 ${result.devices.length} 个候选接口。`);
    } catch (e) { if (mounted.current) fail(e); }
    finally { if (mounted.current) setScanning(false); }
  }, [fail, log]);

  useEffect(() => {
    mounted.current = true;
    void scan();
    void invoke<OperationState | null>("get_operation").then(state => { if (mounted.current) setOperation(state); }).catch(e => { if (mounted.current) fail(e); });
    return () => { mounted.current = false; };
  }, [scan, fail]);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(async () => {
      if (pollBusy.current) return;
      pollBusy.current = true;
      try { const state = await invoke<OperationState | null>("get_operation"); if (mounted.current) setOperation(state); }
      catch (e) { if (mounted.current) fail(e); }
      finally { pollBusy.current = false; }
    }, 650);
    return () => window.clearInterval(id);
  }, [running, fail]);

  useEffect(() => {
    const container = logEnd.current?.parentElement;
    if (container) container.scrollTop = container.scrollHeight;
  }, [operation?.logs.length, localLogs.length]);
  useEffect(() => {
    void invoke<RecoverySummary>("get_recovery_summary").then(value => { if (mounted.current) setRecovery(value); }).catch(e => { if (mounted.current) fail(e); });
  }, [operation?.backupPath, operation?.status, fail]);
  useEffect(() => {
    if (!running) return;
    const leaving = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, [running]);

  const connect = async () => {
    setPending(true); setError("");
    try { await requestWebDevice(); await scan(); } catch (e) { fail(e); }
    finally { setPending(false); }
  };
  const chooseFirmware = async (restore = false) => {
    setPending(true); setError("");
    try {
      const path = await invoke<string | null>(restore ? "choose_restore" : "choose_firmware");
      if (!path) return;
      const info = await invoke<FirmwareInfo>("inspect_firmware", { path });
      setFlashSource(restore ? "backup" : "container");
      setFirmware(info);
      log(`已检查文件：${path}`, info.valid ? "success" : "warning");
    } catch (e) { fail(e); }
    finally { setPending(false); }
  };
  const loadSavedBackup = async () => {
    setPending(true); setError("");
    try { const info = await invoke<FirmwareInfo>("load_saved_backup"); setFlashSource("backup"); setFirmware(info); log("已加载本机保存的完整备份并校验启动容器；尚未执行写入。", "success"); }
    catch (e) { fail(e); }
    finally { setPending(false); }
  };
  const loadFactoryFirmware = async () => {
    setPending(true); setError("");
    setFirmware(null);
    try {
      const info = await invoke<FirmwareInfo>("load_factory_firmware");
      setFlashSource("factory"); setFirmware(info);
      log("已加载内置原厂 BIN；原厂直刷不会读取Flash或创建备份。", "success");
    } catch (e) { fail(e); }
    finally { setPending(false); }
  };
  const start = async (kind: "backup" | "flash" | "factory") => {
    const selected = firmware;
    if (!device || busy || (kind !== "backup" && !selected?.valid)) return;
    setPending(true); setError("");
    try {
      const result = kind === "backup"
        ? await invoke<OperationState>("start_backup", { deviceId: device.id })
        : await invoke<OperationState>(kind === "factory" ? "start_restore" : "start_firmware", { deviceId: device.id, firmwarePath: selected!.path });
      setOperation(result);
    } catch (e) { fail(e); }
    finally { setPending(false); }
  };
  const cancel = async () => {
    if (!operation?.cancellable || pending) return;
    setPending(true);
    try { await invoke("cancel_operation"); setOperation(await invoke<OperationState | null>("get_operation")); }
    catch (e) { fail(e); }
    finally { setPending(false); }
  };
  const exportDiagnostics = async () => {
    setPending(true);
    try { const path = await invoke<string | null>("export_diagnostics"); if (path) { setExportPath(path); log(`诊断已导出：${path}`, "success"); } }
    catch (e) { fail(e); }
    finally { setPending(false); }
  };
  const saveBackup = async () => {
    setPending(true); setError("");
    try {
      await invoke(operation?.backupDownloaded ? "confirm_backup_saved" : "save_pending_backup");
      setOperation(await invoke<OperationState | null>("get_operation"));
    } catch (e) { fail(e); }
    finally { setPending(false); }
  };
  const exportRecovery = async () => {
    setPending(true);
    try { const path = await invoke<string>("export_recovery_package"); log(`恢复包已导出：${path}`, "success"); }
    catch (e) { fail(e); }
    finally { setPending(false); }
  };
  const logs = [...localLogs, ...(operation?.logs ?? [])].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const progress = Math.max(0, Math.min(100, operation?.progress ?? 0));
  const writable = Boolean(device?.canWriteFlash && firmware?.valid && !busy);
  const canStart = task === "backup" ? Boolean(device?.canReadFlash && !busy) : writable;
  const taskLabel = task === "backup" ? "备份当前固件" : task === "factory" ? "恢复原厂固件" : "刷写固件";
  return <div className="app">
    <header className="topbar">
      <div className="brand"><div className="brand-mark" aria-hidden="true"><svg className="brand-logo" viewBox="0 0 56 56" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 11h-7a1 1 0 0 0-1 1v7M37 11h7a1 1 0 0 1 1 1v7M45 37v7a1 1 0 0 1-1 1h-7M19 45h-7a1 1 0 0 1-1-1v-7"/><rect x="17" y="17" width="22" height="22" rx="6"/><path d="M28 23v10m-5-5h10"/><circle cx="42" cy="14" r="2.3" fill="currentColor" stroke="none"/></svg></div><div><h1>固件备份与刷写</h1><a className="brand-description repo-promo" href="https://github.com/cryomachine/ms2133-webhid-flasher" target="_blank" rel="noreferrer">开源项目 · 欢迎 Star 支持 OCAP V3 / MS2133</a></div></div>
      <div className="header-actions"><a className="button guide-link" href="#usage-guide" onClick={() => setGuideOpen(true)}><Icon name="file"/>使用说明</a></div>
    </header>
    <nav className="page-tabs" aria-label="工具页面"><button className={view === "flasher" ? "active" : ""} onClick={() => setView("flasher")}>固件刷写</button><button className={`status-page-tab ${view === "lab" ? "active" : ""}`} onClick={() => setView("lab")}><span>固件状态</span><span className="testing-badge">测试中</span></button></nav>
    {view === "lab" ? <main className="lab-main"><LabPreview devices={devices} selectedId={selectedId} onSelect={setSelectedId} onRefresh={() => void scan()} scanning={scanning}/></main> : <main>
      {error && <div className="error-banner" role="alert"><Icon name="alert"/><div><strong>操作未完成</strong><p>{error}</p></div><button className="dismiss" onClick={() => setError("")} aria-label="关闭错误提示">×</button></div>}
      {operation?.status === "interrupted" && <div className="error-banner" role="status"><Icon name="alert"/><div><strong>发现上次中断的操作</strong><p>{operation.message} 本页保留操作记录和恢复包，不会自动重试擦写。</p></div></div>}
      <div className="workspace">
        <div className="workflow-column">
          <section className="panel device-panel" aria-labelledby="device-heading">
            <div className="section-heading"><div className="heading-title"><span className="step">01</span><h2 id="device-heading">连接设备</h2></div><div className="connect-actions">{webMode && <button className="button small connect-button" onClick={() => void connect()} disabled={busy || scanning}><Icon name="usb"/>连接采集卡</button>}<button className="button small" onClick={() => void scan()} disabled={scanning || busy}><Icon name="refresh" spin={scanning}/>{scanning ? "扫描中" : "刷新设备"}</button></div></div>
            <div className="device-list" role="radiogroup" aria-label="采集卡接口">
              {devices.length === 0 ? <div className="empty-state"><Icon name="usb"/><h3>{scanning ? "正在读取设备列表" : "等待连接采集卡"}</h3><p>{scanning ? "正在读取 USB 与 HID 枚举信息。" : webMode ? "点击“连接采集卡”，在浏览器弹窗中选择设备。" : "通过 USB 连接采集卡后，点击“刷新设备”。"}</p></div> : devices.map(item => <button key={item.id} className={`device-card ${selectedId === item.id ? "selected" : ""}`} role="radio" aria-checked={selectedId === item.id} onClick={() => setSelectedId(item.id)} disabled={busy}>
                <div className="device-title"><span className="radio-dot"/><strong>{item.product || "USB 采集设备"}</strong><span className={`status-pill firmware-type ${item.firmwareType ?? "unknown"}`}>{firmwareInterfaceName[item.firmwareType ?? "unknown"]}</span><span className={`status-pill ${item.status}`}>{statusName[item.status]}</span></div>
                <div className="device-identifiers"><span>VID {hex(item.vendorId)}</span><span>PID {hex(item.productId)}</span><span>接口 {item.interfaceNumber ?? "—"}</span></div>
              </button>)}
            </div>
            {device && <><div className="capability-row"><span className={`capability ${device.canReadFlash ? "ready" : ""}`}><Icon name={device.canReadFlash ? "check" : "alert"}/>{device.canReadFlash ? "备份通道预检通过" : "备份通道未就绪"}</span><span className={`capability ${device.canWriteFlash ? "ready" : ""}`}><Icon name={device.canWriteFlash ? "check" : "alert"}/>{device.canWriteFlash ? "写入校验预检通过" : "写入通道未就绪"}</span></div><details className="technical-details"><summary>所选接口详情</summary><dl className="detail-list"><div><dt>设备路径</dt><dd>{device.path}</dd></div><div><dt>固件接口</dt><dd><span className={`status-pill firmware-type ${device.firmwareType ?? "unknown"}`}>{firmwareInterfaceName[device.firmwareType ?? "unknown"]}</span></dd></div><div><dt>Usage page / usage</dt><dd>{hex(device.usagePage)} / {hex(device.usage)}</dd></div><div><dt>Feature report（含 ID）</dt><dd>{device.featureReportLength == null ? "尚未确认" : `${device.featureReportLength} 字节`}</dd></div><div><dt>序列号</dt><dd>{device.serial || "当前接口未提供"}</dd></div><div><dt>协议探测</dt><dd>{device.detail || "—"}</dd></div></dl></details></>}
            {diagnostics.length > 0 && <details className="technical-details scan-details"><summary>扫描诊断（{diagnostics.length}）</summary><div className="diagnostic-messages">{diagnostics.map((message, i) => <p key={i}>{message}</p>)}</div></details>}
          </section>
          <section className="panel task-panel" aria-labelledby="task-heading">
            <div className="section-heading"><div className="heading-title"><span className="step">02</span><h2 id="task-heading">选择任务</h2></div><p className="section-note heading-note">选择任务后不会立即执行，点击下方操作按钮才会开始。</p></div>
            <div className="task-grid" aria-label="任务">
              <button className={`task-card ${task === "backup" ? "selected" : ""}`} aria-pressed={task === "backup"} onClick={() => setTask("backup")} disabled={busy}><Icon name="download"/><strong>备份当前固件</strong><span>读取设备并保存完整备份</span></button>
              <button className={`task-card ${task === "flash" ? "selected" : ""}`} aria-pressed={task === "flash"} onClick={() => setTask("flash")} disabled={busy}><Icon name="upload"/><strong>刷写固件</strong><span>选择固件容器或完整备份</span></button>
              <button className={`task-card ${task === "factory" ? "selected" : ""}`} aria-pressed={task === "factory"} onClick={() => { setTask("factory"); void loadFactoryFirmware(); }} disabled={busy}><Icon name="restore"/><strong>恢复原厂固件</strong><span>使用内置原厂 BIN 直接刷写</span></button>
            </div>
          </section>
          <section className="panel firmware-panel" aria-labelledby="file-heading">
            <div className="section-heading"><div className="heading-title"><span className="step">03</span><h2 id="file-heading">{task === "backup" ? "准备备份" : task === "factory" ? "准备原厂固件" : "选择写入文件"}</h2></div><p className="section-note heading-note">{task === "backup" ? "当前备份任务不需要输入文件。" : task === "factory" ? "使用网页内置的原厂 BIN，不读取设备、不创建备份。" : "请选择固件容器或完整 Flash 备份。"}</p></div>
            {task === "backup" ? <div className="backup-intro"><div className="intro-icon"><Icon name="download"/></div><div><h3>先保存设备当前的完整内容</h3><p>连续读取两遍并核对一致性。备份完成后下载文件，恢复包可在右侧单独导出。</p></div></div> : task === "factory" ? <><p className="section-note">原厂固件由网页从 public/firmware/factory.bin 加载。已确认原厂接口时走直刷路径；其他可写接口继续使用标准校验流程。</p><div className="file-actions"><button className="button selected-source" onClick={() => void loadFactoryFirmware()} disabled={busy}><Icon name="restore"/>重新加载原厂 BIN</button></div><FirmwareCard info={firmware}/></> : <><p className="section-note">选择要写入的文件：98,356 字节固件容器，或完整 Flash 备份。完整备份会自动提取启动容器并保留设备当前尾部。</p><div className="file-actions"><button className={`button ${flashSource === "container" ? "selected-source" : ""}`} onClick={() => void chooseFirmware(false)} disabled={busy}><Icon name="file"/>选择固件容器</button><button className={`button ${flashSource === "backup" ? "selected-source" : ""}`} onClick={() => void chooseFirmware(true)} disabled={busy}><Icon name="restore"/>选择完整备份</button><button className={`button ${flashSource === "backup" ? "selected-source" : ""}`} onClick={() => void loadSavedBackup()} disabled={busy || (recovery.backupBytes ?? 0) < 98356}><Icon name="restore"/>使用本机已存备份</button></div><FirmwareCard info={firmware}/></>}
            {task === "flash" && <p className="compatibility-note">导入的文件检查协议、容器和存储容量；校验通过不代表已验证板卡兼容。完整备份只提取启动镜像，保留设备当前尾部。</p>}
            <div className="primary-action"><div><strong>{device ? device.product || "已选择采集卡接口" : "等待选择目标设备"}</strong><p>{task === "backup" ? "设备可读取时，即可开始双读备份。" : task === "factory" && device?.firmwareType === "stock" ? "确认原厂接口后直接刷写，不读取固件、不备份。" : task === "flash" && device?.firmwareType === "stock" ? "原厂接口将按原厂基线筛选变化扇区，不读取固件、不备份。" : "写入前需完成备份保存；写入后回读校验。"}</p></div><button className="button primary-button" onClick={() => void start(task)} disabled={!canStart}><Icon name={task === "backup" ? "download" : task === "factory" ? "restore" : "upload"}/>{pending || running ? "操作处理中" : taskLabel}</button></div>
            <p className="action-note">{task === "backup" ? "操作期间保持 USB 连接，并留意右侧的备份保存提示。" : (task === "factory" || task === "flash") && device?.firmwareType === "stock" ? "原厂接口不会读取设备固件或创建备份；保持设备供电直到写入完成。" : device?.canWriteFlash ? "擦写开始后，取消功能将锁定。保持设备供电，等待回读结果。" : "连接并选择通过协议探测的接口后，开放恢复与刷写。"}</p>
          </section>
        </div>
        <aside className="status-column" aria-label="操作状态与恢复包">
          <section className="panel operation-panel" aria-labelledby="operation-heading">
            <div className="section-heading"><div className="heading-title"><span className="step">04</span><h2 id="operation-heading">执行状态</h2></div>{operation?.status && operation.status !== "idle" && <span className={`status-pill ${operation.status === "complete" ? "reachable" : operation.status === "failed" || operation.status === "interrupted" ? "error" : "enumerated"}`}>{({ running: "执行中", complete: "已完成", failed: "失败", cancelled: "已取消", interrupted: "上次已中断", idle: "空闲" })[operation.status]}</span>}</div>
            <div className="progress-heading"><b>{Math.round(progress)}<small>%</small></b><strong>{operation?.message || "等待开始"}</strong><span>{operation?.phase || "连接设备并选择任务后，点击主按钮开始。"}</span></div>
            <div className={`progress-track ${operation?.status === "failed" ? "failed" : ""}`} role="progressbar" aria-label="操作进度" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${progress}%` }}/></div>
            {operation?.backupSaveRequired && <div className="backup-barrier" role="status"><div className="barrier-title"><Icon name="download"/><strong>{operation.backupDownloaded ? "请确认备份已保存" : "请先下载备份"}</strong></div><p>{operation.backupDownloaded ? "确认下载文件已保存在本机，再继续后续操作。" : "后续操作已暂停。下载完成后，还需点击按钮确认保存。"}</p><button className="button primary-button" onClick={() => void saveBackup()} disabled={pending}><Icon name={operation.backupDownloaded ? "check" : "download"}/>{operation.backupDownloaded ? "已保存备份，继续" : "下载备份"}</button></div>}
            {operation?.error && <p className="operation-error" role="alert">{operation.error}</p>}
            {(operation?.backupPath || operation?.outputPath) && <details className="technical-details output-files"><summary>备份与输出位置</summary>{operation.backupPath && <p><strong>备份：</strong>{operation.backupPath}</p>}{operation.outputPath && <p><strong>输出：</strong>{operation.outputPath}</p>}</details>}
            <button className="button cancel-button" onClick={() => void cancel()} disabled={!running || !operation?.cancellable || pending}><Icon name="stop"/>{running && !operation?.cancellable ? "擦写开始后不可取消" : "取消操作"}</button>
          </section>
          <section className="panel recovery-panel" aria-labelledby="recovery-heading"><div className="section-heading"><div className="heading-title"><Icon name="restore"/><h2 id="recovery-heading">本机恢复包</h2></div><span className={`status-pill ${recovery.available ? "reachable" : "enumerated"}`}>{recovery.available ? "已保存" : "待生成"}</span></div><p className="section-note">{recovery.available ? `${recovery.device ?? "MS2133"} · Flash 备份 ${size(recovery.backupBytes ?? 0)}。这是浏览器本地保存的完整备份和设备信息，可导出后作为后续恢复输入。` : "开始操作后，完整 Flash 备份和设备信息会保存在本机浏览器。"}</p><button className="button recovery-export" onClick={() => void exportRecovery()} disabled={pending || !recovery.available || Boolean(running && !operation?.backupSaveRequired)}><Icon name="download"/>导出恢复包</button><details className="technical-details"><summary>重连与恢复说明</summary><p>回读完成后，如设备需重新枚举，断开 USB 及 HDMI 所有供电再重连，点击“刷新设备”。原厂与 ROI 接口的报告结构可能不同。</p><p>设备仍需可枚举、可通信。ROM 接口出现不代表已支持写入；USB 层完全没有设备时，本工具没有可达的刷写入口。</p></details></section>
        </aside>
      </div>
      <section className="panel logs-panel" aria-labelledby="logs-heading"><div className="section-heading"><div className="heading-title"><h2 id="logs-heading">操作日志</h2><span className="quiet-tag">{logs.length} 条</span></div><button className="button small" onClick={() => void exportDiagnostics()} disabled={pending}><Icon name="export"/>导出诊断</button></div><div className="log-view" aria-live="polite" aria-relevant="additions text">{logs.length === 0 ? <p className="log-empty">尚无操作记录。设备扫描和任务执行信息会显示在这里。</p> : logs.map((entry, i) => <div className={`log-line ${entry.level}`} key={`${entry.timestamp}-${i}`}><time>{/^\d{4}-/.test(entry.timestamp) ? new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour12: false }) : entry.timestamp}</time><span>{entry.message}</span></div>)}<div ref={logEnd}/></div>{exportPath && <p className="export-path">诊断文件：{exportPath}</p>}</section>
      <details className="panel usage-guide" id="usage-guide" open={guideOpen} onToggle={event => setGuideOpen(event.currentTarget.open)}><summary><span><Icon name="file"/><strong>使用说明与功能指南</strong></span><span className="summary-hint">连接 · 备份 · 刷写</span></summary><div className="guide-content"><div><h3>按四步开始</h3><ol><li><strong>连接设备。</strong>{webMode ? "使用桌面版 Chrome / Edge，点击“连接采集卡”并授权目标 HID 接口。" : "通过 USB 连接采集卡，点击“刷新设备”。"} 列表中的读写状态来自实际协议探测。</li><li><strong>选择任务。</strong>备份无需输入文件；刷写可导入固件容器、完整备份或加载当前浏览器已存备份。</li><li><strong>开始并保存备份。</strong>点击任务主按钮。出现保存提示后先下载备份，再明确确认已保存，后续操作才继续。</li><li><strong>查看结果。</strong>等待写入及回读校验完成，按需导出恢复包和诊断日志。需要重新枚举时，按“重连与恢复说明”操作。</li></ol></div><div><h3>文件与操作规则</h3><ul><li>升级容器为 98356 字节。整片 Flash 备份会提取开头的启动镜像，保留设备当前尾部。</li><li>本工具不附带固件，也不向服务器传输固件。导入的文件在浏览器本地处理，仍需与实际板卡相符。</li><li>本机已存备份来自当前浏览器的本地存储；更换浏览器或清除站点数据后，需重新导入自己保存的文件。任何文件都不会自动刷写。</li><li>运行中会锁定设备、任务与文件选择。擦写开始后不可取消，页面关闭或刷新不会自动续写。</li><li>恢复能力取决于设备接口仍可通信，不承诺所有固件或无 USB 枚举设备均可恢复。</li></ul></div></div></details>
      <footer><span className="footer-dot"/>固件文件仅在本地处理</footer>
    </main>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<App/>);
