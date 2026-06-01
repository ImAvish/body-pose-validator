import type { ValidationResult } from '../types/validation';
import { defaultConfig } from '../config/validationConfig';
import styles from '../styles/ValidationPanel.module.css';

interface Props {
  result: ValidationResult | null;
  isLoading: boolean;
}

export function ValidationPanel({ result, isLoading }: Props) {
  const showDebug = defaultConfig.modules.debugOverlay;

  if (isLoading) {
    return (
      <div className={styles.panel}>
        <div className={styles.loading}>
          <span className={styles.spinner} />
          Analysing photo…
        </div>
      </div>
    );
  }

  if (!result) return null;

  return (
    <div className={styles.panel}>
      {result.isValid ? (
        <div className={`${styles.status} ${styles.valid}`}>
          <span className={styles.statusIcon}>✅</span>
          Photo accepted!
        </div>
      ) : (
        <div className={`${styles.status} ${styles.invalid}`}>
          <span className={styles.statusIcon}>❌</span>
          Validation failed — see issues below
        </div>
      )}

      {result.errors.length > 0 && (
        <ul className={styles.errorList}>
          {result.errors.map((err) => (
            <li key={err.code} className={`${styles.errorItem} ${styles[err.severity]}`}>
              <span className={styles.errorIcon}>⚠️</span>
              {err.message}
            </li>
          ))}
        </ul>
      )}

      {result.warnings.length > 0 && (
        <ul className={styles.warningList}>
          {result.warnings.map((w) => (
            <li key={w.code} className={styles.warningItem}>
              <span className={styles.errorIcon}>💡</span>
              {w.message}
            </li>
          ))}
        </ul>
      )}

      {result.isValid && result.warnings.length === 0 && (
        <p className={styles.hint}>Moving to the next step…</p>
      )}

      {/* Debug metrics panel — enabled via config.modules.debugOverlay = true */}
      {showDebug && result.metrics && (
        <details className={styles.debug} open>
          <summary>🛠 Debug metrics (set debugOverlay: false to hide)</summary>
          <div className={styles.metricsGrid}>
            <Row label="Person count"         value={result.metrics.personCount} />
            <Row label="Pose confidence"       value={pct(result.metrics.poseConfidence)} />
            <Row label="Brightness"            value={`${result.metrics.brightness.toFixed(0)} / 255`} />
            <Row label="Overexposed ratio"     value={pct(result.metrics.overexposedRatio)} />
            <Row label="Person luma"           value={result.metrics.personLuminance != null ? result.metrics.personLuminance.toFixed(0) : 'n/a'} />
            <Row label="Background luma"       value={result.metrics.backgroundLuminance != null ? result.metrics.backgroundLuminance.toFixed(0) : 'n/a'} />
            <Row label="Shoulder tilt"         value={`${result.metrics.tiltAngle.toFixed(1)}°`} />
            <Row label="Body axis lean"        value={`${result.metrics.bodyVerticalAngle.toFixed(1)}°`} />
            {result.metrics.cameraPitchDirection != null && (
              <Row label="Camera pitch"         value={`${result.metrics.cameraPitchDirection} (${pct(result.metrics.cameraPitchScore ?? 0)})`} />
            )}
            {result.metrics.estimatedCameraPitchAngleDeg != null && (
              <Row label="Est. camera angle"     value={`${result.metrics.estimatedCameraPitchAngleDeg.toFixed(1)}°`} />
            )}
            {result.metrics.legToTorsoRatio != null && (
              <Row label="Leg/torso ratio"      value={result.metrics.legToTorsoRatio.toFixed(2)} />
            )}
            {result.metrics.upperLowerZDelta != null && (
              <Row label="Upper/lower Z delta"  value={result.metrics.upperLowerZDelta.toFixed(3)} />
            )}
            {result.metrics.ankleYForPitch != null && (
              <Row label="Ankle Y for pitch" value={result.metrics.ankleYForPitch.toFixed(3)} />
            )}
            {result.metrics.lowAngleFrameScore != null && (
              <Row label="Low-angle frame score" value={result.metrics.lowAngleFrameScore.toFixed(2)} />
            )}
            <Row label="Body visibility"       value={pct(result.metrics.bodyVisibilityScore)} />
            <Row label="Person height ratio"   value={pct(result.metrics.personBboxRatio)} />
            <Row label="Center offset"         value={pct(result.metrics.centerOffsetRatio)} />
            <Row label="Framing score"         value={pct(result.metrics.framingScore)} />
            <Row label="Detected view"         value={result.metrics.detectedView} />
            {result.metrics.sideViewScore != null && (
              <Row label="Side-view score"     value={pct(result.metrics.sideViewScore)} />
            )}
            {result.metrics.frontViewScore != null && (
              <Row label="Front-view score"    value={pct(result.metrics.frontViewScore)} />
            )}
            {result.metrics.faceVisibilityScore != null && (
              <Row label="Face visibility"    value={pct(result.metrics.faceVisibilityScore)} />
            )}
            {result.metrics.visibleFaceLandmarks != null && (
              <Row label="Visible face points" value={result.metrics.visibleFaceLandmarks} />
            )}
            {result.metrics.wristToHipWidthRatio != null && (
              <Row label="Wrist/hip ratio"     value={result.metrics.wristToHipWidthRatio.toFixed(2)} />
            )}
            {result.metrics.ankleToHipWidthRatio != null && (
              <Row label="Ankle/hip ratio"     value={result.metrics.ankleToHipWidthRatio.toFixed(2)} />
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function pct(n: number) { return `${(n * 100).toFixed(1)}%`; }
function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <>
      <span>{label}</span>
      <span>{value}</span>
    </>
  );
}
