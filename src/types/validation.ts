// ─── Validation Types ─────────────────────────────────────────────────────────

export type ViewType = 'front' | 'side';
export type DetectedViewType = ViewType | 'unknown' | 'threeQuarter';
export type AppStep = 'front' | 'side' | 'done';
export type ErrorSeverity = 'error' | 'warning';

export interface ValidationError {
  code: string;
  message: string;
  severity: ErrorSeverity;
}

export interface ValidationMetrics {
  personCount: number;
  poseConfidence: number;
  brightness: number;           // 0–255 average luminance
  overexposedRatio: number;     // fraction of pixels > 245
  tiltAngle: number;            // shoulder line tilt in degrees
  bodyVerticalAngle: number;    // body axis lean in degrees
  bodyVisibilityScore: number;  // 0–1 key-landmark coverage
  framingScore: number;         // 0–1
  detectedView: DetectedViewType;
  personBboxRatio: number;      // person height / frame height
  centerOffsetRatio: number;    // person center offset from frame center

  // Extended metrics for debugging and threshold tuning
  sideViewScore?: number;
  frontViewScore?: number;
  faceVisibilityScore?: number;
  visibleFaceLandmarks?: number;
  wristToHipWidthRatio?: number;
  ankleToHipWidthRatio?: number;
  wristOutsideTorsoRatio?: number;
  elbowOutsideTorsoRatio?: number;
  sideWristTorsoGapRatio?: number;
  sideAnkleXSpreadRatio?: number;
  personLuminance?: number | null;
  backgroundLuminance?: number | null;
  shoulderZDiff?: number;
  shoulderXSpread?: number;
  hipZDiff?: number;
  hipXSpread?: number;
  shoulderWidthToTorsoHeightRatio?: number;
  hipWidthToTorsoHeightRatio?: number;
  threeQuarterScore?: number;
  cameraPitchDirection?: 'level' | 'tooHigh' | 'tooLow' | 'unknown';
  cameraPitchScore?: number;
  deviceCameraPitchDeg?: number;
  deviceCameraPitchSource?: 'native' | 'web' | 'none';
  estimatedCameraPitchAngleDeg?: number;
  legToTorsoRatio?: number;
  shoulderToHipWidthRatio?: number;
  upperLowerZDelta?: number;
  ankleYForPitch?: number;
  lowAngleFrameScore?: number;
}

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
  metrics: ValidationMetrics;
  debug?: {
    landmarks: NormalizedLandmark[];
    boundingBox?: BoundingBox;
  };
}

export interface NormalizedLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ValidateBodyPhotoArgs {
  image: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;
  expectedView: ViewType;
  config?: Partial<import('./models').AppConfig>;
}
