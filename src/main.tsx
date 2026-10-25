import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { callBackend as invoke, requestWebDevice, webMode } from "./backend";
import "./webhid-protocol";
import type { DeviceInfo, FirmwareInfo, LogEntry, OperationState, ScanResult } from "./types";
import type { RecoverySummary } from "./storage";
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
const errorText = (e: unknown) => typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
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

function App() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [firmware, setFirmware] = useState<FirmwareInfo | null>(null);
  const [flashSource, setFlashSource] = useState<"container" | "backup">("container");
  const [task, setTask] = useState<"backup" | "flash">("backup");
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
  const start = async (kind: "backup" | "flash") => {
    const selected = firmware;
    if (!device || busy || (kind !== "backup" && !selected?.valid)) return;
    setPending(true); setError("");
    try {
      const result = kind === "backup"
        ? await invoke<OperationState>("start_backup", { deviceId: device.id })
        : await invoke<OperationState>("start_firmware", { deviceId: device.id, firmwarePath: selected!.path });
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
  const taskLabel = task === "backup" ? "备份当前固件" : "刷写固件";
  return <div className="app">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Icon name="usb"/></div><div><p className="eyebrow">MS2133 / WEBHID FLASHER</p><h1>固件备份与刷写</h1><p className="brand-description">开源网页工具 · 不附带固件</p></div></div>
      <div className="header-actions"><span className="platform-tag">{webMode ? "WebHID · Chrome / Edge" : "macOS / Windows / Linux"}</span><a className="button guide-link" href="#usage-guide" onClick={() => setGuideOpen(true)}><Icon name="file"/>使用说明</a></div>
    </header>
    <main>
      {error && <div className="error-banner" role="alert"><Icon name="alert"/><div><strong>操作未完成</strong><p>{error}</p></div><button className="dismiss" onClick={() => setError("")} aria-label="关闭错误提示">×</button></div>}
      {operation?.status === "interrupted" && <div className="error-banner" role="status"><Icon name="alert"/><div><strong>发现上次中断的操作</strong><p>{operation.message} 本页保留操作记录和恢复包，不会自动重试擦写。</p></div></div>}
      <div className="workspace">
        <div className="workflow-column">
          <section className="panel device-panel" aria-labelledby="device-heading">
            <div className="section-heading"><div className="heading-title"><span className="step">01</span><h2 id="device-heading">连接设备</h2></div><div className="connect-actions">{webMode && <button className="button small connect-button" onClick={() => void connect()} disabled={busy || scanning}><Icon name="usb"/>连接采集卡</button>}<button className="button small" onClick={() => void scan()} disabled={scanning || busy}><Icon name="refresh" spin={scanning}/>{scanning ? "扫描中" : "刷新设备"}</button></div></div>
            <p className="section-note">选择要操作的采集卡接口。读写能力以实际通信探测为准。</p>
            <div className="device-list" role="radiogroup" aria-label="采集卡接口">
              {devices.length === 0 ? <div className="empty-state"><Icon name="usb"/><h3>{scanning ? "正在读取设备列表" : "等待连接采集卡"}</h3><p>{scanning ? "正在读取 USB 与 HID 枚举信息。" : webMode ? "点击“连接采集卡”，在浏览器弹窗中选择设备。" : "通过 USB 连接采集卡后，点击“刷新设备”。"}</p></div> : devices.map(item => <button key={item.id} className={`device-card ${selectedId === item.id ? "selected" : ""}`} role="radio" aria-checked={selectedId === item.id} onClick={() => setSelectedId(item.id)} disabled={busy}>
                <div className="device-title"><span className="radio-dot"/><strong>{item.product || "USB 采集设备"}</strong><span className={`status-pill ${item.status}`}>{statusName[item.status]}</span></div>
                <div className="device-identifiers"><span>VID {hex(item.vendorId)}</span><span>PID {hex(item.productId)}</span><span>接口 {item.interfaceNumber ?? "—"}</span></div>
                {item.detail && <p className="device-detail">{item.detail}</p>}
                {item.productId === 0x0001 && <p className="device-detail">已枚举到 ROM 恢复接口，读写能力仍需通过协议探测。</p>}
              </button>)}
            </div>
            {device && <><div className="capability-row"><span className={`capability ${device.canReadFlash ? "ready" : ""}`}><Icon name={device.canReadFlash ? "check" : "alert"}/>{device.canReadFlash ? "可读取备份" : "读取未就绪"}</span><span className={`capability ${device.canWriteFlash ? "ready" : ""}`}><Icon name={device.canWriteFlash ? "check" : "alert"}/>{device.canWriteFlash ? "可进入写入校验" : "写入未就绪"}</span></div><details className="technical-details"><summary>所选接口详情</summary><dl className="detail-list"><div><dt>设备路径</dt><dd>{device.path}</dd></div><div><dt>Usage page / usage</dt><dd>{hex(device.usagePage)} / {hex(device.usage)}</dd></div><div><dt>Feature report（含 ID）</dt><dd>{device.featureReportLength == null ? "尚未确认" : `${device.featureReportLength} 字节`}</dd></div><div><dt>序列号</dt><dd>{device.serial || "当前接口未提供"}</dd></div></dl></details></>}
            {diagnostics.length > 0 && <details className="technical-details scan-details"><summary>扫描诊断（{diagnostics.length}）</summary><div className="diagnostic-messages">{diagnostics.map((message, i) => <p key={i}>{message}</p>)}</div></details>}
          </section>
          <section className="panel task-panel" aria-labelledby="task-heading">
            <div className="section-heading"><div className="heading-title"><span className="step">02</span><h2 id="task-heading">选择任务</h2></div><span className="quiet-tag">选择后不会立即执行</span></div>
            <div className="task-grid" aria-label="任务">
              <button className={`task-card ${task === "backup" ? "selected" : ""}`} aria-pressed={task === "backup"} onClick={() => setTask("backup")} disabled={busy}><Icon name="download"/><strong>备份当前固件</strong><span>读取设备并保存完整备份</span></button>
              <button className={`task-card ${task === "flash" ? "selected" : ""}`} aria-pressed={task === "flash"} onClick={() => setTask("flash")} disabled={busy}><Icon name="upload"/><strong>刷写固件</strong><span>选择固件容器或完整备份</span></button>
            </div>
          </section>
          <section className="panel firmware-panel" aria-labelledby="file-heading">
            <div className="section-heading"><div className="heading-title"><span className="step">03</span><h2 id="file-heading">{task === "backup" ? "准备备份" : "选择写入文件"}</h2></div><span className="quiet-tag">{task === "backup" ? "无需输入文件" : "固件或完整备份"}</span></div>
            {task === "backup" ? <div className="backup-intro"><div className="intro-icon"><Icon name="download"/></div><div><h3>先保存设备当前的完整内容</h3><p>连续读取两遍并核对一致性。备份完成后下载文件，恢复包可在右侧单独导出。</p></div></div> : <><p className="section-note">选择要写入的文件：98,356 字节固件容器，或完整 Flash 备份。完整备份会自动提取启动容器并保留设备当前尾部。</p><div className="file-actions"><button className={`button ${flashSource === "container" ? "selected-source" : ""}`} onClick={() => void chooseFirmware(false)} disabled={busy}><Icon name="file"/>选择固件容器</button><button className={`button ${flashSource === "backup" ? "selected-source" : ""}`} onClick={() => void chooseFirmware(true)} disabled={busy}><Icon name="restore"/>选择完整备份</button><button className={`button ${flashSource === "backup" ? "selected-source" : ""}`} onClick={() => void loadSavedBackup()} disabled={busy || (recovery.backupBytes ?? 0) < 98356}><Icon name="restore"/>使用本机已存备份</button></div><FirmwareCard info={firmware}/></>}
            {task === "flash" && <p className="compatibility-note">导入的文件检查协议、容器和存储容量；校验通过不代表已验证板卡兼容。完整备份只提取启动镜像，保留设备当前尾部。</p>}
            <div className="primary-action"><div><strong>{device ? device.product || "已选择采集卡接口" : "等待选择目标设备"}</strong><p>{task === "backup" ? "设备可读取时，即可开始双读备份。" : "写入前需完成备份保存；写入后回读校验。"}</p></div><button className="button primary-button" onClick={() => void start(task)} disabled={!canStart}><Icon name={task === "backup" ? "download" : "upload"}/>{pending || running ? "操作处理中" : taskLabel}</button></div>
            <p className="action-note">{task === "backup" ? "操作期间保持 USB 连接，并留意右侧的备份保存提示。" : device?.canWriteFlash ? "擦写开始后，取消功能将锁定。保持设备供电，等待回读结果。" : "连接并选择通过协议探测的接口后，开放恢复与刷写。"}</p>
          </section>
        </div>
        <aside className="status-column" aria-label="操作状态与恢复包">
          <section className="panel operation-panel" aria-labelledby="operation-heading">
            <div className="section-heading"><div className="heading-title"><span className="step">04</span><h2 id="operation-heading">执行状态</h2></div>{operation?.status && operation.status !== "idle" && <span className={`status-pill ${operation.status === "complete" ? "reachable" : operation.status === "failed" || operation.status === "interrupted" ? "error" : "enumerated"}`}>{({ running: "执行中", complete: "已完成", failed: "失败", cancelled: "已取消", interrupted: "上次已中断", idle: "空闲" })[operation.status]}</span>}</div>
            <div className="progress-heading"><b>{Math.round(progress)}<small>%</small></b><strong>{operation?.message || "等待开始"}</strong><span>{operation?.phase || "连接设备并选择任务后，点击主按钮开始。"}</span></div>
            <div className={`progress-track ${operation?.status === "failed" ? "failed" : ""}`} role="progressbar" aria-label="操作进度" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${progress}%` }}/></div>
            {Boolean(operation?.readTotalBytes) && <p className="section-note read-stats">两遍读取累计 {size(operation?.readBytes ?? 0)} / {size(operation?.readTotalBytes ?? 0)}<br/>本次读取平均 {size(Math.round(operation?.readBytesPerSecond ?? 0))}/s</p>}
            {operation?.backupSaveRequired && <div className="backup-barrier" role="status"><div className="barrier-title"><Icon name="download"/><strong>{operation.backupDownloaded ? "请确认备份已保存" : "请先下载备份"}</strong></div><p>{operation.backupDownloaded ? "确认下载文件已保存在本机，再继续后续操作。" : "后续操作已暂停。下载完成后，还需点击按钮确认保存。"}</p><button className="button primary-button" onClick={() => void saveBackup()} disabled={pending}><Icon name={operation.backupDownloaded ? "check" : "download"}/>{operation.backupDownloaded ? "已保存备份，继续" : "下载备份"}</button></div>}
            {operation?.error && <p className="operation-error" role="alert">{operation.error}</p>}
            {(operation?.backupPath || operation?.outputPath) && <details className="technical-details output-files"><summary>备份与输出位置</summary>{operation.backupPath && <p><strong>备份：</strong>{operation.backupPath}</p>}{operation.outputPath && <p><strong>输出：</strong>{operation.outputPath}</p>}</details>}
            <button className="button cancel-button" onClick={() => void cancel()} disabled={!running || !operation?.cancellable || pending}><Icon name="stop"/>{running && !operation?.cancellable ? "擦写开始后不可取消" : "取消操作"}</button>
          </section>
          <section className="panel recovery-panel" aria-labelledby="recovery-heading"><div className="section-heading"><div className="heading-title"><Icon name="restore"/><h2 id="recovery-heading">本机恢复包</h2></div><span className={`status-pill ${recovery.available ? "reachable" : "enumerated"}`}>{recovery.available ? "已保存" : "待生成"}</span></div><p className="section-note">{recovery.available ? `${recovery.device ?? "MS2133"} · Flash 备份 ${size(recovery.backupBytes ?? 0)}。可导出当前保存的文件与设备信息。` : "开始操作后，文件、设备信息和 Flash 备份会保存在本机。"}</p><button className="button recovery-export" onClick={() => void exportRecovery()} disabled={pending || !recovery.available || Boolean(running && !operation?.backupSaveRequired)}><Icon name="download"/>导出恢复包</button><details className="technical-details"><summary>重连与恢复说明</summary><p>回读完成后，如设备需重新枚举，断开 USB 及 HDMI 所有供电再重连，点击“刷新设备”。原厂与 ROI 接口的报告结构可能不同。</p><p>设备仍需可枚举、可通信。ROM 接口出现不代表已支持写入；USB 层完全没有设备时，本工具没有可达的刷写入口。</p></details></section>
        </aside>
      </div>
      <section className="panel logs-panel" aria-labelledby="logs-heading"><div className="section-heading"><div className="heading-title"><h2 id="logs-heading">操作日志</h2><span className="quiet-tag">{logs.length} 条</span></div><button className="button small" onClick={() => void exportDiagnostics()} disabled={pending}><Icon name="export"/>导出诊断</button></div><div className="log-view" aria-live="polite" aria-relevant="additions text">{logs.length === 0 ? <p className="log-empty">尚无操作记录。设备扫描和任务执行信息会显示在这里。</p> : logs.map((entry, i) => <div className={`log-line ${entry.level}`} key={`${entry.timestamp}-${i}`}><time>{/^\d{4}-/.test(entry.timestamp) ? new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour12: false }) : entry.timestamp}</time><span>{entry.message}</span></div>)}<div ref={logEnd}/></div>{exportPath && <p className="export-path">诊断文件：{exportPath}</p>}</section>
      <details className="panel usage-guide" id="usage-guide" open={guideOpen} onToggle={event => setGuideOpen(event.currentTarget.open)}><summary><span><Icon name="file"/><strong>使用说明与功能指南</strong></span><span className="summary-hint">连接 · 备份 · 刷写</span></summary><div className="guide-content"><div><h3>按四步开始</h3><ol><li><strong>连接设备。</strong>{webMode ? "使用桌面版 Chrome / Edge，点击“连接采集卡”并授权目标 HID 接口。" : "通过 USB 连接采集卡，点击“刷新设备”。"} 列表中的读写状态来自实际协议探测。</li><li><strong>选择任务。</strong>备份无需输入文件；刷写可导入固件容器、完整备份或加载当前浏览器已存备份。</li><li><strong>开始并保存备份。</strong>点击任务主按钮。出现保存提示后先下载备份，再明确确认已保存，后续操作才继续。</li><li><strong>查看结果。</strong>等待写入及回读校验完成，按需导出恢复包和诊断日志。需要重新枚举时，按“重连与恢复说明”操作。</li></ol></div><div><h3>文件与操作规则</h3><ul><li>升级容器为 98356 字节。整片 Flash 备份会提取开头的启动镜像，保留设备当前尾部。</li><li>本工具不附带固件，也不向服务器传输固件。导入的文件在浏览器本地处理，仍需与实际板卡相符。</li><li>本机已存备份来自当前浏览器的本地存储；更换浏览器或清除站点数据后，需重新导入自己保存的文件。任何文件都不会自动刷写。</li><li>运行中会锁定设备、任务与文件选择。擦写开始后不可取消，页面关闭或刷新不会自动续写。</li><li>恢复能力取决于设备接口仍可通信，不承诺所有固件或无 USB 枚举设备均可恢复。</li></ul></div></div></details>
      <footer><span className="footer-dot"/>MS2133 WebHID Flasher<span className="footer-separator">·</span>固件文件仅在本地处理</footer>
    </main>
  </div>;
}
createRoot(document.getElementById("root")!).render(<App/>);
