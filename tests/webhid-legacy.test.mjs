import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSyntheticContainer } from './synthetic-firmware.mjs';
import { webHidDriver } from './webhid-protocol.test-bundle.mjs';
const baseline=makeSyntheticContainer();
function candidate(){const b=baseline.slice();b[0x31]=(b[0x31]+1)&255;b[0x1234]=(b[0x1234]+2)&255;let sum=0;for(let i=0x30;i<0x18030;i++)sum+=b[i];b[0x18032]=sum>>>8&255;b[0x18033]=sum&255;return b;}
export class StockDevice {
  vendorId=0x345f;productId=0x2133;productName='stock SPI mock';opened=false;
  collections=[{usagePage:0xff00,usage:1,featureReports:[8,63,4095].map((n,i)=>({reportId:i+1,items:[{reportSize:8,reportCount:n}]})),children:[]}];
  memory=new Uint8Array(0x40000).fill(255);sfr=new Map([[0xa0,0x94],[0xb0,0x5c],[0xc7,0x22],[0xca,0xf3],[0xc8,0xc0],[0xc9,0]]);xdata=new Map([[0xf01f,0x20],[0xf58a,0],[0xfe8a,0]]);
  opcodes=new Map();last=null;bus=[];selected=false;sr=0;pageAddress=0;pages=0;erased=[];programmed=[];calls=0;pendingWrites=0;
  constructor(options={}){this.options=options;if(options.windowsFlat)this.collections=[{usagePage:0xff00,usage:1,featureReports:[{reportId:1,items:[{reportSize:8,reportCount:4095}]}],children:[]}];this.memory.set(baseline);this.memory.set([5,6,7],0x18060);this.memory.set([9,10,11],0x21000);}
  async open(){this.opened=true;}async close(){this.opened=false;}
  spiByte(value){
    assert.ok(this.selected);this.bus.push(value);const i=this.bus.length-2;
    if(this.bus[0]===0x9f&&i>=0)return (this.options.unknownFlash?[0xef,0x60,0x12]:[0x5e,0x60,0x12])[i]??255;
    if(this.bus[0]===5&&i>=0)return this.sr;
    if(this.bus[0]===0x35&&i>=0)return this.options.protected?0x40:0;
    return 255;
  }
  select(value,old){
    if(!(value&4)&&(old&4)){this.selected=true;this.bus=[];}
    if((value&4)&&!(old&4)&&this.selected){
      const b=this.bus;
      if(b[0]===6&&!this.options.noWren)this.sr|=2;
      if(b[0]===0x20){assert.equal(this.sr&3,2);const a=b[1]*65536+b[2]*256+b[3];this.erased.push(a);this.memory.fill(255,a,a+4096);this.sr=0;}
      this.selected=false;
    }
  }
  async sendFeatureReport(id,source){
    assert.equal(id,1);const d=new Uint8Array(source);assert.equal(d.length,this.options.windowsFlat?4095:8);this.last=d.subarray(0,8);this.calls++;this.opcodes.set(d[0],(this.opcodes.get(d[0])??0)+1);
    assert.ok(![0x52,0xf4,0xf8,0xfb,0xfe].includes(d[0]),'ROI/chip erase forbidden on stock');
    if(d[0]===0xb6)this.xdata.set(d[1]*256+d[2],d[3]);
    else if(d[0]===0xc6){const a=d[1],v=d[2],old=this.sfr.get(a)??0;if(a===0xa0)this.select(v,old);if(a===0xc9)this.sfr.set(a,this.spiByte(v));else this.sfr.set(a,v);}
    else if(d[0]===0xf7&&d[1]===1){this.pageAddress=d[2]*65536+d[3]*256+d[4];assert.equal(d[5],1);this.pages++;}
    else if(d[0]===0x34){const a=d[1]*65536+d[2]*256+d[3];this.programmed.push(a);if(!this.options.dropProgram)for(let i=0;i<4;i++)this.memory[a+i]&=d[4+i];if(this.options.pendingProgram){this.pendingWrites++;return new Promise(()=>{});}}
  }
  async receiveFeatureReport(){
    const d=this.last;let p;
    if(d[0]===0xb5)p=[0xb5,d[1],d[2],this.xdata.get(d[1]*256+d[2])??0,0,0,0,0];
    else if(d[0]===0xc5)p=[0xc5,d[1],this.sfr.get(d[1])??0,0,0,0,0,0];
    else if(d[0]===0xfd)p=[0xfd,0xfd,0,0,0,0,0,0];
    else if(d[0]===0xf7&&d[1]===0)p=this.memory.slice(this.pageAddress+d[6],this.pageAddress+d[6]+8);
    else throw new Error('bad GET '+d[0]);
    let withId=!this.options.noReportId;
    if(this.options.inconsistentEnvelope&&d[0]===0xc5)withId=!withId;
    const raw=Uint8Array.from(withId?[1,...p]:p);
    const length=this.options.maxResponses??(this.options.paddedChunks&&d[0]===0xf7?this.options.paddedChunks:(this.options.windowsFlat?4096:raw.length));
    const offset=this.options.viewOffset??0;
    const padded=new Uint8Array(length+offset).fill(0xa5);padded.set(raw,offset);
    return new DataView(padded.buffer,offset,length);
  }
  restored(){assert.equal(this.xdata.get(0xf01f),0x20);for(const [a,v]of [[0xa0,0x94],[0xb0,0x5c],[0xc7,0x22],[0xca,0xf3]])assert.equal(this.sfr.get(a),v);}
}
export function context(d){const updates=[],backups=[],logs=[];return {operationMode:'flash',updates,backups,logs,update(v){updates.push(v);},log(message){logs.push(message);},isCancelled(){return false;},async saveBackup(b){assert.equal(d.erased.length,0);backups.push(b.slice());}};}
test('precise stock descriptor probes B5/C5 only, and ROM is enumerated without guesses',async()=>{
  const d=new StockDevice();const p=await webHidDriver.probe(d);assert.equal(p.canReadFlash,true);assert.equal(p.canWriteFlash,true);assert.equal(p.firmwareType,'stock');assert.equal(p.featureReportLength,9);assert.deepEqual([...d.opcodes.keys()],[0xb5,0xc5]);
  const rom=new StockDevice();rom.productId=1;const r=await webHidDriver.probe(rom);assert.equal(r.firmwareType,'rom');assert.equal(r.canWriteFlash,false);assert.equal(rom.calls,0);assert.match(r.detail,/ROM/);
});
test('Windows descriptor variant with ID-inclusive large reports remains stock SPI',async()=>{
  const d=new StockDevice();
  d.collections[0].featureReports[1].items[0].reportCount=64;
  d.collections[0].featureReports[2].items[0].reportCount=4096;
  const info=await webHidDriver.probe(d);
  assert.equal(info.canReadFlash,true);assert.equal(info.canWriteFlash,true);
  assert.deepEqual([...d.opcodes.keys()],[0xb5,0xc5]);
});
test('Windows USB3 Video flattened descriptor pads legacy commands and remains stock SPI',async()=>{
  const d=new StockDevice({windowsFlat:true});d.productName='USB3 Video';
  const info=await webHidDriver.probe(d);
  assert.equal(info.canReadFlash,true);assert.equal(info.canWriteFlash,true);assert.equal(info.featureReportLength,4096);
  assert.deepEqual(await webHidDriver.backup(d,context(d)),d.memory);d.restored();
});
test('Windows USB3 Video may return a padded 4097-byte Feature report',async()=>{
  const d=new StockDevice({paddedChunks:4097});d.productName='USB3 Video';
  const info=await webHidDriver.probe(d);assert.equal(info.canReadFlash,true);assert.equal(info.canWriteFlash,true);
  assert.deepEqual(await webHidDriver.backup(d,context(d)),d.memory);d.restored();
});
test('stock full backup uses correct F7 raw chunks twice and restores every saved SPI register',async()=>{
  const d=new StockDevice();const before=d.memory.slice();await webHidDriver.probe(d);const b=await webHidDriver.backup(d,context(d));assert.deepEqual(b,before);assert.equal(d.pages,2048);d.restored();assert.equal(d.erased.length,0);assert.equal(d.programmed.length,0);
});
test('stock flash uses SPI20 and opcode34, preserves tail, validates complete readback, restores SPI config',async()=>{
  const d=new StockDevice();const before=d.memory.slice();const c=context(d);await webHidDriver.probe(d);const b=candidate();assert.deepEqual(await webHidDriver.flash(d,b,c),{verified:true});assert.equal(c.backups.length,1);assert.deepEqual(c.backups[0],before);assert.deepEqual(d.erased,[0x1000,0x18000,0]);assert.ok(d.programmed.every(a=>a%4===0&&a<0x19000));assert.deepEqual(d.memory.subarray(0,b.length),b);assert.deepEqual(d.memory.subarray(b.length),before.subarray(b.length));d.restored();
});
test('stock direct flash verifies written Flash without creating a backup',async()=>{
  const d=new StockDevice();const c=context(d);c.directImageWrite=true;await webHidDriver.probe(d);const b=candidate();c.referenceImage=d.memory.slice();
  assert.deepEqual(await webHidDriver.flash(d,b,c),{verified:true});
  assert.equal(c.backups.length,0); assert.ok(d.pages>0); assert.deepEqual(d.erased,[0x1000,0x18000,0]); assert.deepEqual(d.memory.subarray(0,b.length),b); d.restored();
});
test('stock direct flash rejects a dropped page instead of claiming completion',async()=>{
  const d=new StockDevice({dropProgram:true});const c=context(d);c.directImageWrite=true;c.referenceImage=d.memory.slice();await webHidDriver.probe(d);
  await assert.rejects(webHidDriver.flash(d,candidate(),c),/直写扇区回读校验失败/);
  assert.equal(c.backups.length,0);d.restored();
});
test('stock unknown JEDEC and protection restore prior config without erase/program',async()=>{
  for(const opt of [{unknownFlash:true},{protected:true}]){const d=new StockDevice(opt);await webHidDriver.probe(d);await assert.rejects(webHidDriver.backup(d,context(d)),/Flash容量|受到保护/);d.restored();assert.equal(d.erased.length,0);assert.equal(d.programmed.length,0);}
});
test('stock active video rejects before any configuration mutation',async()=>{
  const d=new StockDevice();d.xdata.set(0xf58a,4);await webHidDriver.probe(d);await assert.rejects(webHidDriver.backup(d,context(d)),/视频端点正在采集/);assert.equal(d.opcodes.get(0xb6),undefined);assert.equal(d.opcodes.get(0xc6),undefined);
});
test('stock write-enable failure sends no SPI20 or opcode34 and restores config',async()=>{
  const d=new StockDevice({noWren:true});await webHidDriver.probe(d);await assert.rejects(webHidDriver.flash(d,candidate(),context(d)),/WREN未生效/);assert.equal(d.erased.length,0);assert.equal(d.programmed.length,0);d.restored();
});
test('stock sector mismatch halts before header and does not blind-restore',async()=>{
  const d=new StockDevice({dropProgram:true});await webHidDriver.probe(d);await assert.rejects(webHidDriver.flash(d,candidate(),context(d)),/扇区回读校验失败/);assert.deepEqual(d.erased,[0x1000]);d.restored();
});
test('pending stock program is not retried and no cleanup races its uncompleted OS request',async()=>{
  const d=new StockDevice({pendingProgram:true});await webHidDriver.probe(d);const timer=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...a)=>timer(fn,ms===3000?5:ms,...a);
  try{await assert.rejects(webHidDriver.flash(d,candidate(),context(d)),/USB请求超过3秒/);assert.equal(d.pendingWrites,1);assert.equal(d.last[0],0x34);assert.equal(d.opened,true);}finally{globalThis.setTimeout=timer;}
});


test('unexpected padded stock Flash reply reports raw length and exact view prefix, never truncates or retries',async()=>{
  const d=new StockDevice({paddedChunks:4097,viewOffset:3});await webHidDriver.probe(d);
  const prefix=Array.from(Uint8Array.from([1,...d.memory.subarray(0,8),...new Uint8Array(7).fill(0xa5)]),b=>b.toString(16).padStart(2,'0')).join(' ');
  await assert.rejects(webHidDriver.backup(d,context(d)),error=>{
    assert.match(error.message,/rawLength=4097/);assert.match(error.message,/viewOffset=3/);assert.match(error.message,/reportId=1/);assert.match(error.message,/page=0x0，chunkOffset=0x0/);assert.ok(error.message.includes('prefix16='+prefix));assert.match(error.message,/未猜测或重试/);return true;
  });
  assert.equal(d.pages,1);assert.equal(d.opcodes.get(0xf7),2);assert.equal(d.erased.length,0);assert.equal(d.programmed.length,0);d.restored();
});


test('stock4096 report with confirmed ID and nonzero RAM tail uses only8 logical Flash bytes',async()=>{
  const d=new StockDevice({maxResponses:4096,viewOffset:5});const before=d.memory.slice();const info=await webHidDriver.probe(d);assert.equal(info.canReadFlash,true);const c=context(d);
  assert.deepEqual(await webHidDriver.backup(d,c),before);d.restored();const log=c.logs.filter(v=>v.includes('首个合法原厂F7分块'));assert.equal(log.length,1);assert.match(log[0],/rawLength=4096/);assert.match(log[0],/viewOffset=5/);assert.match(log[0],/envelope=report-id\+data/);assert.match(log[0],/a5 a5/);assert.equal(d.erased.length,0);
});
test('stock4095 data-only report preserves Flash first byte01 using probe-established envelope',async()=>{
  const d=new StockDevice({maxResponses:4095,noReportId:true,viewOffset:7});d.memory[0]=1;const before=d.memory.slice();assert.equal((await webHidDriver.probe(d)).canReadFlash,true);const c=context(d);
  const backup=await webHidDriver.backup(d,c);assert.deepEqual(backup,before);assert.equal(backup[0],1);d.restored();const log=c.logs.filter(v=>v.includes('首个合法原厂F7分块'));assert.equal(log.length,1);assert.match(log[0],/rawLength=4095/);assert.match(log[0],/viewOffset=7/);assert.match(log[0],/envelope=data-only/);assert.match(log[0],/prefix16=01/);
});
test('canonical8 data-only stock response does not strip Flash byte01',async()=>{
  const d=new StockDevice({noReportId:true});d.memory[0]=1;const before=d.memory.slice();assert.equal((await webHidDriver.probe(d)).canReadFlash,true);assert.deepEqual(await webHidDriver.backup(d,context(d)),before);d.restored();
});
test('inconsistent B5 and C5 probe envelopes stop before any Flash request',async()=>{
  const d=new StockDevice({inconsistentEnvelope:true});const info=await webHidDriver.probe(d);assert.equal(info.canReadFlash,false);assert.equal(info.canWriteFlash,false);assert.match(info.detail,/封装前后不一致/);assert.equal(d.opcodes.get(0xf7),undefined);
});
