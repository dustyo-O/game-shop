import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import type { NestExpressApplication } from "@nestjs/platform-express";

import { AppModule } from "./app.module.js";

const DEFAULT_PORT = 3000;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    new ExpressAdapter(),
  );

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
