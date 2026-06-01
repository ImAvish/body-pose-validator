/**
 * framingValidation.ts
 * Check whether the person is well-framed: centred and correct distance.
 *
 * Uses the bounding box of all visible landmarks (normalised coords 0-1).
 */

import type { NormalizedLandmark, ValidationError } from '../types/validation';
import type { AppConfig } from '../types/models';
import { landmarksBBox } from '../utils/geometryUtils';

export interface FramingResult {
  personHeightRatio: number;   // bbox height / 1.0
  centerOffsetRatio: number;   // abs distance of bbox center from image center
  errors: ValidationError[];
  warnings: ValidationError[];
}

export function validateFraming(
  landmarks: NormalizedLandmark[],
  config: AppConfig
): FramingResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  const visible = landmarks.filter(
    (lm) => (lm.visibility ?? 0) >= config.confidence.minLandmarkVisibility
  );

  if (visible.length < 4) {
    // Not enough info to assess framing
    return { personHeightRatio: 0, centerOffsetRatio: 0, errors, warnings };
  }

  const bbox = landmarksBBox(visible);
  const personHeightRatio = bbox.height; // normalised — 1.0 = full frame height
  const bboxCenterX = bbox.minX + bbox.width / 2;
  const bboxCenterY = bbox.minY + bbox.height / 2;
  const centerOffsetX = Math.abs(bboxCenterX - 0.5);
  const centerOffsetY = Math.abs(bboxCenterY - 0.5);
  const centerOffsetRatio = Math.max(centerOffsetX, centerOffsetY);

  const { minPersonHeightRatio, maxPersonHeightRatio, maxCenterOffsetRatio } = config.framing;

  if (personHeightRatio < minPersonHeightRatio) {
    errors.push({
      code: 'TOO_FAR',
      message: 'Please move slightly closer to the camera so your full body fills more of the frame.',
      severity: 'error',
    });
  } else if (personHeightRatio > maxPersonHeightRatio) {
    errors.push({
      code: 'TOO_CLOSE',
      message: 'Please move slightly back so your full body is visible.',
      severity: 'error',
    });
  }

  if (centerOffsetX > maxCenterOffsetRatio) {
    errors.push({
      code: 'OFF_CENTER',
      message: 'Please stand in the centre of the frame.',
      severity: 'error',
    });
  }

  return { personHeightRatio, centerOffsetRatio, errors, warnings };
}
