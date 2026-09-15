import { Controller, Get, Inject } from "@nestjs/common";

import { SUPPLIER_A_CONFIG, type SupplierEndpointConfig } from "./config/supplier-config.js";
import { INSTANCE_ID } from "./instance-identity.js";

export interface HealthResponse {
  readonly status: "ok";
  readonly service: "api";
  /**
   * This process's `INSTANCE_ID`, the same value the `x-instance-id` header
   * carries — repeated in the body so a caller can check the two against each
   * other, and so a reviewer reading a JSON body sees it without inspecting
   * headers. See `./instance-identity.ts` for what it does and does not prove.
   */
  readonly instance_id: string;
  /** Where this process runs: inside a Vercel function, or a Node process that owns a port. */
  readonly runtime: "vercel" | "node";
  /**
   * The deadline the issuance client puts on every supplier call, in
   * milliseconds — `SUPPLIER_TIMEOUT_MS` as this instance parsed it. Published
   * because the timeout-trap race check (`scripts/race/recover-timeout.ts`)
   * arms a supplier hang that must *outlast* the target's deadline
   * (`./config/supplier-config.ts`, "THE ORDERED CHAIN"), and against a live
   * target the runner cannot read that target's environment: a hang derived
   * from the local `2000` against a deployment running `5000` would never time
   * out, and the check would pass having exercised nothing (R8). Reading it
   * from here makes the check honest wherever it points.
   */
  readonly supplier_timeout_ms: number;
}

/**
 * The scaffold's liveness route, and since spec 006 the deployment's boot
 * probe (technical-considerations §2.1).
 *
 * It exists so the application can be proven to boot and serve before any
 * domain module is added, and it stays useful afterwards as the check the
 * local stack and the deployment both hit. On Vercel it is the operator's
 * first `curl` after a deploy: the config providers validate the environment
 * while the container is built, so `200` with an `instance_id` means the
 * container built and the variables it needs were usable; a `503 {
 * "status": "misconfigured" }` from `./vercel.ts` means they were not, and the
 * body names which.
 *
 * `supplier_timeout_ms` is injected from `SUPPLIER_A_CONFIG` — the token
 * `../issuance/supplier.client.ts` itself hands to `AbortSignal.timeout` — so
 * the number published here is the one the client actually waits, not a
 * second read of the variable that could drift from it. A and B read the same
 * variable (`SUPPLIER_TIMEOUT_MS` is deliberately shop-wide), so one value
 * describes both.
 */
@Controller("api")
export class HealthController {
  constructor(
    @Inject(SUPPLIER_A_CONFIG) private readonly supplierA: SupplierEndpointConfig,
  ) {}

  @Get("health")
  getHealth(): HealthResponse {
    return {
      status: "ok",
      service: "api",
      instance_id: INSTANCE_ID,
      // The platform's own marker, for the reason `./scheduling/scheduling.module.ts`
      // gives: the question is "is there a platform holding the process's
      // lifetime", not "is this production".
      runtime: process.env["VERCEL"] === "1" ? "vercel" : "node",
      supplier_timeout_ms: this.supplierA.timeoutMs,
    };
  }
}
