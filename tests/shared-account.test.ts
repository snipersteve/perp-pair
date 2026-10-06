import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setup,cfg } from './helpers.js'
import { assertScope,assertOwnership } from '../src/shared-account.js'
import { Exchange } from '../src/exchanges/client.js'
test('共享账户仅放行明确合约，外部激活/核验文件缺失均阻断',()=>{
 const dir=mkdtempSync(join(tmpdir(),'perp-scope-')),file=join(dir,'pairs.json')
 const c={...cfg(),sharedAccount:true,sharedSymbols:['TESTUSDT'],foreignPairFiles:[file]}
 try{
  writeFileSync(file,JSON.stringify([{cexSymbol:'TESTUSDT',status:'stop'}]))
  assert.doesNotThrow(()=>assertOwnership(c,'TESTUSDT'));assert.throws(()=>assertScope(c,'BTCUSDT'),/清单/)
  writeFileSync(file,JSON.stringify([{cexSymbol:'TESTUSDT',status:'reduce'}]));assert.throws(()=>assertOwnership(c,'TESTUSDT'),/其他策略/)
  rmSync(file);assert.throws(()=>assertOwnership(c,'TESTUSDT'))
 }finally{rmSync(dir,{recursive:true,force:true})}
})
test('共享账户不能恢复无人值守自动交易',async()=>{
 const {e,store}=setup();e.cfg.sharedAccount=true
 await assert.rejects(e.resume(),/单次探针/);store.close()
})
test('共享仓位和挂单按合约过滤，资金费不能混入其他策略',async()=>{
 const {e,store}=setup(),c={...e.cfg,sharedAccount:true,sharedSymbols:['TESTUSDT'],bSecret:'test-only'}
 const client=new Exchange('binance',c,e.circuit,()=>{}),original=globalThis.fetch
 const position=(symbol:string)=>({symbol,positionAmt:'1',markPrice:'1',unRealizedProfit:'0',liquidationPrice:'0.5',leverage:'2',isolated:'false'})
 let ownOrder=false
 globalThis.fetch=async url=>{
  const u=new URL(String(url)),path=u.pathname
  if(path.endsWith('/openOrders'))assert.equal(u.searchParams.get('symbol'),'TESTUSDT')
  const data=path.endsWith('/account')?{availableBalance:'100',totalMarginBalance:'100'}:
   path.endsWith('/positionRisk')?[position('TESTUSDT'),position('OTHERUSDT')]:
   path.endsWith('/dual')?{dualSidePosition:false}:
   path.endsWith('/openOrders')?[{symbol:ownOrder?'TESTUSDT':'OTHERUSDT'}]:
   [{tranId:'1',symbol:'TESTUSDT',income:'0.01',asset:'USDT',time:1},{tranId:'2',symbol:'OTHERUSDT',income:'100',asset:'USDT',time:1}]
  return new Response(JSON.stringify(data))
 }
 try{
  assert.deepEqual((await client.refreshAccount()).positions.map(p=>p.symbol),['TESTUSDT'])
  assert.deepEqual((await client.incomes(0,10)).map(p=>p.symbol),['TESTUSDT'])
  ownOrder=true;await assert.rejects(client.refreshAccount(),/挂单/)
 }finally{globalThis.fetch=original;store.close()}
})
