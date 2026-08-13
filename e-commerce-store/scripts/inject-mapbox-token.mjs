#!/usr/bin/env node
/**
 * inject-mapbox-token.mjs
 *
 * Build-time step that maps the NEXT_PUBLIC_MAPBOX_TOKEN environment variable
 * into the standalone HTML checkout files by replacing the dedicated
 * fallback attribute placeholder:
 *
 *     data-mapbox-token="__NEXT_PUBLIC_MAPBOX_TOKEN__"
 *
 * with the real token:
 *
 *     data-mapbox-token="pk.eyJ1..."
 *
 * Why: the placeholder (never a real token) is committed to the repo. During
 * Vercel assembly the build command runs this script first, so the deployed
 * HTML files contain the actual token while the source repo stays clean.
 *
 * Each page's inline script resolves the token at runtime from:
 *   1. window.ENV_MAPBOX_TOKEN                 (runtime injection)
 *   2. process.env.NEXT_PUBLIC_MAPBOX_TOKEN    (Next.js build-time inline;
 *      NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN is accepted as an alias)
 *   3. the data-mapbox-token fallback attribute (mapped here by Vercel)
 *
 * Behavior:
 *   - NEXT_PUBLIC_MAPBOX_TOKEN unset  -> warns and exits 0 (build still
 *     succeeds; the files keep their runtime fallback resolution).
 *   - Placeholder found               -> replaced with the token inside the
 *     data-mapbox-token attribute (HTML-escaped for attribute safety).
 *   - No placeholder found            -> skipped (already injected / nothing
 *     to do), so the step is idempotent across repeated builds.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// The dedicated fallback attribute and its placeholder value. Keep in sync
// with the <script id="search-js"> tag in the target HTML files.
const ATTRIBUTE_NAME = 'data-mapbox-token';
const PLACEHOLDER = '__NEXT_PUBLIC_MAPBOX_TOKEN__';
const TARGET_FILES = ['public/checkout.html', 'public/address-checkout-form.html'];

const token = (process.env.NEXT_PUBLIC_MAPBOX_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN || '').trim();

if (!token) {
  console.warn(
    `[inject-mapbox-token] NEXT_PUBLIC_MAPBOX_TOKEN is not set — skipping ` +
      `injection. ${ATTRIBUTE_NAME}="${PLACEHOLDER}" will be left for ` +
      `runtime resolution.`
  );
  process.exit(0);
}

// Escape the token for a double-quoted HTML attribute. Mapbox public tokens
// are URL-safe (letters/digits/./-/_); this is defensive only.
const tokenForAttribute = token
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

// Match only the placeholder inside the dedicated attribute. The same
// placeholder string also appears in each page's inline script as a guard
// constant, so scoping the match to `data-mapbox-token="..."` keeps that
// guard literal untouched (a never-injected placeholder is safely ignored at
// runtime, and repeated builds stay idempotent).
const attributePattern = new RegExp(
  `${ATTRIBUTE_NAME}="${PLACEHOLDER}"`,
  'g'
);
const attributeReplacement = `${ATTRIBUTE_NAME}="${tokenForAttribute}"`;

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

  const occurrences = html.split(attributePattern).length - 1;

  if (occurrences === 0) {
    console.log(
      `[inject-mapbox-token] No ${ATTRIBUTE_NAME}="${PLACEHOLDER}" found in ` +
        `${fileName} — already injected, skipping.`
    );
    continue;
  }

  // Function replacement avoids interpreting "$" patterns inside the token.
  const updated = html.replace(attributePattern, () => attributeReplacement);
  await writeFile(filePath, updated, 'utf8');
  filesChanged += 1;

  console.log(
    `[inject-mapbox-token] Mapped NEXT_PUBLIC_MAPBOX_TOKEN into ${fileName} ` +
      `(${occurrences} occurrence${occurrences === 1 ? '' : 's'} replaced).`
  );
}

if (filesChanged === 0) {
  console.warn(
    `[inject-mapbox-token] ${ATTRIBUTE_NAME}="${PLACEHOLDER}" not found in ` +
      `any target file — nothing to replace.`
  );
} else {
  console.log('[inject-mapbox-token] Done.');
}
