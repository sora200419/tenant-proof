import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

const here = path.dirname(fileURLToPath(import.meta.url));

// Mirrors the official Midnight UI template (midnight-examples,
// packages/mnkit/templates/ui/vite.config.ts).
export default defineConfig({
  // GitHub Pages serves the project at /tenant-proof/; local dev and the root domain use /.
  base: process.env['GITHUB_ACTIONS'] ? '/tenant-proof/' : '/',
  plugins: [
    react(),
    // The onchain-runtime ships WebAssembly and loads it with top-level await.
    wasm(),
    topLevelAwait(),
    // Parts of the Midnight SDK reach for Node globals (Buffer, process).
    nodePolyfills({
      include: ['buffer', 'process', 'util', 'crypto', 'stream'],
      globals: { Buffer: true, process: true },
    }),
  ],
  // The polyfill plugin injects shim imports into SDK files that live in the
  // repo root's node_modules, where the plugin itself is not installed. Point
  // those imports at this package's copy so the production build resolves them.
  resolve: {
    alias: Object.fromEntries(
      ['buffer', 'global', 'process'].map((shim) => [
        `vite-plugin-node-polyfills/shims/${shim}`,
        path.resolve(here, `node_modules/vite-plugin-node-polyfills/shims/${shim}`),
      ]),
    ),
  },
  // esbuild pre-bundling breaks the WASM loading in these packages.
  optimizeDeps: {
    exclude: [
      '@midnightntwrk/ledger-v9',
      '@midnightntwrk/onchain-runtime-v4',
      '@midnight-ntwrk/midnight-js-protocol',
    ],
  },
  server: {
    fs: {
      // The compiled contract and shared helpers live one level up.
      allow: [path.resolve(here, '..')],
    },
  },
  build: {
    target: 'esnext',
  },
});
