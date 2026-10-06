import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setup, candidate } from './helpers.js'
import { assertOwnership } from '../src/shared-account.js'
function auto(){
 const s=setup(),dir=mkdtempSync(join(tmpdir(),'perp-auto-')),file=join(dir,'pairs.json'),reg=join(dir,'owners.json')
 Object.assign(s.c,{sharedAuto:true,sharedAccount:true,sharedSymbols:['TESTUSDT'],foreignPairFiles:[file],reservationFile:reg})
 writeFileSync(file,'[]');writeFileSync(reg,JSON.stringify({'aster:TESTUSDT':{owner:'perp-pair',enabled:true},'binance:TESTUSDT':{owner:'perp-pair',enabled:true}}))
 return {...s,file,reg,close(){s.store.close();rmSync(dir,{recursive:true,force:true})}}
}
test('共享自动模式须双所登记、外部完全撤出；stop配置也拒绝',()=>{
 const s=auto();try{
  assert.doesNotThrow(()=>assertOwnership(s.c,'TESTUSDT'))
  writeFileSync(s.file,JSON.stringify([{cexSymbol:'TESTUSDT',status:'stop'}]));assert.throws(()=>assertOwnership(s.c,'TESTUSDT'),/其他策略/)
  writeFileSync(s.file,'[]');writeFileSync(s.reg,'{}');assert.throws(()=>assertOwnership(s.c,'TESTUSDT'),/专属登记/)
  rmSync(s.reg);assert.throws(()=>assertOwnership(s.c,'TESTUSDT'))
 }finally{s.close()}
})
test('共享自动可恢复；登记被撤销后在没有信号的tick也禁止交易',async()=>{
 const s=auto();try{
  await s.e.resume();assert.equal(s.e.paused,false);s.e.initialized=true
  writeFileSync(s.reg,'{}');await assert.rejects(s.e.tick(),/专属登记/);assert.equal(s.a.calls.length,0)
 }finally{s.close()}
})
test('首腿前再次检查外部配置，已有stop外部pair也不能抢仓',async()=>{
 const s=auto();try{
  writeFileSync(s.file,JSON.stringify([{cexSymbol:'TESTUSDT',status:'stop'}]));await s.e.execute(candidate());assert.match(s.e.halt,/其他策略/);assert.equal(s.a.calls.length,0)
 }finally{s.close()}
})
