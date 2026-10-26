#!/usr/bin/env node
// Renders the Capacitor app icons and splash screens (android/, ios/) from
// `public/logo.svg`, replacing the Capacitor placeholders in place.
//
// Re-run after changing the logo or after `npx cap add <platform>`:
// `node scripts/generate-native-icons.mjs`. Every target is resized to the
// dimensions of the file it replaces, so new densities need no code change.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const REPO_ROOT = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
);
const LOGO = path.join(REPO_ROOT, 'public', 'logo.svg');
const ANDROID_RES = path.join(REPO_ROOT, 'android/app/src/main/res');
const IOS_ASSETS = path.join(REPO_ROOT, 'ios/App/App/Assets.xcassets');

/** `--bg-dark` from src/ui/styles/foundation.css, so the tile matches the app. */
const BACKGROUND = '#0a0a0f';

/**
 * Fraction of the shorter side the mark may occupy. Adaptive-icon foregrounds
 * are masked to the middle ~61%, and splash marks read best small.
 */
const INSET = { icon: 0.78, foreground: 0.5, splash: 0.28 };

/** Fit the logo inside `min(width, height) * inset`, centred on an opaque tile. */
async function render(svg, width, height, inset, background = BACKGROUND) {
  const box = Math.round(Math.min(width, height) * inset);
  const mark = await sharp(svg, { density: 384 })
    .resize(box, box, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  return sharp({ create: { width, height, channels: 4, background } })
    .composite([{ input: mark, gravity: 'centre' }])
    .png()
    .toBuffer();
}

async function replace(svg, file, inset, background) {
  const { width, height } = await sharp(file).metadata();
  await writeFile(file, await render(svg, width, height, inset, background));
  console.log(`wrote ${path.relative(REPO_ROOT, file)} (${width}x${height})`);
}

async function pngs(dir) {
  const entries = await readdir(dir, { recursive: true });
  return entries
    .filter((f) => f.endsWith('.png'))
    .map((f) => path.join(dir, f));
}

const svg = await readFile(LOGO);

if (existsSync(ANDROID_RES)) {
  for (const file of await pngs(ANDROID_RES)) {
    const name = path.basename(file);
    if (name === 'splash.png') await replace(svg, file, INSET.splash);
    else if (name === 'ic_launcher_foreground.png')
      await replace(svg, file, INSET.foreground, {
        r: 0,
        g: 0,
        b: 0,
        alpha: 0,
      });
    else if (name.startsWith('ic_launcher'))
      await replace(svg, file, INSET.icon);
  }
  const color = path.join(ANDROID_RES, 'values/ic_launcher_background.xml');
  const xml = await readFile(color, 'utf8');
  await writeFile(
    color,
    xml.replace(/>#[0-9A-Fa-f]{6}</, `>${BACKGROUND.toUpperCase()}<`),
  );
}

if (existsSync(IOS_ASSETS)) {
  for (const file of await pngs(path.join(IOS_ASSETS, 'AppIcon.appiconset')))
    await replace(svg, file, INSET.icon);
  for (const file of await pngs(path.join(IOS_ASSETS, 'Splash.imageset')))
    await replace(svg, file, INSET.splash);
}
