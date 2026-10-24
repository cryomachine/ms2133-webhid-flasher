import type { DeviceInfo, FirmwareInfo, OperationState } from "./types";

const OPERATION_KEY = "ms2133-flasher-operation-v1";
const DATABASE = "ms2133-flasher-recovery-v1";
export interface RecoveryRecord {
  id: string;
  createdAt: string;
  device: DeviceInfo;
  firmware?: FirmwareInfo;
  image?: Uint8Array;
  backup?: Uint8Array;
  backupName?: string;
}
export interface RecoverySummary { available: boolean; createdAt?: string; device?: string; backupName?: string; backupBytes?: number; imageBytes?: number; }
let database: Promise<IDBDatabase> | null = null;
function openDatabase(): Promise<IDBDatabase> {
  if (!database) database = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) { reject(new Error("浏览器未提供IndexedDB，恢复包无法持久保存；写入未开始。")); return; }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("recovery")) request.result.createObjectStore("recovery"); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(`恢复包存储未打开：${request.error?.message ?? "未知错误"}`));
    request.onblocked = () => reject(new Error("恢复包数据库被另一个网页阻塞，请关闭其他刷写页面。"));
  });
  return database;
}
export function saveOperation(operation: OperationState): void {
  localStorage.setItem(OPERATION_KEY, JSON.stringify(operation));
}
export function loadOperation(): OperationState | null {
  try {
    const raw = localStorage.getItem(OPERATION_KEY);
    if (!raw) return null;
    const operation = JSON.parse(raw) as OperationState;
    if (!operation || !Array.isArray(operation.logs) || typeof operation.status !== "string") return null;
    if (operation.status === "running") {
      const interrupted: OperationState = { ...operation, status: "interrupted", cancellable: false, backupSaveRequired: false, backupDownloaded: false, phase: "上次操作已中断", message: operation.destructiveStarted ? "上次在擦写开始后中断，设备状态尚未确认。重新连接后先探测，再选择恢复。" : "上次操作在网页关闭时中断；先重新连接并确认设备状态。", error: "页面重载后不会自动续写或重复擦除。" };
      saveOperation(interrupted); return interrupted;
    }
    return operation;
  } catch { return null; }
}
export async function putRecovery(record: RecoveryRecord): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("recovery", "readwrite");
    transaction.objectStore("recovery").put(record, "latest");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error(`恢复包未保存：${transaction.error?.message ?? "未知错误"}`));
    transaction.onabort = () => reject(new Error("恢复包保存事务已中断。"));
  });
}
export async function getRecovery(): Promise<RecoveryRecord | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("recovery", "readonly");
    const request = transaction.objectStore("recovery").get("latest");
    request.onsuccess = () => resolve((request.result as RecoveryRecord | undefined) ?? null);
    request.onerror = () => reject(new Error("恢复包读取失败。"));
  });
}
export async function recoverySummary(): Promise<RecoverySummary> {
  const record = await getRecovery();
  return record ? { available: true, createdAt: record.createdAt, device: record.device.product ?? "MS2133", backupName: record.backupName, backupBytes: record.backup?.byteLength, imageBytes: record.image?.byteLength } : { available: false };
}
