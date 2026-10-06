import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setup,candidate,result } from './helpers.js'
test('反向开仓与双边reduceOnly平仓，完整往返PnL而非入场价差',async()=>{
 const {a,b,e,store}=setup()
 a.onPlace=async r=>({...result(r),price:r.side==='SELL'?1.02:1.1,quote:10*(r.side==='SELL'?1.02:1.1)})
 b.onPlace=async r=>({...result(r),price:r.side==='BUY'?1:1.1,quote:10*(r.side==='BUY'?1:1.1)})
 await e.execute({...candidate(),side:'SELL'})
 assert.equal(store.position('aster','TESTUSDT').qty,-10);assert.equal(store.position('binance','TESTUSDT').qty,10)
 assert.equal(store.position('aster','TESTUSDT').realized,0)
 await e.execute({...candidate(),side:'BUY',closing:true})
 assert.equal(store.position('aster','TESTUSDT').qty,0);assert.equal(store.position('binance','TESTUSDT').qty,0)
 assert.equal(a.calls[1].reduceOnly,true);assert.equal(b.calls[1].reduceOnly,true)
 assert.ok(Math.abs(e.pnl().realized-0.2)<1e-10)
 assert.ok(Math.abs(e.pnl().total-0.1789)<1e-10);store.close()
})
test('平仓失败撤回是重开原仓，不用reduceOnly',async()=>{
 const {a,b,e,store}=setup()
 await e.execute(candidate())
 b.onPlace=async r=>result(r,0,'EXPIRED')
 await e.execute({...candidate(),side:'SELL',closing:true})
 assert.equal(a.calls.length,3);assert.equal(a.calls[1].side,'SELL');assert.equal(a.calls[1].reduceOnly,true)
 assert.equal(a.calls[2].side,'BUY');assert.equal(a.calls[2].reduceOnly,false)
 assert.equal(store.position('aster','TESTUSDT').qty,10);assert.equal(store.position('binance','TESTUSDT').qty,-10);store.close()
})
test('恢复查询只入账已知订单，不偷偷补单',async()=>{
 const {a,b,e,store}=setup(),r={id:'crash',venue:'aster' as const,symbol:'TESTUSDT',side:'BUY' as const,qty:'10',kind:'FOK' as const,reduceOnly:false}
 store.intent('t','test',r);a.onQuery=async r=>result(r)
 await e.recover();assert.equal(store.pending().length,0);assert.equal(store.position('aster','TESTUSDT').qty,10);assert.equal(b.calls.length,0)
 await assert.rejects(e.acknowledge(),/敞口不平/);store.close()
})
test('撤回预算超限：保留敞口，不无上限市价撤回',async()=>{
 const {a,b,e,store}=setup()
 e.cfg.rollbackLoss=0.001
 b.onPlace=async r=>result(r,0,'EXPIRED')
 await e.execute(candidate());assert.equal(a.calls.length,1);assert.equal(store.position('aster','TESTUSDT').qty,10);assert.match(e.halt,/超预算/);store.close()
})
