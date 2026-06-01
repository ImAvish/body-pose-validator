/**
 * useDeviceCameraPitch.ts
 *
 * Reads real phone camera pitch from device sensors when available.
 *
 * Expected convention for pitchDeg:
 *   90°  = phone/camera is roughly level with the user's body
 *   <90° = phone is angled downward from above  -> CAMERA_TOO_HIGH
 *   >90° = phone is angled upward from below    -> CAMERA_TOO_LOW
 *
 * Sources supported:
 *   1. Native WebView bridge (recommended):
 *      window.BodyValidatorSensor.getPitchDeg() or window.BodyValidatorSensor.pitchDeg
 *      window.BodyValidatorCameraPitchDeg
 *
 *   2. Web DeviceOrientation fallback:
 *      Math.abs(event.beta)
 *
 * For Android/iOS production WebView, prefer the native bridge because it is
 * more predictable than browser permission behavior.
 */

import { useEffect, useRef, useState } from 'react';
import type { AppConfig } from '../types/models';
import type { ValidationError } from '../types/validation';

export type CameraPitchSource = 'native' | 'web' | 'none';
export type CameraPitchPermissionState = 'unknown' | 'granted' | 'denied' | 'unsupported';

export interface DeviceCameraPitchReading {
  available: boolean;
  pitchDeg: number | null;
  source: CameraPitchSource;
  lastUpdatedAt: number;
  permissionState: CameraPitchPermissionState;
}

export interface DeviceCameraPitchResult {
  used: boolean;
  pitchDeg: number | null;
  direction: 'level' | 'tooHigh' | 'tooLow' | 'unknown';
  errors: ValidationError[];
  warnings: ValidationError[];
}

declare global {
  interface Window {
    BodyValidatorCameraPitchDeg?: number;
    BodyValidatorSensor?: {
      pitchDeg?: number;
      getPitchDeg?: () => number | null | undefined;
    };
  }
}

const EMPTY_READING: DeviceCameraPitchReading = {
  available: false,
  pitchDeg: null,
  source: 'none',
  lastUpdatedAt: 0,
  permissionState: 'unknown',
};

export function useDeviceCameraPitch(enabled: boolean, config?: AppConfig): DeviceCameraPitchReading {
  const [reading, setReading] = useState<DeviceCameraPitchReading>(EMPTY_READING);
  const lastSourceRef = useRef<CameraPitchSource>('none');
  const smoothedPitchRef = useRef<number | null>(null);
  const nativeLastUpdatedAtRef = useRef(0);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      setReading(EMPTY_READING);
      return;
    }

    let isMounted = true;
    let nativePollTimer: ReturnType<typeof setInterval> | null = null;
    let webOrientationStarted = false;

    const updateReading = (pitchDeg: number | null | undefined, source: CameraPitchSource) => {
      if (!isMounted || typeof pitchDeg !== 'number' || !Number.isFinite(pitchDeg)) return;
      const normalized = normalizePitchDeg(pitchDeg);
      const alpha = Math.max(0.05, Math.min(1, config?.cameraSensorPitch.smoothingAlpha ?? 0.22));
      const previous = smoothedPitchRef.current;
      const smoothed = previous === null
        ? normalized
        : previous + (normalized - previous) * alpha;

      smoothedPitchRef.current = smoothed;
      lastSourceRef.current = source;
      if (source === 'native') nativeLastUpdatedAtRef.current = Date.now();

      setReading({
        available: true,
        pitchDeg: smoothed,
        source,
        lastUpdatedAt: Date.now(),
        permissionState: 'granted',
      });
    };

    const readNativePitch = () => {
      const bridge = window.BodyValidatorSensor;
      const pitchFromGetter = bridge?.getPitchDeg?.();
      const pitchFromProperty = bridge?.pitchDeg;
      const pitchFromGlobal = window.BodyValidatorCameraPitchDeg;
      updateReading(pitchFromGetter ?? pitchFromProperty ?? pitchFromGlobal, 'native');
    };

    // Native bridge polling. This is intentionally cheap and lets Android/iOS
    // WebView push pitch values without needing browser DeviceOrientation.
    readNativePitch();
    nativePollTimer = setInterval(readNativePitch, 250);

    const handleNativeEvent = (event: Event) => {
      const custom = event as CustomEvent<{ pitchDeg?: number; beta?: number }>;
      updateReading(custom.detail?.pitchDeg ?? custom.detail?.beta, 'native');
    };

    window.addEventListener('bodyValidatorCameraPitch', handleNativeEvent as EventListener);
    window.addEventListener('bodyValidatorSensorPitch', handleNativeEvent as EventListener);

    const handleOrientation = (event: DeviceOrientationEvent) => {
      // Prefer native if it is actively providing values.
      if (lastSourceRef.current === 'native' && Date.now() - nativeLastUpdatedAtRef.current < 1500) return;
      if (typeof event.beta !== 'number') return;

      // In portrait, beta is close to 90 when the phone is upright/level with
      // the body. Tilt from above/below moves it away from 90.
      updateReading(Math.abs(event.beta), 'web');
    };

    const enableWebOrientationListener = () => {
      if (webOrientationStarted) return;
      webOrientationStarted = true;
      window.addEventListener('deviceorientation', handleOrientation);
      if (isMounted) {
        setReading((prev) => ({ ...prev, permissionState: 'granted' }));
      }
    };

    const startWebDeviceOrientation = async (forcePermissionRequest = false) => {
      if (typeof window.DeviceOrientationEvent === 'undefined') {
        if (isMounted) {
          setReading((prev) => ({ ...prev, permissionState: prev.available ? 'granted' : 'unsupported' }));
        }
        return;
      }

      try {
        const ctor = window.DeviceOrientationEvent as typeof DeviceOrientationEvent & {
          requestPermission?: () => Promise<'granted' | 'denied'>;
        };

        if (typeof ctor.requestPermission === 'function') {
          // iOS/Safari requires this call from a user gesture. Do not call it
          // automatically on mount; wait for the CameraCapture button to dispatch
          // bodyValidatorRequestDeviceOrientationPermission.
          if (!forcePermissionRequest) {
            if (isMounted) {
              setReading((prev) => ({ ...prev, permissionState: prev.available ? 'granted' : 'unknown' }));
            }
            return;
          }

          const permission = await ctor.requestPermission();
          if (!isMounted) return;
          if (permission !== 'granted') {
            setReading((prev) => ({ ...prev, permissionState: prev.available ? 'granted' : 'denied' }));
            return;
          }
        }

        enableWebOrientationListener();
      } catch {
        if (isMounted) {
          setReading((prev) => ({ ...prev, permissionState: prev.available ? 'granted' : 'denied' }));
        }
      }
    };

    const handlePermissionRequest = () => {
      void startWebDeviceOrientation(true);
    };

    window.addEventListener('bodyValidatorRequestDeviceOrientationPermission', handlePermissionRequest);
    void startWebDeviceOrientation(false);

    return () => {
      isMounted = false;
      if (nativePollTimer) clearInterval(nativePollTimer);
      window.removeEventListener('deviceorientation', handleOrientation);
      window.removeEventListener('bodyValidatorCameraPitch', handleNativeEvent as EventListener);
      window.removeEventListener('bodyValidatorSensorPitch', handleNativeEvent as EventListener);
      window.removeEventListener('bodyValidatorRequestDeviceOrientationPermission', handlePermissionRequest);
    };
  // reading.lastUpdatedAt is intentionally not a dependency; the handler only
  // needs a coarse preference for native values and the polling loop updates it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, config]);

  return reading;
}

export function validateDeviceCameraPitch(
  reading: DeviceCameraPitchReading,
  config: AppConfig
): DeviceCameraPitchResult {
  const cfg = config.cameraSensorPitch;
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  if (!cfg.enabled || !cfg.useSensorWhenAvailable) {
    return { used: false, pitchDeg: null, direction: 'unknown', errors, warnings };
  }

  const readingIsFresh =
    reading.available &&
    typeof reading.pitchDeg === 'number' &&
    Date.now() - reading.lastUpdatedAt <= cfg.maxReadingAgeMs;

  if (!readingIsFresh) {
    return { used: false, pitchDeg: null, direction: 'unknown', errors, warnings };
  }

  const pitchDeg = reading.pitchDeg as number;
  const targetPitchDeg = cfg.targetPitchDeg ?? 90;
  const errorToleranceDeg = cfg.errorToleranceDeg ?? Math.max(
    Math.abs(targetPitchDeg - cfg.minPitchDeg),
    Math.abs(cfg.maxPitchDeg - targetPitchDeg)
  );
  const warningToleranceDeg = cfg.warningToleranceDeg ?? Math.max(
    Math.abs(targetPitchDeg - cfg.warningMinPitchDeg),
    Math.abs(cfg.warningMaxPitchDeg - targetPitchDeg)
  );
  const deltaFromTarget = pitchDeg - targetPitchDeg;

  const tooHigh = deltaFromTarget < -errorToleranceDeg;
  const tooLow = deltaFromTarget > errorToleranceDeg;
  const slightlyHigh = deltaFromTarget < -warningToleranceDeg;
  const slightlyLow = deltaFromTarget > warningToleranceDeg;

  if (tooHigh || tooLow) {
    const direction = cfg.invertPitchDirection
      ? (tooHigh ? 'tooLow' : 'tooHigh')
      : (tooHigh ? 'tooHigh' : 'tooLow');

    errors.push({
      code: direction === 'tooHigh' ? 'CAMERA_TOO_HIGH' : 'CAMERA_TOO_LOW',
      message: direction === 'tooHigh'
        ? 'The camera angle is too high. Keep the phone around chest height and point it straight at your body.'
        : 'The camera angle is too low. Keep the phone around chest height and point it straight at your body.',
      severity: 'error',
    });

    return { used: true, pitchDeg, direction, errors, warnings };
  }

  if (slightlyHigh || slightlyLow) {
    const direction = cfg.invertPitchDirection
      ? (slightlyHigh ? 'tooLow' : 'tooHigh')
      : (slightlyHigh ? 'tooHigh' : 'tooLow');

    warnings.push({
      code: direction === 'tooHigh' ? 'CAMERA_SLIGHTLY_HIGH' : 'CAMERA_SLIGHTLY_LOW',
      message: direction === 'tooHigh'
        ? 'The camera seems a little high. Try keeping it level with your body.'
        : 'The camera seems a little low. Try keeping it level with your body.',
      severity: 'warning',
    });

    return { used: true, pitchDeg, direction, errors, warnings };
  }

  return { used: true, pitchDeg, direction: 'level', errors, warnings };
}

function normalizePitchDeg(value: number): number {
  // Native should ideally send 0..180 where 90 is level. DeviceOrientation beta
  // can be -180..180, so convert to a stable 0..180 range.
  let v = Math.abs(value);
  if (v > 180) v = v % 360;
  if (v > 180) v = 360 - v;
  return Math.max(0, Math.min(180, v));
}
