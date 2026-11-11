// AudioWorklet runs on the audio thread. Transfer small PCM blocks, never monitor the microphone.
class VoiceoverPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(2048);
    this.used = 0;
    this.first = 0;
    this.peak = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    // A missing quantum must remain a clock gap, including inside a partial block.
    if (this.used && currentFrame !== this.first + this.used) this.flush();
    if (!this.used) this.first = currentFrame;
    for (const value of channel) {
      this.peak = Math.max(this.peak, Math.abs(value));
      this.samples[this.used++] = Math.round(
        Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767),
      );
      if (this.used === this.samples.length) this.flush();
    }
    return true;
  }
  flush() {
    const samples = this.samples.subarray(0, this.used);
    this.port.postMessage({ frame: this.first, samples, peak: this.peak }, [
      samples.buffer,
    ]);
    this.samples = new Int16Array(2048);
    this.used = 0;
    this.peak = 0;
  }
}
registerProcessor("cutroom-voiceover", VoiceoverPcm);
