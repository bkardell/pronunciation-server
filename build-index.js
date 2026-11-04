#!/usr/bin/env node
/**
 * build-index.js — Generate a static index.html from the audio cache directory.
 *
 * Usage:
 *   node build-index.js                        # reads ./cache, writes ./cache/index.html
 *   node build-index.js ./cache ./dist/index.html
 *   node --env-file=.env build-index.js        # respects CACHE_DIR env var
 *
 * The generated index.html references audio files at relative paths, so it
 * works correctly when the entire cache directory is pushed to a CDN:
 *
 *   aws s3 sync ./cache s3://your-bucket/audio/ --exclude index.html --content-type audio/mpeg
 *   # Then upload index.html with content-type text/html:
 *   aws s3 cp ./cache/index.html s3://your-bucket/audio/index.html \
 *     --content-type "text/html; charset=utf-8"
 *
 * Audio hrefs in the built index use relative paths (just the filename) so
 * they resolve correctly wherever the index is hosted alongside the MP3s.
 */

import { writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { buildIndexHtml } from './index-page.js';

const cacheDir   = process.argv[2] ?? process.env.CACHE_DIR ?? './cache';
const outputPath = process.argv[3] ?? join(cacheDir, 'index.html');

if (!existsSync(cacheDir)) {
  console.error(`[build-index] Cache directory not found: ${cacheDir}`);
  process.exit(1);
}

// Same page as the server's GET /index, but with audio hrefs relative to the
// index (just the filename) and without the local cache path.
const html = buildIndexHtml(resolve(cacheDir), { hrefBase: '', showPath: false });
writeFileSync(outputPath, html, 'utf-8');
console.log(`[build-index] Written ${outputPath} (${(html.length / 1024).toFixed(1)} KB)`);
