import type { AppStep } from '../types/validation';
import styles from '../styles/StepIndicator.module.css';

interface Props {
  currentStep: AppStep;
}

const STEPS: { key: AppStep; label: string; icon: string }[] = [
  { key: 'front', label: 'Front Photo', icon: '👤' },
  { key: 'side',  label: 'Side Photo',  icon: '🚶' },
  { key: 'done',  label: 'Done',         icon: '✅' },
];

export function StepIndicator({ currentStep }: Props) {
  const currentIdx = STEPS.findIndex((s) => s.key === currentStep);

  return (
    <div className={styles.container}>
      {STEPS.map((step, idx) => {
        const status =
          idx < currentIdx ? 'done' :
          idx === currentIdx ? 'active' : 'pending';
        return (
          <div key={step.key} className={styles.stepWrapper}>
            <div className={`${styles.step} ${styles[status]}`}>
              <span className={styles.icon}>{step.icon}</span>
              <span className={styles.label}>{step.label}</span>
            </div>
            {idx < STEPS.length - 1 && (
              <div className={`${styles.connector} ${idx < currentIdx ? styles.connectorDone : ''}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
