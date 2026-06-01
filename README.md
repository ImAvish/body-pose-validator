Body Photo Validator is a browser-based AI application that validates full-body front and side photographs before submission. The system uses MediaPipe Pose Landmarker (TensorFlow Lite) to analyze body landmarks and ensure that photos meet predefined quality requirements.

Key validation checks include:

- Single-person detection
- Front-view and side-view classification
- Full-body visibility verification
- Upright standing posture validation
- Camera tilt and alignment detection
- Framing and positioning analysis
- Image brightness and exposure assessment
- Real-time feedback and guidance
- Automatic capture when validation criteria are satisfied
- Support for both live camera input and gallery image uploads
- Mobile and desktop browser compatibility

Built with React, TypeScript, MediaPipe Tasks Vision, TensorFlow Lite, and modern browser APIs.


## Installation & Setup
```Bash 
# 1. Clone the repository
git clone https://github.com/ImAvish/body-pose-validator.git

# 2. Go to project folder
cd body-pose-validator

# 3. Install dependencies (IMPORTANT)
npm install
```
## Run the development server
```Bash
npm run dev
```

## Run on Local Network (Mobile Testing)
```
https://YOUR_LOCAL_IP:5173
```
