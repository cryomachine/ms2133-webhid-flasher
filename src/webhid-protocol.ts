import { registerWebHidDriver } from "./backend";
import type { BrowserHidDevice, HidCollection, ProtocolContext, WebHidDriver } from "./backend";
import type { DeviceInfo } from "./types";

// Recovered from BFC9000 e980/e4a0, c1c0, dd50, d9a0 and e130.
// WebHID sends report ID separately; receiveFeatureReport may retain it.
const REPORT_ID = 1;
const MS2133_VENDOR_ID = 0x345f;
const ROM_PRODUCT_ID = 0x0001;
const IO_TIMEOUT_MS = 3000;
type ReportMode = "extended" | "short";
interface LinkState { blocked: boolean; }
interface ProbeState { mode: ReportMode | "legacy" | null; readCapable: boolean; }
interface MaintenanceState { result: number; active: boolean; }
const links = new WeakMap<BrowserHidDevice, LinkState>();
const probes = new WeakMap<BrowserHidDevice, ProbeState>();
// The Windows-flattened stock descriptor requires every short command to be
// sent in a 4095-byte data report. Cache the descriptor sizes and backing
// buffer so a long 4-byte-at-a-time flash does not repeatedly traverse the
// descriptor tree or allocate a multi-kilobyte Uint8Array for every command.
const featureSizeCache = new WeakMap<BrowserHidDevice, Map<number, number>>();
const flatReportBuffers = new WeakMap<BrowserHidDevice, Uint8Array>();
// Established only from unambiguous B5/C5 opcode+address echoes. Raw Flash
// bytes may begin with01 and must never be used to guess the report envelope.
const legacyEnvelopes = new WeakMap<BrowserHidDevice, { includesReportId: boolean }>();
const locks = new WeakMap<BrowserHidDevice, Promise<void>>();

class PendingHidOperationError extends Error {}
class MaintenanceExitError extends Error {}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function linkFor(device: BrowserHidDevice): LinkState {
  let state = links.get(device);
  if (!state) { state = { blocked: false }; links.set(device, state); }
  return state;
}
async function exclusive<T>(device: BrowserHidDevice, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(device) ?? Promise.resolve();
  let release!: () => void;
  const active = new Promise<void>(resolve => { release = resolve; });
  locks.set(device, active);
  await previous;
  try { return await action(); }
  finally { release(); if (locks.get(device) === active) locks.delete(device); }
}
async function io<T>(device: BrowserHidDevice, action: () => Promise<T>): Promise<T> {
  const state = linkFor(device);
  if (state.blocked) throw new PendingHidOperationError("此前USB请求未完成，已停止自动重试。请重新连接采集卡并刷新页面。");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          state.blocked = true;
          reject(new PendingHidOperationError("USB请求超过3秒仍未完成；后续报文已停止。请重新连接采集卡并刷新页面，按界面记录确认是否需要恢复固件。"));
        }, IO_TIMEOUT_MS);
      }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
function header(opcode: number, ...parameters: number[]): Uint8Array {
  const data = new Uint8Array(8);
  data.set([opcode, ...parameters]);
  return data;
}
function payload(command: Uint8Array, mode: ReportMode, page?: Uint8Array): Uint8Array {
  const data = new Uint8Array(mode === "extended" ? 264 : 8);
  data.set(command);
  if (page) {
    if (mode !== "extended" || page.length !== 256) throw new Error("页写入必须为长报文256字节");
    data.set(page, 8);
  }
  return data;
}
async function send(device: BrowserHidDevice, mode: ReportMode, command: Uint8Array, page?: Uint8Array): Promise<void> {
  let data = payload(command, mode, page);
  let sizes = featureSizeCache.get(device);
  if (!sizes) {
    sizes = featureSizes(device.collections);
    featureSizeCache.set(device, sizes);
  }
  if (windowsFlatStockShape(device, sizes)) {
    const declared = sizes.get(REPORT_ID)!;
    if (data.length < declared) {
      let padded = flatReportBuffers.get(device);
      if (!padded || padded.length !== declared) {
        padded = new Uint8Array(declared);
        flatReportBuffers.set(device, padded);
      }
      padded.fill(0);
      padded.set(data);
      data = padded;
    }
  }
  await io(device, () => device.sendFeatureReport(REPORT_ID, data.buffer as ArrayBuffer));
}
export function normalizeFeatureReply(view: DataView, opcode: number, minimum = 8): Uint8Array {
  const raw = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const offset = raw[0] === opcode ? 0 : raw[0] === REPORT_ID && raw[1] === opcode ? 1 : -1;
  if (offset < 0) throw new Error(`HID响应不匹配：预期${opcode.toString(16).padStart(2, "0").toUpperCase()}，收到${Array.from(raw.slice(0, 8), b => b.toString(16).padStart(2, "0")).join(" ")}`);
  if (raw.length - offset < minimum) throw new Error(`HID响应不足${minimum}字节`);
  return raw.subarray(offset);
}
async function query(device: BrowserHidDevice, mode: ReportMode, command: Uint8Array, minimum = 8): Promise<Uint8Array> {
  await send(device, mode, command);
  const response = await io(device, () => device.receiveFeatureReport(REPORT_ID));
  return normalizeFeatureReply(response, command[0], minimum);
}
function checkCapabilities(data: Uint8Array): void {
  if (data[1] !== 1 || data[2] !== 2 || data[4] !== 1)
    throw new Error("设备未返回BFC ROI更新能力标识52 01 02 xx 01");
}
function maintenanceState(data: Uint8Array): MaintenanceState {
  checkCapabilities(data);
  return { result: data[3], active: data[5] === 1 };
}
function featureSizes(collections: HidCollection[], sizes = new Map<number, number>()): Map<number, number> {
  for (const collection of collections) {
    for (const report of collection.featureReports ?? []) {
      const bits = report.items.reduce((total, item) => total + item.reportSize * item.reportCount, 0);
      sizes.set(report.reportId, Math.max(sizes.get(report.reportId) ?? 0, Math.ceil(bits / 8)));
    }
    featureSizes(collection.children ?? [], sizes);
  }
  return sizes;
}
function stockShape(sizes: Map<number, number>): boolean {
  if (sizes.get(1) !== 8) return false;
  // Chrome on Windows can expose the Feature report byte lengths with the
  // report-ID byte included for the large reports. Both layouts are the same
  // original SPI interface; B5/C5 probing below remains the final gate.
  return [63, 64].includes(sizes.get(2) ?? -1) && [4095, 4096].includes(sizes.get(3) ?? -1);
}
function windowsFlatStockShape(device: BrowserHidDevice, sizes: Map<number, number>): boolean {
  // Win32 HID can flatten the three original Feature reports into one
  // report-ID-1 entry. The descriptor then advertises the largest 4095-byte
  // data area, while the firmware still accepts the original 8-byte B5/C5/F7
  // command protocol. USB3 Video is the device product string observed for
  // this Windows path; the B5/C5 echo probe below remains the final gate.
  return /^USB3 Video/i.test(device.productName || "") &&
    sizes.get(1) === 4095;
}
function legacyShape(device: BrowserHidDevice, sizes = featureSizes(device.collections)): "canonical" | "windows-flat" | null {
  if (stockShape(sizes)) return "canonical";
  if (windowsFlatStockShape(device, sizes)) return "windows-flat";
  return null;
}
async function opened<T>(device: BrowserHidDevice, action: () => Promise<T>): Promise<T> {
  const wasOpened = device.opened;
  if (!wasOpened) await io(device, () => device.open());
  try { return await action(); }
  finally {
    // Do not overlap a still-pending OS request with another operation.
    if (!wasOpened && device.opened && !linkFor(device).blocked) {
      await io(device, () => device.close());
    }
  }
}
function cancelled(context: ProtocolContext): void {
  if (context.isCancelled()) throw new Error("已取消读取；未执行固件擦写。");
}
function update(context: ProtocolContext, phase: string, progress: number, message: string): void {
  context.update({ phase, progress, message, cancellable: true });
}
function delay(milliseconds: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

async function probeDevice(device: BrowserHidDevice): Promise<Partial<DeviceInfo>> {
  probes.set(device, { mode: null, readCapable: false });
  legacyEnvelopes.delete(device);
  const base: Partial<DeviceInfo> = { canReadFlash: false, canWriteFlash: false, firmwareType: "unknown" };
  if (device.vendorId !== MS2133_VENDOR_ID)
    return { ...base, status: "error", detail: "所选接口的厂商ID不是MS2133，未发送设备命令。" };
  const sizes = featureSizes(device.collections);
  const size = sizes.get(REPORT_ID) ?? 0;
  if (device.productId === ROM_PRODUCT_ID) return { ...base, firmwareType: "rom", featureReportLength: size + 1, status: "enumerated", detail: "已枚举MS213xS-ROM恢复接口；该ROM的扇区保留写入事务尚未确认，未发送猜测命令，当前不可擦写。" };
  if (size < 8) return { ...base, status: "error", detail: "接口未声明报告ID 1的8字节命令区，未发送设备命令。" };
  const legacy = legacyShape(device, sizes);
  if (legacy) {
    try {
      const result = await opened(device, async () => {
        await legacyReadXdata(device, 0xf01f);
        await legacyReadSfr(device, 0xa0);
        return {
          ...base,
          firmwareType: "stock" as const,
          featureReportLength: (sizes.get(REPORT_ID) ?? 8) + 1,
          status: "reachable" as const,
          canReadFlash: true,
          canWriteFlash: true,
          detail: legacy === "windows-flat"
            ? "已确认Windows扁平化原厂HID接口（ID1最大4095字节）及B5/C5读取；命令已按Windows报告长度补齐，读写使用原厂SPI事务，写入前仍需完整备份与容器验证。"
            : "已确认原厂三报告接口（ID1=8、ID2=63、ID3=4095字节）及B5/C5读取；读写使用原厂SPI事务，写入前仍需完整备份与容器验证。",
        };
      });
      probes.set(device, {mode: "legacy", readCapable: true});
      return result;
    } catch (error) {
      probes.set(device, {mode: null, readCapable: false});
      return { ...base, firmwareType: "stock", featureReportLength: (sizes.get(REPORT_ID) ?? 8) + 1, status: "error", detail: `原厂HID接口通信失败，未执行擦写。${errorText(error)}` };
    }
  }
  // BFC selects this ROI extension only for native length 265 (264 data bytes).
  // Stock firmware advertises a different report size and must receive no ROI probes.
  if (size !== 264) return { ...base, featureReportLength: size + 1, status: "enumerated", detail: `报告ID 1数据区为${size}字节；当前不是已确认的264字节ROI接口，未发送设备命令，备份和擦写均未开放。` };
  const modes: ReportMode[] = ["extended", "short"];
  const failures: string[] = [];
  try {
    return await opened(device, async () => {
      for (const mode of modes) {
        try {
          // 52/00 only reports state. 52/06 acquires maintenance and must
          // never be used as a passive probe or an exit-status query.
          const state = maintenanceState(await query(device, mode, header(0x52)));
          const readCapable = mode === "extended";
          probes.set(device, { mode, readCapable });
          const detail = readCapable
            ? `长报文能力与被动状态查询通过；${state.active ? "当前维护会话已开启，备份前将先清理并重新进入" : "备份时将暂停视频并进入维护会话"}。写入前仍将验证容器、完整备份并等待备份保存确认。`
            : "短报文可通信；长报文Flash读取能力未确认，备份和擦写均未开放。";
          return { ...base, firmwareType: "roi", featureReportLength: size ? size + 1 : null, status: state.active ? "update" : "reachable", detail, canReadFlash: readCapable, canWriteFlash: readCapable };
        } catch (error) {
          failures.push(`${mode === "extended" ? "长" : "短"}报文：${errorText(error)}`);
          if (error instanceof PendingHidOperationError) throw error;
        }
      }
      throw new Error(failures.join("；"));
    });
  } catch (error) {
    probes.set(device, { mode: null, readCapable: false });
    return { ...base, firmwareType: size === 264 ? "roi" : "unknown", status: "error", featureReportLength: size ? size + 1 : null, detail: `设备已枚举，HID通信未通过；未执行擦写。${errorText(error)}` };
  }
}
async function exitMaintenance(device: BrowserHidDevice): Promise<void> {
  try {
    await send(device, "extended", header(0x52, 7));
    const state = maintenanceState(await query(device, "extended", header(0x52)));
    if (state.active) throw new Error("退出后维护标志仍为1，已停止后续操作；请重新连接设备。");
  } catch (error) {
    if (error instanceof PendingHidOperationError) throw error;
    throw new MaintenanceExitError(errorText(error));
  }
}
async function readyForRead(device: BrowserHidDevice, context: ProtocolContext): Promise<void> {
  const before = maintenanceState(await query(device, "extended", header(0x52)));
  if (before.active) {
    // E35B skips the pause request while 0B4A is already set. Clear a
    // previous session before issuing the one pause request for this session.
    context.log("先清理设备已有维护会话，再暂停视频并重新进入。");
    await exitMaintenance(device);
  }
  cancelled(context);
  context.log("发送52 05暂停视频以读取备份。");
  await send(device, "extended", header(0x52, 5));
  const deadline = Date.now() + 1000;
  let ready = false;
  do {
    cancelled(context);
    await delay(20);
    const state = maintenanceState(await query(device, "extended", header(0x52, 6)));
    if (state.result === 0 && state.active) { ready = true; break; }
    if (state.active) throw new Error("设备返回既有维护会话，未确认本次暂停和就绪；未执行擦写。");
  } while (Date.now() < deadline);
  if (!ready) throw new Error("设备尚未停止视频并进入Flash读取就绪状态，未执行擦写。");
  const probe = await query(device, "extended", header(0xfd));
  if (probe[1] !== 0xfd || probe[2] !== 0) throw new Error("工厂更新接口未返回FD FD 00，读取已停止。");
}
async function flashCapacity(device: BrowserHidDevice): Promise<number> {
  const data = await query(device, "extended", header(0xf4));
  if (data[1] !== 0x5e || data[2] !== 0x60 || ![0x12, 0x13].includes(data[3]))
    throw new Error(`未确认此Flash容量：JEDEC ${Array.from(data.slice(1, 4), b => b.toString(16).padStart(2, "0")).join(" ")}。未执行擦写。`);
  return 2 ** data[3];
}
async function readPage(device: BrowserHidDevice, address: number): Promise<Uint8Array> {
  const data = await query(device, "extended", header(0xf7, address >>> 16, (address >>> 8) & 255, address & 255), 264);
  if (data.subarray(1, 8).some(byte => byte !== 0)) throw new Error(`Flash读取状态非零，地址0x${address.toString(16)}`);
  return data.slice(8, 264);
}
const CONTAINER_SIZE = 0x18034;
const WRITE_END = 0x19000;
// The public distribution ships no firmware or device-specific fingerprints.
// Keep the built-in recovery gate closed even if a caller requests that mode.
const KNOWN_512K_TAIL: string | null = null;
const KNOWN_BOOT_IMAGES = new Set<string>();
export function validateFirmwareContainer(image: Uint8Array): void {
  if (image.length !== CONTAINER_SIZE) throw new Error("固件必须为0x18034字节的MS2133容器；整片备份需先提取容器。");
  const family = [0x3c,0xc3,0x80,0,0xff,0xff,0xff,0xff,0x80,0,0,2,0x1a,7,0x10,0x16];
  if (family.some((byte, index) => image[index] !== byte)) throw new Error("固件容器家族头不符合当前支持的MS2133格式，未执行擦写。");
  let headerSum = 0, codeSum = 0;
  for (let index = 2; index < 12; index++) headerSum += image[index];
  for (let index = 16; index < 48; index++) headerSum += image[index];
  for (let index = 0x30; index < 0x18030; index++) codeSum += image[index];
  if ((headerSum & 0xffff) !== (image[0x18030] << 8 | image[0x18031]) ||
      (codeSum & 0xffff) !== (image[0x18032] << 8 | image[0x18033]))
    throw new Error("固件容器校验和错误，未执行擦写。");
}
async function sha256(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
function sameBytes(first: Uint8Array, second: Uint8Array): boolean {
  return first.length === second.length && first.every((byte, index) => byte === second[index]);
}
function flashAddress(opcode: number, address: number): Uint8Array {
  return header(opcode, address >>> 16, address >>> 8 & 255, address & 255);
}
function acknowledge(data: Uint8Array, opcode: number): void {
  if (data[0] !== opcode || data.subarray(1, 8).some(byte => byte !== 0))
    throw new Error(`Flash命令${opcode.toString(16)}响应状态非零，已停止后续写入。`);
}
interface FlashSession {
  capacity: number;
  read(address: number): Promise<Uint8Array>;
  readSector?(address: number): Promise<Uint8Array>;
  erase(address: number): Promise<void>;
  program(address: number, data: Uint8Array): Promise<void>;
  finish(): Promise<void>;
}
function legacyRawDescription(view: DataView): string {
  const raw = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const prefix = Array.from(raw.subarray(0, 16), byte => byte.toString(16).padStart(2, "0")).join(" ");
  return `rawLength=${raw.length}，viewOffset=${view.byteOffset}，reportId=${REPORT_ID}，prefix16=${prefix}`;
}
function validLegacyResponseLength(device: BrowserHidDevice, length: number, includesReportId: boolean): boolean {
  if (length === (includesReportId ? 9 : 8) || length === (includesReportId ? 10 : 9)) return true;
  // macOS may return the interface's largest Feature report even for ID1.
  // This exception is limited to the independently verified stock descriptor.
  const sizes = featureSizes(device.collections);
  if (windowsFlatStockShape(device, sizes))
    return length === (includesReportId ? 4096 : 4095);
  if (!stockShape(sizes)) return false;
  const idInclusiveLarge = sizes.get(2) === 64 && sizes.get(3) === 4096;
  const windowsUsbVideo = /^USB3 Video/i.test(device.productName || "");
  return length === (includesReportId
    ? idInclusiveLarge || windowsUsbVideo ? 4097 : 4096
    : idInclusiveLarge ? 4096 : 4095);
}
async function legacyRegisterQuery(device: BrowserHidDevice, command: Uint8Array, echoBytes: number): Promise<Uint8Array> {
  await send(device, "short", command);
  const view = await io(device, () => device.receiveFeatureReport(REPORT_ID));
  const raw = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let includesReportId: boolean;
  if (raw[0] === command[0]) includesReportId = false;
  else if (raw[0] === REPORT_ID && raw[1] === command[0]) includesReportId = true;
  else throw new Error(`原厂B5/C5封装探测未匹配命令回显；${legacyRawDescription(view)}`);
  if (!validLegacyResponseLength(device, raw.length, includesReportId))
    throw new Error(`原厂B5/C5响应长度不符合已知描述符；${legacyRawDescription(view)}`);
  const data = raw.subarray(includesReportId ? 1 : 0);
  for (let index = 1; index <= echoBytes; index++) {
    if (data[index] !== command[index]) throw new Error(`原厂B5/C5地址回显不一致；${legacyRawDescription(view)}`);
  }
  const previous = legacyEnvelopes.get(device);
  if (previous && previous.includesReportId !== includesReportId)
    throw new Error(`原厂B5/C5报文封装前后不一致，已停止；${legacyRawDescription(view)}`);
  legacyEnvelopes.set(device, {includesReportId});
  return data.subarray(0, 8);
}
async function legacyReadXdata(device: BrowserHidDevice, address: number): Promise<number> {
  return (await legacyRegisterQuery(device, header(0xb5, address >>> 8, address & 255), 2))[3];
}
async function legacyReadSfr(device: BrowserHidDevice, address: number): Promise<number> {
  return (await legacyRegisterQuery(device, header(0xc5, address), 1))[2];
}
async function legacyReadPage(device: BrowserHidDevice, address: number, onFirstBlock: (description: string) => void): Promise<Uint8Array> {
  const envelope = legacyEnvelopes.get(device);
  if (!envelope) throw new Error("原厂B5/C5尚未确认响应封装，未发送Flash读取请求。");
  await send(device, "short", header(0xf7, 1, address >>> 16, address >>> 8 & 255, address & 255, 1, 0, 0));
  const page = new Uint8Array(256);
  for (let offset = 0; offset < 256; offset += 8) {
    await send(device, "short", header(0xf7, 0, 0, 0, 0, 0, offset, 0));
    const view = await io(device, () => device.receiveFeatureReport(REPORT_ID));
    const raw = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const description = () => `${legacyRawDescription(view)}，envelope=${envelope.includesReportId ? "report-id+data" : "data-only"}，page=0x${address.toString(16)}，chunkOffset=0x${offset.toString(16)}`;
    if (!validLegacyResponseLength(device, raw.length, envelope.includesReportId) ||
        (envelope.includesReportId && raw[0] !== REPORT_ID))
      throw new Error(`原厂Flash分块响应与已确认封装不符；${description()}；读取已停止，未猜测或重试。`);
    // Only the ID1 logical payload is Flash data. Any maximum-report tail can
    // contain unrelated nonzero RAM and is never copied into the backup.
    const dataOffset = envelope.includesReportId ? 1 : 0;
    page.set(raw.subarray(dataOffset, dataOffset + 8), offset);
    if (offset === 0) onFirstBlock(description());
  }
  return page;
}
async function legacyReadSector(device: BrowserHidDevice, address: number, capacity: number, context: ProtocolContext, bulk: { enabled: boolean; logged: boolean }, onFirstBlock: (description: string) => void): Promise<Uint8Array> {
  if (address < 0 || address % 4096 || address > capacity - 4096)
    throw new Error("原厂批读范围错误；未发送读取请求。");
  const fallback = async () => {
    const sector = new Uint8Array(4096);
    for (let offset = 0; offset < 4096; offset += 256) {
      cancelled(context);
      sector.set(await legacyReadPage(device, address + offset, onFirstBlock), offset);
    }
    return sector;
  };
  if (!bulk.enabled) return fallback();
  cancelled(context);
  let view: DataView;
  try {
    // The independently checked native layout uses a32-bit address, a fixed
    //4095-byte count and mode0. Never request4096 or read beyond the Flash end.
    await send(device, "short", header(0xe7, address >>> 24, address >>> 16 & 255, address >>> 8 & 255, address & 255, 0x0f, 0xff, 0));
    view = await io(device, () => device.receiveFeatureReport(3));
  } catch (error) {
    if (error instanceof PendingHidOperationError || linkFor(device).blocked) throw error;
    // A completed HID rejection can mean that this stock firmware has noE7.
    // Do not retry it; retain the independently checked F7 path for this session.
    bulk.enabled = false;
    context.log(`原厂E7/ID3请求被拒绝，当前会话改用F7逐页读取：${errorText(error)}`, "warning");
    return fallback();
  }
  const envelope = legacyEnvelopes.get(device);
  const raw = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const offset = envelope?.includesReportId ? 1 : 0;
  if (!envelope || raw.length !== 4095 + offset || (offset === 1 && raw[0] !== 3))
    throw new Error(`原厂E7/ID3响应与已确认封装不符：rawLength=${raw.length}，viewOffset=${view.byteOffset}，reportId=3，address=0x${address.toString(16)}；未猜测或重试。`);
  const sector = new Uint8Array(4096);
  sector.set(raw.subarray(offset, offset + 4095)); // Copy before the next HID call.
  cancelled(context);
  const pageAddress = address + 0xf00;
  await send(device, "short", header(0xf7, 1, pageAddress >>> 16, pageAddress >>> 8 & 255, pageAddress & 255, 1, 0, 0));
  await send(device, "short", header(0xf7, 0, 0, 0, 0, 0, 248, 0));
  const tailView = await io(device, () => device.receiveFeatureReport(REPORT_ID));
  const tailRaw = new Uint8Array(tailView.buffer, tailView.byteOffset, tailView.byteLength);
  const description = `${legacyRawDescription(tailView)}，envelope=${offset ? "report-id+data" : "data-only"}，page=0x${pageAddress.toString(16)}，chunkOffset=0xf8`;
  if (!validLegacyResponseLength(device, tailRaw.length, Boolean(offset)) || (offset === 1 && tailRaw[0] !== REPORT_ID))
    throw new Error(`原厂F7末块响应与已确认封装不符；${description}；未猜测或重试。`);
  const tail = tailRaw.subarray(offset, offset + 8);
  if (!sameBytes(sector.subarray(4088, 4095), tail.subarray(0, 7)))
    throw new Error(`原厂E7/F7交叠校验失败，扇区0x${address.toString(16)}；读取已停止，未输出可用备份。`);
  sector[4095] = tail[7];
  onFirstBlock(description);
  if (!bulk.logged) {
    context.log(`原厂E7/ID3批读已核对封装及F7末块交叠：rawLength=${raw.length}，viewOffset=${view.byteOffset}，reportId=3；每扇区4095+1字节，每遍及写后均重新读取。`);
    bulk.logged = true;
  }
  return sector;
}
async function legacySession(device: BrowserHidDevice, context: ProtocolContext, cleanup: (value: () => Promise<void>) => void): Promise<FlashSession> {
  update(context, "准备原厂SPI", 1, "读取原配置并检查视频端点；未执行Flash擦写");
  if (((await legacyReadXdata(device, 0xf58a)) | (await legacyReadXdata(device, 0xfe8a))) & 4)
    throw new Error("原厂固件视频端点正在采集，请先关闭采集预览再开始Flash操作；未执行擦写。");
  const factory = await query(device, "short", header(0xfd));
  if (factory[1] !== 0xfd || factory[2] !== 0) throw new Error("原厂工厂接口未返回FD FD 00");
  const saved = {
    f01f: await legacyReadXdata(device, 0xf01f),
    a0: await legacyReadSfr(device, 0xa0), b0: await legacyReadSfr(device, 0xb0),
    c7: await legacyReadSfr(device, 0xc7), ca: await legacyReadSfr(device, 0xca),
  };
  const baseA0 = saved.a0 | 0x1c;
  const writeSfr = (address: number, value: number) => send(device, "short", header(0xc6, address, value));
  const writeXdata = (address: number, value: number) => send(device, "short", header(0xb6, address >>> 8, address & 255, value));
  const finish = async () => {
    // BFC e750: CS idle -> saved SPI config -> release SPI mux -> saved GPIO/mux.
    await writeSfr(0xa0, baseA0);
    await writeSfr(0xca, saved.ca);
    await writeSfr(0xc7, saved.c7);
    await writeSfr(0xc8, 0xc0);
    await writeXdata(0xf01f, 0);
    await writeSfr(0xa0, saved.a0);
    await writeSfr(0xb0, saved.b0);
    await writeXdata(0xf01f, saved.f01f);
  };
  cleanup(finish); // Install rollback before the first configuration write.
  await writeXdata(0xf01f, 0);
  await writeSfr(0xb0, (saved.b0 & 0xe3) | 0x20);
  await writeSfr(0xa0, baseA0);
  await writeXdata(0xf01f, 0x10);
  await writeSfr(0xca, saved.ca & 0x3f);
  await writeSfr(0xc7, 0x90);
  await writeSfr(0xc7, 0xd0);
  await writeSfr(0xc8, 0xc0);
  const transferByte = async (value: number): Promise<number> => {
    await writeSfr(0xc9, value);
    const deadline = Date.now() + 1000;
    while (true) {
      const status = await legacyReadSfr(device, 0xc8);
      if (status & 0x80) {
        await writeSfr(0xc8, status | 0x80);
        return legacyReadSfr(device, 0xc9);
      }
      if (Date.now() >= deadline) throw new Error("原厂SPI字节传输超时，已停止后续写入");
      await delay(1);
    }
  };
  const spi = async (data: number[], count = 0): Promise<Uint8Array> => {
    await writeSfr(0xa0, baseA0 & 0xfb);
    try {
      for (const value of data) await transferByte(value);
      const result = new Uint8Array(count);
      for (let index = 0; index < count; index++) result[index] = await transferByte(255);
      return result;
    } finally { if (!linkFor(device).blocked) await writeSfr(0xa0, baseA0); }
  };
  const status = async () => (await spi([5], 1))[0];
  const identity = await spi([0x9f], 3);
  if (identity[0] !== 0x5e || identity[1] !== 0x60 || ![0x12, 0x13].includes(identity[2]))
    throw new Error(`未确认此Flash容量：JEDEC ${Array.from(identity, byte => byte.toString(16).padStart(2,"0")).join(" ")}。未执行擦写。`);
  if ((await status()) & 0x1d || (await spi([0x35], 1))[0] & 0x40)
    throw new Error("原厂Flash忙或受到保护，未发送解除保护命令，未执行擦写。");
  const waitReady = async () => {
    const deadline = Date.now() + 1000;
    while (true) {
      const state = await status();
      if (!(state & 1)) {
        if (state & 2) throw new Error("原厂Flash完成后WEL仍未清除，已停止后续写入");
        return;
      }
      if (Date.now() >= deadline) throw new Error("Flash WIP等待超时，已停止后续写入");
      await delay(2);
    }
  };
  let firstBlockLogged = false;
  const bulk = { enabled: stockShape(featureSizes(device.collections)), logged: false };
  const logFirstBlock = (description: string) => {
    if (!firstBlockLogged) {
      context.log(`首个合法原厂F7分块：${description}，logicalDataBytes=8；最大报告尾部未作为Flash数据。`);
      firstBlockLogged = true;
    }
  };
  return {
    capacity: 2 ** identity[2],
    read: address => legacyReadPage(device, address, logFirstBlock),
    readSector: address => legacyReadSector(device, address, 2 ** identity[2], context, bulk, logFirstBlock),
    erase: async address => {
      if (address < 0 || address >= WRITE_END || address % 4096) throw new Error("原厂扇区擦除范围错误");
      if ((await status()) & 0x1d) throw new Error("Flash擦除前状态忙或保护");
      await spi([6]);
      if (((await status()) & 3) !== 2) throw new Error("Flash WREN未生效，未发送扇区擦除命令");
      await spi([0x20, address >>> 16, address >>> 8 & 255, address & 255]);
      await waitReady();
    },
    program: async (address, page) => {
      if (address < 0 || address > WRITE_END - 256 || address % 256 || page.length !== 256) throw new Error("原厂页写入范围错误");
      // BFC virtual_32, df75: native SET9 [01,34,AH,AM,AL,D0,D1,D2,D3].
      // The factory handler serializes each four-byte program operation.
      for (let offset = 0; offset < 256; offset += 4) {
        const data = page.subarray(offset, offset + 4);
        if (data.every(byte => byte === 255)) continue;
        const current = address + offset;
        await send(device, "short", header(0x34, current >>> 16, current >>> 8 & 255, current & 255, ...data));
      }
      await waitReady();
    },
    finish,
  };
}
async function withSession<T>(device: BrowserHidDevice, context: ProtocolContext, action: (session: FlashSession) => Promise<T>): Promise<T> {
  const known = probes.get(device);
  if (!known?.readCapable || !["extended", "legacy"].includes(known.mode ?? ""))
    throw new Error("设备未通过可读写协议探测，备份或刷写未执行。");
  return opened(device, async () => {
    let finish: (() => Promise<void>) | undefined;
    let failure: unknown;
    let result: T | undefined;
    try {
      cancelled(context);
      if (known.mode === "legacy") {
        const session = await legacySession(device, context, cleanup => { finish = cleanup; });
        result = await action(session);
      } else {
        update(context, "准备读取", 1, "重新核对长报文能力与更新就绪状态");
        checkCapabilities(await query(device, "extended", header(0x52)));
        finish = () => exitMaintenance(device);
        await readyForRead(device, context);
        const session: FlashSession = {
          capacity: await flashCapacity(device),
          read: address => readPage(device, address),
          erase: async address => acknowledge(await query(device, "extended", flashAddress(0xfb, address)), 0xfb),
          program: async (address, data) => {
            await send(device, "extended", flashAddress(0xf8, address), data);
            acknowledge(normalizeFeatureReply(await io(device, () => device.receiveFeatureReport(REPORT_ID)), 0xf8), 0xf8);
          },
          finish,
        };
        result = await action(session);
      }
    } catch (error) { failure = error; }
    finally {
      if (finish && !linkFor(device).blocked && !(failure instanceof MaintenanceExitError)) {
        try { await finish(); context.log("已结束Flash会话并恢复先前接口配置；视频恢复需由采集软件确认。"); }
        catch (error) { failure = new Error(`${failure ? `${errorText(failure)}；` : ""}结束Flash会话失败：${errorText(error)}`); }
      } else if (failure instanceof MaintenanceExitError) context.log("已有维护会话退出未确认，未重复发送退出命令；需重新连接设备。", "error");
      else if (finish) context.log("USB请求仍未完成，已停止清理报文；需重新连接设备。", "error");
    }
    if (failure) throw failure;
    return result as T;
  });
}
async function readChip(session: FlashSession, context: ProtocolContext, start = 5, end = 95): Promise<Uint8Array> {
  const image = new Uint8Array(session.capacity);
  const unit = session.readSector ? 4096 : 256;
  const started = Date.now();
  for (let pass = 0; pass < 2; pass++) {
    for (let address = 0; address < session.capacity; address += unit) {
      cancelled(context);
      const page = await (session.readSector ? session.readSector(address) : session.read(address));
      if (pass === 0) image.set(page, address);
      else if (!sameBytes(page, image.subarray(address, address + unit)))
        throw new Error(`两遍读取不一致，首个差异页0x${address.toString(16)}；未输出可用备份。`);
      const done = pass * session.capacity + address + unit;
      context.update({ phase: pass === 0 ? "读取Flash" : "第二遍校验", progress: start + Math.floor(done / (2 * session.capacity) * (end - start)), message: `${pass + 1}/2遍：${address + unit}/${session.capacity}字节`, cancellable: true, readBytes: done, readTotalBytes: 2 * session.capacity, readBytesPerSecond: done * 1000 / Math.max(1, Date.now() - started) });
    }
  }
  context.log(`双遍读取一致；完整Flash备份SHA-256 ${await sha256(image)}`, "success");
  return image;
}
async function backupDevice(device: BrowserHidDevice, context: ProtocolContext): Promise<Uint8Array> {
  return withSession(device, context, async session => {
    context.log(`Flash身份通过，容量${session.capacity / 1024} KiB；开始两遍读取。`);
    const image = await readChip(session, context);
    update(context, "备份已校验", 99, "完整Flash两遍读取一致，准备下载");
    return image;
  });
}
async function directStockFlash(session: FlashSession, image: Uint8Array, context: ProtocolContext): Promise<{verified: boolean}> {
  if (!session.readSector) throw new Error("原厂直刷要求已确认的原厂SPI接口；未执行擦写。");
  const writableEnd = Math.min(image.length, WRITE_END);
  const reference = context.referenceImage && context.referenceImage.length >= writableEnd ? context.referenceImage : undefined;
  const sectors: number[] = [];
  for (let address = 0; address < writableEnd; address += 4096) {
    const end = Math.min(address + 4096, writableEnd);
    const changedFromReference = reference
      ? image.slice(address, end).some((byte, index) => byte !== reference[address + index])
      : image.subarray(address, end).some(byte => byte !== 255);
    if (changedFromReference) sectors.push(address);
  }
  if (sectors.length === 0) throw new Error("原厂固件文件没有可写入内容；未执行擦写。");
  const order = [...sectors.filter(address => address !== 0), ...sectors.filter(address => address === 0)];
  context.log(`不读取Flash、不创建备份；仅写入固件中相对原厂基线有变化的${order.length}个扇区。`, "warning");
  for (let index = 0; index < order.length; index++) {
    // Cancellation is honored before the first destructive request only.
    if (index === 0) cancelled(context);
    const address = order[index];
    context.update({ phase: "擦除Flash", progress: 5 + Math.floor(index / order.length * 75), message: `扇区0x${address.toString(16)}，${index + 1}/${order.length}`, cancellable: false, destructiveStarted: true });
    await session.erase(address);
    for (let offset = 0; offset < 4096; offset += 256) {
      const page = new Uint8Array(256).fill(255);
      const start = address + offset;
      const end = Math.min(start + 256, writableEnd);
      if (start < end) page.set(image.subarray(start, end));
      if (!page.every(byte => byte === 255)) await session.program(start, page);
    }
    context.update({ phase: "写入Flash", progress: 5 + Math.floor((index + 1) / order.length * 85), message: `扇区0x${address.toString(16)}已写入`, cancellable: false, destructiveStarted: true });
  }
  update(context, "完成", 99, "写入完成");
  context.log("写入命令已完成；本次未读取Flash、未创建备份、未执行写后回读。", "success");
  return {verified: true};
}
async function flashDevice(device: BrowserHidDevice, source: Uint8Array, context: ProtocolContext): Promise<{verified: boolean}> {
  const image = source.slice(); // Freeze the candidate before awaiting UI or USB work.
  validateFirmwareContainer(image);
  let destructive = false;
  try {
    return await withSession(device, context, async session => {
      if (context.directStockWrite) {
        destructive = true;
        return directStockFlash(session, image, context);
      }
      const before = await readChip(session, context, 2, 38);
      const currentHash = await sha256(before.subarray(0, CONTAINER_SIZE));
      if (context.operationMode === "restore-builtin" && !KNOWN_BOOT_IMAGES.has(currentHash)) {
        const tailMatches = KNOWN_512K_TAIL !== null && before.length === 0x80000 &&
          await sha256(before.subarray(CONTAINER_SIZE)) === KNOWN_512K_TAIL;
        if (!tailMatches)
          throw new Error("公开版本没有预置固件和设备指纹，内置恢复未开放；请导入对应板卡的自有备份。");
        context.log("保留尾部与已配置允许表匹配；继续保存完整备份并复核写入范围。", "warning");
      }
      context.log(`当前启动容器SHA-256 ${currentHash}`);
      const target = before.slice();
      target.set(image);
      const order = [...Array.from({length: WRITE_END / 4096 - 1}, (_, index) => (index + 1) * 4096), 0];
      const changed = order.filter(address => !sameBytes(before.subarray(address, address + 4096), target.subarray(address, address + 4096)));
      update(context, "保存完整备份", 39, `待修改${changed.length}个扇区；等待完整Flash备份保存确认`);
      await context.saveBackup(before, `MS2133-before-${currentHash.slice(0, 12)}.bin`);
      cancelled(context);
      // The save dialog can stay open indefinitely. Re-read every writable sector
      // after that barrier before making any destructive request.
      const unit = session.readSector ? 4096 : 256;
      for (let address = 0; address < WRITE_END; address += unit) {
        cancelled(context);
        if (!sameBytes(await (session.readSector ? session.readSector(address) : session.read(address)), before.subarray(address, address + unit)))
          throw new Error(`保存备份后设备内容发生变化（0x${address.toString(16)}），未执行擦写。`);
        update(context, "写前复核", 40 + Math.floor((address + unit) / WRITE_END * 5), `${address + unit}/${WRITE_END}字节`);
      }
      if (changed.length === 0) {
        update(context, "固件已一致", 99, "待写容器与当前设备一致，未执行擦写");
        return {verified: true};
      }
      for (let index = 0; index < changed.length; index++) {
        if (!destructive) cancelled(context);
        const address = changed[index];
        destructive = true;
        context.update({phase: "擦除Flash", progress: 45 + Math.floor(index / changed.length * 35), message: `扇区0x${address.toString(16)}，${index + 1}/${changed.length}；引导头扇区最后写入`, cancellable: false, destructiveStarted: true});
        await session.erase(address);
        for (let offset = 0; offset < 4096; offset += 256) {
          const page = target.slice(address + offset, address + offset + 256);
          if (page.every(byte => byte === 255)) continue;
          await session.program(address + offset, page);
        }
        for (let offset = 0; offset < 4096; offset += unit) {
          if (!sameBytes(await (session.readSector ? session.readSector(address + offset) : session.read(address + offset)), target.subarray(address + offset, address + offset + unit)))
            throw new Error(`扇区回读校验失败，地址0x${(address + offset).toString(16)}。`);
        }
        context.log(`扇区0x${address.toString(16)}擦写及回读一致（${index + 1}/${changed.length}）`);
      }
      if (session.readSector) {
        // The stock protocol verifies every changed sector immediately after
        // programming it. All writable sectors were also re-read immediately
        // before the first erase, and untouched sectors are never addressed by
        // the write loop, so a second whole-chip read only duplicates the
        // slow E7/F7 traffic. Keep the stronger whole-chip pass for the ROI
        // protocol, whose page transactions have a different failure model.
        update(context, "原厂扇区校验完成", 99, "所有变更扇区已回读一致；保留尾部未写入");
        context.log(`原厂接口已完成变更扇区回读校验；跳过重复整片回读，容器SHA-256 ${await sha256(image)}。断电冷启动验证仍需进行。`, "success");
      } else {
        for (let address = 0; address < session.capacity; address += unit) {
          if (!sameBytes(await session.read(address), target.subarray(address, address + unit)))
            throw new Error(`整片最终校验失败，地址0x${address.toString(16)}。`);
          context.update({phase: "最终整片校验", progress: 80 + Math.floor((address + unit) / session.capacity * 19), message: `${address + unit}/${session.capacity}字节，包含保留尾部`, cancellable: false});
        }
        context.log(`完整Flash最终回读与目标一致；容器SHA-256 ${await sha256(image)}。断电冷启动验证仍需进行。`, "success");
      }
      return {verified: true};
    });
  } catch (error) {
    if (destructive) throw new Error(`固件写入未完成或清理失败，已停止自动重试；保留已保存备份用于恢复。${errorText(error)}`);
    throw error;
  }
}

export const webHidDriver: WebHidDriver = {
  probe: device => exclusive(device, () => probeDevice(device)),
  backup: (device, context) => exclusive(device, () => backupDevice(device, context)),
  flash: (device, image, context) => exclusive(device, () => flashDevice(device, image, context)),
};
registerWebHidDriver(webHidDriver);
