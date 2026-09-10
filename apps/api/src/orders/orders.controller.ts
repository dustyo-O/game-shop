/**
 * `POST /api/orders` — start a purchase — and `GET /api/orders/:id` — the order
 * the status page shows (technical-considerations §2.3, functional spec §2.2 and
 * §2.6).
 *
 * The controller does two things and nothing else: turn an unvalidated JSON body
 * and an optional `Idempotency-Key` header into a SKU and a key, and turn a
 * service result into an HTTP status. The decisions live in
 * {@link OrdersService}; the mapping lives here, so the service stays callable
 * from the race scripts without an HTTP layer's opinions attached.
 *
 * The header is I1's half of this file (`architecture.md` §3): it names the
 * shopper's purchase *intent*, and what makes one intent produce one order is
 * the UNIQUE index it is stored behind, not anything decided here. This file
 * only validates that the header can be a key at all and translates the
 * service's verdict into `201` or `200`.
 *
 * `/api` is on the controller, as `CatalogController` and `HealthController`
 * carry it, and there is deliberately no `setGlobalPrefix("api")` — the supplier
 * A stub answers outside `/api`, at `POST /internal/suppliers/a/issue`.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Res,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { Response } from "express";

import {
  CLIENT_SUPPLIED_ORDER_ID_CONFIG,
  type ClientSuppliedOrderIdConfig,
} from "../config/client-supplied-order-id.js";
import { CreateOrderOutcome, FindOrderOutcome, OrdersService } from "./orders.service.js";
import type { CreateOrderRequest, CreateOrderResponse, OrderView } from "./orders.types.js";

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
 * `id` is a **deliberate exception** to that stance, and is read separately by
 * {@link parseRequestedOrderId} rather than here — see that function's doc
 * comment, and `CreateOrderRequest.id`, for why a field that could genuinely be
 * honoured cannot share this function's "ignore it" answer.
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

/**
 * The header this endpoint reads the shopper's purchase *intent* from — I1,
 * `architecture.md` §3.
 *
 * Spelled as the de-facto standard sends it. Matching is case-insensitive
 * either way: `@Headers()` lower-cases the name before looking it up, because
 * HTTP field names are case-insensitive and Node has already normalised them.
 */
const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/**
 * The longest `Idempotency-Key` this endpoint will accept: **255 characters**.
 *
 * Three reasons, in the order they matter:
 *
 *   1. **It is far above anything a client would legitimately mint.** A UUIDv4
 *      is 36 characters and a ULID is 26 — the two formats a browser has for
 *      free. 255 leaves room for a prefixed or composite key several times over
 *      without ever being the thing a well-behaved caller trips on.
 *   2. **It is the value the ecosystem already uses.** Stripe caps
 *      `Idempotency-Key` at 255 characters, so a client library written against
 *      any other API is already inside this bound.
 *   3. **The column is indexed, and a btree index entry is not unbounded.**
 *      `client_request_id` is `text` with a UNIQUE index behind it, and an
 *      index entry may not exceed a third of an 8 kB page. Measured against the
 *      live index rather than taken from the manual — a 3 200-character random
 *      key raises
 *
 *        ERROR: index row size 3216 exceeds btree version 4 maximum 2704
 *               for index "orders_client_request_id_key"
 *
 *      and an idempotency key is precisely the kind of value that hits it,
 *      because a good one is random and therefore incompressible (a key of
 *      3 000 repeated characters slips through — pglz shrinks it before the
 *      index sees it — which is why the limit cannot be reasoned about from
 *      length alone). Without a ceiling here a client could turn that into a
 *      `500` out of the very constraint that is protecting it: a database error
 *      raised by client input, which is the shape of an availability bug. 255
 *      keeps every stored value an order of magnitude clear of it.
 *
 * Characters, not bytes, and the two are the same here: Node decodes header
 * values as latin1, so one character of a header value is one byte of it.
 */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * Read the `Idempotency-Key` header — `null` when it was not sent.
 *
 * ### Absent is not malformed
 *
 * No header is Phase 1's path and stays a `201`: `client_request_id` is written
 * as NULL, and a Postgres UNIQUE index accepts any number of NULLs because it
 * holds them to be distinct from one another. Existing callers and scripts that
 * predate the header keep working unchanged, which is the whole reason the
 * header is optional (technical-considerations §2.1, assumption A3).
 *
 * ### What is rejected, and why each one
 *
 *   - **Empty, or nothing but whitespace.** `""` is not a value, and `"   "` is
 *     the same mistake with the evidence still attached — both are a client that
 *     built a key from something missing. Storing either would put a key in the
 *     unique index that the *next* such client would collide with, handing a
 *     shopper somebody else's order. That is the one failure this endpoint must
 *     never produce, so a key that means nothing is refused rather than stored.
 *   - **Longer than {@link MAX_IDEMPOTENCY_KEY_LENGTH}.** See that constant.
 *
 * A `400` for all of them, not a `422`: the header cannot be read as a key at
 * all, which is `400`'s job here exactly as a body with no `sku` is
 * ({@link parseCreateOrderRequest}). Re-sending the identical bytes would fail
 * identically, so the answer stops the client rather than inviting a retry.
 *
 * ### Stored verbatim, never repaired
 *
 * A key that survives the checks is written to the column exactly as it
 * arrived — not trimmed, not lower-cased. Same stance as the SKU above, and
 * here it is load-bearing rather than stylistic: trimming would make `"k"` and
 * `"k "` the same intent, so a client that sent one and retried with the other
 * would be *given* an order it did not ask for. Rejecting a key that is nothing
 * but whitespace and altering one that merely contains some are different acts;
 * this does the first and not the second.
 *
 * The parameter is `unknown` rather than `string | undefined` because
 * `@Headers()` hands back whatever was on the wire. Node collapses a repeated
 * header into one comma-joined string, so that case arrives here as an ordinary
 * (if odd) key and is treated as one — deterministic, and still one key per
 * intent.
 */
function parseIdempotencyKey(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestException(`"${IDEMPOTENCY_KEY_HEADER}" must be a non-empty string`);
  }

  if (value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new BadRequestException(
      `"${IDEMPOTENCY_KEY_HEADER}" must be at most ${String(MAX_IDEMPOTENCY_KEY_LENGTH)} characters`,
    );
  }

  return value;
}

/**
 * The longest client-supplied order `id` this endpoint will accept: **255
 * characters**, for the same reason as {@link MAX_IDEMPOTENCY_KEY_LENGTH} —
 * `orders.id` is `text` behind an (implicit, primary-key) btree index, and that
 * index has the identical row-size ceiling `client_request_id`'s does. A real
 * id (`ord_` + ULID, `./order-id.ts`) is 30 characters; 255 leaves generous
 * headroom for anything a seed or a race script would plausibly mint while
 * staying nowhere near the ceiling that turned an oversized idempotency key
 * into a `500` — see that constant's own comment for the measured error.
 */
const MAX_REQUESTED_ORDER_ID_LENGTH = 255;

/**
 * Read the body's `id` field — `undefined` when it should be ignored, meaning
 * "mint one as usual".
 *
 * ### Why this is not folded into {@link parseCreateOrderRequest}
 *
 * That function's entire stance is "extra fields are ignored, not rejected",
 * stated once and true of everything the body might carry — **except** this
 * one field, whose correct handling depends on {@link config} and is "reject",
 * not "ignore", on one of the two branches. Splitting it into its own function
 * keeps `parseCreateOrderRequest`'s doc comment honest rather than growing an
 * exception clause into a rule that is supposed to be unconditional.
 *
 * ### Why `id` present + flag off is `400`, not silently ignored
 *
 * Every other extra field a client might send — `amount_minor`, `discount` —
 * can **never** be honoured, by any caller, under any configuration: the
 * server never reads a client-supplied number, so dropping them costs a
 * well-behaved client nothing it could have had, and silence is the honest
 * answer. `id` breaks that symmetry, because it genuinely *would* be honoured
 * with the flag on. A caller that sends it while the flag is off — realistically
 * a misconfigured seed or `scripts/race/before-order.ts`, never a shopper, since
 * `apps/web` never sends this field — must not be told `201` while a random id
 * was substituted underneath the one it asked for. That is a silent, confusing
 * failure for exactly the one caller this field exists to serve, so it is
 * refused instead, naming the environment variable that would turn it on.
 *
 * ### Validation, when the flag is on
 *
 * The same shape check as the SKU in {@link parseCreateOrderRequest} — a
 * non-empty string — plus {@link MAX_REQUESTED_ORDER_ID_LENGTH}. Passed through
 * **verbatim**, not trimmed: the same "never repaired" stance as the SKU and
 * the idempotency key above, and load-bearing here specifically, because this
 * id must byte-for-byte match whatever `scripts/race/before-order.ts` already
 * named in an earlier webhook payload — trimming would silently create two
 * different identities out of one script's two calls.
 */
function parseRequestedOrderId(
  body: unknown,
  config: ClientSuppliedOrderIdConfig,
): string | undefined {
  if (typeof body !== "object" || body === null || !("id" in body) || body.id === undefined) {
    return undefined;
  }

  if (!config.enabled) {
    throw new BadRequestException(
      '"id" is not accepted unless ALLOW_CLIENT_SUPPLIED_ORDER_ID is set (see .env.example)',
    );
  }

  const { id } = body;

  if (typeof id !== "string" || id === "") {
    throw new BadRequestException('"id" must be a non-empty string');
  }

  if (id.length > MAX_REQUESTED_ORDER_ID_LENGTH) {
    throw new BadRequestException(
      `"id" must be at most ${String(MAX_REQUESTED_ORDER_ID_LENGTH)} characters`,
    );
  }

  return id;
}

/** Exhaustiveness guard: the compiler routes here only if an outcome went unhandled. */
function assertNever(value: never): never {
  throw new Error(`orders: unhandled service outcome ${JSON.stringify(value)}`);
}

@Controller("api/orders")
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    /**
     * Whether `id` in the request body is honoured — see
     * `../config/client-supplied-order-id.ts`. Injected here rather than read
     * per request: the value was already proven safe (a boolean, never a
     * malformed one) while Nest built the container, and `parseRequestedOrderId`
     * below only ever asks `config.enabled`.
     */
    @Inject(CLIENT_SUPPLIED_ORDER_ID_CONFIG)
    private readonly clientSuppliedOrderId: ClientSuppliedOrderIdConfig,
  ) {}

  /**
   * Create an order for the given SKU — or hand back the one this
   * `Idempotency-Key` already created.
   *
   * ---------------------------------------------------------------------------
   * `201` MEANS "I CREATED IT"; `200` MEANS "I FOUND IT"
   * ---------------------------------------------------------------------------
   * | Case                                        | Answer                    |
   * | -------------------------------------------- | ------------------------- |
   * | No header                                    | `201`, order created      |
   * | Header, first use                             | `201`, order created      |
   * | Header, already used                          | `200`, **original order** |
   * | Header, empty or over-long                    | `400`                     |
   * | SKU not purchasable                           | `422`                     |
   * | `id` present, `ALLOW_CLIENT_SUPPLIED_ORDER_ID` off | `400`                 |
   * | `id` present and valid, flag on, id free      | `201`, that id echoed     |
   * | `id` present, flag on, id already exists      | `409`                     |
   *
   * The `201`/`200` split is the point of the header, not a nicety. A caller
   * that cannot tell "created" from "found" cannot detect its own retry — it
   * has no way to know whether the network ate its first request or its first
   * request worked — and idempotency it cannot observe is idempotency it cannot
   * rely on. `201` is also simply the honest code: a request that created no
   * resource has no business claiming it did.
   *
   * Both bodies carry the same five fields ({@link CreateOrderResponse}), so a
   * client reads `id` and navigates without branching. Only the *status* of the
   * order can differ, and only on the `200` path — see `ExistingOrder` in
   * `./orders.types.ts`.
   *
   * ### Why `@Res({ passthrough: true })` and not `@HttpCode`
   *
   * `@HttpCode` is fixed at decoration time and this endpoint's code is decided
   * per request. Passthrough is the narrow escape hatch for exactly that: Nest
   * sets the route's default status **before** the handler runs and then, for a
   * passthrough handler, serialises the returned value **without** re-applying
   * it (`RouterExecutionContext.createHandleResponseFn` passes no status code in
   * that path). So `response.status(...)` inside the handler is the last word,
   * while everything else — serialisation, interceptors, the exception filter
   * that renders the `400`/`422` below — is still Nest's. The alternative, a
   * bare `@Res()`, would hand this method the whole response object and take
   * those with it.
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
   * **A `422` never displaces a `200`.** The service tells the two zero-row
   * causes apart before answering, so a legitimate retry whose SKU has since
   * been withdrawn still gets its order rather than a rejection — see
   * {@link OrdersService.createOrder}.
   *
   * A malformed body — no `sku`, or a `sku` that is not a non-empty string — is
   * a `400` from {@link parseCreateOrderRequest}, and a malformed header a `400`
   * from {@link parseIdempotencyKey}. The split is the ordinary one: `400` for
   * an instruction the server cannot read, `422` for one it read and cannot
   * carry out.
   *
   * ### `409`, for the one new case: a requested `id` that already exists
   *
   * Reachable only with `ALLOW_CLIENT_SUPPLIED_ORDER_ID` set and only when the
   * caller names an id another order is already using — see
   * {@link parseRequestedOrderId} for why the field is honoured at all, and
   * {@link OrdersService.createOrder}'s `OrderIdAlreadyExists` outcome for the
   * database error this maps. `409 Conflict` rather than `422`: the request is
   * perfectly processable in general, it collides with one specific existing
   * resource, which is exactly what `409` is for.
   *
   * Both bodies are Nest's standard error envelope
   * (`{ statusCode, error, message }`) and both messages are English. They are
   * developer-facing: functional spec §2.8 governs what a *shopper* reads, and
   * every string a shopper reads is rendered by `apps/web` in Russian, never
   * echoed from an API error.
   */
  @Post()
  async createOrder(
    @Body() body: unknown,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CreateOrderResponse> {
    const { sku } = parseCreateOrderRequest(body);
    const clientRequestId = parseIdempotencyKey(idempotencyKey);
    const requestedOrderId = parseRequestedOrderId(body, this.clientSuppliedOrderId);

    const result = await this.orders.createOrder(sku, clientRequestId, requestedOrderId);

    switch (result.outcome) {
      case CreateOrderOutcome.Created:
        // Nest's `@Post` default, already set on the response before this
        // handler ran. Left alone rather than re-asserted, so there is exactly
        // one line in this method that touches the status code.
        return result.order;

      case CreateOrderOutcome.AlreadyCreated:
        response.status(HttpStatus.OK);
        return result.order;

      case CreateOrderOutcome.ProductNotPurchasable:
        throw new UnprocessableEntityException(`no purchasable product with sku "${result.sku}"`);

      case CreateOrderOutcome.OrderIdAlreadyExists:
        throw new ConflictException(`order id "${result.orderId}" already exists`);

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
