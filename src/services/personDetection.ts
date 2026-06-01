/**
 * personDetection.ts
 * Person-count validation.
 *
 * We derive the person count from the number of valid pose detections returned
 * by MediaPipe PoseLandmarker. Weak/partial duplicate poses are filtered out so
 * a noisy second skeleton does not falsely block a good one-person photo.
 */

import type { NormalizedLandmark, ValidationError } from '../types/validation';
import type { AppConfig } from '../types/models';
import { LM, isVisible, averageCoreVisibility } from './poseDetection';

export interface PersonCountResult {
  count: number;
  errors: ValidationError[];
}

const PERSON_COUNT_KEY_LMS = [
  LM.NOSE,
  LM.LEFT_SHOULDER,
  LM.RIGHT_SHOULDER,
  LM.LEFT_HIP,
  LM.RIGHT_HIP,
  LM.LEFT_KNEE,
  LM.RIGHT_KNEE,
  LM.LEFT_ANKLE,
  LM.RIGHT_ANKLE,
];

/**
 * Validate that exactly one real person is present.
 * @param allPoses - All detected pose landmark arrays (one per detected body).
 */
export function validatePersonCount(
  allPoses: NormalizedLandmark[][],
  config: AppConfig
): PersonCountResult {
  const validPoses = allPoses.filter((pose) => isValidPersonPose(pose, config));
  const count = validPoses.length;
  const errors: ValidationError[] = [];

  if (count === 0) {
    errors.push({
      code: 'NO_PERSON',
      message: 'No person detected. Please stand fully visible in the frame.',
      severity: 'error',
    });
  } else if (count > 1) {
    errors.push({
      code: 'MULTIPLE_PERSONS',
      message: 'Multiple people detected. Only one person is allowed in the photo.',
      severity: 'error',
    });
  }

  return { count, errors };
}

function isValidPersonPose(
  landmarks: NormalizedLandmark[],
  config: AppConfig
): boolean {
  if (!landmarks || landmarks.length === 0) return false;

  const minVis = config.confidence.minLandmarkVisibility;
  const visibleKeyLandmarks = PERSON_COUNT_KEY_LMS.filter((idx) =>
    isVisible(landmarks[idx], minVis)
  ).length;

  const averageVisibility = averageCoreVisibility(landmarks);

  // A real full-body person should have several confident key landmarks. This
  // now uses only the core validation landmarks, not all 33 MediaPipe points,
  // so extra face/finger landmarks cannot influence the count.
  return (
    visibleKeyLandmarks >= 5 &&
    averageVisibility >= config.confidence.minPoseConfidence
  );
}
