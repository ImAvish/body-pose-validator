import { useRef } from 'react';
import styles from '../styles/GalleryUpload.module.css';

interface Props {
  onImageSelected: (file: File) => void;
  disabled?: boolean;
}

export function GalleryUpload({ onImageSelected, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onImageSelected(file);
      // Reset so same file can be re-selected
      e.target.value = '';
    }
  };

  return (
    <div className={styles.wrapper}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture={undefined}
        className={styles.input}
        onChange={handleChange}
        disabled={disabled}
        aria-label="Upload photo from gallery"
      />
      <button
        type="button"
        className={styles.button}
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
      >
        📁 Upload from Gallery
      </button>
    </div>
  );
}
