import * as THREE from 'three';
import { getTerrainHeight } from '../sim/terrainField';
import { DOMAIN_HALF_SIZE } from '../sim/types';

export type CameraMode = 'ground' | 'elevated' | 'orbit';

const DEFAULT_X = 0;
const DEFAULT_Z = 5200;
const EYE_HEIGHT_M = 1.7;
const DEFAULT_YAW = 0.0; // Facing North (-Z) across open plains
const DEFAULT_PITCH = 0.2; // ~11.5 degrees upward so sky occupies ~75% of viewport
const DEFAULT_FOV = 64;
export const GROUND_WALK_SPEED_KMH = 120;
const GROUND_WALK_SPEED_MS = GROUND_WALK_SPEED_KMH / 3.6;

export class ObserverCameraController {
  public camera: THREE.PerspectiveCamera;
  public mode: CameraMode = 'ground';
  public fov = DEFAULT_FOV;

  public posX = DEFAULT_X;
  public posY = 10;
  public posZ = DEFAULT_Z;
  public yaw = DEFAULT_YAW;
  public pitch = DEFAULT_PITCH;

  // Orbit parameters
  private orbitRadius = 15500;
  private orbitTheta = 0.35;
  private orbitPhi = 0.34;
  private orbitTarget = new THREE.Vector3(0, 4200, -1500);

  private keysPressed = new Set<string>();
  private keyboardControlsEnabled = true;
  private joystickForward = 0;
  private joystickStrafe = 0;
  private isDragging = false;
  private prevPointerX = 0;
  private prevPointerY = 0;
  private activePointerId: number | null = null;
  private domElement: HTMLElement | null = null;

  constructor(aspect: number) {
    // Far plane raised to enclose the horizon-distance terrain (200 km half-extent) and the
    // 300 km sky dome. With a 0.35 m near plane the depth precision is dominated by near, not
    // far, so this extension is effectively free.
    this.camera = new THREE.PerspectiveCamera(DEFAULT_FOV, aspect, 0.35, 420000);
    this.resetToGroundObserver();
  }

  public attach(el: HTMLElement): void {
    this.domElement = el;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerCancel);
    el.addEventListener('lostpointercapture', this.onPointerCancel);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  public detach(): void {
    if (this.domElement) {
      this.domElement.removeEventListener('pointerdown', this.onPointerDown);
      this.domElement.removeEventListener('pointermove', this.onPointerMove);
      this.domElement.removeEventListener('pointerup', this.onPointerUp);
      this.domElement.removeEventListener('pointercancel', this.onPointerCancel);
      this.domElement.removeEventListener('lostpointercapture', this.onPointerCancel);
      this.domElement.removeEventListener('wheel', this.onWheel);
    }
    this.isDragging = false;
    this.activePointerId = null;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  public setKeyboardControlsEnabled(enabled: boolean): void {
    this.keyboardControlsEnabled = enabled;
    if (!enabled) this.keysPressed.clear();
  }

  public setJoystickInput(forward: number, strafe: number): void {
    this.joystickForward = Math.max(-1, Math.min(1, forward));
    this.joystickStrafe = Math.max(-1, Math.min(1, strafe));
  }

  public resetToGroundObserver(): void {
    this.mode = 'ground';
    this.posX = DEFAULT_X;
    this.posZ = DEFAULT_Z;
    this.posY = getTerrainHeight(this.posX, this.posZ) + EYE_HEIGHT_M;
    this.yaw = DEFAULT_YAW;
    this.pitch = DEFAULT_PITCH;
    this.setFov(DEFAULT_FOV);
    this.syncCameraTransform();
  }

  public setMode(newMode: CameraMode): void {
    this.mode = newMode;
    if (newMode === 'ground') {
      this.posY = getTerrainHeight(this.posX, this.posZ) + EYE_HEIGHT_M;
      if (this.pitch < -0.25) this.pitch = 0.16;
    } else if (newMode === 'elevated') {
      this.posY = Math.max(this.posY, getTerrainHeight(this.posX, this.posZ) + 850);
      this.pitch = 0.04;
    } else if (newMode === 'orbit') {
      this.orbitRadius = 17500;
      this.orbitPhi = 0.36;
    }
    this.syncCameraTransform();
  }

  public setFov(deg: number): void {
    this.fov = Math.max(24, Math.min(88, deg));
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
  }

  public nudgeMove(forward: number, strafe: number, dt: number): void {
    const speed = this.mode === 'ground' ? GROUND_WALK_SPEED_MS : 950.0;
    const length = Math.hypot(forward, strafe) || 1;
    const f = forward / length;
    const s = strafe / length;
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    this.posX += (-sinY * f + cosY * s) * speed * dt;
    this.posZ += (-cosY * f - sinY * s) * speed * dt;
    this.clampPosition();
  }

  public update(dt: number): void {
    if (this.mode !== 'orbit') {
      let forward = this.joystickForward;
      let strafe = this.joystickStrafe;
      let vert = 0;

      if (this.keyboardControlsEnabled) {
        if (this.keysPressed.has('KeyW') || this.keysPressed.has('ArrowUp')) forward += 1;
        if (this.keysPressed.has('KeyS') || this.keysPressed.has('ArrowDown')) forward -= 1;
        if (this.keysPressed.has('KeyD') || this.keysPressed.has('ArrowRight')) strafe += 1;
        if (this.keysPressed.has('KeyA') || this.keysPressed.has('ArrowLeft')) strafe -= 1;
        if (this.keysPressed.has('KeyE') || this.keysPressed.has('Space')) vert += 1;
        if (this.keysPressed.has('KeyQ') || this.keysPressed.has('ShiftLeft')) vert -= 1;
      }

      const len = Math.hypot(forward, strafe);
      if (len > 1) {
        forward /= len;
        strafe /= len;
      }
      const sprint = this.mode === 'ground' || !this.keysPressed.has('ShiftRight') ? 1.0 : 1.5;
      const baseSpeed = this.mode === 'ground' ? GROUND_WALK_SPEED_MS : 1100.0 * sprint;

      if (forward !== 0 || strafe !== 0) {
        const sinY = Math.sin(this.yaw);
        const cosY = Math.cos(this.yaw);
        this.posX += (-sinY * forward + cosY * strafe) * baseSpeed * dt;
        this.posZ += (-cosY * forward - sinY * strafe) * baseSpeed * dt;
      }

      this.clampPosition();
      const groundH = getTerrainHeight(this.posX, this.posZ);
      if (this.mode === 'ground') {
        this.posY = groundH + EYE_HEIGHT_M;
      } else {
        this.posY = Math.max(groundH + 15.0, Math.min(16000, this.posY + vert * 650.0 * dt));
      }
    }

    this.syncCameraTransform();
  }

  private clampPosition(): void {
    const bound = DOMAIN_HALF_SIZE - 900;
    this.posX = Math.max(-bound, Math.min(bound, this.posX));
    this.posZ = Math.max(-bound, Math.min(bound, this.posZ));
  }

  private syncCameraTransform(): void {
    if (this.mode === 'orbit') {
      const x =
        this.orbitTarget.x +
        this.orbitRadius * Math.cos(this.orbitPhi) * Math.sin(this.orbitTheta);
      const y =
        Math.max(
          getTerrainHeight(this.posX, this.posZ) + 80,
          this.orbitTarget.y + this.orbitRadius * Math.sin(this.orbitPhi)
        );
      const z =
        this.orbitTarget.z +
        this.orbitRadius * Math.cos(this.orbitPhi) * Math.cos(this.orbitTheta);

      this.camera.position.set(x, y, z);
      this.camera.lookAt(this.orbitTarget);
      this.posX = x;
      this.posY = y;
      this.posZ = z;
    } else {
      this.camera.position.set(this.posX, this.posY, this.posZ);
      const euler = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
      this.camera.quaternion.setFromEuler(euler);
    }
  }

  private onPointerDown = (e: PointerEvent): void => {
    // Only begin a camera drag on the canvas; capture the pointer so movement
    // remains continuous even when the finger/mouse leaves its bounds.
    if (e.target !== this.domElement || (e.pointerType === 'mouse' && e.button !== 0)) return;
    this.isDragging = true;
    this.activePointerId = e.pointerId;
    this.prevPointerX = e.clientX;
    this.prevPointerY = e.clientY;
    try { this.domElement?.setPointerCapture(e.pointerId); } catch { /* capture may be unavailable */ }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.isDragging || e.pointerId !== this.activePointerId) return;
    const dx = e.clientX - this.prevPointerX;
    const dy = e.clientY - this.prevPointerY;
    this.prevPointerX = e.clientX;
    this.prevPointerY = e.clientY;

    const sensitivity = 0.0032 * (this.fov / 64.0);
    if (this.mode === 'orbit') {
      this.orbitTheta -= dx * 0.0045;
      this.orbitPhi = Math.max(0.05, Math.min(1.38, this.orbitPhi + dy * 0.0045));
    } else {
      this.yaw -= dx * sensitivity;
      this.pitch = Math.max(-1.25, Math.min(1.48, this.pitch - dy * sensitivity));
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.activePointerId) return;
    this.isDragging = false;
    this.activePointerId = null;
    try { if (this.domElement?.hasPointerCapture(e.pointerId)) this.domElement.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  private onPointerCancel = (e: PointerEvent): void => {
    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
    this.isDragging = false;
    this.activePointerId = null;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (this.mode === 'orbit') {
      this.orbitRadius = Math.max(4000, Math.min(34000, this.orbitRadius + e.deltaY * 12.0));
    } else {
      this.setFov(this.fov + e.deltaY * 0.035);
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.keyboardControlsEnabled) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }
    const movementKey = [
      'KeyW', 'KeyA', 'KeyS', 'KeyD',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'KeyE', 'KeyQ', 'Space', 'ShiftLeft', 'ShiftRight',
    ].includes(e.code);
    if (movementKey) e.preventDefault();
    this.keysPressed.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keysPressed.delete(e.code);
  };
}
