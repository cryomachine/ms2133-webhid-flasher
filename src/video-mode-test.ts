export type VideoModeDescriptor = {
  width: number;
  height: number;
  frameRate: number;
};

type NativeVideoConstraints = MediaTrackConstraints & { resizeMode?: ConstrainDOMString };

export const SIX_CAPTURE_TEST_MODES: readonly VideoModeDescriptor[] = [
  { width: 192, height: 192, frameRate: 240 },
  { width: 256, height: 256, frameRate: 240 },
  { width: 320, height: 320, frameRate: 240 },
  { width: 416, height: 416, frameRate: 240 },
  { width: 512, height: 512, frameRate: 240 },
  { width: 640, height: 640, frameRate: 240 },
];

export type SixCaptureTestResult = VideoModeDescriptor & {
  status: "passed" | "failed";
  actualWidth: number | null;
  actualHeight: number | null;
  actualFrameRate: number | null;
  observedFrameRate: number | null;
  frameCount: number;
  elapsedMs: number;
  error?: string;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function applyConstraintsWithTimeout(
  track: MediaStreamTrack,
  constraints: NativeVideoConstraints,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`UVC 模式约束调用超时（${timeoutMs}ms）`));
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

async function ensureVideoPlaying(video: HTMLVideoElement): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (video.paused) await video.play();
      return;
    } catch (error) {
      if (!errorText(error).includes("interrupted") || attempt === 2) throw error;
      await new Promise<void>(resolve => window.setTimeout(resolve, 120));
    }
  }
}

async function rebindVideoStream(video: HTMLVideoElement, stream: MediaStream): Promise<void> {
  video.pause();
  video.srcObject = null;
  await new Promise<void>(resolve => window.setTimeout(resolve, 60));
  video.srcObject = stream;
  await ensureVideoPlaying(video);
}

function waitForMetadata(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  if (video.readyState >= 1 && video.videoWidth > 0 && video.videoHeight > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      video.removeEventListener("loadedmetadata", loaded);
      reject(new Error("等待视频模式元数据超时"));
    }, timeoutMs);
    const loaded = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", loaded);
      resolve();
    };
    video.addEventListener("loadedmetadata", loaded, { once: true });
  });
}

async function sampleFrames(video: HTMLVideoElement, durationMs: number): Promise<{ frameCount: number; elapsedMs: number }> {
  if (!("requestVideoFrameCallback" in video)) throw new Error("当前浏览器不支持逐帧回调");
  await waitForMetadata(video, 1500);
  const started = performance.now();
  let frameCount = 0;
  await new Promise<void>(resolve => {
    const deadline = started + durationMs;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(finish, durationMs + 1500);
    const onFrame = (timestamp: number) => {
      if (finished) return;
      frameCount += 1;
      if (timestamp >= deadline) finish();
      else video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  });
  const elapsedMs = Math.max(1, performance.now() - started);
  return { frameCount, elapsedMs };
}

async function waitForModeSettled(
  track: MediaStreamTrack,
  video: HTMLVideoElement,
  mode: VideoModeDescriptor,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  // applyConstraints() resolves when the request is accepted, but UVC
  // devices can publish the new dimensions a little later. Poll both the
  // track settings and the decoded video dimensions before sampling frames.
  while (performance.now() < deadline) {
    const settings = track.getSettings();
    const trackMatches = settings.width === mode.width && settings.height === mode.height;
    const videoMatches = video.videoWidth === mode.width && video.videoHeight === mode.height;
    if (trackMatches && videoMatches) {
      // Let the decoder present at least one frame at the new dimensions
      // before the sampling window starts; UVC mode changes can otherwise
      // leave one or two frames from the previous mode in the queue.
      await new Promise<void>(resolve => window.setTimeout(resolve, 120));
      return;
    }
    await new Promise<void>(resolve => window.setTimeout(resolve, 40));
  }
  const settings = track.getSettings();
  const trackSize = settings.width && settings.height ? `${settings.width} × ${settings.height}` : "未知";
  const videoSize = video.videoWidth && video.videoHeight ? `${video.videoWidth} × ${video.videoHeight}` : "未知";
  throw new Error(`设备未切换到 ${mode.width} × ${mode.height}（轨道 ${trackSize}，画面 ${videoSize}）`);
}

export async function runSixModeCaptureTest(
  stream: MediaStream,
  video: HTMLVideoElement,
  onProgress?: (mode: VideoModeDescriptor, index: number, total: number) => void,
  durationMs = 1000,
): Promise<SixCaptureTestResult[]> {
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error("没有可测试的视频轨道");
  // Keep this helper usable independently of the React preview lifecycle.
  // The caller may have obtained the stream just before the <video> effect
  // ran, so bind and start playback explicitly here as well.
  if (video.srcObject !== stream) video.srcObject = stream;
  await ensureVideoPlaying(video);
  const results: SixCaptureTestResult[] = [];
  for (let index = 0; index < SIX_CAPTURE_TEST_MODES.length; index++) {
    const mode = SIX_CAPTURE_TEST_MODES[index];
    onProgress?.(mode, index, SIX_CAPTURE_TEST_MODES.length);
    const started = performance.now();
    try {
      await applyConstraintsWithTimeout(track, {
        width: { exact: mode.width },
        height: { exact: mode.height },
        frameRate: { ideal: mode.frameRate, max: mode.frameRate },
        resizeMode: { exact: "none" },
      }, 4000);
      // A UVC mode change can leave the HTMLVideoElement decoding one or
      // more frames from the previous mode. Rebinding the same stream flushes
      // that queue before dimensions and frame counts are measured.
      await rebindVideoStream(video, stream);
      await waitForMetadata(video, 3000);
      await waitForModeSettled(track, video, mode, 3000);
      const settings = track.getSettings();
      const sample = await sampleFrames(video, durationMs);
      if (sample.frameCount === 0) throw new Error("测试窗口内未收到视频帧");
      results.push({ ...mode, status: "passed", actualWidth: settings.width ?? (video.videoWidth || null),
        actualHeight: settings.height ?? (video.videoHeight || null), actualFrameRate: settings.frameRate ?? null,
        observedFrameRate: sample.frameCount * 1000 / sample.elapsedMs, frameCount: sample.frameCount,
        elapsedMs: performance.now() - started });
    } catch (error) {
      const settings = track.getSettings();
      results.push({ ...mode, status: "failed", actualWidth: settings.width ?? null, actualHeight: settings.height ?? null,
        actualFrameRate: settings.frameRate ?? null, observedFrameRate: null, frameCount: 0,
        elapsedMs: performance.now() - started, error: errorText(error) });
      if (errorText(error).startsWith("UVC 模式约束调用超时")) {
        for (let remaining = index + 1; remaining < SIX_CAPTURE_TEST_MODES.length; remaining++) {
          const pendingMode = SIX_CAPTURE_TEST_MODES[remaining];
          results.push({ ...pendingMode, status: "failed", actualWidth: null, actualHeight: null,
            actualFrameRate: null, observedFrameRate: null, frameCount: 0, elapsedMs: 0,
            error: "前一档 UVC 约束未返回，已停止后续切换" });
        }
        break;
      }
    }
  }
  return results;
}
