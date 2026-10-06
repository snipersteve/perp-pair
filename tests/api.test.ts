import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { parseJson } from '../src/exchanges/http.js'
import { decodeOrder } from '../src/exchanges/client.js'
import { setup } from './helpers.js'
test('large orderId preserves precision',()=>assert.equal(parseJson('{"orderId":123456789012345678}').orderId,'123456789012345678'))
test('订单身份与超额成交校验',()=>{
 const r={id:'x',venue:'aster' as const,symbol:'TESTUSDT',side:'BUY' as const,qty:'10',kind:'FOK' as const,reduceOnly:false}
 assert.throws(()=>decodeOrder({symbol:'WRONG',side:'BUY',clientOrderId:'x'},r),/身份/)
 assert.throws(()=>decodeOrder({symbol:'TESTUSDT',side:'BUY',clientOrderId:'x',executedQty:'11',cumQuote:'11',avgPrice:'1'},r),/非法/)
})
test('HTTP认证、CSRF、只读状态与控制',async()=>{
 const {e,store}=setup();e.cfg.password='strong-test-password'
 const server=createApp(e).listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r))
 const port=(server.address() as any).port,url='http://127.0.0.1:'+port,auth={Authorization:'Basic '+Buffer.from('admin:strong-test-password').toString('base64')}
 try{
  assert.equal((await fetch(url+'/api/state')).status,401)
  const r=await fetch(url+'/api/state',{headers:auth});const s=await r.json();assert.ok(s.csrf);assert.equal(s.paused,true)
  assert.equal((await fetch(url+'/api/control',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({action:'pause'})})).status,403)
  assert.equal((await fetch(url+'/api/control',{method:'POST',headers:{...auth,'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:JSON.stringify({action:'pause'})})).status,200)
  assert.ok((await fetch(url+'/',{headers:auth})).headers.get('content-security-policy'))
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close()}
})
