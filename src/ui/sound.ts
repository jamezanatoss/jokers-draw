/**
 * Sound: background music and card-game sound effects, all synthesised with the Web Audio API.
 *
 * Music, in order of preference:
 *   1. the player's own file (`setCustomTrack`), if they chose one — vs. AI and online, for this
 *      player only; it stays on their device (see customMusic.ts);
 *   2. dev only, vs. AI only: a private track from the gitignored local-audio/ folder
 *      (`setLocalTrack`); it is never part of a build;
 *   3. the game's own original loop ("Joker's Gambit", music.ts).
 * Browsers only allow audio after a user gesture: the engine is unlocked on the first
 * pointer/key press. Music plays only while a match is running (`startMusic` / `stopMusic`),
 * always from the top; Deal is a user gesture, so autoplay rules are satisfied.
 */
import { SynthMusic } from './music';

/** Which track a match asks for: the private local file (dev, vs-AI only) or the original loop. */
export type MusicChoice = 'local' | 'original';
export type MusicSource = 'custom' | 'local' | 'original';

/** Which source plays: the player's own file wins, then the dev-only local file (if asked for). */
export function pickMusicSource(o: { custom: boolean; local: boolean; choice: MusicChoice }): MusicSource {
  if (o.custom) return 'custom';
  if (o.choice === 'local' && o.local) return 'local';
  return 'original';
}

export type Sfx =
  | 'shuffle'
  | 'deal'
  | 'flip'
  | 'select'
  | 'deselect'
  | 'exchange'
  | 'coin'
  | 'call'
  | 'drop'
  | 'win'
  | 'lose'
  | 'gameOverWin'
  | 'gameOverLose'
  | 'coinFlip'
  | 'click'
  | 'swish'
  | 'tick';

export interface SoundSettings {
  musicVolume: number; // 0..1
  sfxVolume: number; // 0..1
  musicMuted: boolean;
  sfxMuted: boolean;
}

const KEY = 'jokers-draw:sound';
const DEFAULTS: SoundSettings = { musicVolume: 0.35, sfxVolume: 0.6, musicMuted: false, sfxMuted: false };
/** Overall loudness ceilings: keep effects and music in the background. */
const SFX_CEILING = 0.55;
const MUSIC_CEILING = 0.5;
/** The synth loop is mixed hotter than a mastered file would be; this evens them out. */
const SYNTH_CEILING = 0.9;

function load(): SoundSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const v = JSON.parse(raw) as Partial<SoundSettings>;
    const vol = (x: unknown, d: number) => (typeof x === 'number' && x >= 0 && x <= 1 ? x : d);
    return {
      musicVolume: vol(v.musicVolume, DEFAULTS.musicVolume),
      sfxVolume: vol(v.sfxVolume, DEFAULTS.sfxVolume),
      musicMuted: v.musicMuted === true,
      sfxMuted: v.sfxMuted === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export class Sound {
  settings: SoundSettings = load();
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  /** The private local track (dev only), if one was found. */
  private music: HTMLAudioElement | null = null;
  /** The player's own track (object URL of their file), if they chose one. */
  private custom: HTMLAudioElement | null = null;
  private customName: string | null = null;
  private customUrl: string | null = null;
  /** Set when the player's file fails while playing (shown in the sound panel). */
  customError: string | null = null;
  private synth: SynthMusic | null = null;
  private synthOut: GainNode | null = null;
  private choice: MusicChoice = 'original';
  private unlocked = false;
  private musicFailed = false;
  /** True while a match is running (music wanted, subject to mute/volume). */
  private musicOn = false;
  private listeners: (() => void)[] = [];

  constructor() {
    const unlock = () => this.unlock();
    window.addEventListener('pointerdown', unlock, { once: true, capture: true });
    window.addEventListener('keydown', unlock, { once: true, capture: true });
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  get allMuted(): boolean {
    return this.settings.musicMuted && this.settings.sfxMuted;
  }

  /** Dev only: a private track that vs-AI matches may use instead of the original loop. */
  setLocalTrack(url: string): void {
    const a = new Audio();
    a.loop = true;
    a.preload = 'none';
    a.src = url;
    a.addEventListener('error', () => {
      this.musicFailed = true;
      this.applyMusic(); // fall back to the original loop
    });
    this.music = a;
  }

  get hasLocalTrack(): boolean {
    return !!this.music && !this.musicFailed;
  }

  /**
   * The player's own music: `url` is a local object URL of their file (null = back to the
   * default). It replaces the default track right away, also in a running match (from the top).
   */
  setCustomTrack(url: string | null, name: string | null = null): void {
    if (this.custom) {
      this.custom.pause();
      this.custom.removeAttribute('src');
      this.custom.load();
    }
    if (this.customUrl && this.customUrl !== url) URL.revokeObjectURL(this.customUrl);
    this.custom = null;
    this.customName = null;
    this.customUrl = null;
    this.customError = null;
    if (url) {
      const a = new Audio();
      a.loop = true;
      a.preload = 'auto';
      a.src = url;
      a.addEventListener('error', () => {
        if (this.custom !== a) return;
        this.customError = `“${name ?? 'Your file'}” stopped playing — using the default music.`;
        this.custom = null;
        this.applyMusic();
        for (const fn of this.listeners) fn();
      });
      this.custom = a;
      this.customName = name;
      this.customUrl = url;
    }
    this.rewind();
    this.applyMusic();
    for (const fn of this.listeners) fn();
  }

  /** File name of the player's own music, or null when the default plays. */
  get customTrackName(): string | null {
    return this.custom ? this.customName : null;
  }

  /** Match started: play the track from the beginning (silent if music is muted). */
  startMusic(choice: MusicChoice = 'original'): void {
    this.choice = choice;
    this.musicOn = true;
    this.rewind();
    this.applyMusic();
  }

  /** Match over / back to the start screen: stop and rewind, so the next match starts fresh. */
  stopMusic(): void {
    this.musicOn = false;
    this.custom?.pause();
    this.music?.pause();
    this.synth?.pause();
    this.rewind();
  }

  /** For checks: which track is audibly playing right now. */
  get musicPlaying(): MusicSource | null {
    if (this.custom && !this.custom.paused) return 'custom';
    if (this.music && !this.music.paused) return 'local';
    if (this.synth?.playing) return 'original';
    return null;
  }

  /** For checks: playback position of the player's own file (s). */
  get customPosition(): number {
    return this.custom?.currentTime ?? 0;
  }

  /** For checks: position of the original loop (16th steps). */
  get musicPosition(): number {
    return this.synth?.position ?? 0;
  }

  private rewind(): void {
    for (const a of [this.music, this.custom]) {
      if (!a) continue;
      try {
        a.currentTime = 0;
      } catch {
        /* not loaded yet: it starts at 0 anyway */
      }
    }
    this.synth?.rewind();
  }

  /** Create the effects engine after the first user gesture (autoplay rules). */
  unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AC) {
      try {
        this.ctx = new AC();
        this.out = this.ctx.createGain();
        this.out.connect(this.ctx.destination);
        this.applySfx();
        void this.ctx.resume();
      } catch {
        this.ctx = null;
      }
    }
    this.applyMusic();
  }

  setMusicVolume(v: number): void {
    this.settings.musicVolume = Math.max(0, Math.min(1, v));
    if (this.settings.musicVolume > 0) this.settings.musicMuted = false;
    this.changed();
  }
  setSfxVolume(v: number): void {
    this.settings.sfxVolume = Math.max(0, Math.min(1, v));
    if (this.settings.sfxVolume > 0) this.settings.sfxMuted = false;
    this.changed();
  }
  toggleMusic(): void {
    this.settings.musicMuted = !this.settings.musicMuted;
    this.changed();
  }
  toggleSfx(): void {
    this.settings.sfxMuted = !this.settings.sfxMuted;
    this.changed();
  }
  /** M key: mute everything, or unmute everything if all is muted. */
  toggleAll(): void {
    const mute = !this.allMuted;
    this.settings.musicMuted = mute;
    this.settings.sfxMuted = mute;
    this.changed();
  }

  private changed(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.settings));
    } catch {
      /* storage unavailable */
    }
    this.applyMusic();
    this.applySfx();
    for (const fn of this.listeners) fn();
  }

  private applyMusic(): void {
    const s = this.settings;
    const want = this.musicOn && !s.musicMuted && s.musicVolume > 0;
    const source = pickMusicSource({ custom: !!this.custom, local: !!this.music && !this.musicFailed, choice: this.choice });
    const useFile = source !== 'original';
    for (const [a, src] of [[this.custom, 'custom'], [this.music, 'local']] as const) {
      if (!a) continue;
      a.volume = s.musicVolume * MUSIC_CEILING;
      const on = want && source === src;
      if (on && a.paused) {
        a.play().catch(() => {
          /* blocked: stay silent */
        });
      } else if (!on && !a.paused) a.pause();
    }
    // The original loop needs the audio engine (created on the first user gesture).
    if (this.ctx && !this.synth) {
      this.synthOut = this.ctx.createGain();
      this.synthOut.connect(this.ctx.destination);
      this.synth = new SynthMusic(this.ctx, this.synthOut);
    }
    if (this.synth && this.synthOut && this.ctx) {
      this.synthOut.gain.setTargetAtTime(s.musicVolume * MUSIC_CEILING * SYNTH_CEILING, this.ctx.currentTime, 0.03);
      if (want && !useFile) {
        void this.ctx.resume();
        this.synth.start();
      } else this.synth.pause();
    }
  }

  private applySfx(): void {
    if (!this.out || !this.ctx) return;
    const s = this.settings;
    const v = s.sfxMuted ? 0 : s.sfxVolume * SFX_CEILING;
    this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  // ------------------------------------------------------------------ synthesis

  /** Play an effect, optionally after `delay` seconds. */
  play(name: Sfx, delay = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.out || this.settings.sfxMuted || this.settings.sfxVolume === 0) return;
    const t = ctx.currentTime + 0.01 + delay;
    switch (name) {
      case 'deal':
        this.noise(t, 0.06, 'bandpass', 3200, 1.2, 0.5, 1800);
        this.tone(t, 150, 0.05, 'sine', 0.12, 90);
        break;
      case 'flip':
        this.noise(t, 0.09, 'bandpass', 1400, 2, 0.45, 4200);
        break;
      case 'shuffle':
        for (let i = 0; i < 16; i++) {
          const ti = t + i * 0.034 + Math.random() * 0.012;
          this.noise(ti, 0.03, 'bandpass', 2400 + Math.random() * 1800, 1.5, 0.28);
        }
        this.noise(t + 0.6, 0.18, 'bandpass', 1800, 0.8, 0.3, 900);
        break;
      case 'select':
        this.tone(t, 880, 0.07, 'triangle', 0.16, 990);
        break;
      case 'deselect':
        this.tone(t, 660, 0.07, 'triangle', 0.14, 560);
        break;
      case 'swish':
        // Quiet airy sweep for the card-swipe phases.
        this.noise(t, 0.22, 'bandpass', 900, 0.9, 0.16, 3800);
        break;
      case 'tick':
        // Light tick as a card lands.
        this.noise(t, 0.018, 'highpass', 4200, 0.8, 0.12);
        this.tone(t, 1900, 0.025, 'sine', 0.03);
        break;
      case 'click':
        this.tone(t, 520, 0.04, 'triangle', 0.1);
        break;
      case 'exchange':
        this.noise(t, 0.11, 'bandpass', 3800, 1.4, 0.4, 900);
        this.noise(t + 0.12, 0.11, 'bandpass', 3800, 1.4, 0.35, 900);
        break;
      case 'coin':
        this.coin(t);
        break;
      case 'call':
        this.tone(t, 523.25, 0.14, 'triangle', 0.2);
        this.tone(t + 0.12, 783.99, 0.28, 'triangle', 0.2);
        break;
      case 'drop':
        this.tone(t, 330, 0.34, 'square', 0.05, 150, 1200);
        this.noise(t, 0.2, 'lowpass', 900, 0.7, 0.15, 300);
        break;
      case 'win':
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(t + i * 0.085, f, i === 3 ? 0.45 : 0.16, 'triangle', 0.18));
        break;
      case 'lose':
        [392, 329.63, 261.63].forEach((f, i) => this.tone(t + i * 0.16, f, i === 2 ? 0.5 : 0.2, 'sawtooth', 0.06, undefined, 1400));
        break;
      case 'gameOverWin':
        [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => this.tone(t + i * 0.11, f, 0.22, 'triangle', 0.18));
        [523.25, 659.25, 783.99, 1046.5].forEach((f) => this.tone(t + 0.62, f, 1.1, 'triangle', 0.1));
        for (let i = 0; i < 4; i++) this.coin(t + 0.7 + i * 0.09);
        break;
      case 'gameOverLose':
        [440, 415.3, 392, 369.99, 349.23].forEach((f, i) => this.tone(t + i * 0.2, f, 0.24, 'sawtooth', 0.06, undefined, 1200));
        this.tone(t + 1.05, 261.63, 1.2, 'sawtooth', 0.07, 196, 900);
        break;
      case 'coinFlip':
        for (let i = 0; i < 12; i++) {
          const ti = t + 0.15 * (1 - Math.pow(0.86, i)) * 9; // pings slowing down
          this.tone(ti, 2900 + (i % 2) * 400, 0.06, 'sine', 0.07);
        }
        this.coin(t + 1.75);
        break;
    }
  }

  private env(g: GainNode, t: number, peak: number, dur: number, attack = 0.004): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  private tone(
    t: number,
    freq: number,
    dur: number,
    type: OscillatorType,
    gain: number,
    freqEnd?: number,
    lowpass?: number,
  ): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = ctx.createGain();
    this.env(g, t, gain, dur);
    let node: AudioNode = o;
    if (lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lowpass;
      o.connect(f);
      node = f;
    }
    node.connect(g).connect(this.out!);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private noise(
    t: number,
    dur: number,
    type: BiquadFilterType,
    freq: number,
    q: number,
    gain: number,
    freqEnd?: number,
  ): void {
    const ctx = this.ctx!;
    if (!this.noiseBuf) {
      const len = Math.floor(ctx.sampleRate * 0.5);
      this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = ctx.createGain();
    this.env(g, t, gain, dur, 0.002);
    src.connect(f).connect(g).connect(this.out!);
    src.start(t, Math.random() * 0.3);
    src.stop(t + dur + 0.02);
  }

  /** Metallic clink: a few inharmonic partials with fast decay. */
  private coin(t: number): void {
    const base = 2000 + Math.random() * 300;
    [1, 1.52, 2.03, 2.61].forEach((m, i) => this.tone(t, base * m, 0.32 - i * 0.05, 'sine', [0.12, 0.08, 0.05, 0.03][i]));
    this.noise(t, 0.02, 'highpass', 5000, 0.7, 0.12);
  }
}
