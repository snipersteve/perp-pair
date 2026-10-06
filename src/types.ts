export type Venue = 'aster' | 'binance'
export type Side = 'BUY' | 'SELL'
export type PairMode = 'stop' | 'run' | 'reduce'
export type Level = [number, number]
export interface Book { bids: Level[]; asks: Level[]; receivedAt: number; eventAt: number; sequence: number }
export interface Rules {
  symbol: string; base: string; quote: string; step: string; tick: string;
  marketStep: string; timeInForce: string[]; minQty: number; maxQty: number; minNotional: number;
}
export interface Pair {
  id: string; aSymbol: string; bSymbol: string; mode: PairMode;
  orderUsd: number; capUsd: number; openPct: number; closePct: number;
  direction: 'both' | 'longA' | 'shortA'; revision: number;
}
export interface OrderRequest {
  id: string; venue: Venue; symbol: string; side: Side; qty: string;
  kind: 'FOK' | 'MARKET' | 'IOC'; price?: string; reduceOnly: boolean;
}
export interface OrderResult { status: string; qty: number; price: number; quote: number; orderId: string; ackAt: number; rejection?: string; code?: number }
export interface AccountPosition { symbol: string; qty: number; mark: number; unrealized: number; liquidation: number; leverage: number; isolated: boolean }
export interface Account { at: number; available: number; equity: number; positions: AccountPosition[]; oneWay: boolean }
export interface Funding { rate: number; nextTime: number; mark: number }
export interface Income { id: string; symbol: string; amount: number; asset: string; time: number }
export interface Client {
  venue: Venue;
  rules: Map<string, Rules>; books: Map<string, Book>; funding: Map<string, Funding>;
  account?: Account; offsetMs: number;
  init(): Promise<void>; subscribe(symbols: string[]): void; close(): void;
  refreshAccount(): Promise<Account>; refreshFunding(): Promise<void>;
  configure(symbol: string, leverage: number): Promise<void>;
  place(req: OrderRequest): Promise<OrderResult>;
  query(req: OrderRequest): Promise<OrderResult>;
  incomes(start: number, end: number): Promise<Income[]>;
}
export interface Candidate {
  pair: Pair; side: Side; qty: number; qtyText: string; priceText: string;
  aVwap: number; bVwap: number; grossPct: number; netPct: number; closing: boolean;
  at: number; notional: number;
  // Trigger price/spreads precede IOC slippage; limit spreads use the submitted limit.
  signalPriceText?: string; iocSlippagePct?: number; limitGrossPct?: number; limitNetPct?: number;
}
export const terminal = (s: string) => ['FILLED','EXPIRED','EXPIRED_IN_MATCH','CANCELED','REJECTED'].includes(s)
export const opposite = (s: Side): Side => s === 'BUY' ? 'SELL' : 'BUY'
export const sign = (s: Side) => s === 'BUY' ? 1 : -1
