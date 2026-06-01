/**
 * CameraCapture.tsx
 * Live camera preview with:
 *   • Front / rear camera toggle
 *   • Hardware zoom (native MediaStream zoom) + CSS-scale fallback
 *   • Real-time validation hints (from useRealtimeValidation hook)
 *   • Pose skeleton overlay
 *   • Auto-capture when N consecutive good frames detected
 *   • Manual capture button
 *   • Debug overlay panel (enabled via config.modules.debugOverlay)
 */

import {
  useRef, useState, useEffect, useCallback,
  useImperativeHandle, forwardRef,
} from 'react';
import type { ViewType, NormalizedLandmark, ValidationResult } from '../types/validation';
import type { FacingMode } from '../utils/cameraUtils';
import { requestCameraStream, stopStream } from '../utils/cameraUtils';
import {
  getZoomCapabilities, applyNativeZoom, captureWithZoom,
  type ZoomCapabilities,
} from '../utils/zoomUtils';
import { useRealtimeValidation, type RealtimeValidationState } from '../hooks/useRealtimeValidation';
import { defaultConfig } from '../config/validationConfig';
import { validateBodyPhoto } from '../services/validationPipeline';
import { LM, CORE_VALIDATION_LANDMARKS } from '../services/poseDetection';
import styles from '../styles/CameraCapture.module.css';

export interface CameraCaptureHandle {
  captureStill: () => Promise<{ dataUrl: string; image: HTMLImageElement } | null>;
}

interface Props {
  expectedView: ViewType;
  onCapture: (dataUrl: string, imageEl: HTMLImageElement, validationResult?: ValidationResult) => void;
  disabled?: boolean;
}

export const CameraCapture = forwardRef<CameraCaptureHandle, Props>(
  ({ expectedView, onCapture, disabled }, ref) => {
    const videoRef    = useRef<HTMLVideoElement>(null);
    const overlayRef  = useRef<HTMLCanvasElement>(null);
    const streamRef   = useRef<MediaStream | null>(null);
    const rafRef      = useRef<number>(0);

    const [facingMode, setFacingMode] = useState<FacingMode>('environment');
    const [cameraError, setCameraError] = useState<string | null>(null);
    const [isReady, setIsReady] = useState(false);
    const [autoCaptured, setAutoCaptured] = useState(false);
    const [isCaptureChecking, setIsCaptureChecking] = useState(false);
    const [captureGuardMessage, setCaptureGuardMessage] = useState<string | null>(null);
    const latestRealtimeStateRef = useRef<RealtimeValidationState | null>(null);
    const captureInFlightRef = useRef(false);

    // ── Zoom state ─────────────────────────────────────────────────────────────
    const [zoomCap, setZoomCap] = useState<ZoomCapabilities | null>(null);
    const [cssZoom, setCssZoom] = useState(1);       // CSS scale factor
    const cssZoomRef = useRef(1);                    // ref for capture closure

    // ── Start camera ───────────────────────────────────────────────────────────
    const startCamera = useCallback(async (mode: FacingMode) => {
      setCameraError(null);
      setIsReady(false);
      setCssZoom(1);
      cssZoomRef.current = 1;
      stopStream(streamRef.current);
      cancelAnimationFrame(rafRef.current);

      try {
        const stream = await requestCameraStream(mode);
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play();
          setIsReady(true);

          // Read zoom capabilities
          const cap = getZoomCapabilities(stream);
          setZoomCap(cap);
        }
      } catch (err) {
        setCameraError(err instanceof Error ? err.message : String(err));
      }
    }, []);

    useEffect(() => {
      startCamera(facingMode);
      return () => {
        stopStream(streamRef.current);
        cancelAnimationFrame(rafRef.current);
      };
    }, [facingMode, startCamera]);

    // ── Capture ────────────────────────────────────────────────────────────────
    const doCapture = useCallback(async () => {
      const video = videoRef.current;
      if (!video || captureInFlightRef.current) return;

      const liveState = latestRealtimeStateRef.current;
      const canCaptureNow =
        !!liveState &&
        liveState.isAllGood &&
        !liveState.hints.some((h) => h.level === 'error');

      if (!canCaptureNow) {
        setAutoCaptured(false);
        setCaptureGuardMessage('Please fix the highlighted issue before capturing the photo.');
        return;
      }

      const useNative = zoomCap?.nativeSupported ?? false;
      const { dataUrl } = captureWithZoom(video, cssZoomRef.current, useNative, 1280);
      const img = new Image();

      captureInFlightRef.current = true;
      setIsCaptureChecking(true);
      setCaptureGuardMessage(null);

      try {
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('Could not prepare captured image.'));
          img.src = dataUrl;
        });

        // Final safety gate: run the same validation used by gallery/final images.
        // If live camera had a real device sensor pitch reading, do not let the
        // image-based pitch fallback reject the still image again; the sensor was
        // already the source of truth before capture. Gallery upload still uses
        // image-based pitch because no live sensor reading exists there.
        const liveStateForFinal = latestRealtimeStateRef.current;
        const finalValidationConfig = liveStateForFinal?.cameraSensorPitchAvailable
          ? {
              ...defaultConfig,
              modules: {
                ...defaultConfig.modules,
                cameraPitch: false,
              },
            }
          : defaultConfig;

        const validation = await validateBodyPhoto({
          image: img,
          expectedView,
          config: finalValidationConfig,
        });
        if (!validation.isValid) {
          const firstIssue = validation.errors[0] ?? validation.warnings[0];
          setCaptureGuardMessage(firstIssue?.message ?? 'Please correct your pose or camera angle before capturing.');
          setAutoCaptured(false);
          return;
        }

        onCapture(dataUrl, img, validation);
      } catch (err) {
        setCaptureGuardMessage(err instanceof Error ? err.message : String(err));
        setAutoCaptured(false);
      } finally {
        captureInFlightRef.current = false;
        setIsCaptureChecking(false);
      }
    }, [expectedView, onCapture, zoomCap]);

    // ── Real-time validation ───────────────────────────────────────────────────
    const handleAutoCapture = useCallback(() => {
      if (autoCaptured || captureInFlightRef.current) return;
      setAutoCaptured(true);
      void doCapture();
    }, [autoCaptured, doCapture]);

    const realtimeState = useRealtimeValidation({
      video: isReady ? videoRef.current : null,
      expectedView,
      enabled: isReady && !disabled,
      onAutoCapture: handleAutoCapture,
    });

    useEffect(() => {
      latestRealtimeStateRef.current = realtimeState;
      if (!realtimeState.hints.some((h) => h.level === 'error')) {
        setCaptureGuardMessage(null);
      }
    }, [realtimeState]);

    // ── Skeleton overlay draw loop ─────────────────────────────────────────────
    useEffect(() => {
      const canvas = overlayRef.current;
      const video  = videoRef.current;
      if (!canvas || !video || !isReady) return;
      let running = true;

      const loop = () => {
        if (!running) return;
        rafRef.current = requestAnimationFrame(loop);

        // Match canvas dimensions to video
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width  = video.videoWidth;
          canvas.height = video.videoHeight;
        }
        const ctx = canvas.getContext('2d')!;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawSkeleton(ctx, realtimeState.landmarks, canvas.width, canvas.height, realtimeState.isAllGood);
      };

      rafRef.current = requestAnimationFrame(loop);
      return () => { running = false; cancelAnimationFrame(rafRef.current); };
    }, [isReady, realtimeState.landmarks, realtimeState.isAllGood]);

    useImperativeHandle(ref, () => ({
      captureStill: async () => {
        const video = videoRef.current;
        if (!video) return null;
        const useNative = zoomCap?.nativeSupported ?? false;
        const { dataUrl } = captureWithZoom(video, cssZoomRef.current, useNative, 1280);
        const img = new Image();
        await new Promise<void>((res) => { img.onload = () => res(); img.src = dataUrl; });
        return { dataUrl, image: img };
      },
    }));

    // ── Zoom handlers ──────────────────────────────────────────────────────────
    const handleZoomChange = async (newZoom: number) => {
      if (!streamRef.current || !zoomCap) return;
      const clamped = Math.max(zoomCap.min, Math.min(zoomCap.max, newZoom));

      if (zoomCap.nativeSupported) {
        const ok = await applyNativeZoom(streamRef.current, clamped);
        if (ok) {
          setCssZoom(clamped);
          cssZoomRef.current = clamped;
          setZoomCap((prev) => prev ? { ...prev, current: clamped } : prev);
        }
      } else {
        // CSS fallback
        setCssZoom(clamped);
        cssZoomRef.current = clamped;
      }
    };

    const handleZoomReset = () => handleZoomChange(zoomCap?.min ?? 1);

    const toggleCamera = () => {
      setAutoCaptured(false);
      setFacingMode((prev) => (prev === 'user' ? 'environment' : 'user'));
    };

    const requestAngleSensorPermission = () => {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('bodyValidatorRequestDeviceOrientationPermission'));
      }
    };

    // ── Live hint display ──────────────────────────────────────────────────────
    const guardHint = captureGuardMessage
      ? { code: 'CAPTURE_BLOCKED', message: captureGuardMessage, level: 'error' as const }
      : null;
    const topHint = guardHint ?? realtimeState.hints[0] ?? null;
    const canCaptureNow =
      isReady &&
      realtimeState.isAllGood &&
      !realtimeState.hints.some((h) => h.level === 'error') &&
      !isCaptureChecking;
    const pitchIndicator = getPitchIndicator(realtimeState);
    const showDebug = defaultConfig.modules.debugOverlay;

    if (cameraError) {
      return (
        <div className={styles.error}>
          <p className={styles.errorTitle}>📷 Camera unavailable</p>
          <p className={styles.errorMsg}>{cameraError}</p>
          <p className={styles.errorHint}>
            Camera requires HTTPS or localhost. Over LAN use mkcert or a tunnel (see README).
            You can also use the gallery upload option below.
          </p>
          <button className={styles.retryBtn} onClick={() => startCamera(facingMode)}>
            Try Again
          </button>
        </div>
      );
    }

    // Compute current zoom for display
    const currentDisplayZoom = zoomCap?.nativeSupported
      ? (zoomCap.current ?? 1)
      : cssZoom;

    return (
      <div className={styles.wrapper}>
        {/* ── Preview ─────────────────────────────────────────────────────── */}
        <div className={styles.preview}>
          <video
            ref={videoRef}
            className={styles.video}
            playsInline muted autoPlay
            style={{
              transform: (!zoomCap?.nativeSupported && cssZoom > 1)
                ? `scale(${cssZoom})`
                : undefined,
              transformOrigin: 'center center',
            }}
          />
          <canvas ref={overlayRef} className={styles.overlay} />

          {/* Guide rectangle */}
          <div className={styles.frameGuide} />

          {/* Sensor angle indicator: shows the user when the phone is close to 90°. */}
          {pitchIndicator && (
            <div className={`${styles.pitchIndicator} ${styles[pitchIndicator.className]}`}>
              <div className={styles.pitchIndicatorTop}>
                <span>{pitchIndicator.icon}</span>
                <span>{pitchIndicator.title}</span>
              </div>
              <div className={styles.pitchIndicatorValue}>{pitchIndicator.value}</div>
              <div className={styles.pitchBar}>
                <div
                  className={styles.pitchBarNeedle}
                  style={{ left: `${pitchIndicator.needlePercent}%` }}
                />
              </div>
            </div>
          )}

          {!pitchIndicator && isReady && realtimeState.cameraSensorPitchPermissionState !== 'unsupported' && (
            <button
              type="button"
              className={styles.pitchPermissionBtn}
              onClick={requestAngleSensorPermission}
            >
              Enable angle sensor
            </button>
          )}

          {/* Hold-still overlay: shown directly on the camera image when auto-capture is preparing. */}
          {isReady && canCaptureNow && (
            <div className={styles.holdStillOverlay}>
              <div className={styles.holdStillTitle}>Hold still</div>
              <div className={styles.holdStillSub}>Do not move until the photo is captured</div>
            </div>
          )}


          {/* Camera switch button */}
          <button
            type="button"
            className={styles.switchBtn}
            onClick={toggleCamera}
            disabled={disabled || isCaptureChecking}
            title="Switch camera"
          >
            🔄
          </button>

          {/* Live hint bar */}
          {isReady && topHint && (
            <div className={`${styles.hint} ${
              topHint.level === 'ok'   ? styles.hintGood  :
              topHint.level === 'warn' ? styles.hintWarn  : styles.hintBad
            }`}>
              {topHint.message}
              {realtimeState.hints.length > 1 && (
                <span className={styles.hintCount}>
                  {' '}+{realtimeState.hints.length - 1} more
                </span>
              )}
            </div>
          )}

          {/* Auto-capture progress bar */}
          {realtimeState.consecutiveGoodFrames > 0 && defaultConfig.realtime.autoCaptureFrames > 0 && (
            <div className={styles.progressBar}>
              <div
                className={styles.progressFill}
                style={{
                  width: `${(realtimeState.consecutiveGoodFrames /
                    defaultConfig.realtime.autoCaptureFrames) * 100}%`,
                }}
              />
            </div>
          )}
        </div>

        {/* ── Validation hint list ─────────────────────────────────────────── */}
        {isReady && realtimeState.hints.length > 1 && (
          <div className={styles.hintList}>
            {realtimeState.hints.map((h) => (
              <div
                key={h.code}
                className={`${styles.hintItem} ${
                  h.level === 'ok'   ? styles.hintItemOk   :
                  h.level === 'warn' ? styles.hintItemWarn : styles.hintItemErr
                }`}
              >
                {h.level === 'error' ? '⚠️' : h.level === 'warn' ? '💡' : '✅'} {h.message}
              </div>
            ))}
          </div>
        )}

        {/* ── Zoom controls ────────────────────────────────────────────────── */}
        {isReady && zoomCap && (
          <div className={styles.zoomRow}>
            <span className={styles.zoomLabel}>🔍 Zoom: {currentDisplayZoom.toFixed(1)}×</span>
            <input
              type="range"
              className={styles.zoomSlider}
              min={zoomCap.min}
              max={zoomCap.max}
              step={zoomCap.step}
              value={currentDisplayZoom}
              onChange={(e) => handleZoomChange(parseFloat(e.target.value))}
              disabled={disabled || isCaptureChecking}
            />
            <button
              type="button"
              className={styles.zoomReset}
              onClick={handleZoomReset}
              disabled={disabled || currentDisplayZoom <= zoomCap.min}
            >
              ↺
            </button>
            {!zoomCap.nativeSupported && (
              <span className={styles.zoomNote}>visual zoom</span>
            )}
          </div>
        )}

        {/* ── Capture button ───────────────────────────────────────────────── */}
        <button
          type="button"
          className={styles.captureBtn}
          onClick={() => {
            if (!canCaptureNow) return;
            setAutoCaptured(false);
            void doCapture();
          }}
          disabled={disabled || !canCaptureNow}
        >
          {isCaptureChecking ? 'Checking…' : '📸 Capture Photo'}
        </button>

        {!isReady && !cameraError && (
          <p className={styles.loading}>Starting camera…</p>
        )}

        {/* ── Debug overlay ────────────────────────────────────────────────── */}
        {showDebug && isReady && (
          <DebugPanel realtimeState={realtimeState} />
        )}
      </div>
    );
  }
);

CameraCapture.displayName = 'CameraCapture';

function getPitchIndicator(realtimeState: RealtimeValidationState): null | {
  className: 'pitchOk' | 'pitchWarn' | 'pitchBad' | 'pitchUnknown';
  icon: string;
  title: string;
  value: string;
  needlePercent: number;
} {
  if (!realtimeState.cameraSensorPitchAvailable || realtimeState.cameraSensorPitchDeg === null) {
    return null;
  }

  const cfg = defaultConfig.cameraSensorPitch;
  const pitch = realtimeState.cameraSensorPitchDeg;
  const target = cfg.targetPitchDeg;
  const delta = pitch - target;
  const absDelta = Math.abs(delta);
  const displayDelta = delta >= 0 ? `+${delta.toFixed(1)}°` : `${delta.toFixed(1)}°`;
  const needleRange = Math.max(cfg.errorToleranceDeg * 1.6, 16);
  const needlePercent = Math.max(4, Math.min(96, 50 + (delta / needleRange) * 50));

  if (absDelta <= cfg.warningToleranceDeg) {
    return {
      className: 'pitchOk',
      icon: '✅',
      title: 'Angle OK',
      value: `${pitch.toFixed(1)}° (${displayDelta})`,
      needlePercent,
    };
  }

  if (absDelta <= cfg.errorToleranceDeg) {
    return {
      className: 'pitchWarn',
      icon: '↕️',
      title: delta < 0 ? 'Slightly high' : 'Slightly low',
      value: `${pitch.toFixed(1)}° (${displayDelta})`,
      needlePercent,
    };
  }

  return {
    className: 'pitchBad',
    icon: '⚠️',
    title: delta < 0 ? 'Too high' : 'Too low',
    value: `${pitch.toFixed(1)}° (${displayDelta})`,
    needlePercent,
  };
}

// ── Skeleton draw helper ──────────────────────────────────────────────────────
function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  w: number,
  h: number,
  isGood: boolean
) {
  if (landmarks.length === 0) return;

  const color = isGood ? '#00ff88' : '#ff4444';
  const connections: [number, number][] = [
    [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER],
    [LM.LEFT_SHOULDER, LM.LEFT_ELBOW],   [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW],
    [LM.LEFT_ELBOW, LM.LEFT_WRIST],      [LM.RIGHT_ELBOW, LM.RIGHT_WRIST],
    [LM.LEFT_SHOULDER, LM.LEFT_HIP],     [LM.RIGHT_SHOULDER, LM.RIGHT_HIP],
    [LM.LEFT_HIP, LM.RIGHT_HIP],
    [LM.LEFT_HIP, LM.LEFT_KNEE],         [LM.RIGHT_HIP, LM.RIGHT_KNEE],
    [LM.LEFT_KNEE, LM.LEFT_ANKLE],       [LM.RIGHT_KNEE, LM.RIGHT_ANKLE],
    [LM.NOSE, LM.LEFT_SHOULDER],         [LM.NOSE, LM.RIGHT_SHOULDER],
    [LM.LEFT_ANKLE, LM.LEFT_HEEL],       [LM.RIGHT_ANKLE, LM.RIGHT_HEEL],
    [LM.LEFT_HEEL, LM.LEFT_FOOT],        [LM.RIGHT_HEEL, LM.RIGHT_FOOT],
  ];

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.85;

  for (const [a, b] of connections) {
    const lmA = landmarks[a]; const lmB = landmarks[b];
    if (!lmA || !lmB) continue;
    if ((lmA.visibility ?? 0) < 0.25 || (lmB.visibility ?? 0) < 0.25) continue;
    ctx.beginPath();
    ctx.moveTo(lmA.x * w, lmA.y * h);
    ctx.lineTo(lmB.x * w, lmB.y * h);
    ctx.stroke();
  }

  // Draw only the core landmarks that are useful for validation.
  // MediaPipe still returns 33 landmarks internally, but the UI no longer
  // displays the extra face/finger points.
  ctx.fillStyle = color;
  for (const idx of CORE_VALIDATION_LANDMARKS) {
    const lm = landmarks[idx];
    if (!lm || (lm.visibility ?? 0) < 0.25) continue;
    ctx.beginPath();
    ctx.arc(lm.x * w, lm.y * h, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ── Debug panel (shown when config.modules.debugOverlay = true) ──────────────
function DebugPanel({ realtimeState }: { realtimeState: ReturnType<typeof useRealtimeValidation> }) {
  const { hints, landmarks, isAllGood, consecutiveGoodFrames } = realtimeState;
  return (
    <details open className={styles.debugPanel}>
      <summary>🛠 Debug overlay</summary>
      <div className={styles.debugGrid}>
        <span>Shown landmarks:</span>
        <span>{CORE_VALIDATION_LANDMARKS.length}</span>
        <span>Total MediaPipe landmarks:</span>
        <span>{landmarks.length}</span>
        <span>All good:</span>
        <span>{isAllGood ? '✅' : '❌'}</span>
        <span>Good frames:</span>
        <span>{consecutiveGoodFrames}</span>
        <span>Sensor pitch:</span>
        <span>{realtimeState.cameraSensorPitchAvailable ? `${realtimeState.cameraSensorPitchDeg?.toFixed(1)}° (${realtimeState.cameraSensorPitchSource})` : 'fallback'}</span>
        <span>Hints:</span>
        <span>{hints.map((h) => h.code).join(', ') || '—'}</span>
      </div>
    </details>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export { useRealtimeValidation };
