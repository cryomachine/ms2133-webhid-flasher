import test from 'node:test';
import assert from 'node:assert/strict';
import { StockDevice, context } from './webhid-legacy.test.mjs';
import { webHidDriver } from './webhid-protocol.test-bundle.mjs';

class BulkDevice extends StockDevice {
  bulkReads = [];
  async sendFeatureReport(id, source) {
    const d = new Uint8Array(source);
    if (d[0] === 0xe7) {
      if (this.options.rejectBulk) throw new Error('mock E7 unsupported');
      const address = d[1] * 0x1000000 + d[2] * 65536 + d[3] * 256 + d[4];
      assert.equal(d[5] * 256 + d[6], 4095);
      assert.equal(d[7], 0);
      assert.equal(address % 4096, 0);
      assert.ok(address >= 0 && address + 4096 <= this.memory.length);
      this.bulkAddress = address;
    }
    return super.sendFeatureReport(id, source);
  }
  async receiveFeatureReport(id) {
    if (id !== 3) return super.receiveFeatureReport();
    assert.equal(this.last[0], 0xe7);
    this.bulkReads.push(this.bulkAddress);
    if (this.options.pendingBulk) return new Promise(()=>{});
    if (this.options.changeSecondPass && this.bulkReads.length === this.memory.length / 4096 + 1)
      this.memory[20] ^= 1;
    const data = this.memory.slice(this.bulkAddress, this.bulkAddress + 4095);
    const withId = !this.options.noReportId;
    const normal = Uint8Array.from(withId ? [3, ...data] : data);
    const padding = this.options.viewOffset ?? 0;
    const length = this.options.badBulkLength ?? normal.length;
    const bytes = new Uint8Array(padding + length).fill(0xa5);
    bytes.set(normal.subarray(0, length), padding);
    if (this.options.badBulkId) bytes[padding] = 2;
    if (this.options.changeTail) this.memory[this.bulkAddress + 4090] ^= 1;
    return new DataView(bytes.buffer, padding, length);
  }
}

test('bulk full backup reads each4095-byte sector twice, uses stock tail framing, preserves final Flash byte', async () => {
  const d = new BulkDevice({maxResponses:4096, viewOffset:5});
  d.memory[d.memory.length - 1] = 0x67;
  const before = d.memory.slice(), c = context(d);
  await webHidDriver.probe(d);
  assert.deepEqual(await webHidDriver.backup(d,c), before);
  const addresses = Array.from({length:d.memory.length / 4096}, (_,i) => i * 4096);
  assert.deepEqual(d.bulkReads, [...addresses, ...addresses]);
  assert.equal(d.pages, addresses.length * 2);
  assert.equal(d.opcodes.get(0xf7), addresses.length * 4);
  assert.equal(c.logs.filter(s => s.includes('E7/ID3批读已核对')).length, 1);
  const measured=c.updates.filter(v=>v.readTotalBytes).at(-1);
  assert.equal(measured.readBytes,before.length*2);assert.equal(measured.readTotalBytes,before.length*2);assert.ok(measured.readBytesPerSecond>0);
  d.restored(); assert.equal(d.erased.length,0); assert.equal(d.programmed.length,0);
});
test('bulk data-only reply preserves leading03 instead of guessing an ID', async () => {
  const d = new BulkDevice({noReportId:true,maxResponses:4095,viewOffset:7});
  d.memory[0]=3; const before=d.memory.slice(); await webHidDriver.probe(d);
  assert.deepEqual(await webHidDriver.backup(d,context(d)),before); d.restored();
});
test('completed E7 rejection falls back once per session to checked F7 without writes', async () => {
  const d = new BulkDevice({rejectBulk:true}); const before=d.memory.slice(),c=context(d);
  await webHidDriver.probe(d); assert.deepEqual(await webHidDriver.backup(d,c),before);
  assert.equal(c.logs.filter(s=>s.includes('改用F7')).length,1); assert.equal(d.bulkReads.length,0);
  assert.equal(d.pages,2048); d.restored(); assert.equal(d.erased.length,0);
});
test('bad bulk length or reportID stops without silently falling back', async () => {
  for (const options of [{badBulkLength:4097},{badBulkId:true}]) {
    const d = new BulkDevice(options); await webHidDriver.probe(d);
    await assert.rejects(webHidDriver.backup(d,context(d)),/E7\/ID3响应与已确认封装不符/);
    assert.equal(d.bulkReads.length,1); assert.equal(d.pages,0); d.restored(); assert.equal(d.erased.length,0);
  }
});
test('E7 and F7 overlap mismatch stops instead of returning mixed bytes', async () => {
  const d = new BulkDevice({changeTail:true}); await webHidDriver.probe(d);
  await assert.rejects(webHidDriver.backup(d,context(d)),/交叠校验失败/);
  assert.equal(d.bulkReads.length,1); d.restored(); assert.equal(d.erased.length,0);
});
test('bulk second pass always rereads device and detects changed Flash', async () => {
  const d = new BulkDevice({changeSecondPass:true}); await webHidDriver.probe(d);
  await assert.rejects(webHidDriver.backup(d,context(d)),/两遍读取不一致/);
  assert.equal(d.bulkReads.length,d.memory.length / 4096+1); d.restored();
});
test('bulk write precheck rereads after backup save barrier instead of reusing old bytes', async () => {
  const d=new BulkDevice(), c=context(d), image=d.memory.slice(0,0x18034);
  c.saveBackup=async()=>{d.memory[0x2000]^=1;}; await webHidDriver.probe(d);
  await assert.rejects(webHidDriver.flash(d,image,c),/保存备份后设备内容发生变化/);
  assert.equal(d.erased.length,0); assert.equal(d.programmed.length,0); d.restored();
});
test('pending bulk GET is not retried, does not fall back and does not race cleanup', async()=>{
  const d=new BulkDevice({pendingBulk:true});await webHidDriver.probe(d);
  const timer=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>timer(fn,ms===3000?5:ms,...args);
  try{await assert.rejects(webHidDriver.backup(d,context(d)),/USB请求超过3秒/);assert.equal(d.bulkReads.length,1);assert.equal(d.opcodes.get(0xe7),1);assert.equal(d.pages,0);assert.equal(d.last[0],0xe7);assert.equal(d.opened,true);}
  finally{globalThis.setTimeout=timer;}
});
test('bulk cancellation after completed GET stops before tail and restores configuration',async()=>{
  const d=new BulkDevice(),c=context(d);c.isCancelled=()=>d.bulkReads.length>0;await webHidDriver.probe(d);
  await assert.rejects(webHidDriver.backup(d,c),/已取消读取/);assert.equal(d.pages,0);assert.equal(d.erased.length,0);d.restored();
});
test('bulk sector verification rereads programmed device and rejects a dropped write',async()=>{
  const d=new BulkDevice({dropProgram:true}),c=context(d),image=d.memory.slice(0,0x18034);image[0x1234]^=1;
  let sum=0;for(let i=0x30;i<0x18030;i++)sum+=image[i];image[0x18032]=sum>>>8&255;image[0x18033]=sum&255;
  await webHidDriver.probe(d);await assert.rejects(webHidDriver.flash(d,image,c),/扇区回读校验失败/);assert.deepEqual(d.erased,[0x1000]);d.restored();
});
