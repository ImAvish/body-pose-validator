/**
 * cameraUtils.ts
 * Camera permission and stream management helpers.
 */

export type FacingMode = 'user' | 'environment';

/** Request a camera stream. Returns the MediaStream or throws with a user-friendly message. */
export async function requestCameraStream(facingMode: FacingMode): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      'Camera API is not available in this browser. ' +
      'Make sure you are on HTTPS or localhost.'
    );
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode,
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    return stream;
  } catch (err: unknown) {
    const e = err as DOMException;
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      throw new Error(
        'Camera permission denied. Please allow camera access in your browser settings and reload.'
      );
    }
    if (e.name === 'NotFoundError') {
      throw new Error(
        'No camera found. Please connect a camera and try again.'
      );
    }
    if (e.name === 'NotReadableError') {
      throw new Error(
        'Camera is already in use by another app. Please close it and try again.'
      );
    }
    throw new Error(`Camera error: ${e.message || String(err)}`);
  }
}

/** Stop all tracks of a MediaStream. */
export function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
}

/**
 * Capture a still frame from a <video> element onto a <canvas>.
 * Returns a data-URL JPEG string.
 */
export function captureFrameFromVideo(
  video: HTMLVideoElement,
  maxDimension = 1280
): { dataUrl: string; canvas: HTMLCanvasElement } {
  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  const scale = Math.min(1, maxDimension / Math.max(srcW, srcH));

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(srcW * scale);
  canvas.height = Math.round(srcH * scale);

  const ctx = canvas.getContext('2d')!;
  // Mirror if front camera (user-facing)
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  return { dataUrl: canvas.toDataURL('image/jpeg', 0.92), canvas };
}

/** Check if the browser reports support for a given facingMode. */
export async function hasFacingMode(mode: FacingMode): Promise<boolean> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((d) => d.kind === 'videoinput');
  } catch {
    return false;
  }
}
