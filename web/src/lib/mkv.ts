// Matroska (MKV)-skriver: video + lyd fra mux.js sine fMP4-fragmenter, pluss
// undertekster som egne spor (S_TEXT/UTF8, samme som SRT).
//
// Layout:
//   EBML | Segment( [Void→SeekHead] Info Tracks Cluster* Cues )
//
// Klynger (én per HLS-segment, ~5 s) bygges i minnet og skrives fortløpende.
// Til slutt skrives Cues (søkeindeks), og SeekHead, varighet og
// segmentstørrelse rettes opp med writeAt.

import { type ContainerWriter, type InitTrack, type SeekableSink, parseFragments, parseInit } from "./fmp4";
import type { Cue } from "./vtt";

export type MkvSubtitle = {
  cues: Cue[];
  /** BCP 47, f.eks. "nb" */
  language?: string;
  name?: string;
  default?: boolean;
  hearingImpaired?: boolean;
};

// ---------- EBML ----------

const ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Title: 0x7ba9,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagDefault: 0x88,
  FlagLacing: 0x9c,
  FlagHearingImpaired: 0x55ab,
  Name: 0x536e,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  Void: 0xec,
} as const;

const enc = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.byteLength;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

function idBytes(id: number): Uint8Array {
  const n = id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (id >>> (8 * (n - 1 - i))) & 0xff;
  return out;
}

/** EBML variabel-lengde størrelse. `width` tvinger antall byte (for patching). */
function vint(value: number, width?: number): Uint8Array {
  let n = width ?? 1;
  if (!width) while (n < 8 && value >= 2 ** (7 * n) - 1) n++;
  const out = new Uint8Array(n);
  // Vanlig tallaritmetikk holder (filer < 2^53 byte)
  let v = value;
  for (let i = n - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 1 << (8 - n);
  return out;
}

function el(id: number, ...payload: Uint8Array[]): Uint8Array {
  const data = concat(payload);
  return concat([idBytes(id), vint(data.byteLength), data]);
}

function uint(id: number, value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value;
  do {
    bytes.unshift(v % 256);
    v = Math.floor(v / 256);
  } while (v > 0);
  return el(id, new Uint8Array(bytes));
}

function float(id: number, value: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, value);
  return el(id, b);
}

const str = (id: number, s: string) => el(id, enc.encode(s));

/** Void-element med eksakt total størrelse (minst 2 byte). */
function voidEl(total: number): Uint8Array {
  const sizeLen = total - 2 <= 126 ? 1 : 2;
  const payload = total - 1 - sizeLen;
  return concat([idBytes(ID.Void), vint(payload, sizeLen), new Uint8Array(payload)]);
}

function blockHeader(track: number, rel: number, flags: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = 0x80 | track; // tracknummer som 1-byte vint (< 127)
  new DataView(b.buffer).setInt16(1, rel);
  b[3] = flags;
  return b;
}

// ---------- Skriver ----------

const SEEKHEAD_RESERVE = 200;
const MAX_CLUSTER_SPAN = 30_000; // ms, relativ tid i en blokk er int16

type Block = { track: number; ts: number; order: number; key: boolean; data: Uint8Array; duration?: number };

export class MkvWriter implements ContainerWriter {
  private sink: SeekableSink;
  private subs: MkvSubtitle[];
  private title?: string;

  private position = 0;
  private segmentSizePos = 0;
  private segmentStart = 0; // posisjon der segmentets innhold starter
  private durationPos = 0;
  private infoPos = 0;
  private tracksPos = 0;

  private trackMap = new Map<number, { number: number; info: InitTrack }>();
  private videoTrack = 0;
  private pendingSubs: { track: number; cue: Cue }[] = [];
  private cuePoints: { time: number; track: number; pos: number }[] = [];
  private endMs = 0;

  constructor(sink: SeekableSink, opts: { subtitles?: MkvSubtitle[]; title?: string } = {}) {
    this.sink = sink;
    this.subs = (opts.subtitles ?? []).filter((s) => s.cues.length);
    this.title = opts.title;
  }

  private async write(b: Uint8Array) {
    await this.sink.write(b);
    this.position += b.byteLength;
  }

  async setInit(initSegment: Uint8Array) {
    const info = parseInit(initSegment);
    // Video først, så lyd - tracknummer 1, 2, ..
    const media = [
      ...info.tracks.filter((t) => t.kind === "video"),
      ...info.tracks.filter((t) => t.kind === "audio"),
    ];
    media.forEach((t, i) => this.trackMap.set(t.id, { number: i + 1, info: t }));
    this.videoTrack = media.find((t) => t.kind === "video") ? 1 : 0;
    const firstSub = media.length + 1;
    this.subs.forEach((s, i) => {
      for (const cue of s.cues) this.pendingSubs.push({ track: firstSub + i, cue });
    });
    this.pendingSubs.sort((a, b) => a.cue.start - b.cue.start);

    await this.write(
      el(
        ID.EBML,
        uint(ID.EBMLVersion, 1),
        uint(ID.EBMLReadVersion, 1),
        uint(ID.EBMLMaxIDLength, 4),
        uint(ID.EBMLMaxSizeLength, 8),
        str(ID.DocType, "matroska"),
        uint(ID.DocTypeVersion, 4),
        uint(ID.DocTypeReadVersion, 2),
      ),
    );

    // Segment med 8-byte størrelse som rettes opp til slutt
    await this.write(idBytes(ID.Segment));
    this.segmentSizePos = this.position;
    await this.write(vint(0, 8));
    this.segmentStart = this.position;

    await this.write(voidEl(SEEKHEAD_RESERVE));

    const infoEl = el(
      ID.Info,
      uint(ID.TimestampScale, 1_000_000), // 1 ms
      ...(this.title ? [str(ID.Title, this.title)] : []),
      str(ID.MuxingApp, "nrk-web"),
      str(ID.WritingApp, "nrk-web"),
      float(ID.Duration, 0),
    );
    this.infoPos = this.position;
    // Duration ligger sist i Info: 8 byte float helt på slutten
    this.durationPos = this.position + infoEl.byteLength - 8;
    await this.write(infoEl);

    const entries: Uint8Array[] = [];
    for (const { number, info: t } of this.trackMap.values()) {
      const common = [
        uint(ID.TrackNumber, number),
        uint(ID.TrackUID, number),
        uint(ID.FlagLacing, 0),
        str(ID.Language, "und"),
      ];
      if (t.kind === "video") {
        if (t.codec !== "avc1" || !t.codecPrivate) throw new Error(`Videokodek ${t.codec} støttes ikke i MKV`);
        entries.push(
          el(
            ID.TrackEntry,
            ...common,
            uint(ID.TrackType, 1),
            str(ID.CodecID, "V_MPEG4/ISO/AVC"),
            el(ID.CodecPrivate, t.codecPrivate),
            el(ID.Video, uint(ID.PixelWidth, t.width ?? 0), uint(ID.PixelHeight, t.height ?? 0)),
          ),
        );
      } else {
        if (t.codec !== "mp4a" || !t.codecPrivate) throw new Error(`Lydkodek ${t.codec} støttes ikke i MKV`);
        entries.push(
          el(
            ID.TrackEntry,
            ...common,
            uint(ID.TrackType, 2),
            str(ID.CodecID, "A_AAC"),
            el(ID.CodecPrivate, t.codecPrivate),
            el(ID.Audio, float(ID.SamplingFrequency, t.sampleRate ?? 48000), uint(ID.Channels, t.channels ?? 2)),
          ),
        );
      }
    }
    this.subs.forEach((s, i) => {
      const lang = s.language || "und";
      entries.push(
        el(
          ID.TrackEntry,
          uint(ID.TrackNumber, firstSub + i),
          uint(ID.TrackUID, firstSub + i),
          uint(ID.TrackType, 0x11),
          uint(ID.FlagLacing, 0),
          uint(ID.FlagDefault, s.default ? 1 : 0),
          ...(s.hearingImpaired ? [uint(ID.FlagHearingImpaired, 1)] : []),
          str(ID.CodecID, "S_TEXT/UTF8"),
          // Eldre spillere leser ISO 639-2, nyere BCP 47
          str(ID.Language, iso6392(lang)),
          str(ID.LanguageBCP47, lang),
          ...(s.name ? [str(ID.Name, s.name)] : []),
        ),
      );
    });
    this.tracksPos = this.position;
    await this.write(el(ID.Tracks, ...entries));
  }

  async addFragments(buf: Uint8Array) {
    const blocks: Block[] = [];
    let maxTs = 0;
    for (const run of parseFragments(buf)) {
      const t = this.trackMap.get(run.trackId);
      if (!t) continue;
      const scale = 1000 / t.info.timescale;
      for (const s of run.samples) {
        const ts = Math.round((s.dts + s.cto) * scale);
        const end = Math.round((s.dts + s.cto + s.duration) * scale);
        // order = dekoderekkefølge (dts), brukes til å flette sporene
        blocks.push({ track: t.number, ts, order: s.dts * scale, key: s.sync, data: s.data });
        maxTs = Math.max(maxTs, ts);
        this.endMs = Math.max(this.endMs, end);
      }
    }
    if (!blocks.length) return;

    // Undertekster som starter innenfor denne klyngen
    while (this.pendingSubs.length && this.pendingSubs[0].cue.start <= maxTs) {
      const { track, cue } = this.pendingSubs.shift()!;
      blocks.push({ track, ts: cue.start, order: cue.start, key: true, data: enc.encode(cue.text), duration: cue.end - cue.start });
    }
    await this.writeClusters(blocks);
  }

  private async writeClusters(blocks: Block[]) {
    // Flett etter dekodetid; stabil sortering beholder rekkefølgen innen hvert spor
    blocks.sort((a, b) => a.order - b.order);
    let i = 0;
    while (i < blocks.length) {
      // Klyngetid = laveste pts i klyngen, så relative tider blir 0..MAX_CLUSTER_SPAN
      let j = i;
      let minTs = Infinity;
      let maxTs = -Infinity;
      while (j < blocks.length) {
        const lo = Math.min(minTs, blocks[j].ts);
        const hi = Math.max(maxTs, blocks[j].ts);
        if (j > i && hi - lo > MAX_CLUSTER_SPAN) break;
        minTs = lo;
        maxTs = hi;
        j++;
      }
      const group = blocks.slice(i, j);
      const clusterTs = minTs;
      const parts: Uint8Array[] = [uint(ID.Timestamp, clusterTs)];
      let cueKey: number | null = null;
      for (const b of group) {
        const rel = b.ts - clusterTs;
        if (b.duration !== undefined) {
          parts.push(el(ID.BlockGroup, el(ID.Block, blockHeader(b.track, rel, 0), b.data), uint(ID.BlockDuration, b.duration)));
        } else {
          parts.push(el(ID.SimpleBlock, blockHeader(b.track, rel, b.key ? 0x80 : 0), b.data));
          if (b.key && b.track === this.videoTrack && cueKey === null) cueKey = b.ts;
        }
      }
      const clusterPos = this.position - this.segmentStart;
      if (cueKey !== null && this.videoTrack) this.cuePoints.push({ time: cueKey, track: this.videoTrack, pos: clusterPos });
      await this.write(el(ID.Cluster, ...parts));
      i = j;
    }
  }

  async finish() {
    // Undertekster etter siste video/lyd-blokk
    if (this.pendingSubs.length) {
      const rest = this.pendingSubs.splice(0).map(({ track, cue }) => ({
        track,
        ts: cue.start,
        order: cue.start,
        key: true,
        data: enc.encode(cue.text),
        duration: cue.end - cue.start,
      }));
      for (const r of rest) this.endMs = Math.max(this.endMs, r.ts + (r.duration ?? 0));
      await this.writeClusters(rest);
    }

    const cuesPos = this.position - this.segmentStart;
    await this.write(
      el(
        ID.Cues,
        ...this.cuePoints.map((c) =>
          el(ID.CuePoint, uint(ID.CueTime, c.time), el(ID.CueTrackPositions, uint(ID.CueTrack, c.track), uint(ID.CueClusterPosition, c.pos))),
        ),
      ),
    );

    // SeekHead inn i det reserverte Void-området
    const seek = (id: number, pos: number) => el(ID.Seek, el(ID.SeekID, idBytes(id)), uint(ID.SeekPosition, pos));
    const seekHead = el(
      ID.SeekHead,
      seek(ID.Info, this.infoPos - this.segmentStart),
      seek(ID.Tracks, this.tracksPos - this.segmentStart),
      seek(ID.Cues, cuesPos),
    );
    const filler = SEEKHEAD_RESERVE - seekHead.byteLength;
    if (filler < 2) throw new Error("SeekHead for stor");
    await this.sink.writeAt(this.segmentStart, concat([seekHead, voidEl(filler)]));

    const dur = new Uint8Array(8);
    new DataView(dur.buffer).setFloat64(0, this.endMs);
    await this.sink.writeAt(this.durationPos, dur);

    await this.sink.writeAt(this.segmentSizePos, vint(this.position - this.segmentStart, 8));
  }
}

/** BCP 47 -> ISO 639-2 for de språkene NRK typisk har. */
function iso6392(lang: string): string {
  const map: Record<string, string> = { nb: "nob", nn: "nno", no: "nor", se: "sme", en: "eng", sv: "swe", da: "dan", fi: "fin", de: "ger", fr: "fre" };
  return map[lang.toLowerCase().split("-")[0]] ?? "und";
}
