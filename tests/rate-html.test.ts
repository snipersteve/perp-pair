import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Circuit,request,NotSent } from '../src/exchanges/http.js'
import { Store } from '../src/store.js'
test('非JSON的418/429也必须全局退避，不能当普通解析错误',async()=>{
 const original=globalThis.fetch
 for(const status of [418,429]){
  const store=new Store(':memory:'),circuit=new Circuit(store)
  globalThis.fetch=async()=>new Response('<html>rate limit</html>',{status})
  try{
   await assert.rejects(request('https://test.invalid','/order','GET','',{},1000,circuit),/限流/)
   assert.ok(circuit.until>Date.now());assert.throws(()=>circuit.check(),NotSent)
  }finally{store.close()}
 }
 globalThis.fetch=original
})
