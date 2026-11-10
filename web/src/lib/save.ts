// Lagring av filer i nettleseren.
// Chromium: File System Access API - strømmer rett til en mappe på disk.
// Andre: samler filen i minnet og laster ned som Blob (OK for korte programmer).

import type { Sink } from "./hls";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const canPickDirectory = () => typeof window !== "undefined" && "showDirectoryPicker" in window;

export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  return (window as any).showDirectoryPicker({ id: "nrk-web", mode: "readwrite" });
}

async function subdir(root: FileSystemDirectoryHandle, path: string[]) {
  let dir = root;
  for (const p of path) dir = await dir.getDirectoryHandle(p, { create: true });
  return dir;
}

export async function fileExists(root: FileSystemDirectoryHandle, path: string[], name: string) {
  try {
    const dir = await subdir(root, path);
    const f = await (await dir.getFileHandle(name)).getFile();
    return f.size > 0;
  } catch {
    return false;
  }
}

export async function dirSink(root: FileSystemDirectoryHandle, path: string[], name: string): Promise<Sink> {
  const dir = await subdir(root, path);
  // Skriv til .part og gi nytt navn når ferdig, så halve filer ikke ser ferdige ut.
  const partName = `${name}.part`;
  const handle = await dir.getFileHandle(partName, { create: true });
  const w = await (handle as any).createWritable();
  return {
    write: (c) => w.write(c),
    writeAt: (position, data) => w.write({ type: "write", position, data }),
    close: async () => {
      await w.close();
      if (typeof (handle as any).move === "function") {
        await (handle as any).move(name);
      } else {
        // Fallback: kopier til endelig navn
        const file = await handle.getFile();
        const dst = await dir.getFileHandle(name, { create: true });
        const dw = await (dst as any).createWritable();
        await file.stream().pipeTo(dw);
        await dir.removeEntry(partName);
      }
    },
    abort: async () => {
      await w.abort?.().catch(() => {});
      await dir.removeEntry(partName).catch(() => {});
    },
  };
}

export function blobSink(name: string, type = "video/mp4"): Sink {
  const parts: Uint8Array[] = [];
  return {
    write: async (c) => {
      parts.push(c);
    },
    // Patch bytes i delene vi allerede har (brukes bare for MP4-headeren)
    writeAt: async (position, data) => {
      let off = 0;
      for (let i = 0; i < parts.length && off < position + data.byteLength; i++) {
        const p = parts[i];
        const from = Math.max(position, off);
        const to = Math.min(position + data.byteLength, off + p.byteLength);
        if (from < to) {
          const copy = p.slice();
          copy.set(data.subarray(from - position, to - position), from - off);
          parts[i] = copy;
        }
        off += p.byteLength;
      }
    },
    close: async () => triggerDownload(new Blob(parts as BlobPart[], { type }), name),
    abort: async () => {
      parts.length = 0;
    },
  };
}

export function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function writeTextFile(root: FileSystemDirectoryHandle | null, path: string[], name: string, text: string) {
  if (!root) return triggerDownload(new Blob([text], { type: "text/vtt" }), name);
  const dir = await subdir(root, path);
  const w = await (await dir.getFileHandle(name, { create: true }) as any).createWritable();
  await w.write(text);
  await w.close();
}
/* eslint-enable @typescript-eslint/no-explicit-any */
