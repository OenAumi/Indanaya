export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });

    // Health check
    if (url.pathname === "/api/health") {
      return json({ ok: true, ts: Date.now() });
    }

    // FEED: hitung trending + cache 30 detik
    if (url.pathname === "/api/feed") {
      const cached = await env.KV_CACHE.get("feed:top");
      if (cached) return json(JSON.parse(cached));

      const base = env.SUPABASE_URL + "/rest/v1";
      const headers = {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`
      };

      // Ambil data dasar
      const [posts, reacts, comms] = await Promise.all([
        fetch(`${base}/posts?select=id,text,region,profession,created_at&order=created_at.desc&limit=200`, { headers }).then(r=>r.json()),
        fetch(`${base}/reactions?select=post_id,kind&limit=10000`, { headers }).then(r=>r.json()),
        fetch(`${base}/comments?select=post_id&limit=10000`, { headers }).then(r=>r.json())
      ]);

      // Skor sederhana: like*1 + comment*2 + share*3 + recency
      const now = Date.now(), map = {};
      for (const r of reacts) { (map[r.post_id] ??= { like:0, share:0, comment:0 }); map[r.post_id][r.kind]++; }
      for (const c of comms) { (map[c.post_id] ??= { like:0, share:0, comment:0 }).comment++; }

      const scored = posts.map(p => {
        const m = map[p.id] ?? { like:0, share:0, comment:0 };
        const ageH = (now - new Date(p.created_at).getTime()) / 3600000;
        const recency = Math.max(0, 100 - ageH);
        return { ...p, metrics: m, score: m.like + 2*m.comment + 3*m.share + recency };
      }).sort((a,b)=> b.score - a.score).slice(0, 100);

      // Simpan ke KV 30 detik
      ctx.waitUntil(env.KV_CACHE.put("feed:top", JSON.stringify(scored), { expirationTtl: 30 }));
      return json(scored);
    }

    // AI: IBM Granite via Replicate (cache 20 menit)
    if (url.pathname === "/api/ai/chat" && request.method === "POST") {
      const { prompt, messages } = await request.json();
      const inPrompt = messages
        ? messages.map(m => `${m.role}: ${m.content}`).join("\n")
        : (prompt || "Ringkas 3 poin netral.");
      const key = "ai:" + await sha1(inPrompt) + ":v1";

      const cached = await env.KV_CACHE.get(key);
      if (cached) return json({ provider: "replicate-cache", text: cached });

      const r = await fetch("https://api.replicate.com/v1/models/ibm-granite/granite-3.3-8b-instruct/predictions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json",
          "Prefer": "wait=30"
        },
        body: JSON.stringify({ input: { prompt: inPrompt } })
      });

      if (!r.ok) {
        const detail = await r.text();
        return json({ error: "replicate_error", detail }, 502);
      }

      const data = await r.json();
      const text = typeof data.output === "string"
        ? data.output
        : Array.isArray(data.output) ? data.output.join("") : (data.output?.text || JSON.stringify(data.output));

      // Cache 20 menit (hemat biaya)
      ctx.waitUntil(env.KV_CACHE.put(key, text, { expirationTtl: 60 * 20 }));
      return json({ provider: "replicate-granite", text });
    }

    return new Response("Not Found", { status: 404, headers: cors() });
  }
};

// util
function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization",
    "X-Content-Type-Options": "nosniff"
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors() } });
}
async function sha1(s) {
  const buf = new TextEncoder().encode(s);
  const h = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2,"0")).join("");
}
