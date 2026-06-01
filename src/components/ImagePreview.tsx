import styles from '../styles/ImagePreview.module.css';

interface Props {
  src: string;
  label: string;
  isValid?: boolean;
}

export function ImagePreview({ src, label, isValid }: Props) {
  return (
    <div className={`${styles.container} ${isValid ? styles.valid : ''}`}>
      <img src={src} alt={label} className={styles.image} />
      <div className={styles.label}>
        {isValid && <span className={styles.badge}>✅</span>}
        {label}
      </div>
    </div>
  );
}
