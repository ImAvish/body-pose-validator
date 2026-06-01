#!/usr/bin/env node
/**
 * download-models.mjs
 * Downloads the required MediaPipe model files into public/models/.
 * Run once: node download-models.mjs
 *
 * After running this script the app can be used fully offline.
 */

import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { pipeline } from 'stream/promises';
import { get } from 'https';

const MODELS_DIR = './public/models';

const MODELS = [
  {
    name: 'pose_landmarker_full.task',
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
    description: 'MediaPipe Pose Landmarker (Full, float16) — ~6 MB',
  },
];

mkdirSync(MODELS_DIR, { recursive: true });

async function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const request = (u) => {
      get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          request(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        pipeline(res, file).then(resolve).catch(reject);
      }).on('error', reject);
    };
    request(url);
  });
}

for (const model of MODELS) {
  const dest = `${MODELS_DIR}/${model.name}`;
  if (existsSync(dest)) {
    console.log(`✅ Already exists: ${model.name}`);
    continue;
  }
  console.log(`⬇️  Downloading ${model.description}…`);
  try {
    await download(model.url, dest);
    console.log(`✅ Saved: ${dest}`);
  } catch (err) {
    console.error(`❌ Failed to download ${model.name}:`, err.message);
    console.log('   Manual download URL:', model.url);
    console.log(`   Place the file at: ${dest}`);
  }
}

console.log('\nAll done. You can now run the app offline.');
