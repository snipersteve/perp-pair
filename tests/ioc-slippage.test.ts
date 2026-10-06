import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.js'
import { evaluate } from '../src/strategy.js'
import { setup, pair, result } from './helpers.js'

function fixture(side:'BUY'|'SELL') {
  const x=setup()
  x.c.firstTif='IOC';x.c.iocSlippage=0.1
  x.a.rules.get('TESTUSDT')!.tick='0.000001'
  const book=x.b.books.get('TESTUSDT')!
  book.bids=[[side==='BUY'?1.02:0.97,1000]]
  book.asks=[[side==='BUY'?1.03:0.98,1000]]
  return x
}

test('IOC滑点env默认关闭，0.1表示百分之0.1，非法值拒绝',()=>{
  const key='ASTER_IOC_SLIPPAGE_PCT',old=process.env[key]
  try {
    delete process.env[key];assert.equal(loadConfig().iocSlippage,0)
    process.env[key]='0.1';assert.equal(loadConfig().iocSlippage,0.1)
    for(const value of ['-0.1','NaN','Infinity','1.1']){
      process.env[key]=value;assert.throws(()=>loadConfig())
    }
  }finally{if(old===undefined)delete process.env[key];else process.env[key]=old}
})

for(const side of ['BUY','SELL'] as const)for(const closing of [false,true]){
  test(`IOC ${side} ${closing?'平仓':'开仓'}限价放宽0.1%，触发价差不变`,()=>{
    const {a,b,c,store}=fixture(side)
    try{
      const position=closing?(side==='BUY'?-10:10):0
      c.iocSlippage=0
      const base=evaluate(pair(),side,a,b,position,c).candidate!
      assert.ok(base)
      c.iocSlippage=0.1
      const slipped=evaluate(pair(),side,a,b,position,c).candidate!
      assert.ok(slipped)
      const expected=side==='BUY'?1.01101:0.999
      assert.equal(Number(slipped.priceText),expected)
      assert.equal(slipped.signalPriceText,base.priceText)
      assert.equal(slipped.grossPct,base.grossPct)
      assert.equal(slipped.netPct,base.netPct)
      assert.ok(slipped.limitGrossPct!<slipped.grossPct)
      assert.ok(slipped.limitNetPct!<slipped.netPct)
      assert.equal(slipped.closing,closing)
      if(closing)assert.ok(slipped.qty<=Math.abs(position))
    }finally{store.close()}
  })
}

test('不把0.1%滑点叠加为更高开仓门槛，也不降低原信号门槛',()=>{
  const {a,b,c,store}=fixture('BUY')
  try{
    c.buffer=0.15;c.aFee=c.bFee=0.05
    b.books.get('TESTUSDT')!.bids=[[1.0186,1000]]
    const p={...pair(),openPct:0.55}
    const candidate=evaluate(p,'BUY',a,b,0,c).candidate!
    assert.ok(candidate);assert.ok(candidate.netPct>=p.openPct)
    assert.ok(candidate.limitNetPct!<p.openPct)
    b.books.get('TESTUSDT')!.bids=[[1.017,1000]]
    assert.equal(evaluate(p,'BUY',a,b,0,c).candidate,undefined)
  }finally{store.close()}
})

test('粗tick向内取整，不能突破允许滑点；FOK不受影响',()=>{
  for(const side of ['BUY','SELL'] as const){
    const {a,b,c,store}=fixture(side)
    try{
      a.rules.get('TESTUSDT')!.tick='0.01'
      const p=evaluate(pair(),side,a,b,0,c).candidate!
      assert.ok(p);assert.equal(p.priceText,p.signalPriceText)
      a.rules.get('TESTUSDT')!.tick='0.000001';c.firstTif='FOK'
      const f=evaluate(pair(),side,a,b,0,c).candidate!
      assert.ok(f);assert.equal(f.priceText,f.signalPriceText);assert.equal(f.iocSlippagePct,0)
    }finally{store.close()}
  }
})

test('买入滑点计入单笔、单币及总额度/保证金用的候选名义金额',()=>{
  const {a,b,c,store}=fixture('BUY')
  try{
    b.books.get('TESTUSDT')!.bids=[[1,1000]]
    const p={...pair(),orderUsd:10.1,capUsd:10.1,openPct:0,closePct:-10}
    c.aFee=c.bFee=c.buffer=0
    c.iocSlippage=0
    const before=evaluate(p,'BUY',a,b,-50,c).candidate!
    assert.equal(before.qty,10)
    c.iocSlippage=0.1
    const after=evaluate(p,'BUY',a,b,-50,c).candidate!
    assert.equal(after.qty,9)
    assert.ok(after.notional<=p.orderUsd)
    assert.equal(after.notional,after.qty*Number(after.priceText))
    // Zero base spread, new limit alone would exceed a 10.1U position cap.
    b.books.get('TESTUSDT')!.bids=[[1.01,1000]]
    const entry=evaluate({...p,orderUsd:20},'BUY',a,b,0,c).candidate!
    assert.ok(entry);assert.ok(entry.qty*Number(entry.priceText)<=p.capUsd)
  }finally{store.close()}
})

test('真实执行请求采用放宽限价，IOC只按实成量立即对冲',async()=>{
  const {a,b,c,e,store}=fixture('SELL')
  try{
    const candidate=evaluate({...pair(),direction:'shortA'},'SELL',a,b,0,c).candidate!
    assert.ok(candidate)
    a.onPlace=async r=>result(r,6,'EXPIRED')
    await e.execute(candidate)
    assert.equal(a.calls[0].kind,'IOC');assert.equal(a.calls[0].price,'0.999')
    assert.equal(a.calls[0].side,'SELL');assert.equal(a.calls[0].reduceOnly,false)
    assert.equal(b.calls.length,1);assert.equal(b.calls[0].kind,'MARKET')
    assert.equal(b.calls[0].side,'BUY');assert.equal(b.calls[0].qty,'6')
    assert.equal(e.halt,'')
  }finally{store.close()}
})
