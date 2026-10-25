import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSyntheticContainer, makeSyntheticFlash, fixContainerChecksums as fixSum } from './synthetic-firmware.mjs';
import { webHidDriver, validateFirmwareContainer } from './webhid-protocol.test-bundle.mjs';
const baseline = makeSyntheticContainer();
const fullFlash = makeSyntheticFlash();
const modified = () => {const b=baseline.slice();b[0x31]^=1;b[0x1234]^=1;b.fill(255,0x2000,0x3000);return fixSum(b);};
class FlashDevice {
  vendorId=0x345f;productId=0x2133;productName='transaction mock';opened=false;
  collections=[{usagePage:0xff00,usage:1,featureReports:[{reportId:1,items:[{reportSize:8,reportCount:264}]}],children:[]}];
  calls=[];eraseAddresses=[];programAddresses=[];readCount=0;memory=new Uint8Array(0x40000).fill(255);last=null;active=false;result=0;
  constructor(options={}) {this.options=options;if(options.memory){this.memory=options.memory.slice();}else{this.memory.set(baseline);this.memory.set([7,8,9],0x18050);this.memory.set([1,2,3],0x20000);}}
  async open(){this.opened=true;}
  async close(){this.opened=false;}
  async sendFeatureReport(id,buffer){
    assert.equal(id,1);const d=new Uint8Array(buffer);this.last=d;this.calls.push(d.slice());
    if(d[0]===0x52){this.result=0;if(d[1]===6){if(this.active)this.result=1;else this.active=true;}else if(d[1]===7)this.active=false;}
    if(d[0]===0xfb){this.eraseAddresses.push(d[1]*65536+d[2]*256+d[3]);this.memory.fill(255,this.eraseAddresses.at(-1),this.eraseAddresses.at(-1)+4096);}
    if(d[0]===0xf8){const a=d[1]*65536+d[2]*256+d[3];this.programAddresses.push(a);for(let i=0;i<256;i++)this.memory[a+i]&=d[8+i];}
  }
  async receiveFeatureReport(){
    const d=this.last;let p;
    if(d[0]===0x52)p=[0x52,1,2,this.result,1,this.active?1:0,0,0];
    else if(d[0]===0xfd)p=[0xfd,0xfd,0,0,0,0,0,0];
    else if(d[0]===0xf4)p=[0xf4,0x5e,0x60,this.memory.length===0x80000?0x13:0x12,0,0,0,0];
    else if(d[0]===0xfb)p=[0xfb,this.options.badEraseAck?1:0,0,0,0,0,0,0];
    else if(d[0]===0xf8)p=[0xf8,0,0,0,0,0,0,0];
    else if(d[0]===0xf7){
      const a=d[1]*65536+d[2]*256+d[3];let page=this.memory.slice(a,a+256);
      if(this.options.badReadback&&this.programAddresses.length&&a===0x1000)page[0]^=1;
      p=[0xf7,0,0,0,0,0,0,0,...page];this.readCount++;
    } else throw new Error('unknown '+d[0]);
    const raw=Uint8Array.from([1,...p]);return new DataView(raw.buffer);
  }
}
function ctx(device,options={}){
  const updates=[],backups=[],logs=[];
  return {operationMode:options.mode??'flash',updates,backups,logs,
    update(v){updates.push(v);},log(v,l){logs.push({v,l});},
    isCancelled(){return options.cancelAfterErase?device.eraseAddresses.length>0:!!options.cancel;},
    async saveBackup(data,name){assert.equal(device.eraseAddresses.length,0);backups.push(data.slice());if(options.saveFailure)throw new Error('save failed');if(options.mutateAfterSave)device.memory[0x1400]^=1;},
  };
}
async function run(device,context,image=modified()){await webHidDriver.probe(device);return webHidDriver.flash(device,image,context);}

test('synthetic container validates and checks both sums/family/length',()=>{
  validateFirmwareContainer(baseline);
  for(const offset of [0,8,0x30,0x18030,0x18032]){const b=baseline.slice();b[offset]^=1;assert.throws(()=>validateFirmwareContainer(b));}
  assert.throws(()=>validateFirmwareContainer(baseline.subarray(0,50)));
});
test('extended flash saves full backup, writes changed sectors/header last, skips FF, preserves tail and verifies',async()=>{
  const d=new FlashDevice();const before=d.memory.slice();const c=ctx(d);const image=modified();
  assert.deepEqual(await run(d,c,image),{verified:true});assert.equal(c.backups.length,1);assert.deepEqual(c.backups[0],before);
  assert.deepEqual(d.eraseAddresses,[0x1000,0x2000,0x18000,0]);assert.ok(!d.programAddresses.some(a=>a>=0x2000&&a<0x3000));
  assert.deepEqual(d.memory.subarray(0,image.length),image);assert.deepEqual(d.memory.subarray(image.length),before.subarray(image.length));
  const marker=c.updates.findIndex(u=>u.destructiveStarted);assert.ok(marker>=0);assert.ok(c.updates.slice(marker).every(u=>u.cancellable===false));
  assert.deepEqual(d.calls.slice(-2).map(c=>Array.from(c.subarray(0,2))),[[0x52,7],[0x52,0]]);
  assert.equal(d.active,false);
});
test('direct image write on extended interface verifies Flash without backup',async()=>{
  const d=new FlashDevice(); const c=ctx(d); c.directImageWrite=true;
  await webHidDriver.probe(d);
  assert.deepEqual(await webHidDriver.flash(d,baseline,c),{verified:true});
  assert.equal(c.backups.length,0); assert.ok(d.readCount>0); assert.deepEqual(d.memory.subarray(0,baseline.length),baseline);
});
test('saving backup is a hard barrier and save rejection causes no erase',async()=>{
  const d=new FlashDevice();await assert.rejects(run(d,ctx(d,{saveFailure:true})),/save failed/);assert.equal(d.eraseAddresses.length,0);
});
test('post-save preflight catches changed flash before erase',async()=>{
  const d=new FlashDevice();await assert.rejects(run(d,ctx(d,{mutateAfterSave:true})),/发生变化/);assert.equal(d.eraseAddresses.length,0);
});
test('cancellation is ignored only after first erase and cannot interrupt write transaction',async()=>{
  const d=new FlashDevice();assert.deepEqual(await run(d,ctx(d,{cancelAfterErase:true})),{verified:true});assert.equal(d.eraseAddresses.at(-1),0);
});
test('cancellation before reading causes no destructive request',async()=>{
  const d=new FlashDevice();await assert.rejects(run(d,ctx(d,{cancel:true})),/已取消/);assert.equal(d.eraseAddresses.length,0);
});
test('bad erase ACK stops without program or retry and reports unfinished write',async()=>{
  const d=new FlashDevice({badEraseAck:true});await assert.rejects(run(d,ctx(d)),/固件写入未完成/);assert.equal(d.eraseAddresses.length,1);assert.equal(d.programAddresses.length,0);
});
test('failed sector readback stops before header sector and never blind-restores',async()=>{
  const d=new FlashDevice({badReadback:true});await assert.rejects(run(d,ctx(d)),/扇区回读校验失败/);assert.deepEqual(d.eraseAddresses,[0x1000]);
});
test('builtin restore rejects unknown source while explicit file accepts valid target',async()=>{
  const d=new FlashDevice();d.memory[0x50]^=1;const c=ctx(d,{mode:'restore-builtin'});await assert.rejects(run(d,c),/内置恢复未开放/);assert.equal(d.eraseAddresses.length,0);assert.equal(d.programAddresses.length,0);assert.equal(c.backups.length,0);
  assert.deepEqual(await webHidDriver.flash(d,modified(),ctx(d,{mode:'restore-file'})),{verified:true});
});
test('identical image still requires saved backup but avoids all erase/program',async()=>{
  const d=new FlashDevice();const c=ctx(d,{mode:'restore-file'});assert.deepEqual(await run(d,c,baseline),{verified:true});assert.equal(c.backups.length,1);assert.equal(d.eraseAddresses.length,0);
});
test('invalid candidate is rejected before opening or any USB command',async()=>{
  const d=new FlashDevice();await assert.rejects(webHidDriver.flash(d,new Uint8Array(1),ctx(d)),/固件必须/);assert.equal(d.calls.length,0);
});


test('explicit recovery repairs interrupted synthetic512KiB image and preserves its entire tail',async()=>{
  const d=new FlashDevice({memory:fullFlash});d.memory[0x40]^=1;const before=d.memory.slice();const c=ctx(d,{mode:'restore-file'});
  assert.deepEqual(await run(d,c,baseline),{verified:true});assert.equal(c.backups[0].length,0x80000);assert.deepEqual(c.backups[0],before);
  assert.deepEqual(d.memory.subarray(0,baseline.length),baseline);assert.deepEqual(d.memory.subarray(baseline.length),before.subarray(baseline.length));
  assert.equal(d.eraseAddresses.at(-1),0);assert.ok(d.programAddresses.every(a=>a<0x19000));
});
test('builtin fails closed for unknown synthetic512KiB image; explicit recovery preserves altered tail',async()=>{
  const d=new FlashDevice({memory:fullFlash});d.memory[0x40]^=1;d.memory[0x21000]^=1;const c=ctx(d,{mode:'restore-builtin'});
  await assert.rejects(run(d,c,baseline),/内置恢复未开放/);assert.equal(d.eraseAddresses.length,0);assert.equal(d.programAddresses.length,0);assert.equal(c.backups.length,0);
  assert.deepEqual(await webHidDriver.flash(d,baseline,ctx(d,{mode:'restore-file'})),{verified:true});assert.equal(d.memory[0x21000],fullFlash[0x21000]^1);
});
