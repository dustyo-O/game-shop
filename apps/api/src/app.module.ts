import { Module } from "@nestjs/common";

import { AdminModule } from "./admin/admin.module.js";
import { CatalogModule } from "./catalog/catalog.module.js";
import { ConfigModule } from "./config/config.module.js";
import { HealthController } from "./health.controller.js";
import { OrdersModule } from "./orders/orders.module.js";
import { PaymentsModule } from "./payments/payments.module.js";
import { SchedulingModule } from "./scheduling/scheduling.module.js";
import { SupplierAModule } from "./suppliers/a/supplier-a.module.js";
import { SupplierBModule } from "./suppliers/b/supplier-b.module.js";
import { SupplierBehaviourModule } from "./suppliers/supplier-behaviour.module.js";

@Module({
  // `ConfigModule` is listed first and holds no routes. It is here so the
  // environment is checked while the container is built rather than when a
  // value is first needed: a supplier URL that is missing, unparseable or not
  // an http(s) address, or a `SUPPLIER_TIMEOUT_MS` that is not a positive whole
  // number, stops the boot with a named `ConfigurationError` instead of letting
  // the API come up healthy and fail on the first order somebody pays for.
  // Nothing injects `SUPPLIER_A_CONFIG` until Slice 5's issuance client, and
  // that is exactly why the module has to be imported here — Nest instantiates
  // a module's providers eagerly whether or not anything consumes them, so the
  // guarantee exists before the consumer does.
  //
  // `OrdersModule` now carries `POST /api/orders` as well as the status
  // transition helper that `payments` and `issuance` will call.
  //
  // `PaymentsModule` carries the webhook receiver, `POST /api/webhooks/payment`.
  // It now imports `OrdersModule` — a stored event is applied to its order
  // through the exported `OrderTransitionService`, which is the only way any
  // module may write `orders.status`.
  //
  // `SchedulingModule` is listed for the same reason `ConfigModule` is, and it
  // holds no routes either. `PaymentsModule` now injects
  // `CONTINUATION_SCHEDULER` — the webhook schedules its processing instead of
  // awaiting it — and imports this module itself, but this line stays and is
  // the load-bearing one. Being imported *here* is what pins the module at
  // distance 2 from the root, and Nest destroys modules in ascending distance —
  // so the continuation drain runs before `DatabaseModule` (distance 3, since
  // nothing imports it from the root) closes the connection pool, which is the
  // only order in which the drain can do any good. `PaymentsModule` is also at
  // distance 2, so its import does not move it. See the `onModuleDestroy`
  // comment in `./scheduling/tracked-continuation-scheduler.ts` for the rule
  // and the one import that would break it.
  //
  // `AdminModule` carries the operator's surface behind the shared bearer
  // token: `POST /api/admin/payment-events/sweep`, which is `architecture.md`
  // §4's fourth processing trigger and the backstop for whatever the other
  // three missed. Imported here rather than from `PaymentsModule` for the
  // ordinary reason — it is a top-level area of the API — and with one useful
  // consequence: at distance 2 its own imports (`ConfigModule` and
  // `PaymentsModule`, both already at 2) are not re-parented, so
  // `SchedulingModule` stays at 2 and the destroy order above is untouched.
  //
  // `SupplierAModule` and `SupplierBModule` are the odd ones out and should stay
  // that way: they are not part of the shop, they are the two simulated
  // suppliers hosted in the same function (architecture.md §6). They answer at
  // `POST /internal/suppliers/a/issue` and `POST /internal/suppliers/b/issue`,
  // outside the `/api` namespace every other controller carries, and they export
  // nothing — the shop reaches them over HTTP through `SUPPLIER_A_URL` and
  // `SUPPLIER_B_URL`, never through this container. Listing them here buys each
  // a route and a database connection and deliberately nothing else.
  //
  // Two modules rather than one with two controllers, and two entries here
  // rather than B importing A: two suppliers do not depend on each other, and a
  // reviewer reading this list should see two independent services. They do
  // share one key pool and one ledger, which is a fact about the *fixture*
  // (A4) — `supplier_keys` has no provider column — and it is recorded where it
  // has a visible consequence, in `./suppliers/b/supplier-b.controller.ts`.
  //
  // At distance 2 `SupplierBModule`'s only import (`DatabaseModule`, at 3) is
  // not re-parented, so `SchedulingModule` stays at 2 and the destroy order
  // above is untouched.
  //
  // `SupplierBehaviourModule` is on that same far side of the boundary and
  // exports nothing either. It carries the reviewer's console —
  // `PUT /internal/suppliers/:provider/behaviour`, behind the same
  // `AdminTokenGuard` the sweep sits behind — which is how spec 003 §2.7's
  // fourth criterion is met: a supplier can be made to fail on demand *without
  // changing the shop itself*. One route for every supplier rather than one per
  // stub, which is why it is a module here rather than a controller inside
  // `SupplierAModule`. At distance 2 its imports (`ConfigModule` at 2,
  // `DatabaseModule` at 3) are not re-parented, so `SchedulingModule` stays at
  // 2 and the destroy order above is untouched.
  imports: [
    ConfigModule,
    SchedulingModule,
    CatalogModule,
    OrdersModule,
    PaymentsModule,
    AdminModule,
    SupplierAModule,
    SupplierBModule,
    SupplierBehaviourModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
