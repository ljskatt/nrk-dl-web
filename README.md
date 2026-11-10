# nrk-dl-web

**Ta den i bruk: [nrk-dl.ljskatt.no](https://nrk-dl.ljskatt.no)**

Arvtakeren til [nrk-dl](https://github.com/ljskatt/nrk-dl). Laster ned programmer og serier fra NRK TV **direkte i nettleseren**, uten noe å installere.

Lovligheten rundt dette er uklar - bruk kun til privat, ikke-kommersiell bruk. [Opphavsrett på NRK](https://www.nrk.no/etikk/opphavsrett-pa-nrk.no-1.2843522)

## Arkitektur

```
nettleser ──(små JSON-kall)──▶ worker/ (Cloudflare Worker) ──▶ psapi.nrk.no
    │
    └──────(video + undertekster, direkte)──────────────────▶ NRK CDN
```

- **`web/`** - statisk Next.js-side (`output: "export"`). Henter HLS-segmenter fra NRK sitt CDN, demuxer TS med [mux.js](https://github.com/videojs/mux.js) og skriver rett til disk med File System Access API (Chrome/Edge). Andre nettlesere får en fil fra minnet.
  - **MP4** (standard): flat MP4 med `moov` på slutten (`src/lib/mp4.ts`). Spilles av overalt, også QuickTime/iOS. Undertekster lagres som `.vtt` ved siden av.
  - **MKV**: video, lyd og undertekster (`S_TEXT/UTF8`) i én fil (`src/lib/mkv.ts`). For VLC, IINA, Plex, Jellyfin og Infuse.
- **`worker/`** - liten proxy for `psapi.nrk.no`, som bare godtar CORS fra NRK sine egne domener og localhost. NRK sitt video-CDN og `undertekst.nrk.no` godtar alle origins, så ingen video går gjennom workeren.

Workeren slipper bare gjennom `GET` mot katalog- og manifeststier, krever `Origin` fra en tillatt side og cacher svar (katalog 1 t, manifest 5 min, aldri «ikke tilgjengelig»-svar).

## Utvikling

```bash
cd worker && npm install && npm run dev      # http://localhost:8787
cd web && npm install && npm run dev         # http://localhost:3000
```

## Deploy

1. **Worker:** sett domenet i `worker/wrangler.toml` (`routes` og `ALLOWED_ORIGINS` under `env.production`), så kjør `cd worker && npx wrangler login && npm run deploy`.
2. **Nettside:** kopier `web/.env.production.example` til `web/.env.production` og sett `NEXT_PUBLIC_API_BASE` til worker-domenet, så kjør `cd web && npm run build`. Last opp `web/out/` til en hvilket som helst webhost.

### Beskytt Workers-kvoten (anbefalt)

Det som stoppes før workeren kjører, teller ikke mot Workers-kvoten (100 000 kall per dag på gratisplanen). Legg derfor workeren på et eget domene i sonen din (ikke `*.workers.dev`) og legg til:

- **Custom Security rule:** Block når `http.host eq "nrk-api.ditt.domene"` and not `http.request.headers["origin"][0] eq "https://nrk.ditt.domene"`
- **Rate limiting rule:** f.eks. 100 kall per 10 s per IP mot worker-domenet
- **Bot Fight Mode:** på

## Begrensninger

- Krypterte (DRM) strømmer og strømmer med separate lydspor støttes ikke.
- Geoblokkert innhold sjekkes mot workerens IP når manifestet hentes.
- NRK kan når som helst endre CORS på CDN-et, og da kan løsningen slutte å virke.

## Lisens

[MIT](LICENSE). Lisensen gjelder koden i dette repoet, ikke innholdet fra NRK.
