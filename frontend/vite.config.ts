import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

const here = path.dirname(fileURLToPath(import.meta.url));

// Compiler output the browser needs to prove: keys/ (gitignored, about 33 MB),
// zkir/ and compiler/ (the integrity manifest FetchZkConfigProvider checks).
const zkDir = path.resolve(here, '..', 'contract', 'managed', 'tenant-proof');
const ZK_FILE_RE = /^\/zk\/(compiler|keys|zkir)\/([A-Za-z0-9_.-]+)$/;

const SHIM_RE = /^vite-plugin-node-polyfills\/shims\/(buffer|global|process)$/;

/**
 * The polyfill plugin injects shim imports (and rewrites bare `buffer` /
 * `process` imports to them) in SDK files that live in the repo root's
 * node_modules, where the plugin itself is not installed. Resolve those ids to
 * this package's copy, whatever plugin produced them.
 */
function polyfillShims(): Plugin {
  return {
    name: 'tenant-proof-polyfill-shims',
    enforce: 'pre',
    resolveId(id) {
      const m = SHIM_RE.exec(id);
      return m ? path.resolve(here, `node_modules/vite-plugin-node-polyfills/shims/${m[1]}/dist/index.js`) : null;
    },
  };
}

/**
 * Dev server only: serves the proving keys, ZKIR and manifest at /zk/ for
 * wallet mode. The production build (GitHub Pages) ships none of them, so
 * wallet mode needs a local run. Files are streamed; a miss is logged with the
 * path asked for, so a layout mismatch shows up at once.
 */
function zkArtifacts(): Plugin {
  return {
    name: 'tenant-proof-zk-artifacts',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0] ?? '';
        if (!url.startsWith('/zk/')) return next();
        const m = ZK_FILE_RE.exec(url);
        const file = m ? path.join(zkDir, m[1]!, m[2]!) : undefined;
        let stat: fs.Stats | undefined;
        try {
          stat = file ? fs.statSync(file) : undefined;
        } catch {
          stat = undefined;
        }
        if (!file || !stat?.isFile()) {
          server.config.logger.warn(`[zk] no artifact for ${url} (looked in contract/managed/tenant-proof; run npm run compile?)`);
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain');
          res.end('not found');
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
        res.setHeader('Content-Length', String(stat.size));
        const stream = fs.createReadStream(file);
        stream.on('error', (err) => {
          server.config.logger.error(`[zk] failed reading ${url}: ${err.message}`);
          res.destroy(err);
        });
        stream.pipe(res);
      });
    },
  };
}

// Mirrors the official Midnight UI template (midnight-examples,
// packages/mnkit/templates/ui/vite.config.ts).
export default defineConfig({
  // GitHub Pages serves the project at /tenant-proof/; local dev and the root domain use /.
  base: process.env['GITHUB_ACTIONS'] ? '/tenant-proof/' : '/',
  plugins: [
    react(),
    polyfillShims(),
    zkArtifacts(),
    // The onchain-runtime ships WebAssembly and loads it with top-level await.
    wasm(),
    topLevelAwait(),
    // Parts of the Midnight SDK reach for Node globals (Buffer, process).
    nodePolyfills({
      include: ['buffer', 'process', 'util', 'crypto', 'stream'],
      globals: { Buffer: true, process: true },
    }),
  ],
  // esbuild pre-bundling breaks the WASM loading in these packages.
  optimizeDeps: {
    exclude: [
      '@midnightntwrk/ledger-v9',
      '@midnightntwrk/onchain-runtime-v4',
      '@midnight-ntwrk/midnight-js-protocol',
    ],
  },
  server: {
    // Wallet mode's proof server: the one on this machine. The dev server
    // forwards /proof-server to it so the page needs no CORS from it. Proving
    // `apply` can take minutes, so the proxy waits longer than the SDK's 300 s.
    proxy: {
      '/proof-server': {
        target: 'http://127.0.0.1:6300',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/proof-server/, ''),
        timeout: 330_000,
        proxyTimeout: 330_000,
      },
    },
    fs: {
      // The compiled contract and shared helpers live one level up.
      allow: [path.resolve(here, '..')],
    },
  },
  build: {
    target: 'esnext',
  },
});
