/**
 * Live synth for the game's original loop (score in musicScore.ts). Everything is Web Audio:
 * no samples, no files. Timbres aim at late-90s console sound chips / samplers: FM electric
 * piano, a resonant saw bass, a detuned pulse lead with vibrato and pitch scoops, a short
 * triangle "mallet", and noise-based drums through a small generated room reverb + echo.
 *
 * Scheduling: a lookahead scheduler (setInterval) queues notes slightly ahead on the audio
 * clock, so timing is sample-accurate and the loop is seamless. Each start() builds a fresh
 * output bus; pause() fades it out and disconnects it, which also silences notes that were
 * already queued.
 */
import { type NoteEvent, STEP_SEC, TOTAL_STEPS, eventsAt, swingOffset } from './musicScore';

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

export class SynthMusic {
  private bus: GainNode | null = null;
  private fxSend: GainNode | null = null;
  private echoSend: GainNode | null = null;
  private timer = 0;
  private step = 0;
  private nextTime = 0;
  private readonly noise: AudioBuffer;
  private readonly ir: AudioBuffer;
  playing = false;

  constructor(
    private readonly ctx: AudioContext,
    /** Volume node owned by Sound (music volume / mute). */
    private readonly out: AudioNode,
  ) {
    const sr = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, sr, sr);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    // Small dark room: decaying stereo noise.
    const len = Math.floor(sr * 1.8);
    this.ir = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const ch = this.ir.getChannelData(c);
      for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    }
  }

  /** Start (or resume) from the current position. */
  start(): void {
    if (this.playing) return;
    this.playing = true;
    const ctx = this.ctx;
    const bus = ctx.createGain();
    bus.gain.value = 0.0001;
    bus.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 0.08);
    bus.connect(this.out);
    // Reverb send
    const verb = ctx.createConvolver();
    verb.buffer = this.ir;
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.32;
    const fxSend = ctx.createGain();
    fxSend.connect(verb).connect(verbOut).connect(bus);
    // Dotted-8th echo (lead only), darkened in the feedback path
    const echo = ctx.createDelay(1);
    echo.delayTime.value = STEP_SEC * 3;
    const fb = ctx.createGain();
    fb.gain.value = 0.28;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 1800;
    const echoSend = ctx.createGain();
    echoSend.connect(echo).connect(tone).connect(fb).connect(echo);
    const echoOut = ctx.createGain();
    echoOut.gain.value = 0.35;
    tone.connect(echoOut).connect(bus);
    this.bus = bus;
    this.fxSend = fxSend;
    this.echoSend = echoSend;
    this.nextTime = ctx.currentTime + 0.06;
    this.timer = window.setInterval(() => this.tick(), 25);
    this.tick();
  }

  /** Stop sound now, keep the position. */
  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    window.clearInterval(this.timer);
    const bus = this.bus;
    if (bus) {
      const t = this.ctx.currentTime;
      bus.gain.cancelScheduledValues(t);
      bus.gain.setValueAtTime(bus.gain.value, t);
      bus.gain.linearRampToValueAtTime(0, t + 0.08);
      window.setTimeout(() => bus.disconnect(), 250);
    }
    this.bus = this.fxSend = this.echoSend = null;
  }

  /** Back to bar 1 (the next start plays from the top). */
  rewind(): void {
    const was = this.playing;
    if (was) this.pause();
    this.step = 0;
    if (was) this.start();
  }

  get position(): number {
    return this.step;
  }

  private tick(): void {
    // Background tabs run timers about once a second: queue further ahead there.
    const ahead = document.hidden ? 1.6 : 0.25;
    while (this.nextTime < this.ctx.currentTime + ahead) {
      const t = this.nextTime + swingOffset(this.step) * STEP_SEC;
      for (const e of eventsAt(this.step)) this.note(e, t);
      this.nextTime += STEP_SEC;
      this.step = (this.step + 1) % TOTAL_STEPS;
    }
  }

  // ------------------------------------------------------------------ instruments

  private note(e: NoteEvent, t: number): void {
    const dur = e.len * STEP_SEC;
    switch (e.inst) {
      case 'bass':
        return this.bassNote(e, t, dur);
      case 'keys':
        return this.keysNote(e, t, dur);
      case 'lead':
        return this.leadNote(e, t, dur);
      case 'mallet':
        return this.malletNote(e, t);
      case 'kick':
        return this.kick(e, t);
      case 'snare':
        return this.snare(e, t);
      case 'hat':
      case 'openhat':
      case 'shaker':
        return this.hat(e, t);
    }
  }

  private amp(t: number, peak: number, attack: number, hold: number, release: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.setValueAtTime(Math.max(0.0002, peak * 0.8), t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    return g;
  }

  private osc(type: OscillatorType, f: number, t: number, end: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    o.start(t);
    o.stop(end + 0.05);
    return o;
  }

  private bassNote(e: NoteEvent, t: number, dur: number): void {
    if (!this.bus) return;
    const f = hz(e.midi);
    const end = t + dur * 0.92 + 0.06;
    const g = this.amp(t, 0.34 * e.vel, 0.006, Math.max(0.02, dur * 0.8), 0.07);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 7;
    lp.frequency.setValueAtTime(260, t);
    lp.frequency.exponentialRampToValueAtTime(260 + 1300 * e.vel, t + 0.02);
    lp.frequency.exponentialRampToValueAtTime(320, t + 0.22);
    const saw = this.osc('sawtooth', f, t, end);
    const sub = this.osc('square', f / 2, t, end);
    const subG = this.ctx.createGain();
    subG.gain.value = 0.35;
    saw.connect(lp);
    sub.connect(subG).connect(lp);
    lp.connect(g).connect(this.bus);
  }

  /** Two-operator FM electric piano. */
  private keysNote(e: NoteEvent, t: number, dur: number): void {
    if (!this.bus || !this.fxSend) return;
    const f = hz(e.midi);
    const end = t + dur + 0.35;
    const car = this.osc('sine', f, t, end);
    const mod = this.osc('sine', f, t, end);
    const idx = this.ctx.createGain();
    idx.gain.setValueAtTime(f * 1.6, t);
    idx.gain.exponentialRampToValueAtTime(f * 0.15, t + 0.35);
    mod.connect(idx).connect(car.frequency);
    // a hint of tine: quiet partial
    const tine = this.osc('sine', f * 4.02, t, t + 0.12);
    const tg = this.amp(t, 0.012 * e.vel, 0.002, 0.01, 0.1);
    tine.connect(tg).connect(this.bus);
    const g = this.amp(t, 0.06 * e.vel, 0.005, Math.max(0.03, dur), 0.3);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
    car.connect(g).connect(lp);
    lp.connect(this.bus);
    lp.connect(this.fxSend);
  }

  /** Detuned pulse + saw with a scoop into the note, delayed vibrato and a resonant filter. */
  private leadNote(e: NoteEvent, t: number, dur: number): void {
    if (!this.bus || !this.fxSend || !this.echoSend) return;
    const f = hz(e.midi);
    const end = t + dur * 0.95 + 0.12;
    const a = this.osc('square', f, t, end);
    const b = this.osc('sawtooth', f * 1.006, t, end);
    for (const o of [a, b]) {
      o.detune.setValueAtTime(-45, t); // sly scoop up into the note
      o.detune.linearRampToValueAtTime(0, t + 0.07);
    }
    if (dur > 0.35) {
      const lfo = this.osc('sine', 5.3, t, end);
      const depth = this.ctx.createGain();
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(0, t + 0.22);
      depth.gain.linearRampToValueAtTime(14, t + 0.5);
      lfo.connect(depth);
      depth.connect(a.detune);
      depth.connect(b.detune);
    }
    const mix = this.ctx.createGain();
    mix.gain.value = 0.5;
    a.connect(mix);
    b.connect(mix);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = e.dark ? 3 : 6;
    const top = e.dark ? 900 : 2300;
    lp.frequency.setValueAtTime(top * 0.6, t);
    lp.frequency.exponentialRampToValueAtTime(top, t + 0.06);
    lp.frequency.exponentialRampToValueAtTime(top * 0.7, t + Math.max(0.1, dur));
    const g = this.amp(t, 0.085 * e.vel, 0.012, Math.max(0.03, dur * 0.85), 0.1);
    mix.connect(lp).connect(g);
    g.connect(this.bus);
    g.connect(this.fxSend);
    g.connect(this.echoSend);
  }

  private malletNote(e: NoteEvent, t: number): void {
    if (!this.bus || !this.fxSend) return;
    const f = hz(e.midi);
    const tri = this.osc('triangle', f, t, t + 0.4);
    const ov = this.osc('sine', f * 3.98, t, t + 0.1);
    const g = this.amp(t, 0.07 * e.vel, 0.002, 0.01, 0.3);
    const g2 = this.amp(t, 0.02 * e.vel, 0.001, 0.005, 0.06);
    tri.connect(g);
    ov.connect(g2);
    for (const n of [g, g2]) {
      n.connect(this.bus);
      n.connect(this.fxSend);
    }
  }

  private noiseSrc(t: number, dur: number): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
    return src;
  }

  private kick(e: NoteEvent, t: number): void {
    if (!this.bus) return;
    const o = this.osc('sine', 125, t, t + 0.4);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
    const g = this.amp(t, 0.42 * e.vel, 0.002, 0.04, 0.28);
    o.connect(g).connect(this.bus);
  }

  private snare(e: NoteEvent, t: number): void {
    if (!this.bus || !this.fxSend) return;
    const n = this.noiseSrc(t, 0.2);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1900;
    bp.Q.value = 0.9;
    const g = this.amp(t, 0.16 * e.vel, 0.001, 0.01, 0.13);
    n.connect(bp).connect(g);
    g.connect(this.bus);
    g.connect(this.fxSend);
    const body = this.osc('triangle', 190, t, t + 0.12);
    body.frequency.exponentialRampToValueAtTime(150, t + 0.08);
    const bg = this.amp(t, 0.09 * e.vel, 0.001, 0.005, 0.07);
    body.connect(bg).connect(this.bus);
  }

  private hat(e: NoteEvent, t: number): void {
    if (!this.bus) return;
    const open = e.inst === 'openhat';
    const shaker = e.inst === 'shaker';
    const len = open ? 0.26 : shaker ? 0.05 : 0.035;
    const n = this.noiseSrc(t, len);
    const f = this.ctx.createBiquadFilter();
    f.type = shaker ? 'bandpass' : 'highpass';
    f.frequency.value = shaker ? 6500 : 7200;
    const g = this.amp(t, (shaker ? 0.05 : 0.07) * e.vel, 0.001, 0.003, len);
    n.connect(f).connect(g).connect(this.bus);
  }
}
