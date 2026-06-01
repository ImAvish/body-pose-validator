/**
 * poseValidation.ts
 *
 * Front-view validation:
 * - Face must be visible to reject back-facing front photos.
 * - Arms must be slightly open from the torso.
 * - Feet must be slightly apart.
 *
 * Side-profile validation:
 * - Arm/hand must be visible beside the body and kept down.
 * - Feet must be visible and naturally aligned for a side profile.
 *
 * All thresholds are configured in src/config/validationConfig.ts.
 */

import type { NormalizedLandmark, ValidationError } from '../types/validation';
import type { AppConfig } from '../types/models';
import { LM, isVisible } from './poseDetection';
import { midpoint } from '../utils/geometryUtils';

export interface FrontFacingResult {
  faceVisibilityScore: number;
  visibleFaceLandmarks: number;
  errors: ValidationError[];
  warnings: ValidationError[];
}

export interface ArmOpeningResult {
  wristToHipWidthRatio: number;
  elbowToTorsoRatio: number;
  wristOutsideTorsoRatio: number;
  elbowOutsideTorsoRatio: number;
  errors: ValidationError[];
  warnings: ValidationError[];
}

export interface LegOpeningResult {
  ankleToHipWidthRatio: number;
  errors: ValidationError[];
  warnings: ValidationError[];
}

export interface FrontPoseResult {
  facing: FrontFacingResult;
  arm: ArmOpeningResult;
  leg: LegOpeningResult;
  errors: ValidationError[];
  warnings: ValidationError[];
}

export interface SideProfilePoseResult {
  wristTorsoGapRatio: number;
  ankleXSpreadRatio: number;
  errors: ValidationError[];
  warnings: ValidationError[];
}


// ── Front-view face direction ────────────────────────────────────────────────

export function validateFrontFacing(
  landmarks: NormalizedLandmark[],
  config: AppConfig
): FrontFacingResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const cfg = config.frontPose.facing;

  const faceMinVis = cfg.minFaceLandmarkVisibility;
  const nose = landmarks[LM.NOSE];
  const lEye = landmarks[LM.LEFT_EYE];
  const rEye = landmarks[LM.RIGHT_EYE];
  const lEar = landmarks[LM.LEFT_EAR];
  const rEar = landmarks[LM.RIGHT_EAR];
  const mouthL = landmarks[LM.MOUTH_LEFT];
  const mouthR = landmarks[LM.MOUTH_RIGHT];
  const lShoulder = landmarks[LM.LEFT_SHOULDER];
  const rShoulder = landmarks[LM.RIGHT_SHOULDER];
  const lHip = landmarks[LM.LEFT_HIP];
  const rHip = landmarks[LM.RIGHT_HIP];

  // Back-facing front photos are not reliably rejected by NOSE alone because
  // MediaPipe can sometimes hallucinate a weak nose point on hair/back-of-head.
  // Keep a small face set internally and require several face landmarks to be
  // visible for the front-view step.
  const facePoints = [nose, lEye, rEye, lEar, rEar, mouthL, mouthR];
  const visibleFaceLandmarks = facePoints.filter((p) => isVisible(p, faceMinVis)).length;
  const faceVisibilityScore = facePoints.reduce((sum, p) => sum + (p?.visibility ?? 0), 0) / facePoints.length;
  const hasCoreFace = isVisible(nose, faceMinVis) &&
    (isVisible(lEye, faceMinVis) || isVisible(rEye, faceMinVis) || isVisible(mouthL, faceMinVis) || isVisible(mouthR, faceMinVis));

  const shouldersVisible =
    isVisible(lShoulder, config.confidence.minLandmarkVisibility) &&
    isVisible(rShoulder, config.confidence.minLandmarkVisibility);
  const hipsVisible =
    isVisible(lHip, config.confidence.minLandmarkVisibility) &&
    isVisible(rHip, config.confidence.minLandmarkVisibility);

  const shoulderWidth = shouldersVisible ? Math.abs(lShoulder.x - rShoulder.x) : 0;
  const hipWidth = hipsVisible ? Math.abs(lHip.x - rHip.x) : 0;
  const bothEyesVisible = isVisible(lEye, faceMinVis) && isVisible(rEye, faceMinVis);
  const bothMouthVisible = isVisible(mouthL, faceMinVis) && isVisible(mouthR, faceMinVis);
  const eyeWidthRatio = bothEyesVisible ? Math.abs(lEye.x - rEye.x) / Math.max(shoulderWidth, 0.01) : 0;
  const mouthWidthRatio = bothMouthVisible ? Math.abs(mouthL.x - mouthR.x) / Math.max(shoulderWidth, 0.01) : 0;

  // Back-facing photos can sometimes get a hallucinated NOSE landmark. Do not
  // trust the nose alone. For the front step, require a reliable front-face pair
  // such as both eyes or both mouth corners with a plausible width.
  const hasReliableFacePair = shouldersVisible && (
    (bothEyesVisible && eyeWidthRatio >= cfg.minFacePairWidthToShoulderRatio) ||
    (bothMouthVisible && mouthWidthRatio >= cfg.minFacePairWidthToShoulderRatio * 0.65)
  );

  if (
    visibleFaceLandmarks < cfg.minVisibleFaceLandmarks ||
    faceVisibilityScore < cfg.minFaceVisibilityScore ||
    !hasCoreFace ||
    !hasReliableFacePair
  ) {
    errors.push({
      code: 'FRONT_BACK_FACING',
      message: 'Please face the camera. Back-facing photos are not accepted for the front view.',
      severity: 'error',
    });
  }

  // Body left/right order guard for back-facing photos.
  // MediaPipe labels LEFT/RIGHT anatomically. In a true front-facing image,
  // anatomical LEFT normally appears on the viewer's right side, so
  // LEFT_SHOULDER.x and LEFT_HIP.x should be greater than the corresponding
  // RIGHT landmarks. When the user stands with their back to the camera, this
  // order flips. This is a strong signal even if face landmarks are hallucinated.
  if (cfg.requireFrontBodyLeftRightOrder && shouldersVisible && hipsVisible) {
    const bodyOrderCanBeChecked =
      shoulderWidth >= cfg.minFrontBodyOrderXSpread &&
      hipWidth >= cfg.minFrontBodyOrderXSpread;
    const shoulderOrderLooksBackFacing = lShoulder.x < rShoulder.x;
    const hipOrderLooksBackFacing = lHip.x < rHip.x;

    if (bodyOrderCanBeChecked && shoulderOrderLooksBackFacing && hipOrderLooksBackFacing) {
      errors.push({
        code: 'FRONT_BACK_FACING',
        message: 'Please face the camera. Back-facing photos are not accepted for the front view.',
        severity: 'error',
      });
    }
  }

  // Extra guard for cases where the model produces a weak/hallucinated nose
  // on a back-facing or strongly turned head.
  if (shouldersVisible && isVisible(nose, faceMinVis)) {
    const shoulderMid = midpoint(lShoulder, rShoulder);
    const noseOffsetRatio = Math.abs(nose.x - shoulderMid.x) / Math.max(shoulderWidth, 0.01);

    if (noseOffsetRatio > cfg.maxNoseShoulderCenterOffsetRatio) {
      errors.push({
        code: 'FRONT_FACE_NOT_CENTERED',
        message: 'Please face the camera directly. Do not turn your head away from the camera.',
        severity: 'error',
      });
    }

    if (cfg.requireNoseAboveShoulders && nose.y > shoulderMid.y - 0.015) {
      errors.push({
        code: 'FRONT_FACE_NOT_CLEAR',
        message: 'Your face is not clear enough. Please face the camera directly.',
        severity: 'error',
      });
    }
  }

  return {
    faceVisibilityScore,
    visibleFaceLandmarks,
    errors: dedupeValidationItems(errors),
    warnings,
  };
}

// ── Front-view arm opening ───────────────────────────────────────────────────

export function validateArmOpening(
  landmarks: NormalizedLandmark[],
  config: AppConfig
): ArmOpeningResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const minVis = config.confidence.minLandmarkVisibility;
  const cfg = config.frontPose.armOpening;

  const lWrist = landmarks[LM.LEFT_WRIST];
  const rWrist = landmarks[LM.RIGHT_WRIST];
  const lElbow = landmarks[LM.LEFT_ELBOW];
  const rElbow = landmarks[LM.RIGHT_ELBOW];
  const lHip = landmarks[LM.LEFT_HIP];
  const rHip = landmarks[LM.RIGHT_HIP];
  const lShoulder = landmarks[LM.LEFT_SHOULDER];
  const rShoulder = landmarks[LM.RIGHT_SHOULDER];

  const hasWrists = isVisible(lWrist, minVis) && isVisible(rWrist, minVis);
  const hasElbows = isVisible(lElbow, minVis) && isVisible(rElbow, minVis);
  const hasHips = isVisible(lHip, minVis) && isVisible(rHip, minVis);
  const hasShoulders = isVisible(lShoulder, minVis) && isVisible(rShoulder, minVis);

  if (!hasWrists) {
    errors.push({
      code: 'HANDS_NOT_VISIBLE',
      message: 'Both hands must be visible. Keep your arms away from your body.',
      severity: 'error',
    });
  }

  const hipWidth = hasHips ? Math.abs(lHip.x - rHip.x) : 0;
  const shoulderWidth = hasShoulders ? Math.abs(lShoulder.x - rShoulder.x) : hipWidth;
  const torsoWidth = Math.max(hipWidth, shoulderWidth, 0.01);

  const wristSpanX = hasWrists ? Math.abs(lWrist.x - rWrist.x) : 0;
  const wristToHipWidthRatio = hipWidth > 0 ? wristSpanX / Math.max(hipWidth, 0.01) : 0;

  const torsoMinX = hasShoulders && hasHips
    ? Math.min(lShoulder.x, rShoulder.x, lHip.x, rHip.x)
    : 0;
  const torsoMaxX = hasShoulders && hasHips
    ? Math.max(lShoulder.x, rShoulder.x, lHip.x, rHip.x)
    : 1;

  const wristOutsideTorsoRatio = hasWrists
    ? getOutsideTorsoRatio([lWrist, rWrist], torsoMinX, torsoMaxX, torsoWidth)
    : 0;
  const elbowOutsideTorsoRatio = hasElbows
    ? getOutsideTorsoRatio([lElbow, rElbow], torsoMinX, torsoMaxX, torsoWidth)
    : 0;

  const leftWristOutsideRatio = hasWrists
    ? getSingleOutsideTorsoRatio(lWrist, torsoMinX, torsoMaxX, torsoWidth)
    : 0;
  const rightWristOutsideRatio = hasWrists
    ? getSingleOutsideTorsoRatio(rWrist, torsoMinX, torsoMaxX, torsoWidth)
    : 0;
  const leftElbowOutsideRatio = hasElbows
    ? getSingleOutsideTorsoRatio(lElbow, torsoMinX, torsoMaxX, torsoWidth)
    : 0;
  const rightElbowOutsideRatio = hasElbows
    ? getSingleOutsideTorsoRatio(rElbow, torsoMinX, torsoMaxX, torsoWidth)
    : 0;

  // Elbow-to-torso-line: distance from each elbow to the vertical torso centreline.
  let elbowToTorsoRatio = 0;
  if (hasElbows && hasShoulders && hasHips) {
    const torsoMidX = midpoint(
      midpoint(lShoulder, rShoulder),
      midpoint(lHip, rHip)
    ).x;
    const lElbowDist = Math.abs(lElbow.x - torsoMidX);
    const rElbowDist = Math.abs(rElbow.x - torsoMidX);
    elbowToTorsoRatio = (lElbowDist + rElbowDist) / 2 / Math.max(shoulderWidth, 0.01);
  }

  if (hasWrists && hasHips) {
    const armsTooCloseBySpan = wristToHipWidthRatio < cfg.minWristToHipWidthRatio;
    const armsTooCloseByOutsideGap = wristOutsideTorsoRatio < cfg.minWristOutsideTorsoRatio;
    const oneWristTooClose = Math.min(leftWristOutsideRatio, rightWristOutsideRatio) < cfg.minWristOutsideTorsoRatio * 0.65;
    const elbowsTooCloseByOutsideGap = hasElbows && elbowOutsideTorsoRatio < cfg.minElbowOutsideTorsoRatio;
    const oneElbowTooClose = hasElbows && Math.min(leftElbowOutsideRatio, rightElbowOutsideRatio) < cfg.minElbowOutsideTorsoRatio * 0.65;
    const elbowsTooCloseByCenterLine = hasElbows && elbowToTorsoRatio < cfg.minElbowToTorsoRatio;

    if (armsTooCloseBySpan || armsTooCloseByOutsideGap || oneWristTooClose || elbowsTooCloseByOutsideGap || oneElbowTooClose || elbowsTooCloseByCenterLine) {
      errors.push({
        code: 'ARMS_TOO_CLOSE',
        message: 'Open your arms slightly — keep a visible gap between your arms and body.',
        severity: 'error',
      });
    } else if (wristToHipWidthRatio > cfg.maxWristToHipWidthRatio) {
      errors.push({
        code: 'ARMS_TOO_WIDE',
        message: 'Your arms are too wide. Keep your arms slightly open, not stretched out horizontally.',
        severity: 'error',
      });
    }
  }

  if (hasWrists && hasElbows && hasShoulders && hasHips) {
    const leftHandOnWaist = isFrontHandOnWaistPose(
      lShoulder,
      lElbow,
      lWrist,
      lHip,
      rHip,
      torsoMinX,
      torsoMaxX,
      torsoWidth,
      cfg.maxHandOnWaistElbowAngleDeg,
      cfg.maxHandOnWaistWristHipDistanceRatio,
      cfg.maxHandOnWaistWristInsideTorsoMarginRatio
    );

    const rightHandOnWaist = isFrontHandOnWaistPose(
      rShoulder,
      rElbow,
      rWrist,
      rHip,
      lHip,
      torsoMinX,
      torsoMaxX,
      torsoWidth,
      cfg.maxHandOnWaistElbowAngleDeg,
      cfg.maxHandOnWaistWristHipDistanceRatio,
      cfg.maxHandOnWaistWristInsideTorsoMarginRatio
    );

    if (leftHandOnWaist || rightHandOnWaist) {
      errors.push({
        code: 'HAND_ON_WAIST_OR_BENT_ARM',
        message: 'Keep both arms down and slightly open. Do not put your hand on your waist or bend your arm.',
        severity: 'error',
      });
    }
  }

  if (cfg.requireWristsBelowElbows && hasWrists && hasElbows) {
    const leftRaised = lWrist.y < lElbow.y - 0.015;
    const rightRaised = rWrist.y < rElbow.y - 0.015;
    if (leftRaised || rightRaised) {
      errors.push({
        code: 'ARMS_RAISED_OR_BENT',
        message: 'Keep your arms down and slightly open. Do not raise or bend your arms.',
        severity: 'error',
      });
    }
  }

  return {
    wristToHipWidthRatio,
    elbowToTorsoRatio,
    wristOutsideTorsoRatio,
    elbowOutsideTorsoRatio,
    errors: dedupeValidationItems(errors),
    warnings,
  };
}

// ── Front-view feet opening ──────────────────────────────────────────────────

export function validateLegOpening(
  landmarks: NormalizedLandmark[],
  config: AppConfig
): LegOpeningResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const minVis = config.confidence.minLandmarkVisibility;
  const cfg = config.frontPose.legOpening;

  const lAnkle = landmarks[LM.LEFT_ANKLE];
  const rAnkle = landmarks[LM.RIGHT_ANKLE];
  const lHeel = landmarks[LM.LEFT_HEEL];
  const rHeel = landmarks[LM.RIGHT_HEEL];
  const lFoot = landmarks[LM.LEFT_FOOT];
  const rFoot = landmarks[LM.RIGHT_FOOT];
  const lHip = landmarks[LM.LEFT_HIP];
  const rHip = landmarks[LM.RIGHT_HIP];

  const hasAnkles = isVisible(lAnkle, minVis) && isVisible(rAnkle, minVis);
  const hasHips = isVisible(lHip, minVis) && isVisible(rHip, minVis);

  const hipWidth = hasHips ? Math.abs(lHip.x - rHip.x) : 0;
  const ankleSpreadX = hasAnkles ? Math.abs(lAnkle.x - rAnkle.x) : 0;
  const heelSpreadX = visiblePairXSpread(lHeel, rHeel, minVis);
  const footSpreadX = visiblePairXSpread(lFoot, rFoot, minVis);
  const bestFootSpreadX = Math.max(ankleSpreadX, heelSpreadX, footSpreadX);
  const ankleToHipWidthRatio = hipWidth > 0 ? bestFootSpreadX / Math.max(hipWidth, 0.01) : 0;

  if (!hasAnkles || !hasHips) {
    errors.push({
      code: 'FEET_NOT_CLEAR',
      message: 'Both feet must be visible and slightly apart.',
      severity: 'error',
    });
    return { ankleToHipWidthRatio, errors, warnings };
  }

  if (ankleToHipWidthRatio < cfg.minAnkleToHipWidthRatio) {
    errors.push({
      code: 'FEET_TOO_CLOSE',
      message: 'Open your feet slightly — do not keep your feet together.',
      severity: 'error',
    });
  } else if (ankleToHipWidthRatio > cfg.maxAnkleToHipWidthRatio) {
    warnings.push({
      code: 'FEET_TOO_WIDE',
      message: 'Your feet are too far apart. Bring them slightly closer together.',
      severity: 'warning',
    });
  }

  return { ankleToHipWidthRatio, errors, warnings };
}

// ── Combined front-view pose check ───────────────────────────────────────────

export function validateFrontPose(
  landmarks: NormalizedLandmark[],
  config: AppConfig
): FrontPoseResult {
  const facing = config.frontPose.facing.enabled && config.modules.frontFacing
    ? validateFrontFacing(landmarks, config)
    : { faceVisibilityScore: 0, visibleFaceLandmarks: 0, errors: [], warnings: [] };

  const arm = config.frontPose.armOpening.enabled
    ? validateArmOpening(landmarks, config)
    : emptyArmResult();

  const leg = config.frontPose.legOpening.enabled
    ? validateLegOpening(landmarks, config)
    : { ankleToHipWidthRatio: 0, errors: [], warnings: [] };

  return {
    facing,
    arm,
    leg,
    errors: [...facing.errors, ...arm.errors, ...leg.errors],
    warnings: [...facing.warnings, ...arm.warnings, ...leg.warnings],
  };
}

// ── Side-profile pose check ──────────────────────────────────────────────────

export function validateSideProfilePose(
  landmarks: NormalizedLandmark[],
  config: AppConfig
): SideProfilePoseResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const minVis = config.confidence.minLandmarkVisibility;
  const armCfg = config.sidePose.arm;
  const feetCfg = config.sidePose.feet;
  const legCfg = config.sidePose.leg;

  const lShoulder = landmarks[LM.LEFT_SHOULDER];
  const rShoulder = landmarks[LM.RIGHT_SHOULDER];
  const lHip = landmarks[LM.LEFT_HIP];
  const rHip = landmarks[LM.RIGHT_HIP];
  const lElbow = landmarks[LM.LEFT_ELBOW];
  const rElbow = landmarks[LM.RIGHT_ELBOW];
  const lWrist = landmarks[LM.LEFT_WRIST];
  const rWrist = landmarks[LM.RIGHT_WRIST];
  const lKnee = landmarks[LM.LEFT_KNEE];
  const rKnee = landmarks[LM.RIGHT_KNEE];
  const lAnkle = landmarks[LM.LEFT_ANKLE];
  const rAnkle = landmarks[LM.RIGHT_ANKLE];
  const lHeel = landmarks[LM.LEFT_HEEL];
  const rHeel = landmarks[LM.RIGHT_HEEL];
  const lFoot = landmarks[LM.LEFT_FOOT];
  const rFoot = landmarks[LM.RIGHT_FOOT];

  const hasShoulders = isVisible(lShoulder, minVis) && isVisible(rShoulder, minVis);
  const hasHips = isVisible(lHip, minVis) && isVisible(rHip, minVis);
  const shoulderMid = hasShoulders ? midpoint(lShoulder, rShoulder) : null;
  const hipMid = hasHips ? midpoint(lHip, rHip) : null;

  const ankleMid = visiblePairMidpoint(lAnkle, rAnkle, minVis);
  const bodyHeight = Math.max(
    shoulderMid && ankleMid ? Math.abs(ankleMid.y - shoulderMid.y) : 0,
    shoulderMid && hipMid ? Math.abs(hipMid.y - shoulderMid.y) * 2.2 : 0,
    0.25
  );
  const torsoCenterX = shoulderMid && hipMid
    ? (shoulderMid.x + hipMid.x) / 2
    : shoulderMid?.x ?? hipMid?.x ?? 0.5;

  let wristTorsoGapRatio = 0;
  if (armCfg.enabled) {
    const visibleArmLandmarks = [lElbow, rElbow, lWrist, rWrist]
      .filter((lm) => isVisible(lm, minVis));
    const visibleWrists = [lWrist, rWrist]
      .filter((lm) => isVisible(lm, minVis));
    const visibleElbows = [lElbow, rElbow]
      .filter((lm) => isVisible(lm, minVis));

    if (visibleArmLandmarks.length < armCfg.minVisibleArmLandmarks || visibleWrists.length === 0) {
      errors.push({
        code: 'SIDE_ARM_NOT_VISIBLE',
        message: 'Keep your arm and hand visible beside your body in the side photo.',
        severity: 'error',
      });
    } else {
      wristTorsoGapRatio = Math.max(
        ...visibleWrists.map((wrist) => Math.abs(wrist.x - torsoCenterX) / bodyHeight)
      );

      if (wristTorsoGapRatio < armCfg.minWristTorsoGapRatio && visibleElbows.length > 0) {
        const elbowGapRatio = Math.max(
          ...visibleElbows.map((elbow) => Math.abs(elbow.x - torsoCenterX) / bodyHeight)
        );
        if (elbowGapRatio < armCfg.minWristTorsoGapRatio) {
          errors.push({
            code: 'SIDE_ARM_TOO_CLOSE',
            message: 'Move your arm slightly away from your body so it is clearly visible.',
            severity: 'error',
          });
        }
      }

      if (wristTorsoGapRatio > armCfg.maxWristTorsoGapRatio) {
        warnings.push({
          code: 'SIDE_ARM_TOO_FAR',
          message: 'Keep your arm relaxed beside your body, not stretched forward or backward.',
          severity: 'warning',
        });
      }

      if (hipMid) {
        const highestVisibleWristY = Math.min(...visibleWrists.map((wrist) => wrist.y));
        if (highestVisibleWristY < hipMid.y - bodyHeight * armCfg.maxWristAboveHipRatio) {
          errors.push({
            code: 'SIDE_ARM_RAISED',
            message: 'Keep your arm down beside your body in the side photo.',
            severity: 'error',
          });
        }
      }

      if (armCfg.requireWristBelowElbow && visibleWrists.length > 0 && visibleElbows.length > 0) {
        const averageWristY = average(visibleWrists.map((wrist) => wrist.y));
        const averageElbowY = average(visibleElbows.map((elbow) => elbow.y));
        if (averageWristY < averageElbowY - 0.015) {
          errors.push({
            code: 'SIDE_ARM_BENT_OR_RAISED',
            message: 'Keep your arm straight down. Do not bend or raise it.',
            severity: 'error',
          });
        }
      }
    }
  }

  let ankleXSpreadRatio = 0;
  if (feetCfg.enabled) {
    const visibleFootLandmarks = [lAnkle, rAnkle, lHeel, rHeel, lFoot, rFoot]
      .filter((lm) => isVisible(lm, minVis));

    if (visibleFootLandmarks.length < feetCfg.minVisibleFootLandmarks) {
      errors.push({
        code: 'SIDE_FEET_NOT_VISIBLE',
        message: 'Both feet must be visible in the side photo.',
        severity: 'error',
      });
    }

    if (isVisible(lAnkle, minVis) && isVisible(rAnkle, minVis)) {
      ankleXSpreadRatio = Math.abs(lAnkle.x - rAnkle.x) / bodyHeight;
      if (ankleXSpreadRatio > feetCfg.maxAnkleXSpreadRatio) {
        warnings.push({
          code: 'SIDE_FEET_TOO_FAR_APART',
          message: 'For the side photo, stand naturally with your feet aligned.',
          severity: 'warning',
        });
      }
    }
  }

  if (legCfg.enabled) {
    const leftLeg = getSideLegPostureMetrics(lHip, lKnee, lAnkle, torsoCenterX, bodyHeight, minVis);
    const rightLeg = getSideLegPostureMetrics(rHip, rKnee, rAnkle, torsoCenterX, bodyHeight, minVis);
    const visibleLegs = [leftLeg, rightLeg].filter((leg) => leg.visible);

    const bentLeg = visibleLegs.some((leg) =>
      leg.kneeAngleDeg > 0 && leg.kneeAngleDeg < legCfg.minKneeAngleDeg
    );

    const ankleNotBelowKnee = visibleLegs.some((leg) =>
      leg.kneeToAnkleDropRatio < legCfg.minKneeToAnkleDropRatio
    );

    const legTooFarFromBody = visibleLegs.some((leg) =>
      leg.kneeTorsoGapRatio > legCfg.maxKneeTorsoGapRatio ||
      leg.ankleTorsoGapRatio > legCfg.maxAnkleTorsoGapRatio
    );

    const bothKneesVisible = isVisible(lKnee, minVis) && isVisible(rKnee, minVis);
    const bothAnklesVisible = isVisible(lAnkle, minVis) && isVisible(rAnkle, minVis);
    const ankleYDiffRatio = bothAnklesVisible
      ? Math.abs(lAnkle.y - rAnkle.y) / bodyHeight
      : 0;
    const kneeYDiffRatio = bothKneesVisible
      ? Math.abs(lKnee.y - rKnee.y) / bodyHeight
      : 0;

    const oneLegLifted =
      (bothAnklesVisible && ankleYDiffRatio > legCfg.maxAnkleYDiffRatio) ||
      (bothKneesVisible && kneeYDiffRatio > legCfg.maxKneeYDiffRatio);

    if (bentLeg || ankleNotBelowKnee || oneLegLifted || legTooFarFromBody) {
      errors.push({
        code: 'SIDE_LEG_NOT_STRAIGHT',
        message: 'Keep both legs straight and beside your body in the side photo. Do not bend, lift, or move one leg backward/forward.',
        severity: 'error',
      });
    }
  }

  return {
    wristTorsoGapRatio,
    ankleXSpreadRatio,
    errors: dedupeValidationItems(errors),
    warnings,
  };
}

interface SideLegPostureMetrics {
  visible: boolean;
  kneeAngleDeg: number;
  kneeToAnkleDropRatio: number;
  kneeTorsoGapRatio: number;
  ankleTorsoGapRatio: number;
}

function getSideLegPostureMetrics(
  hip: NormalizedLandmark,
  knee: NormalizedLandmark,
  ankle: NormalizedLandmark,
  torsoCenterX: number,
  bodyHeight: number,
  minVis: number
): SideLegPostureMetrics {
  const hasHip = isVisible(hip, minVis);
  const hasKnee = isVisible(knee, minVis);
  const hasAnkle = isVisible(ankle, minVis);

  if (!hasHip || !hasKnee || !hasAnkle) {
    return {
      visible: false,
      kneeAngleDeg: 0,
      kneeToAnkleDropRatio: 1,
      kneeTorsoGapRatio: 0,
      ankleTorsoGapRatio: 0,
    };
  }

  return {
    visible: true,
    kneeAngleDeg: angleAtPointDeg(hip, knee, ankle),
    kneeToAnkleDropRatio: (ankle.y - knee.y) / Math.max(bodyHeight, 0.01),
    kneeTorsoGapRatio: Math.abs(knee.x - torsoCenterX) / Math.max(bodyHeight, 0.01),
    ankleTorsoGapRatio: Math.abs(ankle.x - torsoCenterX) / Math.max(bodyHeight, 0.01),
  };
}

function angleAtPointDeg(
  a: NormalizedLandmark,
  vertex: NormalizedLandmark,
  c: NormalizedLandmark
): number {
  const v1x = a.x - vertex.x;
  const v1y = a.y - vertex.y;
  const v2x = c.x - vertex.x;
  const v2y = c.y - vertex.y;
  const dot = v1x * v2x + v1y * v2y;
  const mag1 = Math.sqrt(v1x * v1x + v1y * v1y);
  const mag2 = Math.sqrt(v2x * v2x + v2y * v2y);
  if (mag1 < 1e-6 || mag2 < 1e-6) return 180;
  const cos = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
  return Math.acos(cos) * 180 / Math.PI;
}


function isFrontHandOnWaistPose(
  shoulder: NormalizedLandmark,
  elbow: NormalizedLandmark,
  wrist: NormalizedLandmark,
  sameSideHip: NormalizedLandmark,
  oppositeHip: NormalizedLandmark,
  torsoMinX: number,
  torsoMaxX: number,
  torsoWidth: number,
  maxElbowAngleDeg: number,
  maxWristHipDistanceRatio: number,
  maxWristInsideTorsoMarginRatio: number
): boolean {
  const hipMidY = (sameSideHip.y + oppositeHip.y) / 2;
  const torsoHeight = Math.max(Math.abs(hipMidY - shoulder.y), 0.01);

  const elbowAngleDeg = getJointAngleDeg(shoulder, elbow, wrist);
  const elbowIsBent = elbowAngleDeg < maxElbowAngleDeg;

  const wristHipDistanceRatio =
    Math.abs(wrist.y - sameSideHip.y) / Math.max(torsoHeight, 0.01);

  const wristNearWaistY =
    wristHipDistanceRatio <= maxWristHipDistanceRatio ||
    wrist.y < hipMidY + torsoHeight * 0.06;

  const margin = torsoWidth * maxWristInsideTorsoMarginRatio;
  const wristInsideOrNearTorso =
    wrist.x >= torsoMinX - margin &&
    wrist.x <= torsoMaxX + margin;

  return elbowIsBent && wristNearWaistY && wristInsideOrNearTorso;
}

function getJointAngleDeg(
  a: NormalizedLandmark,
  b: NormalizedLandmark,
  c: NormalizedLandmark
): number {
  const abx = a.x - b.x;
  const aby = a.y - b.y;
  const cbx = c.x - b.x;
  const cby = c.y - b.y;

  const abLen = Math.sqrt(abx * abx + aby * aby);
  const cbLen = Math.sqrt(cbx * cbx + cby * cby);

  if (abLen < 1e-6 || cbLen < 1e-6) return 180;

  const cosine = Math.max(-1, Math.min(1, (abx * cbx + aby * cby) / (abLen * cbLen)));
  return Math.acos(cosine) * (180 / Math.PI);
}

function getOutsideTorsoRatio(
  points: NormalizedLandmark[],
  torsoMinX: number,
  torsoMaxX: number,
  torsoWidth: number
): number {
  const sortedByX = [...points].sort((a, b) => a.x - b.x);
  const leftPoint = sortedByX[0];
  const rightPoint = sortedByX[sortedByX.length - 1];
  const leftGap = torsoMinX - leftPoint.x;
  const rightGap = rightPoint.x - torsoMaxX;
  return Math.min(leftGap, rightGap) / Math.max(torsoWidth, 0.01);
}

function getSingleOutsideTorsoRatio(
  point: NormalizedLandmark,
  torsoMinX: number,
  torsoMaxX: number,
  torsoWidth: number
): number {
  if (point.x < torsoMinX) return (torsoMinX - point.x) / Math.max(torsoWidth, 0.01);
  if (point.x > torsoMaxX) return (point.x - torsoMaxX) / Math.max(torsoWidth, 0.01);
  return 0;
}

function visiblePairXSpread(
  a: NormalizedLandmark,
  b: NormalizedLandmark,
  minVis: number
): number {
  return isVisible(a, minVis) && isVisible(b, minVis)
    ? Math.abs(a.x - b.x)
    : 0;
}

function visiblePairMidpoint(
  a: NormalizedLandmark,
  b: NormalizedLandmark,
  minVis: number
): NormalizedLandmark | null {
  if (isVisible(a, minVis) && isVisible(b, minVis)) return midpoint(a, b);
  if (isVisible(a, minVis)) return a;
  if (isVisible(b, minVis)) return b;
  return null;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function dedupeValidationItems(items: ValidationError[]): ValidationError[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.code)) return false;
    seen.add(item.code);
    return true;
  });
}

function emptyArmResult(): ArmOpeningResult {
  return {
    wristToHipWidthRatio: 0,
    elbowToTorsoRatio: 0,
    wristOutsideTorsoRatio: 0,
    elbowOutsideTorsoRatio: 0,
    errors: [],
    warnings: [],
  };
}
