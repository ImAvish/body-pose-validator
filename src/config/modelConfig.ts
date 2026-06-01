import type { ModelConfig } from '../types/models';

/**
 * MODEL CONFIGURATION
 * -------------------
 * By default all models are loaded from /public/models/ (served as static assets).
 * After placing your model files in public/models/, no internet access is required.
 *
 * To use a custom model:
 *  1. Place your .task file in public/models/
 *  2. Set useCustomPoseModel: true
 *  3. Set customPoseModelUrl to the file's public path, e.g. '/models/my_pose.task'
 */
export const modelConfig: ModelConfig = {
  // MediaPipe Pose Landmarker FULL model (best accuracy, ~6 MB)
  // Download from: https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task
  // Place at: public/models/pose_landmarker_full.task
  poseLandmarkerModelPath: '/models/pose_landmarker_full.task',

  useCustomPoseModel: false,
  // customPoseModelUrl: '/models/my_custom_pose.task',
};
