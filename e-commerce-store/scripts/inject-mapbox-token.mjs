#!/usr/bin/env node
/**
 * inject-mapbox-token.mjs
 *
 * Build-time step that inlines the NEXT_PUBLIC_MAPBOX_TOKEN environment
 * variable into the standalone HTML checkout files, replacing the
 * `window.ENV_MAPBOX_TOKEN` placeholder with the real token.
 *
 * Why: the placeholder (never a real token) is committed to the repo. During
 * Vercel assembly the build command runs this script first, so the deployed
 * HTML files contain the actual token while the source repo stays clean.
 *
 * Behavior:
 *   - NEXT_PUBLIC_MAPBOX_TOKEN unset  -> warns and exits 0 (build still
 *     succeeds; the files keep their runtime fallback resolution).
 *   - Placeholder found               -> replaced with a JSON-escaped string
 *     literal (safe to inline in a <script> block).
 *   - No placeholder found            -> skipped (already injected / nothing
 *     to do), so the step is idempotent across repeated builds.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const PLACEHOLDER = 'window.ENV_MAPBOX_TOKEN';
const TARGET_FILES = ['checkout.html', 'address-checkout-form.html'];

const token = (process.env.NEXT_PUBLIC_MAPBOX_TOKEN || '').trim();

if (!token) {
  console.warn(
    `[inject-mapbox-token] NEXT_PUBLIC_MAPBOX_TOKEN is not set — skipping ` +
      `injection. ${PLACEHOLDER} will be left for runtime resolution.`
  );
  process.exit(0);
}

// JSON.stringify produces a valid JS string literal; also escape "<" so a
// token can never break out of the inline <script> block.
const tokenLiteral = JSON.stringify(token).replace(/</g, '\\u003c');

let filesChanged = 0;

for (const fileName of TARGET_FILES) {
  const filePath = path.join(projectRoot, fileName);

  let html;
  try {
    html = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn(`[inject-mapbox-token] Skipping missing file: ${fileName}`);
      continue;
    }
    throw error;
  }

  const occurrences = html.split(PLACEHOLDER).length - 1;

  if (occurrences === 0) {
    console.log(
      `[inject-mapbox-token] No ${PLACEHOLDER} found in ${fileName} — already injected, skipping.`
    );
    continue;
  }

  const updated = html.split(PLACEHOLDER).join(tokenLiteral);
  await writeFile(filePath, updated, 'utf8');
  filesChanged += 1;

  console.log(
    `[inject-mapbox-token] Injected token into ${fileName} ` +
      `(${occurrences} occurrence${occurrences === 1 ? '' : 's'} replaced).`
  );
}

if (filesChanged === 0) {
  console.warn(
    `[inject-mapbox-token] ${PLACEHOLDER} not found in any target file — nothing to replace.`
  );
} else {
  console.log('[inject-mapbox-token] Done.');
}
