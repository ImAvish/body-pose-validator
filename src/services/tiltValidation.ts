/**
 * tiltValidation.ts
 * Camera tilt / roll validation derived from pose landmarks.
 *
 * Threshold config: src/config/validationConfig.ts → tilt section
 *   warningTiltDeg          : tilt below this → silent
 *   maxShoulderTiltDeg      : shoulder-line tilt above this → tilt evidence
 *   maxHipLineTiltDeg       : hip-line tilt above this → tilt evidence / warning
 *   maxBodyAxisDeviationDeg : body-axis deviation above this → tilt evidence / warning
 *
 * Important:
 *   Raw atan2 angles can return values close to 180° for an almost-horizontal line
 *   when left/right landmark order or direction changes.
 *
 *   Example:
 *     Raw angle = 178°
 *     Real tilt from horizontal = 2°
 *
 *   This file normalizes that correctly.
 */

import type { NormalizedLandmark, ValidationError, ViewType } from '../types/validation';
import type { AppConfig } from '../types/models';
import { LM, isVisible } from './poseDetection';

export interface TiltResult {
  shoulderTilt: number;
  hipLineTilt: number;
  bodyAxisDeviation: number;
  errors: ValidationError[];
  warnings: ValidationError[];
}

export type CameraPitchDirection = 'level' | 'tooHigh' | 'tooLow' | 'unknown';

export interface CameraPitchResult {
  direction: CameraPitchDirection;
  pitchScore: number;
  estimatedCameraPitchAngleDeg: number;
  legToTorsoRatio: number;
  shoulderToHipWidthRatio: number;
  upperLowerZDelta: number;
  ankleYForPitch: number;
  lowAngleFrameScore: number;
  errors: ValidationError[];
  warnings: ValidationError[];
}

export function validateTilt(
  landmarks: NormalizedLandmark[],
  config: AppConfig,
  expectedView?: ViewType
): TiltResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  const minVis = config.confidence.minLandmarkVisibility;

  const lShoulder = landmarks[LM.LEFT_SHOULDER];
  const rShoulder = landmarks[LM.RIGHT_SHOULDER];
  const lHip = landmarks[LM.LEFT_HIP];
  const rHip = landmarks[LM.RIGHT_HIP];

  const hasShoulders =
    isVisible(lShoulder, minVis) && isVisible(rShoulder, minVis);

  const hasHips =
    isVisible(lHip, minVis) && isVisible(rHip, minVis);

  const shoulderTilt = hasShoulders
    ? getLineTiltFromHorizontalDeg(lShoulder, rShoulder)
    : 0;

  const hipLineTilt = hasHips
    ? getLineTiltFromHorizontalDeg(lHip, rHip)
    : 0;

  const bodyAxisDeviation = hasShoulders && hasHips
    ? getBodyAxisDeviationFromVerticalDeg(lShoulder, rShoulder, lHip, rHip)
    : 0;

  const {
    warningTiltDeg,
    maxShoulderTiltDeg,
    maxHipLineTiltDeg,
    maxBodyAxisDeviationDeg,
  } = config.tilt;

  // Side-view landmarks are naturally less stable for roll/tilt:
  // shoulder and hip lines can look slanted because one side is hidden or
  // MediaPipe swaps/guesses the far-side landmarks. Keep front view strict,
  // but make side-view tilt less sensitive so valid side photos are not
  // blocked by small landmark jitter.
  const isSideView = expectedView === 'side';
  const tiltThresholdMultiplier = isSideView ? 1.6 : 1;
  const warningThresholdMultiplier = isSideView ? 1.8 : 1;
  const requiredTiltEvidenceForError = isSideView ? 3 : 2;

  const effectiveWarningTiltDeg = warningTiltDeg * warningThresholdMultiplier;
  const effectiveMaxShoulderTiltDeg = maxShoulderTiltDeg * tiltThresholdMultiplier;
  const effectiveMaxHipLineTiltDeg = maxHipLineTiltDeg * tiltThresholdMultiplier;
  const effectiveMaxBodyAxisDeviationDeg = maxBodyAxisDeviationDeg * tiltThresholdMultiplier;

  const shoulderTooTilted =
    hasShoulders && shoulderTilt > effectiveMaxShoulderTiltDeg;

  const hipTooTilted =
    hasHips && hipLineTilt > effectiveMaxHipLineTiltDeg;

  const bodyAxisTooTilted =
    hasShoulders && hasHips && bodyAxisDeviation > effectiveMaxBodyAxisDeviationDeg;

  const tiltEvidenceCount = [
    shoulderTooTilted,
    hipTooTilted,
    bodyAxisTooTilted,
  ].filter(Boolean).length;

  /**
   * Error logic:
   * Do NOT block only because one line is tilted.
   *
   * Reason:
   * In real images, shoulder landmarks can be noisy because of clothes,
   * body shape, side view, arm position, or pose estimation error.
   *
   * We block only when at least 2 signals agree that the image/person is tilted.
   */
  if (tiltEvidenceCount >= requiredTiltEvidenceForError) {
    errors.push({
      code: 'CAMERA_TILTED',
      message: 'The camera seems tilted. Please keep the phone straight and level.',
      severity: 'error',
    });
  }

  // Shoulder warning
  if (
    hasShoulders &&
    !shoulderTooTilted &&
    shoulderTilt > effectiveWarningTiltDeg
  ) {
    warnings.push({
      code: 'CAMERA_SLIGHTLY_TILTED',
      message: 'The camera is slightly tilted. Try to hold the phone straight for the best result.',
      severity: 'warning',
    });
  }

  // If only shoulder is too tilted, warn instead of blocking.
  if (
    shoulderTooTilted &&
    tiltEvidenceCount < 2
  ) {
    warnings.push({
      code: 'SHOULDER_LINE_TILTED',
      message: 'The shoulder line appears tilted. Please keep the phone straight and stand naturally.',
      severity: 'warning',
    });
  }

  // Hip warning
  if (
    hipTooTilted &&
    tiltEvidenceCount < 2
  ) {
    warnings.push({
      code: 'HIP_LINE_TILTED',
      message: 'Your hips appear tilted. Try to stand with equal weight on both feet.',
      severity: 'warning',
    });
  }

  // Body-axis warning
  if (
    bodyAxisTooTilted &&
    tiltEvidenceCount < 2
  ) {
    warnings.push({
      code: 'BODY_LEANING',
      message: 'Please stand straight. Avoid leaning, bending, or swaying.',
      severity: 'warning',
    });
  }

  return {
    shoulderTilt,
    hipLineTilt,
    bodyAxisDeviation,
    errors,
    warnings,
  };
}

/**
 * Returns how much a line is tilted from horizontal.
 *
 * Output:
 *   0°  = perfectly horizontal
 *   90° = perfectly vertical
 *
 * Important normalization:
 *   Raw 178° becomes 2°
 *   Raw -178° becomes 2°
 *   Raw 0° stays 0°
 */
function getLineTiltFromHorizontalDeg(
  p1: NormalizedLandmark,
  p2: NormalizedLandmark
): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;

  if (Math.abs(dx) < 1e-6) {
    return 90;
  }

  const rawAngle = radiansToDegrees(Math.atan2(dy, dx));
  const absAngle = Math.abs(rawAngle);

  return absAngle > 90 ? 180 - absAngle : absAngle;
}

/**
 * Returns how much the body center axis deviates from vertical.
 *
 * Output:
 *   0°  = perfectly vertical body axis
 *   90° = perfectly horizontal body axis
 */
function getBodyAxisDeviationFromVerticalDeg(
  lShoulder: NormalizedLandmark,
  rShoulder: NormalizedLandmark,
  lHip: NormalizedLandmark,
  rHip: NormalizedLandmark
): number {
  const shoulderMid = midpoint(lShoulder, rShoulder);
  const hipMid = midpoint(lHip, rHip);

  const tiltFromHorizontal = getLineTiltFromHorizontalDeg(shoulderMid, hipMid);

  return Math.abs(90 - tiltFromHorizontal);
}

function midpoint(
  p1: NormalizedLandmark,
  p2: NormalizedLandmark
): NormalizedLandmark {
  return {
    x: (p1.x + p2.x) / 2,
    y: (p1.y + p2.y) / 2,
    z: ((p1.z ?? 0) + (p2.z ?? 0)) / 2,
    visibility: Math.min(p1.visibility ?? 1, p2.visibility ?? 1),
  };
}

function radiansToDegrees(rad: number): number {
  return rad * 180 / Math.PI;
}

// ── Camera pitch / perspective validation ────────────────────────────────────

/**
 * Detect clear top-down or bottom-up camera perspective.
 *
 * This is different from roll tilt. Roll means the phone is rotated left/right.
 * Pitch means the phone is angled downward from above or upward from below.
 *
 * Signals used:
 *   1. Leg-to-torso image ratio:
 *      - Too small  -> legs are compressed -> camera likely too high.
 *      - Too large  -> legs are stretched   -> camera likely too low.
 *   2. MediaPipe z distribution:
 *      - Upper body much closer than lower body -> camera likely high.
 *      - Lower body much closer than upper body -> camera likely low.
 *   3. Front-view width perspective:
 *      - Shoulders extremely wider/narrower than hips can support the decision.
 *
 * We require multiple signals unless a single signal is extreme. This keeps the
 * rule sensitive to clear bad camera pitch without rejecting normal body-shape
 * differences or small natural camera angle changes.
 */
export function validateCameraPitch(
  landmarks: NormalizedLandmark[],
  config: AppConfig,
  expectedView?: ViewType
): CameraPitchResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const cfg = config.cameraPitch;
  const minVis = config.confidence.minLandmarkVisibility;
  const isSideView = expectedView === 'side';

  if (!cfg.enabled) {
    return emptyCameraPitchResult(errors, warnings);
  }

  const lShoulder = landmarks[LM.LEFT_SHOULDER];
  const rShoulder = landmarks[LM.RIGHT_SHOULDER];
  const lHip = landmarks[LM.LEFT_HIP];
  const rHip = landmarks[LM.RIGHT_HIP];
  const lKnee = landmarks[LM.LEFT_KNEE];
  const rKnee = landmarks[LM.RIGHT_KNEE];
  const lAnkle = landmarks[LM.LEFT_ANKLE];
  const rAnkle = landmarks[LM.RIGHT_ANKLE];
  const nose = landmarks[LM.NOSE];

  const visibleShoulders = [lShoulder, rShoulder].filter((p): p is NormalizedLandmark => isVisible(p, minVis));
  const visibleHips = [lHip, rHip].filter((p): p is NormalizedLandmark => isVisible(p, minVis));
  const visibleKnees = [lKnee, rKnee].filter((p): p is NormalizedLandmark => isVisible(p, minVis));
  const visibleAnkles = [lAnkle, rAnkle].filter((p): p is NormalizedLandmark => isVisible(p, minVis));

  // Front view usually exposes both body sides, so require both left/right anchors.
  // Side view often hides the far shoulder/hip/ankle or MediaPipe marks it with
  // low visibility. Do not skip camera-pitch validation in side view only because
  // one side is hidden; use the visible side anchors instead.
  const hasPitchAnchors = isSideView
    ? visibleShoulders.length >= 1 && visibleHips.length >= 1 && visibleAnkles.length >= 1
    : visibleShoulders.length >= 2 && visibleHips.length >= 2 && visibleAnkles.length >= 2;

  if (!hasPitchAnchors) {
    return emptyCameraPitchResult(errors, warnings);
  }

  const shoulderMid = isSideView
    ? averageVisiblePoint([lShoulder, rShoulder], minVis)
    : midpoint(lShoulder, rShoulder);
  const hipMid = isSideView
    ? averageVisiblePoint([lHip, rHip], minVis)
    : midpoint(lHip, rHip);
  const ankleMid = isSideView
    ? averageVisiblePoint([lAnkle, rAnkle], minVis)
    : midpoint(lAnkle, rAnkle);

  const torsoHeight = Math.abs(hipMid.y - shoulderMid.y);
  const legHeight = Math.abs(ankleMid.y - hipMid.y);
  const legToTorsoRatio = torsoHeight > 0.01 ? legHeight / torsoHeight : 0;

  const shoulderWidth = visibleShoulders.length >= 2 ? Math.abs(lShoulder.x - rShoulder.x) : 0;
  const hipWidth = visibleHips.length >= 2 ? Math.abs(lHip.x - rHip.x) : 0;
  const ankleWidth = visibleAnkles.length >= 2 ? Math.abs(lAnkle.x - rAnkle.x) : 0;
  const shoulderToHipWidthRatio = hipWidth > 0.01 ? shoulderWidth / hipWidth : 0;
  const ankleToShoulderWidthRatio = shoulderWidth > 0.01 ? ankleWidth / shoulderWidth : 0;

  const lHeel = landmarks[LM.LEFT_HEEL];
  const rHeel = landmarks[LM.RIGHT_HEEL];
  const lFoot = landmarks[LM.LEFT_FOOT];
  const rFoot = landmarks[LM.RIGHT_FOOT];
  const lowerFootPoints = [lAnkle, rAnkle, lHeel, rHeel, lFoot, rFoot]
    .filter((p): p is NormalizedLandmark => isVisible(p, minVis));

  const lowerFootWidth = lowerFootPoints.length >= 2
    ? Math.max(...lowerFootPoints.map((p) => p.x)) - Math.min(...lowerFootPoints.map((p) => p.x))
    : 0;
  const lowerFootToShoulderWidthRatio = shoulderWidth > 0.01 ? lowerFootWidth / shoulderWidth : 0;

  const leftFootLength = maxVisiblePairDistance([lAnkle, lHeel, lFoot], minVis);
  const rightFootLength = maxVisiblePairDistance([rAnkle, rHeel, rFoot], minVis);
  const maxFootLengthToTorsoRatio = torsoHeight > 0.01
    ? Math.max(leftFootLength, rightFootLength) / torsoHeight
    : 0;

  const upperZ = averageVisibleZ([nose, lShoulder, rShoulder], minVis);
  const lowerZ = averageVisibleZ(
    visibleKnees.length > 0 ? [lHip, rHip, lKnee, rKnee, lAnkle, rAnkle] : [lHip, rHip, lAnkle, rAnkle],
    minVis
  );
  const upperLowerZDelta = upperZ - lowerZ;

  const headY = isVisible(nose, minVis) ? nose.y : shoulderMid.y;
  const personTopY = Math.min(
    headY,
    shoulderMid.y,
    hipMid.y,
  );
  const personBottomY = ankleMid.y;
  const personHeightRatio = Math.max(0, personBottomY - personTopY);
  const ankleYForPitch = ankleMid.y;
  const floorBelowFeetRatio = Math.max(0, 1 - ankleYForPitch);
  const topSpaceRatio = Math.max(0, personTopY);
  const bottomSpaceRatio = Math.max(0.01, 1 - personBottomY);

  const tooHighSignals: string[] = [];
  const tooLowSignals: string[] = [];

  if (legToTorsoRatio > 0 && legToTorsoRatio < cfg.minLegToTorsoRatio) {
    tooHighSignals.push('LEG_TORSO_RATIO');
  }
  if (legToTorsoRatio > cfg.maxLegToTorsoRatio) {
    tooLowSignals.push('LEG_TORSO_RATIO');
  }

  if (upperLowerZDelta < -cfg.maxUpperBodyCloserZDelta) {
    tooHighSignals.push('Z_DEPTH');
  }
  if (upperLowerZDelta > cfg.maxLowerBodyCloserZDelta) {
    tooLowSignals.push('Z_DEPTH');
  }

  // Width signal is only useful when both shoulder and hip spreads are wide enough.
  // In true side photos both spreads can be tiny, so this guard avoids false errors.
  const widthSignalReliable = shoulderWidth > 0.08 && hipWidth > 0.06;
  if (widthSignalReliable && shoulderToHipWidthRatio > cfg.maxShoulderToHipWidthRatio) {
    tooHighSignals.push('WIDTH_PERSPECTIVE');
  }
  if (widthSignalReliable && shoulderToHipWidthRatio < cfg.minShoulderToHipWidthRatio) {
    tooLowSignals.push('WIDTH_PERSPECTIVE');
  }

  // High-camera framing signal. In top-down photos, the phone is held high and
  // pointed downward. The person often appears lower in the frame, with a large
  // area above the head and comparatively less space below the feet. This catches
  // clear top-down photos that body-ratio geometry alone can miss.
  const highAngleFrameSignal =
    personTopY > cfg.minHeadYForHighAngle &&
    topSpaceRatio / bottomSpaceRatio > cfg.minTopToBottomSpaceRatioForHighAngle &&
    personHeightRatio <= cfg.maxPersonHeightRatioForHighAngle;

  const strongHighAngleFrameSignal =
    highAngleFrameSignal &&
    personTopY > cfg.minHeadYForHighAngle + 0.06 &&
    topSpaceRatio / bottomSpaceRatio > cfg.minTopToBottomSpaceRatioForHighAngle + 0.55 &&
    personHeightRatio <= cfg.maxPersonHeightRatioForHighAngle;

  const highAngleFrameScore = highAngleFrameSignal
    ? Math.min(1, Math.max(
        ((personTopY - cfg.minHeadYForHighAngle) / 0.24) + 0.35,
        ((topSpaceRatio / bottomSpaceRatio) - cfg.minTopToBottomSpaceRatioForHighAngle) / 1.8 + 0.35,
        strongHighAngleFrameSignal ? 0.92 : 0,
      ))
    : 0;

  if (highAngleFrameSignal) {
    tooHighSignals.push(strongHighAngleFrameSignal ? 'HIGH_CAMERA_FRAME_STRONG' : 'HIGH_CAMERA_FRAME');
  }

  // Low-camera framing signal. In the user's bad sample, the phone is low and
  // angled upward: the body sits high in the frame and a large foreground floor
  // area remains below the feet. This signal is not used for top-down photos.
  const lowAngleFrameSignal =
    ankleYForPitch < cfg.maxAnkleYForLowAngle &&
    personHeightRatio >= cfg.minPersonHeightRatioForLowAngle &&
    legToTorsoRatio >= cfg.minLegToTorsoRatioForLowAngle;

  // Strong low-camera frame signal:
  // If the feet are high in the frame and there is a large visible floor area
  // below the feet, the phone is usually placed too low and angled upward. This
  // catches low-angle photos even when MediaPipe depth or leg/torso ratio is noisy.
  const strongLowAngleFrameSignal =
    ankleYForPitch < cfg.maxAnkleYForStrongLowAngle &&
    floorBelowFeetRatio >= cfg.minFloorBelowFeetRatioForStrongLowAngle &&
    personHeightRatio >= cfg.minPersonHeightRatioForLowAngle;

  const lowAngleFrameScore = lowAngleFrameSignal || strongLowAngleFrameSignal
    ? Math.min(1, Math.max(
        (cfg.maxAnkleYForLowAngle - ankleYForPitch) / 0.18 + 0.45,
        strongLowAngleFrameSignal ? 0.95 : 0,
      ))
    : 0;

  // Low camera can also happen when the person fills most of the frame: feet are
  // near the bottom and the head is near the top, so there may not be much floor
  // below the feet. This pattern needs perspective support so normal close, level
  // photos are not blocked just because the body fills the frame.
  const lowFullBodyFrameSignal =
    personTopY <= cfg.maxHeadYForLowAngleFullBody &&
    ankleYForPitch >= cfg.minAnkleYForLowAngleFullBody &&
    personHeightRatio >= cfg.minPersonHeightRatioForLowAngleFullBody;

  const lowFullBodyLowerBodyPerspectiveSignal =
    ankleToShoulderWidthRatio >= cfg.minAnkleToShoulderWidthRatioForLowAngleFullBody ||
    lowerFootToShoulderWidthRatio >= cfg.minLowerFootToShoulderWidthRatioForLowAngleFullBody ||
    maxFootLengthToTorsoRatio >= cfg.minFootLengthToTorsoRatioForLowAngleFullBody;

  const lowFullBodySupportSignals = [
    legToTorsoRatio >= cfg.minLegToTorsoRatioForLowAngleFullBody,
    upperLowerZDelta > cfg.maxLowerBodyCloserZDelta * 0.60,
    widthSignalReliable && shoulderToHipWidthRatio > 0 && shoulderToHipWidthRatio < cfg.minShoulderToHipWidthRatio * 1.15,
    ankleToShoulderWidthRatio >= cfg.minAnkleToShoulderWidthRatioForLowAngleFullBody,
    lowerFootToShoulderWidthRatio >= cfg.minLowerFootToShoulderWidthRatioForLowAngleFullBody,
    maxFootLengthToTorsoRatio >= cfg.minFootLengthToTorsoRatioForLowAngleFullBody,
  ].filter(Boolean).length;

  const lowFullBodyVeryStrongFrameSignal =
    personTopY <= cfg.maxHeadYForLowAngleFullBody &&
    ankleYForPitch >= cfg.minAnkleYForLowAngleFullBody + 0.04 &&
    personHeightRatio >= cfg.minPersonHeightRatioForLowAngleFullBody + 0.05;

  // Full-body low-angle should not depend only on "floor below feet". In many
  // phone-on-floor shots the feet are near the bottom of the frame, so there is
  // little extra floor below them, but the perspective is still clearly bottom-up.
  // Block when the frame pattern is strong enough and at least one reliable
  // perspective support signal also agrees, or when two support signals agree.
  const lowFullBodyCameraBlockingSignal =
    lowFullBodyFrameSignal && (
      lowFullBodySupportSignals >= 2 ||
      (lowFullBodyVeryStrongFrameSignal && lowFullBodySupportSignals >= 1) ||
      // Phone-on-floor / very low camera case: the whole body fits in the frame,
      // but feet/shoes become disproportionately large. This catches cases where
      // there is little floor below the feet, so the old foreground-floor rule fails.
      (personTopY <= cfg.maxHeadYForLowAngleFullBody &&
        ankleYForPitch >= cfg.minAnkleYForLowAngleFullBody &&
        personHeightRatio >= cfg.minPersonHeightRatioForLowAngleFullBody &&
        lowFullBodyLowerBodyPerspectiveSignal)
    );

  const lowFullBodyFrameScore = lowFullBodyFrameSignal
    ? Math.min(1, Math.max(
        0.62,
        ((personHeightRatio - cfg.minPersonHeightRatioForLowAngleFullBody) / 0.22) + 0.35,
        ((ankleYForPitch - cfg.minAnkleYForLowAngleFullBody) / 0.18) + 0.35,
        lowFullBodyVeryStrongFrameSignal ? 0.82 : 0,
        lowFullBodyCameraBlockingSignal ? 0.92 : 0,
      ))
    : 0;

  // Image-based estimated camera pitch angle.
  // 90° = roughly level with the body. More than 90° means bottom-up;
  // less than 90° means top-down. This is not a true physical sensor angle,
  // but it converts the landmark/framing perspective signals into the requested
  // 75°–100° acceptance band.
  const floorSignal = Math.min(1, Math.max(0, (floorBelowFeetRatio - 0.10) / 0.28));
  const ankleHighSignal = Math.min(1, Math.max(0, (cfg.maxAnkleYForLowAngle - ankleYForPitch) / 0.28));
  const lowLegSignal = Math.min(1, Math.max(0, (legToTorsoRatio - cfg.minLegToTorsoRatioForLowAngle) / 1.0));
  const lowZSignal = Math.min(1, Math.max(0, upperLowerZDelta / Math.max(0.01, cfg.maxLowerBodyCloserZDelta * 1.6)));
  const lowWidthSignal = widthSignalReliable && shoulderToHipWidthRatio > 0
    ? Math.min(1, Math.max(0, (cfg.minShoulderToHipWidthRatio - shoulderToHipWidthRatio) / 0.45))
    : 0;

  const highLegSignal = Math.min(1, Math.max(0, (cfg.warningMinLegToTorsoRatio - legToTorsoRatio) / 0.55));
  const highZSignal = Math.min(1, Math.max(0, (-upperLowerZDelta - cfg.maxUpperBodyCloserZDelta * 0.65) / Math.max(0.01, cfg.maxUpperBodyCloserZDelta)));
  const highWidthSignal = widthSignalReliable
    ? Math.min(1, Math.max(0, (shoulderToHipWidthRatio - cfg.maxShoulderToHipWidthRatio) / 1.0))
    : 0;

  const lowPitchScore = Math.min(1, Math.max(
    lowAngleFrameScore,
    lowFullBodyFrameScore,
    (floorSignal * 0.50) + (ankleHighSignal * 0.35) + (lowLegSignal * 0.15),
    (floorSignal * 0.45) + (ankleHighSignal * 0.30) + (lowZSignal * 0.25),
    (lowLegSignal * 0.45) + (lowZSignal * 0.35) + (lowWidthSignal * 0.20),
  ));

  const highPitchScore = Math.min(1, Math.max(
    highAngleFrameScore,
    (highLegSignal * 0.45) + (highZSignal * 0.25) + (highWidthSignal * 0.10) + (highAngleFrameScore * 0.20),
    (highAngleFrameScore * 0.70) + (highLegSignal * 0.20) + (highZSignal * 0.10),
    highLegSignal,
  ));

  const estimatedCameraPitchAngleDeg = Math.max(55, Math.min(125,
    cfg.levelCameraPitchAngleDeg + (lowPitchScore * 25) - (highPitchScore * 22)
  ));

  const angleTooHigh = estimatedCameraPitchAngleDeg < cfg.minCameraPitchAngleDeg;
  const angleTooLow = estimatedCameraPitchAngleDeg > cfg.maxCameraPitchAngleDeg;

  // Camera pitch uses the same blocking sensitivity for front and side.
  // Side view still uses visible anchors when one side of the body is hidden,
  // but it no longer has separate stricter/softer CAMERA_TOO_HIGH/LOW rules.
  const highPitchBlockThreshold = 0.70;
  const lowPitchBlockThreshold = 0.68;

  if (lowAngleFrameSignal || strongLowAngleFrameSignal) {
    tooLowSignals.push(strongLowAngleFrameSignal ? 'LOW_CAMERA_FRAME_STRONG' : 'LOW_CAMERA_FRAME');
  }
  if (lowFullBodyFrameSignal) {
    tooLowSignals.push(lowFullBodyCameraBlockingSignal ? 'LOW_CAMERA_FULL_BODY_STRONG' : 'LOW_CAMERA_FULL_BODY');
  }

  // Leg/torso ratio is the most stable pitch signal. MediaPipe Z and
  // shoulder/hip width are noisy on real phones, so they can support an error,
  // but they are not allowed to create a blocking error by themselves.
  const highGeometrySignal = legToTorsoRatio > 0 && legToTorsoRatio < cfg.minLegToTorsoRatio;
  const lowGeometrySignal = legToTorsoRatio > cfg.maxLegToTorsoRatio;

  const strongHighSignal =
    legToTorsoRatio > 0 &&
    legToTorsoRatio < cfg.minLegToTorsoRatio / cfg.strongSingleSignalMultiplier;

  const strongLowSignal =
    legToTorsoRatio > cfg.maxLegToTorsoRatio * cfg.strongSingleSignalMultiplier;

  // Bottom-up shots need support evidence. A high leg/torso ratio alone can
  // happen in normal straight photos because of body shape, clothing, or pose
  // estimation noise. To block the photo we require the geometry signal plus
  // at least one perspective support signal, or an extreme single signal.
  const lowNearGeometrySignal = legToTorsoRatio > cfg.warningMaxLegToTorsoRatio;
  const lowSupportSignalsCount = tooLowSignals.filter((signal) => signal !== 'LEG_TORSO_RATIO').length;
  const widthSignalStrongLow =
    widthSignalReliable &&
    shoulderToHipWidthRatio > 0 &&
    shoulderToHipWidthRatio < cfg.minShoulderToHipWidthRatio;
  const zSignalStrongLow = upperLowerZDelta > cfg.maxLowerBodyCloserZDelta * 0.8;

  const lowCombinedPerspectiveSignal =
    lowNearGeometrySignal &&
    lowSupportSignalsCount >= 1 &&
    (widthSignalStrongLow || zSignalStrongLow || lowAngleFrameSignal || strongLowAngleFrameSignal);

  const strongLowPerspectiveSignal =
    lowNearGeometrySignal &&
    [widthSignalStrongLow, zSignalStrongLow, lowAngleFrameSignal, strongLowAngleFrameSignal, lowFullBodyVeryStrongFrameSignal, lowFullBodyCameraBlockingSignal].filter(Boolean).length >= 2;

  // A dedicated bottom-up blocker for cases where the person is clearly shot
  // from a low phone position but leg/torso ratio does not become extreme.
  const lowCameraFrameBlockingSignal =
    strongLowAngleFrameSignal ||
    lowFullBodyCameraBlockingSignal ||
    (lowFullBodyVeryStrongFrameSignal && lowSupportSignalsCount >= 1) ||
    (lowAngleFrameSignal &&
      floorBelowFeetRatio >= cfg.minFloorBelowFeetRatioForStrongLowAngle * 0.85 &&
      [legToTorsoRatio >= cfg.minLegToTorsoRatioForLowAngle, zSignalStrongLow, widthSignalStrongLow].filter(Boolean).length >= 2);

  // Side-specific low-angle guards are intentionally disabled here.
  // We use the same camera-pitch blocking rules for front and side; side view
  // differs only in how anchors are selected when one side of the body is hidden.
  const sideLowFramePattern = false;
  const sideLowStrongFramePattern = false;
  const sideLowVeryStrongFramePattern = false;
  const sideLowCameraFrameBlockingSignal = false;
  const sideAngleLowBlockingSignal = false;

  // Simple, view-agnostic camera-height guards.
  // These are intentionally easier to reason about than the score-based rules:
  //   • top-down: legs become visually compressed compared with torso
  //   • bottom-up: legs/feet/shoes become visually dominant compared with upper body
  // They require support signals so normal body-shape differences do not create
  // errors by themselves.
  const simpleTopDownSupportCount = [
    personHeightRatio <= cfg.simpleHighMaxPersonHeightRatio,
    shoulderToHipWidthRatio >= cfg.simpleHighMinShoulderToHipWidthRatio,
    upperLowerZDelta < -cfg.maxUpperBodyCloserZDelta * 0.35,
    highAngleFrameSignal,
  ].filter(Boolean).length;

  const simpleTopDownBlockingSignal =
    legToTorsoRatio > 0 &&
    legToTorsoRatio <= cfg.simpleHighMaxLegToTorsoRatio &&
    simpleTopDownSupportCount >= 1;

  const simpleBottomUpSupportCount = [
    lowFullBodyFrameSignal,
    lowAngleFrameSignal,
    lowerFootToShoulderWidthRatio >= cfg.simpleLowMinLowerFootToShoulderWidthRatio,
    maxFootLengthToTorsoRatio >= cfg.simpleLowMinFootLengthToTorsoRatio,
    ankleToShoulderWidthRatio >= cfg.simpleLowMinAnkleToShoulderWidthRatio,
    upperLowerZDelta > cfg.maxLowerBodyCloserZDelta * 0.35,
  ].filter(Boolean).length;

  const simpleFootPerspectiveIsStrong =
    lowerFootToShoulderWidthRatio >= cfg.simpleLowMinLowerFootToShoulderWidthRatio ||
    maxFootLengthToTorsoRatio >= cfg.simpleLowMinFootLengthToTorsoRatio ||
    ankleToShoulderWidthRatio >= cfg.simpleLowMinAnkleToShoulderWidthRatio;

  const simpleBottomUpBlockingSignal =
    personHeightRatio >= cfg.simpleLowMinPersonHeightRatio &&
    headY <= cfg.simpleLowMaxHeadY &&
    (
      (legToTorsoRatio >= cfg.simpleLowMinLegToTorsoRatio && simpleBottomUpSupportCount >= 2) ||
      (simpleFootPerspectiveIsStrong && simpleBottomUpSupportCount >= 2) ||
      (lowFullBodyVeryStrongFrameSignal && simpleBottomUpSupportCount >= 2)
    );

  let direction: CameraPitchDirection = 'level';
  let pitchScore = 0;

  // The primary blocking rule uses an image-estimated pitch range, but
  // top-down blocking is not allowed to depend on one weak signal alone.
  // This prevents straight photos from being rejected while still blocking
  // clear high-angle shots in both front and side views.
  const highSupportSignalsCount = tooHighSignals.filter((signal) => signal !== 'LEG_TORSO_RATIO').length;
  const highCameraFrameBlockingSignal =
    strongHighAngleFrameSignal ||
    (highAngleFrameSignal && highSupportSignalsCount >= 2 && highPitchScore > 0.74);

  // Side-specific top-down guard is intentionally disabled.
  // Front and side now use the same CAMERA_TOO_HIGH blocking rule.
  const sideHighCameraFrameBlockingSignal = false;

  const highAngleBlockingSignal =
    highCameraFrameBlockingSignal ||
    sideHighCameraFrameBlockingSignal ||
    (angleTooHigh &&
      highPitchScore > highPitchBlockThreshold &&
      (highGeometrySignal || highSupportSignalsCount >= 1));

  if (simpleTopDownBlockingSignal || highAngleBlockingSignal) {
    direction = 'tooHigh';
    pitchScore = Math.min(1, Math.max(
      0.72,
      (cfg.minCameraPitchAngleDeg - estimatedCameraPitchAngleDeg) / 22,
      simpleTopDownBlockingSignal ? 0.9 : 0,
      highCameraFrameBlockingSignal ? 0.86 : 0,
      sideHighCameraFrameBlockingSignal ? 0.84 : 0,
    ));
    errors.push({
      code: 'CAMERA_TOO_HIGH',
      message: 'The camera angle is too high. Keep the phone around chest height and point it straight at your body.',
      severity: 'error',
    });
  } else if (
    simpleBottomUpBlockingSignal ||
    sideLowCameraFrameBlockingSignal ||
    sideAngleLowBlockingSignal ||
    (angleTooLow && (lowSupportSignalsCount >= 1 || lowAngleFrameSignal || strongLowAngleFrameSignal || lowFullBodyCameraBlockingSignal || zSignalStrongLow || widthSignalStrongLow))
  ) {
    direction = 'tooLow';
    pitchScore = Math.min(1, Math.max(0.75, (estimatedCameraPitchAngleDeg - cfg.maxCameraPitchAngleDeg) / 20, lowPitchScore, simpleBottomUpBlockingSignal ? 0.9 : 0, sideLowCameraFrameBlockingSignal ? 0.88 : 0));
    errors.push({
      code: 'CAMERA_TOO_LOW',
      message: 'The camera angle is too low. Keep the phone around chest height and point it straight at your body.',
      severity: 'error',
    });
  } else if ((highGeometrySignal && tooHighSignals.length >= cfg.minPitchEvidenceForError) || (strongHighSignal && tooHighSignals.length >= 1)) {
    direction = 'tooHigh';
    pitchScore = Math.max(tooHighSignals.length / 3, strongHighSignal ? 1 : 0);
    errors.push({
      code: 'CAMERA_TOO_HIGH',
      message: 'The camera angle is too high. Keep the phone around chest height and point it straight at your body.',
      severity: 'error',
    });
  } else if (
    sideLowCameraFrameBlockingSignal ||
    lowCameraFrameBlockingSignal ||
    (lowGeometrySignal && lowSupportSignalsCount >= 1) ||
    lowCombinedPerspectiveSignal ||
    strongLowPerspectiveSignal ||
    strongLowSignal
  ) {
    direction = 'tooLow';
    pitchScore = Math.max(
      tooLowSignals.length / 3,
      lowCombinedPerspectiveSignal ? 0.85 : 0,
      lowCameraFrameBlockingSignal ? 0.9 : 0,
      strongLowPerspectiveSignal ? 1 : 0,
      strongLowSignal ? 1 : 0
    );
    errors.push({
      code: 'CAMERA_TOO_LOW',
      message: 'The camera angle is too low. Keep the phone around chest height and point it straight at your body.',
      severity: 'error',
    });
  } else {
    const nearHigh =
      (legToTorsoRatio > 0 && legToTorsoRatio < cfg.warningMinLegToTorsoRatio && tooHighSignals.length >= 1) ||
      upperLowerZDelta < -cfg.maxUpperBodyCloserZDelta * 0.90;
    const nearLow =
      legToTorsoRatio > cfg.warningMaxLegToTorsoRatio ||
      upperLowerZDelta > cfg.maxLowerBodyCloserZDelta * 0.90 ||
      lowAngleFrameSignal ||
      strongLowAngleFrameSignal ||
      lowFullBodyFrameSignal ||
      (lowNearGeometrySignal && (widthSignalStrongLow || zSignalStrongLow));

    // Near-pitch signals are advisory only. They are deliberately not blocking
    // because leg/torso ratio and MediaPipe Z can be noisy on normal straight
    // photos. Clear top-down / bottom-up shots are blocked by the stronger
    // multi-signal conditions above.
    if (nearHigh) {
      direction = 'tooHigh';
      pitchScore = 0.35;
      warnings.push({
        code: 'CAMERA_SLIGHTLY_HIGH',
        message: 'The camera seems a little high. Try keeping it level with your body.',
        severity: 'warning',
      });
    } else if (nearLow) {
      direction = 'tooLow';
      pitchScore = 0.35;
      warnings.push({
        code: 'CAMERA_SLIGHTLY_LOW',
        message: 'The camera seems a little low. Try keeping it level with your body.',
        severity: 'warning',
      });
    }
  }

  return {
    direction,
    pitchScore,
    estimatedCameraPitchAngleDeg,
    legToTorsoRatio,
    shoulderToHipWidthRatio,
    upperLowerZDelta,
    ankleYForPitch,
    lowAngleFrameScore,
    errors,
    warnings,
  };
}

function emptyCameraPitchResult(
  errors: ValidationError[],
  warnings: ValidationError[]
): CameraPitchResult {
  return {
    direction: 'unknown',
    pitchScore: 0,
    estimatedCameraPitchAngleDeg: 0,
    legToTorsoRatio: 0,
    shoulderToHipWidthRatio: 0,
    upperLowerZDelta: 0,
    ankleYForPitch: 0,
    lowAngleFrameScore: 0,
    errors,
    warnings,
  };
}


function averageVisiblePoint(
  points: Array<NormalizedLandmark | undefined>,
  minVis: number
): NormalizedLandmark {
  const visible = points.filter((p): p is NormalizedLandmark => isVisible(p, minVis));

  if (visible.length === 0) {
    return { x: 0, y: 0, z: 0, visibility: 0 };
  }

  const n = visible.length;
  return {
    x: visible.reduce((sum, p) => sum + p.x, 0) / n,
    y: visible.reduce((sum, p) => sum + p.y, 0) / n,
    z: visible.reduce((sum, p) => sum + (p.z ?? 0), 0) / n,
    visibility: Math.min(...visible.map((p) => p.visibility ?? 1)),
  };
}

function maxVisiblePairDistance(points: Array<NormalizedLandmark | undefined>, minVis: number): number {
  const visible = points.filter((p): p is NormalizedLandmark => isVisible(p, minVis));
  let maxDistance = 0;

  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const dx = visible[i].x - visible[j].x;
      const dy = visible[i].y - visible[j].y;
      maxDistance = Math.max(maxDistance, Math.sqrt(dx * dx + dy * dy));
    }
  }

  return maxDistance;
}

function averageVisibleZ(points: Array<NormalizedLandmark | undefined>, minVis: number): number {
  const visible = points.filter((p): p is NormalizedLandmark => isVisible(p, minVis));
  if (visible.length === 0) return 0;
  return visible.reduce((sum, p) => sum + (p.z ?? 0), 0) / visible.length;
}
