// Lesing av fragmentert MP4 slik mux.js lager den: init-segment (ftyp+moov)
// og fragmenter (moof+mdat). Brukes av både MP4- og MKV-skriveren.

export interface SeekableSink {
  write(chunk: Uint8Array): Promise<void>;
  /** Overskriv bytes på en gitt posisjon (brukes til å rette opp headere til slutt). */
  writeAt(position: number, chunk: Uint8Array): Promise<void>;
}

/** Felles grensesnitt for containerskrivere (MP4, MKV). */
export interface ContainerWriter {
  setInit(initSegment: Uint8Array): Promise<void>;
  addFragments(buf: Uint8Array): Promise<void>;
  finish(): Promise<void>;
}

// ---------- Bokser ----------

export type Box = { type: string; start: number; size: number; hdr: number };

export function readBoxes(buf: Uint8Array, start = 0, end = buf.byteLength): Box[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: Box[] = [];
  let off = start;
  while (off + 8 <= end) {
    let size = dv.getUint32(off);
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    let hdr = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(off + 8));
      hdr = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < hdr || off + size > end) throw new Error(`Ugyldig MP4-boks ${type}`);
    out.push({ type, start: off, size, hdr });
    off += size;
  }
  return out;
}

export const children = (buf: Uint8Array, b: Box) => readBoxes(buf, b.start + b.hdr, b.start + b.size);
export const find = (buf: Uint8Array, b: Box, type: string) => children(buf, b).find((c) => c.type === type);
export const raw = (buf: Uint8Array, b: Box) => buf.slice(b.start, b.start + b.size);
export const body = (buf: Uint8Array, b: Box) => buf.subarray(b.start + b.hdr, b.start + b.size);
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

// ---------- Init-segment ----------

export type InitTrack = {
  id: number;
  timescale: number;
  kind: "video" | "audio" | "other";
  trak: Box;
  codec?: string; // avc1, mp4a, ...
  width?: number;
  height?: number;
  /** avcC-innhold (video) eller AudioSpecificConfig (AAC) */
  codecPrivate?: Uint8Array;
  channels?: number;
  sampleRate?: number;
};

export type InitInfo = { moov: Box; movieTimescale: number; tracks: InitTrack[] };

/** Leser lengdefeltet i en MPEG-4-deskriptor (1-4 byte, 7 bit per byte). */
function descLength(b: Uint8Array, p: number): [number, number] {
  let len = 0;
  for (let i = 0; i < 4; i++) {
    const c = b[p++];
    len = (len << 7) | (c & 0x7f);
    if (!(c & 0x80)) break;
  }
  return [len, p];
}

/** Henter AudioSpecificConfig fra en esds-boks. */
function parseEsds(esds: Uint8Array): Uint8Array | undefined {
  let p = 4; // version+flags
  if (esds[p++] !== 0x03) return;
  let len: number;
  [len, p] = descLength(esds, p);
  p += 2; // ES_ID
  const flags = esds[p++];
  if (flags & 0x80) p += 2;
  if (flags & 0x40) p += 1 + esds[p];
  if (flags & 0x20) p += 2;
  if (esds[p++] !== 0x04) return;
  [len, p] = descLength(esds, p);
  p += 13; // objectType, streamType, bufferSize, maxBitrate, avgBitrate
  if (esds[p++] !== 0x05) return;
  [len, p] = descLength(esds, p);
  return esds.slice(p, p + len);
}

export function parseInit(init: Uint8Array): InitInfo {
  const moov = readBoxes(init).find((b) => b.type === "moov");
  if (!moov) throw new Error("Init-segment mangler moov");
  const mvhd = body(init, find(init, moov, "mvhd")!);
  const movieTimescale = view(mvhd).getUint32(mvhd[0] === 1 ? 20 : 12);

  const tracks: InitTrack[] = [];
  for (const trak of children(init, moov).filter((b) => b.type === "trak")) {
    const tkhd = body(init, find(init, trak, "tkhd")!);
    const id = view(tkhd).getUint32(tkhd[0] === 1 ? 20 : 12);
    const mdia = find(init, trak, "mdia")!;
    const mdhd = body(init, find(init, mdia, "mdhd")!);
    const timescale = view(mdhd).getUint32(mdhd[0] === 1 ? 20 : 12);
    const hdlr = body(init, find(init, mdia, "hdlr")!);
    const handler = String.fromCharCode(...hdlr.subarray(8, 12));
    const track: InitTrack = {
      id,
      timescale,
      trak,
      kind: handler === "vide" ? "video" : handler === "soun" ? "audio" : "other",
    };

    const stbl = find(init, find(init, mdia, "minf")!, "stbl")!;
    const stsd = find(init, stbl, "stsd")!;
    // stsd: fullbox (4) + entry_count (4), så sample entries
    const entry = readBoxes(init, stsd.start + stsd.hdr + 8, stsd.start + stsd.size)[0];
    if (entry) {
      track.codec = entry.type;
      const e = body(init, entry);
      if (track.kind === "video") {
        track.width = view(e).getUint16(24);
        track.height = view(e).getUint16(26);
        const avcC = readBoxes(init, entry.start + entry.hdr + 78, entry.start + entry.size).find((b) => b.type === "avcC");
        if (avcC) track.codecPrivate = body(init, avcC).slice();
      } else if (track.kind === "audio") {
        track.channels = view(e).getUint16(16);
        track.sampleRate = view(e).getUint32(24) >>> 16;
        const esds = readBoxes(init, entry.start + entry.hdr + 28, entry.start + entry.size).find((b) => b.type === "esds");
        if (esds) track.codecPrivate = parseEsds(body(init, esds));
      }
    }
    tracks.push(track);
  }
  return { moov, movieTimescale, tracks };
}

// ---------- Fragmenter ----------

export type Sample = {
  /** Dekodetid i sporets tidsskala */
  dts: number;
  duration: number;
  /** Komposisjons-offset (pts = dts + cto) */
  cto: number;
  sync: boolean;
  data: Uint8Array;
};

export type Run = { trackId: number; samples: Sample[]; data: Uint8Array };

/** Leser alle moof+mdat-par i en buffer og returnerer samples per traf/trun. */
export function parseFragments(buf: Uint8Array): Run[] {
  const runs: Run[] = [];
  for (const moof of readBoxes(buf).filter((b) => b.type === "moof")) {
    for (const traf of children(buf, moof).filter((b) => b.type === "traf")) {
      const tf = body(buf, find(buf, traf, "tfhd")!);
      const tdv = view(tf);
      const tfFlags = (tf[1] << 16) | (tf[2] << 8) | tf[3];
      const trackId = tdv.getUint32(4);

      let p = 8;
      let base = moof.start; // default-base-is-moof / første traf
      if (tfFlags & 0x1) {
        base = Number(tdv.getBigUint64(p));
        p += 8;
      }
      if (tfFlags & 0x2) p += 4; // sample_description_index
      let defDur = 0,
        defSize = 0,
        defFlags = 0;
      if (tfFlags & 0x8) {
        defDur = tdv.getUint32(p);
        p += 4;
      }
      if (tfFlags & 0x10) {
        defSize = tdv.getUint32(p);
        p += 4;
      }
      if (tfFlags & 0x20) {
        defFlags = tdv.getUint32(p);
        p += 4;
      }

      let dts = 0;
      const tfdtBox = find(buf, traf, "tfdt");
      if (tfdtBox) {
        const t = body(buf, tfdtBox);
        dts = t[0] === 1 ? Number(view(t).getBigUint64(4)) : view(t).getUint32(4);
      }

      for (const trunBox of children(buf, traf).filter((b) => b.type === "trun")) {
        const tr = body(buf, trunBox);
        const dv = view(tr);
        const version = tr[0];
        const flags = (tr[1] << 16) | (tr[2] << 8) | tr[3];
        const count = dv.getUint32(4);
        let q = 8;
        let dataOffset = 0;
        if (flags & 0x1) {
          dataOffset = dv.getInt32(q);
          q += 4;
        }
        let firstFlags: number | null = null;
        if (flags & 0x4) {
          firstFlags = dv.getUint32(q);
          q += 4;
        }

        const start = base + dataOffset;
        let pos = start;
        const samples: Sample[] = [];
        for (let i = 0; i < count; i++) {
          let duration = defDur;
          if (flags & 0x100) {
            duration = dv.getUint32(q);
            q += 4;
          }
          let size = defSize;
          if (flags & 0x200) {
            size = dv.getUint32(q);
            q += 4;
          }
          let sflags = i === 0 && firstFlags !== null ? firstFlags : defFlags;
          if (flags & 0x400) {
            sflags = dv.getUint32(q);
            q += 4;
          }
          let cto = 0;
          if (flags & 0x800) {
            cto = version === 0 ? dv.getUint32(q) : dv.getInt32(q);
            q += 4;
          }
          if (pos + size > buf.byteLength) throw new Error("Fragment peker utenfor data");
          // sample_is_non_sync_sample = bit 16
          samples.push({ dts, duration, cto, sync: !(sflags & 0x10000), data: buf.subarray(pos, pos + size) });
          dts += duration;
          pos += size;
        }
        runs.push({ trackId, samples, data: buf.subarray(start, pos) });
      }
    }
  }
  return runs;
}
