// WebVTT-parser (det NRK leverer) og konvertering til SRT-tekst.

export type Cue = { start: number; end: number; text: string }; // millisekunder

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})/;

function toMs(t: string): number {
  const m = t.match(TIME);
  if (!m) return NaN;
  return ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]);
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
  "&lrm;": "‎",
  "&rlm;": "‏",
  "&quot;": '"',
  "&apos;": "'",
};

/**
 * Beholder <i>, <b>, <u> (støttes i SRT/MKV), fjerner andre VTT-tagger
 * (<v>, <c.x>, <lang>, tidsstempler). Tåler feil i kilden, f.eks.
 * «-Sier <i>du>med den nesa<der?!</i>»: løse < og > blir mellomrom,
 * og tagger som ikke lukkes, lukkes på slutten.
 */
function cleanText(s: string): string {
  let out = s
    .replace(/<(\/?)([ibu])>/g, "\u0000$1$2\u0001") // beskytt tillatte tagger
    .replace(/<\/?[a-zA-Z][^<>]*>|<\d[^<>]*>/g, "") // fjern andre tagger
    .replace(/[<>]/g, " ") // løse vinkelparenteser
    .replace(/\u0000/g, "<")
    .replace(/\u0001/g, ">")
    .replace(/&(?:amp|lt|gt|nbsp|lrm|rlm|quot|apos);/g, (e) => ENTITIES[e])
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n|\n[ \t]+/g, "\n")
    .trim();
  for (const tag of ["i", "b", "u"]) {
    const open = out.split(`<${tag}>`).length - 1;
    const close = out.split(`</${tag}>`).length - 1;
    out += `</${tag}>`.repeat(Math.max(0, open - close));
  }
  return out;
}

export function parseVtt(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue; // WEBVTT-header, NOTE, STYLE, REGION
    const [a, b] = lines[i].split("-->");
    const start = toMs(a);
    const end = toMs(b); // cue-innstillinger etter tiden ignoreres
    const body = cleanText(lines.slice(i + 1).join("\n"));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && body) {
      cues.push({ start, end, text: body });
    }
  }
  return cues.sort((x, y) => x.start - y.start);
}

function srtTime(ms: number): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n");
}
