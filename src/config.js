const RPC_URL = process.env.RPC_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);
const STALL_THRESHOLD_CHECKS = parseInt(process.env.STALL_THRESHOLD_CHECKS || "5", 10);

// --- Latency / degradation alarm ---
// Up-vs-down misses the dominant failure mode on the archive endpoint: the node
// answers, but slowly. Measured 2026-07-27 over 300 samples, eth_blockNumber (an
// in-memory read that touches no historical state): archive p90 1.88s / p99 8.50s /
// max 11.46s, with 14% of SUCCESSFUL calls over 1s. The pruned node behind the same
// gateway held p99 349ms / max 426ms and never failed. Every one of those slow calls
// counts as "up" in the uptime buckets, which is why uptime read 98% while the
// endpoint was degraded roughly a sixth of the time.
// Percentiles are computed over HEALTHY samples only: a hard failure returns fast
// (nginx short-circuits an ejected upstream in ~1 RTT) and would drag p90 down,
// masking the degradation it was caused by.
const LATENCY_ALARM_MS = parseInt(process.env.LATENCY_ALARM_MS || "1000", 10); // fire when rolling p90 >= this
const LATENCY_CLEAR_MS = parseInt(process.env.LATENCY_CLEAR_MS || "600", 10); // clear when p90 <= this (hysteresis, stops flapping at the edge)
const LATENCY_WINDOW_MINUTES = parseInt(process.env.LATENCY_WINDOW_MINUTES || "15", 10);
const LATENCY_MIN_SAMPLES = parseInt(process.env.LATENCY_MIN_SAMPLES || "20", 10); // don't alarm on thin data
const SLOW_CALL_MS = parseInt(process.env.SLOW_CALL_MS || "1000", 10); // a "slow call" for the degraded-share stat
const LATENCY_RETENTION_DAYS = parseInt(process.env.LATENCY_RETENTION_DAYS || "7", 10);

// --- USDC.e peg check (FunToken escrow vs bank-mirror supply) ---
// The EVM module account escrows the real ERC-20 USDC.e; the bank module mints a
// 1:1 mirror denom (erc20/<addr>). Invariant: escrow >= mirror supply. A breach
// (escrow < supply) means bank coins exist that aren't backed — a real exploit signal.
// Decoupled from RPC_URL on purpose: the peg must verify even when the monitored node
// is the one under stress. Defaults are mainnet public endpoints; override via env.
const LCD_URL = process.env.LCD_URL || "https://lcd.nibiru.fi";
const PEG_RPC_URL = process.env.PEG_RPC_URL || "https://evm-rpc.nibiru.fi";
const USDCE_ERC20 = process.env.USDCE_ERC20 || "0x0829F361A05D993d5CEb035cA6DF3446b060970b";
const EVM_MODULE_ADDR = process.env.EVM_MODULE_ADDR || "0x603871c2ddd41c26ee77495e2e31e6de7f9957e0";
const BANK_MIRROR_DENOM = process.env.BANK_MIRROR_DENOM || `erc20/${USDCE_ERC20}`;
const PEG_DECIMALS = parseInt(process.env.PEG_DECIMALS || "6", 10);
const PEG_CHECK_INTERVAL_MS = parseInt(process.env.PEG_CHECK_INTERVAL_MS || "86400000", 10); // 24h
const PEG_TOLERANCE_MICRO = BigInt(process.env.PEG_TOLERANCE_MICRO || "0"); // allowed escrow-shortfall before alert
const PEG_HEARTBEAT = process.env.PEG_HEARTBEAT !== "false"; // send the daily peg status even when healthy; set "false" to only alert on breach

module.exports = {
  RPC_URL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  POLL_INTERVAL_MS,
  STALL_THRESHOLD_CHECKS,
  LATENCY_ALARM_MS,
  LATENCY_CLEAR_MS,
  LATENCY_WINDOW_MINUTES,
  LATENCY_MIN_SAMPLES,
  SLOW_CALL_MS,
  LATENCY_RETENTION_DAYS,
  LCD_URL,
  PEG_RPC_URL,
  USDCE_ERC20,
  EVM_MODULE_ADDR,
  BANK_MIRROR_DENOM,
  PEG_DECIMALS,
  PEG_CHECK_INTERVAL_MS,
  PEG_TOLERANCE_MICRO,
  PEG_HEARTBEAT,
};
