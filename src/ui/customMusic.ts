/**
 * The player's own music file. It never leaves the device: the file is kept in this browser's
 * IndexedDB (so it is remembered between visits) and played from a local object URL. Nothing
 * about it is ever sent to the server — online play only ever sends moves.
 */

export interface CustomTrack {
  name: string;
  type: string;
  size: number;
  blob: Blob;
  savedAt: number;
}

/** Largest file we accept (keeps IndexedDB use reasonable). */
export const MAX_MUSIC_BYTES = 60 * 1024 * 1024;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm|weba|mp4)$/i;

const DB = 'jokers-draw';
const STORE = 'music';
const KEY = 'custom';

/** Quick check before trying to play: is this plausibly an audio file we accept? */
export function checkAudioFile(f: { name: string; type: string; size: number }): string | null {
  const audioType = f.type.startsWith('audio/') || (f.type === 'video/mp4' && /\.m4a$|\.mp4$/i.test(f.name));
  if (!audioType && !(f.type === '' && AUDIO_EXT.test(f.name))) {
    return `“${f.name}” is not an audio file. Choose an MP3, M4A, OGG, WAV, FLAC or similar.`;
  }
  if (f.size === 0) return `“${f.name}” is empty.`;
  if (f.size > MAX_MUSIC_BYTES) {
    return `“${f.name}” is too big (${(f.size / 1048576).toFixed(0)} MB). The limit is ${MAX_MUSIC_BYTES / 1048576} MB.`;
  }
  return null;
}

/** Can this browser actually play it? Resolves with an error message, or null if it plays. */
export function probePlayable(url: string, name: string, timeoutMs = 8000): Promise<string | null> {
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = 'metadata';
    const done = (msg: string | null) => {
      clearTimeout(timer);
      a.removeAttribute('src');
      a.load();
      resolve(msg);
    };
    const timer = setTimeout(() => done(`“${name}” could not be read in time — it may be damaged.`), timeoutMs);
    a.addEventListener('loadedmetadata', () => done(Number.isFinite(a.duration) && a.duration > 0 ? null : `“${name}” has no playable audio.`), { once: true });
    a.addEventListener('error', () => done(`Your browser can't play “${name}” (unsupported format or damaged file).`), { once: true });
    a.src = url;
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        t.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        t.onerror = t.onabort = () => {
          db.close();
          reject(t.error ?? new Error('IndexedDB transaction failed'));
        };
      }),
  );
}

export async function saveCustomTrack(file: File | Blob, name: string): Promise<void> {
  const rec: CustomTrack = { name, type: file.type, size: file.size, blob: file, savedAt: Date.now() };
  await tx('readwrite', (s) => s.put(rec, KEY));
}

export async function loadCustomTrack(): Promise<CustomTrack | null> {
  try {
    const rec = (await tx('readonly', (s) => s.get(KEY))) as CustomTrack | undefined;
    return rec && rec.blob instanceof Blob ? rec : null;
  } catch {
    return null;
  }
}

export async function clearCustomTrack(): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(KEY));
  } catch {
    /* nothing stored */
  }
}
