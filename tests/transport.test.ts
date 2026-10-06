import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { Store } from '../src/store.js'
import { Circuit,request,ApiError } from '../src/exchanges/http.js'
import { Exchange } from '../src/exchanges/client.js'
import { setup,cfg,rules,candidate } from './helpers.js'
import type { OrderRequest } from '../src/types.js'
const response=(r:OrderRequest)=>({symbol:r.symbol,clientOrderId:r.id,side:r.side,status:'FILLED',executedQty:r.qty,avgPrice:'1',cumQuote:r.qty,orderId:'123456789012345678'})
test('币安中文symbol：签名和实际发送编码逐字一致',async()=>{
 const store=new Store(':memory:'),c={...cfg(),bSecret:'test-only-hmac',bPem:'',bKey:'test-api-key'},client=new Exchange('binance',c,new Circuit(store),()=>{})
 const original=globalThis.fetch
 const r:OrderRequest={id:'test-order',venue:'binance',symbol:'龙虾USDT',side:'SELL',qty:'10',kind:'MARKET',reduceOnly:false}
 globalThis.fetch=async(input,init)=>{
  assert.equal(String(input),'https://fapi.binance.com/fapi/v1/order')
  const body=String(init?.body),p=new URLSearchParams(body),sig=p.get('signature');p.delete('signature')
  assert.equal(sig,createHmac('sha256',c.bSecret).update(p.toString()).digest('hex'))
  assert.equal(p.get('symbol'),'龙虾USDT');assert.equal(p.get('type'),'MARKET')
  return new Response(JSON.stringify(response(r)),{status:200})
 }
 try{assert.equal((await client.place(r)).qty,10)}finally{globalThis.fetch=original;store.close()}
})
test('Aster未声明FOK：默认禁止，显式核验覆盖后按币安字段发送FOK',async()=>{
 const store=new Store(':memory:'),c={...cfg(),aUser:'0x0000000000000000000000000000000000000001',aKey:'0x'+'1'.padStart(64,'0'),fokVerified:false}
 const circuit=new Circuit(store),client=new Exchange('aster',c,circuit,()=>{});client.rules.set('TESTUSDT',{...rules(),timeInForce:['IOC']})
 const r:OrderRequest={id:'probe-fok',venue:'aster',symbol:'TESTUSDT',side:'BUY',qty:'10',kind:'FOK',price:'1',reduceOnly:false}
 await assert.rejects(client.place(r),/未声明支持/)
 c.fokVerified=true
 const original=globalThis.fetch
 globalThis.fetch=async(input,init)=>{
  assert.equal(String(input),'https://fapi.asterdex.com/fapi/v3/order')
  const p=new URLSearchParams(String(init?.body))
  assert.equal(p.get('type'),'LIMIT');assert.equal(p.get('timeInForce'),'FOK');assert.equal(p.get('newOrderRespType'),'RESULT')
  assert.match(p.get('signature')!,/^0x[0-9a-f]+$/i);assert.ok(Number(p.get('nonce'))>Date.now()*999)
  return new Response(JSON.stringify(response(r)),{status:200})
 }
 try{assert.equal((await client.place(r)).qty,10)}finally{globalThis.fetch=original;store.close()}
})
test('429持久化全局冷却，两所共享拦截',async()=>{
 const store=new Store(':memory:'),circuit=new Circuit(store),original=globalThis.fetch;let n=0
 globalThis.fetch=async()=>{n++;return new Response('{"code":-1003,"msg":"rate limit"}',{status:429,headers:{'retry-after':'60'}})}
 try{
  await assert.rejects(request('https://example.test','/a','GET','',{},1000,circuit))
  await assert.rejects(request('https://second.test','/b','GET','',{},1000,circuit),/退避/)
  assert.equal(n,1);assert.ok(new Circuit(store).until>Date.now())
 }finally{globalThis.fetch=original;store.close()}
})
test('503携带业务code仍然是未知，不作为确定拒绝',async()=>{
 const store=new Store(':memory:'),original=globalThis.fetch
 globalThis.fetch=async()=>new Response('{"code":-2019,"msg":"timeout"}',{status:503})
 try{await assert.rejects(request('https://example.test','/order','POST','',{},1000,new Circuit(store)),(e:any)=>e instanceof ApiError&&!e.definitive)}
 finally{globalThis.fetch=original;store.close()}
})
test('不支持timeInForce属于REJECTED并停机，不是假NO_FILL',async()=>{
 const {a,e,store}=setup();a.onPlace=async()=>{throw new ApiError('Invalid timeInForce',-1115,400,true)}
 await e.execute(candidate())
 assert.equal(store.trades()[0].status,'REJECTED');assert.equal(store.trades()[0].detail.a.code,-1115);assert.match(e.halt,/不是正常FOK未成交/);store.close()
})
