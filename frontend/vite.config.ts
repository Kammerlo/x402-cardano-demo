// Buffer polyfill: @x402/cardano's browser path and our base64 handling use
// Buffer, which Vite does not provide by default.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [react(), nodePolyfills({ globals: { Buffer: true } })],
  // @x402/* deps are npm `file:` links into the sibling ../x402 pnpm
  // workspace. Without this, Vite/Rollup resolve their imports against the
  // symlink target (outside this project's node_modules), which breaks the
  // node-polyfills plugin's build-time Buffer injection (it can't find
  // "vite-plugin-node-polyfills/shims/buffer" from outside our node_modules).
  resolve: { preserveSymlinks: true },
});
