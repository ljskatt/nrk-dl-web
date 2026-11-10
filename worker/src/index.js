/**
 * nrk-web psapi proxy
 *
 * Videresender et lite, fast sett med GET-kall til psapi.nrk.no og legger på
 * CORS-headere for våre egne domener. Selve videoen går aldri gjennom her -
 * nettleseren henter den direkte fra NRK sitt CDN.
 */

const UPSTREAM = "https://psapi.nrk.no";

// Kun disse stiene slippes gjennom. Alt annet gir 404.
// ttl = sekunder i Cloudflare-cache og i nettleserens HTTP-cache.
const ROUTES = [
  { re: /^\/tv\/catalog\/series\/[\w-]+$/i, ttl: 3600 },
  { re: /^\/tv\/catalog\/series\/[\w-]+\/seasons\/[\w-]+$/i, ttl: 3600 },
  { re: /^\/tv\/catalog\/series\/[\w-]+\/extramaterial$/i, ttl: 3600 },
  { re: /^\/tv\/catalog\/programs\/[a-z0-9]+$/i, ttl: 3600 },
  { re: /^\/playback\/manifest\/program\/[a-z0-9]+$/i, ttl: 3600, manifest: true },
];

// Query-parametre vi tillater (paginering). Resten fjernes, så cachen ikke kan
// fylles med tilfeldige varianter.
const ALLOWED_QUERY = new Set(["page", "pageSize"]);

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(status, body, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(origin ? corsHeaders(origin) : {}),
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const origins = allowedOrigins(env);
    const originOk = origin && origins.includes(origin);

    // Ingen gyldig Origin = ikke vår side. Bots, curl, skannere osv.
    if (!originOk) return json(403, { error: "forbidden" });

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET") return json(405, { error: "method not allowed" }, origin);

    const route = ROUTES.find((r) => r.re.test(url.pathname));
    if (!route) return json(404, { error: "not found" }, origin);

    const upstream = new URL(url.pathname, UPSTREAM);
    for (const [k, v] of url.searchParams) {
      if (ALLOWED_QUERY.has(k)) upstream.searchParams.set(k, v);
    }
    upstream.searchParams.sort();

    // Cache-nøkkel uten origin: samme svar deles av alle, CORS legges på etterpå.
    const cache = caches.default;
    const cacheKey = new Request(upstream.toString(), { method: "GET" });

    let res = await cache.match(cacheKey);
    let cacheStatus = "HIT";

    if (!res) {
      cacheStatus = "MISS";
      const up = await fetch(upstream.toString(), {
        headers: { Accept: "application/json", "User-Agent": "nrk-web-proxy" },
      });
      const body = await up.text();

      let cacheable = up.ok;
      let ttl = route.ttl;
      if (cacheable && route.manifest) {
        // Ikke cache "ikke tilgjengelig"-svar (geoblokkering, rettigheter o.l.),
        // og ikke cache forbi tidspunktet rettighetene går ut.
        try {
          const m = JSON.parse(body);
          cacheable = m.playability === "playable";
          const until = Date.parse(m.availability?.onDemand?.to);
          if (cacheable && !Number.isNaN(until)) {
            ttl = Math.min(ttl, Math.floor((until - Date.now()) / 1000));
            cacheable = ttl > 0;
          }
        } catch {
          cacheable = false;
        }
      }

      res = new Response(body, {
        status: up.status,
        headers: {
          "Content-Type": up.headers.get("Content-Type") || "application/json; charset=utf-8",
          "Cache-Control": cacheable ? `public, max-age=${ttl}` : "no-store",
        },
      });
      if (cacheable) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }

    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(corsHeaders(origin))) out.headers.set(k, v);
    out.headers.set("X-Proxy-Cache", cacheStatus);
    return out;
  },
};
