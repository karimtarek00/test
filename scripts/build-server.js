#!/usr/bin/env node
// The server is plain CommonJS with no build-time transform needed (Node
// runs it directly) -- so "building" it is just copying src/ -> dist/,
// keeping the same dev-vs-production split the reference app uses:
// `npm run dev:server` runs src/index.js directly for fast-iteration dev,
// while `npm start`/PM2 run the built dist/index.js in production. Run as
// part of `npm run build`, after Vite has already built the client into
// public/.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

fs.rmSync(DIST, { recursive: true, force: true });
fs.cpSync(SRC, DIST, { recursive: true });
console.log(`✓ copied src/ -> dist/`);
