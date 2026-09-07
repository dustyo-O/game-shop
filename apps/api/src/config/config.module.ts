/**
 * `config` — environment values that have been checked, exposed as injectables.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE IS FOR
 * ---------------------------------------------------------------------------
 * Registering it in {@link AppModule} is what turns two documented strings in
 * `.env.example` into a boot-time guarantee. Nest instantiates every provider
 * declared here while it builds the container — eagerly, and without waiting
 * for anything to inject them — so a missing `SUPPLIER_A_URL` or a
 * `SUPPLIER_TIMEOUT_MS` of `"soon"` stops the process before `app.listen()`
 * rather than surfacing as a `500` on the first order somebody pays for.
 *
 * That distinction is the module's entire reason to exist today, because
 * **nothing injects `SUPPLIER_A_CONFIG` yet** — the issuance client is Slice 5.
 * A configuration provider with no consumers still runs, still validates, and
 * still refuses the boot, which is precisely the behaviour wanted: the shop
 * cannot come up unable to reach its supplier and look healthy while doing it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `@Global()`
 * ---------------------------------------------------------------------------
 * `DatabaseModule` is imported by each module that touches storage rather than
 * being global, "and in exchange the import graph shows which modules touch
 * storage" (`../database/database.module.ts`). The same trade applies here, and
 * matters more: which modules talk to a supplier is exactly the question the
 * boundary between the shop and `suppliers/a` exists to keep answerable. Slice
 * 5's issuance module will add one `imports` line and that line will be the
 * documentation.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 * `PAYMENT_WEBHOOK_URL` is still read in {@link PaymentSimulatorService}'s
 * constructor. It shares the readers in `./env.ts` — one copy of the parsing
 * and one message shape — but it is not moved behind a token, because a
 * default-scoped provider's constructor is instantiated at exactly the same
 * moment a factory here is, so the move would buy no earlier failure. It stays
 * where its reasoning is written down.
 *
 * `DATABASE_URL` is not here either: `@game-shop/db` validates it where the
 * pool is built, which is the only place that can also enforce `max: 1` and the
 * no-prepared-statements rule alongside it.
 *
 * Phase 3's supplier failure and timeout *rates* are read by the stub, not by
 * the shop — they belong to `suppliers/a`, above the claim service
 * (`../suppliers/a/supplier-a.controller.ts`), because they are the supplier
 * misbehaving rather than the shop being configured.
 */
import { Module } from "@nestjs/common";

import { SUPPLIER_A_CONFIG, supplierAConfigProvider } from "./supplier-config.js";

@Module({
  providers: [supplierAConfigProvider],
  exports: [SUPPLIER_A_CONFIG],
})
export class ConfigModule {}
