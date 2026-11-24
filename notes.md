# Pump.fun Paper Sprint — catatan kerja

Kontes: u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b ($2, tutup 26 Nov 12:40 WIB).
Harness: pumpfun-replay/v2, modal paper 10 SOL, maks 5 posisi, fee 95+30 bps/sisi,
latency 2 slot, guardrail min 20 koin berbeda + drawdown maks 50%.

## Strategi final (v2, main.ts)
Launch sniper: beli di 3 slot pertama setelah CreateEvent kalau lolos rug filter
(real SOL 0,3–30; creator buy ≤2,5 SOL; maks 3 buyer berbeda; run-up ≤+10% dari
harga create), stake 0,1 SOL (terbatas cap 1% real reserve), exit TP +15% /
SL −12% / max hold 10 slot. TIDAK exit saat creator jual. Slippage 10000 bps.

## Metrik lokal (grade-local --driver process, dev window 24 jam)
- v1 (momentum +20%, slippage 500): PnL −2,02 SOL, win 16,9%, 136 round trip, 320 rejected
- v2 (sniper C1): PnL **−0,066 SOL**, win 3,7%, 135 round trip / 135 koin,
  max drawdown 0,66%, 33 rejected, guardrails MET (53 koin ≥0,01 SOL)
- Stress 5 copy: median −0,07, p10 −0,09, p90 −0,04 SOL — konsisten, tidak overfit ke dev window

## Varian yang dicoba (simulator offline terkalibrasi + grade-local baseline)
- Momentum (beli breakout +5/+10/+20%, TP/SL/trailing/time-stop bervariasi): semua rugi
  (−0,08 s.d. −2,80 SOL di sim); pilot momentum kit: −9,45 SOL (win 6,5%)
- Reversion kit (beli dip): −4,37 SOL
- Sniper pilot kit (default): −0,42 SOL, 343 round trip — keluarga terbaik
- Sniper sim: exit-saat-creator-jual merugikan (−0,39 → −0,09); run-up ≤+10% → −0,01;
  partial TP dan adds: netral; min_buy ≥0,02 SOL: 0 trade (cap 1% reserve mengikat)
- Panel Mistral (mistral-small-latest): aturan entry/sizing/exit awal — diuji semua,
  yang bertahan: sizing kecil + TP 3x/SL 0,5x diganti TP +15%/SL −12% (biaya 1,25%/sisi
  membunuh trade kecil), skip 10 menit pertama diganti jendela 3 slot pertama.

## Repo
- Lokal: ~/workspace/pumpfun-paper-sprint
- GitHub: https://github.com/KenIDN24/pumpfun-paper-sprint
- Commit final: 757bdd514344003d8f2f600caaa4154d487c7eab (master, remote HEAD terverifikasi)
- Catatan jujur: skor dev sedikit negatif (−0,07 SOL) — bot ini nyaris impas dengan
  downside kecil, bukan mesin cuan; final window 6 jam bisa ke mana saja.
