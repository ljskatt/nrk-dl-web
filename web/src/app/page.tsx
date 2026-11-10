"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import styles from "./page.module.css";
import { loadShow, getManifest, fileBase, folderPath, type Show, type Episode } from "@/lib/nrk";
import { getVariants, getSegments, downloadHls, type Sink } from "@/lib/hls";
import { FlatMp4Writer } from "@/lib/mp4";
import { MkvWriter, type MkvSubtitle } from "@/lib/mkv";
import { parseVtt } from "@/lib/vtt";
import { canPickDirectory, pickDirectory, dirSink, blobSink, fileExists, writeTextFile } from "@/lib/save";

type Status =
  | { state: "queued" }
  | { state: "running"; pct: number; mb: number }
  | { state: "done" }
  | { state: "skipped"; why: string }
  | { state: "error"; why: string };

const QUALITIES = [
  { label: "Beste", maxHeight: Infinity },
  { label: "720p", maxHeight: 720 },
  { label: "540p", maxHeight: 540 },
  { label: "360p", maxHeight: 360 },
];

function fmtDuration(s?: number) {
  if (!s) return "";
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} t ${m % 60} min` : `${m} min`;
}

const noop = () => () => {};

/** Avkrysning med "delvis valgt"-tilstand (indeterminate kan bare settes via DOM). */
function TriCheckbox({
  ids,
  selected,
  onToggle,
  disabled,
  label,
}: {
  ids: string[];
  selected: Set<string>;
  onToggle: (ids: string[], on: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const count = ids.filter((id) => selected.has(id)).length;
  const all = ids.length > 0 && count === ids.length;
  const some = count > 0 && !all;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some;
  }, [some]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={all}
      // Delvis valgt + klikk = velg alle (samme som Gmail/Finder)
      onChange={() => onToggle(ids, !all)}
      disabled={disabled || !ids.length}
    />
  );
}

export default function Home() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState<Show | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [quality, setQuality] = useState(0);
  const [subs, setSubs] = useState(true);
  const [format, setFormat] = useState<"mp4" | "mkv">("mp4");
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Sist klikkede episode - ankerpunkt for shift-klikk.
  const anchorRef = useRef<string | null>(null);
  // Klient-only sjekk uten hydreringsavvik (statisk HTML rendres uten window).
  const supportsDir = useSyncExternalStore(noop, canPickDirectory, () => true);

  // Åpne sesonger. Serier med flere sesonger starter sammenlagt.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const collapsible = show?.kind === "series" && show.seasons.length > 1;
  const isOpen = (name: string) => !collapsible || expanded.has(name);

  const allEpisodes = useMemo(() => show?.seasons.flatMap((s) => s.episodes) ?? [], [show]);
  // Shift-klikk gjelder bare episoder man faktisk ser.
  const visibleEpisodes = useMemo(
    () =>
      show?.seasons
        .filter((s) => !collapsible || expanded.has(s.name))
        .flatMap((s) => s.episodes) ?? [],
    [show, expanded, collapsible],
  );

  function toggleExpanded(name: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setShow(null);
    setStatus({});
    setLoading(true);
    try {
      const s = await loadShow(input);
      anchorRef.current = null;
      setExpanded(new Set());
      setShow(s);
      setSelected(new Set(s.seasons.flatMap((x) => x.episodes).filter((x) => x.available).map((x) => x.prfId)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function toggle(ids: string[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  /** Vanlig klikk: én episode. Shift-klikk: alle tilgjengelige mellom forrige klikk og denne. */
  function onEpisodeToggle(ep: Episode, on: boolean, shift: boolean) {
    const anchor = anchorRef.current;
    const from = anchor ? visibleEpisodes.findIndex((e) => e.prfId === anchor) : -1;
    const to = visibleEpisodes.findIndex((e) => e.prfId === ep.prfId);
    if (shift && from >= 0 && to >= 0) {
      const [a, b] = from < to ? [from, to] : [to, from];
      toggle(
        visibleEpisodes
          .slice(a, b + 1)
          .filter((e) => e.available)
          .map((e) => e.prfId),
        on,
      );
    } else {
      toggle([ep.prfId], on);
    }
    anchorRef.current = ep.prfId;
  }

  const availableIds = allEpisodes.filter((e) => e.available).map((e) => e.prfId);

  const setOne = (id: string, s: Status) => setStatus((prev) => ({ ...prev, [id]: s }));

  async function downloadEpisode(s: Show, ep: Episode, root: FileSystemDirectoryHandle | null, signal: AbortSignal) {
    const base = fileBase(s, ep);
    const path = folderPath(s, ep);
    const name = `${base}.${format}`;

    if (root && (await fileExists(root, path, name))) {
      setOne(ep.prfId, { state: "skipped", why: "Finnes allerede" });
      return;
    }

    const m = await getManifest(ep.prfId);
    if (!m.playable || !m.hlsUrl) throw new Error(m.reason ?? "Ikke tilgjengelig");
    if (m.encrypted) throw new Error("Kryptert (DRM)");

    const variants = await getVariants(m.hlsUrl, signal);
    const max = QUALITIES[quality].maxHeight;
    const variant = variants.find((v) => !v.height || v.height <= max) ?? variants[variants.length - 1];
    const segments = await getSegments(variant.url, signal);

    // Undertekster: MP4 får egen .vtt ved siden av, MKV får dem innebygd
    const mkvSubs: MkvSubtitle[] = [];
    if (subs) {
      for (const sub of m.subtitles) {
        const res = await fetch(sub.url, { signal });
        if (!res.ok) continue;
        const text = await res.text();
        if (format === "mkv") {
          mkvSubs.push({
            cues: parseVtt(text),
            language: sub.language || "nb",
            name: sub.label,
            default: sub.defaultOn && sub.type !== "ttv",
            hearingImpaired: sub.type === "ttv",
          });
        } else {
          await writeTextFile(root, path, `${base}.${sub.language || "nb"}.vtt`, text);
        }
      }
    }

    const sink: Sink = root
      ? await dirSink(root, path, name)
      : blobSink(name, format === "mkv" ? "video/x-matroska" : "video/mp4");
    const writer = format === "mkv" ? new MkvWriter(sink, { subtitles: mkvSubs, title: ep.title }) : new FlatMp4Writer(sink);
    setOne(ep.prfId, { state: "running", pct: 0, mb: 0 });
    await downloadHls(segments, sink, writer, {
      signal,
      onProgress: (p) =>
        setOne(ep.prfId, { state: "running", pct: Math.round((p.done / p.total) * 100), mb: Math.round(p.bytes / 1e6) }),
    });
    setOne(ep.prfId, { state: "done" });
  }

  async function onDownload() {
    if (!show) return;
    const queue = allEpisodes.filter((e) => selected.has(e.prfId));
    if (!queue.length) return;

    let root: FileSystemDirectoryHandle | null = null;
    if (supportsDir) {
      try {
        root = await pickDirectory();
      } catch {
        return; // bruker avbrøt mappevalget
      }
    }

    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setStatus(Object.fromEntries(queue.map((e) => [e.prfId, { state: "queued" } as Status])));

    for (const ep of queue) {
      if (ac.signal.aborted) {
        setOne(ep.prfId, { state: "skipped", why: "Avbrutt" });
        continue;
      }
      try {
        await downloadEpisode(show, ep, root, ac.signal);
      } catch (err) {
        const why = ac.signal.aborted ? "Avbrutt" : err instanceof Error ? err.message : String(err);
        setOne(ep.prfId, { state: "error", why });
      }
    }
    setRunning(false);
    abortRef.current = null;
  }

  const statuses = Object.values(status);
  const doneCount = statuses.filter((s) => s.state === "done").length;

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1>NRK-DL</h1>
        <p className={styles.muted}>
          Last ned programmer og serier fra NRK TV. Videoen hentes rett fra NRK, mens programinfo går via min server
          siden NRK ikke lar andre nettsider hente den direkte.
        </p>
      </header>

      <form className={styles.search} onSubmit={onSearch}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="https://tv.nrk.no/serie/fleksnes"
          aria-label="Lenke, serienavn eller program-ID"
          disabled={running}
        />
        <button
          type="submit"
          className={styles.searchButton}
          disabled={loading || running || !input.trim()}
          aria-busy={loading}
          aria-label={loading ? "Henter" : undefined}
        >
          {/* Teksten beholdes (usynlig) mens den laster, så knappen ikke endrer bredde */}
          <span className={loading ? styles.hidden : undefined}>Hent</span>
          {loading && <span className={styles.spinner} aria-hidden />}
        </button>
      </form>

      {error && <p className={styles.error}>{error}</p>}

      {show && (
        <section className={styles.show}>
          <div className={styles.showHead}>
            {show.image && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={show.image} alt="" className={show.imageShape === "poster" ? styles.poster : styles.wide} />
            )}
            <div>
              <h2>{show.title}</h2>
              <p className={styles.muted}>
                {allEpisodes.length} {allEpisodes.length === 1 ? "program" : "episoder"} · {selected.size} valgt
              </p>
            </div>
          </div>

          <div className={styles.options}>
            {show.kind === "series" && (
              <label>
                <TriCheckbox ids={availableIds} selected={selected} onToggle={toggle} disabled={running} /> Alle
              </label>
            )}
            <label>
              Kvalitet{" "}
              <select value={quality} onChange={(e) => setQuality(Number(e.target.value))} disabled={running}>
                {QUALITIES.map((q, i) => (
                  <option key={q.label} value={i}>
                    {q.label}
                  </option>
                ))}
              </select>
            </label>
            <label title="MP4 spilles av overalt, også QuickTime og iPhone. MKV har undertekstene inni filen (VLC, IINA, Plex, Jellyfin, Infuse).">
              Format{" "}
              <select value={format} onChange={(e) => setFormat(e.target.value as "mp4" | "mkv")} disabled={running}>
                <option value="mp4">MP4</option>
                <option value="mkv">MKV</option>
              </select>
            </label>
            <label>
              <input type="checkbox" checked={subs} onChange={(e) => setSubs(e.target.checked)} disabled={running} />{" "}
              {format === "mkv" ? "Undertekster (innebygd)" : "Undertekster (.vtt)"}
            </label>
            <div className={styles.spacer} />
            {running ? (
              <button className={styles.secondary} onClick={() => abortRef.current?.abort()}>
                Avbryt
              </button>
            ) : (
              <button onClick={onDownload} disabled={!selected.size}>
                {supportsDir ? "Last ned til mappe…" : "Last ned"}
              </button>
            )}
          </div>

          {show.kind === "series" && !running && (
            <p className={styles.muted}>Tips: hold Shift og klikk for å velge flere episoder på rad.</p>
          )}

          {!supportsDir && (
            <p className={styles.warn}>
              Nettleseren din kan ikke lagre direkte til en mappe. Hver fil holdes i minnet til den er ferdig, så lange
              programmer kan bruke mye RAM. Chrome eller Edge anbefales.
            </p>
          )}
          {statuses.length > 0 && (
            <p className={styles.muted}>
              {doneCount} av {statuses.length} ferdig
            </p>
          )}

          {show.seasons.map((season) => {
            const ids = season.episodes.filter((e) => e.available).map((e) => e.prfId);
            const total = season.episodes.length;
            const selCount = ids.filter((id) => selected.has(id)).length;
            const open = isOpen(season.name);
            const listId = `season-${season.name}`;

            // Nedlastingsstatus for sesongen (vises også når den er lagt sammen)
            const seasonStatuses = season.episodes.map((e) => status[e.prfId]).filter(Boolean);
            const seasonDone = seasonStatuses.filter((s) => s.state === "done").length;
            const seasonErr = seasonStatuses.filter((s) => s.state === "error").length;

            const title = <h3>{season.title}</h3>;
            return (
              <div key={season.name} className={styles.season}>
                {show.kind === "series" && (
                  <div className={styles.seasonHead}>
                    <TriCheckbox
                      ids={ids}
                      selected={selected}
                      onToggle={toggle}
                      disabled={running}
                      label={`Velg ${season.title}`}
                    />
                    {collapsible ? (
                      <button
                        type="button"
                        className={styles.seasonToggle}
                        aria-expanded={open}
                        aria-controls={listId}
                        onClick={() => toggleExpanded(season.name)}
                      >
                        <svg className={styles.chevron} viewBox="0 0 16 16" aria-hidden>
                          <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        {title}
                      </button>
                    ) : (
                      title
                    )}
                    <span className={styles.muted}>
                      {selCount > 0 && selCount < total ? `${selCount} av ${total} valgt` : `${total} ${total === 1 ? "episode" : "episoder"}`}
                      {seasonStatuses.length > 0 && ` · ${seasonDone} av ${seasonStatuses.length} ferdig`}
                      {seasonErr > 0 && ` · ${seasonErr} feilet`}
                    </span>
                  </div>
                )}
                {open && <ul className={styles.episodes} id={listId}>
                  {season.episodes.map((ep) => {
                    const st = status[ep.prfId];
                    return (
                      <li key={ep.prfId} className={ep.available ? undefined : styles.unavailable}>
                        <label>
                          <input
                            type="checkbox"
                            checked={selected.has(ep.prfId)}
                            onChange={(e) =>
                              onEpisodeToggle(ep, e.target.checked, (e.nativeEvent as MouseEvent).shiftKey === true)
                            }
                            disabled={running || !ep.available}
                          />
                          <span className={styles.epTitle}>{ep.title}</span>
                          <span className={styles.muted}>
                            {ep.available ? fmtDuration(ep.durationSeconds) : "Utilgjengelig"}
                          </span>
                        </label>
                        {st && <StatusBadge s={st} />}
                      </li>
                    );
                  })}
                </ul>}
              </div>
            );
          })}
        </section>
      )}

      <footer className={styles.footer}>
        <p>
          Lovligheten rundt nedlasting er uklar - bruk kun til privat, ikke-kommersiell bruk.{" "}
          <a href="https://www.nrk.no/etikk/opphavsrett-pa-nrk.no-1.2843522" target="_blank" rel="noreferrer">
            Opphavsrett på NRK
          </a>
        </p>
        <p>
          <a href="https://github.com/ljskatt/nrk-dl-web" target="_blank" rel="noreferrer">
            Kildekode på GitHub
          </a>
        </p>
      </footer>
    </main>
  );
}

function StatusBadge({ s }: { s: Status }) {
  switch (s.state) {
    case "queued":
      return <span className={styles.badge}>I kø</span>;
    case "running":
      return (
        <span className={styles.progress}>
          <span style={{ width: `${s.pct}%` }} />
          <em>
            {s.pct}% · {s.mb} MB
          </em>
        </span>
      );
    case "done":
      return <span className={`${styles.badge} ${styles.ok}`}>Ferdig</span>;
    case "skipped":
      return <span className={styles.badge}>{s.why}</span>;
    case "error":
      return (
        <span className={`${styles.badge} ${styles.bad}`} title={s.why}>
          {s.why}
        </span>
      );
  }
}
