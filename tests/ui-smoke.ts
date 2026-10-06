import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { setup } from './helpers.js'
const {e,store}=setup();e.cfg.mode='observe';e.cfg.password='ui-smoke-test';e.initialized=true
e.a.rules.get('TESTUSDT')!.timeInForce=['IOC'];e.cfg.fokVerified=false
e.a.funding.get('TESTUSDT')!.nextTime=Date.now()+3600000;e.b.funding.get('TESTUSDT')!.nextTime=Date.now()+3600000
store.savePair({...store.pair('test')!,mode:'stop'})
const server=createApp(e).listen(0,'127.0.0.1')
await new Promise<void>(r=>server.once('listening',r))
const port=(server.address() as any).port
const browser=await chromium.launch({headless:true})
try{
 const context=await browser.newContext({httpCredentials:{username:'admin',password:'ui-smoke-test'},viewport:{width:1440,height:1100}})
 const page=await context.newPage(),errors:string[]=[]
 page.on('pageerror',err=>errors.push(err.message))
 await page.goto('http://127.0.0.1:'+port)
 await page.waitForSelector('.pair-item')
 assert.match(await page.locator('#topStatus').innerText(),/只读观察/)
 assert.equal(await page.locator('#resume').isDisabled(),true)
 assert.match(await page.locator('#capability').innerText(),/未声明/)
 await page.locator('[name=orderUsd]').fill('15')
 await page.locator('#pairForm button[type=submit]').click()
 await page.waitForFunction(()=>document.querySelector('#toast')?.textContent==='已保存')
 assert.equal(store.pair('test')!.orderUsd,15)
 await page.screenshot({path:'/tmp/perp-pair-ui-desktop.png',fullPage:true})
 await page.setViewportSize({width:390,height:844})
 await page.screenshot({path:'/tmp/perp-pair-ui-mobile.png',fullPage:true})
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false)
 assert.deepEqual(errors,[])
 console.log('UI smoke passed: auth, observe mode, FOK notice, save, desktop/mobile, zero JS errors')
}finally{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close()}
