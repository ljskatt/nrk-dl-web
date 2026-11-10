// Gjør om fragmentert MP4 (fra mux.js) til en vanlig, flat MP4:
//   ftyp | mdat (sampledata, strømmes rett til disk) | moov (sampletabeller)
//
// Hvorfor: mux.js lager fMP4 beregnet på MediaSource, med varighet 0xFFFFFFFF
// ("ukjent") og hundrevis av moof/mdat-par. QuickTime og VLC viser da ~24 t
// spilletid og hakker. En flat MP4 med moov på slutten spilles av overalt.
//
// Sampledata skrives fortløpende; bare tabellene (noen få byte per sample)
// holdes i minnet. Til slutt patches mdat-størrelsen i starten av filen.

import {
  type ContainerWriter,
  type InitInfo,
  type InitTrack,
  type SeekableSink,
  type Box,
  children,
  find,
  parseFragments,
  parseInit,
  raw,
} from "./fmp4";

export type { SeekableSink } from "./fmp4";

// ---------- Skriving av bokser ----------

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const content = concat(payload);
  const out = new Uint8Array(8 + content.byteLength);
  new DataView(out.buffer).setUint32(0, out.byteLength);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(content, 8);
  return out;
}

function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]) {
  const vf = new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]);
  return box(type, vf, ...payload);
}

function u32s(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) dv.setUint32(i * 4, values[i] >>> 0);
  return out;
}

// Voksende Uint32-liste (unngår millioner av JS-tall i vanlige arrays)
class U32List {
  data = new Uint32Array(4096);
  length = 0;
  push(v: number) {
    if (this.length === this.data.length) {
      const next = new Uint32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v >>> 0;
  }
  view() {
    return this.data.subarray(0, this.length);
  }
}

type Track = {
  info: InitTrack;
  durations: U32List;
  sizes: U32List;
  cts: U32List; // komposisjons-offset, lagret som uint32 (kan være negativ)
  nonSync: number[]; // 1-baserte samplenumre som IKKE er keyframes
  chunkOffsets: number[];
  chunkSamples: number[];
  hasCts: boolean;
  negativeCts: boolean;
};

export class FlatMp4Writer implements ContainerWriter {
  private init: Uint8Array | null = null;
  private info: InitInfo | null = null;
  private tracks = new Map<number, Track>();
  private position = 0;
  private mdatStart = 0;
  private sink: SeekableSink;

  constructor(sink: SeekableSink) {
    this.sink = sink;
  }

  async setInit(initSegment: Uint8Array) {
    this.init = initSegment;
    this.info = parseInit(initSegment);
    for (const t of this.info.tracks) {
      this.tracks.set(t.id, {
        info: t,
        durations: new U32List(),
        sizes: new U32List(),
        cts: new U32List(),
        nonSync: [],
        chunkOffsets: [],
        chunkSamples: [],
        hasCts: false,
        negativeCts: false,
      });
    }

    const enc = new TextEncoder();
    const ftyp = box("ftyp", enc.encode("isom"), u32s([0x200]), enc.encode("isomiso2avc1mp41"));
    // mdat med 64-bit størrelse; størrelsen settes i finish()
    const mdatHdr = new Uint8Array(16);
    new DataView(mdatHdr.buffer).setUint32(0, 1);
    mdatHdr.set(enc.encode("mdat"), 4);

    await this.sink.write(ftyp);
    this.mdatStart = ftyp.byteLength;
    await this.sink.write(mdatHdr);
    this.position = ftyp.byteLength + mdatHdr.byteLength;
  }

  async addFragments(buf: Uint8Array) {
    if (!this.init) throw new Error("setInit må kalles først");
    for (const run of parseFragments(buf)) {
      const track = this.tracks.get(run.trackId);
      if (!track) throw new Error(`Ukjent spor ${run.trackId}`);
      if (!run.samples.length) continue;
      for (const s of run.samples) {
        track.durations.push(s.duration);
        track.sizes.push(s.data.byteLength);
        track.cts.push(s.cto);
        if (s.cto !== 0) track.hasCts = true;
        if (s.cto < 0) track.negativeCts = true;
        if (!s.sync) track.nonSync.push(track.sizes.length);
      }
      track.chunkOffsets.push(this.position);
      track.chunkSamples.push(run.samples.length);
      await this.sink.write(run.data);
      this.position += run.data.byteLength;
    }
  }

  /** Skriver moov på slutten og retter opp mdat-størrelsen. */
  async finish() {
    if (!this.init || !this.info) throw new Error("Ingen data");
    const init = this.init;
    const { moov: moovBox, movieTimescale } = this.info;
    const moovKids = children(init, moovBox);

    const traks: Uint8Array[] = [];
    let movieDuration = 0;
    for (const t of this.tracks.values()) {
      if (!t.sizes.length) continue;
      let mediaDuration = 0;
      for (const d of t.durations.view()) mediaDuration += d;
      const trackDuration = Math.round((mediaDuration * movieTimescale) / t.info.timescale);
      movieDuration = Math.max(movieDuration, trackDuration);
      traks.push(this.buildTrak(t, mediaDuration, trackDuration));
    }

    const mvhd = patchDuration(raw(init, moovKids.find((b) => b.type === "mvhd")!), movieDuration, "mvhd");
    // Kopier evt. andre moov-barn (unntatt mvex, som bare gjelder fMP4)
    const others = moovKids.filter((b) => !["mvhd", "trak", "mvex"].includes(b.type)).map((b) => raw(init, b));
    const moov = box("moov", mvhd, ...traks, ...others);

    await this.sink.write(moov);
    const largesize = new Uint8Array(8);
    new DataView(largesize.buffer).setBigUint64(0, BigInt(this.position - this.mdatStart));
    await this.sink.writeAt(this.mdatStart + 8, largesize);
  }

  private buildTrak(t: Track, mediaDuration: number, trackDuration: number): Uint8Array {
    const init = this.init!;
    const out: Uint8Array[] = [];
    for (const k of children(init, t.info.trak)) {
      if (k.type === "tkhd") out.push(patchDuration(raw(init, k), trackDuration, "tkhd"));
      else if (k.type === "mdia") out.push(this.buildMdia(t, k, mediaDuration));
      else if (k.type !== "edts") out.push(raw(init, k));
    }
    return box("trak", ...out);
  }

  private buildMdia(t: Track, mdia: Box, mediaDuration: number): Uint8Array {
    const init = this.init!;
    const out: Uint8Array[] = [];
    for (const k of children(init, mdia)) {
      if (k.type === "mdhd") out.push(patchDuration(raw(init, k), mediaDuration, "mdhd"));
      else if (k.type === "minf") {
        const minfKids = children(init, k).map((m) => (m.type === "stbl" ? this.buildStbl(t, m) : raw(init, m)));
        out.push(box("minf", ...minfKids));
      } else out.push(raw(init, k));
    }
    return box("mdia", ...out);
  }

  private buildStbl(t: Track, stbl: Box): Uint8Array {
    const init = this.init!;
    const stsd = raw(init, find(init, stbl, "stsd")!);
    const n = t.sizes.length;

    // stts: kjørelengdekodede varigheter
    const stts: number[] = [];
    const durs = t.durations.view();
    for (let i = 0; i < n; ) {
      let j = i + 1;
      while (j < n && durs[j] === durs[i]) j++;
      stts.push(j - i, durs[i]);
      i = j;
    }

    // ctts: komposisjons-offset (kun video med B-frames)
    let ctts: Uint8Array | null = null;
    if (t.hasCts) {
      const cts = t.cts.view();
      const entries: number[] = [];
      for (let i = 0; i < n; ) {
        let j = i + 1;
        while (j < n && cts[j] === cts[i]) j++;
        entries.push(j - i, cts[i]);
        i = j;
      }
      ctts = fullBox("ctts", t.negativeCts ? 1 : 0, 0, u32s([entries.length / 2]), u32s(entries));
    }

    // stsc: antall samples per chunk, bare når det endrer seg
    const stsc: number[] = [];
    let prev = -1;
    t.chunkSamples.forEach((c, i) => {
      if (c !== prev) stsc.push(i + 1, c, 1);
      prev = c;
    });

    const co64 = new Uint8Array(t.chunkOffsets.length * 8);
    const cdv = new DataView(co64.buffer);
    t.chunkOffsets.forEach((o, i) => cdv.setBigUint64(i * 8, BigInt(o)));

    const parts = [
      stsd,
      fullBox("stts", 0, 0, u32s([stts.length / 2]), u32s(stts)),
      ...(ctts ? [ctts] : []),
      fullBox("stsc", 0, 0, u32s([stsc.length / 3]), u32s(stsc)),
      fullBox("stsz", 0, 0, u32s([0, n]), u32s(t.sizes.view())),
      fullBox("co64", 0, 0, u32s([t.chunkOffsets.length]), co64),
    ];
    // stss: liste over keyframes (utelates når alle samples er sync, f.eks. lyd)
    if (t.nonSync.length) {
      const nonSync = new Set(t.nonSync);
      const sync: number[] = [];
      for (let i = 1; i <= n; i++) if (!nonSync.has(i)) sync.push(i);
      parts.push(fullBox("stss", 0, 0, u32s([sync.length]), u32s(sync)));
    }
    return box("stbl", ...parts);
  }
}

/** Setter varighet i mvhd/tkhd/mdhd (versjon 0 = 32 bit, versjon 1 = 64 bit). */
function patchDuration(b: Uint8Array, duration: number, type: "mvhd" | "tkhd" | "mdhd"): Uint8Array {
  const out = b.slice();
  const dv = new DataView(out.buffer);
  const hdr = 8;
  const version = out[hdr];
  // Offset til duration, relativt til boksens start
  const off =
    type === "tkhd"
      ? hdr + 4 + (version === 1 ? 8 + 8 + 4 + 4 : 4 + 4 + 4 + 4)
      : hdr + 4 + (version === 1 ? 8 + 8 + 4 : 4 + 4 + 4);
  if (version === 1) dv.setBigUint64(off, BigInt(duration));
  else {
    if (duration > 0xfffffffe) throw new Error("Programmet er for langt for MP4 versjon 0");
    dv.setUint32(off, duration);
  }
  return out;
}
