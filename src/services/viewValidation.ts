/**
 * viewValidation.ts
 * Full-body visibility, standing-pose, and front/side/three-quarter view classification.
 *
 * Threshold config: src/config/validationConfig.ts
 *   confidence.minLandmarkVisibility  — used by ALL visibility checks
 *   confidence.minBodyVisibilityScore — full-body threshold
 *   viewClassification.frontSymmetryMinRatio   — front-view classification
 *   viewClassification.sideView.*               — side-view classification
 *   viewClassification.threeQuarter.*           — reject 3/4 photos in both steps
 */

import type { DetectedViewType, NormalizedLandmark, ValidationError, ViewType } from '../types/validation';
import type { AppConfig } from '../types/models';
import { LM, isVisible } from './poseDetection';
import { midpoint, dist2D } from '../utils/geometryUtils';

const UPPER_BODY_LMS = [LM.NOSE, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER];
const MID_BODY_LMS   = [LM.LEFT_HIP, LM.RIGHT_HIP];
const LOWER_BODY_LMS = [LM.LEFT_KNEE, LM.RIGHT_KNEE, LM.LEFT_ANKLE, LM.RIGHT_ANKLE];
const ALL_KEY_LMS    = [...UPPER_BODY_LMS, ...MID_BODY_LMS, ...LOWER_BODY_LMS];

// ─── Full-body visibility ─────────────────────────────────────────────────────

export interface BodyVisibilityResult {
  score: number;
  errors: ValidationError[];
}

export function validateBodyVisibility(
  landmarks: NormalizedLandmark[],
  config: AppConfig
): BodyVisibilityResult {
  const errors: ValidationError[] = [];
  const minVis = config.confidence.minLandmarkVisibility;

  const visibleCount = ALL_KEY_LMS.filter(
    (idx) => isVisible(landmarks[idx], minVis)
  ).length;
  const score = visibleCount / ALL_KEY_LMS.length;

  const hasHead      = isVisible(landmarks[LM.NOSE], minVis);
  const hasShoulders =
    isVisible(landmarks[LM.LEFT_SHOULDER], minVis) ||
    isVisible(landmarks[LM.RIGHT_SHOULDER], minVis);
  const hasLegs =
    isVisible(landmarks[LM.LEFT_KNEE], minVis) ||
    isVisible(landmarks[LM.RIGHT_KNEE], minVis);
  const hasFeet =
    isVisible(landmarks[LM.LEFT_ANKLE], minVis) ||
    isVisible(landmarks[LM.RIGHT_ANKLE], minVis);

  if (!hasHead && !hasShoulders) {
    errors.push({
      code: 'BODY_CUT_TOP',
      message: 'Your full body is not visible. Please move back so your head is inside the frame.',
      severity: 'error',
    });
  } else if (!hasFeet && !hasLegs) {
    errors.push({
      code: 'BODY_CUT_BOTTOM',
      message: 'Your full body is not visible. Please move back so your feet are inside the frame.',
      severity: 'error',
    });
  } else if (score < config.confidence.minBodyVisibilityScore) {
    errors.push({
      code: 'BODY_NOT_FULLY_VISIBLE',
      message:
        'Your full body is not visible. Please move back and make sure your head and feet are inside the frame.',
      severity: 'error',
    });
  }

  return { score, errors };
}

// ─── Standing upright ─────────────────────────────────────────────────────────

export interface StandingPoseResult {
  isUpright: boolean;
  errors: ValidationError[];
}

export function validateStandingPose(
  landmarks: NormalizedLandmark[],
  config: AppConfig
): StandingPoseResult {
  const errors: ValidationError[] = [];
  const minVis = config.confidence.minLandmarkVisibility;

  const lShoulder = landmarks[LM.LEFT_SHOULDER];
  const rShoulder = landmarks[LM.RIGHT_SHOULDER];
  const lHip      = landmarks[LM.LEFT_HIP];
  const rHip      = landmarks[LM.RIGHT_HIP];
  const lKnee     = landmarks[LM.LEFT_KNEE];
  const rKnee     = landmarks[LM.RIGHT_KNEE];

  const hasAll =
    isVisible(lShoulder, minVis) && isVisible(rShoulder, minVis) &&
    isVisible(lHip, minVis) && isVisible(rHip, minVis);

  if (!hasAll) return { isUpright: true, errors }; // benefit of doubt

  const shoulderMid = midpoint(lShoulder, rShoulder);
  const hipMid      = midpoint(lHip, rHip);

  // Crouching / sitting: hips should be ABOVE knees (lower y)
  const hasKnees = isVisible(lKnee, minVis) || isVisible(rKnee, minVis);
  if (hasKnees) {
    const hipsBelowKnees =
      (isVisible(lKnee, minVis) && lKnee.y < hipMid.y - 0.10) ||
      (isVisible(rKnee, minVis) && rKnee.y < hipMid.y - 0.10);
    if (hipsBelowKnees) {
      errors.push({
        code: 'NOT_STANDING',
        message: 'Please stand straight. Avoid sitting, crouching, or bending.',
        severity: 'error',
      });
    }
  }

  // Torso aspect ratio: torso height should be significantly taller than wide
  const bodyWidth  = dist2D(lShoulder, rShoulder);
  const bodyHeight = dist2D(shoulderMid, hipMid);
  if (bodyHeight < bodyWidth * 0.3) {
    errors.push({
      code: 'NOT_UPRIGHT',
      message: 'Please stand upright. Avoid bending or leaning forward.',
      severity: 'error',
    });
  }

  return { isUpright: errors.length === 0, errors };
}

// ─── Front vs Side view classification ───────────────────────────────────────

export interface ViewClassificationResult {
  detectedView: DetectedViewType;
  sideViewScore: number;       // 0–1 composite; 1 = perfectly side
  frontViewScore: number;      // 0–1 composite; 1 = perfectly front
  threeQuarterScore: number;   // 0–1 composite; 1 = strong 3/4 evidence
  shoulderXSpread: number;
  shoulderZDiff: number;
  hipXSpread: number;
  hipZDiff: number;
  shoulderWidthToTorsoHeightRatio: number;
  hipWidthToTorsoHeightRatio: number;
  errors: ValidationError[];
  warnings: ValidationError[];
}

export function classifyView(
  landmarks: NormalizedLandmark[],
  expectedView: ViewType,
  config: AppConfig
): ViewClassificationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const minVis = config.confidence.minLandmarkVisibility;
  const vc = config.viewClassification;

  const lShoulder = landmarks[LM.LEFT_SHOULDER];
  const rShoulder = landmarks[LM.RIGHT_SHOULDER];
  const lHip      = landmarks[LM.LEFT_HIP];
  const rHip      = landmarks[LM.RIGHT_HIP];
  const nose      = landmarks[LM.NOSE];
  const lEye      = landmarks[LM.LEFT_EYE];
  const rEye      = landmarks[LM.RIGHT_EYE];
  const lEar      = landmarks[LM.LEFT_EAR];
  const rEar      = landmarks[LM.RIGHT_EAR];
  const mouthL    = landmarks[LM.MOUTH_LEFT];
  const mouthR    = landmarks[LM.MOUTH_RIGHT];

  const hasShoulders = isVisible(lShoulder, minVis) && isVisible(rShoulder, minVis);
  const hasHips      = isVisible(lHip, minVis) && isVisible(rHip, minVis);

  if (!hasShoulders) {
    return {
      detectedView: 'unknown', sideViewScore: 0, frontViewScore: 0, threeQuarterScore: 0,
      shoulderXSpread: 0, shoulderZDiff: 0, hipXSpread: 0, hipZDiff: 0,
      shoulderWidthToTorsoHeightRatio: 0, hipWidthToTorsoHeightRatio: 0,
      errors, warnings,
    };
  }

  // ── Raw measurements ─────────────────────────────────────────────────────────
  const shoulderXSpread = Math.abs(lShoulder.x - rShoulder.x);
  const shoulderZDiff   = Math.abs((lShoulder.z ?? 0) - (rShoulder.z ?? 0));
  const hipXSpread      = hasHips ? Math.abs(lHip.x - rHip.x) : shoulderXSpread;
  const hipZDiff        = hasHips ? Math.abs((lHip.z ?? 0) - (rHip.z ?? 0)) : 0;
  const spreadRatio     = shoulderXSpread / Math.max(hipXSpread, 0.01);

  const shoulderMid = midpoint(lShoulder, rShoulder);
  const hipMid = hasHips ? midpoint(lHip, rHip) : null;
  const torsoHeight = hipMid ? Math.abs(hipMid.y - shoulderMid.y) : 0;
  const shoulderWidthToTorsoHeightRatio =
    torsoHeight > 0.01 ? shoulderXSpread / torsoHeight : 0;
  const hipWidthToTorsoHeightRatio =
    torsoHeight > 0.01 ? hipXSpread / torsoHeight : 0;

  // ── Composite side-view score (0–1) ──────────────────────────────────────────
  // Factors that increase side score:
  //   • Low shoulder X-spread (person is narrow)
  //   • High shoulder Z difference (depth asymmetry)
  // Score is a weighted blend of two signals.
  const sv = vc.sideView;
  const tq = vc.threeQuarter;
  const spreadSignal = Math.max(0, 1 - shoulderXSpread / Math.max(sv.maxShoulderXSpreadForSide * 2, 0.01));
  const zSignal      = Math.min(1, shoulderZDiff / Math.max(sv.minShoulderZDiff * 2, 0.01));
  const sideViewScore  = spreadSignal * 0.6 + zSignal * 0.4;

  // Front score is high only when the body is wide enough in X and depth symmetry
  // is good. A body can look wide in X but still be 3/4 if Z asymmetry is high.
  const frontDepthPenalty = Math.min(
    0.45,
    (shoulderZDiff / Math.max(tq.maxFrontShoulderZDiff, 0.01)) * 0.30 +
      (hipZDiff / Math.max(tq.maxFrontHipZDiff, 0.01)) * 0.15
  );
  const frontViewScore = Math.max(0, Math.min(1,
    (spreadRatio > vc.frontSymmetryMinRatio ? 0.55 : 0.2) +
      (shoulderXSpread > 0.10 ? 0.35 : 0) -
      frontDepthPenalty
  ));

  // ── Three-quarter score (0–1) ────────────────────────────────────────────────
  // A 3/4 photo usually has both shoulders visible horizontally, while one side
  // is clearly closer to camera in Z. This is different from a true side photo,
  // where the shoulder X-spread should become narrow.
  const shoulderDepthSignal = Math.min(1, shoulderZDiff / Math.max(tq.minShoulderZDiff, 0.01));
  const hipDepthSignal = hasHips ? Math.min(1, hipZDiff / Math.max(tq.minHipZDiff, 0.01)) : 0;
  const widthSignal = shoulderXSpread >= tq.minShoulderXSpread ? 1 : shoulderXSpread / Math.max(tq.minShoulderXSpread, 0.01);
  const notTrueSideSignal = shoulderXSpread > sv.maxShoulderXSpreadForSide ? 1 : 0;

  // Less sensitive than the previous version: shoulder Z alone should not be
  // enough to mark a normal front photo as 3/4. Hip depth and the overall score
  // must also support the rotation, except when shoulder depth is very strong.
  const threeQuarterScore = Math.min(
    1,
    shoulderDepthSignal * 0.40 + hipDepthSignal * 0.30 + widthSignal * 0.20 + notTrueSideSignal * 0.10
  );

  // ── Classification ────────────────────────────────────────────────────────────
  const isSideByZ = shoulderZDiff >= sv.minShoulderZDiff;

  // Absolute shoulder x-spread alone is not enough for side-view validation,
  // because a far-away 3/4 body can still have a small normalized x-spread.
  // These body-scale ratios catch clear 3/4 side poses without making the
  // side step too strict for small natural angle variations.
  const shoulderTooWideForSide =
    shoulderWidthToTorsoHeightRatio >= sv.maxShoulderWidthToTorsoHeightRatio;
  const hipTooWideForSide =
    hasHips && hipWidthToTorsoHeightRatio >= sv.maxHipWidthToTorsoHeightRatio;
  const clearlyTooWideForSide =
    shoulderTooWideForSide &&
    (hipTooWideForSide ||
      shoulderWidthToTorsoHeightRatio >= sv.maxShoulderWidthToTorsoHeightRatio * 1.25);

  const isSideBySpread =
    shoulderXSpread <= sv.maxShoulderXSpreadForSide && !clearlyTooWideForSide;
  const isFrontBySpread =
    shoulderXSpread > 0.10 && spreadRatio >= vc.frontSymmetryMinRatio;

  const frontDepthTooAsymmetric =
    shoulderZDiff >= tq.maxFrontShoulderZDiff ||
    (hasHips && hipZDiff >= tq.maxFrontHipZDiff);

  const hasShoulderDepth = shoulderZDiff >= tq.minShoulderZDiff;
  const hasHipDepth = hasHips && hipZDiff >= tq.minHipZDiff;
  const hasVeryStrongShoulderDepth = shoulderZDiff >= tq.minShoulderZDiff * 1.35;
  const hasReliableThreeQuarterDepth =
    (hasShoulderDepth && hasHipDepth) ||
    (hasVeryStrongShoulderDepth && (hasHipDepth || frontDepthTooAsymmetric));

  const isThreeQuarter =
    tq.enabled &&
    hasShoulders &&
    shoulderXSpread >= tq.minShoulderXSpread &&
    shoulderXSpread > sv.maxShoulderXSpreadForSide &&
    hasReliableThreeQuarterDepth &&
    threeQuarterScore >= tq.minThreeQuarterScore;

  // Extra front-step 3/4 guard. In clear front 3/4 photos, MediaPipe depth can
  // be too noisy to pass the Z-based rule above. Face/torso geometry is a more
  // direct signal: the face is shifted away from the shoulder center, one side
  // of the face is much more visible, or shoulder/hip centers are horizontally
  // offset.
  const faceMinVis = Math.max(0.20, config.frontPose.facing.minFaceLandmarkVisibility * 0.85);
  const hasNose = isVisible(nose, faceMinVis);
  const shoulderWidth = Math.max(shoulderXSpread, 0.01);
  const shoulderCenterX = shoulderMid.x;
  const noseOffsetRatio = hasNose ? Math.abs(nose.x - shoulderCenterX) / shoulderWidth : 0;

  const visibleFaceSidePoints = [lEye, rEye, lEar, rEar, mouthL, mouthR]
    .filter((p) => isVisible(p, faceMinVis));
  const faceCenterX = visibleFaceSidePoints.length > 0
    ? visibleFaceSidePoints.reduce((sum, p) => sum + p.x, 0) / visibleFaceSidePoints.length
    : (hasNose ? nose.x : shoulderCenterX);
  const faceCenterOffsetRatio = Math.abs(faceCenterX - shoulderCenterX) / shoulderWidth;

  const leftFaceVisibility = [lEye, lEar, mouthL].reduce((sum, p) => sum + (p?.visibility ?? 0), 0) / 3;
  const rightFaceVisibility = [rEye, rEar, mouthR].reduce((sum, p) => sum + (p?.visibility ?? 0), 0) / 3;
  const faceSideVisibilityAsymmetry = Math.abs(leftFaceVisibility - rightFaceVisibility);
  const torsoCenterOffsetRatio = hipMid
    ? Math.abs(shoulderMid.x - hipMid.x) / shoulderWidth
    : 0;

  const noseOffsetSignal = noseOffsetRatio > tq.maxFrontNoseShoulderCenterOffsetRatio;
  const faceCenterOffsetSignal = faceCenterOffsetRatio > tq.maxFrontFaceCenterOffsetRatio;
  const faceAsymmetrySignal =
    faceSideVisibilityAsymmetry > tq.minFrontFaceSideVisibilityAsymmetry &&
    (noseOffsetRatio > 0.08 || faceCenterOffsetRatio > 0.08);
  const torsoOffsetSignal =
    torsoCenterOffsetRatio > tq.maxFrontTorsoCenterOffsetRatio &&
    (noseOffsetRatio > 0.08 || faceCenterOffsetRatio > 0.08 || faceSideVisibilityAsymmetry > tq.minFrontFaceSideVisibilityAsymmetry * 0.80);

  const frontThreeQuarterSignals = [
    noseOffsetSignal,
    faceCenterOffsetSignal,
    faceAsymmetrySignal,
    torsoOffsetSignal,
  ].filter(Boolean).length;

  const strongFrontThreeQuarterSignal =
    noseOffsetRatio > tq.maxFrontNoseShoulderCenterOffsetRatio * 1.45 ||
    faceCenterOffsetRatio > tq.maxFrontFaceCenterOffsetRatio * 1.45 ||
    (faceSideVisibilityAsymmetry > tq.minFrontFaceSideVisibilityAsymmetry * 1.45 && (noseOffsetRatio > 0.07 || faceCenterOffsetRatio > 0.07)) ||
    (torsoCenterOffsetRatio > tq.maxFrontTorsoCenterOffsetRatio * 1.35 && (noseOffsetRatio > 0.07 || faceCenterOffsetRatio > 0.07));

  const isFrontStepThreeQuarter =
    expectedView === 'front' &&
    tq.enabled &&
    hasShoulders &&
    hasNose &&
    shoulderXSpread >= tq.minShoulderXSpread &&
    (frontThreeQuarterSignals >= 2 || (strongFrontThreeQuarterSignal && frontThreeQuarterSignals >= 1));

  // Extra guard for the side step only. It is intentionally weaker than the
  // front-step 3/4 rule: it blocks clear 3/4 side photos, but it does not reject
  // a true side profile for tiny shoulder/hip jitter.
  const isSideStepThreeQuarter =
    expectedView === 'side' &&
    tq.enabled &&
    clearlyTooWideForSide &&
    sideViewScore >= sv.warningSideViewScore &&
    shoulderZDiff >= sv.minShoulderZDiff * 0.65;

  let detectedView: DetectedViewType;
  if (isThreeQuarter || isSideStepThreeQuarter || isFrontStepThreeQuarter) {
    detectedView = 'threeQuarter';
  } else if (isSideByZ && isSideBySpread && sideViewScore >= sv.minSideViewScore) {
    detectedView = 'side';
  } else if (isFrontBySpread && !frontDepthTooAsymmetric) {
    detectedView = 'front';
  } else {
    detectedView = 'unknown';
  }

  // ── Validate expected vs detected ─────────────────────────────────────────────
  if (expectedView === 'side') {
    if (detectedView === 'front') {
      errors.push({
        code: 'WRONG_VIEW_FRONT_FOR_SIDE',
        message: 'This looks like a front-view photo. Please turn sideways for the side photo.',
        severity: 'error',
      });
    } else if (detectedView === 'threeQuarter') {
      errors.push({
        code: 'THREE_QUARTER_VIEW',
        message: 'Three-quarter photos are not accepted. Turn fully sideways for the side photo.',
        severity: 'error',
      });
    } else if (sideViewScore < sv.minSideViewScore || !isSideBySpread) {
      // Clear 3/4 and weak-side photos are blocked. A very tiny natural angle can
      // still pass when the shoulder X-spread is narrow and the side score is high.
      errors.push({
        code: 'NOT_SIDE_VIEW',
        message: 'Please turn fully sideways. The camera should see a clear side profile, not a three-quarter angle.',
        severity: 'error',
      });
    }
  } else {
    // Expected front
    if (detectedView === 'side') {
      errors.push({
        code: 'WRONG_VIEW_SIDE_FOR_FRONT',
        message: 'This looks like a side-view photo. Please face the camera directly for the front photo.',
        severity: 'error',
      });
    } else if (detectedView === 'threeQuarter') {
      errors.push({
        code: 'THREE_QUARTER_VIEW',
        message: 'Three-quarter photos are not accepted. Face the camera directly for the front photo.',
        severity: 'error',
      });
    }

    // Both shoulders should be visible for front view
    if (!hasShoulders) {
      errors.push({
        code: 'FRONT_SHOULDERS_NOT_VISIBLE',
        message: 'Please face the camera directly. Both shoulders should be visible.',
        severity: 'error',
      });
    }
  }

  return {
    detectedView,
    sideViewScore,
    frontViewScore,
    threeQuarterScore,
    shoulderXSpread,
    shoulderZDiff,
    hipXSpread,
    hipZDiff,
    shoulderWidthToTorsoHeightRatio,
    hipWidthToTorsoHeightRatio,
    errors: dedupeValidationItems(errors),
    warnings,
  };
}


function dedupeValidationItems(items: ValidationError[]): ValidationError[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.code)) return false;
    seen.add(item.code);
    return true;
  });
}
