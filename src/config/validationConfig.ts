/**
 * validationConfig.ts
 *
 * Single source of truth for all validation thresholds.
 *
 * Important files:
 * - Camera roll/pitch sensitivity:  src/services/tiltValidation.ts
 * - Front/side/three-quarter detection: src/services/viewValidation.ts
 * - Front arm/feet opening:         src/services/poseValidation.ts
 * - Side profile arm/feet posture:  src/services/poseValidation.ts
 * - Realtime validation:            src/hooks/useRealtimeValidation.ts
 * - Gallery image validation:       src/App.tsx → handleGalleryUpload() → validateBodyPhoto()
 */

import type { AppConfig } from '../types/models';
import { modelConfig } from './modelConfig';

export const defaultConfig: AppConfig = {
  model: modelConfig,

  // ── Landmark / pose confidence ────────────────────────────────────────────
  confidence: {
    minLandmarkVisibility: 0.45,
    minBodyVisibilityScore: 0.65,
    minPoseConfidence: 0.4,
  },

  // ── Lighting ──────────────────────────────────────────────────────────────
  lighting: {
    minBrightness: 50,
    maxBrightness: 220,
    maxOverexposedRatio: 0.12,
    backlight: {
      enabled: true,
      maxBackgroundToPersonRatio: 1.35,
      minBackgroundMinusPersonDelta: 35,
      maxDarkPersonPixelRatio: 0.24,
      minPersonLuminance: 45,
      requireSceneBrightnessBelow: 130,
    },
  },

  // ── Camera / body tilt ────────────────────────────────────────────────────
  // Error is raised only when at least two tilt signals agree, so these values
  // are medium-sensitive: small natural tilt is accepted, visible skew is blocked.
  tilt: {
    warningTiltDeg: 7,
    maxShoulderTiltDeg: 11,
    maxHipLineTiltDeg: 11,
    maxBodyAxisDeviationDeg: 9,
  },

  // ── Device sensor camera pitch ───────────────────────────────────────────
  // Preferred for live camera. The target is 90°: the phone/camera is roughly
  // level with the user's body. A tolerance band is used so normal hand tremor
  // does not instantly turn the UI red. If unavailable, the app falls back to
  // image-based cameraPitch below.
  cameraSensorPitch: {
    enabled: true,
    useSensorWhenAvailable: true,

    // Main sensor rule: aim for 90°.
    targetPitchDeg: 90,
    warningToleranceDeg: 7,
    errorToleranceDeg: 12,

    // Keep these derived ranges for backward compatibility/debug display.
    minPitchDeg: 78,
    maxPitchDeg: 102,
    warningMinPitchDeg: 83,
    warningMaxPitchDeg: 97,

    // Smoothing avoids quick red/green flicker from small hand shake.
    smoothingAlpha: 0.22,
    maxReadingAgeMs: 1500,

    // Sensor controls the actual up/down tilt. This image guard runs in realtime
    // as an extra camera-height check: table-height photos can pass, but clear
    // floor-level / very high-angle views are blocked before capture.
    useImagePitchGuardWhenSensorAvailable: true,
    imagePitchGuardMinScoreWhenSensorAvailable: 1,

    fallbackToPoseWhenUnavailable: true,
    invertPitchDirection: false,
  },

  // ── Camera pitch / perspective ───────────────────────────────────────────
  // Blocks only clear top-down and bottom-up shots.
  // This version is intentionally less sensitive: normal straight photos should
  // not be rejected because of body-shape differences or noisy MediaPipe Z values.
  cameraPitch: {
    enabled: true,

    // Estimated camera angle relative to the user. 90° means the camera is
    // roughly straight/level with the body. Values below min mean top-down;
    // values above max mean bottom-up. The range is intentionally
    // a little wider than before so normal chest-height photos are easier to capture. This is an image-based estimate, not a
    // real sensor angle, but it gives one clear rule for blocking pitch errors.
    minCameraPitchAngleDeg: 68,
    maxCameraPitchAngleDeg: 108,
    levelCameraPitchAngleDeg: 90,

    // Low value = legs look too short compared with torso → camera too high.
    // High value = legs look too long compared with torso → camera too low.
    // These ranges are wider than the previous version to avoid false errors
    // on normal straight photos.
    // Top-down was causing false errors on level photos, so the high-angle
    // side is intentionally stricter. Bottom-up is handled by both body-ratio
    // and framing signals below.
    minLegToTorsoRatio: 0.60,
    maxLegToTorsoRatio: 2.65,
    warningMinLegToTorsoRatio: 0.72,
    warningMaxLegToTorsoRatio: 2.10,

    // z delta: upperZ - lowerZ. Negative means upper body is closer; positive
    // means lower body is closer. MediaPipe Z is noisy, so these thresholds are
    // deliberately loose and used only as supporting evidence.
    // Bottom-up photos need slightly stronger detection than top-down photos,
    // so the lower-body threshold is a bit tighter.
    maxUpperBodyCloserZDelta: 0.65,
    maxLowerBodyCloserZDelta: 0.28,

    // Width perspective is strongest in front view. In side view the body is
    // naturally narrow, so width cues are weaker and pitchValidation.ts relies
    // more on framing / estimated pitch score to keep side-view behavior close
    // to front-view behavior.
    minShoulderToHipWidthRatio: 0.65,
    maxShoulderToHipWidthRatio: 2.35,

    // Top-down framing signal. When the phone is held high and pointed down,
    // the person often sits low in the frame with too much space above the head.
    // This is used only as supporting evidence for CAMERA_TOO_HIGH, so normal
    // level photos with small framing differences are not blocked.
    minHeadYForHighAngle: 0.34,
    minTopToBottomSpaceRatioForHighAngle: 1.85,
    maxPersonHeightRatioForHighAngle: 0.58,

    // Bottom-up framing signal. In low-angle photos there is usually too much
    // foreground floor and the ankle midpoint is not close enough to the bottom
    // of the frame. Side-view uses this signal more strongly because width
    // perspective is naturally weak in a true side profile.
    // of the frame. This catches the sample where pure leg/torso ratio was not
    // enough. Increase maxAnkleYForLowAngle to be stricter, decrease it to be
    // more tolerant.
    maxAnkleYForLowAngle: 0.82,
    maxAnkleYForStrongLowAngle: 0.72,
    minFloorBelowFeetRatioForStrongLowAngle: 0.24,
    minLegToTorsoRatioForLowAngle: 1.25,
    minPersonHeightRatioForLowAngle: 0.30,

    // Full-body bottom-up guard. This catches low-angle photos where the whole
    // body still fits in the frame, so the previous floor-below-feet rule is not
    // enough. It is scale-normalized and requires perspective support, so it is
    // not tuned to one person's height/body shape.
    maxHeadYForLowAngleFullBody: 0.38,
    minAnkleYForLowAngleFullBody: 0.70,
    minPersonHeightRatioForLowAngleFullBody: 0.48,
    minLegToTorsoRatioForLowAngleFullBody: 1.12,
    minAnkleToShoulderWidthRatioForLowAngleFullBody: 0.48,
    minLowerFootToShoulderWidthRatioForLowAngleFullBody: 0.92,
    minFootLengthToTorsoRatioForLowAngleFullBody: 0.20,

    // Simple camera-height guards. These are intentionally view-agnostic and
    // are used before the older score-based rules. They block only clear
    // top-down / bottom-up perspective by requiring a body-proportion trigger
    // plus supporting evidence, so they work across different heights/body types.
    simpleHighMaxLegToTorsoRatio: 1.18,
    simpleHighMaxPersonHeightRatio: 0.68,
    simpleHighMinShoulderToHipWidthRatio: 1.05,

    simpleLowMinPersonHeightRatio: 0.45,
    simpleLowMaxHeadY: 0.45,
    simpleLowMinLegToTorsoRatio: 1.85,
    simpleLowMinAnkleToShoulderWidthRatio: 0.52,
    simpleLowMinLowerFootToShoulderWidthRatio: 0.70,
    simpleLowMinFootLengthToTorsoRatio: 0.14,

    // Legacy side-specific pitch thresholds. They are kept in the config for
    // compatibility, but tiltValidation.ts now uses the same CAMERA_TOO_HIGH /
    // CAMERA_TOO_LOW sensitivity for front and side views.
    sideHighMinHeadY: 0.42,
    sideHighMinTopToBottomSpaceRatio: 2.10,
    sideHighMaxPersonHeightRatio: 0.52,
    sideHighMinPitchScore: 0.68,

    sideLowMaxAnkleY: 0.78,
    sideLowMinFloorBelowFeetRatio: 0.24,
    sideLowMinPersonHeightRatio: 0.28,
    sideLowMaxPersonHeightRatio: 0.62,
    sideLowMinPitchScore: 0.68,

    minPitchEvidenceForError: 2,
    strongSingleSignalMultiplier: 1.80,
  },

  // ── Framing / distance ────────────────────────────────────────────────────
  framing: {
    minPersonHeightRatio: 0.38,
    maxPersonHeightRatio: 1.0,
    maxCenterOffsetRatio: 0.65,
  },

  // ── View classification ───────────────────────────────────────────────────
  // Front photo target: camera sees the body directly from the front.
  // Side photo target: camera sees a true side profile.
  // Three-quarter views are blocked in both steps, but the thresholds are
  // intentionally relaxed so normal front-view users are not rejected because
  // of tiny natural shoulder/hip depth jitter from MediaPipe.
  viewClassification: {
    frontSymmetryMinRatio: 0.55,
    sideView: {
      sideNarrownessMaxRatio: 0.50,
      maxShoulderXSpreadForSide: 0.14,

      // Side-step 3/4 guard normalized by torso height.
      // This catches clear 3/4 side photos even when the person is far from the
      // camera and the absolute shoulder x-spread looks small. Values are still
      // relaxed, so a small natural angle in a real side profile is accepted.
      maxShoulderWidthToTorsoHeightRatio: 0.38,
      maxHipWidthToTorsoHeightRatio: 0.34,

      minShoulderZDiff: 0.06,
      minSideViewScore: 0.54,
      allowSlightThreeQuarter: false,
      warningSideViewScore: 0.24,
    },
    threeQuarter: {
      enabled: true,

      // 3/4 usually keeps both shoulders visible in X, but one shoulder/hip is
      // clearly closer to the camera in Z. These values are relaxed compared
      // with the previous version to avoid false 3/4 errors on normal front photos.
      minShoulderXSpread: 0.12,
      minShoulderZDiff: 0.075,
      minHipZDiff: 0.060,
      minThreeQuarterScore: 0.62,

      // Front photos are not rejected by these values alone anymore. They only
      // contribute to the 3/4 score, so small MediaPipe Z jitter is accepted.
      maxFrontShoulderZDiff: 0.100,
      maxFrontHipZDiff: 0.090,

      // Extra front-step 3/4 guards. MediaPipe Z can miss clear 3/4 front
      // photos, so also check whether the face/head is shifted away from the
      // shoulder center or one side of the face is much more visible.
      maxFrontNoseShoulderCenterOffsetRatio: 0.13,
      maxFrontFaceCenterOffsetRatio: 0.12,
      minFrontFaceSideVisibilityAsymmetry: 0.26,
      maxFrontTorsoCenterOffsetRatio: 0.15,
    },
  },

  // ── Front-view pose opening ───────────────────────────────────────────────
  // Front photo target: arms are open from the body and feet are slightly apart.
  // The ranges are intentionally not too strict, but glued arms/feet are errors.
  frontPose: {
    facing: {
      enabled: true,

      // Front photo must show the user's face/eyes. If the person is standing
      // with their back to the camera, these face landmarks become missing or
      // very low-confidence. Thresholds are intentionally moderate so normal
      // full-body photos are accepted while clear back-facing photos are blocked.
      minFaceLandmarkVisibility: 0.30,
      minVisibleFaceLandmarks: 4,
      minFaceVisibilityScore: 0.30,
      maxNoseShoulderCenterOffsetRatio: 0.38,
      minFacePairWidthToShoulderRatio: 0.08,

      // Anatomical left/right body order check for front photos.
      // In a true front-facing photo, the person's LEFT shoulder/hip usually
      // appears on the viewer's RIGHT side of the image. In a back-facing photo,
      // that order flips. This catches back photos even when MediaPipe
      // hallucinates weak face landmarks on the back of the head.
      requireFrontBodyLeftRightOrder: true,
      minFrontBodyOrderXSpread: 0.05,

      requireNoseAboveShoulders: true,
    },

    armOpening: {
      enabled: true,

      // Total wrist span relative to hip width. Low = arms close to body.
      minWristToHipWidthRatio: 1.45,
      maxWristToHipWidthRatio: 4,

      // Average elbow distance from torso centerline relative to shoulder width.
      minElbowToTorsoRatio: 0.42,

      // Per-side clearance outside the torso box relative to torso width.
      minWristOutsideTorsoRatio: 0.12,
      minElbowOutsideTorsoRatio: 0.05,

      // Blocks raised/bent arms where wrists are above elbows.
      requireWristsBelowElbows: true,

      // Blocks hand-on-waist / bent-arm poses in front view.
      // A valid front photo should keep both arms down and slightly away from the body.
      maxHandOnWaistElbowAngleDeg: 145,
      maxHandOnWaistWristHipDistanceRatio: 0.24,
      maxHandOnWaistWristInsideTorsoMarginRatio: 0.22,
    },

    legOpening: {
      enabled: true,

      // Foot/ankle horizontal spread relative to hip width.
      minAnkleToHipWidthRatio: 0.65,
      maxAnkleToHipWidthRatio: 2.20,
    },
  },

  // ── Side-profile pose ─────────────────────────────────────────────────────
  // Side photo target: true profile, arm visible beside body and arm down.
  // Foot visibility is intentionally not a blocking rule for side photos.
  sidePose: {
    arm: {
      enabled: true,
      minVisibleArmLandmarks: 2,
      minWristTorsoGapRatio: 0.012,
      maxWristTorsoGapRatio: 0.18,
      maxWristAboveHipRatio: 0.05,
      requireWristBelowElbow: true,
    },
    feet: {
      // Disabled by request: do not show/block with
      // "Both feet must be visible in the side photo."
      // General full-body/framing validation can still catch obviously cropped photos.
      enabled: false,
      minVisibleFootLandmarks: 4,
      maxAnkleXSpreadRatio: 0.22,
    },
    leg: {
      // Side photo target: both legs stay straight/natural beside the body.
      // This blocks bent/lifted legs like standing on one leg, foot behind body,
      // walking pose, or any leg position not beside the body.
      enabled: true,
      minKneeAngleDeg: 155,
      minKneeToAnkleDropRatio: 0.16,
      maxAnkleYDiffRatio: 0.10,
      maxKneeYDiffRatio: 0.12,
      maxKneeTorsoGapRatio: 0.24,
      maxAnkleTorsoGapRatio: 0.32,
    },
  },

  // ── Real-time preview validation ──────────────────────────────────────────
  realtime: {
    // Run live validation repeatedly, but do not change the visible status on
    // every noisy frame. The visible hint is refreshed at most around every
    // 3 seconds unless the same result becomes stable sooner.
    // Live pose overlay should react quickly when the phone moves.
    // 300ms gives near-real-time feedback, while 7 stable good frames keep
    // auto capture close to 2 seconds: 300ms × 7 ≈ 2.1s.
    intervalMs: 300,
    autoCaptureFrames: 7,
    errorStableFrames: 2,
    okStableFrames: 2,
    statusRefreshMs: 1200,
    landmarkSmoothingAlpha: 0.25,
  },

  // ── Module switches ───────────────────────────────────────────────────────
  modules: {
    personCount: true,
    fullBodyVisibility: true,
    standingPose: true,
    viewType: true,
    lighting: true,
    cameraTilt: true,
    cameraSensorPitch: true,
    cameraPitch: true,
    framing: true,
    frontPoseOpening: true,
    sideProfilePose: true,
    frontFacing: true,
    debugOverlay: false,
  },

  poseInferenceSize: 640,
};
