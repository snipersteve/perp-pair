import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setup,candidate,result } from './helpers.js'
import { Exchange } from '../src/exchanges/client.js'
test('IOC测试接口发送IOC而不是硬编码FOK',async()=>{
 const {e,store}=setup(),original=globalThis.fetch
 const c=new Exchange('binance',{...e.cfg,bSecret:'test-only'},e.circuit,()=>{})
 globalThis.fetch=async(url,init)=>{
  assert.match(String(url),/order\/test$/)
  const p=new URLSearchParams(String(init?.body));assert.equal(p.get('timeInForce'),'IOC');assert.equal(p.get('type'),'LIMIT')
  return new Response('{}')
 }
 try{await c.testOrder({id:'test',venue:'binance',symbol:'TESTUSDT',side:'BUY',qty:'10',price:'1',kind:'IOC',reduceOnly:false})}
 finally{globalThis.fetch=original;store.close()}
})
test('IOC零成交不发币安，部分成交不等待补满',async()=>{
 for(const qty of [0,6]){
  const {a,b,e,store}=setup();e.cfg.firstTif='IOC'
  a.onPlace=async r=>result(r,qty,'EXPIRED')
  await e.execute(candidate());assert.equal(a.calls.length,1);assert.equal(a.calls[0].kind,'IOC')
  if(qty){assert.equal(b.calls[0].qty,'6');assert.equal(b.calls[0].kind,'MARKET');assert.equal(e.halt,'')}
  else assert.equal(b.calls.length,0)
  store.close()
 }
})
test('IOC成交低于币安最小名义：撤回首腿，不放大对冲数量',async()=>{
 const {a,b,e,store}=setup();e.cfg.firstTif='IOC';a.onPlace=async r=>result(r,4,'EXPIRED')
 await e.execute(candidate());assert.equal(b.calls.length,0);assert.equal(a.calls.length,2);assert.equal(a.calls[1].qty,'4');assert.equal(a.calls[1].reduceOnly,true);assert.equal(store.position('aster','TESTUSDT').qty,0);store.close()
})
