import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setup,candidate,result,pair } from './helpers.js'
import { ApiError } from '../src/exchanges/http.js'
import { UnknownOrder,Engine } from '../src/engine.js'
import { Store } from '../src/store.js'
test('首腿零成交：币安绝不下单',async()=>{
 const {a,b,e,store}=setup();a.onPlace=async r=>result(r,0,'EXPIRED')
 await e.execute(candidate());assert.equal(b.calls.length,0);assert.equal(store.trades()[0].status,'NO_FILL');store.close()
})
test('首腿成交即对冲，不等成交明细',async()=>{
 const {a,b,e,store}=setup()
 b.onPlace=async r=>{assert.equal(store.position('aster','TESTUSDT').qty,10);assert.equal(a.queries,0);return result(r)}
 await e.execute(candidate());assert.equal(b.calls[0].kind,'MARKET');assert.equal(b.calls[0].qty,'10');assert.equal(store.position('binance','TESTUSDT').qty,-10);assert.equal(store.trades()[0].status,'HEDGED');store.close()
})
test('FOK意外部分成交：对冲真实量后熔断',async()=>{
 const {a,b,e,store}=setup();a.onPlace=async r=>result(r,6,'EXPIRED')
 await e.execute(candidate());assert.equal(b.calls[0].qty,'6');assert.match(e.halt,/FOK出现部分成交/);store.close()
})
test('显式IOC部分成交正常对冲',async()=>{
 const {a,b,e,store}=setup();e.cfg.firstTif='IOC';a.onPlace=async r=>result(r,6,'EXPIRED')
 await e.execute(candidate());assert.equal(b.calls[0].qty,'6');assert.equal(e.halt,'');store.close()
})
test('首腿超时查不到，不盲重发，不下币安',async()=>{
 const {a,b,e,store}=setup();a.onPlace=async()=>{throw Error('timeout')}
 await e.execute(candidate());assert.equal(a.calls.length,1);assert.equal(b.calls.length,0);assert.equal(store.pending().length,1);assert.match(e.halt,/结局未知/);store.close()
})
test('首腿超时但恢复FILLED：只发一次POST',async()=>{
 const {a,b,e,store}=setup();a.onPlace=async()=>{throw Error('timeout')};a.onQuery=async r=>result(r)
 await e.execute(candidate());assert.equal(a.calls.length,1);assert.equal(a.queries,1);assert.equal(b.calls.length,1);store.close()
})
test('币安明确拒绝：仅撤回Aster已成交量',async()=>{
 const {a,b,e,store}=setup();b.onPlace=async()=>{throw new ApiError('margin',-2019,400,true)}
 await e.execute(candidate());assert.equal(a.calls.length,2);assert.equal(a.calls[1].kind,'IOC');assert.equal(a.calls[1].reduceOnly,true);assert.equal(a.calls[1].qty,'10');assert.equal(store.position('aster','TESTUSDT').qty,0);assert.ok(e.halt);store.close()
})
test('币安结果未知：禁止贸然撤回',async()=>{
 const {a,b,e,store}=setup();b.onPlace=async()=>{throw Error('timeout')}
 await e.execute(candidate());assert.equal(a.calls.length,1);assert.equal(b.calls.length,1);assert.equal(store.pending().length,1);store.close()
})
test('币安部分成交：只撤回差额',async()=>{
 const {a,b,e,store}=setup();b.onPlace=async r=>result(r,6,'EXPIRED')
 await e.execute(candidate());assert.equal(a.calls[1].qty,'4');assert.equal(store.position('aster','TESTUSDT').qty,6);assert.equal(store.position('binance','TESTUSDT').qty,-6);store.close()
})
test('撤回失败不掩盖单腿',async()=>{
 const {a,b,e,store}=setup();b.onPlace=async r=>result(r,0,'EXPIRED');a.onPlace=async r=>r.kind==='IOC'?result(r,0,'EXPIRED'):result(r)
 await e.execute(candidate());assert.equal(store.position('aster','TESTUSDT').qty,10);assert.equal(store.trades()[0].status,'MANUAL_REQUIRED');store.close()
})
test('幂等入账：同一回执不重复加仓/手续费',()=>{
 const {store}=setup(),r={id:'x',venue:'aster' as const,symbol:'TESTUSDT',side:'BUY' as const,qty:'10',kind:'FOK' as const,reduceOnly:false}
 store.intent('t','test',r);store.finish('x',result(r),0.05);store.finish('x',result(r),0.05)
 assert.equal(store.position('aster','TESTUSDT').qty,10);assert.equal(store.position('aster','TESTUSDT').fees,0.005);store.close()
})
test('独立账户漂移阻止恢复',async()=>{
 const {a,e,store}=setup();a.refreshAccount=async()=>({...a.account,positions:[{symbol:'TESTUSDT',qty:1,mark:1,unrealized:0,liquidation:0,leverage:2,isolated:false}]})
 await assert.rejects(e.reconcile(),/外来|漂移/);store.close()
})
test('重启默认暂停，未知订单不自动重发',()=>{
 const {a,b,e,store}=setup();store.intent('t','test',{id:'x',venue:'aster',symbol:'TESTUSDT',side:'BUY',qty:'10',kind:'FOK',reduceOnly:false})
 const restarted=new Engine(e.cfg,store,a,b,e.circuit);assert.ok(restarted.paused);assert.ok(restarted.halt);assert.equal(a.calls.length,0);store.close()
})
test('stop不是清仓，观察模式无法恢复',async()=>{
 const {e,store}=setup();e.cfg.mode='observe';await assert.rejects(e.resume(),/观察模式/);store.close()
})
test('FOK未声明且未验证：不允许run',()=>{
 const {a,e,store}=setup();a.rules.get('TESTUSDT')!.timeInForce=['IOC'];e.cfg.fokVerified=false
 assert.throws(()=>e.validatePair(pair()),/未声明支持FOK/);store.close()
})
test('配置乐观锁和相同合约不可重复',()=>{
 const {e,store}=setup();assert.throws(()=>e.savePair({...pair(),revision:99}),/配置已更新/)
 assert.throws(()=>e.savePair({...pair(),id:'other'}),/不可分配多个pair/);store.close()
})
test('数据层非终态不能入账',()=>{
 const s=new Store(':memory:');assert.throws(()=>s.finish('x',{status:'NEW',qty:0,price:0,quote:0,orderId:'1',ackAt:0},0.1));s.close()
})
