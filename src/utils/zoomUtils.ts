/**
 * zoomUtils.ts
 * Camera zoom support.
 *
 * Strategy:
 *  1. Try native MediaStreamTrack zoom via applyConstraints() (Chrome on Android, some desktop).
 *  2. Fall back to CSS transform: scale() on the video element (all browsers).
 *
 * The captured still image always reflects the visual zoom level:
 *  - Native zoom: camera sensor is zoomed → canvas capture is zoomed automatically.
 *  - CSS zoom: we crop + rescale the canvas manually to match the displayed crop.
 */

export interface ZoomCapabilities {
  /** Whether the browser/device supports native hardware/software zoom. */
  nativeSupported: boolean;
  min: number;
  max: number;
  step: number;
  current: number;
}

/** Read zoom capabilities from the active video track. Returns null if unsupported. */
export function getZoomCapabilities(stream: MediaStream): ZoomCapabilities | null {
  const track = stream.getVideoTracks()[0];
  if (!track) return null;

  // The capabilities API is not in the standard TS lib yet — cast carefully.
  const cap = track.getCapabilities?.() as Record<string, unknown> | undefined;
  if (!cap || typeof cap['zoom'] !== 'object' || cap['zoom'] === null) {
    return { nativeSupported: false, min: 1, max: 5, step: 0.1, current: 1 };
  }

  const z = cap['zoom'] as { min?: number; max?: number; step?: number };
  const settings = track.getSettings() as Record<string, unknown>;
  const current = typeof settings['zoom'] === 'number' ? settings['zoom'] : (z.min ?? 1);

  return {
    nativeSupported: true,
    min: z.min ?? 1,
    max: z.max ?? 5,
    step: z.step ?? 0.1,
    current,
  };
}

/** Apply native zoom to the video track. Returns true if successful. */
export async function applyNativeZoom(stream: MediaStream, zoom: number): Promise<boolean> {
  const track = stream.getVideoTracks()[0];
  if (!track) return false;
  try {
    // applyConstraints with advanced zoom
    await track.applyConstraints({ advanced: [{ zoom } as MediaTrackConstraints] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture a still frame from a video element, applying CSS zoom simulation
 * when native zoom is not available.
 *
 * @param video          The <video> element.
 * @param cssZoom        Current CSS scale factor (1 = no zoom).
 * @param nativeZoom     Whether native zoom was used (affects capture path).
 * @param maxDimension   Max output dimension.
 */
export function captureWithZoom(
  video: HTMLVideoElement,
  cssZoom: number,
  nativeZoom: boolean,
  maxDimension = 1280
): { dataUrl: string; canvas: HTMLCanvasElement } {
  const srcW = video.videoWidth;
  const srcH = video.videoHeight;

  const outCanvas = document.createElement('canvas');

  if (nativeZoom || cssZoom <= 1) {
    // Native zoom is handled by the sensor; capture full frame normally
    const scale = Math.min(1, maxDimension / Math.max(srcW, srcH));
    outCanvas.width  = Math.round(srcW * scale);
    outCanvas.height = Math.round(srcH * scale);
    const ctx = outCanvas.getContext('2d')!;
    ctx.drawImage(video, 0, 0, outCanvas.width, outCanvas.height);
  } else {
    // CSS zoom simulation: the user sees a zoomed crop — replicate that crop
    const cropW = srcW / cssZoom;
    const cropH = srcH / cssZoom;
    const cropX = (srcW - cropW) / 2;
    const cropY = (srcH - cropH) / 2;

    const scale = Math.min(1, maxDimension / Math.max(cropW, cropH));
    outCanvas.width  = Math.round(cropW * scale);
    outCanvas.height = Math.round(cropH * scale);
    const ctx = outCanvas.getContext('2d')!;
    ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, outCanvas.width, outCanvas.height);
  }

  return { dataUrl: outCanvas.toDataURL('image/jpeg', 0.92), canvas: outCanvas };
}
