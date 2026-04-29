import { createLogger, defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const polyfillShim = (name: "buffer" | "global" | "process") =>
  new URL(`./node_modules/vite-plugin-node-polyfills/shims/${name}/dist/index.js`, import.meta.url)
    .pathname;
const lodashShim = (name: string) =>
  new URL(`./src/shims/lodash/${name}.ts`, import.meta.url).pathname;

const logger = createLogger();
const warn = logger.warn;
const warnOnce = logger.warnOnce;
const isIgnorableSourcemapWarning = (msg: string) =>
  msg.includes("points to missing source files") ||
  msg.includes("Failed to load source map for");

logger.warn = (msg, options) => {
  if (isIgnorableSourcemapWarning(msg)) return;
  warn(msg, options);
};

logger.warnOnce = (msg, options) => {
  if (isIgnorableSourcemapWarning(msg)) return;
  warnOnce(msg, options);
};

export default defineConfig({
  customLogger: logger,
  plugins: [
    react(),
    // Mesh's transaction builder pulls in Node-only globals (Buffer,
    // global, process). Polyfill them so the browser bundle works — same
    // recipe used by Mesh's own example apps.
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    fs: {
      // Allow Vite to follow the file: symlinks into the sibling x402/ repo
      // two levels up (x402-cardano-demo/frontend → x402-cardano-demo → parent).
      allow: ["../.."],
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 5173,
  },
  resolve: {
    preserveSymlinks: false,
    alias: [
      { find: /^bech32$/, replacement: new URL("./src/shims/bech32.ts", import.meta.url).pathname },
      { find: /^blake2b$/, replacement: new URL("./src/shims/blake2b.ts", import.meta.url).pathname },
      { find: /^libsodium-wrappers-sumo$/, replacement: new URL("./src/shims/libsodium-wrappers-sumo.ts", import.meta.url).pathname },
      { find: /^pbkdf2$/, replacement: new URL("./src/shims/pbkdf2.ts", import.meta.url).pathname },
      { find: /^lodash\/difference\.js$/, replacement: lodashShim("difference") },
      { find: /^lodash\/groupBy\.js$/, replacement: lodashShim("groupBy") },
      { find: /^lodash\/isEqual\.js$/, replacement: lodashShim("isEqual") },
      { find: /^lodash\/isUndefined\.js$/, replacement: lodashShim("isUndefined") },
      { find: /^lodash\/last\.js$/, replacement: lodashShim("last") },
      { find: /^lodash\/memoize\.js$/, replacement: lodashShim("memoize") },
      { find: /^lodash\/merge\.js$/, replacement: lodashShim("merge") },
      { find: /^lodash\/minBy\.js$/, replacement: lodashShim("minBy") },
      { find: /^lodash\/orderBy\.js$/, replacement: lodashShim("orderBy") },
      { find: /^lodash\/pick\.js$/, replacement: lodashShim("pick") },
      { find: /^lodash\/sum\.js$/, replacement: lodashShim("sum") },
      { find: /^lodash\/transform\.js$/, replacement: lodashShim("transform") },
      { find: /^lodash\/uniq\.js$/, replacement: lodashShim("uniq") },
      { find: /^lodash\/uniqBy\.js$/, replacement: lodashShim("uniqBy") },
      { find: /^lodash\/uniqWith\.js$/, replacement: lodashShim("uniqWith") },
      { find: /^serialize-error$/, replacement: new URL("./src/shims/serialize-error.ts", import.meta.url).pathname },
      { find: "vite-plugin-node-polyfills/shims/buffer", replacement: polyfillShim("buffer") },
      { find: "vite-plugin-node-polyfills/shims/global", replacement: polyfillShim("global") },
      { find: "vite-plugin-node-polyfills/shims/process", replacement: polyfillShim("process") },
    ],
  },
  optimizeDeps: {
    exclude: [
      // Only exclude packages Vite genuinely cannot pre-bundle:
      // core-csl ships WASM binaries that esbuild cannot process.
      "@meshsdk/core-csl",
      // Local workspace symlinks — keep excluded to preserve live resolution.
      "@x402/core",
      "@x402/cardano",
      // Everything else (@meshsdk/core, @meshsdk/react, …) is intentionally
      // NOT excluded: Vite pre-bundles them and converts all their CJS
      // transitive deps (blakejs, fraction.js, ip-address, @harmoniclabs/cbor,
      // …) to ESM in one pass, avoiding per-package whack-a-mole errors.
    ],
  },
});
