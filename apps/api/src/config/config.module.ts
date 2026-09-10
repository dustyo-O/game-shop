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
 * THE TWO PROVIDERS HERE WHOSE ABSENCE IS NOT FATAL — FOR TWO DIFFERENT REASONS
 * ---------------------------------------------------------------------------
 * `ADMIN_TOKEN` joins `SUPPLIER_A_URL` and `SUPPLIER_TIMEOUT_MS` in being read
 * and checked while the container is built, and differs from both in what
 * happens when it is missing: the boot continues, loudly, and the endpoints
 * behind it fail closed with a `503`. The argument for that asymmetry is in
 * `./env.ts` ({@link readOptionalSecret}) and `./admin-token.ts`, and it comes
 * down to one line of `architecture.md` §4 — the four processing triggers are
 * layered *"so no single one is load-bearing"*, so an unconfigured admin token
 * costs a backstop rather than an order, and refusing to boot over it would
 * take the catalogue and the webhook down with it.
 *
 * `ALLOW_CLIENT_SUPPLIED_ORDER_ID` (`./client-supplied-order-id.ts`) is
 * unset-tolerant for a different, simpler reason: unset is not a degraded
 * state to report, it is the *only* state a real deployment should ever be
 * in. Nothing fails closed on its absence because there is nothing to fail —
 * `POST /api/orders` behaves exactly as it did before this file existed.
 *
 * What is *not* asymmetric, for either of them, is when the check runs. A
 * token that is present but too short to be a secret, or a flag set to
 * anything but `"true"`/`"false"`, still stops the boot from this module, at
 * the same moment a malformed `SUPPLIER_A_URL` would.
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

import { ADMIN_TOKEN_CONFIG, adminTokenConfigProvider } from "./admin-token.js";
import {
  CLIENT_SUPPLIED_ORDER_ID_CONFIG,
  clientSuppliedOrderIdConfigProvider,
} from "./client-supplied-order-id.js";
import { SUPPLIER_A_CONFIG, supplierAConfigProvider } from "./supplier-config.js";

@Module({
  providers: [supplierAConfigProvider, adminTokenConfigProvider, clientSuppliedOrderIdConfigProvider],
  exports: [SUPPLIER_A_CONFIG, ADMIN_TOKEN_CONFIG, CLIENT_SUPPLIED_ORDER_ID_CONFIG],
})
export class ConfigModule {}
