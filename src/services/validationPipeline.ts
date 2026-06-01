/**
 * validationPipeline.ts
 * Single entry-point for all photo validation logic.
 *
 * Run order:
 *   1. Lighting (no model; fast pixel check)
 *   2. Pose model inference
 *   3. Person count
 *   4. Full-body visibility
 *   5. Framing
 *   6. Camera tilt
 *   7. Standing pose
 *   8. View classification (front vs side)
 *   9. Front-view pose: arm + leg opening  [front step only]
 *
 * Lighting (step 1) gets landmarks passed in step 1.5 if available,
 * but for the first pass we run it without landmarks then re-check backlight
 * after the pose result is available.
 */

import type { ValidateBodyPhotoArgs, ValidationResult, ValidationMetrics } from '../types/validation';
import { defaultConfig } from '../config/validationConfig';
import { detectPose, extractLandmarks, selectBestPose, keepCoreValidationPoses, averageCoreVisibility } from './poseDetection';
import { validatePersonCount } from './personDetection';
import { validateLighting } from './lightingValidation';
import { validateTilt, validateCameraPitch } from './tiltValidation';
import { validateFraming } from './framingValidation';
import {
  validateBodyVisibility,
  validateStandingPose,
  classifyView,
} from './viewValidation';
import { validateFrontPose, validateSideProfilePose } from './poseValidation';
import { imageToCanvas } from '../utils/imageUtils';

export async function validateBodyPhoto(
  args: ValidateBodyPhotoArgs
): Promise<ValidationResult> {
  const { image, expectedView } = args;
  const config = { ...defaultConfig, ...args.config };

  const errors: ValidationResult['errors'] = [];
  const warnings: ValidationResult['warnings'] = [];

  const metrics: ValidationMetrics = {
    personCount: 0,
    poseConfidence: 0,
    brightness: 0,
    overexposedRatio: 0,
    tiltAngle: 0,
    bodyVerticalAngle: 0,
    bodyVisibilityScore: 0,
    framingScore: 0,
    detectedView: 'unknown',
    personBboxRatio: 0,
    centerOffsetRatio: 0,
  };

  // ── 1. Quick lighting check (no landmarks yet) ─────────────────────────────
  if (config.modules.lighting) {
    const lightResult = validateLighting(image, config);
    metrics.brightness = lightResult.averageLuminance;
    metrics.overexposedRatio = lightResult.overexposedRatio;
    errors.push(...lightResult.errors);
    warnings.push(...lightResult.warnings);
    if (lightResult.errors.some((e) => e.code === 'TOO_DARK')) {
      return { isValid: false, errors, warnings, metrics };
    }
  }

  // ── 2. Pose model inference ────────────────────────────────────────────────
  let allPoses: ReturnType<typeof extractLandmarks> = [];
  try {
    const canvas = imageToCanvas(image, config.poseInferenceSize);
    const result = await detectPose(canvas, config);
    allPoses = keepCoreValidationPoses(extractLandmarks(result));
  } catch (err) {
    errors.push({
      code: 'MODEL_ERROR',
      message: `Could not run pose analysis: ${err instanceof Error ? err.message : String(err)}`,
      severity: 'error',
    });
    return { isValid: false, errors, warnings, metrics };
  }

  // ── 3. Person count ────────────────────────────────────────────────────────
  if (config.modules.personCount) {
    const countResult = validatePersonCount(allPoses, config);
    metrics.personCount = countResult.count;
    errors.push(...countResult.errors);
    if (countResult.errors.length > 0) {
      return { isValid: false, errors, warnings, metrics };
    }
  }

  // ── 4. Select best pose ────────────────────────────────────────────────────
  const landmarks = selectBestPose(allPoses);
  if (!landmarks) {
    errors.push({
      code: 'NO_POSE',
      message: 'No pose detected. Please stand fully visible in the frame.',
      severity: 'error',
    });
    return { isValid: false, errors, warnings, metrics };
  }

  const avgVis = averageCoreVisibility(landmarks);
  metrics.poseConfidence = avgVis;

  // ── 4.5. Re-run lighting with landmarks for accurate backlight detection ───
  if (config.modules.lighting && config.lighting.backlight.enabled) {
    // Remove backlight errors from first pass (they were heuristic-only)
    const idx = errors.findIndex((e) => e.code === 'BACKLIT');
    if (idx !== -1) errors.splice(idx, 1);

    const lightResult2 = validateLighting(image, config, landmarks);
    // Add only backlight-related items from second pass
    errors.push(...lightResult2.errors.filter((e) => e.code === 'BACKLIT'));
    warnings.push(...lightResult2.warnings.filter((w) => w.code === 'BACKLIT'));
  }

  // ── 5. Full-body visibility ────────────────────────────────────────────────
  if (config.modules.fullBodyVisibility) {
    const visResult = validateBodyVisibility(landmarks, config);
    metrics.bodyVisibilityScore = visResult.score;
    errors.push(...visResult.errors);
    if (visResult.errors.length > 0) {
      return { isValid: false, errors, warnings, metrics, debug: { landmarks } };
    }
  }

  // ── 6. Framing ─────────────────────────────────────────────────────────────
  if (config.modules.framing) {
    const framingResult = validateFraming(landmarks, config);
    metrics.personBboxRatio = framingResult.personHeightRatio;
    metrics.centerOffsetRatio = framingResult.centerOffsetRatio;
    metrics.framingScore = 1 - framingResult.centerOffsetRatio;
    errors.push(...framingResult.errors);
    warnings.push(...framingResult.warnings);
  }

  // ── 7. Camera roll / body lean ─────────────────────────────────────────────
  if (config.modules.cameraTilt) {
    const tiltResult = validateTilt(landmarks, config, expectedView);
    metrics.tiltAngle = tiltResult.shoulderTilt;
    metrics.bodyVerticalAngle = tiltResult.bodyAxisDeviation;
    errors.push(...tiltResult.errors);
    warnings.push(...tiltResult.warnings);
  }

  // ── 7.5. Camera pitch / top-down / bottom-up perspective ─────────────────
  if (config.modules.cameraPitch && config.cameraPitch.enabled) {
    const pitchResult = validateCameraPitch(landmarks, config, expectedView);
    metrics.cameraPitchDirection = pitchResult.direction;
    metrics.cameraPitchScore = pitchResult.pitchScore;
    metrics.estimatedCameraPitchAngleDeg = pitchResult.estimatedCameraPitchAngleDeg;
    metrics.legToTorsoRatio = pitchResult.legToTorsoRatio;
    metrics.shoulderToHipWidthRatio = pitchResult.shoulderToHipWidthRatio;
    metrics.upperLowerZDelta = pitchResult.upperLowerZDelta;
    metrics.ankleYForPitch = pitchResult.ankleYForPitch;
    metrics.lowAngleFrameScore = pitchResult.lowAngleFrameScore;
    errors.push(...pitchResult.errors);
    warnings.push(...pitchResult.warnings);
  }

  // ── 8. Standing pose ───────────────────────────────────────────────────────
  if (config.modules.standingPose) {
    const poseResult = validateStandingPose(landmarks, config);
    errors.push(...poseResult.errors);
  }

  // ── 9. View classification ─────────────────────────────────────────────────
  if (config.modules.viewType) {
    const viewResult = classifyView(landmarks, expectedView, config);
    metrics.detectedView = viewResult.detectedView;
    metrics.sideViewScore = viewResult.sideViewScore;
    metrics.frontViewScore = viewResult.frontViewScore;
    metrics.threeQuarterScore = viewResult.threeQuarterScore;
    metrics.shoulderXSpread = viewResult.shoulderXSpread;
    metrics.shoulderZDiff = viewResult.shoulderZDiff;
    metrics.hipXSpread = viewResult.hipXSpread;
    metrics.hipZDiff = viewResult.hipZDiff;
    metrics.shoulderWidthToTorsoHeightRatio = viewResult.shoulderWidthToTorsoHeightRatio;
    metrics.hipWidthToTorsoHeightRatio = viewResult.hipWidthToTorsoHeightRatio;
    errors.push(...viewResult.errors);
    warnings.push(...viewResult.warnings);
  }

  // ── 10. Front-view arm/leg opening ────────────────────────────────────────
  if (config.modules.frontPoseOpening && expectedView === 'front') {
    const frontResult = validateFrontPose(landmarks, config);
    metrics.faceVisibilityScore = frontResult.facing.faceVisibilityScore;
    metrics.visibleFaceLandmarks = frontResult.facing.visibleFaceLandmarks;
    metrics.wristToHipWidthRatio = frontResult.arm.wristToHipWidthRatio;
    metrics.ankleToHipWidthRatio = frontResult.leg.ankleToHipWidthRatio;
    metrics.wristOutsideTorsoRatio = frontResult.arm.wristOutsideTorsoRatio;
    metrics.elbowOutsideTorsoRatio = frontResult.arm.elbowOutsideTorsoRatio;
    errors.push(...frontResult.errors);
    warnings.push(...frontResult.warnings);
  }

  // ── 11. Side-profile posture ──────────────────────────────────────────────
  if (config.modules.sideProfilePose && expectedView === 'side') {
    const sidePoseResult = validateSideProfilePose(landmarks, config);
    metrics.sideWristTorsoGapRatio = sidePoseResult.wristTorsoGapRatio;
    metrics.sideAnkleXSpreadRatio = sidePoseResult.ankleXSpreadRatio;
    errors.push(...sidePoseResult.errors);
    warnings.push(...sidePoseResult.warnings);
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    metrics,
    debug: { landmarks },
  };
}
