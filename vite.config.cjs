const { defineConfig } = require('vite');
const react = require('@vitejs/plugin-react');

// Mirrors the reference app's split: Vite builds the client into public/
// (served by Express in production, see src/app.js), while the server's own
// build (src/ -> dist/, no bundling needed for plain CommonJS) is a
// separate step -- see scripts/build-server.js, chained after this one in
// `npm run build`.
module.exports = defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
