/**
 * UI guards for the compact tab layout and direct browser-preview actions.
 * The browser app is plain client JavaScript (no build step), so these checks
 * keep the authored markup and its delegated click handlers in sync.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');

test('desktop search results expose the existing browser-preview flow', () => {
  const markup = appJs.match(/function resultGroupMarkup\(group\) \{([\s\S]*?)\n\}/);
  assert.ok(markup, 'result cards have a single markup helper');
  assert.match(markup[1], /data-preview-group/, 'each result card has a preview button');
  assert.match(appJs, /card\.querySelector\('\[data-preview-group\]'\)\?\.addEventListener\('click'/,
    'the preview button calls the shared preview handler');
  assert.match(appJs, /previewGroup\(group, e\.currentTarget\)/,
    'the selected result is previewed without resolving the card click');
});

test('Mobile search results expose the same browser-preview flow', () => {
  assert.match(appJs, /data-mob-preview="\$\{escapeHtml\(group\.key\)\}"/,
    'mobile result cards render a preview control');
  assert.match(appJs, /if \(group\) previewGroup\(group, previewBtn\)/,
    'the mobile control calls the shared preview handler');
});

test('tab card groups and the transcode editor stack into one compact column', () => {
  assert.match(styleCss, /\.grid\.g2,\.grid\.g3,\.grid\.g4,\.gl\{[\s\S]*?grid-template-columns:minmax\(0,1fr\)/,
    'multi-card tab sections use a single column');
  assert.match(styleCss, /\.ffmpeg-page\{grid-template-columns:minmax\(0,1fr\)/,
    'the Transcode and Test panes stack too');
  assert.match(styleCss, /\.results-poster,\.results-thumbnails,\.results-list\{grid-template-columns:minmax\(0,1fr\)\}/,
    'search result cards are stacked for every view mode');
});
