const fetch = require("node-fetch");
const {
  RPC_URL, POLL_INTERVAL_MS, STALL_THRESHOLD_CHECKS,
  LATENCY_ALARM_MS, LATENCY_CLEAR_MS, LATENCY_WINDOW_MINUTES, LATENCY_MIN_SAMPLES, SLOW_CALL_MS,
} = require("./config");
const { recordCheck, getUptime, logEvent, recordLatency, getLatencyStats } = require("./db");
const { formatDetailedError } = require("./errors");
const { sendAlert } = require("./telegram");

let lastBlockHeight = null;
let stallCount = 0;
let alertSent = false;
let consecutiveFailures = 0;
let lastHealthy = null; // track state changes
// Separate from `alertSent` on purpose: degradation and hard-down are independent
// conditions, and a shared flag would let one silence the other.
let latencyAlertSent = false;

function getStallCount() { return stallCount; }
function getLastBlockHeight() { return lastBlockHeight; }
function isCurrentlyHealthy() { return lastHealthy; }
function isCurrentlyDegraded() { return latencyAlertSent; }

async function poll() {
  const start = Date.now();
  let blockHeight = null;
  let statusCode = null;
  let isHealthy = false;
  let error = null;

  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
      timeout: 10000,
    });
    statusCode = res.status;
    const data = await res.json();
    if (data.result) {
      blockHeight = parseInt(data.result, 16);
      isHealthy = true;
    } else {
      error = data.error ? JSON.stringify(data.error) : "No result in response";
    }
  } catch (err) {
    error = err.message;
  }

  const responseTime = Date.now() - start;

  if (isHealthy) {
    consecutiveFailures = 0;
  } else {
    consecutiveFailures++;
  }

  // Record every check for uptime calculation
  recordCheck(isHealthy);
  recordLatency(responseTime, isHealthy);

  const uptime = getUptime(24);

  // Log event only on state changes
  if (lastHealthy !== null && lastHealthy !== isHealthy) {
    if (isHealthy) {
      logEvent("recovery", { blockHeight, responseTime, message: "Node back online" });
    } else {
      logEvent("down", { blockHeight, responseTime, statusCode, error });
    }
  }

  // Stall detection
  if (blockHeight !== null && lastBlockHeight !== null) {
    if (blockHeight <= lastBlockHeight) {
      stallCount++;
    } else {
      if (stallCount >= STALL_THRESHOLD_CHECKS && alertSent) {
        logEvent("stall_recovery", { blockHeight, message: `Block advancing again after ${stallCount} stall checks` });
        await sendAlert(`✅ *Nibiru Node Recovered*\nBlock height advancing again: \`${blockHeight}\``, uptime);
        alertSent = false;
      }
      stallCount = 0;
    }
  }

  if (blockHeight !== null) lastBlockHeight = blockHeight;

  if (stallCount >= STALL_THRESHOLD_CHECKS && !alertSent) {
    logEvent("stall", { blockHeight, message: `Block stuck for ${stallCount} checks` });
    await sendAlert(
      `⚠️ *Nibiru Node Stalled*\nBlock height stuck at \`${blockHeight}\` for ${stallCount} consecutive checks (${(stallCount * POLL_INTERVAL_MS) / 1000}s)`,
      uptime
    );
    alertSent = true;
  }

  if (!isHealthy && !alertSent) {
    const detailedMsg = formatDetailedError({ error, statusCode, responseTime, consecutiveFailures });
    await sendAlert(
      detailedMsg || `🔴 *Nibiru Node Down*\nEndpoint: \`${RPC_URL}\`\nError: ${error || "Unknown"}`,
      uptime
    );
    alertSent = true;
  }

  if (isHealthy && alertSent && stallCount < STALL_THRESHOLD_CHECKS) {
    await sendAlert(`✅ *Nibiru Node Back Online*\nBlock height: \`${blockHeight}\``, uptime);
    alertSent = false;
  }

  // --- Degradation alarm ---
  // Fires on rolling p90 over healthy responses, so it catches the case the up/down
  // check is blind to: the node answering every poll, but taking seconds to do it.
  // Hysteresis (fire at LATENCY_ALARM_MS, clear at the lower LATENCY_CLEAR_MS) keeps
  // it from flapping while p90 sits on the threshold.
  const lat = getLatencyStats(LATENCY_WINDOW_MINUTES, SLOW_CALL_MS);
  if (lat && lat.n >= LATENCY_MIN_SAMPLES) {
    if (!latencyAlertSent && lat.p90 >= LATENCY_ALARM_MS) {
      logEvent("degraded", {
        responseTime: lat.p90,
        message: `p90 ${lat.p90}ms over ${LATENCY_WINDOW_MINUTES}m (p99 ${lat.p99}ms, max ${lat.max}ms, ${lat.slowShare}% of calls >= ${SLOW_CALL_MS}ms)`,
      });
      await sendAlert(
        [
          `🟠 *Nibiru Node Degraded*`,
          ``,
          `The node is answering, but slowly. These polls all count as "up", so uptime will look fine.`,
          ``,
          `*Latency (last ${LATENCY_WINDOW_MINUTES}m, ${lat.n} healthy samples)*`,
          `p50: \`${lat.p50}ms\``,
          `p90: \`${lat.p90}ms\`  ← alarm at \`${LATENCY_ALARM_MS}ms\``,
          `p99: \`${lat.p99}ms\``,
          `max: \`${lat.max}ms\``,
          `Slow calls (≥ \`${SLOW_CALL_MS}ms\`): \`${lat.slow}/${lat.n}\` (\`${lat.slowShare}%\`)`,
          `Hard failures in window: \`${lat.failures}\``,
          ``,
          `*Endpoint*`,
          `URL: \`${RPC_URL}\``,
          `Call: \`eth_blockNumber\` (in-memory read, touches no historical state)`,
        ].join("\n"),
        uptime
      );
      latencyAlertSent = true;
    } else if (latencyAlertSent && lat.p90 <= LATENCY_CLEAR_MS) {
      logEvent("degraded_recovery", {
        responseTime: lat.p90,
        message: `p90 back to ${lat.p90}ms over ${LATENCY_WINDOW_MINUTES}m`,
      });
      await sendAlert(
        `🟢 *Nibiru Node Latency Recovered*\np90 back to \`${lat.p90}ms\` over the last ${LATENCY_WINDOW_MINUTES}m (p99 \`${lat.p99}ms\`, max \`${lat.max}ms\`)`,
        uptime
      );
      latencyAlertSent = false;
    }
  }

  lastHealthy = isHealthy;

  const status = isHealthy ? "✓" : "✗";
  const degradedTag = latencyAlertSent ? " DEGRADED" : "";
  console.log(`[${new Date().toISOString()}] ${status} block=${blockHeight} time=${responseTime}ms status=${statusCode} stall=${stallCount}${degradedTag}`);
}

module.exports = { poll, getStallCount, getLastBlockHeight, isCurrentlyHealthy, isCurrentlyDegraded };
