# Body Photo Validator

A production-grade, fully client-side React + TypeScript app for capturing and validating front-view and side-view full-body photos.
All inference runs on-device using MediaPipe Tasks Vision (TFLite internally). No server or internet required after setup.

---

## Technical Plan

### Selected Models / Tools

| Task | Solution | Reason |
|---|---|---|
| **Pose detection + landmarks** | MediaPipe PoseLandmarker (Full model) | 33 3-D landmarks + per-landmark visibility, TFLite internally, runs via WASM/WebGL in-browser, best accuracy for full-body |
| **Person count** | Derived from PoseLandmarker (`numPoses: 2`) | Avoids a second model; MediaPipe Pose is already a detector+estimator |
| **Full-body visibility** | Landmark visibility scores (heuristic) | No extra model; visibility scores from MediaPipe are reliable |
| **Standing-pose validation** | Geometric heuristics on landmarks | Rules-based, explainable, fast |
| **Front/side classification** | Shoulder X-spread + shoulder Z-depth (heuristic) | Works well without a dedicated classifier; replaceable |
| **Lighting** | Pixel luminance histogram (canvas) | Zero ML cost, accurate |
| **Camera tilt** | Shoulder-line angle + body-axis angle | Derived from landmarks, no extra model |
| **Framing** | Landmark bounding box (normalised coords) | Derived from landmarks |

### Limitations
- Front-vs-side classification is heuristic-based; accuracy ~80%. Replace with a trained TFLite classifier for better results.
- PoseLandmarker struggles with very loose/baggy clothing; confidence thresholds may need tuning.
- Camera API requires HTTPS or localhost (see below).

---

## Project Structure

```
body-photo-validator/
├── public/
│   └── models/
│       └── pose_landmarker_full.task   ← place model here
├── src/
│   ├── App.tsx
│   ├── main.tsx
│   ├── config/
│   │   ├── modelConfig.ts              ← model paths & custom model flags
│   │   └── validationConfig.ts         ← all thresholds
│   ├── components/
│   │   ├── CameraCapture.tsx
│   │   ├── GalleryUpload.tsx
│   │   ├── StepIndicator.tsx
│   │   ├── ValidationPanel.tsx
│   │   └── ImagePreview.tsx
│   ├── services/
│   │   ├── modelLoader.ts              ← singleton PoseLandmarker loader
│   │   ├── personDetection.ts
│   │   ├── poseDetection.ts
│   │   ├── viewValidation.ts           ← body visibility, pose, view classification
│   │   ├── lightingValidation.ts
│   │   ├── tiltValidation.ts
│   │   ├── framingValidation.ts
│   │   └── validationPipeline.ts       ← main entry point
│   ├── types/
│   │   ├── validation.ts
│   │   └── models.ts
│   ├── utils/
│   │   ├── imageUtils.ts
│   │   ├── geometryUtils.ts
│   │   └── cameraUtils.ts
│   └── styles/
│       ├── app.css
│       ├── CameraCapture.module.css
│       ├── ValidationPanel.module.css
│       ├── StepIndicator.module.css
│       ├── ImagePreview.module.css
│       └── GalleryUpload.module.css
├── download-models.mjs                 ← run once to download model files
├── package.json
├── vite.config.ts
└── tsconfig.json
```

---

## Installation

```bash
# 1. Install dependencies
npm install

# 2. Download the pose model (~6 MB, one-time)
node download-models.mjs

# 3. Start the dev server (accessible on your local network)
npm run dev
```

The model file will be saved to `public/models/pose_landmarker_full.task`.
After this, the app works fully offline.

---

## Running on Mobile (LAN Testing)

### Find your computer's IP address

**Windows:** Open a terminal and run:
```
ipconfig
```
Look for `IPv4 Address` under your active adapter (e.g. `192.168.1.42`).

**macOS/Linux:**
```
ip addr show   # Linux
ifconfig       # macOS
```

### Start the server

```bash
npm run dev
# Vite will print something like:
#   Local:   http://localhost:5173/
#   Network: http://192.168.1.42:5173/
```

### Open on phone

Navigate to `http://192.168.1.42:5173` (replace with your IP) in:
- **Android Chrome** ✅
- **iPhone Safari** ✅
- **Windows Chrome/Edge** ✅

---

## HTTPS Requirement for Camera (IMPORTANT)

The browser Camera API (`getUserMedia`) **requires HTTPS** except on `localhost`.
Over a plain `http://192.168.1.x:5173` LAN URL, camera access will be blocked on most mobile browsers.

### Solution A: mkcert (recommended)

```bash
# Install mkcert
# Windows: choco install mkcert  (or download from https://github.com/FiloSottile/mkcert)
# macOS:   brew install mkcert
# Linux:   see https://github.com/FiloSottile/mkcert

mkcert -install
mkcert localhost 192.168.1.42   # replace with your IP

# This creates localhost+1.pem and localhost+1-key.pem
```

Then update `vite.config.ts`:
```ts
import fs from 'fs';
export default defineConfig({
  server: {
    https: {
      cert: fs.readFileSync('./localhost+1.pem'),
      key:  fs.readFileSync('./localhost+1-key.pem'),
    },
    host: '0.0.0.0',
    port: 5173,
  },
  // ... rest of config
});
```

Install the root CA on your phone (mkcert prints instructions) and then open:
`https://192.168.1.42:5173`

### Solution B: ngrok tunnel (quick, requires internet)

```bash
npm install -g ngrok
ngrok http 5173
# Use the https://xxxx.ngrok.io URL on your phone
```

### Solution C: Gallery upload (no HTTPS needed)

If camera does not work, use the **"Upload from Gallery"** button.
This uses `<input type="file" accept="image/*">` which works on all browsers without HTTPS.

---

## iOS Safari Notes

- Safari on iOS requires a user gesture (tap) to start the camera; this is handled automatically.
- The `playsInline` attribute is set on the `<video>` element to prevent fullscreen takeover.
- If the camera appears mirrored: this is the front camera mirror effect. The captured still is not mirrored.
- iOS 14.3+ supports `getUserMedia` over HTTPS. Older iOS versions may not support camera access in Safari.

---

## Replacing Default Models with Custom Models

### 1. Replace the pose model

Place your `.task` file in `public/models/` and update `src/config/modelConfig.ts`:

```ts
export const modelConfig: ModelConfig = {
  poseLandmarkerModelPath: '/models/my_custom_pose.task',
  useCustomPoseModel: false, // set true if you want to use customPoseModelUrl
};
```

Or to use a URL:
```ts
useCustomPoseModel: true,
customPoseModelUrl: '/models/my_custom_pose.task',
```

### 2. Replace the view classifier

The view classifier (`classifyView` in `src/services/viewValidation.ts`) is currently heuristic-based.
To plug in a TFJS model:

```ts
// In viewValidation.ts, replace classifyView() body with:
import * as tf from '@tensorflow/tfjs';

const model = await tf.loadLayersModel('/models/view_classifier/model.json');
const input = tf.browser.fromPixels(canvas).resizeBilinear([224, 224]).expandDims(0).div(255);
const output = model.predict(input) as tf.Tensor;
const [frontProb, sideProb] = Array.from(await output.data());
const detectedView = frontProb > sideProb ? 'front' : 'side';
```

### 3. Adjust thresholds

All thresholds live in `src/config/validationConfig.ts`. Tune them without touching any service code:

```ts
confidence: {
  minLandmarkVisibility: 0.45,  // lower = more permissive
  minBodyVisibilityScore: 0.65, // fraction of key landmarks required
},
lighting: {
  minBrightness: 60,    // increase if too many "too dark" errors
  maxBrightness: 210,   // decrease if too many "too bright" errors
},
tilt: {
  maxShoulderTiltDeg: 12,       // increase for more tilt tolerance
},
framing: {
  minPersonHeightRatio: 0.55,   // decrease if users are too far away
},
```

### 4. Disable individual modules

```ts
modules: {
  personCount: true,
  fullBodyVisibility: true,
  standingPose: false,   // ← disable if causing too many false positives
  viewType: false,
  lighting: true,
  cameraTilt: false,
  framing: true,
},
```

---

## Building for Production (Offline)

```bash
npm run build
# Output goes to dist/

# Serve locally (no internet needed):
npx serve dist
```

Make sure `public/models/pose_landmarker_full.task` is present before building.
The model file is copied into `dist/models/` automatically by Vite.

---

## Known Limitations and How to Improve

| Limitation | Improvement |
|---|---|
| Front/side classification ~80% accuracy | Train a binary image classifier on labelled data; plug into `classifyView()` |
| Loose clothing reduces landmark visibility | Lower `minLandmarkVisibility` threshold or use a clothing-aware model |
| Camera tilt check relies on shoulder visibility | Add accelerometer/gyroscope API as a parallel signal on mobile |
| No face visibility check | Add MediaPipe FaceDetector for extra "facing camera" signal |
| Model loads on first visit (~6 MB) | Pre-cache with a service worker for instant offline loads |
| No EXIF orientation handling | Add an EXIF parser (exifr library) to auto-rotate uploaded images |

---

## Model Files Required

| File | Size | Where to Place |
|---|---|---|
| `pose_landmarker_full.task` | ~6 MB | `public/models/pose_landmarker_full.task` |

Download command:
```bash
node download-models.mjs
```

Manual download:
```
https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task
```
