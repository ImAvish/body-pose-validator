/**
 * geometryUtils.ts
 * 2-D geometry helpers used by pose/heuristic validation logic.
 * All coordinate systems use [0,1] normalised space (MediaPipe convention).
 */

import type { NormalizedLandmark } from '../types/validation';

/** Euclidean distance between two 2-D points. */
export function dist2D(a: NormalizedLandmark, b: NormalizedLandmark): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/**
 * Angle (degrees) of the line from point A to point B,
 * measured from the horizontal (0 = right, +90 = down).
 */
export function angleDeg(a: NormalizedLandmark, b: NormalizedLandmark): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.atan2(dy, dx) * (180 / Math.PI);
}

/** Midpoint of two landmarks. */
export function midpoint(a: NormalizedLandmark, b: NormalizedLandmark): NormalizedLandmark {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

/**
 * Compute the tilt of the shoulder line in degrees.
 * 0 = perfectly horizontal, positive = left shoulder higher than right.
 */
export function shoulderTiltDeg(
  leftShoulder: NormalizedLandmark,
  rightShoulder: NormalizedLandmark
): number {
  // In MediaPipe normalised coords, y increases downward.
  const dx = rightShoulder.x - leftShoulder.x;
  const dy = rightShoulder.y - leftShoulder.y;
  return Math.atan2(dy, dx) * (180 / Math.PI);
}

/**
 * Estimate the tilt of the body vertical axis in degrees from vertical.
 * Uses shoulder-midpoint and hip-midpoint.
 * 0 = perfectly vertical, large value = leaning.
 */
export function bodyAxisTiltDeg(
  leftShoulder: NormalizedLandmark,
  rightShoulder: NormalizedLandmark,
  leftHip: NormalizedLandmark,
  rightHip: NormalizedLandmark
): number {
  const shoulderMid = midpoint(leftShoulder, rightShoulder);
  const hipMid = midpoint(leftHip, rightHip);
  // Angle of the line from hip to shoulder from vertical (y-axis pointing up)
  const dx = shoulderMid.x - hipMid.x;
  const dy = hipMid.y - shoulderMid.y; // flip y because y increases downward
  const fromVertical = Math.atan2(dx, dy) * (180 / Math.PI);
  return Math.abs(fromVertical);
}

/**
 * Returns bounding box of a set of landmarks (normalised coords).
 */
export function landmarksBBox(landmarks: NormalizedLandmark[]): {
  minX: number; minY: number; maxX: number; maxY: number;
  width: number; height: number;
} {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const lm of landmarks) {
    if (lm.x < minX) minX = lm.x;
    if (lm.y < minY) minY = lm.y;
    if (lm.x > maxX) maxX = lm.x;
    if (lm.y > maxY) maxY = lm.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Clamp a number between min and max.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
