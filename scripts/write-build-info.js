#!/usr/bin/env node
/**
 * Regenerates src/buildInfo.ts with the current git commit, run as part of
 * `npm run build` (before `tsc`) so the compiled plugin always knows which
 * commit it was built from — bakes the value in at build time because an
 * npm-installed copy of this package does not reliably keep its .git
 * directory, so reading it at plugin *runtime* is not dependable. This
 * script runs during `npm install github:...#branch` too, since npm's
 * `prepare` hook (which runs `npm run build`) executes inside the freshly
 * cloned checkout, while .git is still present.
 *
 * Falls back to 'unknown' (never throws) so a build from a source tree
 * without git history (e.g. a bare npm-published tarball) still succeeds.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function gitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return 'unknown';
  }
}

const commit = gitCommit();
const outFile = path.join(__dirname, '..', 'src', 'buildInfo.ts');
const content = `// Auto-generated at build time by scripts/write-build-info.js — do not edit by hand.
export const GIT_COMMIT = ${JSON.stringify(commit)};
`;

fs.writeFileSync(outFile, content);
console.log(`Wrote src/buildInfo.ts (GIT_COMMIT=${commit})`);
