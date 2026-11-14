import * as THREE from 'three';
import { ActiveLightningDischarge } from '../sim/types';

const SAMPLE_INTERVAL = 1 / 40;

/** 40 Hz stochastic observer shake driven by the active return-stroke channel. */
export class LightningCameraShake {
  private sampleAccumulator = 0;
  private current = new THREE.Vector3();
  private target = new THREE.Vector3();
  private envelope = 0;
  private random = Math.random;

  update(dt: number, discharges: ActiveLightningDischarge[], cameraPosition: THREE.Vector3): THREE.Vector3 {
    let strongest = 0;
    for (const discharge of discharges) {
      if (discharge.phase !== 'return_stroke' && discharge.phase !== 'dart_stroke' && discharge.phase !== 'continuing_current') continue;
      let distanceM = Infinity;
      for (const segment of discharge.segments) {
        const ax = segment.x1 - cameraPosition.x;
        const ay = segment.y1 - cameraPosition.y;
        const az = segment.z1 - cameraPosition.z;
        const dx = segment.x2 - segment.x1;
        const dy = segment.y2 - segment.y1;
        const dz = segment.z2 - segment.z1;
        const lengthSq = dx * dx + dy * dy + dz * dz;
        const t = lengthSq > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy + az * dz) / lengthSq)) : 0;
        const px = ax + dx * t;
        const py = ay + dy * t;
        const pz = az + dz * t;
        distanceM = Math.min(distanceM, Math.sqrt(px * px + py * py + pz * pz));
      }
      if (!Number.isFinite(distanceM)) continue;
      distanceM = Math.max(35, distanceM);
      const currentFactor = Math.pow(Math.max(0, discharge.peakCurrentKA) / 100, 0.72);
      const lengthFactor = Math.pow(Math.max(0.15, discharge.channelLengthKm) / 4, 0.32);
      const branchFactor = 0.82 + Math.min(0.35, discharge.branchCount / 80);
      const radiusFactor = 0.85 + Math.min(0.25, discharge.channelRadiusM / 0.12);
      const channelShapeFactor = 0.9 + Math.min(0.2, discharge.segments.length / 500);
      const thermalFactor = Math.pow(Math.max(0.5, discharge.channelTemperatureK / 25000), 0.65);
      const distanceFactor = 1 / (1 + Math.pow(distanceM / 950, 1.35));
      const phaseFactor = discharge.phase === 'continuing_current' ? 0.48 : 1.0;
      const intensity = currentFactor * lengthFactor * branchFactor * radiusFactor * channelShapeFactor * thermalFactor * distanceFactor * phaseFactor;
      strongest = Math.max(strongest, intensity);
    }

    const desired = Math.min(0.018, strongest * 0.014);
    this.envelope += (desired - this.envelope) * Math.min(1, dt * (desired > this.envelope ? 32 : 7));
    this.sampleAccumulator += Math.min(dt, 0.1);
    while (this.sampleAccumulator >= SAMPLE_INTERVAL) {
      this.sampleAccumulator -= SAMPLE_INTERVAL;
      const axis = new THREE.Vector3(this.random() * 2 - 1, this.random() * 2 - 1, this.random() * 2 - 1).normalize();
      const amplitude = this.envelope * (0.55 + this.random() * 0.9);
      this.target.copy(axis.multiplyScalar(amplitude));
    }
    this.current.lerp(this.target, Math.min(1, dt * 65));
    return this.current;
  }
}
