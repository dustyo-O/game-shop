import { Controller, Get } from "@nestjs/common";

export interface HealthResponse {
  readonly status: "ok";
  readonly service: "api";
}

/**
 * The scaffold's liveness route. It exists so the application can be proven
 * to boot and serve before any domain module is added, and it stays useful
 * afterwards as the check the local stack and the deployment both hit.
 */
@Controller("api")
export class HealthController {
  @Get("health")
  getHealth(): HealthResponse {
    return { status: "ok", service: "api" };
  }
}
