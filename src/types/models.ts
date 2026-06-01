// ─── Model & App Configuration Types ─────────────────────────────────────────
// Edit thresholds ONLY in src/config/validationConfig.ts — never here.
// This file defines the shape; validationConfig.ts defines the values.

export interface ModelConfig {
  poseLandmarkerModelPath: string;
  useCustomPoseModel: boolean;
  customPoseModelUrl?: string;
  customPersonDetectorUrl?: string;
  customViewClassifierUrl?: string;
}

export interface ConfidenceThresholds {
  minLandmarkVisibility: number;
  minBodyVisibilityScore: number;
  minPoseConfidence: number;
}

export interface BacklightThresholds {
  enabled: boolean;
  maxBackgroundToPersonRatio: number;
  minBackgroundMinusPersonDelta: number;
  maxDarkPersonPixelRatio: number;
  minPersonLuminance: number;
  requireSceneBrightnessBelow: number;
}

export interface LightingThresholds {
  minBrightness: number;
  maxBrightness: number;
  maxOverexposedRatio: number;
  backlight: BacklightThresholds;
}

export interface TiltThresholds {
  warningTiltDeg: number;
  maxShoulderTiltDeg: number;
  maxHipLineTiltDeg: number;
  maxBodyAxisDeviationDeg: number;
}

export interface CameraSensorPitchThresholds {
  enabled: boolean;
  useSensorWhenAvailable: boolean;

  /** Target sensor pitch. 90° should mean camera level/straight. */
  targetPitchDeg: number;

  /** Warning/error tolerance around targetPitchDeg. */
  warningToleranceDeg: number;
  errorToleranceDeg: number;

  /** Accepted absolute sensor pitch range. Kept for compatibility/debug. */
  minPitchDeg: number;
  maxPitchDeg: number;
  warningMinPitchDeg: number;
  warningMaxPitchDeg: number;

  /** Exponential smoothing for sensor pitch, 0..1. Lower = smoother. */
  smoothingAlpha: number;

  maxReadingAgeMs: number;

  /**
   * When the real device sensor is available, still run a strong image-based
   * guard in realtime to catch bad camera placement, such as the phone being
   * on the floor. This should be a coarse guard, not the main pitch source.
   */
  useImagePitchGuardWhenSensorAvailable: boolean;
  imagePitchGuardMinScoreWhenSensorAvailable: number;

  fallbackToPoseWhenUnavailable: boolean;
  /** Set true if native bridge/browser reports the high/low direction reversed. */
  invertPitchDirection: boolean;
}

export interface CameraPitchThresholds {
  enabled: boolean;

  /**
   * Image-based estimated camera angle range.
   * 90° means roughly level/straight. < min is too high/top-down;
   * > max is too low/bottom-up.
   */
  minCameraPitchAngleDeg: number;
  maxCameraPitchAngleDeg: number;
  levelCameraPitchAngleDeg: number;

  /**
   * Perspective guard based on vertical body proportions.
   * Very small leg/torso ratio usually means the camera is too high
   * and looking down. Very large ratio usually means the camera is too low
   * and looking up.
   */
  minLegToTorsoRatio: number;
  maxLegToTorsoRatio: number;
  warningMinLegToTorsoRatio: number;
  warningMaxLegToTorsoRatio: number;

  /**
   * MediaPipe z-axis guard. Negative delta means upper body is closer
   * to the camera; positive delta means lower body is closer.
   */
  maxUpperBodyCloserZDelta: number;
  maxLowerBodyCloserZDelta: number;

  /**
   * Front-view width perspective guard.
   * For side view this signal is ignored because shoulder/hip widths are narrow.
   */
  minShoulderToHipWidthRatio: number;
  maxShoulderToHipWidthRatio: number;

  /**
   * High camera / top-down guard based on framing.
   * When the phone is held too high, the head/body often sits lower in the
   * frame and there is more space above the person than below the feet.
   */
  minHeadYForHighAngle: number;
  minTopToBottomSpaceRatioForHighAngle: number;
  maxPersonHeightRatioForHighAngle: number;

  /**
   * Low camera / bottom-up guard based on framing.
   * When the phone is very low, the feet often sit too high in the frame and
   * there is too much foreground floor below the body. This is a supporting
   * signal for CAMERA_TOO_LOW and helps catch bottom-up photos that body-ratio
   * geometry alone misses.
   */
  maxAnkleYForLowAngle: number;
  maxAnkleYForStrongLowAngle: number;
  minFloorBelowFeetRatioForStrongLowAngle: number;
  minLegToTorsoRatioForLowAngle: number;
  minPersonHeightRatioForLowAngle: number;

  /** Full-body bottom-up guard for cases where the person fills the frame. */
  maxHeadYForLowAngleFullBody: number;
  minAnkleYForLowAngleFullBody: number;
  minPersonHeightRatioForLowAngleFullBody: number;
  minLegToTorsoRatioForLowAngleFullBody: number;
  minAnkleToShoulderWidthRatioForLowAngleFullBody: number;
  minLowerFootToShoulderWidthRatioForLowAngleFullBody: number;
  minFootLengthToTorsoRatioForLowAngleFullBody: number;

  /** Simple view-agnostic camera-height guards. */
  simpleHighMaxLegToTorsoRatio: number;
  simpleHighMaxPersonHeightRatio: number;
  simpleHighMinShoulderToHipWidthRatio: number;

  simpleLowMinPersonHeightRatio: number;
  simpleLowMaxHeadY: number;
  simpleLowMinLegToTorsoRatio: number;
  simpleLowMinAnkleToShoulderWidthRatio: number;
  simpleLowMinLowerFootToShoulderWidthRatio: number;
  simpleLowMinFootLengthToTorsoRatio: number;

  /** Side-view top-down guard. Side view uses weaker width cues, so it has its own frame thresholds. */
  sideHighMinHeadY: number;
  sideHighMinTopToBottomSpaceRatio: number;
  sideHighMaxPersonHeightRatio: number;
  sideHighMinPitchScore: number;

  /** Side-view bottom-up guard. Blocks low phone angle without making normal side photos too strict. */
  sideLowMaxAnkleY: number;
  sideLowMinFloorBelowFeetRatio: number;
  sideLowMinPersonHeightRatio: number;
  sideLowMaxPersonHeightRatio: number;
  sideLowMinPitchScore: number;

  /**
   * Error is raised when this many signals agree, unless one signal is extreme.
   */
  minPitchEvidenceForError: number;
  strongSingleSignalMultiplier: number;
}

export interface FramingThresholds {
  minPersonHeightRatio: number;
  maxPersonHeightRatio: number;
  maxCenterOffsetRatio: number;
}

export interface SideViewThresholds {
  sideNarrownessMaxRatio: number;
  maxShoulderXSpreadForSide: number;

  /**
   * Extra side-view guard normalized by body scale.
   * MediaPipe x values are frame-normalized, so an absolute shoulder x-spread can
   * be small when the person is far from the camera. These ratios compare the
   * left/right shoulder and hip spreads with torso height, making strong 3/4
   * side photos easier to reject without making true side photos too sensitive.
   */
  maxShoulderWidthToTorsoHeightRatio: number;
  maxHipWidthToTorsoHeightRatio: number;

  minShoulderZDiff: number;
  minSideViewScore: number;
  allowSlightThreeQuarter: boolean;
  warningSideViewScore: number;
}

export interface ThreeQuarterViewThresholds {
  enabled: boolean;
  minShoulderXSpread: number;
  minShoulderZDiff: number;
  minHipZDiff: number;
  minThreeQuarterScore: number;
  maxFrontShoulderZDiff: number;
  maxFrontHipZDiff: number;
  maxFrontNoseShoulderCenterOffsetRatio: number;
  maxFrontFaceCenterOffsetRatio: number;
  minFrontFaceSideVisibilityAsymmetry: number;
  maxFrontTorsoCenterOffsetRatio: number;
}

export interface ViewClassificationThresholds {
  frontSymmetryMinRatio: number;
  sideView: SideViewThresholds;
  threeQuarter: ThreeQuarterViewThresholds;
}

export interface ArmOpeningThresholds {
  enabled: boolean;
  minWristToHipWidthRatio: number;
  maxWristToHipWidthRatio: number;
  minElbowToTorsoRatio: number;
  minWristOutsideTorsoRatio: number;
  minElbowOutsideTorsoRatio: number;
  requireWristsBelowElbows: boolean;

  /**
   * Blocks front-view hand-on-waist / bent-arm poses.
   * Used only when wrist + elbow + shoulder + hips are visible.
   */
  maxHandOnWaistElbowAngleDeg: number;
  maxHandOnWaistWristHipDistanceRatio: number;
  maxHandOnWaistWristInsideTorsoMarginRatio: number;
}

export interface LegOpeningThresholds {
  enabled: boolean;
  minAnkleToHipWidthRatio: number;
  maxAnkleToHipWidthRatio: number;
}


export interface FrontFacingThresholds {
  enabled: boolean;
  minFaceLandmarkVisibility: number;
  minVisibleFaceLandmarks: number;
  minFaceVisibilityScore: number;
  maxNoseShoulderCenterOffsetRatio: number;
  minFacePairWidthToShoulderRatio: number;
  requireFrontBodyLeftRightOrder: boolean;
  minFrontBodyOrderXSpread: number;
  requireNoseAboveShoulders: boolean;
}

export interface FrontPoseThresholds {
  facing: FrontFacingThresholds;
  armOpening: ArmOpeningThresholds;
  legOpening: LegOpeningThresholds;
}

export interface SideProfileArmThresholds {
  enabled: boolean;
  minVisibleArmLandmarks: number;
  minWristTorsoGapRatio: number;
  maxWristTorsoGapRatio: number;
  maxWristAboveHipRatio: number;
  requireWristBelowElbow: boolean;
}

export interface SideProfileFootThresholds {
  enabled: boolean;
  minVisibleFootLandmarks: number;
  maxAnkleXSpreadRatio: number;
}

export interface SideProfileLegThresholds {
  enabled: boolean;

  /** Knee angle below this means the leg is visibly bent. */
  minKneeAngleDeg: number;

  /** An ankle must be clearly below its knee in a normal standing side photo. */
  minKneeToAnkleDropRatio: number;

  /** Left/right ankle height difference above this means one leg is lifted. */
  maxAnkleYDiffRatio: number;

  /** Left/right knee height difference above this means one leg is lifted/bent. */
  maxKneeYDiffRatio: number;

  /** A knee too far from the torso line usually means the leg is not beside the body. */
  maxKneeTorsoGapRatio: number;

  /** An ankle too far from the torso line usually means the leg is not beside the body. */
  maxAnkleTorsoGapRatio: number;
}

export interface SidePoseThresholds {
  arm: SideProfileArmThresholds;
  feet: SideProfileFootThresholds;
  leg: SideProfileLegThresholds;
}

export interface RealtimeThresholds {
  /** How often the hook runs a live MediaPipe analysis pass. */
  intervalMs: number;

  /** How many stable good passes are required before auto capture. */
  autoCaptureFrames: number;

  /** Minimum repeated error passes before switching the visible status to red. */
  errorStableFrames: number;

  /** Minimum repeated good passes before switching the visible status to green. */
  okStableFrames: number;

  /** Maximum time to keep the old visible status before showing the newest analysis. */
  statusRefreshMs: number;

  /** Exponential smoothing amount for landmark movement in realtime. */
  landmarkSmoothingAlpha: number;
}

export interface ModuleEnableFlags {
  personCount: boolean;
  fullBodyVisibility: boolean;
  standingPose: boolean;
  viewType: boolean;
  lighting: boolean;
  cameraTilt: boolean;
  cameraSensorPitch: boolean;
  cameraPitch: boolean;
  framing: boolean;
  frontPoseOpening: boolean;
  sideProfilePose: boolean;
  frontFacing: boolean;
  debugOverlay: boolean;
}

export interface AppConfig {
  model: ModelConfig;
  confidence: ConfidenceThresholds;
  lighting: LightingThresholds;
  tilt: TiltThresholds;
  cameraSensorPitch: CameraSensorPitchThresholds;
  cameraPitch: CameraPitchThresholds;
  framing: FramingThresholds;
  viewClassification: ViewClassificationThresholds;
  frontPose: FrontPoseThresholds;
  sidePose: SidePoseThresholds;
  realtime: RealtimeThresholds;
  modules: ModuleEnableFlags;
  poseInferenceSize: number;
}
