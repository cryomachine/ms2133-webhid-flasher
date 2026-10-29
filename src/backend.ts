import type { DeviceInfo, FirmwareInfo, LogEntry, OperationState, ScanResult } from "./types";
import { getRecovery, loadOperation, putRecovery, recoverySummary, saveOperation } from "./storage";
import type { RecoveryRecord } from "./storage";
import { CONTAINER_SIZE, firmwareContainerErrors } from "./firmware-format";

export interface HidReportItem { reportSize: number; reportCount: number; }
export interface HidReport { reportId: number; items: HidReportItem[]; }
export interface HidCollection {
  usagePage: number;
  usage: number;
  featureReports: HidReport[];
  children: HidCollection[];
}
export interface BrowserHidDevice {
  vendorId: number;
  productId: number;
  productName: string;
  opened: boolean;
  collections: HidCollection[];
  open(): Promise<void>;
  close(): Promise<void>;
  sendFeatureReport(reportId: number, data: BufferSource): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
}
interface BrowserHid {
  getDevices(): Promise<BrowserHidDevice[]>;
  requestDevice(options: { filters: { vendorId: number; productId?: number }[] }): Promise<BrowserHidDevice[]>;
}
export interface ProgressUpdate { phase: string; progress: number; message: string; cancellable: boolean; destructiveStarted?: boolean; readBytes?: number; readTotalBytes?: number; readBytesPerSecond?: number; }
export interface ProtocolContext {
  intent?: "backup" | "flash" | "restore";
  operationMode?: "flash" | "restore-builtin" | "restore-file";
  directImageWrite?: boolean;
  referenceImage?: Uint8Array;
  update(value: ProgressUpdate): void;
  log(message: string, level?: LogEntry["level"]): void;
  isCancelled(): boolean;
  saveBackup(data: Uint8Array, name: string): Promise<void>;
}
export interface WebHidDriver {
  probe(device: BrowserHidDevice): Promise<Partial<DeviceInfo>>;
  backup(device: BrowserHidDevice, context: ProtocolContext): Promise<Uint8Array>;
  flash(device: BrowserHidDevice, image: Uint8Array, context: ProtocolContext): Promise<{ verified: boolean; backup?: Uint8Array }>;
}
let driver: WebHidDriver | null = null;
export function registerWebHidDriver(value: WebHidDriver) { driver = value; }
export const webMode = true;
let sequence = 0;
const deviceIds = new WeakMap<BrowserHidDevice, string>();
const devices = new Map<string, BrowserHidDevice>();
const files = new Map<string, Uint8Array>();
let current: OperationState | null = loadOperation();
let recovery: RecoveryRecord | null = null;
let fileSequence = 0;
const sourceSizes = new Map<string, number>();
let cancelled = false;
let pendingBackup: { data: Uint8Array; name: string; resolve(): void; reject(error: Error): void } | null = null;
let lastScan: ScanResult = { devices: [] };
const idle: OperationState = { kind: "idle", status: "idle", phase: "", progress: 0, message: "等待操作", cancellable: false, logs: [] };
const MS2133_VENDOR_ID = 0x345f;
const MS2133_PRODUCT_ID = 0x2133;
const ROM_PRODUCT_ID = 0x0001;
function firmwareUrl(file: string): string {
  // Resolve against the deployed page so GitHub Pages project paths and the
  // local Vite server both find the bundled firmware assets.
  if (typeof URL !== "function") return `/firmware/${file}`;
  const base = typeof document === "undefined" || !document.baseURI ? "http://localhost/" : document.baseURI;
  return new URL(`firmware/${file}`, base).toString();
}

function browserHid(): BrowserHid {
  if (!window.isSecureContext) throw new Error("WebHID需要安全上下文。请使用HTTPS或localhost打开网页。");
  const hid = (navigator as Navigator & { hid?: BrowserHid }).hid;
  if (!hid) throw new Error("当前浏览器未提供WebHID。请使用桌面版Chrome或Edge。");
  return hid;
}
function idFor(device: BrowserHidDevice): string {
  let id = deviceIds.get(device);
  if (!id) { id = `webhid-${++sequence}`; deviceIds.set(device, id); }
  devices.set(id, device);
  return id;
}
function reportLength(collections: HidCollection[]): number | null {
  let maximum = 0;
  for (const collection of collections) {
    for (const report of collection.featureReports ?? []) {
      const bits = report.items.reduce((total, item) => total + item.reportSize * item.reportCount, 0);
      maximum = Math.max(maximum, Math.ceil(bits / 8) + 1);
    }
    maximum = Math.max(maximum, reportLength(collection.children ?? []) ?? 0);
  }
  return maximum || null;
}
export async function requestWebDevice(): Promise<void> {
  // Windows can expose the same HID interface with a firmware-dependent PID
  // (and some composite-device bridges report PID 0000). Filter only by the
  // assigned vendor so the chooser can show those interfaces. The protocol
  // probe below still gates all reads and writes by the descriptor and reply.
  await browserHid().requestDevice({ filters: [{ vendorId: MS2133_VENDOR_ID }] });
}
async function scan(): Promise<ScanResult> {
  if (current?.status === "running") throw new Error("操作进行中，请等待当前阶段完成后再扫描设备。");
  const authorized = (await browserHid().getDevices()).filter(d => d.vendorId === MS2133_VENDOR_ID);
  const found: DeviceInfo[] = [];
  for (const device of authorized) {
    const id = idFor(device);
    const collection = device.collections.find(c => c.usagePage >= 0xff00) ?? device.collections[0];
    let item: DeviceInfo = {
      id, path: `WebHID授权接口 ${id}`, vendorId: device.vendorId, productId: device.productId,
      product: device.productName || (device.productId === ROM_PRODUCT_ID ? "MS213xS ROM恢复接口" : device.productId === MS2133_PRODUCT_ID ? "MS2133" : `MS2133 HID接口 (PID ${device.productId.toString(16).padStart(4, "0").toUpperCase()})`), usagePage: collection?.usagePage, usage: collection?.usage,
      featureReportLength: reportLength(device.collections), status: "enumerated", firmwareType: "unknown",
      canReadFlash: false, canWriteFlash: false,
      detail: driver ? "尚未完成通信探测" : "已取得浏览器授权；协议模块尚未加载，写入未开放。",
    };
    if (driver) {
      try { item = { ...item, ...await driver.probe(device), id, path: item.path }; }
      catch (e) { item.status = "error"; item.detail = String(e); }
    }
    found.push(item);
  }
  lastScan = { devices: found, diagnostics: found.length ? [] : ["暂未发现已授权的345F厂商HID接口；Windows可能为同一设备暴露不同PID，网页会继续通过报告描述符和只读协议探测确认。首次使用请点击“连接采集卡”授权设备。ROM入口须实际枚举，网页不会强制使设备进入ROM。"] };
  return lastScan;
}
function chooseFile(restore = false): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.style.position = "fixed"; input.style.left = "-10000px";
    input.tabIndex = -1;
    let settled = false;
    let reading = false;
    let focusTimer: number | undefined;
    const cleanup = () => {
      window.removeEventListener("focus", onFocus);
      if (focusTimer !== undefined) window.clearTimeout(focusTimer);
      input.remove();
    };
    const finish = (path: string | null, error?: unknown) => {
      if (settled) return;
      settled = true; cleanup();
      if (error !== undefined) reject(error); else resolve(path);
    };
    const readSelection = async () => {
      if (settled || reading) return;
      reading = true;
      try {
        const file = input.files?.[0];
        if (!file) { finish(null); return; }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const path = `local-${++fileSequence}/${file.name}`;
        sourceSizes.set(path, bytes.length);
        files.set(path, restore && bytes.length > 0x18034 ? bytes.slice(0, 0x18034) : bytes);
        finish(path);
      } catch (e) { finish(null, e); }
    };
    const onFocus = () => {
      if (focusTimer !== undefined) window.clearTimeout(focusTimer);
      focusTimer = window.setTimeout(() => {
        if (settled || reading) return;
        if (input.files?.length) void readSelection(); else finish(null);
      }, 750);
    };
    input.onchange = () => { void readSelection(); };
    input.addEventListener("cancel", () => { if (!reading) finish(null); }, { once: true });
    window.addEventListener("focus", onFocus);
    document.body.appendChild(input);
    try { input.click(); } catch (e) { finish(null, e); }
  });
}
async function inspect(path: string): Promise<FirmwareInfo> {
  const data = files.get(path);
  if (!data) throw new Error("网页未保存这个文件，请重新选择。");
  const errors: string[] = [];
  const format = data.length === CONTAINER_SIZE ? "MS2133固件容器" : "未支持的文件结构";
  if (data.length !== CONTAINER_SIZE) errors.push("当前写入入口只接受98,356字节的MS2133容器。");
  let headerChecksumValid = false, payloadChecksumValid = false;
  if (data.length === CONTAINER_SIZE) {
    let h = 0, c = 0;
    for (let i = 2; i < 12; i++) h += data[i];
    for (let i = 16; i < 48; i++) h += data[i];
    for (let i = 0x30; i < data.length - 4; i++) c += data[i];
    headerChecksumValid = (h & 0xffff) === (data[data.length - 4] << 8 | data[data.length - 3]);
    payloadChecksumValid = (c & 0xffff) === (data[data.length - 2] << 8 | data[data.length - 1]);
    if (!headerChecksumValid) errors.push("头部校验和不匹配。");
    if (!payloadChecksumValid) errors.push("固件载荷校验和不匹配。");
    for (const error of firmwareContainerErrors(data)) {
      if (!errors.includes(error) && !error.includes("校验和")) errors.push(error);
    }
  }
  const digest = await crypto.subtle.digest("SHA-256", data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  const sha256 = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  return { path, size: data.length, sha256, valid: errors.length === 0, errors, format, target: "MS2133 · 用户导入文件", headerChecksumValid, payloadChecksumValid, sourceSize: sourceSizes.get(path), bootImageExtracted: (sourceSizes.get(path) ?? data.length) > data.length };
}
async function loadSavedBackup(): Promise<FirmwareInfo> {
  const stored = await getRecovery();
  const backup = stored?.backup;
  if (!backup?.length) throw new Error("本机尚未保存完整 Flash 备份。请先备份设备或导入自己的备份文件。");
  if (backup.length < 0x18034) throw new Error("本机备份小于启动容器长度，恢复未准备。");
  const name = stored?.backupName?.split(/[\\/]/).pop() || "MS2133-backup.bin";
  const path = `saved-${++fileSequence}/${name}`;
  sourceSizes.set(path, backup.length);
  files.set(path, backup.slice(0, 0x18034));
  const info = await inspect(path);
  if (!info.valid) {
    files.delete(path); sourceSizes.delete(path);
    throw new Error(`本机备份的启动容器未通过校验：${info.errors.join("；")}`);
  }
  return { ...info, target: "MS2133 · 本机已存备份" };
}
async function loadFactoryFirmware(): Promise<FirmwareInfo> {
  const response = await fetch(firmwareUrl("factory.bin"), { cache: "no-store" });
  if (!response.ok) throw new Error("网页内尚未挂载原厂固件：请将原厂 BIN 放入 public/firmware/factory.bin 后重新加载页面。");
  const source = new Uint8Array(await response.arrayBuffer());
  const path = `factory-${++fileSequence}/factory.bin`;
  sourceSizes.set(path, source.length);
  files.set(path, source.length > 0x18034 ? source.slice(0, 0x18034) : source);
  try {
    const info = await inspect(path);
    if (!info.valid) throw new Error(info.errors.join("；"));
    return { ...info, target: "MS2133 · 内置原厂固件" };
  } catch (error) {
    files.delete(path); sourceSizes.delete(path);
    throw new Error(`内置原厂 BIN 校验失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
async function loadLatestFirmware(): Promise<FirmwareInfo> {
  const response = await fetch(firmwareUrl("ROI_V0.10_1029.bin"), { cache: "no-store" });
  if (!response.ok) throw new Error("网页内尚未挂载最新ROI固件，请重新加载页面或等待发布完成。");
  const source = new Uint8Array(await response.arrayBuffer());
  const path = `latest-${++fileSequence}/ROI_V0.10_1029.bin`;
  sourceSizes.set(path, source.length); files.set(path, source);
  try {
    const info = await inspect(path);
    if (!info.valid) throw new Error(info.errors.join("；"));
    return { ...info, target: "MS2133 · 最新ROI固件" };
  } catch (error) {
    files.delete(path); sourceSizes.delete(path);
    throw new Error(`最新ROI固件校验失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
async function loadFactoryReference(): Promise<Uint8Array | undefined> {
  if (typeof fetch !== "function") return undefined;
  const response = await fetch(firmwareUrl("factory.bin"), { cache: "no-store" });
  if (!response.ok) return undefined;
  const source = new Uint8Array(await response.arrayBuffer());
  // Keep the complete factory image as the direct-write baseline.  The
  // 98,356-byte container ends inside the 0x18000 sector, so a short slice
  // would make the sector tail become FF after erase.
  if (source.length < 0x19000) return undefined;
  const image = source.length > 0x18034 ? source.slice(0, 0x18034) : source;
  const path = `factory-reference-${++fileSequence}/factory.bin`;
  sourceSizes.set(path, source.length); files.set(path, image);
  try {
    const info = await inspect(path);
    return info.valid ? source : undefined;
  } finally {
    files.delete(path); sourceSizes.delete(path);
  }
}
function download(data: Uint8Array, name: string): void {
  const copy = new Uint8Array(data.byteLength); copy.set(data);
  const url = URL.createObjectURL(new Blob([copy.buffer], { type: "application/octet-stream" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function context(referenceImage?: Uint8Array): ProtocolContext {
  return {
    intent: current?.kind === "restore" ? "restore" : current?.kind === "flash" ? "flash" : "backup",
    operationMode: current?.kind === "restore" ? "restore-file" : "flash",
    directImageWrite: current?.directImageWrite === true,
    referenceImage,
    update: value => {
      if (current) {
        const destructiveStarted = Boolean(current.destructiveStarted || value.destructiveStarted || value.phase === "擦除Flash");
        current = { ...current, ...value, destructiveStarted, cancellable: value.cancellable && !destructiveStarted };
        saveOperation(current);
      }
    },
    log: (message, level = "info") => { if (current) { current = { ...current, logs: [...current.logs.slice(-999), { timestamp: new Date().toISOString(), level, message }] }; saveOperation(current); } },
    isCancelled: () => cancelled,
    saveBackup: async (data, name) => {
      if (!data.length || cancelled) throw new Error(cancelled ? "已取消，后续写入未执行。" : "备份为空，后续写入未执行。");
      if (pendingBackup) throw new Error("已有待保存备份。");
      if (!recovery) throw new Error("恢复包尚未初始化，写入未执行。");
      recovery = { ...recovery, backup: new Uint8Array(data), backupName: name };
      await putRecovery(recovery);
      return new Promise<void>((resolve, reject) => {
        pendingBackup = { data: new Uint8Array(data), name, resolve, reject };
        if (current) { current = { ...current, phase: "等待保存备份", message: "恢复包已保存在本机浏览器。先另存当前设备备份，再继续后续操作。", backupPath: name, backupSaveRequired: true, backupDownloaded: false, cancellable: !current.destructiveStarted }; saveOperation(current); }
      });
    },
  };
}
async function savePendingBackup(): Promise<void> {
  const pending = pendingBackup;
  if (!pending || !current?.backupSaveRequired) throw new Error("没有待保存的备份。");
  const picker = (window as Window & { showSaveFilePicker?: (options: unknown) => Promise<{ createWritable(): Promise<{ write(data: BufferSource): Promise<void>; close(): Promise<void> }> }> }).showSaveFilePicker;
  if (picker) {
    const handle = await picker({ suggestedName: pending.name, types: [{ description: "固件备份", accept: { "application/octet-stream": [".bin"] } }] });
    const writable = await handle.createWritable();
    await writable.write(pending.data as Uint8Array<ArrayBuffer>);
    await writable.close();
    completeBackupSave();
  } else {
    download(pending.data, pending.name);
    current = { ...current, backupDownloaded: true, message: "浏览器已开始下载。保存完成后，点击“已保存备份，继续”。" };
    saveOperation(current);
  }
}
function completeBackupSave(): void {
  const pending = pendingBackup;
  if (!pending) throw new Error("没有待确认的备份。");
  pendingBackup = null;
  if (current) current = { ...current, backupSaveRequired: false, backupDownloaded: false, message: "备份已保存，继续执行协议流程。" };
  if (current) saveOperation(current);
  pending.resolve();
}
async function start(kind: "backup" | "flash" | "restore", deviceId: string, path?: string, directUpdate = false): Promise<OperationState> {
  if (current?.status === "running") throw new Error("已有操作进行中。");
  if (!driver) throw new Error("真实刷写协议尚未加载，操作未执行。");
  const device = devices.get(deviceId);
  if (!device) throw new Error("设备授权已失效，请重新连接并选择设备。");
  const scanned = lastScan.devices.find(d => d.id === deviceId);
  if (kind === "backup" ? !scanned?.canReadFlash : !scanned?.canWriteFlash) throw new Error("设备未通过对应能力探测。");
  let image: Uint8Array | undefined;
  let firmware: FirmwareInfo | undefined;
  if (kind !== "backup") {
    if (!path) throw new Error("请先选择文件。");
    firmware = await inspect(path);
    if (!firmware.valid) throw new Error("所选固件未通过文件校验。");
    image = files.get(path);
    if (!image) throw new Error("固件文件已失效。");
  }
  cancelled = false;
  const id = `web-${Date.now()}`;
  recovery = { id, createdAt: new Date().toISOString(), device: scanned!, firmware, image: image ? new Uint8Array(image) : undefined };
  await putRecovery(recovery);
  // A plain container can use the read-free factory-baseline path on stock
  // firmware. A normalized full backup still needs the normal read/backup
  // path so its saved tail remains the target instead of being replaced by
  // the bundled factory tail.
  const directImageWrite = directUpdate || kind === "restore" ||
    (kind === "flash" && scanned?.firmwareType === "stock" && (firmware?.sourceSize ?? firmware?.size) === 0x18034);
  const referenceImage = directImageWrite ? await loadFactoryReference() : undefined;
  const next: OperationState = { ...idle, id, kind, status: "running", phase: "准备", message: "准备与设备通信", cancellable: true, logs: [], destructiveStarted: false, firmwareSha256: firmware?.sha256, target: scanned?.product ?? "MS2133", directImageWrite };
  saveOperation(next);
  current = next;
  const ctx = context(referenceImage);
  const activeDriver = driver;
  const snapshot = { ...current, logs: [...current.logs] };
  void (async () => {
    try {
      if (kind === "backup") {
        const data = await activeDriver.backup(device, ctx);
        if (!data.length) throw new Error("备份返回空数据。");
        const name = `MS2133-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.bin`;
        recovery = { ...recovery!, backup: data, backupName: name };
        await putRecovery(recovery);
        download(data, name);
        if (current) current.backupPath = name;
      } else {
        const result = await activeDriver.flash(device, image!, ctx);
        if (!result.verified) throw new Error("回读校验未通过，写入不标记为成功。");
        if (result.backup?.length && !current?.backupPath) {
          const name = `MS2133-preflash-${new Date().toISOString().replace(/[:.]/g, "-")}.bin`;
          download(result.backup, name);
          if (current) current.backupPath = name;
        }
      }
      if (current) current = { ...current, status: "complete", phase: "完成", progress: 100, message: kind === "backup" ? "备份已交给浏览器下载" : "写入与回读校验完成", cancellable: false };
      if (current) saveOperation(current);
    } catch (e) {
      if (current) {
        const message = e instanceof Error ? e.message : String(e);
        current = { ...current, status: cancelled ? "cancelled" : "failed", phase: cancelled ? "已取消" : "失败", message, error: message, cancellable: false };
        ctx.log(message, "error");
      }
    }
  })();
  return snapshot;
}
async function webCall(command: string, args: Record<string, unknown>): Promise<unknown> {
  switch (command) {
    case "scan_devices": return scan();
    case "choose_firmware": return chooseFile();
    case "choose_restore": return chooseFile(true);
    case "load_saved_backup": return loadSavedBackup();
    case "load_factory_firmware": return loadFactoryFirmware();
    case "load_latest_firmware": return loadLatestFirmware();
    case "inspect_firmware": return inspect(String(args.path));
    case "start_backup": return start("backup", String(args.deviceId));
    // Unified firmware task: both a normalized upgrade container and a
    // complete backup (already reduced by choose_restore/load_saved_backup)
    // use the same verified Flash transaction. Keep the legacy commands below
    // for saved operation records and older clients.
    case "start_firmware": return start("flash", String(args.deviceId), String(args.firmwarePath), args.latest === true);
    case "start_flash": return start("flash", String(args.deviceId), String(args.firmwarePath), args.latest === true);
    case "start_restore": return start("restore", String(args.deviceId), String(args.firmwarePath));
    case "get_recovery_summary": return recoverySummary();
    case "export_recovery_package": {
      const stored = await getRecovery();
      if (!stored) throw new Error("本机没有持久保存的恢复包。");
      const encode = (bytes?: Uint8Array) => {
        if (!bytes) return null;
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x4000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x4000));
        return btoa(binary);
      };
      const name = `MS2133-recovery-${stored.id}.json`;
      const report = { format: "ms2133-recovery-v1", createdAt: stored.createdAt, device: stored.device, firmware: stored.firmware, imageBase64: encode(stored.image), backupName: stored.backupName, backupBase64: encode(stored.backup), operation: current?.id === stored.id ? current : null, note: "Flash整片备份不应直接当作98356字节升级容器。恢复时仅提取并校验bootimage，保留当前Flash尾部。" };
      download(new TextEncoder().encode(JSON.stringify(report, null, 2)), name); return name;
    }
    case "get_operation": return current ? { ...current, logs: [...current.logs] } : null;
    case "save_pending_backup": return savePendingBackup();
    case "confirm_backup_saved":
      if (!current?.backupDownloaded) throw new Error("请先下载备份文件。");
      completeBackupSave(); return null;
    case "cancel_operation":
      if (!current?.cancellable || current.status !== "running") throw new Error("当前阶段不允许取消。");
      cancelled = true;
      if (pendingBackup) {
        const pending = pendingBackup; pendingBackup = null;
        if (current) current = { ...current, backupSaveRequired: false, backupDownloaded: false };
        pending.reject(new Error("已取消，后续写入未执行。"));
      }
      if (current) saveOperation(current);
      return null;
    case "export_diagnostics": {
      const report = { timestamp: new Date().toISOString(), browser: navigator.userAgent, scan: lastScan, operation: current };
      const name = `MS2133-diagnostics-${Date.now()}.json`;
      download(new TextEncoder().encode(JSON.stringify(report, null, 2)), name); return name;
    }
    default: throw new Error(`未知操作：${command}`);
  }
}
export function callBackend<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return webCall(command, args) as Promise<T>;
}
