import 'dotenv/config'
import { z } from 'zod'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { parse } from 'dotenv'
const num = (key: string, fallback: number, min: number, max: number) => z.coerce.number().finite().min(min).max(max).parse(process.env[key] ?? fallback)
const bool = (key: string) => z.enum(['true','false']).parse(process.env[key] ?? 'false') === 'true'
export function loadConfig() {
  const shared = process.env.SHARED_EXCHANGES_FILE ? parse(readFileSync(process.env.SHARED_EXCHANGES_FILE,'utf8')) : {}
  const notify=process.env.SHARED_NOTIFY_FILE?parse(readFileSync(process.env.SHARED_NOTIFY_FILE,'utf8')):{}
  const credential=(name:string)=>process.env[name]||shared[name]||''
  const csv=(name:string)=>(process.env[name]||'').split(',').map(s=>s.trim()).filter(Boolean)
  const mode = z.enum(['observe','live']).parse(process.env.MODE ?? 'observe')
  const c = {
    firstTif: z.enum(['FOK','IOC']).parse(process.env.ASTER_FIRST_TIF ?? 'FOK'),
    iocSlippage: num('ASTER_IOC_SLIPPAGE_PCT',0,0,1),
    rateLimitStopHook: process.env.RATE_LIMIT_STOP_HOOK||'',
    sharedAuto: bool('SHARED_AUTOTRADE_ENABLED'), reservationFile: process.env.SHARED_RESERVATION_FILE||'',
    accountPollMs: num('ACCOUNT_POLL_MS',15000,5000,60000),
    sharedAccount: bool('SHARED_ACCOUNT_MODE'), sharedSymbols: csv('SHARED_SYMBOLS'), foreignPairFiles: csv('SHARED_FOREIGN_PAIR_FILES'),
    mode, live: bool('LIVE_TRADING'), dedicated: bool('DEDICATED_ACCOUNTS_CONFIRMED'), fokVerified: bool('ASTER_FOK_VERIFIED'),
    host: process.env.HOST || '127.0.0.1', port: num('PORT',3321,1024,65535),
    dataDir: resolve(process.env.DATA_DIR || './data'), password: process.env.ADMIN_PASSWORD || '',
    aUser: credential('ASTER_USER_ADDRESS'), aKey: credential('ASTER_SIGNER_PRIVATE_KEY'),
    bKey: credential('BINANCE_API_KEY'), bSecret: credential('BINANCE_API_SECRET'), bPem: credential('BINANCE_ED25519_KEY_PATH')||credential('BINANCE_ED25519_PRIVATE_KEY_PATH'),
    aFee: num('ASTER_FEE_PCT',0.05,0,1), bFee: num('BINANCE_FEE_PCT',0.05,0,1),
    maxFundingCost: num('MAX_FUNDING_COST_PCT',0.3,0,10),
    buffer: num('EXEC_BUFFER_PCT',0.15,0,5), trust: num('DEPTH_TRUST',0.3,0.01,1),
    maxAge: num('BOOK_MAX_AGE_MS',600,50,5000), maxSkew: num('BOOK_MAX_SKEW_MS',300,0,3000),
    maxClock: num('MAX_CLOCK_OFFSET_MS',3000,100,5000),
    timeout: num('REQUEST_TIMEOUT_MS',3000,100,10000), resolveMs: num('ORDER_RESOLVE_MS',5000,500,15000),
    accountMaxAge: num('ACCOUNT_MAX_AGE_MS',30000,1000,60000),
    maxOrderUsd: num('MAX_ORDER_USD',100,5,10000), totalCap: num('MAX_TOTAL_POSITION_USD',1000,5,1000000),
    dailyLoss: num('MAX_DAILY_LOSS_USD',20,1,100000), marginBuffer: num('MIN_MARGIN_BUFFER_USD',50,0,100000),
    marginUse: num('MAX_MARGIN_USE_PCT',30,1,80), rollbackLoss: num('ROLLBACK_MAX_LOSS_USD',5,0.1,1000),
    rollbackSlippage: num('ROLLBACK_MAX_SLIPPAGE_PCT',1,0.01,10),
    cooldown: num('COOLDOWN_MS',1500,100,60000), leverage: num('LEVERAGE',2,1,5),
    tradeNotify: bool('TRADE_TELEGRAM_ENABLED'),
    tradeTgToken: process.env.TG_TRADE_BOT_TOKEN || notify.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN || '',
    tradeTgChat: process.env.TG_TRADE_CHAT_ID || process.env.TG_CHAT_ID || notify.TELEGRAM_CHAT_ID || '',
    tgToken: process.env.TG_BOT_TOKEN || notify.TELEGRAM_ALERT_BOT_TOKEN || '', tgChat: process.env.TG_CHAT_ID || notify.TELEGRAM_CHAT_ID || '',
  }
  if (!['127.0.0.1','::1','localhost'].includes(c.host) && c.password.length < 32) throw Error('公开监听必须配置至少32位 ADMIN_PASSWORD')
  if(c.sharedAuto&&(!c.sharedAccount||!c.reservationFile))throw Error('共享自动交易必须启用共享模式与合约专属登记文件')
  if(c.sharedAccount && (!c.sharedSymbols.length || !c.foreignPairFiles.length))throw Error('共享账户必须配置专属合约和外部pair文件核验清单')
  if (mode === 'live' && (!c.live || !(c.dedicated||c.sharedAccount) || !c.aUser || !c.aKey || !c.bKey || !(c.bSecret || c.bPem))) {
    throw Error('实盘配置不完整：实盘开关、账户归属确认和两所凭证全部必需')
  }
  if(c.tradeNotify&&(!c.tradeTgToken||!c.tradeTgChat))throw Error('成交Telegram推送已开启，但缺少日常Bot或Chat ID')
  if (c.bSecret && c.bPem) throw Error('币安 HMAC / Ed25519 只能配置一种')
  return c
}
export type Config = ReturnType<typeof loadConfig>
export const pairInput = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
  aSymbol: z.string().min(5).max(40).regex(/^[\p{L}\p{N}_]+USDT$/u),
  bSymbol: z.string().min(5).max(40).regex(/^[\p{L}\p{N}_]+USDT$/u),
  mode: z.enum(['stop','run','reduce']),
  orderUsd: z.number().finite().min(5).max(10000),
  capUsd: z.number().finite().min(5).max(1000000),
  openPct: z.number().finite().min(0).max(50),
  closePct: z.number().finite().min(-50).max(50),
  direction: z.enum(['both','longA','shortA']),
  revision: z.number().int().min(0),
}).strict()
