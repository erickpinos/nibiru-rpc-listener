const Database = require("better-sqlite3");
const path = require("path");
const { LATENCY_RETENTION_DAYS } = require("./config");

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, "..", "data", "watcher.db");
const fs = require("fs");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      type TEXT NOT NULL,
      block_height INTEGER,
      response_time_ms INTEGER,
      status_code INTEGER,
      error TEXT,
      message TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS uptime_buckets (
      hour TEXT PRIMARY KEY,
      healthy INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0
    )
  `);

  // USDC.e peg readings: escrow (ERC-20 held by EVM module) vs bank-mirror supply.
  // Amounts stored as TEXT micro-units (BigInt-safe).
  db.exec(`
    CREATE TABLE IF NOT EXISTS peg_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      escrow TEXT NOT NULL,
      mirror TEXT NOT NULL,
      drift TEXT NOT NULL,
      healthy INTEGER NOT NULL
    )
  `);

  // Per-poll response times. Uptime buckets only count up/down, which hides the
  // "answers, but takes 8 seconds" failure mode entirely. See LATENCY_ALARM_MS.
  db.exec(`
    CREATE TABLE IF NOT EXISTS latency_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      response_time_ms INTEGER NOT NULL,
      healthy INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_latency_ts ON latency_samples (timestamp)`);

  // Prepare statements after tables exist
  stmts.upsertBucket = db.prepare(`
    INSERT INTO uptime_buckets (hour, healthy, total)
    VALUES (?, ?, 1)
    ON CONFLICT(hour) DO UPDATE SET
      healthy = healthy + excluded.healthy,
      total = total + 1
  `);
  stmts.insertEvent = db.prepare(`
    INSERT INTO events (type, block_height, response_time_ms, status_code, error, message)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmts.insertPeg = db.prepare(`
    INSERT INTO peg_readings (escrow, mirror, drift, healthy)
    VALUES (?, ?, ?, ?)
  `);
  stmts.insertLatency = db.prepare(`
    INSERT INTO latency_samples (response_time_ms, healthy) VALUES (?, ?)
  `);

  console.log("SQLite database ready");
}

const stmts = {};

function recordCheck(isHealthy) {
  const hour = new Date().toISOString().slice(0, 13);
  stmts.upsertBucket.run(hour, isHealthy ? 1 : 0);
}

function getUptime(intervalHours) {
  const since = new Date(Date.now() - intervalHours * 3600000).toISOString().slice(0, 13);
  const row = db.prepare(`
    SELECT COALESCE(SUM(healthy), 0) AS healthy, COALESCE(SUM(total), 0) AS total
    FROM uptime_buckets WHERE hour >= ?
  `).get(since);
  if (row.total === 0) return null;
  return parseFloat(((row.healthy / row.total) * 100).toFixed(2));
}

function logEvent(type, { blockHeight = null, responseTime = null, statusCode = null, error = null, message = null } = {}) {
  stmts.insertEvent.run(type, blockHeight, responseTime, statusCode, error, message);
}

function getRecentEvents(limit = 10) {
  return db.prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ?`).all(limit);
}

// Time-window queries must compare against datetime(), never a JS toISOString().
// `events`/`peg_readings`/`latency_samples` timestamps default to SQLite's
// datetime('now') format 'YYYY-MM-DD HH:MM:SS'; ISO uses a 'T' separator, and since
// ' ' (0x20) sorts before 'T' (0x54), string-comparing the two shifts the effective
// cutoff by up to a full day on same-date rows. (`uptime_buckets.hour` is the
// exception: it is written as an ISO slice, so it keeps the ISO comparison.)
function getErrorEvents(hours = 24) {
  return db.prepare(`
    SELECT error, COUNT(*) AS count, MAX(timestamp) AS last_seen
    FROM events
    WHERE error IS NOT NULL AND timestamp >= datetime('now', ?)
    GROUP BY error ORDER BY count DESC
  `).all(`-${hours} hours`);
}

function getErrorDetail(n = 1) {
  return db.prepare(`
    SELECT * FROM events WHERE error IS NOT NULL ORDER BY id DESC LIMIT ? OFFSET ?
  `).get(1, n - 1);
}

function recordLatency(responseTimeMs, isHealthy) {
  stmts.insertLatency.run(responseTimeMs, isHealthy ? 1 : 0);
}

// Rolling latency stats over the last `minutes`. Percentiles cover healthy samples
// only: a short-circuited 504 comes back in ~1 RTT and would pull p90 down, hiding
// the stall that triggered it. Failures are reported separately in `failures`.
// Uses SQLite-native datetime() comparison rather than a JS ISO string: SQLite writes
// 'YYYY-MM-DD HH:MM:SS' and ISO uses 'T', so string-comparing the two silently drops
// same-date rows.
function getLatencyStats(minutes = 60, slowMs = 1000) {
  const window = `-${minutes} minutes`;
  const rows = db.prepare(`
    SELECT response_time_ms AS ms FROM latency_samples
    WHERE healthy = 1 AND timestamp >= datetime('now', ?)
    ORDER BY response_time_ms ASC
  `).all(window);
  const totals = db.prepare(`
    SELECT COUNT(*) AS samples, COALESCE(SUM(1 - healthy), 0) AS failures
    FROM latency_samples WHERE timestamp >= datetime('now', ?)
  `).get(window);

  if (rows.length === 0) {
    return { n: 0, samples: totals.samples, failures: totals.failures, p50: null, p90: null, p99: null, max: null, slow: 0, slowShare: null };
  }

  const ms = rows.map((r) => r.ms);
  const pct = (p) => ms[Math.min(ms.length - 1, Math.floor((ms.length - 1) * p))];
  const slow = ms.filter((v) => v >= slowMs).length;

  return {
    n: ms.length,
    samples: totals.samples,
    failures: totals.failures,
    p50: pct(0.5),
    p90: pct(0.9),
    p99: pct(0.99),
    max: ms[ms.length - 1],
    slow,
    slowShare: parseFloat(((slow / ms.length) * 100).toFixed(1)),
  };
}

function recordPeg(escrow, mirror, drift, healthy) {
  stmts.insertPeg.run(String(escrow), String(mirror), String(drift), healthy ? 1 : 0);
}

function getLatestPeg() {
  return db.prepare(`SELECT * FROM peg_readings ORDER BY id DESC LIMIT 1`).get();
}

function cleanup() {
  // Keep 30 days of events, uptime buckets, and peg readings.
  // events/peg_readings use datetime() comparison for the reason documented above
  // getErrorEvents(); with the old ISO cutoff this DELETE over-deleted, discarding up
  // to a day of rows that were still inside the retention window.
  // uptime_buckets.hour is an ISO slice, so it correctly keeps the ISO cutoff.
  const cutoffHour = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 13);
  db.prepare(`DELETE FROM events WHERE timestamp < datetime('now', '-30 days')`).run();
  db.prepare(`DELETE FROM uptime_buckets WHERE hour < ?`).run(cutoffHour);
  db.prepare(`DELETE FROM peg_readings WHERE timestamp < datetime('now', '-30 days')`).run();
  // Latency samples are per-poll (~2,880/day at a 30s interval), so they get their
  // own shorter retention.
  db.prepare(`DELETE FROM latency_samples WHERE timestamp < datetime('now', ?)`).run(`-${LATENCY_RETENTION_DAYS} days`);
}

function close() {
  db.close();
}

module.exports = { initDb, recordCheck, getUptime, logEvent, getRecentEvents, getErrorEvents, getErrorDetail, recordLatency, getLatencyStats, recordPeg, getLatestPeg, cleanup, close };
