/**
 * poseDetection.ts
 * Wraps MediaPipe PoseLandmarker results into our internal landmark format.
 *
 * MediaPipe 33-landmark indices:
 *  0  = nose
 *  11 = left shoulder,  12 = right shoulder
 *  13 = left elbow,     14 = right elbow
 *  15 = left wrist,     16 = right wrist
 *  23 = left hip,       24 = right hip
 *  25 = left knee,      26 = right knee
 *  27 = left ankle,     28 = right ankle
 *
 * Important: MediaPipe PoseLandmarker always returns its fixed 33 landmarks.
 * There is no config option to make this ready-made .task model detect fewer
 * landmarks internally. What we can do is immediately mask the output and make
 * our validation/model logic consume only CORE_VALIDATION_LANDMARKS below.
 *
 * Current overlay core set = 13 points:
 *   head/nose, 2 shoulders, 2 elbows, 2 wrists, 2 hips, 2 knees, 2 ankles.
 *
 * Important front-facing/back-facing note:
 *   The UI overlay still draws the small 13-point set, but validation keeps a
 *   few extra face landmarks (eyes/ears/mouth) internally so back-facing front
 *   photos can be rejected. MediaPipe still returns 33 internally.
 */

import type { PoseLandmarkerResult } from '@mediapipe/tasks-vision';
import type { NormalizedLandmark } from '../types/validation';

export const LM = {
  NOSE: 0,
  LEFT_EYE: 2,
  RIGHT_EYE: 5,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT: 31,
  RIGHT_FOOT: 32,
} as const;

// Main landmarks shown on the realtime overlay.
// Keep this list small so the user sees only the core body points.
export const CORE_VALIDATION_LANDMARKS = [
  LM.NOSE,
  LM.LEFT_SHOULDER,
  LM.RIGHT_SHOULDER,
  LM.LEFT_ELBOW,
  LM.RIGHT_ELBOW,
  LM.LEFT_WRIST,
  LM.RIGHT_WRIST,
  LM.LEFT_HIP,
  LM.RIGHT_HIP,
  LM.LEFT_KNEE,
  LM.RIGHT_KNEE,
  LM.LEFT_ANKLE,
  LM.RIGHT_ANKLE,
] as const;

// Extra face landmarks kept for validation only, not drawn on the overlay.
// These are needed to reject front photos where the person is standing with
// their back to the camera. Relying on NOSE alone can be fooled by MediaPipe
// hallucinating a weak nose point on hair/back-of-head.
export const FACE_DIRECTION_LANDMARKS = [
  LM.LEFT_EYE,
  LM.RIGHT_EYE,
  LM.LEFT_EAR,
  LM.RIGHT_EAR,
  LM.MOUTH_LEFT,
  LM.MOUTH_RIGHT,
] as const;

// Extra foot landmarks are kept for validation only, not drawn on the overlay.
// They are needed to detect bottom-up camera perspective: in low-angle photos,
// shoes/feet become disproportionately large compared with the upper body.
export const FOOT_PERSPECTIVE_LANDMARKS = [
  LM.LEFT_HEEL,
  LM.RIGHT_HEEL,
  LM.LEFT_FOOT,
  LM.RIGHT_FOOT,
] as const;

const VALIDATION_LANDMARK_SET = new Set<number>([
  ...CORE_VALIDATION_LANDMARKS,
  ...FACE_DIRECTION_LANDMARKS,
  ...FOOT_PERSPECTIVE_LANDMARKS,
]);

/** Convert MediaPipe result landmarks to our format. */
export function extractLandmarks(result: PoseLandmarkerResult): NormalizedLandmark[][] {
  return result.landmarks.map((pose) =>
    pose.map((lm) => ({
      x: lm.x,
      y: lm.y,
      z: lm.z,
      visibility: lm.visibility ?? 0,
    }))
  );
}

/**
 * Keep MediaPipe's original array indices but hide all non-core landmarks.
 * This prevents index-based code from breaking while making downstream
 * validation consume only the smaller core-point set.
 */
export function keepCoreValidationLandmarks(
  landmarks: NormalizedLandmark[]
): NormalizedLandmark[] {
  return landmarks.map((lm, idx) => {
    if (VALIDATION_LANDMARK_SET.has(idx)) return lm;
    return { ...lm, visibility: 0 };
  });
}

/** Apply core landmark masking to all detected poses. */
export function keepCoreValidationPoses(
  poses: NormalizedLandmark[][]
): NormalizedLandmark[][] {
  return poses.map(keepCoreValidationLandmarks);
}

/** Return the pose with the highest average core-landmark visibility. */
export function selectBestPose(poses: NormalizedLandmark[][]): NormalizedLandmark[] | null {
  if (poses.length === 0) return null;
  let best = poses[0];
  let bestScore = averageCoreVisibility(best);
  for (let i = 1; i < poses.length; i++) {
    const s = averageCoreVisibility(poses[i]);
    if (s > bestScore) { best = poses[i]; bestScore = s; }
  }
  return best;
}

export function averageCoreVisibility(landmarks: NormalizedLandmark[]): number {
  if (landmarks.length === 0) return 0;
  const visibleCore = CORE_VALIDATION_LANDMARKS.map((idx) => landmarks[idx]);
  const sum = visibleCore.reduce((acc, lm) => acc + (lm?.visibility ?? 0), 0);
  return sum / CORE_VALIDATION_LANDMARKS.length;
}

/** Check if a specific landmark is visible above the threshold. */
export function isVisible(lm: NormalizedLandmark | undefined, threshold: number): boolean {
  return (lm?.visibility ?? 0) >= threshold;
}

// Re-export detectPose so consumers can import from a single module
export { detectPose } from './modelLoader';
