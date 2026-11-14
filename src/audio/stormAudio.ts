import { ActiveLightningDischarge, DischargePhase } from '../sim/types';

const SOUND_STROKE_PHASES = new Set<DischargePhase>(['return_stroke', 'dart_stroke']);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class StormAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private windGain: GainNode | null = null;
  private rainGain: GainNode | null = null;
  private windSource: AudioBufferSourceNode | null = null;
  private rainSource: AudioBufferSourceNode | null = null;
  private enabled = false;
  private playedStrokes = new Map<string, number>();

  public async enable(): Promise<boolean> {
    if (typeof window === 'undefined' || !window.AudioContext) return false;
    if (!this.context) this.createAudioGraph();
    try {
      await this.context!.resume();
      this.enabled = true;
      this.master!.gain.setTargetAtTime(0.72, this.context!.currentTime, 0.08);
      return true;
    } catch {
      return false;
    }
  }

  public disable(): void {
    this.enabled = false;
    if (this.context && this.master) {
      this.master.gain.setTargetAtTime(0, this.context.currentTime, 0.06);
    }
  }

  public setEnvironment(windSpeedMS: number, rainRateMMHr: number): void {
    if (!this.enabled || !this.context || !this.windGain || !this.rainGain) return;
    const now = this.context.currentTime;
    const windLevel = clamp((windSpeedMS / 18) * 0.09, 0.008, 0.12);
    const rainLevel = clamp(Math.sqrt(Math.max(0, rainRateMMHr) / 55) * 0.22, 0, 0.23);
    this.windGain.gain.setTargetAtTime(windLevel, now, 0.8);
    this.rainGain.gain.setTargetAtTime(rainLevel, now, 0.45);
  }

  public syncLightning(
    discharges: readonly ActiveLightningDischarge[],
    listener: { x: number; y: number; z: number }
  ): void {
    if (!this.enabled || !this.context) return;
    const nowMs = performance.now();
    for (const [key, createdAt] of this.playedStrokes) {
      if (nowMs - createdAt > 30000) this.playedStrokes.delete(key);
    }

    for (const discharge of discharges) {
      if (!SOUND_STROKE_PHASES.has(discharge.phase)) continue;
      const strokeKey = `${discharge.id}:${discharge.currentStrokeIndex}`;
      if (this.playedStrokes.has(strokeKey)) continue;
      this.playedStrokes.set(strokeKey, nowMs);
      this.playThunder(discharge, listener);
    }
  }

  public dispose(): void {
    this.enabled = false;
    this.windSource?.stop();
    this.rainSource?.stop();
    this.windSource = null;
    this.rainSource = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') void context.close();
  }

  private createAudioGraph(): void {
    const context = new window.AudioContext();
    this.context = context;
    this.master = context.createGain();
    this.master.gain.value = 0;
    this.master.connect(context.destination);

    const windFilter = context.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 420;
    windFilter.connect(this.master);
    this.windGain = context.createGain();
    this.windGain.gain.value = 0;
    this.windGain.connect(windFilter);
    this.windSource = context.createBufferSource();
    this.windSource.buffer = this.createNoiseBuffer(5, true);
    this.windSource.loop = true;
    this.windSource.connect(this.windGain);
    this.windSource.start();

    const rainFilter = context.createBiquadFilter();
    rainFilter.type = 'bandpass';
    rainFilter.frequency.value = 1650;
    rainFilter.Q.value = 0.45;
    rainFilter.connect(this.master);
    this.rainGain = context.createGain();
    this.rainGain.gain.value = 0;
    this.rainGain.connect(rainFilter);
    this.rainSource = context.createBufferSource();
    this.rainSource.buffer = this.createNoiseBuffer(4, false);
    this.rainSource.loop = true;
    this.rainSource.connect(this.rainGain);
    this.rainSource.start();
  }

  private createNoiseBuffer(seconds: number, brown: boolean): AudioBuffer {
    const context = this.context!;
    const length = Math.ceil(context.sampleRate * seconds);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const samples = buffer.getChannelData(0);
    let low = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      low = brown ? (low + 0.035 * white) / 1.035 : white;
      samples[i] = brown ? low * 3.2 : white * 0.62;
    }
    return buffer;
  }

  private playThunder(
    discharge: ActiveLightningDischarge,
    listener: { x: number; y: number; z: number }
  ): void {
    const context = this.context!;
    const now = context.currentTime;
    let nearestDistanceSq = Number.POSITIVE_INFINITY;
    let nearestX = discharge.termPoint[0];

    for (const segment of discharge.segments) {
      const samples = [
        [segment.x1, segment.y1, segment.z1],
        [(segment.x1 + segment.x2) * 0.5, (segment.y1 + segment.y2) * 0.5, (segment.z1 + segment.z2) * 0.5],
        [segment.x2, segment.y2, segment.z2],
      ];
      for (const [x, y, z] of samples) {
        const dx = x - listener.x;
        const dy = y - listener.y;
        const dz = z - listener.z;
        const distanceSq = dx * dx + dy * dy + dz * dz;
        if (distanceSq < nearestDistanceSq) {
          nearestDistanceSq = distanceSq;
          nearestX = x;
        }
      }
    }

    const distanceM = Math.max(40, Math.sqrt(nearestDistanceSq));
    const arrival = now + distanceM / 343;
    const rumbleDuration = clamp(2.5 + distanceM / 7000, 2.5, 11);
    const intensity = clamp(
      0.48 * Math.sqrt(Math.max(0.15, discharge.peakCurrentKA / 40)) * 1400 / (distanceM + 900),
      0.018,
      0.52
    );
    const pan = clamp((nearestX - listener.x) / 12000, -0.85, 0.85);

    const rumble = context.createBufferSource();
    rumble.buffer = this.createNoiseBuffer(rumbleDuration + 0.5, true);
    const rumbleFilter = context.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = clamp(2100 / (1 + distanceM / 6000), 115, 2100);
    const rumblePan = context.createStereoPanner();
    rumblePan.pan.value = pan;
    const rumbleEnvelope = context.createGain();
    rumbleEnvelope.gain.setValueAtTime(0.0001, arrival);
    rumbleEnvelope.gain.linearRampToValueAtTime(intensity, arrival + 0.025);
    rumbleEnvelope.gain.setTargetAtTime(intensity * 0.46, arrival + 0.04, 0.16 + distanceM / 60000);
    rumbleEnvelope.gain.setTargetAtTime(0.0001, arrival + 0.34, rumbleDuration * 0.27);
    rumble.connect(rumbleFilter);
    rumbleFilter.connect(rumblePan);
    rumblePan.connect(rumbleEnvelope);
    rumbleEnvelope.connect(this.master!);
    rumble.start(arrival);
    rumble.stop(arrival + rumbleDuration + 1.5);

    // Nearby return strokes have a sharp crack; distant channels arrive as a softened roll.
    if (distanceM < 10000) {
      const crack = context.createBufferSource();
      crack.buffer = this.createNoiseBuffer(0.24, false);
      const crackFilter = context.createBiquadFilter();
      crackFilter.type = 'bandpass';
      crackFilter.frequency.value = clamp(2600 - distanceM * 0.16, 900, 2600);
      crackFilter.Q.value = 0.8;
      const crackPan = context.createStereoPanner();
      crackPan.pan.value = pan;
      const crackEnvelope = context.createGain();
      const crackLevel = intensity * (1 - distanceM / 12000) * 0.85;
      crackEnvelope.gain.setValueAtTime(0.0001, arrival);
      crackEnvelope.gain.linearRampToValueAtTime(Math.max(0.001, crackLevel), arrival + 0.008);
      crackEnvelope.gain.exponentialRampToValueAtTime(0.0001, arrival + 0.22 + distanceM / 40000);
      crack.connect(crackFilter);
      crackFilter.connect(crackPan);
      crackPan.connect(crackEnvelope);
      crackEnvelope.connect(this.master!);
      crack.start(arrival);
      crack.stop(arrival + 0.35);
    }
  }
}
