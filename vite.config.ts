import { defineConfig } from 'vite';

// `base: './'` is required for the production ZIP (assets resolve relative to the
// plugin folder), but breaks the dev server's absolute module paths — so use
// '/' in dev and './' only for the build. Library mode gives a deterministic
// `assets/index.js` filename for simpler branding assembly.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  server: {
    port: 5173,
    strictPort: true,
    cors: true, // allow the https webapp to frame & talk to the dev server
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'assets/index',
    },
    rollupOptions: { external: [] },
  },
}));
