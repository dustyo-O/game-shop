/**
 * The database as a Nest provider.
 *
 * `@game-shop/db` already owns the hard decisions — a pool of exactly one
 * connection per function instance, no server-side prepared statements, one
 * process-wide client cached at module scope (see that package's `client.ts`
 * header). This module adds **nothing** to them. It exists for one reason: so a
 * controller or service receives the client through its constructor instead of
 * calling `getDatabaseClient()` at the point of use.
 *
 * Why that matters here rather than being ceremony:
 *
 *   - A service that imports the singleton directly cannot be constructed with
 *     a different one. Phase 1's integration and concurrency tests
 *     (technical-considerations §4) run against a real Postgres and need to
 *     hand a service a client with its own lifetime — `createDatabaseClient()`
 *     exists precisely for that — which is a provider override here and an
 *     unmockable import there.
 *   - Shutdown becomes a lifecycle event rather than something each entry point
 *     remembers to do. See {@link DatabaseModule.onModuleDestroy}.
 *
 * It deliberately does not wrap, re-export or "improve" the client's API.
 * `transaction()`, the `max: 1` policy and the no-prepared-statements rule all
 * stay where their reasoning is written down.
 *
 * **Not `@Global()`.** Every module that talks to the database says so in its
 * own `imports` — `catalog` does today; `orders`, `payments`, `issuance` and
 * `suppliers/a` will as they arrive. One line each, and in exchange the import
 * graph shows which modules touch storage.
 */
import { Module, type OnModuleDestroy, type Provider } from "@nestjs/common";

import { closeDatabaseClient, getDatabaseClient, type DatabaseClient } from "@game-shop/db";

/**
 * Injection token for the {@link DatabaseClient}.
 *
 * A symbol rather than a string: tokens live in one flat namespace per
 * application, and a symbol cannot collide with one a library picked.
 *
 * Inject it by naming both the token and the type, since neither can be
 * inferred from the other:
 *
 *     constructor(
 *       @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
 *     ) {}
 *
 * The whole client is provided, not just `client.db`, because the issuance and
 * webhook paths need `transaction()` and a read-only service is free to use
 * `database.db` and ignore the rest.
 */
export const DATABASE_CLIENT = Symbol("DATABASE_CLIENT");

/**
 * Hands out the process-wide client — the same instance a warm serverless
 * invocation reuses. Nest's own singleton scope is not what makes it single:
 * the module-level cache inside `@game-shop/db` is, which is why a script and
 * the API running in one process still share one pool.
 */
const databaseClientProvider: Provider = {
  provide: DATABASE_CLIENT,
  useFactory: (): DatabaseClient => getDatabaseClient(),
};

@Module({
  providers: [databaseClientProvider],
  exports: [DATABASE_CLIENT],
})
export class DatabaseModule implements OnModuleDestroy {
  /**
   * Drains the pool on shutdown.
   *
   * `closeDatabaseClient()` rather than `client.close()`: both end the pool,
   * but only the former also clears the module-level cache in `@game-shop/db`.
   * Calling `close()` alone would leave `getDatabaseClient()` handing out a
   * drained pool forever after — invisible in production, where the process
   * exits anyway, and a confusing hang in a test file that tears an
   * application down and builds another.
   *
   * Reached only when Nest's shutdown hooks are enabled, which `main.ts` does.
   */
  async onModuleDestroy(): Promise<void> {
    await closeDatabaseClient();
  }
}
