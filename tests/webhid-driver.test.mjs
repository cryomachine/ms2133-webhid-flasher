import test from 'node:test';
import assert from 'node:assert/strict';
import { webHidDriver, normalizeFeatureReply } from './webhid-protocol.test-bundle.mjs';

class MockDevice {
  vendorId = 0x345f; productId = 0x2133; productName = 'MS2133 mock'; opened = false;
  collections = [{ usagePage: 0xff00, usage: 1, featureReports: [{ reportId: 1, items: [{ reportSize: 8, reportCount: 264 }] }], children: [] }];
  calls = []; last = null; reads = 0; busy = false; active = false; result = 0; stops = 0; closes = 0;
  constructor(options = {}) { this.options = options; }
  async open() { this.opened = true; }
  async close() { this.opened = false; this.closes++; }
  async sendFeatureReport(id, source) {
    assert.equal(id, 1);
    const data = new Uint8Array(source);
    this.last = data;
    this.calls.push({ length: data.length, data: Array.from(data.slice(0, 8)) });
    if (this.options.pending) return new Promise(() => {});
    if (this.options.allFail || this.options.shortOnly && data.length > 8) throw new Error('mock SET timeout');
    if (this.options.registerOnly && data[0] !== 0xb5) throw new Error('unsupported cap');
    if (data[0] === 0x52 && data[1] === 5) { this.busy = false; this.stops++; }
    if (data[0] === 0x52) {
      this.result = 0;
      if (data[1] === 6) {
        if (this.active || this.busy) this.result = 1;
        else this.active = true;
      } else if (data[1] === 7) this.active = false;
    }
  }
  async receiveFeatureReport(id) {
    assert.equal(id, 1);
    const c = this.last;
    let result;
    if (c[0] === 0x52) result = [1,0x52,1,2,this.result,1,this.active ? 1 : 0,0,0];
    else if (c[0] === 0xb5) result = [1,0xb5,0xf0,0x1f,0x33,0,0,0,0];
    else if (c[0] === 0xfd) result = [1,0xfd,0xfd,0,0,0,0,0,0];
    else if (c[0] === 0xf4) result = [1,0xf4,this.options.unknownFlash ? 0xef : 0x5e,0x60,0x12,0,0,0,0];
    else if (c[0] === 0xf7) {
      const address = c[1] * 65536 + c[2] * 256 + c[3];
      const page = Array.from({ length: 256 }, (_, i) => (address / 256 + i) & 255);
      if (this.options.mismatch && this.reads >= 1024) page[20] ^= 1;
      this.reads++;
      result = [1,0xf7,0,0,0,0,0,0,0,...page];
    } else throw new Error('Unexpected read');
    const bytes = Uint8Array.from(result);
    return new DataView(bytes.buffer);
  }
}
function context(cancelAfterFirstPage = false) {
  const updates = [], logs = [];
  return {
    updates, logs,
    update(value) { updates.push(value); },
    log(message, level) { logs.push({ message, level }); },
    isCancelled() { return cancelAfterFirstPage && updates.some(update => update.phase === '读取Flash'); },
  };
}

test('module registers real driver and normalize respects DataView offsets', () => {
  assert.equal(globalThis.__ms2133RegisteredDriver, webHidDriver);
  const bytes = Uint8Array.from([99,1,0x52,1,2,0,1,0,0,0,99]);
  assert.equal(normalizeFeatureReply(new DataView(bytes.buffer, 1, 9), 0x52)[4], 1);
});

test('Windows PID variants are accepted only after the same descriptor and protocol probe', async () => {
  const device = new MockDevice();
  device.productId = 0x0000;
  const info = await webHidDriver.probe(device);
  assert.equal(info.status, 'reachable');
  assert.equal(info.canReadFlash, true);
  assert.deepEqual(device.calls.map(call => call.data.slice(0, 2)), [[0x52, 0]]);
});

test('a different vendor is rejected without opening or sending commands', async () => {
  const device = new MockDevice();
  device.vendorId = 0x1234;
  const info = await webHidDriver.probe(device);
  assert.equal(info.status, 'error');
  assert.equal(info.canReadFlash, false);
  assert.equal(device.calls.length, 0);
  assert.equal(device.opened, false);
});

test('read-only probe sends no stop, factory, erase, or program commands', async () => {
  const device = new MockDevice(); device.busy = true;
  const info = await webHidDriver.probe(device);
  assert.equal(info.canReadFlash, true);
  assert.equal(info.canWriteFlash, true);
  assert.equal(info.status, 'reachable');
  assert.deepEqual(device.calls.map(call => call.data.slice(0,2)), [[0x52,0]]);
  assert.equal(device.opened, false);
});

test('rejected extended SET falls back to short probe without enabling Flash', async () => {
  const device = new MockDevice({ shortOnly: true });
  const info = await webHidDriver.probe(device);
  assert.equal(info.status, 'reachable');
  assert.equal(info.canReadFlash, false);
  assert.equal(info.canWriteFlash, false);
  assert.deepEqual(device.calls.map(call => call.length), [264,8]);
  await assert.rejects(webHidDriver.backup(device, context()), /未通过可读写协议/);
});

test('unsupported capabilities never fall back to legacy register commands', async () => {
  const device = new MockDevice({ registerOnly: true });
  const info = await webHidDriver.probe(device);
  assert.equal(info.status, 'error');
  assert.equal(info.canReadFlash, false);
  assert.equal(info.canWriteFlash, false);
  assert.equal(device.calls.length, 2);
  assert.ok(device.calls.every(call => call.data[0] === 0x52));
});

test('enumerated but nonresponding device exposes no Flash capabilities', async () => {
  const device = new MockDevice({ allFail: true });
  const info = await webHidDriver.probe(device);
  assert.equal(info.status, 'error');
  assert.equal(info.canReadFlash, false);
  assert.equal(info.canWriteFlash, false);
  assert.equal(device.calls.length, 2);
});

test('backup pauses explicitly, reads entire known chip twice, then ends session', async () => {
  const device = new MockDevice();
  await webHidDriver.probe(device);
  device.busy = true;
  const ctx = context();
  const result = await webHidDriver.backup(device, ctx);
  assert.equal(result.length, 0x40000);
  assert.equal(device.reads, 2048);
  assert.equal(device.stops, 1);
  assert.deepEqual(Array.from(result.slice(0, 3)), [0,1,2]);
  assert.deepEqual(Array.from(result.slice(256, 259)), [1,2,3]);
  assert.deepEqual(device.calls.slice(-2).map(call => call.data.slice(0,2)), [[0x52,7],[0x52,0]]);
  assert.equal(device.active, false);
  assert.ok(device.calls.every(call => ![0xf8,0xfb,0xfe,0xb6,0xc6].includes(call.data[0])));
  assert.match(ctx.logs.find(entry => entry.level === 'success').message, /双遍读取一致/);
});

test('second-pass mismatch rejects backup and still ends session', async () => {
  const device = new MockDevice({ mismatch: true });
  await webHidDriver.probe(device);
  await assert.rejects(webHidDriver.backup(device, context()), /首个差异页0x0/);
  assert.equal(device.reads, 1025);
  assert.deepEqual(device.calls.slice(-2).map(call => call.data.slice(0,2)), [[0x52,7],[0x52,0]]);
});

test('unknown JEDEC prevents reads and still ends session', async () => {
  const device = new MockDevice({ unknownFlash: true });
  await webHidDriver.probe(device);
  await assert.rejects(webHidDriver.backup(device, context()), /未确认此Flash容量/);
  assert.equal(device.reads, 0);
  assert.deepEqual(device.calls.slice(-2).map(call => call.data.slice(0,2)), [[0x52,7],[0x52,0]]);
});

test('cancellation is observed between pages and session cleanup is sent', async () => {
  const device = new MockDevice();
  await webHidDriver.probe(device);
  await assert.rejects(webHidDriver.backup(device, context(true)), /已取消读取/);
  assert.equal(device.reads, 1);
  assert.deepEqual(device.calls.slice(-2).map(call => call.data.slice(0,2)), [[0x52,7],[0x52,0]]);
});

test('flash rejects without issuing any transport calls', async () => {
  const device = new MockDevice();
  await assert.rejects(webHidDriver.flash(device, new Uint8Array(1), context()), /固件必须/);
  assert.equal(device.calls.length, 0);
});

test('unsettled request does not race with fallback or close', async () => {
  const device = new MockDevice({ pending: true });
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms === 3000 ? 5 : ms, ...args);
  try {
    const info = await webHidDriver.probe(device);
    assert.equal(info.status, 'error');
    assert.equal(info.canReadFlash, false);
    assert.equal(device.calls.length, 1);
    assert.equal(device.closes, 0);
    await webHidDriver.probe(device);
    assert.equal(device.calls.length, 1);
  } finally { globalThis.setTimeout = original; }
});


test('an interface without report ID 1 receives no requests', async () => {
  const device = new MockDevice();
  device.collections[0].featureReports[0].reportId = 2;
  const info = await webHidDriver.probe(device);
  assert.equal(info.status, 'error');
  assert.equal(info.canReadFlash, false);
  assert.equal(device.calls.length, 0);
});

test('a failed close does not leave UI claiming a read-capable link', async () => {
  const device = new MockDevice();
  device.close = async () => { throw new Error('mock close failed'); };
  const info = await webHidDriver.probe(device);
  assert.equal(info.status, 'error');
  assert.equal(info.canReadFlash, false);
  assert.match(info.detail, /mock close failed/);
  await assert.rejects(webHidDriver.backup(device, context()), /未通过可读写协议/);
});


test('stock or unknown report sizes are not probed with ROI commands', async () => {
  for (const reportCount of [8,64,263,265,4095,4096]) {
    const device = new MockDevice();
    device.collections[0].featureReports[0].items[0].reportCount = reportCount;
    const info = await webHidDriver.probe(device);
    assert.equal(info.status, 'enumerated');
    assert.equal(info.canReadFlash, false);
    assert.equal(info.canWriteFlash, false);
    assert.equal(info.featureReportLength, reportCount + 1);
    assert.equal(device.calls.length, 0);
    assert.equal(device.opened, false);
    assert.equal(device.closes, 0);
  }
});
