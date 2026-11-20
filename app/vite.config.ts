import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Release builds get a strict Content-Security-Policy: only the app's own scripts run, it only talks to the local
// bridge, and images come from the app, data:/blob: URLs and its own picture protocol (sximg:). (Development uses
// Vite's inline hot-reload scripts, so the policy is added to built pages only.)
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: sximg:",
  "font-src 'self' data:",
  'connect-src ws://127.0.0.1:*',
  "media-src 'self' blob: data:",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

const csp = (): Plugin => ({
  name: 'kf-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
});

export default defineConfig({
  plugins: [react(), csp()],
  base: './',
  server: { host: '127.0.0.1', port: 5199, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome120' },
});
