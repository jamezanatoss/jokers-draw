import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { MAX_MUSIC_BYTES, checkAudioFile, clearCustomTrack, loadCustomTrack, saveCustomTrack } from '../src/ui/customMusic';
import { pickMusicSource } from '../src/ui/sound';

describe('custom music: file check', () => {
  it('accepts audio files', () => {
    expect(checkAudioFile({ name: 'song.mp3', type: 'audio/mpeg', size: 4_000_000 })).toBeNull();
    expect(checkAudioFile({ name: 'song.ogg', type: 'audio/ogg', size: 10 })).toBeNull();
    expect(checkAudioFile({ name: 'song.m4a', type: 'video/mp4', size: 10 })).toBeNull();
    expect(checkAudioFile({ name: 'track.flac', type: '', size: 10 })).toBeNull(); // no MIME type, known extension
  });

  it('rejects other files with a clear message', () => {
    expect(checkAudioFile({ name: 'photo.png', type: 'image/png', size: 10 })).toMatch(/not an audio file/);
    expect(checkAudioFile({ name: 'notes.txt', type: '', size: 10 })).toMatch(/not an audio file/);
    expect(checkAudioFile({ name: 'empty.mp3', type: 'audio/mpeg', size: 0 })).toMatch(/is empty/);
    expect(checkAudioFile({ name: 'huge.wav', type: 'audio/wav', size: MAX_MUSIC_BYTES + 1 })).toMatch(/too big/);
  });
});

describe('custom music: which track plays', () => {
  it("the player's own file wins in both modes; otherwise the dev file (vs AI) or the default", () => {
    expect(pickMusicSource({ custom: true, local: true, choice: 'local' })).toBe('custom'); // vs AI
    expect(pickMusicSource({ custom: true, local: false, choice: 'original' })).toBe('custom'); // online
    expect(pickMusicSource({ custom: false, local: true, choice: 'local' })).toBe('local');
    expect(pickMusicSource({ custom: false, local: true, choice: 'original' })).toBe('original');
    expect(pickMusicSource({ custom: false, local: false, choice: 'local' })).toBe('original');
  });
});

describe('custom music: remembered on this device (IndexedDB)', () => {
  it('saves, loads and clears the file', async () => {
    expect(await loadCustomTrack()).toBeNull();
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/mpeg' });
    await saveCustomTrack(blob, 'my song.mp3');
    const rec = await loadCustomTrack();
    expect(rec).toMatchObject({ name: 'my song.mp3', type: 'audio/mpeg', size: 4 });
    expect(new Uint8Array(await rec!.blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    await clearCustomTrack();
    expect(await loadCustomTrack()).toBeNull();
  });
});
