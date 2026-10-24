import test from 'node:test';
import assert from 'node:assert/strict';
import { webHidDriver } from './webhid-protocol.test-bundle.mjs';

// Models the recovered firmware: 00 passive, 05 requests pause, 06 acquires
// maintenance (returns1 if already active), 07 exits. E35B skips05 if active.
class StateMachineDevice {
  vendorId=0x345f;productId=0x2133;opened=false;
  collections=[{featureReports:[{reportId:1,items:[{reportSize:8,reportCount:264}]}]}];
  calls=[];reads=0;pauseRequests=0;paused=false;result=0;last=null;closes=0;exitAttempts=0;
  constructor(options={}){this.options=options;this.active=!!options.active;}
  async open(){this.opened=true;}
  async close(){this.closes++;this.opened=false;}
  async sendFeatureReport(id,buffer){
    assert.equal(id,1);this.last=new Uint8Array(buffer);this.calls.push(Array.from(this.last.slice(0,8)));
    const [op,sub]=this.last;if(op!==0x52)return;
    this.result=0;
    if(sub===5){this.pauseRequests++;if(!this.active)this.paused=true;if(this.options.foreignActive)this.active=true;}
    else if(sub===6){
      if(this.active||!this.paused||this.options.notReady)this.result=1;
      else this.active=true;
    }else if(sub===7){
      this.exitAttempts++;
      if(this.options.exitSetReject)throw new Error('SET07 rejected');
      if(this.options.pendingExitSet)return new Promise(()=>{});
      if(!this.options.exitStuck){this.active=false;this.paused=false;}
    }
  }
  async receiveFeatureReport(){
    const [op,sub]=this.last;let p;
    if(op===0x52&&sub===0&&this.exitAttempts&&this.options.postExitStatusReject)
      throw new Error('post-exit passive00 rejected');
    if(op===0x52)p=[0x52,1,2,this.result,1,this.active?1:0,2,240];
    else if(op===0xfd)p=[0xfd,this.options.badFactory?0:0xfd,0,0,0,0,0,0];
    else if(op===0xf4)p=[0xf4,0x5e,0x60,0x12,0,0,0,0];
    else if(op===0xf7){this.reads++;p=[0xf7,0,0,0,0,0,0,0,...new Uint8Array(256)];}
    else throw new Error('Unexpected operation '+op.toString(16));
    return new DataView(Uint8Array.from([1,...p]).buffer);
  }
}
const context=device=>({update(){},log(){},isCancelled(){return device.reads>0;}});
const controls=device=>device.calls.filter(c=>c[0]===0x52).map(c=>c[1]);

test('passive probe preserves idle and existing maintenance without06',async()=>{
  for(const active of [false,true]){
    const d=new StateMachineDevice({active});const info=await webHidDriver.probe(d);
    assert.equal(info.canReadFlash,true);assert.equal(d.active,active);
    assert.deepEqual(controls(d),[0]);assert.equal(d.pauseRequests,0);
  }
});
test('idle backup pauses before acquiring; cleanup07 then00 stays inactive',async()=>{
  const d=new StateMachineDevice();await webHidDriver.probe(d);
  await assert.rejects(webHidDriver.backup(d,context(d)),/已取消读取/);
  assert.deepEqual(controls(d),[0,0,0,5,6,7,0]);
  assert.equal(d.pauseRequests,1);assert.equal(d.reads,1);assert.equal(d.active,false);
});
test('stale active session is exited and passively confirmed before05',async()=>{
  const d=new StateMachineDevice({active:true});await webHidDriver.probe(d);
  await assert.rejects(webHidDriver.backup(d,context(d)),/已取消读取/);
  assert.deepEqual(controls(d),[0,0,0,7,0,5,6,7,0]);
  assert.equal(d.pauseRequests,1);assert.equal(d.reads,1);assert.equal(d.active,false);
});
test('already-active result1 after pause cannot bypass fresh-ready gate',async()=>{
  const d=new StateMachineDevice({foreignActive:true});await webHidDriver.probe(d);
  await assert.rejects(webHidDriver.backup(d,context(d)),/未确认本次暂停和就绪/);
  assert.equal(d.reads,0);assert.deepEqual(controls(d).slice(-2),[7,0]);assert.equal(d.active,false);
});
test('failed FD handshake still exits with passive00 and no reenter',async()=>{
  const d=new StateMachineDevice({badFactory:true});await webHidDriver.probe(d);
  await assert.rejects(webHidDriver.backup(d,context(d)),/FD FD 00/);
  assert.equal(d.reads,0);assert.deepEqual(controls(d).slice(-2),[7,0]);assert.equal(d.active,false);
});
test('exit flag remaining active is reported as cleanup failure',async()=>{
  const d=new StateMachineDevice({exitStuck:true});await webHidDriver.probe(d);
  await assert.rejects(webHidDriver.backup(d,context(d)),/退出后维护标志仍为1/);
  assert.deepEqual(controls(d).slice(-2),[7,0]);assert.equal(d.active,true);
});
test('stale session that cannot exit never receives05,06 or flash reads',async()=>{
  const d=new StateMachineDevice({active:true,exitStuck:true});await webHidDriver.probe(d);
  await assert.rejects(webHidDriver.backup(d,context(d)),/退出后维护标志仍为1/);
  assert.equal(d.pauseRequests,0);assert.equal(d.reads,0);assert.ok(!controls(d).includes(6));
  assert.deepEqual(controls(d),[0,0,0,7,0]);
});
test('not-ready deadline keeps strict gate, sends pause once and cleans up',async()=>{
  const d=new StateMachineDevice({notReady:true});await webHidDriver.probe(d);
  await assert.rejects(webHidDriver.backup(d,context(d)),/尚未停止视频/);
  assert.equal(d.pauseRequests,1);assert.equal(d.reads,0);assert.equal(d.active,false);
  assert.deepEqual(controls(d).slice(-2),[7,0]);
});
test('failed stale-session SET07 is never retried by finally',async()=>{
  const d=new StateMachineDevice({active:true,exitSetReject:true});await webHidDriver.probe(d);
  await assert.rejects(webHidDriver.backup(d,context(d)),/SET07 rejected/);
  assert.equal(d.exitAttempts,1);assert.equal(d.pauseRequests,0);assert.equal(d.reads,0);
  assert.deepEqual(controls(d),[0,0,0,7]);assert.equal(d.closes,2);
});
test('failed passive00 after stale-session exit never triggers another07',async()=>{
  const d=new StateMachineDevice({active:true,postExitStatusReject:true});await webHidDriver.probe(d);
  await assert.rejects(webHidDriver.backup(d,context(d)),/post-exit passive00 rejected/);
  assert.equal(d.exitAttempts,1);assert.equal(d.pauseRequests,0);assert.equal(d.reads,0);
  assert.deepEqual(controls(d),[0,0,0,7,0]);assert.equal(d.closes,2);
});
test('pending stale-session SET07 blocks later requests without overlapping close',async()=>{
  const d=new StateMachineDevice({active:true,pendingExitSet:true});await webHidDriver.probe(d);
  const original=globalThis.setTimeout;
  globalThis.setTimeout=(fn,ms,...args)=>original(fn,ms===3000?5:ms,...args);
  try{
    await assert.rejects(webHidDriver.backup(d,context(d)),/USB请求超过3秒/);
    assert.equal(d.exitAttempts,1);assert.equal(d.pauseRequests,0);assert.equal(d.reads,0);
    assert.deepEqual(controls(d),[0,0,0,7]);assert.equal(d.closes,1);assert.equal(d.opened,true);
    await assert.rejects(webHidDriver.backup(d,context(d)),/此前USB请求未完成/);
    assert.deepEqual(controls(d),[0,0,0,7]);assert.equal(d.closes,1);
  }finally{globalThis.setTimeout=original;}
});
