import { Module } from "@nestjs/common";

import { CatalogModule } from "./catalog/catalog.module.js";
import { ConfigModule } from "./config/config.module.js";
import { HealthController } from "./health.controller.js";
import { OrdersModule } from "./orders/orders.module.js";
import { PaymentsModule } from "./payments/payments.module.js";
import { SupplierAModule } from "./suppliers/a/supplier-a.module.js";

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
  // `SupplierAModule` is the odd one out and should stay that way: it is not a
  // part of the shop, it is the simulated supplier hosted in the same function
  // (architecture.md §6). It answers at `POST /internal/suppliers/a/issue`,
  // outside the `/api` namespace every other controller carries, and it exports
  // nothing — the shop reaches it over HTTP through `SUPPLIER_A_URL`, never
  // through this container. Listing it here buys it a route and a database
  // connection and deliberately nothing else.
  imports: [ConfigModule, CatalogModule, OrdersModule, PaymentsModule, SupplierAModule],
  controllers: [HealthController],
})
export class AppModule {}
