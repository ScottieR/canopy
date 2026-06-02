// Audio worklets for live voice — registered at runtime via Blob URLs so we
// don't need to teach the bundler about .worklet.js files.
//
// Two processors:
//   - canopy-mic-capture: downsamples the mic stream to 16kHz LINEAR16 PCM
//     and posts frames to the main thread roughly every 20ms.
//   - canopy-audio-playback: a tiny ring-buffer PCM player driven by frames
//     posted from the main thread. Supports flush (for barge-in) and rate-
//     conversion from 24kHz → output sample rate.
//
// Both processors are designed to be defensive: if the worklet runs at a
// sample rate we can't divide evenly, we use linear interpolation rather
// than aliasing-prone naive decimation/duplication.

// ─── Capture worklet source ──────────────────────────────────────────────

/**
 * Posts frames in the shape:
 *   { type: "pcm16", samples: Int16Array, sampleRate: 16000 }
 *
 * Down-samples whatever rate the AudioContext gives us (typically 48000) to
 * 16000 using simple low-pass + linear-interp. Not Studio-grade but more
 * than good enough for speech. We aim for ~20ms frames (320 samples @ 16kHz)
 * to balance latency vs. per-message overhead.
 */
export const CAPTURE_WORKLET_SOURCE = /* js */ `
class CapWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.outRate = 16000;
    this.outFrame = 320;            // ~20ms @ 16kHz
    this.outBuf = new Int16Array(this.outFrame);
    this.outWriteIdx = 0;
    // Cheap one-pole low-pass to fight aliasing before decimation. Cutoff is
    // ~7kHz which is plenty for speech and lets us keep the math trivial.
    this.lpState = 0;
    this.lpAlpha = 0.35;
    // Resampling cursor — fractional position into the input stream.
    this.srcPos = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;
    const inRate = sampleRate;       // AudioWorkletGlobalScope global
    const ratio = inRate / this.outRate;

    // Walk fractional output samples through the input buffer.
    while (this.srcPos < channel.length) {
      const i0 = Math.floor(this.srcPos);
      const i1 = Math.min(i0 + 1, channel.length - 1);
      const frac = this.srcPos - i0;

      // Low-pass the two endpoints we'll lerp between.
      const s0 = this.lpAlpha * channel[i0] + (1 - this.lpAlpha) * this.lpState;
      this.lpState = s0;
      const s1 = this.lpAlpha * channel[i1] + (1 - this.lpAlpha) * s0;

      const sample = s0 + (s1 - s0) * frac;
      // Float [-1, 1] → Int16.
      const clamped = Math.max(-1, Math.min(1, sample));
      this.outBuf[this.outWriteIdx++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;

      if (this.outWriteIdx >= this.outFrame) {
        // Post a copy so the main thread can transfer/encode without us
        // overwriting it on the next quantum.
        this.port.postMessage({
          type: "pcm16",
          samples: this.outBuf.slice(0),
          sampleRate: this.outRate,
        });
        this.outWriteIdx = 0;
      }

      this.srcPos += ratio;
    }
    // Carry remainder forward so we don't lose phase between quanta.
    this.srcPos -= channel.length;
    return true;
  }
}
registerProcessor("canopy-mic-capture", CapWorklet);
`;

// ─── Playback worklet source ─────────────────────────────────────────────

/**
 * Main thread sends frames via port:
 *   { type: "push", samples: Float32Array, sampleRate: 24000 }
 *   { type: "flush" }                          // barge-in — drop everything
 *   { type: "set-volume", value: 0..1 }
 *
 * The processor concatenates incoming frames into a ring buffer, resamples
 * to the AudioContext's destination rate on the fly, and reports underrun /
 * fullness back to the main thread so the UI can show a "speaking" pulse.
 */
export const PLAYBACK_WORKLET_SOURCE = /* js */ `
class PlayWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    // Mono ring buffer. ~3s at 48kHz = 144000. We over-allocate so we never
    // hit the wraparound in normal speech bursts.
    this.bufCap = 192000;
    this.buf = new Float32Array(this.bufCap);
    this.readIdx = 0;
    this.writeIdx = 0;
    this.filled = 0;
    this.volume = 1.0;
    // Source sample rate of incoming frames (set by first push).
    this.srcRate = 24000;
    // Fractional read cursor for resampling.
    this.srcPos = 0;
    // Track active/silent state for the main thread.
    this.wasActive = false;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === "push" && msg.samples) {
        this.srcRate = msg.sampleRate || this.srcRate;
        const n = msg.samples.length;
        for (let i = 0; i < n; i++) {
          this.buf[this.writeIdx] = msg.samples[i];
          this.writeIdx = (this.writeIdx + 1) % this.bufCap;
        }
        this.filled = Math.min(this.bufCap, this.filled + n);
      } else if (msg.type === "flush") {
        this.readIdx = this.writeIdx;
        this.filled = 0;
        this.srcPos = 0;
        if (this.wasActive) {
          this.port.postMessage({ type: "silence" });
          this.wasActive = false;
        }
      } else if (msg.type === "set-volume") {
        this.volume = Math.max(0, Math.min(1, msg.value));
      }
    };
  }
  // Read one float sample from the ring buffer at fractional position.
  readSample(pos) {
    if (this.filled <= 1) return 0;
    const i0 = Math.floor(pos) % this.filled;
    const i1 = (i0 + 1) % this.filled;
    const frac = pos - Math.floor(pos);
    const idx0 = (this.readIdx + i0) % this.bufCap;
    const idx1 = (this.readIdx + i1) % this.bufCap;
    return this.buf[idx0] * (1 - frac) + this.buf[idx1] * frac;
  }
  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const outRate = sampleRate;
    const ratio = this.srcRate / outRate;
    let produced = 0;

    if (this.filled === 0) {
      // No data — emit silence.
      out.fill(0);
      if (this.wasActive) {
        this.port.postMessage({ type: "silence" });
        this.wasActive = false;
      }
      return true;
    }

    if (!this.wasActive) {
      this.port.postMessage({ type: "active" });
      this.wasActive = true;
    }

    for (let i = 0; i < out.length; i++) {
      if (this.srcPos >= this.filled - 1) {
        // Exhausted available source samples — pad with silence and stop.
        out[i] = 0;
        continue;
      }
      out[i] = this.readSample(this.srcPos) * this.volume;
      this.srcPos += ratio;
      produced++;
    }
    // Advance ring read cursor by the integer source samples we consumed,
    // keep the fractional remainder for the next quantum.
    const consumedSamples = Math.floor(this.srcPos);
    this.readIdx = (this.readIdx + consumedSamples) % this.bufCap;
    this.filled = Math.max(0, this.filled - consumedSamples);
    this.srcPos -= consumedSamples;

    if (this.filled === 0 && this.wasActive) {
      this.port.postMessage({ type: "silence" });
      this.wasActive = false;
    }
    return true;
  }
}
registerProcessor("canopy-audio-playback", PlayWorklet);
`;

// ─── Loader ───────────────────────────────────────────────────────────────

/**
 * Register both worklets on an AudioContext. Safe to call multiple times —
 * the AudioWorklet API tracks registration internally and won't re-add the
 * same processor name. We do guard with a per-ctx flag because some Webkit
 * versions throw rather than no-op on duplicate registration.
 */
const REGISTERED = new WeakSet<AudioContext>();
export async function registerLiveVoiceWorklets(ctx: AudioContext): Promise<void> {
  if (REGISTERED.has(ctx)) return;
  const combined = `${CAPTURE_WORKLET_SOURCE}\n\n${PLAYBACK_WORKLET_SOURCE}`;
  const blob = new Blob([combined], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    await ctx.audioWorklet.addModule(url);
    REGISTERED.add(ctx);
  } finally {
    URL.revokeObjectURL(url);
  }
}
