/**
 * A reel's media, kept in this browser between visits.
 *
 * Footage stays on the creator's machine -- nothing is uploaded to edit it
 * -- so for a saved edit to reopen with its pictures, the files themselves
 * are kept in the browser's private file storage (the Origin Private File
 * System), one folder per reel. On another machine, or a browser without
 * that storage, the edit still opens and the missing files are listed as
 * offline, to be relinked by importing them again under the same names.
 */

const ROOT = 'studio-media';

async function folder(projectId: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (!navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle(ROOT, { create });
    return await base.getDirectoryHandle(projectId, { create });
  } catch {
    return null;
  }
}

// File names can hold characters a directory entry cannot.
const entry = (name: string) => encodeURIComponent(name);

let askedToPersist = false;

/** Keep a copy of an imported file for this reel. Best effort: never throws. */
export async function keepMedia(projectId: string, file: File): Promise<boolean> {
  const dir = await folder(projectId, true);
  if (!dir) return false;
  try {
    const handle = await dir.getFileHandle(entry(file.name), { create: true });
    // Same size and date: already kept, no need to write it again.
    const existing = await handle.getFile();
    if (existing.size === file.size && existing.lastModified >= file.lastModified && existing.size > 0) return true;
    if (!('createWritable' in handle)) return false;
    const out = await (handle as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
    await out.write(file);
    await out.close();
    // Ask once that the browser not clear this storage under pressure.
    if (!askedToPersist) {
      askedToPersist = true;
      void navigator.storage.persist?.();
    }
    return true;
  } catch {
    return false;
  }
}

/** The kept files for these names, and the names not kept here. */
export async function mediaFor(projectId: string, names: readonly string[]): Promise<{ found: File[]; missing: string[] }> {
  const dir = await folder(projectId, false);
  const found: File[] = [];
  const missing: string[] = [];
  for (const name of names) {
    try {
      if (!dir) throw new Error('no folder');
      const handle = await dir.getFileHandle(entry(name));
      const kept = await handle.getFile();
      if (kept.size === 0) throw new Error('empty');
      // The kept file carries the encoded entry name; give it its own back.
      found.push(new File([kept], name, { type: kept.type || typeFor(name), lastModified: kept.lastModified }));
    } catch {
      missing.push(name);
    }
  }
  return { found, missing };
}

/** Drop a reel's kept media, when the reel is deleted. */
export async function forgetMedia(projectId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle(ROOT);
    await base.removeEntry(projectId, { recursive: true });
  } catch {
    /* nothing kept, or nothing to remove */
  }
}

// OPFS does not keep a file's type; the loader decides by it.
function typeFor(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    m4v: 'video/mp4',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
  };
  return map[ext] ?? '';
}
