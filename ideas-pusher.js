// ideas-pusher.js
// Multi-source ideas pusher for GitHub Actions (Node 20). No external deps.

const TOP_N = parseInt(process.env.TOP_N || "10", 10);
const MIN_24H_QV = parseFloat(process.env.MIN_24H_QV || "10000000"); // $10m
const TTL_SEC = parseInt(process.env.TTL_SEC || "900", 10); // 15 minutes

function log(...args) { console.log("[pusher]", ...args); }

// Normalize rows to {symbol, qv, ch}
function normFromMexc(arr) {
  return arr
    .filter(t => (t.symbol || "").endsWith("USDT"))
    .map(t => ({
      symbol: (t.symbol || "").replace("USDT", ""),
      qv: parseFloat(t.quoteVolume || t.quote_volume || "0"),
      ch: parseFloat(t.priceChangePercent || t.price_change_percent || "0"),
    }));
}

function normFromGate(arr) {
  // Gate returns currency_pair like BTC_USDT
  return arr
    .filter(t => (t.currency_pair || "").endsWith("_USDT"))
    .map(t => ({
      symbol: (t.currency_pair || "").replace("_USDT", ""),
      qv: parseFloat(t.quote_volume || "0"),
      // change_percentage is a string like "1.23"
      ch: parseFloat(t.change_percentage || "0"),
    }));
}

function normFromBinance(arr) {
  return arr
    .filter(t => (t.symbol || "").endsWith("USDT"))
    .map(t => ({
      symbol: (t.symbol || "").replace("USDT", ""),
      qv: parseFloat(t.quoteVolume || "0"),
      ch: parseFloat(t.priceChangePercent || "0"),
    }));
}

async function fetchJson(url) {
  const r = await fetch(url, { method: "GET" });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} ${text.slice(0, 200)}`);
  }
  return r.json();
}

async function getTickersMultiSource() {
  const sources = [
    { name: "mexc", url: "https://api.mexc.com/api/v3/ticker/24hr", norm: normFromMexc },
    { name: "gate", url: "https://api.gateio.ws/api/v4/spot/tickers", norm: normFromGate },
    // Last: Binance (may be restricted on GH); keep as fallback
    { name: "binance", url: "https://api.binance.com/api/v3/ticker/24hr", norm: normFromBinance },
  ];
  let lastErr;
  for (const s of sources) {
    try {
      log("trying source:", s.name);
      const raw = await fetchJson(s.url);
      const rows = Array.isArray(raw) ? raw : (raw?.data || raw?.ticker || raw || []);
      const norm = s.norm(rows);
      if (Array.isArray(norm) && norm.length > 0) {
        log("using source:", s.name, "rows:", norm.length);
        return norm;
      }
    } catch (e) {
      lastErr = e;
      log(`source ${s.name} failed:`, e.message || e);
    }
  }
  throw lastErr || new Error("all sources failed");
}

function pickIdeas(norm) {
  const liquid = norm.filter(x => isFinite(x.qv) && x.qv >= MIN_24H_QV);
  // Blend liquidity (70%) and abs 24h change (30%)
  liquid.sort((a, b) => (b.qv * 0.7 + Math.abs(b.ch) * 1e6 * 0.3) - (a.qv * 0.7 + Math.abs(a.ch) * 1e6 * 0.3));
  const top = liquid.slice(0, TOP_N);
  return top.map((x, i) => ({
    symbol: x.symbol,
    side: (x.ch || 0) >= 0 ? "long" : "short",
    score: 60 + Math.min(40, Math.abs(x.ch || 0)), // crude score 60..100
    rank: i + 1,
    ttl_sec: TTL_SEC,
  }));
}

async function pushToWorker(ideas) {
  const url = process.env.WORKER_PUSH_URL;
  if (!url) throw new Error("WORKER_PUSH_URL not set");
  const headers = { "Content-Type": "application/json" };
  if (process.env.PUSH_TOKEN) headers["Authorization"] = `Bearer ${process.env.PUSH_TOKEN}`;
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(ideas) });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`push failed: HTTP ${r.status} ${txt.slice(0, 200)}`);
  }
}

async function main() {
  try {
    const norm = await getTickersMultiSource();
    const picks = pickIdeas(norm);
    const payload = {
      ts: new Date().toISOString(),
      mode: "normal",
      source: "external_pusher",
      meta: { origin: "github_actions" },
      top_n: picks.length,
      ideas: picks,
    };
    await pushToWorker(payload);
    log("pushed", picks.length, "ideas");
  } catch (e) {
    console.error("ERROR:", e.message || e);
    process.exit(1);
  }
}

main();
