/**
 * `POST /api/orders` — start a purchase — and `GET /api/orders/:id` — the order
 * the status page shows (technical-considerations §2.3, functional spec §2.2 and
 * §2.6).
 *
 * The controller does two things and nothing else: turn an unvalidated JSON body
 * into a SKU, and turn a service result into an HTTP status. The decisions live
 * in {@link OrdersService}; the mapping lives here, so the service stays
 * callable from the Phase 2 race scripts without an HTTP layer's opinions
 * attached.
 *
 * `/api` is on the controller, as `CatalogController` and `HealthController`
 * carry it, and there is deliberately no `setGlobalPrefix("api")` — the supplier
 * A stub answers outside `/api`, at `POST /internal/suppliers/a/issue`.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  UnprocessableEntityException,
} from "@nestjs/common";

import { CreateOrderOutcome, FindOrderOutcome, OrdersService } from "./orders.service.js";
import type { CreatedOrder, CreateOrderRequest, OrderView } from "./orders.types.js";

/**
 * Parse the request body — `{ sku: string }`, and **only** `sku` is read.
 *
 * ### Extra fields are ignored, not rejected
 *
 * A body of `{ "sku": "KEY-CS2-PRIME", "amount_minor": 1, "discount": 99 }`
 * creates an ordinary order at the catalogue price. That is a deliberate choice
 * over a whitelist that would `400` on unknown keys:
 *
 *   - **It is the honest shape of the guarantee.** The price is not "validated
 *     against" anything the client sent; it is read from `products` inside the
 *     INSERT, and there is no code path that could consult a body field. A
 *     rejection would suggest the field was meaningful enough to argue with.
 *   - **It stays true as the request grows.** Phase 2 adds an `Idempotency-Key`
 *     *header* and Phase 5 adds a promo *code* the server prices; neither turns
 *     a client-supplied number into money, and neither needs this function to
 *     change its stance.
 *
 * Hand-written rather than `class-validator` + `ValidationPipe`: this is one
 * required string, and `packages/contracts` is deliberately free of validation
 * frameworks (`apps/web` bundles it into a browser). A decorator stack here
 * would be more machinery than the rule it enforces.
 *
 * The SKU is passed through **verbatim** — not trimmed, not upper-cased. A SKU
 * with a stray space is not a SKU this shop sells, and it gets the same answer
 * as any other unknown one rather than being quietly repaired into a different
 * request than the client made.
 */
function parseCreateOrderRequest(body: unknown): CreateOrderRequest {
  if (typeof body !== "object" || body === null || !("sku" in body)) {
    throw new BadRequestException('expected a JSON body of the form { "sku": string }');
  }

  const { sku } = body;

  if (typeof sku !== "string" || sku === "") {
    throw new BadRequestException('"sku" must be a non-empty string');
  }

  return { sku };
}

/** Exhaustiveness guard: the compiler routes here only if an outcome went unhandled. */
function assertNever(value: never): never {
  throw new Error(`orders: unhandled service outcome ${JSON.stringify(value)}`);
}

@Controller("api/orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /**
   * Create an order for the given SKU.
   *
   * **`201` with the order** — Nest's default for `@Post`, and the right one:
   * the request created a resource that did not exist before. No `@HttpCode`
   * override, since the default already says what happened. Phase 2's
   * `Idempotency-Key` adds the one case that answers `200` instead — a repeat
   * that returns the *original* order, because that request created nothing
   * (architecture.md §3, I1).
   *
   * ### `422`, not `404`, for a SKU the shop will not sell
   *
   * `404` is a statement about the **request target**, and `/api/orders` is a
   * route that exists and is working. Answering `404` from it would be
   * indistinguishable, to any client, from the API not being deployed — and
   * would send a frontend developer looking at routing for a problem that is in
   * the body they sent.
   *
   * `422 Unprocessable Content` says what actually happened, in RFC 9110's own
   * words: the content type is understood and the syntax is correct, but the
   * server "was unable to process the contained instructions". The body is a
   * well-formed create-order instruction naming something not for sale.
   *
   * Unknown SKU and display-only SKU share the code, because they are one fact —
   * *there is no purchasable product with that SKU* — and one fix: the shop page
   * renders «Купить» only where `GET /api/products` says `purchasable`, so
   * neither is reachable through the UI. Nine of the twelve catalogue items are
   * display-only in this phase (assumption A4).
   *
   * A malformed body — no `sku`, or a `sku` that is not a non-empty string —
   * is a `400` from {@link parseCreateOrderRequest} instead. The split is the
   * ordinary one: `400` for an instruction the server cannot read, `422` for one
   * it read and cannot carry out.
   *
   * Both bodies are Nest's standard error envelope
   * (`{ statusCode, error, message }`) and both messages are English. They are
   * developer-facing: functional spec §2.8 governs what a *shopper* reads, and
   * every string a shopper reads is rendered by `apps/web` in Russian, never
   * echoed from an API error.
   */
  @Post()
  async createOrder(@Body() body: unknown): Promise<CreatedOrder> {
    const { sku } = parseCreateOrderRequest(body);

    const result = await this.orders.createOrder(sku);

    switch (result.outcome) {
      case CreateOrderOutcome.Created:
        return result.order;

      case CreateOrderOutcome.ProductNotPurchasable:
        throw new UnprocessableEntityException(`no purchasable product with sku "${result.sku}"`);

      default:
        return assertNever(result);
    }
  }

  /**
   * One order, as the status page renders it — product name, amount, current
   * state, and the key once it has one (functional spec §2.2 and §2.6).
   *
   * This is the endpoint `apps/web` polls once a second while the order is in
   * flight and stops calling when it settles (technical-considerations §2.6).
   * The stop condition is `status` read through `isSettledOrderStatus` from
   * `@game-shop/contracts`; see {@link OrderView} for why no `settled` flag is
   * put on the wire.
   *
   * ### `404`, and here it really is about the request target
   *
   * `/api/orders/{id}` names a specific order, so an id that identifies nothing
   * is precisely what `404` means — unlike the `422` on creation above, where
   * the route existed and the *body* named something unsellable. Functional spec
   * §2.6 asks for it directly: *"they see a message telling them the order could
   * not be found, rather than a blank or broken page"*.
   *
   * The body is Nest's standard error envelope, the same one this controller's
   * `400` and `422` use:
   *
   *   { "message": "no order with id \"ord_bogus\"", "error": "Not Found",
   *     "statusCode": 404 }
   *
   * **The frontend renders «Заказ не найден» from the status code, not from
   * that message.** The message is developer-facing English, as
   * `createOrder`'s are: functional spec §2.8 governs what a *shopper* reads,
   * and every string a shopper reads is written by `apps/web` in Russian rather
   * than echoed out of an API error. Sending Russian from here would put the
   * shopper-facing copy in two codebases.
   *
   * ### No format check on the id
   *
   * `ord_` + ULID is what `./order-id.ts` mints, but this route does not
   * reject an id that fails to look like one. It would be a second reason to
   * answer `404` that produces exactly the same answer as the first — the
   * `WHERE id = $2` already matches nothing — while adding a rule that has to
   * stay true of every id the system has ever issued. The id reaches Postgres as
   * a bound parameter, so a malformed one is a miss, not a hazard.
   */
  @Get(":id")
  async getOrder(@Param("id") id: string): Promise<OrderView> {
    const result = await this.orders.findOrder(id);

    switch (result.outcome) {
      case FindOrderOutcome.Found:
        return result.order;

      case FindOrderOutcome.NotFound:
        throw new NotFoundException(`no order with id "${result.orderId}"`);

      default:
        return assertNever(result);
    }
  }
}
