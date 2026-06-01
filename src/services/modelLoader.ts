/**
 * modelLoader.ts
 * Singleton loader for MediaPipe PoseLandmarker.
 *
 * WHY MediaPipe Tasks Vision / PoseLandmarker?
 * ─────────────────────────────────────────────
 * • Uses a TFLite model internally (pose_landmarker_full.task wraps a .tflite graph).
 * • Runs fully on-device via WASM + optional WebGL/GPU delegate — no server needed.
 * • Provides 33 3-D body landmarks + per-landmark visibility scores.
 * • Better accuracy than PoseNet or MoveNet for full-body validation use-cases.
 * • Official Google/MediaPipe library; actively maintained.
 * • The .task bundle is a single file you can host locally.
 *
 * LIMITATIONS:
 * • ~6 MB model download on first load (cached after that).
 * • Requires cross-origin isolation headers (COOP/COEP) for WASM threading.
 * • GPU delegate may not activate on all mobile browsers; falls back to WASM CPU.
 */

import {
  PoseLandmarker,
  FilesetResolver,
  type PoseLandmarkerResult,
} from '@mediapipe/tasks-vision';
import type { AppConfig } from '../types/models';

let landmarker: PoseLandmarker | null = null;
let loading = false;
let loadError: string | null = null;
const loadListeners: Array<() => void> = [];

// MediaPipe PoseLandmarker is not re-entrant.
// Gallery validation and live camera validation can overlap, so serialize every
// setOptions + detect call to prevent WASM/WebGL aborts.
let poseDetectionQueue: Promise<void> = Promise.resolve();

function runPoseDetectionSerialized<T>(task: () => T | Promise<T>): Promise<T> {
  const run = poseDetectionQueue.then(task, task);
  poseDetectionQueue = run.then(() => undefined, () => undefined);
  return run;
}

/** Initialise (or return cached) PoseLandmarker. */
export async function getPoseLandmarker(config: AppConfig): Promise<PoseLandmarker> {
  if (landmarker) return landmarker;
  if (loadError) throw new Error(loadError);

  if (loading) {
    // Wait for the in-flight load to complete
    await new Promise<void>((resolve) => loadListeners.push(resolve));
    if (loadError) throw new Error(loadError);
    return landmarker!;
  }

  loading = true;

  try {
    // The WASM files are served from the @mediapipe/tasks-vision package.
    // We point FilesetResolver at the package's dist/wasm directory.
    const vision = await FilesetResolver.forVisionTasks(
      '/node_modules/@mediapipe/tasks-vision/wasm'
    );

    const modelPath = config.model.useCustomPoseModel && config.model.customPoseModelUrl
      ? config.model.customPoseModelUrl
      : config.model.poseLandmarkerModelPath;

    landmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: modelPath,
        // CPU is more stable across desktop browsers and gallery uploads.
        // GPU/WebGL can abort with gl_texture_buffer.cc prod_token errors when
        // camera and still-image validations happen close together.
        delegate: 'CPU',
      },
      runningMode: 'IMAGE',   // we switch to VIDEO for live preview dynamically
      numPoses: 5,            // detect multiple people so we can enforce exactly one person
      minPoseDetectionConfidence: 0.4,
      minPosePresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
    });

    loadListeners.forEach((cb) => cb());
    return landmarker;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    loadError = `Failed to load pose model: ${msg}. ` +
      'Make sure pose_landmarker_full.task is in public/models/ and the dev server is running.';
    loadListeners.forEach((cb) => cb());
    throw new Error(loadError);
  } finally {
    loading = false;
  }
}

/** Check if the model loaded successfully. */
export function isModelReady(): boolean {
  return landmarker !== null;
}

/** Return any load error message (or null). */
export function getModelLoadError(): string | null {
  return loadError;
}

/** Run pose detection on an image-like element in IMAGE mode. */
export async function detectPose(
  image: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
  config: AppConfig,
  timestamp?: number
): Promise<PoseLandmarkerResult> {
  const lm = await getPoseLandmarker(config);

  return runPoseDetectionSerialized(async () => {
    if (image instanceof HTMLVideoElement) {
      // For video (live preview) we must use detectForVideo.
      await lm.setOptions({ runningMode: 'VIDEO' });
      return lm.detectForVideo(image, timestamp ?? performance.now());
    }

    await lm.setOptions({ runningMode: 'IMAGE' });
    return lm.detect(image as HTMLImageElement | HTMLCanvasElement);
  });
}
