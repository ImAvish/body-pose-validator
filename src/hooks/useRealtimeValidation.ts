/**
 * useRealtimeValidation.ts
 * React hook for real-time (live preview) validation feedback.
 *
 * Design:
 *   • Runs a lightweight validation pass on the live video at a configurable interval.
 *   • Returns a list of live hint messages + a skeleton-landmark array for the overlay.
 *   • Does NOT block the user — all results are advisory only.
 *   • The final decision is always made on the captured still image.
 *
 * Throttle interval: src/config/validationConfig.ts → realtime.intervalMs
 * Auto-capture count: src/config/validationConfig.ts → realtime.autoCaptureFrames
 *
 * To change how often real-time validation runs:
 *   Open src/config/validationConfig.ts → realtime.intervalMs
 *   e.g. 300 = fast (heavy on CPU), 700 = slow (light on CPU)
 */

import { useEffect, useRef, useState, useCallback, useMemo, type MutableRefObject } from 'react';
import type { ViewType, NormalizedLandmark } from '../types/validation';
import type { AppConfig } from '../types/models';
import { defaultConfig } from '../config/validationConfig';
import { detectPose, extractLandmarks, selectBestPose, keepCoreValidationPoses, isVisible, LM } from '../services/poseDetection';
import { validateLighting } from '../services/lightingValidation';
import { validateTilt, validateCameraPitch } from '../services/tiltValidation';
import { validateFraming } from '../services/framingValidation';
import { classifyView } from '../services/viewValidation';
import { validateArmOpening, validateLegOpening, validateFrontFacing, validateSideProfilePose } from '../services/poseValidation';
import { validatePersonCount } from '../services/personDetection';
import { imageToCanvas } from '../utils/imageUtils';
import { useDeviceCameraPitch, validateDeviceCameraPitch, type CameraPitchPermissionState } from './useDeviceCameraPitch';

export interface LiveHint {
  code: string;
  message: string;
  /** 'ok' = positive feedback, 'warn' = advisory, 'error' = problem */
  level: 'ok' | 'warn' | 'error';
}

export interface RealtimeValidationState {
  hints: LiveHint[];
  landmarks: NormalizedLandmark[];
  isAllGood: boolean;
  consecutiveGoodFrames: number;
  isRunning: boolean;
  cameraSensorPitchAvailable: boolean;
  cameraSensorPitchDeg: number | null;
  cameraSensorPitchSource: 'native' | 'web' | 'none';
  cameraSensorPitchDirection: 'level' | 'tooHigh' | 'tooLow' | 'unknown';
  cameraSensorPitchPermissionState: CameraPitchPermissionState;
}

interface Options {
  video: HTMLVideoElement | null;
  expectedView: ViewType;
  enabled: boolean;
  config?: Partial<AppConfig>;
  onAutoCapture?: () => void;
}

export function useRealtimeValidation({
  video,
  expectedView,
  enabled,
  config: configOverride,
  onAutoCapture,
}: Options): RealtimeValidationState {
  const config: AppConfig = useMemo(
    () => ({ ...defaultConfig, ...configOverride }),
    [configOverride]
  );
  const intervalMs = config.realtime.intervalMs;
  const autoCaptureFrames = config.realtime.autoCaptureFrames;
  const errorStableFrames = Math.max(1, config.realtime.errorStableFrames);
  const okStableFrames = Math.max(1, config.realtime.okStableFrames);
  const statusRefreshMs = Math.max(1000, config.realtime.statusRefreshMs);
  const landmarkSmoothingAlpha = Math.max(0.01, Math.min(1, config.realtime.landmarkSmoothingAlpha));
  const sensorPitch = useDeviceCameraPitch(
    enabled &&
    config.modules.cameraSensorPitch &&
    config.cameraSensorPitch.enabled &&
    config.cameraSensorPitch.useSensorWhenAvailable,
    config
  );
  const sensorPitchRef = useRef(sensorPitch);

  useEffect(() => {
    sensorPitchRef.current = sensorPitch;
  }, [sensorPitch]);

  const [state, setState] = useState<RealtimeValidationState>({
    hints: [],
    landmarks: [],
    isAllGood: false,
    consecutiveGoodFrames: 0,
    isRunning: false,
    cameraSensorPitchAvailable: false,
    cameraSensorPitchDeg: null,
    cameraSensorPitchSource: 'none',
    cameraSensorPitchDirection: 'unknown',
    cameraSensorPitchPermissionState: 'unknown',
  });

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const goodFramesRef = useRef(0);
  const runningRef = useRef(false);
  const inferenceInFlightRef = useRef(false);
  const candidateRef = useRef<StableCandidate | null>(null);
  const displayedRef = useRef<DisplayedRealtime | null>(null);
  const smoothedLandmarksRef = useRef<NormalizedLandmark[]>([]);

  const runValidation = useCallback(async () => {
    if (!video || video.readyState < 2 || !enabled || inferenceInFlightRef.current) return;

    inferenceInFlightRef.current = true;

    try {
      // ── Lighting (fast, no model) ─────────────────────────────────────────
      const lightResult = validateLighting(video, config);
      const lightHints: LiveHint[] = [
        ...lightResult.errors.map((e) => ({
          code: e.code, message: e.message, level: 'error' as const,
        })),
        ...lightResult.warnings.map((w) => ({
          code: w.code, message: w.message, level: 'warn' as const,
        })),
      ];

      // If too dark, skip model (won't be useful anyway)
      if (lightResult.errors.some((e) => e.code === 'TOO_DARK' || e.code === 'BACKLIT')) {
        if (!runningRef.current) return;
        setState((prev) => ({
          ...prev,
          hints: lightHints,
          landmarks: [],
          isAllGood: false,
          consecutiveGoodFrames: 0,
        }));
        goodFramesRef.current = 0;
        return;
      }

      // ── Pose model ────────────────────────────────────────────────────────
      // Scale to smaller canvas for speed in live mode
      const canvas = imageToCanvas(video, 480);
      const result = await detectPose(canvas, config, performance.now());
      const allPoses = keepCoreValidationPoses(extractLandmarks(result));
      const best = selectBestPose(allPoses);

      // ── Person count ──────────────────────────────────────────────────────
      const personCountResult = validatePersonCount(allPoses, config);
      const poseHints: LiveHint[] = personCountResult.errors.map((e) => ({
        code: e.code,
        message: e.message,
        level: 'error' as const,
      }));

      const rawLandmarks: NormalizedLandmark[] = best ?? [];
      const smoothedLandmarks: NormalizedLandmark[] = best
        ? smoothLandmarks(best, smoothedLandmarksRef.current, landmarkSmoothingAlpha)
        : [];
      smoothedLandmarksRef.current = smoothedLandmarks;

      // Draw the newest raw landmarks so the overlay follows camera movement
      // immediately. Keep smoothed landmarks only for validation stability.
      const landmarks: NormalizedLandmark[] = rawLandmarks;
      const detectionHints: LiveHint[] = [...lightHints, ...poseHints];

      const sensorPitchReading = sensorPitchRef.current;
      const sensorPitchResult = validateDeviceCameraPitch(sensorPitchReading, config);
      const sensorPitchIsUsed = sensorPitchResult.used;
      if (sensorPitchIsUsed) {
        detectionHints.push(
          ...sensorPitchResult.errors.map((e) => ({ code: e.code, message: e.message, level: 'error' as const })),
          ...sensorPitchResult.warnings.map((w) => ({ code: w.code, message: w.message, level: 'warn' as const })),
        );
      }

      if (best) {
        const validationLandmarks = smoothedLandmarks.length > 0 ? smoothedLandmarks : best;

        // ── Key landmark presence ───────────────────────────────────────────
        const minVis = config.confidence.minLandmarkVisibility;
        const keyLMs = [LM.NOSE, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER,
                        LM.LEFT_HIP, LM.RIGHT_HIP, LM.LEFT_ANKLE, LM.RIGHT_ANKLE];
        const hasHead   = isVisible(validationLandmarks[LM.NOSE], minVis);
        const hasFeet   = isVisible(validationLandmarks[LM.LEFT_ANKLE], minVis) || isVisible(validationLandmarks[LM.RIGHT_ANKLE], minVis);
        const allKeyVis = keyLMs.every((i) => isVisible(validationLandmarks[i], minVis));

        if (!hasHead) {
          detectionHints.push({ code: 'HEAD_NOT_VISIBLE', message: 'Move back — head not visible.', level: 'error' });
        }
        if (!hasFeet) {
          detectionHints.push({ code: 'FEET_NOT_VISIBLE', message: 'Move back — feet not visible.', level: 'error' });
        }

        if (allKeyVis) {
          // ── Framing ─────────────────────────────────────────────────────
          const framingResult = validateFraming(validationLandmarks, config);
          detectionHints.push(
            ...framingResult.errors.map((e) => ({ code: e.code, message: e.message, level: 'error' as const })),
            ...framingResult.warnings.map((w) => ({ code: w.code, message: w.message, level: 'warn' as const })),
          );

          // ── Tilt ─────────────────────────────────────────────────────────
          const tiltResult = validateTilt(validationLandmarks, config, expectedView);
          detectionHints.push(
            ...tiltResult.errors.map((e) => ({ code: e.code, message: e.message, level: 'error' as const })),
            ...tiltResult.warnings.map((w) => ({ code: w.code, message: w.message, level: 'warn' as const })),
          );

          // ── Camera placement / visual pitch guard ─────────────────────
          // Sensor pitch remains the source of truth for the phone angle. However,
          // a phone can still be placed too low/high while the sensor shows ~90°
          // (for example, on the floor but pointed straight). Therefore, when the
          // sensor is available, run image pitch as a coarse realtime guard only.
          // It blocks only strong visual evidence so table-height setups can pass.
          const useImagePitchFallback = !sensorPitchIsUsed && config.cameraSensorPitch.fallbackToPoseWhenUnavailable;
          const useImagePitchGuardWithSensor =
            sensorPitchIsUsed && config.cameraSensorPitch.useImagePitchGuardWhenSensorAvailable;

          if (
            config.modules.cameraPitch &&
            config.cameraPitch.enabled &&
            (useImagePitchFallback || useImagePitchGuardWithSensor)
          ) {
            const pitchLandmarks = best;
            const pitchResult = validateCameraPitch(pitchLandmarks, config, expectedView);

            if (useImagePitchGuardWithSensor) {
              const strongEnough =
                pitchResult.pitchScore >= config.cameraSensorPitch.imagePitchGuardMinScoreWhenSensorAvailable;
              if (strongEnough) {
                detectionHints.push(
                  ...pitchResult.errors.map((e) => ({ code: e.code, message: e.message, level: 'error' as const })),
                );
              }
            } else {
              detectionHints.push(
                ...pitchResult.errors.map((e) => ({ code: e.code, message: e.message, level: 'error' as const })),
                ...pitchResult.warnings.map((w) => ({ code: w.code, message: w.message, level: 'warn' as const })),
              );
            }
          }

          // ── View type ────────────────────────────────────────────────────
          const viewResult = classifyView(validationLandmarks, expectedView, config);
          detectionHints.push(
            ...viewResult.errors.map((e) => ({ code: e.code, message: e.message, level: 'error' as const })),
            ...viewResult.warnings.map((w) => ({ code: w.code, message: w.message, level: 'warn' as const })),
          );

          // ── Front-facing + arm / leg opening (front view only) ────────────
          if (expectedView === 'front' && config.modules.frontFacing && config.frontPose.facing.enabled) {
            const facingResult = validateFrontFacing(validationLandmarks, config);
            detectionHints.push(
              ...facingResult.errors.map((e) => ({ code: e.code, message: e.message, level: 'error' as const })),
              ...facingResult.warnings.map((w) => ({ code: w.code, message: w.message, level: 'warn' as const })),
            );
          }

          if (expectedView === 'front' && config.modules.frontPoseOpening) {
            if (config.frontPose.armOpening.enabled) {
              const armResult = validateArmOpening(validationLandmarks, config);
              detectionHints.push(
                ...armResult.errors.map((e) => ({ code: e.code, message: e.message, level: 'error' as const })),
                ...armResult.warnings.map((w) => ({ code: w.code, message: w.message, level: 'warn' as const })),
              );
            }
            if (config.frontPose.legOpening.enabled) {
              const legResult = validateLegOpening(validationLandmarks, config);
              detectionHints.push(
                ...legResult.errors.map((e) => ({ code: e.code, message: e.message, level: 'error' as const })),
                ...legResult.warnings.map((w) => ({ code: w.code, message: w.message, level: 'warn' as const })),
              );
            }
          }

          // ── Side-profile pose (side view only) ───────────────────────────
          if (expectedView === 'side' && config.modules.sideProfilePose) {
            const sidePoseResult = validateSideProfilePose(validationLandmarks, config);
            detectionHints.push(
              ...sidePoseResult.errors.map((e) => ({ code: e.code, message: e.message, level: 'error' as const })),
              ...sidePoseResult.warnings.map((w) => ({ code: w.code, message: w.message, level: 'warn' as const })),
            );
          }
        }
      }

      const errorHints = detectionHints.filter((h) => h.level === 'error');
      const rawIsAllGood = errorHints.length === 0;

      // Show a positive message when everything looks good. The message and the
      // red/green state are stabilized below so single noisy frames do not flicker.
      const rawHints = detectionHints.length === 0 && rawIsAllGood
        ? [{ code: 'ALL_GOOD', message: '✅ Looking good — hold still!', level: 'ok' as const }]
        : detectionHints;

      const stable = stabilizeRealtimeResult({
        rawHints,
        rawIsAllGood,
        landmarks,
        candidateRef,
        displayedRef,
        errorStableFrames,
        okStableFrames,
        statusRefreshMs,
        nowMs: performance.now(),
      });

      // Auto-capture is stricter than the visible UI state. The UI is smoothed
      // to avoid flicker, but capture is allowed only when both the stabilized
      // status and the latest raw analysis have no errors.
      const canCaptureThisFrame = stable.isAllGood && rawIsAllGood;

      if (canCaptureThisFrame) {
        goodFramesRef.current++;
        if (autoCaptureFrames > 0 && goodFramesRef.current >= autoCaptureFrames) {
          goodFramesRef.current = 0;
          onAutoCapture?.();
        }
      } else {
        goodFramesRef.current = 0;
      }

      const visibleHints = stable.isAllGood
        ? [{
            code: 'READY_TO_CAPTURE',
            message:
              autoCaptureFrames > 0
                ? `✅ Looking good — hold still, capturing${Math.max(0, autoCaptureFrames - goodFramesRef.current) > 0 ? ` in ${Math.max(0, autoCaptureFrames - goodFramesRef.current)}…` : '…'}`
                : '✅ Looking good — hold still!',
            level: 'ok' as const,
          }]
        : stable.hints;

      if (!runningRef.current) return;
      setState((prev) => {
        const next: RealtimeValidationState = {
          hints: visibleHints,
          landmarks: stable.landmarks,
          isAllGood: stable.isAllGood,
          consecutiveGoodFrames: goodFramesRef.current,
          isRunning: true,
          cameraSensorPitchAvailable: sensorPitchIsUsed,
          cameraSensorPitchDeg: sensorPitchResult.pitchDeg,
          cameraSensorPitchSource: sensorPitchReading.source,
          cameraSensorPitchDirection: sensorPitchResult.direction,
          cameraSensorPitchPermissionState: sensorPitchReading.permissionState,
        };
        return realtimeStatesEqual(prev, next) ? prev : next;
      });
    } catch {
      // Model not loaded yet or inference error — silent fail during live preview
    } finally {
      inferenceInFlightRef.current = false;
    }
  }, [
    video,
    enabled,
    expectedView,
    config,
    autoCaptureFrames,
    errorStableFrames,
    okStableFrames,
    statusRefreshMs,
    landmarkSmoothingAlpha,
    onAutoCapture,
  ]);

  // Periodic loop
  useEffect(() => {
    if (!enabled || !video) {
      goodFramesRef.current = 0;
      candidateRef.current = null;
      displayedRef.current = null;
      smoothedLandmarksRef.current = [];
      setState((prev) => {
        const alreadyIdle = !prev.isRunning &&
          prev.hints.length === 0 &&
          prev.landmarks.length === 0 &&
          !prev.isAllGood &&
          prev.consecutiveGoodFrames === 0;

        if (alreadyIdle) return prev;

        return {
          hints: [],
          landmarks: [],
          isAllGood: false,
          consecutiveGoodFrames: 0,
          isRunning: false,
          cameraSensorPitchAvailable: false,
          cameraSensorPitchDeg: null,
          cameraSensorPitchSource: 'none',
          cameraSensorPitchDirection: 'unknown',
          cameraSensorPitchPermissionState: 'unknown',
        };
      });
      return;
    }

    runningRef.current = true;

    const tick = async () => {
      if (!runningRef.current) return;
      await runValidation();
      if (runningRef.current) {
        timerRef.current = setTimeout(tick, intervalMs);
      }
    };

    timerRef.current = setTimeout(tick, 300); // short initial delay

    return () => {
      runningRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [enabled, video, intervalMs, runValidation]);

  return state;
}


interface StableCandidate {
  key: string;
  count: number;
  hints: LiveHint[];
  isAllGood: boolean;
  landmarks: NormalizedLandmark[];
}

interface DisplayedRealtime {
  key: string;
  hints: LiveHint[];
  isAllGood: boolean;
  landmarks: NormalizedLandmark[];
  /** Last time the visible status was actually refreshed. */
  updatedAt: number;
}

function stabilizeRealtimeResult({
  rawHints,
  rawIsAllGood,
  landmarks,
  candidateRef,
  displayedRef,
  errorStableFrames,
  okStableFrames,
  statusRefreshMs,
  nowMs,
}: {
  rawHints: LiveHint[];
  rawIsAllGood: boolean;
  landmarks: NormalizedLandmark[];
  candidateRef: MutableRefObject<StableCandidate | null>;
  displayedRef: MutableRefObject<DisplayedRealtime | null>;
  errorStableFrames: number;
  okStableFrames: number;
  statusRefreshMs: number;
  nowMs: number;
}): DisplayedRealtime {
  const rawKey = makeRealtimeStatusKey(rawHints, rawIsAllGood);
  const previousCandidate = candidateRef.current;

  if (previousCandidate?.key === rawKey) {
    candidateRef.current = {
      ...previousCandidate,
      count: previousCandidate.count + 1,
      hints: rawHints,
      isAllGood: rawIsAllGood,
      landmarks,
    };
  } else {
    candidateRef.current = {
      key: rawKey,
      count: 1,
      hints: rawHints,
      isAllGood: rawIsAllGood,
      landmarks,
    };
  }

  const requiredFrames = rawIsAllGood ? okStableFrames : errorStableFrames;
  const hasStableCandidate = candidateRef.current.count >= requiredFrames;

  const displayed = displayedRef.current;
  if (displayed === null) {
    displayedRef.current = {
      key: 'ANALYZING',
      hints: [{ code: 'ANALYZING', message: 'Hold still — analyzing pose…', level: 'warn' }],
      isAllGood: false,
      landmarks,
      updatedAt: nowMs,
    };
    return displayedRef.current;
  }

  const visibleStatusAgeMs = nowMs - displayed.updatedAt;
  const isStillAnalyzing = displayed.key === 'ANALYZING';
  const isDifferentVisibleStatus = displayed.key !== candidateRef.current.key;

  // Important behavior:
  // - Prefer stable repeated results, so the UI does not flicker red/green.
  // - But never keep the old status forever. If the user changes the phone angle
  //   or body pose, the visible hint must refresh within about statusRefreshMs
  //   (default: 3 seconds), even if MediaPipe outputs are not perfectly identical.
  const shouldClearErrorWithGoodFrame =
    rawIsAllGood &&
    displayed.key.startsWith('ERR:') &&
    candidateRef.current.count >= Math.min(2, okStableFrames) &&
    visibleStatusAgeMs >= Math.min(1500, statusRefreshMs);

  const shouldRefreshVisibleStatus =
    hasStableCandidate ||
    shouldClearErrorWithGoodFrame ||
    (isDifferentVisibleStatus && visibleStatusAgeMs >= statusRefreshMs) ||
    (isStillAnalyzing && visibleStatusAgeMs >= statusRefreshMs);

  if (shouldRefreshVisibleStatus) {
    displayedRef.current = {
      key: candidateRef.current.key,
      hints: candidateRef.current.hints,
      isAllGood: candidateRef.current.isAllGood,
      landmarks: candidateRef.current.landmarks,
      updatedAt: nowMs,
    };
  } else {
    displayedRef.current = {
      ...displayed,
      // Keep overlay movement live even while the text/status is waiting for
      // stability or the 3-second refresh window.
      landmarks,
    };
  }

  return displayedRef.current;
}

function makeRealtimeStatusKey(hints: LiveHint[], isAllGood: boolean): string {
  if (isAllGood) return 'OK';
  const errorCodes = hints
    .filter((hint) => hint.level === 'error')
    .map((hint) => hint.code)
    .sort();
  if (errorCodes.length > 0) return `ERR:${errorCodes.join('|')}`;
  return `WARN:${hints.map((hint) => hint.code).sort().join('|')}`;
}

function smoothLandmarks(
  current: NormalizedLandmark[],
  previous: NormalizedLandmark[],
  alpha: number
): NormalizedLandmark[] {
  if (previous.length !== current.length) return current;

  return current.map((lm, idx) => {
    const prev = previous[idx];
    if (!prev || (lm.visibility ?? 0) < 0.01) return lm;
    return {
      x: prev.x + (lm.x - prev.x) * alpha,
      y: prev.y + (lm.y - prev.y) * alpha,
      z: prev.z + (lm.z - prev.z) * alpha,
      visibility: lm.visibility,
    };
  });
}

function realtimeStatesEqual(a: RealtimeValidationState, b: RealtimeValidationState): boolean {
  if (a.isAllGood !== b.isAllGood) return false;
  if (a.consecutiveGoodFrames !== b.consecutiveGoodFrames) return false;
  if (a.isRunning !== b.isRunning) return false;
  if (a.cameraSensorPitchAvailable !== b.cameraSensorPitchAvailable) return false;
  if (a.cameraSensorPitchSource !== b.cameraSensorPitchSource) return false;
  if (a.cameraSensorPitchDirection !== b.cameraSensorPitchDirection) return false;
  if (a.cameraSensorPitchPermissionState !== b.cameraSensorPitchPermissionState) return false;
  if ((a.cameraSensorPitchDeg ?? null) !== (b.cameraSensorPitchDeg ?? null)) return false;
  if (a.landmarks.length !== b.landmarks.length) return false;
  // Landmarks are smoothed but still change over time; allow state updates so
  // the overlay can keep tracking the user.
  if (b.landmarks.length > 0) return false;
  if (a.hints.length !== b.hints.length) return false;
  return a.hints.every((hint, idx) => {
    const other = b.hints[idx];
    return hint.code === other.code && hint.level === other.level && hint.message === other.message;
  });
}

