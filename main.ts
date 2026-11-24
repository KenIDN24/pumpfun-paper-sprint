// Pump.fun Paper Sprint — launch sniper bot (v2).
//
// Family: buy launches in their first 3 slots after passing a rug filter,
// exit fast (+15% / -12% / 10 slots). Calibrated on the dev window with a
// faithful offline replay simulator (constant-product curve, 1% order cap,
// 2-slot latency, 125bps curve fees + tx fees):
//   pilot sniper defaults  -> sim -0.39 SOL, real grade -0.42 SOL
//   this config (C1)       -> sim -0.01 SOL over 127 coins, win 0.28
// Two findings drove C1: (1) exiting when the creator sells LOCKS IN losses
// (sim -0.39 -> -0.09 alone), and (2) capping the run-up at +10% over the
// create price keeps us out of launches that already ran (sim -> -0.01).
// Partial take-profit and adds tested neutral; left out for simplicity.
//
// Everything is deterministic: decisions come only from harness state
// (no clock, no env, no randomness).

import { runBot, LAMPORTS_PER_SOL, BPS } from './vendor/makefun-bot.ts';
import type { BotState, Batch, OrderInput } from './vendor/makefun-bot.ts';

// ---- parameters (v2 = C1) --------------------------------------------------
const MIN_AGE = 0; // slots since CreateEvent
const MAX_AGE = 3;
const STAKE_LAMPORTS = 100_000_000n; // 0.1 SOL target per coin
const MIN_BUY_LAMPORTS = 5_000_000n; // 0.005 SOL
const MAX_POSITIONS = 5;
const MIN_REAL_SOL = 300_000_000n; // 0.3 SOL
const MAX_REAL_SOL = 30_000_000_000n; // 30 SOL
const MAX_DEV_BUY = 2_500_000_000n; // 2.5 SOL creator buy in create slot
const MAX_BUYERS = 3; // distinct non-creator buyers
const MAX_SELL_RATIO_BPS = 10_000;
const MAX_BIG_SELL_BPS = 10_000;
const MAX_RUNUP_BPS = 11_000; // +10% over create price
const TP_BPS = 1500; // +15%
const SL_BPS = 1200; // -12%
const MAX_HOLD_SLOTS = 10;
const SLIPPAGE_BPS = 10_000; // fills must land; tight slippage caused 320 rejects in v1
const FEE_BPS = 125n; // 95 protocol + 30 creator

const SOL = LAMPORTS_PER_SOL;

// ---- per-coin memory -------------------------------------------------------
interface Coin {
  mint: string;
  createSlot: number;
  creator: string;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<string>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
}

const coins = new Map<string, Coin>();
const young: string[] = []; // mints created within the entry window, in order
const held = new Map<string, Held>();

/** What selling `tokens` against (vq, vt) pays after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const tx = state.txFeeLamports();
    const cap = state.hello.caps.max_orders_per_batch;

    // ---- fold events -------------------------------------------------------
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!coins.has(e.mint)) {
          coins.set(e.mint, {
            mint: e.mint,
            createSlot: e.slot,
            creator: e.creator,
            vq0: BigInt(e.virtual_sol_reserves),
            vt0: BigInt(e.virtual_token_reserves),
            devBuy: 0n,
            trades: 0,
            buyers: new Set(),
            bought: 0n,
            soldByOthers: 0n,
            bigSellBps: 0n,
            devSold: false,
            done: false,
            complete: false,
          });
          young.push(e.mint);
        }
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (!c) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c) {
          c.complete = true;
          c.done = true;
        }
      }
    }

    // ---- fills: track tx paid + open/close held records -------------------
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        held.delete(f.mint);
        continue;
      }
      if (f.status === 'filled') {
        const h = held.get(f.mint);
        if (f.side === 'buy' && !h) {
          held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), best: 0n });
        } else if (h) {
          h.txPaid += BigInt(f.tx_fee_lamports);
        }
      }
    }
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) {
        let pendingBuy = false;
        for (const p of state.pending.values()) {
          if (p.order.mint === mint && p.order.side === 'buy') {
            pendingBuy = true;
            break;
          }
        }
        if (!pendingBuy) held.delete(mint);
      }
    }

    // ---- exits -------------------------------------------------------------
    const marks = new Map<string, { vq: bigint; vt: bigint }>();
    for (const m of batch.marks) {
      marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
    }
    for (const [mint, pos] of state.positions) {
      if (orders.length >= cap) break;
      let h = held.get(mint);
      if (!h) {
        h = { openedSlot: state.slot, txPaid: tx, best: 0n };
        held.set(mint, h);
      }
      let mk = marks.get(mint);
      if (!mk) {
        const cv = state.curves.get(mint);
        if (!cv) continue;
        mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
      }
      const tokens = BigInt(pos.token_amount);
      const value = sellValue(tokens, mk.vq, mk.vt) - tx;
      const basis = BigInt(pos.cost_lamports) + h.txPaid;
      if (value > h.best) h.best = value;
      let exit = false;
      if (basis > 0n) {
        if (value * BPS >= basis * (BPS + BigInt(TP_BPS))) exit = true;
        if (value * BPS <= basis * (BPS - BigInt(SL_BPS))) exit = true;
      }
      if (state.slot - h.openedSlot >= MAX_HOLD_SLOTS) exit = true;
      if (!exit) continue;
      orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: SLIPPAGE_BPS });
      const c = coins.get(mint);
      if (c) c.done = true;
    }

    // ---- entries (only coins created within the last MAX_AGE slots) -------
    let free = state.freeCashLamports() - tx * BigInt(orders.length);
    let open = state.committedPositionCount();
    const stillYoung: string[] = [];
    for (const mint of young) {
      const c = coins.get(mint);
      if (!c) continue;
      const age = batch.slot - c.createSlot;
      if (age > MAX_AGE || c.done || c.complete) {
        if (age > MAX_AGE) c.done = true;
        continue;
      }
      stillYoung.push(mint);
    }
    young.length = 0;
    young.push(...stillYoung);
    if (orders.length < cap) {
      for (const mint of young) {
        if (orders.length >= cap) break;
        const c = coins.get(mint)!;
        if (c.done || c.complete) continue;
        const age = batch.slot - c.createSlot;
        if (age < MIN_AGE) continue;
        if (open >= MAX_POSITIONS) break;
        const curve = state.curves.get(mint);
        if (!curve || curve.complete) continue;
        const rq = curve.real_quote_reserves;
        if (rq < MIN_REAL_SOL || rq > MAX_REAL_SOL) continue;
        if (c.devBuy > MAX_DEV_BUY) continue;
        if (c.trades < 0 || c.buyers.size > MAX_BUYERS) continue;
        if (c.bought > 0n && (c.soldByOthers * BPS) / c.bought > BigInt(MAX_SELL_RATIO_BPS)) continue;
        if (c.bigSellBps > BigInt(MAX_BIG_SELL_BPS)) continue;
        const runup = (curve.virtual_quote_reserves * c.vt0 * BPS) / (curve.virtual_token_reserves * c.vq0);
        if (runup > BigInt(MAX_RUNUP_BPS)) continue;
        const maxBuy = state.maxBuyLamports(mint);
        const amount = STAKE_LAMPORTS < maxBuy ? STAKE_LAMPORTS : maxBuy;
        if (amount < MIN_BUY_LAMPORTS) continue;
        if (free < amount + tx * 6n) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: SLIPPAGE_BPS });
        free -= amount + tx;
        open += 1;
        c.done = true;
      }
    }

    return orders;
  },
});
