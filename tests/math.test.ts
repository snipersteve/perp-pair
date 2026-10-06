import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commonStep,quantize,decimal,priceBound,sweep,applyPosition,validBook,checkRules } from '../src/math.js'
import { rules } from './helpers.js'
test('共同数量步长用LCM不是max',()=>{assert.equal(commonStep('0.002','0.003'),0.006);assert.equal(commonStep('1','0.10000000'),1)})
test('精度、价格保护取整',()=>{assert.equal(quantize(1.019,0.01),1.01);assert.equal(priceBound(1.019,'0.01','BUY'),1.01);assert.equal(priceBound(1.011,'0.01','SELL'),1.02);assert.equal(decimal(1000),'1000');assert.equal(decimal(0.01),'0.01')})
test('拒绝非法step',()=>{assert.throws(()=>commonStep('0'));assert.throws(()=>commonStep('NaN'))})
test('双边深度按VWAP，挂量打折',()=>{assert.deepEqual(sweep([[1,10],[2,10]],10,0.5),{price:1.5,worst:2});assert.equal(sweep([[1,1]],2),null)})
test('仓位加仓、部分平仓、翻向已实现',()=>{
 let p=applyPosition(10,100,10,110);assert.equal(p.entry,105)
 p=applyPosition(p.qty,p.entry,-5,120);assert.equal(p.realized,75);assert.equal(p.qty,15);assert.equal(p.entry,105)
 p=applyPosition(p.qty,p.entry,-20,90);assert.equal(p.realized,-225);assert.equal(p.qty,-5);assert.equal(p.entry,90)
})
test('陈旧与未来盘口不能交易',()=>{const b={bids:[[1,2]],asks:[[2,2]],receivedAt:1000,eventAt:1000,sequence:1} as any;assert.ok(validBook(b,1100,500));assert.ok(!validBook(b,2000,500));assert.ok(!validBook({...b,eventAt:5000},1100,500))})
test('拒绝同名不同基币、1000倍自动映射',()=>assert.throws(()=>checkRules(rules(),{...rules(),base:'1000TEST'})))
