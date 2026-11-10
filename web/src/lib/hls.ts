// HLS-nedlasting og ompakking (TS -> MP4/MKV) som kjører i nettleseren.
// Videoen hentes direkte fra NRK sitt CDN; ingen server er involvert.

// mux.js har ingen typer; vi bruker bare Transmuxer.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import muxjs from "mux.js";
import type { ContainerWriter, SeekableSink } from "./fmp4";

export type Variant = {
  url: string;
  bandwidth: number;
  resolution?: string;
  height: number;
};

export type Sink = SeekableSink & {
  close(): Promise<void>;
  abort(): Promise<void>;
};

export type Progress = { done: number; total: number; bytes: number };

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function parseAttrs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out[m[1]] = m[2].replace(/^"|"$/g, "");
  return out;
}

export async function getVariants(masterUrl: string, signal?: AbortSignal): Promise<Variant[]> {
  const text = await fetchText(masterUrl, signal);
  const lines = text.split(/\r?\n/);
  if (!text.includes("#EXT-X-STREAM-INF")) {
    // Allerede en media-playlist
    return [{ url: masterUrl, bandwidth: 0, height: 0 }];
  }
  if (/#EXT-X-MEDIA:.*TYPE=AUDIO.*URI=/.test(text)) {
    throw new Error("Separate lydspor støttes ikke ennå");
  }
  const variants: Variant[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
    const a = parseAttrs(lines[i].slice("#EXT-X-STREAM-INF:".length));
    let j = i + 1;
    while (j < lines.length && (lines[j].startsWith("#") || !lines[j].trim())) j++;
    const res = a.RESOLUTION;
    variants.push({
      url: new URL(lines[j].trim(), masterUrl).toString(),
      bandwidth: Number(a.BANDWIDTH || 0),
      resolution: res,
      height: res ? Number(res.split("x")[1]) : 0,
    });
  }
  return variants.sort((x, y) => y.bandwidth - x.bandwidth);
}

export async function getSegments(mediaUrl: string, signal?: AbortSignal): Promise<string[]> {
  const text = await fetchText(mediaUrl, signal);
  if (/#EXT-X-KEY:(?!.*METHOD=NONE)/.test(text)) {
    throw new Error("Strømmen er kryptert (DRM/AES) og kan ikke lastes ned");
  }
  if (text.includes("#EXT-X-MAP")) {
    throw new Error("fMP4-strømmer støttes ikke ennå");
  }
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => new URL(l, mediaUrl).toString());
}

async function fetchSegment(url: string, signal?: AbortSignal, tries = 4): Promise<Uint8Array> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (signal?.aborted || attempt >= tries) throw e;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

/**
 * Laster ned alle segmenter (med litt parallellitet, men i riktig rekkefølge),
 * pakker om og skriver fortløpende til `sink`, slik at hele filen aldri
 * trenger å ligge i minnet når sink skriver til disk.
 *
 * mux.js lager fragmentert MP4; `writer` (FlatMp4Writer eller MkvWriter)
 * gjør det om til en vanlig fil som spillere viser riktig lengde på.
 */
export async function downloadHls(
  segments: string[],
  sink: Sink,
  writer: ContainerWriter,
  opts: { concurrency?: number; signal?: AbortSignal; onProgress?: (p: Progress) => void } = {},
): Promise<void> {
  const { concurrency = 6, signal, onProgress } = opts;
  const transmuxer = new muxjs.mp4.Transmuxer({ remux: true });

  let init: Uint8Array | null = null;
  let pending: Uint8Array[] = [];
  transmuxer.on("data", (seg: { initSegment: Uint8Array; data: Uint8Array }) => {
    if (!init) init = new Uint8Array(seg.initSegment);
    pending.push(new Uint8Array(seg.data));
  });

  const inflight = new Map<number, Promise<Uint8Array>>();
  let next = 0;
  const fill = () => {
    while (next < segments.length && inflight.size < concurrency) {
      const p = fetchSegment(segments[next], signal);
      p.catch(() => {}); // håndteres når vi await-er den
      inflight.set(next, p);
      next++;
    }
  };

  let bytes = 0;
  let wroteInit = false;
  try {
    for (let i = 0; i < segments.length; i++) {
      fill();
      const data = await inflight.get(i)!;
      inflight.delete(i);
      fill();

      transmuxer.push(data);
      transmuxer.flush();
      if (init && !wroteInit) {
        await writer.setInit(init);
        wroteInit = true;
      }
      for (const chunk of pending) {
        await writer.addFragments(chunk);
        bytes += chunk.byteLength;
      }
      pending = [];
      onProgress?.({ done: i + 1, total: segments.length, bytes });
    }
    if (!wroteInit) throw new Error("Fant ingen video i strømmen");
    await writer.finish();
    await sink.close();
  } catch (e) {
    await sink.abort().catch(() => {});
    throw e;
  }
}
