import { ActiveLightningDischarge, DischargePhase, PrecipitationType } from '../sim/types';

const SOUND_STROKE_PHASES = new Set<DischargePhase>(['return_stroke', 'dart_stroke']);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

type NoiseKind = 'brown' | 'pink' | 'white';

/** One layered band of the precipitation bus: a filter, its gain, and the buffer feeding it. */
interface RainBand {
  filter: BiquadFilterNode;
  gain: GainNode;
}

/**
 * Thunder is not a single bang. Sound from different parts of a kilometres-long channel travels
 * different distances, so it arrives spread over `(dMax - dMin) / c` seconds, each part filtered
 * differently by the air it crossed. That spread is measured here straight from the discharge
 * geometry rather than guessed from a duration constant, which is what makes a long horizontal
 * flash roll and a short nearby one crack.
 */
interface ChannelAcoustics {
  nearDistanceM: number;
  /** Arrival-time spread across the channel, in seconds. */
  rollSpanSec: number;
  /** Stereo pan at the near end and at the far end, so the roll can travel across the field. */
  nearPan: number;
  farPan: number;
}

const MAX_CONCURRENT_THUNDER = 6;
const SPEED_OF_SOUND = 343;

export class StormAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private enabled = false;
  private playedStrokes = new Map<string, number>();

  // Wind bus: brown-noise body plus a resonant "howl" band, both gusting on slow LFOs.
  private windOut: GainNode | null = null;
  private windBodyGain: GainNode | null = null;
  private windHowlGain: GainNode | null = null;
  private windHowlFilter: BiquadFilterNode | null = null;
  private windSource: AudioBufferSourceNode | null = null;
  private windLfos: OscillatorNode[] = [];
  /** Depth gain of each wind LFO, so gust factor can scale the modulation live. */
  private windLfoDepths: GainNode[] = [];

  // Rain bus: a single pink-noise source split across four bands, plus one tone filter that
  // shifts the whole timbre from the bright clatter of hail to the muffled hush of snow.
  private rainOut: GainNode | null = null;
  private rainTone: BiquadFilterNode | null = null;
  private rainBands: RainBand[] = [];
  private rainSource: AudioBufferSourceNode | null = null;

  // Reusable noise buffers. Allocating a fresh AudioBuffer per thunderclap was the old
  // behaviour, which churned memory exactly when the storm was busiest.
  private noisePool = new Map<string, AudioBuffer>();

  private activeThunder = 0;
  private tickBudget = 0;

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

  /**
   * Drives the continuous beds. Called at roughly 6 Hz from the HUD sync, so every parameter
   * uses a smoothing time constant rather than an instant set — that both avoids zipper noise
   * and means a 6 Hz update rate still sounds continuous.
   */
  public setEnvironment(
    windSpeedMS: number,
    rainRateMMHr: number,
    precipType: PrecipitationType = 'None',
    frozenFraction = 0,
    gustFactor = 0
  ): void {
    if (
      !this.enabled ||
      !this.context ||
      !this.windOut ||
      !this.rainOut ||
      !this.rainTone ||
      !this.windBodyGain ||
      !this.windHowlGain ||
      !this.windHowlFilter
    ) {
      return;
    }
    const now = this.context.currentTime;

    // ---- Wind --------------------------------------------------------------------------
    // Two layers with independent gust behaviour: the body roars, the howl band whistles and
    // shifts pitch as the gust strengthens, which is what makes wind sound like moving air
    // rather than a static noise loop at a different volume.
    const windLevel = clamp(Math.pow(windSpeedMS / 18, 1.12) * 0.13, 0.005, 0.19);
    const gust = clamp(gustFactor, 0, 1);
    this.windOut.gain.setTargetAtTime(windLevel, now, 0.8);
    this.windBodyGain.gain.setTargetAtTime(0.66 - gust * 0.12, now, 1.1);
    this.windHowlGain.gain.setTargetAtTime(0.34 + gust * 0.34, now, 0.7);
    // A resonant band centred higher as the wind hardens: ~480 Hz in a breeze, ~1.1 kHz in a
    // gale. Q rises too, so strong wind gets a narrower, more vocal peak.
    this.windHowlFilter.frequency.setTargetAtTime(480 + windSpeedMS * 26 + gust * 260, now, 1.4);
    this.windHowlFilter.Q.setTargetAtTime(3.2 + gust * 3.4, now, 1.4);
    // Gust depth on the modulation LFOs scales with how gusty the boundary layer actually is.
    for (const depthGain of this.windLfoDepths) {
      depthGain.gain.setTargetAtTime(0.28 + gust * 0.62, now, 1.6);
    }

    // ---- Precipitation ----------------------------------------------------------------
    // rate01 keeps the old ~55 mm/h saturation point so the mix does not get louder overall;
    // the sqrt simply compresses the very heavy end, matching how rain loudness is perceived.
    const rate01 = clamp(Math.sqrt(Math.max(0, rainRateMMHr) / 55), 0, 1);
    const frozen = clamp(frozenFraction, 0, 1);

    // Virga is precipitation that evaporates before reaching the ground. There is still a faint
    // hiss from the shaft aloft, but no impact noise at all, so it is heavily attenuated.
    const reachesGround = precipType === 'Virga' ? 0.22 : 1.0;
    // Snow muffles everything: less high-frequency detail, more low broadband hush, and a tone
    // filter pulled right down. Hail does the opposite and adds discrete clatter.
    const isSnow = precipType === 'Snow / Ice Pellets';
    const isHail = precipType === 'Hail & Heavy Rain' || precipType === 'Graupel Shower';
    const muffle = isSnow ? 0.42 : 1.0;

    const level = rate01 * reachesGround;
    const hiss = level * (isSnow ? 0.055 : isHail ? 0.2 : 0.17) * (precipType === 'Drizzle' ? 1.5 : 1.0);
    const patter = Math.pow(level, 1.2) * (isSnow ? 0.03 : 0.21);
    const roar = Math.pow(level, 2.2) * (isSnow ? 0.16 : 0.23);
    const impact = level * (isSnow ? 0.02 : isHail ? 0.2 : frozen * 0.13) *
      (precipType === 'Drizzle' ? 0.2 : 1.0);

    const bandLevels = [hiss, patter, roar, impact];
    for (let i = 0; i < this.rainBands.length; i++) {
      this.rainBands[i].gain.gain.setTargetAtTime(bandLevels[i] * muffle, now, 0.45);
    }
    // Whole-bus timbre: bright and open for hail, closed and soft for snow.
    this.rainTone.frequency.setTargetAtTime(isSnow ? 2100 : isHail ? 9400 : 5200 + frozen * 3600, now, 0.9);
    this.rainTone.Q.setTargetAtTime(isSnow ? 0.3 : 0.5 + frozen * 0.4, now, 0.9);

    // ---- Discrete hail / graupel impacts ----------------------------------------------
    // Frozen pellets hitting ground are individual events, not a bed. Rate is proportional to
    // the frozen fraction and intensity, and the budget is spread across the ~166 ms until the
    // next call, so the clatter stays irregular without ever spawning hundreds of voices.
    this.tickBudget += rate01 * frozen * reachesGround * 0.166 * 26;
    if (this.tickBudget > 1 && (isHail || frozen > 0.35) && !isSnow) {
      const count = Math.min(4, Math.floor(this.tickBudget));
      this.tickBudget -= count;
      for (let i = 0; i < count; i++) {
        this.playImpactTick(now + Math.random() * 0.17, 0.5 + rate01 * 0.9);
      }
    } else if (this.tickBudget > 6) {
      this.tickBudget = 6;
    }
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
      // Voice cap: an electrical storm can produce dozens of strokes per second, and each one
      // builds a handful of nodes. Dropping the excess keeps the graph from growing unbounded.
      if (this.activeThunder >= MAX_CONCURRENT_THUNDER) continue;
      this.playThunder(discharge, listener);
    }
  }

  public dispose(): void {
    this.enabled = false;
    for (const lfo of this.windLfos) {
      try {
        lfo.stop();
      } catch {
        /* already stopped */
      }
    }
    this.windLfos = [];
    this.windLfoDepths = [];
    this.windSource?.stop();
    this.rainSource?.stop();
    this.windSource = null;
    this.rainSource = null;
    this.noisePool.clear();
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') void context.close();
  }

  // ---------------------------------------------------------------------------------------
  // Graph construction
  // ---------------------------------------------------------------------------------------

  private createAudioGraph(): void {
    const context = new window.AudioContext();
    this.context = context;
    this.master = context.createGain();
    this.master.gain.value = 0;
    this.master.connect(context.destination);

    this.buildWindBus(context);
    this.buildRainBus(context);
  }

  /**
   * Wind: one looping brown-noise source split into a broadband body and a resonant howl band.
   * Two slow LFOs — one on the howl's amplitude, one on its centre frequency, at deliberately
   * incommensurate rates so the gust pattern never audibly repeats — give it turbulence.
   */
  private buildWindBus(context: AudioContext): void {
    this.windOut = context.createGain();
    this.windOut.gain.value = 0;
    this.windOut.connect(this.master!);

    this.windSource = context.createBufferSource();
    this.windSource.buffer = this.getNoise(6, 'brown');
    this.windSource.loop = true;

    // Broadband roar.
    const bodyFilter = context.createBiquadFilter();
    bodyFilter.type = 'lowpass';
    bodyFilter.frequency.value = 385;
    bodyFilter.Q.value = 0.7;
    this.windBodyGain = context.createGain();
    this.windBodyGain.gain.value = 0.66;
    this.windSource.connect(bodyFilter);
    bodyFilter.connect(this.windBodyGain);
    this.windBodyGain.connect(this.windOut);

    // Resonant whistle, the part that actually sounds like wind moving past things.
    this.windHowlFilter = context.createBiquadFilter();
    this.windHowlFilter.type = 'bandpass';
    this.windHowlFilter.frequency.value = 620;
    this.windHowlFilter.Q.value = 3.6;
    this.windHowlGain = context.createGain();
    this.windHowlGain.gain.value = 0.3;
    this.windSource.connect(this.windHowlFilter);
    this.windHowlFilter.connect(this.windHowlGain);
    this.windHowlGain.connect(this.windOut);

    // Amplitude gust on the howl band, 0.09 Hz.
    this.addModulator(context, 0.087, 0.3, this.windHowlGain.gain);
    // Pitch drift on the howl band, 0.053 Hz and +-210 Hz: gusts sharpen the whistle.
    this.addModulator(context, 0.053, 210, this.windHowlFilter.frequency);
    // A slower swell across the whole bus, 0.031 Hz, so even steady wind breathes.
    this.addModulator(context, 0.031, 0.18, this.windOut.gain);

    this.windSource.start();
  }

  /**
   * Rain: one looping pink-noise source (1/f, which sits far closer to real rainfall than white)
   * split across four bands. Band gains are driven per type from setEnvironment; a single
   * lowpass on the output carries the overall bright-hail to muffled-snow timbre shift.
   */
  private buildRainBus(context: AudioContext): void {
    this.rainOut = context.createGain();
    this.rainOut.gain.value = 1;
    this.rainTone = context.createBiquadFilter();
    this.rainTone.type = 'lowpass';
    this.rainTone.frequency.value = 6200;
    this.rainTone.Q.value = 0.5;
    this.rainTone.connect(this.rainOut);
    this.rainOut.connect(this.master!);

    this.rainSource = context.createBufferSource();
    this.rainSource.buffer = this.getNoise(5, 'pink');
    this.rainSource.loop = true;

    // [type, frequency, Q] — hiss (fine droplets), patter (mid body), roar (heavy-rain low end),
    // impact (hail and graupel clatter).
    const specs: Array<[BiquadFilterType, number, number]> = [
      ['highpass', 3600, 0.7],
      ['bandpass', 1520, 0.5],
      ['lowpass', 430, 0.8],
      ['bandpass', 2950, 2.1],
    ];
    this.rainBands = [];
    for (const [type, freq, q] of specs) {
      const filter = context.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = freq;
      filter.Q.value = q;
      const gain = context.createGain();
      gain.gain.value = 0;
      this.rainSource.connect(filter);
      filter.connect(gain);
      gain.connect(this.rainTone);
      this.rainBands.push({ filter, gain });
    }

    this.rainSource.start();
  }

  /** Connects an LFO through a depth gain to an AudioParam, and remembers it for disposal. */
  private addModulator(
    context: AudioContext,
    freqHz: number,
    depth: number,
    target: AudioParam
  ): void {
    const lfo = context.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = freqHz;
    // Random start phase so the gust pattern is not synchronised across sessions.
    const depthGain = context.createGain();
    depthGain.gain.value = depth;
    lfo.connect(depthGain);
    depthGain.connect(target);
    lfo.start(context.currentTime + Math.random() * (1 / freqHz));
    this.windLfos.push(lfo);
    this.windLfoDepths.push(depthGain);
  }

  /** Returns a cached noise buffer, generating it once on first use. */
  private getNoise(seconds: number, kind: NoiseKind): AudioBuffer {
    const context = this.context!;
    const key = `${kind}:${seconds}`;
    const cached = this.noisePool.get(key);
    if (cached) return cached;

    const length = Math.ceil(context.sampleRate * seconds);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const samples = buffer.getChannelData(0);

    if (kind === 'brown') {
      let low = 0;
      for (let i = 0; i < length; i++) {
        low = (low + 0.035 * (Math.random() * 2 - 1)) / 1.035;
        samples[i] = low * 3.2;
      }
    } else if (kind === 'pink') {
      // Paul Kellet's refined method: six cascaded first-order filters giving an accurate
      // enough 1/f slope to read as rainfall rather than as electronic hiss.
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        samples[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.16;
        b6 = white * 0.115926;
      }
    } else {
      for (let i = 0; i < length; i++) samples[i] = (Math.random() * 2 - 1) * 0.62;
    }

    this.noisePool.set(key, buffer);
    return buffer;
  }

  // ---------------------------------------------------------------------------------------
  // One-shot events
  // ---------------------------------------------------------------------------------------

  /** A single frozen-pellet impact: a few milliseconds of bright, randomly placed noise. */
  private playImpactTick(atTime: number, strength: number): void {
    const context = this.context!;
    const src = context.createBufferSource();
    src.buffer = this.getNoise(0.05, 'white');
    src.playbackRate.value = 0.8 + Math.random() * 0.7;
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2600 + Math.random() * 2600;
    filter.Q.value = 1.6 + Math.random() * 2.2;
    const pan = context.createStereoPanner();
    pan.pan.value = Math.random() * 2 - 1;
    const env = context.createGain();
    const peak = 0.012 * strength * (0.5 + Math.random());
    env.gain.setValueAtTime(0.0001, atTime);
    env.gain.linearRampToValueAtTime(peak, atTime + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, atTime + 0.035 + Math.random() * 0.03);
    src.connect(filter);
    filter.connect(pan);
    pan.connect(env);
    env.connect(this.master!);
    src.start(atTime, Math.random() * 0.03);
    src.stop(atTime + 0.1);
    src.onended = () => {
      src.disconnect();
      filter.disconnect();
      pan.disconnect();
      env.disconnect();
    };
  }

  /**
   * Measures the acoustic footprint of a discharge channel: nearest point, arrival-time spread
   * between the nearest and farthest parts, and the stereo pan at each end.
   */
  private measureChannel(
    discharge: ActiveLightningDischarge,
    listener: { x: number; y: number; z: number }
  ): ChannelAcoustics {
    let minDistSq = Number.POSITIVE_INFINITY;
    let maxDistSq = 0;
    let nearX = discharge.termPoint[0];
    let farX = discharge.termPoint[0];
    let nearDist = 40;
    let farDist = 40;

    for (const segment of discharge.segments) {
      // Three samples per segment: ends and midpoint, enough to resolve the channel extent
      // without walking every metre of a branching fractal.
      const samples = [
        [segment.x1, segment.y1, segment.z1],
        [(segment.x1 + segment.x2) * 0.5, (segment.y1 + segment.y2) * 0.5, (segment.z1 + segment.z2) * 0.5],
        [segment.x2, segment.y2, segment.z2],
      ];
      for (const [x, y, z] of samples) {
        const dx = x - listener.x;
        const dy = y - listener.y;
        const dz = z - listener.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq < minDistSq) {
          minDistSq = distSq;
          nearX = x;
        }
        if (distSq > maxDistSq) {
          maxDistSq = distSq;
          farX = x;
        }
      }
    }

    nearDist = Math.max(40, Math.sqrt(minDistSq));
    farDist = Math.max(nearDist, Math.sqrt(maxDistSq));

    return {
      nearDistanceM: nearDist,
      rollSpanSec: clamp((farDist - nearDist) / SPEED_OF_SOUND, 0.02, 7),
      nearPan: clamp((nearX - listener.x) / 12000, -0.85, 0.85),
      farPan: clamp((farX - listener.x) / 12000, -0.85, 0.85),
    };
  }

  /**
   * Renders one stroke as a crack (near), a set of sub-booms spread across the channel's real
   * arrival-time window and travelling across the stereo field, and a long decaying tail.
   */
  private playThunder(
    discharge: ActiveLightningDischarge,
    listener: { x: number; y: number; z: number }
  ): void {
    const context = this.context!;
    const now = context.currentTime;
    const ac = this.measureChannel(discharge, listener);
    const distanceM = ac.nearDistanceM;
    const arrival = now + distanceM / SPEED_OF_SOUND;

    // Peak current sets loudness and how much low-frequency energy survives; a long channel
    // (large rollSpan) means more, longer-separated reflections.
    const currentScale = Math.sqrt(Math.max(0.15, discharge.peakCurrentKA / 40));
    const baseIntensity = clamp((0.5 * currentScale * 1400) / (distanceM + 900), 0.02, 0.55);

    // Air absorbs high frequencies over distance, so the cutoff falls with range. Longer
    // channels also arrive later from their far end and are correspondingly duller.
    const cutoff = clamp(2250 / (1 + distanceM / 5800), 105, 2250);

    // Number of distinct booms: driven by the measured roll span and by stroke strength.
    const boomCount = clamp(2 + Math.round(ac.rollSpanSec * 1.4 + currentScale * 1.6), 2, 7);
    const tailDuration = clamp(2.4 + distanceM / 6200 + ac.rollSpanSec * 0.9, 2.4, 13);

    this.activeThunder++;
    let pending = boomCount + (distanceM < 9000 ? 1 : 0) + 1;
    const releaseVoice = () => {
      pending--;
      if (pending <= 0) this.activeThunder = Math.max(0, this.activeThunder - 1);
    };

    // ---- Sub-booms, spread over the channel's arrival window ---------------------------
    for (let i = 0; i < boomCount; i++) {
      // Later booms come from farther parts of the channel: quieter, duller, and panned toward
      // the far end, so the roll physically travels across the stereo image.
      const t = boomCount === 1 ? 0 : i / (boomCount - 1);
      const wobble = (Math.random() - 0.5) * ac.rollSpanSec * 0.35;
      const boomAt = arrival + t * ac.rollSpanSec + wobble;
      const fade = Math.pow(1 - t, 0.72) * (0.62 + Math.random() * 0.55);
      const pan = ac.nearPan + (ac.farPan - ac.nearPan) * t;
      this.playBoom(
        boomAt,
        baseIntensity * fade,
        clamp(cutoff * (1 - t * 0.45), 90, 2250),
        pan,
        clamp(0.55 + t * 1.5 + distanceM / 9000, 0.5, 3.4),
        releaseVoice
      );
    }

    // ---- Initial crack, only when the channel is close enough to retain high frequencies --
    if (distanceM < 9000) {
      const crack = context.createBufferSource();
      crack.buffer = this.getNoise(0.4, 'white');
      const crackFilter = context.createBiquadFilter();
      crackFilter.type = 'bandpass';
      crackFilter.frequency.value = clamp(2750 - distanceM * 0.17, 950, 2750);
      crackFilter.Q.value = 0.85;
      const crackPan = context.createStereoPanner();
      crackPan.pan.value = ac.nearPan;
      const crackEnv = context.createGain();
      const crackLevel = baseIntensity * (1 - distanceM / 11000) * 0.95;
      crackEnv.gain.setValueAtTime(0.0001, arrival);
      crackEnv.gain.linearRampToValueAtTime(Math.max(0.001, crackLevel), arrival + 0.006);
      crackEnv.gain.exponentialRampToValueAtTime(0.0001, arrival + 0.2 + distanceM / 42000);
      crack.connect(crackFilter);
      crackFilter.connect(crackPan);
      crackPan.connect(crackEnv);
      crackEnv.connect(this.master!);
      crack.start(arrival, Math.random() * 0.1);
      crack.stop(arrival + 0.4);
      crack.onended = () => {
        crack.disconnect();
        crackFilter.disconnect();
        crackPan.disconnect();
        crackEnv.disconnect();
        releaseVoice();
      };

      // Very close strikes get a chest-level sub thump from the sudden pressure rise.
      if (distanceM < 2200) {
        const sub = context.createOscillator();
        sub.type = 'sine';
        sub.frequency.setValueAtTime(52, arrival);
        sub.frequency.exponentialRampToValueAtTime(24, arrival + 0.42);
        const subEnv = context.createGain();
        subEnv.gain.setValueAtTime(0.0001, arrival);
        subEnv.gain.linearRampToValueAtTime(clamp(baseIntensity * 1.15, 0.01, 0.5), arrival + 0.012);
        subEnv.gain.exponentialRampToValueAtTime(0.0001, arrival + 0.55);
        sub.connect(subEnv);
        subEnv.connect(this.master!);
        sub.start(arrival);
        sub.stop(arrival + 0.6);
      }
    }

    // ---- Long tail: the last of the roll, decaying over several seconds ------------------
    this.playBoom(arrival + ac.rollSpanSec * 0.5, baseIntensity * 0.34, cutoff * 0.55, ac.farPan, tailDuration, releaseVoice);
  }

  /** One thunder burst: brown noise through a distance-filtered envelope with a stereo position. */
  private playBoom(
    atTime: number,
    level: number,
    cutoffHz: number,
    pan: number,
    duration: number,
    onDone: () => void
  ): void {
    const context = this.context!;
    const src = context.createBufferSource();
    src.buffer = this.getNoise(6, 'brown');
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = clamp(cutoffHz, 80, 2400);
    filter.Q.value = 0.6;
    const panner = context.createStereoPanner();
    panner.pan.value = clamp(pan, -0.95, 0.95);
    const env = context.createGain();
    const peak = clamp(level, 0.004, 0.6);
    const start = Math.max(atTime, context.currentTime);
    env.gain.setValueAtTime(0.0001, start);
    env.gain.linearRampToValueAtTime(peak, start + 0.02);
    // Hold briefly then fall: the hold is what reads as "rolling" rather than "popping".
    env.gain.setTargetAtTime(peak * 0.42, start + 0.05, 0.14 + duration * 0.05);
    env.gain.setTargetAtTime(0.0001, start + duration * 0.22, duration * 0.26);
    src.connect(filter);
    filter.connect(panner);
    panner.connect(env);
    env.connect(this.master!);
    // Random read offset into the shared buffer so successive booms are not the same sample.
    src.start(start, Math.random() * 4.5);
    src.stop(start + duration + 1.2);
    src.onended = () => {
      src.disconnect();
      filter.disconnect();
      panner.disconnect();
      env.disconnect();
      onDone();
    };
  }
}
