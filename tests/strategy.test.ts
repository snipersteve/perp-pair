import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setup,pair } from './helpers.js'
import { evaluate } from '../src/strategy.js'
test('双边深度定量，薄侧不够不发信号',()=>{
 const {a,b,c,store}=setup();b.books.get('TESTUSDT')!.bids=[[1.05,1000]];b.books.get('TESTUSDT')!.asks=[[1.06,1000]]
 let e=evaluate(pair(),'BUY',a,b,0,c);assert.ok(e.candidate);assert.ok(e.candidate.notional<=20)
 b.books.get('TESTUSDT')!.bids=[[1.05,0.1]]
 assert.equal(evaluate(pair(),'BUY',a,b,0,c).candidate,undefined);store.close()
})
test('盘口不同步、单侧陈旧、资金费过高均阻止开仓',()=>{
 const {a,b,c,store}=setup();b.books.get('TESTUSDT')!.eventAt=Date.now()-700
 assert.match(evaluate(pair(),'BUY',a,b,0,c).reason,/不同步/)
 a.books.get('TESTUSDT')!.receivedAt=0;assert.match(evaluate(pair(),'BUY',a,b,0,c).reason,/陈旧/)
 a.books.get('TESTUSDT')!.receivedAt=Date.now();b.books.get('TESTUSDT')!.eventAt=Date.now();a.funding.get('TESTUSDT')!.rate=0.1
 assert.match(evaluate(pair(),'BUY',a,b,0,c).reason,/资金费/);store.close()
})
test('reduce只减仓、平仓可负阈值，不翻向',()=>{
 const {a,b,c,store}=setup(),p={...pair(),mode:'reduce' as const,closePct:-10}
 assert.equal(evaluate(p,'BUY',a,b,10,c).candidate,undefined)
 const e=evaluate(p,'SELL',a,b,10,c);assert.ok(e.candidate);assert.equal(e.candidate.closing,true);assert.ok(e.candidate.qty<=10);store.close()
})
