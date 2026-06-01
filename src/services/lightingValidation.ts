/**
 * lightingValidation.ts
 * Pixel-based brightness, overexposure, and backlight detection.
 *
 * Threshold config: src/config/validationConfig.ts → lighting section
 *   minBrightness                   : avg luma below → "too dark"
 *   maxBrightness                   : avg luma above → "too bright"
 *   maxOverexposedRatio             : overexposed pixel fraction → warning
 *   backlight.enabled               : toggle backlight detection
 *   backlight.maxBackgroundToPersonRatio      : bg/person luma ratio → backlit
 *   backlight.minBackgroundMinusPersonDelta   : bg−person delta → backlit
 *   backlight.maxDarkPersonPixelRatio         : dark-pixel fraction in person bbox
 *   backlight.minPersonLuminance              : threshold for "dark" pixel
 *   backlight.requireSceneBrightnessBelow     : only run dark-person/backlight checks below this scene luma
 *
 * Backlight detection strategy:
 *   After pose detection provides landmarks we can compute:
 *     • Person region luma using the bounding box of visible landmarks
 *     • Background region luma using the remainder of the image
 *
 *   Important:
 *   Dark-person and backlight checks are only applied when the whole scene is
 *   also relatively dark. This prevents black clothes from being detected as
 *   bad lighting in otherwise acceptable images.
 */

import type { NormalizedLandmark, ValidationError } from '../types/validation';
import type { AppConfig } from '../types/models';
import { computeLuminanceStats, imageToCanvas, getPixelData } from '../utils/imageUtils';
import { landmarksBBox } from '../utils/geometryUtils';

export interface LightingResult {
  averageLuminance: number;
  overexposedRatio: number;
  personLuminance: number | null;
  backgroundLuminance: number | null;
  errors: ValidationError[];
  warnings: ValidationError[];
}

type BacklightConfigWithOptionalGuard = AppConfig['lighting']['backlight'] & {
  requireSceneBrightnessBelow?: number;
};

export function validateLighting(
  image: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
  config: AppConfig,
  landmarks?: NormalizedLandmark[]
): LightingResult {
  const canvas = imageToCanvas(image, 320);
  const pixels = getPixelData(canvas);
  const { averageLuminance, overexposedRatio } = computeLuminanceStats(pixels);

  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  let personLuminance: number | null = null;
  let backgroundLuminance: number | null = null;

  const {
    minBrightness,
    maxBrightness,
    maxOverexposedRatio,
    backlight,
  } = config.lighting;

  const bl = backlight as BacklightConfigWithOptionalGuard;

  const requireSceneBrightnessBelow = bl.requireSceneBrightnessBelow ?? 130;
  const minPersonLuminance = bl.minPersonLuminance ?? 45;

  const isLowLightScene = averageLuminance < requireSceneBrightnessBelow;

  // ── Scene brightness ────────────────────────────────────────────────────────
  if (averageLuminance < minBrightness) {
    addUniqueError(errors, {
      code: 'TOO_DARK',
      message: 'The image is too dark. Please take the photo in better lighting.',
      severity: 'error',
    });
  } else if (averageLuminance > maxBrightness) {
    addUniqueError(errors, {
      code: 'TOO_BRIGHT',
      message: 'The image is too bright. Please avoid strong direct light.',
      severity: 'error',
    });
  }

  // Overexposed pixels warning only when the image is not globally too bright.
  if (overexposedRatio > maxOverexposedRatio && averageLuminance <= maxBrightness) {
    warnings.push({
      code: 'OVEREXPOSED',
      message: 'Parts of the image are overexposed. Try to avoid harsh direct lighting.',
      severity: 'warning',
    });
  }

  // ── Backlight detection ─────────────────────────────────────────────────────
  if (bl.enabled) {
    if (landmarks && landmarks.length > 0) {
      const visible = landmarks.filter(
        (lm) => (lm.visibility ?? 0) >= config.confidence.minLandmarkVisibility
      );

      if (visible.length >= 4) {
        const bbox = landmarksBBox(visible);

        const result = computeRegionLuminance(
          pixels,
          canvas.width,
          canvas.height,
          bbox,
          minPersonLuminance
        );

        personLuminance = result.person;
        backgroundLuminance = result.background;

        const ratio = backgroundLuminance / Math.max(personLuminance, 1);
        const delta = backgroundLuminance - personLuminance;

        const personTooDarkInLowScene =
          isLowLightScene &&
          result.darkPersonRatio > bl.maxDarkPersonPixelRatio;

        const strongBacklight =
          isLowLightScene &&
          result.darkPersonRatio > bl.maxDarkPersonPixelRatio &&
          (
            ratio > bl.maxBackgroundToPersonRatio ||
            delta > bl.minBackgroundMinusPersonDelta
          );

        if (strongBacklight) {
          addUniqueError(errors, {
            code: 'BACKLIT',
            message:
              'Strong backlight detected. Please face the light source or move away from the bright background.',
            severity: 'error',
          });
        } else if (personTooDarkInLowScene) {
          addUniqueError(errors, {
            code: 'BACKLIT',
            message:
              'The person appears too dark. Please stand in better light and avoid strong backlight.',
            severity: 'error',
          });
        }
      }
    } else {
      // Fallback path without landmarks.
      // This is intentionally conservative to avoid rejecting good images
      // only because the clothes are dark.
      if (averageLuminance < minBrightness && overexposedRatio > 0.05) {
        addUniqueError(errors, {
          code: 'BACKLIT',
          message:
            'You appear to be backlit. Please face a light source instead of standing in front of one.',
          severity: 'error',
        });
      }
    }
  }

  return {
    averageLuminance,
    overexposedRatio,
    personLuminance,
    backgroundLuminance,
    errors,
    warnings,
  };
}

// ── Region luminance helper ────────────────────────────────────────────────────

interface RegionLuminance {
  person: number;
  background: number;
  darkPersonRatio: number;
}

function computeRegionLuminance(
  pixels: ImageData,
  w: number,
  h: number,
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  darkThreshold: number
): RegionLuminance {
  const { data } = pixels;

  // Use the full person bbox, slightly expanded.
  // Do not use a tight body/clothes mask here, because black clothes can cause
  // false backlight errors in otherwise valid images.
  const padX = 0.04;
  const padY = 0.03;

  const x0 = Math.max(0, Math.floor((bbox.minX - padX) * w));
  const y0 = Math.max(0, Math.floor((bbox.minY - padY) * h));
  const x1 = Math.min(w - 1, Math.ceil((bbox.maxX + padX) * w));
  const y1 = Math.min(h - 1, Math.ceil((bbox.maxY + padY) * h));

  let personSum = 0;
  let personCount = 0;
  let darkPerson = 0;

  let bgSum = 0;
  let bgCount = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

      const insidePersonBBox = x >= x0 && x <= x1 && y >= y0 && y <= y1;

      if (insidePersonBBox) {
        personSum += luma;
        personCount++;

        if (luma < darkThreshold) {
          darkPerson++;
        }
      } else {
        bgSum += luma;
        bgCount++;
      }
    }
  }

  const person = personCount > 0 ? personSum / personCount : 128;
  const background = bgCount > 0 ? bgSum / bgCount : 128;
  const darkPersonRatio = personCount > 0 ? darkPerson / personCount : 0;

  return {
    person,
    background,
    darkPersonRatio,
  };
}

function addUniqueError(errors: ValidationError[], error: ValidationError): void {
  if (!errors.some((e) => e.code === error.code)) {
    errors.push(error);
  }
}