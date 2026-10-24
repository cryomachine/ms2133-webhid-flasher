export type DeviceStatus = "enumerated" | "reachable" | "update" | "busy" | "error";
export interface DeviceInfo {
  id: string;
  path: string;
  vendorId: number;
  productId: number;
  product?: string | null;
  manufacturer?: string | null;
  serial?: string | null;
  interfaceNumber?: number | null;
  usagePage?: number | null;
  usage?: number | null;
  featureReportLength?: number | null;
  status: DeviceStatus;
  detail?: string | null;
  canReadFlash: boolean;
  canWriteFlash: boolean;
}
export interface ScanResult { devices: DeviceInfo[]; diagnostics?: string[]; }
export interface FirmwareInfo {
  path: string;
  size: number;
  sha256: string;
  valid: boolean;
  errors: string[];
  format?: string | null;
  target?: string | null;
  headerChecksumValid?: boolean | null;
  payloadChecksumValid?: boolean | null;
  sourceSize?: number;
  bootImageExtracted?: boolean;
}
export type OperationStatus = "idle" | "running" | "complete" | "failed" | "cancelled" | "interrupted";
export interface LogEntry { timestamp: string; level: "info" | "warning" | "error" | "success"; message: string; }
export interface OperationState {
  id?: string | null;
  kind: "idle" | "backup" | "flash" | "restore";
  status: OperationStatus;
  phase: string;
  progress: number;
  message: string;
  cancellable: boolean;
  logs: LogEntry[];
  backupPath?: string | null;
  backupSaveRequired?: boolean;
  backupDownloaded?: boolean;
  outputPath?: string | null;
  error?: string | null;
  destructiveStarted?: boolean;
  readBytes?: number;
  readTotalBytes?: number;
  readBytesPerSecond?: number;
  firmwareSha256?: string;
  target?: string;
}
