/**
 * App.tsx
 * Root application component.
 * Orchestrates the two-step photo capture + validation flow.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import type { AppStep, ValidationResult, ViewType } from './types/validation';
import { validateBodyPhoto } from './services/validationPipeline';
import { getPoseLandmarker } from './services/modelLoader';
import { defaultConfig } from './config/validationConfig';
import { fileToImageElement } from './utils/imageUtils';

import { StepIndicator } from './components/StepIndicator';
import { CameraCapture, type CameraCaptureHandle } from './components/CameraCapture';
import { GalleryUpload } from './components/GalleryUpload';
import { ValidationPanel } from './components/ValidationPanel';
import { ImagePreview } from './components/ImagePreview';
import './styles/app.css';

type InputMode = 'camera' | 'gallery';

interface StepState {
  dataUrl: string | null;
  validationResult: ValidationResult | null;
}

export default function App() {
  const [step, setStep] = useState<AppStep>('front');
  const [inputMode, setInputMode] = useState<InputMode>('camera');
  const [isValidating, setIsValidating] = useState(false);
  const [modelStatus, setModelStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [modelError, setModelError] = useState<string>('');

  const [frontState, setFrontState] = useState<StepState>({ dataUrl: null, validationResult: null });
  const [sideState, setSideState]   = useState<StepState>({ dataUrl: null, validationResult: null });

  // Pending captured image waiting for validation
  const [capturedDataUrl, setCapturedDataUrl] = useState<string | null>(null);
  const [capturedImage, setCapturedImage]     = useState<HTMLImageElement | null>(null);

  const cameraRef = useRef<CameraCaptureHandle>(null);

  // ── Pre-load model on mount ───────────────────────────────────────────────
  useEffect(() => {
    getPoseLandmarker(defaultConfig)
      .then(() => setModelStatus('ready'))
      .catch((err) => {
        setModelStatus('error');
        setModelError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  const currentView: ViewType = step === 'front' ? 'front' : 'side';
  const currentState = step === 'front' ? frontState : sideState;
  const setCurrentState = step === 'front' ? setFrontState : setSideState;

  const advanceAfterValidResult = useCallback(() => {
    setTimeout(() => {
      if (currentView === 'front') {
        setStep('side');
        setCapturedDataUrl(null);
        setCapturedImage(null);
      } else {
        setStep('done');
      }
    }, 1200);
  }, [currentView]);

  // ── Handle a captured or uploaded image ──────────────────────────────────
  const handleImage = useCallback(async (
    dataUrl: string,
    imgEl: HTMLImageElement,
    prevalidatedResult?: ValidationResult
  ) => {
    setCapturedDataUrl(dataUrl);
    setCapturedImage(imgEl);
    setCurrentState({ dataUrl, validationResult: prevalidatedResult ?? null });

    // CameraCapture already runs a final safety validation. When it provides
    // that result, do not run validateBodyPhoto() again in App.tsx, because that
    // second pass can use image-based cameraPitch and reject a photo even though
    // the live sensor angle indicator was green.
    if (prevalidatedResult) {
      if (prevalidatedResult.isValid) {
        advanceAfterValidResult();
      }
      return;
    }

    setIsValidating(true);

    try {
      const result = await validateBodyPhoto({
        image: imgEl,
        expectedView: currentView,
      });

      setCurrentState({ dataUrl, validationResult: result });

      if (result.isValid) {
        advanceAfterValidResult();
      }
    } catch (err) {
      setCurrentState({
        dataUrl,
        validationResult: {
          isValid: false,
          errors: [{
            code: 'PIPELINE_ERROR',
            message: `Validation failed: ${err instanceof Error ? err.message : String(err)}`,
            severity: 'error',
          }],
          warnings: [],
          metrics: {
            personCount: 0, poseConfidence: 0, brightness: 0, overexposedRatio: 0,
            tiltAngle: 0, bodyVerticalAngle: 0, bodyVisibilityScore: 0,
            framingScore: 0, detectedView: 'unknown', personBboxRatio: 0, centerOffsetRatio: 0,
          },
        },
      });
    } finally {
      setIsValidating(false);
    }
  }, [currentView, setCurrentState, advanceAfterValidResult]);

  // Camera capture callback
  const handleCameraCapture = useCallback((
    dataUrl: string,
    imgEl: HTMLImageElement,
    validationResult?: ValidationResult
  ) => {
    handleImage(dataUrl, imgEl, validationResult);
  }, [handleImage]);

  // Gallery upload callback
  const handleGalleryUpload = useCallback(async (file: File) => {
    try {
      const imgEl = await fileToImageElement(file);
      const dataUrl = URL.createObjectURL(file);
      handleImage(dataUrl, imgEl);
    } catch {
      alert('Could not load the selected image. Please try another file.');
    }
  }, [handleImage]);

  // Retake: reset current step state
  const handleRetake = () => {
    setCapturedDataUrl(null);
    setCapturedImage(null);
    setCurrentState({ dataUrl: null, validationResult: null });
  };

  // ── Render ────────────────────────────────────────────────────────────────

  // Model loading/error screen
  if (modelStatus === 'loading') {
    return (
      <div className="app-shell centered">
        <div className="model-loading">
          <div className="spinner large" />
          <h2>Loading AI Model…</h2>
          <p>Downloading pose detection model (~6 MB).<br />This only happens once.</p>
          <p className="hint">
            Make sure <code>pose_landmarker_full.task</code> is in <code>public/models/</code>.
          </p>
        </div>
      </div>
    );
  }

  if (modelStatus === 'error') {
    return (
      <div className="app-shell centered">
        <div className="model-error">
          <h2>⚠️ Model Load Failed</h2>
          <p>{modelError}</p>
          <h3>How to fix:</h3>
          <ol>
            <li>Download <code>pose_landmarker_full.task</code> from the MediaPipe Models page.</li>
            <li>Place it in <code>public/models/pose_landmarker_full.task</code>.</li>
            <li>Restart the dev server and reload this page.</li>
          </ol>
          <p>See the README for the exact download URL and offline setup instructions.</p>
          <button onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    );
  }

  // ── Done screen ───────────────────────────────────────────────────────────
  if (step === 'done') {
    return (
      <div className="app-shell">
        <StepIndicator currentStep="done" />
        <div className="success-screen">
          <h2 className="success-title">🎉 Both Photos Accepted!</h2>
          <p className="success-sub">Your front and side photos have been validated successfully.</p>
          <div className="success-previews">
            {frontState.dataUrl && (
              <ImagePreview src={frontState.dataUrl} label="Front View" isValid />
            )}
            {sideState.dataUrl && (
              <ImagePreview src={sideState.dataUrl} label="Side View" isValid />
            )}
          </div>
          <button
            className="btn-primary"
            onClick={() => {
              setStep('front');
              setFrontState({ dataUrl: null, validationResult: null });
              setSideState({ dataUrl: null, validationResult: null });
              setCapturedDataUrl(null);
              setCapturedImage(null);
            }}
          >
            Start Over
          </button>
        </div>
      </div>
    );
  }

  // ── Capture / validate screen ─────────────────────────────────────────────
  const hasCapture = !!capturedDataUrl;
  const result = currentState.validationResult;

  return (
    <div className="app-shell">
      <StepIndicator currentStep={step} />

      <div className="step-header">
        <h2>{step === 'front' ? '📸 Front View Photo' : '🚶 Side View Photo'}</h2>
        <p className="step-instructions">
          {step === 'front'
            ? 'Stand upright facing the camera. Make sure your full body is visible.'
            : 'Turn sideways (90°) to the camera. Keep your full body in the frame.'}
        </p>
      </div>

      {/* Input mode toggle */}
      {!hasCapture && (
        <div className="mode-toggle">
          <button
            className={`mode-btn ${inputMode === 'camera' ? 'active' : ''}`}
            onClick={() => setInputMode('camera')}
          >
            📷 Camera
          </button>
          <button
            className={`mode-btn ${inputMode === 'gallery' ? 'active' : ''}`}
            onClick={() => setInputMode('gallery')}
          >
            📁 Gallery
          </button>
        </div>
      )}

      {/* Capture area */}
      {!hasCapture && inputMode === 'camera' && (
        <CameraCapture
          ref={cameraRef}
          expectedView={currentView}
          onCapture={handleCameraCapture}
          disabled={isValidating}
        />
      )}

      {!hasCapture && inputMode === 'gallery' && (
        <div className="gallery-area">
          <div className="gallery-prompt">
            <p>Select a {step === 'front' ? 'front-view' : 'side-view'} full-body photo from your gallery.</p>
          </div>
          <GalleryUpload onImageSelected={handleGalleryUpload} disabled={isValidating} />
        </div>
      )}

      {/* Captured image preview */}
      {hasCapture && capturedDataUrl && (
        <div className="captured-area">
          <ImagePreview
            src={capturedDataUrl}
            label={step === 'front' ? 'Captured Front Photo' : 'Captured Side Photo'}
            isValid={result?.isValid}
          />
        </div>
      )}

      {/* Validation result */}
      <ValidationPanel result={result} isLoading={isValidating} />

      {/* Retake button */}
      {hasCapture && !isValidating && (
        <div className="action-row">
          <button className="btn-secondary" onClick={handleRetake}>
            🔄 Retake Photo
          </button>
        </div>
      )}

      {/* Previously accepted front photo (shown during side step) */}
      {step === 'side' && frontState.dataUrl && (
        <div className="accepted-front">
          <p className="accepted-label">✅ Front photo accepted</p>
          <ImagePreview src={frontState.dataUrl} label="Front View" isValid />
        </div>
      )}
    </div>
  );
}
