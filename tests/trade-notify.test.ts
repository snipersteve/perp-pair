import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatTradeNotice,sendTradeNotice,type TradeNotice } from '../src/trade-notify.js'
import { setup,candidate,result } from './helpers.js'
const response=()=>new Response(JSON.stringify({ok:true,result:{message_id:1}}))
function enable(e:ReturnType<typeof setup>['e']){Object.assign(e.cfg,{tradeNotify:true,tradeTgToken:'test-token',tradeTgChat:'test-chat'})}
function notice():TradeNotice {
 const c=candidate()
 return {id:'unique-trade',candidate:c,a:{status:'FILLED',qty:6,price:1,quote:6,orderId:'1',ackAt:1},
  b:{status:'FILLED',qty:6,price:1.02,quote:6.12,orderId:'2',ackAt:2},firstTif:'IOC',
  firstMs:150,hedgeMs:250,totalMs:400,at:0,aPosition:6,bPosition:-6,halt:''}
}
test('成交消息用实际价格与成交量，区分开/平及IOC部分成交，价差不冒充利润',()=>{
 const n=notice();n.candidate.grossPct=99
 const text=formatTradeNotice(n)
 assert.match(text,/开仓 已对冲/);assert.match(text,/IOC 部分成交/);assert.match(text,/计划 10，实际 6 ／ 6/)
 assert.match(text,/\+1\.980%/);assert.match(text,/非已实现利润/);assert.match(text,/1970-01-01 08:00:00 北京时间/)
 n.candidate={...n.candidate,closing:true,side:'SELL'};n.halt='漂移'
 const close=formatTradeNotice(n);assert.match(close,/平仓 已对冲/);assert.match(close,/-1\.980%/);assert.match(close,/引擎已暂停/)
})
test('完整开平仓分别推送一次，使用日常Bot，缺省关闭不发送',async()=>{
 const s=setup(),original=globalThis.fetch,messages:any[]=[]
 globalThis.fetch=async (url,init)=>{assert.equal(String(url),'https://api.telegram.org/bottest-token/sendMessage');messages.push(JSON.parse(String(init?.body)));return response()}
 try{
  await s.e.execute(candidate());assert.equal(messages.length,0)
  enable(s.e)
  await s.e.execute({...candidate(),side:'SELL',closing:true});await s.e.flushNotifications()
  assert.equal(messages.length,1);assert.match(messages[0].text,/平仓 已对冲/);assert.equal(messages[0].chat_id,'test-chat');assert.equal(messages[0].parse_mode,undefined)
  await s.e.execute(candidate());await s.e.flushNotifications()
  assert.equal(messages.length,2);assert.match(messages[1].text,/开仓 已对冲/);assert.equal(s.e.halt,'')
 }finally{await s.e.flushNotifications();globalThis.fetch=original;s.store.close()}
})
test('IOC零成交、对冲不足撤回均不发送正常成交消息',async()=>{
 const original=globalThis.fetch;let calls=0
 globalThis.fetch=async()=>{calls++;return response()}
 try{
  for(const scenario of ['zero','rollback']){
   const s=setup();enable(s.e);s.e.cfg.firstTif='IOC'
   if(scenario==='zero')s.a.onPlace=async r=>result(r,0,'EXPIRED')
   else s.b.onPlace=async r=>result(r,0,'EXPIRED')
   try{await s.e.execute(candidate());await s.e.flushNotifications();assert.equal(calls,0)}finally{s.store.close()}
  }
 }finally{globalThis.fetch=original}
})
test('慢Telegram不阻挡交易完成，发送发生在币安成交之后；IOC部分成交可推送',async()=>{
 const s=setup(),original=globalThis.fetch;enable(s.e);s.e.cfg.firstTif='IOC'
 s.a.onPlace=async r=>result(r,6,'EXPIRED')
 let finish!:(r:Response)=>void;let posted='';let timer:ReturnType<typeof setTimeout>|undefined
 globalThis.fetch=async (_url,init)=>{
  assert.equal(s.b.calls.length,1);assert.equal(s.store.trades()[0].status,'HEDGED')
  posted=JSON.parse(String(init?.body)).text
  return new Promise<Response>(resolve=>{finish=resolve})
 }
 try{
  await Promise.race([s.e.execute(candidate()),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('通知阻塞了交易')),1000)})])
  assert.match(posted,/实际 6 ／ 6/);assert.equal(s.e.halt,'');assert.equal(s.store.pending().length,0)
 }finally{
  clearTimeout(timer);finish?.(response());await s.e.flushNotifications();globalThis.fetch=original;s.store.close()
 }
})
test('HTTP200但Telegram ok=false只记警告，不篡改HEDGED或熔断',async()=>{
 const s=setup(),original=globalThis.fetch;enable(s.e)
 globalThis.fetch=async()=>new Response(JSON.stringify({ok:false,error_code:429,description:'do not log raw descriptions'}))
 try{
  await s.e.execute(candidate());await s.e.flushNotifications()
  assert.equal(s.store.trades()[0].status,'HEDGED');assert.equal(s.e.halt,'')
  const events=JSON.stringify(s.store.events());assert.match(events,/推送失败/);assert.doesNotMatch(events,/do not log/)
 }finally{globalThis.fetch=original;s.store.close()}
})
test('网络异常与非JSON响应不外抛，不泄露Bot token，不自动重试',async()=>{
 const original=globalThis.fetch,logs:string[]=[];let calls=0
 try{
  globalThis.fetch=async()=>{calls++;throw Error('https://api.telegram.org/botsecret-token/sendMessage')}
  await sendTradeNotice('secret-token','chat','text','id',(_level,msg)=>logs.push(msg))
  globalThis.fetch=async()=>{calls++;return new Response('invalid')}
  await sendTradeNotice('secret-token','chat','text','id',(_level,msg)=>logs.push(msg))
  assert.equal(calls,2);assert.equal(logs.length,2);assert.doesNotMatch(logs.join('\n'),/secret-token/)
 }finally{globalThis.fetch=original}
})
