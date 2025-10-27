export type AudioLevelCallback = (level: number) => void;

export interface AudioLevelMonitorOptions {
  smoothingTimeConstant?: number;
  fftSize?: number;
}

export class AudioLevelMonitor {
  private readonly source: MediaStreamAudioSourceNode;
  private readonly analyser: AnalyserNode;
  private readonly data: Uint8Array<ArrayBuffer>;
  private rafId: number | null = null;

  constructor(
    context: AudioContext,
    stream: MediaStream,
    private readonly onUpdate: AudioLevelCallback,
    options: AudioLevelMonitorOptions = {},
  ) {
    this.source = context.createMediaStreamSource(stream);
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = options.fftSize ?? 512;
    this.analyser.smoothingTimeConstant = options.smoothingTimeConstant ?? 0.8;
    this.source.connect(this.analyser);
    const buffer = new ArrayBuffer(this.analyser.frequencyBinCount);
    this.data = new Uint8Array<ArrayBuffer>(buffer);
  }

  start(): void {
    if (this.rafId !== null) {
      return;
    }
    const tick = () => {
      this.analyser.getByteTimeDomainData(this.data);
      let sum = 0;
      for (const value of this.data) {
        const normalized = (value - 128) / 128;
        sum += normalized * normalized;
      }
      const rms = Math.sqrt(sum / this.data.length);
      const level = Number.isFinite(rms) ? Math.min(1, rms) : 0;
      this.onUpdate(level);
      this.rafId = window.requestAnimationFrame(tick);
    };
    this.rafId = window.requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    try {
      this.source.disconnect();
    } catch (error) {
      // ignore disconnect errors
    }
    try {
      this.analyser.disconnect();
    } catch (error) {
      // ignore disconnect errors
    }
  }
}
