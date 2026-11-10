// Klient for psapi via vår egen proxy (worker/).

export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8787").replace(/\/$/, "");

export type Episode = {
  prfId: string;
  title: string;
  subtitle?: string;
  season: string; // "00" = ekstramateriale/ukjent
  seasonTitle: string;
  episodeNumber?: number;
  durationSeconds?: number;
  available: boolean;
  image?: string;
};

export type Show = {
  kind: "series" | "program";
  id: string;
  title: string;
  image?: string;
  /** "poster" = stående 2:3, "wide" = 16:9 */
  imageShape: "poster" | "wide";
  seasons: { name: string; title: string; episodes: Episode[] }[];
};

export type Manifest = {
  playable: boolean;
  reason?: string;
  hlsUrl?: string;
  encrypted?: boolean;
  subtitles: {
    language: string;
    label: string;
    url: string;
    /** "ttv" = tekst på all tale (hørselshemmede), "nor" = oversettelse */
    type?: string;
    defaultOn?: boolean;
  }[];
};

type Img = { url: string; width: number }[] | undefined;
const biggest = (img: Img, max = 960) =>
  img?.filter((i) => i.width <= max).sort((a, b) => b.width - a.width)[0]?.url ?? img?.[0]?.url;

async function api<T>(path: string): Promise<T | null> {
  const res = await fetch(API_BASE + path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API-feil ${res.status} for ${path}`);
  return res.json();
}

/** Godtar URL fra tv.nrk.no, et serie-slug eller en program-ID (prfId). */
export function parseInput(input: string): { kind: "series" | "program" | "auto"; id: string } | null {
  const s = input.trim();
  if (!s) return null;
  const prf = s.match(/\b([A-Z]{4}\d{8})\b/i);
  try {
    const u = new URL(s.includes("://") ? s : `https://${s}`);
    if (u.hostname.endsWith("nrk.no")) {
      const parts = u.pathname.split("/").filter(Boolean);
      if (prf) return { kind: "program", id: prf[1].toUpperCase() };
      const i = parts.findIndex((p) => p === "serie" || p === "program");
      if (i >= 0 && parts[i + 1]) return { kind: parts[i] === "serie" ? "series" : "program", id: parts[i + 1] };
    }
  } catch {
    /* ikke en URL */
  }
  if (prf) return { kind: "program", id: prf[1].toUpperCase() };
  if (/^[\w-]+$/.test(s)) return { kind: "auto", id: s.toLowerCase() };
  return null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toEpisode(raw: any, season: string, seasonTitle: string): Episode {
  return {
    prfId: raw.prfId,
    title: raw.titles?.title ?? raw.prfId,
    subtitle: raw.titles?.subtitle,
    season,
    seasonTitle,
    episodeNumber: raw.sequenceNumber,
    durationSeconds: raw.durationInSeconds,
    available: raw.availability?.status ? raw.availability.status === "available" : true,
    image: biggest(raw.image, 600),
  };
}

export async function loadShow(input: string): Promise<Show> {
  const parsed = parseInput(input);
  if (!parsed) throw new Error("Skjønte ikke input - lim inn en lenke fra tv.nrk.no, et serienavn eller en program-ID");

  if (parsed.kind !== "program") {
    const series = await api<any>(`/tv/catalog/series/${encodeURIComponent(parsed.id)}`);
    if (series) {
      const kindKey = series.seriesType as string; // "sequential" | "standard" | "news"
      const meta = series[kindKey] ?? series.sequential ?? series.standard ?? series.news ?? {};
      const seasonLinks: { name: string; title?: string }[] = series._links?.seasons ?? [];
      const seasons = await Promise.all(
        seasonLinks.map(async (s) => {
          const data = await api<any>(
            `/tv/catalog/series/${encodeURIComponent(parsed.id)}/seasons/${encodeURIComponent(s.name)}`,
          );
          const title = s.title ?? data?.titles?.title ?? `Sesong ${s.name}`;
          const raw = [...(data?._embedded?.episodes ?? []), ...(data?._embedded?.instalments ?? [])];
          return { name: s.name, title, episodes: raw.map((e) => toEpisode(e, s.name, title)) };
        }),
      );
      // 16:9-bilde som standard; ellers plakat fra serien eller første sesong som har en.
      const wide = biggest(meta.image, 600);
      const seasonPoster = (series._embedded?.seasons ?? []).find((s: any) => s.posterImage?.length)?.posterImage;
      const poster = biggest(meta.posterImage, 600) ?? biggest(seasonPoster, 600);
      return {
        kind: "series",
        id: parsed.id,
        title: meta.titles?.title ?? parsed.id,
        image: wide ?? poster,
        imageShape: wide ? "wide" : "poster",
        seasons,
      };
    }
    if (parsed.kind === "series") throw new Error(`Fant ikke serien «${parsed.id}»`);
  }

  const prog = await api<any>(`/tv/catalog/programs/${encodeURIComponent(parsed.id.toUpperCase())}`);
  if (!prog) throw new Error(`Fant ikke «${parsed.id}»`);
  const pi = prog.programInformation ?? {};
  const prfId = parsed.id.toUpperCase();
  const ep: Episode = {
    prfId,
    title: pi.titles?.title ?? prfId,
    subtitle: pi.titles?.subtitle,
    season: "00",
    seasonTitle: "",
    available: true,
    image: biggest(pi.image, 600),
  };
  return { kind: "program", id: prfId, title: ep.title, image: ep.image, imageShape: "wide", seasons: [{ name: "00", title: "", episodes: [ep] }] };
}

export async function getManifest(prfId: string): Promise<Manifest> {
  const m = await api<any>(`/playback/manifest/program/${encodeURIComponent(prfId)}`);
  if (!m) return { playable: false, reason: "Fant ikke manifest", subtitles: [] };
  if (m.playability !== "playable") {
    return { playable: false, reason: m.nonPlayable?.endUserMessage ?? m.nonPlayable?.reason ?? "Ikke tilgjengelig", subtitles: [] };
  }
  const asset = (m.playable?.assets ?? []).find((a: any) => a.format === "HLS");
  return {
    playable: !!asset,
    reason: asset ? undefined : "Fant ingen HLS-strøm",
    hlsUrl: asset?.url,
    encrypted: asset ? asset.encrypted || (asset.encryptionScheme && asset.encryptionScheme !== "none") : undefined,
    subtitles: (m.playable?.subtitles ?? [])
      .filter((s: any) => s.webVtt)
      .map((s: any) => ({ language: s.language, label: s.label, url: s.webVtt, type: s.type, defaultOn: !!s.defaultOn })),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export const clean = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim();

/** Mappesti i Plex/Jellyfin-stil: «Serie/Season 01» */
export function folderPath(show: Show, ep: Episode): string[] {
  if (show.kind === "program") return [];
  const season = /^\d+$/.test(ep.season) ? `Season ${ep.season.padStart(2, "0")}` : clean(ep.seasonTitle || ep.season);
  return [clean(show.title), ep.season === "00" ? "Specials" : season];
}

/** Filnavn i Plex/Jellyfin-stil: «Serie - S01E02 - Tittel» */
export function fileBase(show: Show, ep: Episode): string {
  if (show.kind === "program") return clean(ep.title);
  const sn = /^\d+$/.test(ep.season) ? ep.season.padStart(2, "0") : ep.season;
  const en = ep.episodeNumber != null ? String(ep.episodeNumber).padStart(2, "0") : "";
  const title = ep.title.replace(/^\d+\.\s*/, "");
  return clean(`${show.title} - S${sn}E${en} - ${title}`);
}
