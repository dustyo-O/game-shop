/**
 * The local entry: build the container, hold a port, and answer signals.
 *
 * What `pnpm dev`, `dist/main.js` under the harness's four instances, and every
 * test process run. The container itself comes from `./create-app.ts`, which
 * `./vercel.ts` calls too — the two entries differ only in what happens after
 * the application exists: this one listens and has a lifetime; that one
 * answers `(req, res)` and has neither.
 */
import { createApp } from "./create-app.js";

const DEFAULT_PORT = 3000;

async function bootstrap(): Promise<void> {
  const app = await createApp();

  // Without this, Nest never runs `onModuleDestroy` on SIGINT/SIGTERM, and
  // `DatabaseModule`'s pool drain would be dead code: Ctrl-C on the dev server
  // would leave the connection to be reaped by the server's own timeout rather
  // than closed. Costs one signal listener per shutdown signal.
  app.enableShutdownHooks();

  const port = Number(process.env["API_PORT"] ?? DEFAULT_PORT);
  await app.listen(port);
  console.log(`api listening on http://localhost:${port}`);
}

void bootstrap();
