import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import assert from "node:assert/strict";
import ts from "typescript";
import { CONTAINER_SIZE, makeSyntheticContainer, makeSyntheticFlash } from "../tests/synthetic-firmware.mjs";

const compile = name => ts.transpileModule(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS } }).outputText;
const backendCode = compile("backend"), storageCode = compile("storage");
const fixture = makeSyntheticContainer();
function memoryDatabase(records = new Map(), fail = false) {
  const database = {
    objectStoreNames: { contains: () => true }, createObjectStore() {},
    transaction() {
      const transaction = { objectStore() { return {
        put(value, key) { setImmediate(() => { if (fail) { transaction.error = { message: "test storage failure" }; transaction.onerror?.(); } else { records.set(key, structuredClone(value)); transaction.oncomplete?.(); } }); },
        get(key) { const request = {}; setImmediate(() => { request.result = structuredClone(records.get(key)); request.onsuccess?.(); }); return request; },
      }; } };
      return transaction;
    },
  };
  return { records, open() { const request = {}; setImmediate(() => { request.result = database; request.onsuccess?.(); }); return request; } };
}
function setup(savePicker, shared = {}) {
  const writes = [], clicks = [], attached = new Set(), events = new Map(), timers = new Map(), local = shared.local ?? new Map(), idb = shared.idb ?? memoryDatabase();
  const usbCalls = [];
  let requestDeviceOptions;
  const unexpectedUsb = method => { usbCalls.push(method); throw new Error(`Unexpected HID transaction: ${method}`); };
  const fakeDevice = {
    vendorId: shared.vendorId ?? 0x345f, productId: shared.productId ?? 0x2133, productName: "Synthetic test device", opened: false, collections: [],
    open: async () => unexpectedUsb("open"), close: async () => unexpectedUsb("close"),
    sendFeatureReport: async () => unexpectedUsb("sendFeatureReport"), receiveFeatureReport: async () => unexpectedUsb("receiveFeatureReport"),
  };
  const storageExports = {}, exports = {};
  const sandbox = {
    exports: storageExports,
    window: { isSecureContext: true, indexedDB: idb, addEventListener: (name, handler) => events.set(name, handler), removeEventListener: name => events.delete(name), setTimeout: (handler) => { const id = timers.size + 1; timers.set(id, handler); return id; }, clearTimeout: id => timers.delete(id), ...(savePicker ? { showSaveFilePicker: async () => ({ createWritable: async () => ({ write: async bytes => writes.push(bytes.length), close: async () => writes.push("closed") }) }) } : {}) },
    indexedDB: idb,
    localStorage: { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value) },
    navigator: { userAgent: "test", hid: { getDevices: async () => { usbCalls.push("getDevices"); return [fakeDevice]; }, requestDevice: async options => { usbCalls.push("requestDevice"); requestDeviceOptions = options; return [fakeDevice]; } } },
    document: { body: { appendChild: input => attached.add(input) }, createElement: type => type === "input" ? { style: {}, remove() { attached.delete(this); }, files: shared.cancelPicker ? [] : [{ name: "fixture.bin", arrayBuffer: async () => fixture.buffer }], addEventListener() {}, click() { assert.ok(attached.has(this), "file input must be attached before click"); assert.equal(this.accept, undefined, "native picker must not have UTI filter"); if (!shared.cancelPicker) void this.onchange(); } } : { click() { clicks.push(this.download); } } },
    URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
    Blob, Uint8Array, Date, Error, Promise, Map, WeakMap, TextEncoder, btoa,
    crypto: webcrypto,
  };
  vm.runInNewContext(storageCode, sandbox);
  sandbox.exports = exports;
  sandbox.require = name => {
    if (name === "./storage") return storageExports;
    assert.fail(`Unexpected backend dependency: ${name}`);
  };
  vm.runInNewContext(backendCode, sandbox);
  return { api: exports, writes, clicks, usbCalls, local, idb, attached, events, get requestDeviceOptions() { return requestDeviceOptions; }, runTimers() { for (const [id, handler] of [...timers]) { timers.delete(id); handler(); } } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
async function prepare(state, flash, command = "start_flash") {
  state.api.registerWebHidDriver({ probe: async () => ({ canReadFlash: true, canWriteFlash: true, status: "reachable", firmwareType: command === "start_restore" ? "stock" : "roi" }), backup: async () => fixture, flash });
  const scan = await state.api.callBackend("scan_devices");
  const path = await state.api.callBackend("choose_firmware");
  await state.api.callBackend(command, { deviceId: scan.devices[0].id, firmwarePath: path });
  await settle();
  assert.equal(state.attached.size, 0, "completed file input must be removed");
  return state;
}
let savedBackupScenarios = 0;
function savedBackupState(backup, backupName = "saved-backup.bin") {
  const record = {
    id: "synthetic-saved-record", createdAt: "2026-01-01T00:00:00.000Z",
    device: { id: "saved-device", path: "saved-interface", vendorId: 0x345f, productId: 0x2133, product: "Synthetic test device", status: "reachable", canReadFlash: true, canWriteFlash: true },
    backup, backupName,
  };
  const state = setup(false, { idb: memoryDatabase(new Map([["latest", record]])) });
  state.driverCalls = [];
  const unexpectedDriver = method => { state.driverCalls.push(method); throw new Error(`Unexpected driver call: ${method}`); };
  state.api.registerWebHidDriver({
    probe: async () => unexpectedDriver("probe"),
    backup: async () => unexpectedDriver("backup"),
    flash: async () => unexpectedDriver("flash"),
  });
  return state;
}
async function assertBackupLoadIsLocal(state) {
  assert.deepEqual(state.usbCalls, [], "loading a saved backup must not enumerate, authorize or communicate with HID");
  assert.deepEqual(state.driverCalls ?? [], [], "loading a saved backup must not invoke the hardware driver");
  assert.deepEqual(state.clicks, [], "loading a saved backup must not trigger a download");
  assert.deepEqual(state.writes, [], "loading a saved backup must not write a local file");
  assert.equal(await state.api.callBackend("get_operation"), null, "loading a saved backup must not start an operation");
}

const emptySaved = setup(false);
await assert.rejects(emptySaved.api.callBackend("load_saved_backup"), /尚未保存完整.*备份/);
await assertBackupLoadIsLocal(emptySaved); savedBackupScenarios++;

const windowsPid = setup(false, { productId: 0x0000 });
await windowsPid.api.requestWebDevice();
const requestedFilter = windowsPid.requestDeviceOptions.filters;
assert.equal(requestedFilter.length, 1, "WebHID authorization must use one vendor filter");
assert.equal(requestedFilter[0].vendorId, 0x345f, "WebHID authorization must allow Windows PID variants");
assert.equal("productId" in requestedFilter[0], false, "WebHID authorization must not require a fixed PID");
const windowsScan = await windowsPid.api.callBackend("scan_devices");
assert.equal(windowsScan.devices[0].productId, 0x0000, "Windows PID variant must remain visible after authorization");

const missingBackup = savedBackupState(undefined);
await assert.rejects(missingBackup.api.callBackend("load_saved_backup"), /尚未保存完整.*备份/);
await assertBackupLoadIsLocal(missingBackup); savedBackupScenarios++;

for (const capacity of [0x40000, 0x80000]) {
  const completeBackup = makeSyntheticFlash(capacity);
  const state = savedBackupState(completeBackup, `backups/full-${capacity}.bin`);
  const info = await state.api.callBackend("load_saved_backup");
  assert.equal(info.valid, true, "a valid full backup must yield a valid container");
  assert.equal(info.size, CONTAINER_SIZE, "only the boot container may be prepared for restore");
  assert.equal(info.sourceSize, capacity, "sourceSize must describe the complete stored Flash backup");
  assert.equal(info.bootImageExtracted, true, "the UI must distinguish extraction from a container-only input");
  assert.equal(info.headerChecksumValid, true); assert.equal(info.payloadChecksumValid, true);
  const digest = Buffer.from(await webcrypto.subtle.digest("SHA-256", completeBackup.slice(0, CONTAINER_SIZE))).toString("hex");
  assert.equal(info.sha256, digest, "the extracted candidate must exactly equal the stored backup prefix");
  assert.ok(info.path.endsWith(`/full-${capacity}.bin`), "saved backup metadata must retain the basename");
  assert.equal(info.path.includes("backups/"), false, "the virtual candidate must not inherit parent paths");
  const inspected = await state.api.callBackend("inspect_firmware", { path: info.path });
  assert.equal(inspected.sha256, digest); assert.equal(inspected.sourceSize, capacity); assert.equal(inspected.bootImageExtracted, true);
  assert.deepEqual(state.idb.records.get("latest").backup, completeBackup, "loading must preserve the complete stored backup");
  assert.equal((await state.api.callBackend("get_recovery_summary")).backupBytes, capacity);
  await assertBackupLoadIsLocal(state); savedBackupScenarios++;
}

const shortSaved = savedBackupState(makeSyntheticContainer().slice(0, CONTAINER_SIZE - 1));
await assert.rejects(shortSaved.api.callBackend("load_saved_backup"), /小于启动容器长度/);
await assertBackupLoadIsLocal(shortSaved); savedBackupScenarios++;

for (const [offset, expected] of [[0x10, /头部校验和/], [0x35, /载荷校验和/]]) {
  const corruptBackup = makeSyntheticFlash(); corruptBackup[offset] ^= 1;
  const state = savedBackupState(corruptBackup, "invalid.bin");
  await assert.rejects(state.api.callBackend("load_saved_backup"), expected);
  await assert.rejects(state.api.callBackend("inspect_firmware", { path: "saved-1/invalid.bin" }), /网页未保存这个文件/, "a rejected candidate must not remain available for writing");
  assert.deepEqual(state.idb.records.get("latest").backup, corruptBackup, "validation failure must not alter the saved backup");
  await assertBackupLoadIsLocal(state); savedBackupScenarios++;
}

let continued = false;
const fileApi = await prepare(setup(true), async (_device, _image, context) => { assert.equal(context.operationMode, "flash"); await context.saveBackup(new Uint8Array([1, 2, 3]), "before.bin"); continued = true; return { verified: true }; });
assert.equal((await fileApi.api.callBackend("get_operation")).backupSaveRequired, true);
assert.equal(continued, false);
assert.equal((await fileApi.api.callBackend("get_recovery_summary")).backupBytes, 3);
await fileApi.api.callBackend("save_pending_backup"); await settle();
assert.deepEqual(fileApi.writes, [3, "closed"]);
assert.equal(continued, true);
assert.equal((await fileApi.api.callBackend("get_operation")).status, "complete");

// The merged UI uses one firmware task for both a selected container and a
// normalized full-backup source. The unified command must retain the same
// Flash context and save barrier as the legacy command.
continued = false;
const unified = await prepare(setup(false), async (_device, _image, context) => {
  assert.equal(context.operationMode, "flash");
  await context.saveBackup(new Uint8Array([6]), "unified-before.bin");
  continued = true;
  return { verified: true };
}, "start_firmware");
await unified.api.callBackend("save_pending_backup");
await unified.api.callBackend("confirm_backup_saved");
await settle();
assert.equal(continued, true);
assert.equal((await unified.api.callBackend("get_operation")).status, "complete");

continued = false;
const fallback = await prepare(setup(false), async (_device, _image, context) => { await context.saveBackup(new Uint8Array([4]), "fallback.bin"); continued = true; return { verified: true }; });
await fallback.api.callBackend("save_pending_backup");
assert.equal(continued, false); assert.deepEqual(fallback.clicks, ["fallback.bin"]);
assert.equal((await fallback.api.callBackend("get_operation")).backupDownloaded, true);
await fallback.api.callBackend("confirm_backup_saved"); await settle(); assert.equal(continued, true);

continued = false;
const cancelled = await prepare(setup(false), async (_device, _image, context) => { await context.saveBackup(new Uint8Array([5]), "cancel.bin"); continued = true; return { verified: true }; });
await cancelled.api.callBackend("cancel_operation"); await settle(); assert.equal(continued, false);
let operation = await cancelled.api.callBackend("get_operation"); assert.equal(operation.status, "cancelled");
const count = operation.logs.length; operation.logs.push({ message: "external mutation" });
assert.equal((await cancelled.api.callBackend("get_operation")).logs.length, count);

let finish;
const destructive = await prepare(setup(false), async (_device, _image, context) => {
  assert.equal(context.operationMode, "restore-file");
  context.update({ phase: "擦除Flash", progress: 20, message: "test", cancellable: false, destructiveStarted: true });
  context.update({ phase: "编程", progress: 30, message: "test", cancellable: true });
  await new Promise(resolve => { finish = resolve; }); return { verified: true };
}, "start_restore");
operation = await destructive.api.callBackend("get_operation"); assert.equal(operation.cancellable, false);
await assert.rejects(destructive.api.callBackend("cancel_operation"), /不允许取消/);
const reloaded = setup(false, destructive);
operation = await reloaded.api.callBackend("get_operation"); assert.equal(operation.status, "interrupted"); assert.equal(operation.destructiveStarted, true);
assert.equal((await reloaded.api.callBackend("get_recovery_summary")).imageBytes, fixture.length);
finish(); await settle();

let touched = false;
const noStorage = setup(false, { idb: memoryDatabase(new Map(), true) });
await assert.rejects(prepare(noStorage, async () => { touched = true; return { verified: true }; }), /恢复包未保存/);
assert.equal(touched, false);

const cancelledPicker = setup(false, { cancelPicker: true });
const cancelledPick = cancelledPicker.api.callBackend("choose_firmware");
cancelledPicker.events.get("focus")(); cancelledPicker.runTimers();
assert.equal(await cancelledPick, null); assert.equal(cancelledPicker.attached.size, 0); assert.equal(cancelledPicker.events.has("focus"), false);
const readingPicker = setup(false);
const picked = readingPicker.api.callBackend("choose_firmware");
readingPicker.events.get("focus")(); readingPicker.runTimers();
assert.match(await picked, /fixture.bin$/); assert.equal(readingPicker.attached.size, 0);

console.log(`Backend checks passed: ${savedBackupScenarios} saved-backup scenarios (empty/missing backup, 256/512 KiB extraction, short input, header/payload corruption; no USB or auto-start), plus existing save barrier, file close, download acknowledgement, cancellation, snapshot isolation, persistence, irreversible cancel lock, interrupted reload, storage failure and file-picker regressions (synthetic data; mocked hardware).`);
