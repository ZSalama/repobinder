import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const webRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  build: {
    outDir: path.resolve(webRoot, "../../dist-web"),
    emptyOutDir: true,
  },
});
