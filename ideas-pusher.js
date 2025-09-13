// ideas-pusher.js
// Minimal external pusher: fetch Binance 24h tickers, rank, and push picks to your Worker.

function pickIdeasFromTickers(tickers) {
  const usdt = tickers.filter(t => (t.symbol || "").endsWith("USDT"));
  const liquid = usdt
    .map(t => ({
      symbol: String(t.symbol || "").replace("USDT",""),
      qv: parseFloat(t.quoteVolume || "0"),
      ch: parseFloat(t.priceChangePercent || "0")
    }))
    .filter(x => x.qv > 10_000_000);

  // Simple blend of liquidity and absolute change
  liquid.sort((a,b) => (b.qv*0.7 + Math.abs(b.ch)*1e6*0.3) - (a.qv*0.7 + Math.abs(a.ch)*1e6*0.3));

  const N = 10;
  return liquid.slice(0, N).map((x, i) => ({
    symbol: x.symbol,
    side: x.ch >= 0 ? "long" : "short",
    score: 60 + Math.min(40, Math.abs(x.ch)), // crude score
    rank: i + 1,
    ttl_sec: 900
  }));
}

async function main() {
  const pushUrl = process.env.WORKER_PUSH_URL;
  if (!pushUrl) {
    console.error("WORKER_PUSH_URL is not set");
    process.exit(1);
  }

  // 1) fetch tickers
  const r = await fetch("https://api.binance.com/api/v3/ticker/24hr", { method: "GET" });
  if (!r.ok) {
    console.error("binance 24hr failed:", r.status, await r.text());
    process.exit(1);
  }
  const tickers = await r.json();

  // 2) score + pick top-N
  const picks = pickIdeasFromTickers(tickers);

  // 3) build ideas payload
  const ideas = {
    ts: new Date().toISOString(),
    mode: "normal",
    source: "external_pusher",
    meta: { origin: "github_actions" },
    top_n: picks.length,
    ideas: picks
  };

  // 4) push to worker
  const headers = { "Content-Type": "application/json" };
  if (process.env.PUSH_TOKEN) headers["Authorization"] = `Bearer ${process.env.PUSH_TOKEN}`;

  const resp = await fetch(pushUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(ideas)
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error("push failed:", resp.status, txt);
    process.exit(1);
  }
  console.log("pushed", picks.length, "ideas at", ideas.ts);
}

main().catch(e => { console.error(e); process.exit(1); });
