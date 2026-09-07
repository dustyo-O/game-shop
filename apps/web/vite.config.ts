import { defineConfig } from "vite";

const DEFAULT_WEB_PORT = 5173;
const DEFAULT_API_PORT = 3000;

const webPort = Number(process.env["WEB_PORT"] ?? DEFAULT_WEB_PORT);

/**
 * Where the dev server forwards API traffic. Set by `WEB_API_BASE_URL`, which
 * `scripts/with-env.ts` loads before Vite starts.
 */
const apiTarget =
  process.env["WEB_API_BASE_URL"] ??
  `http://localhost:${process.env["API_PORT"] ?? DEFAULT_API_PORT}`;

/**
 * The browser always calls same-origin relative paths (`/api/...`), and the dev
 * server proxies them to the API. That is the same shape the deployment has,
 * where a Vercel rewrite sends `/api/*` to the Nest function on the site's own
 * origin — so no API base is ever baked into the bundle, and there is no CORS
 * configuration in development that production would not have.
 */
const apiProxy = {
  "/api": { target: apiTarget, changeOrigin: false },
  // The supplier stubs are reached over real HTTP by the API, not by the
  // browser; proxied anyway so the race and recovery scripts can drive them
  // through one origin.
  "/internal": { target: apiTarget, changeOrigin: false },
};

export default defineConfig({
  server: {
    host: true,
    port: webPort,
    proxy: apiProxy,
  },
  preview: {
    host: true,
    port: webPort,
    proxy: apiProxy,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
