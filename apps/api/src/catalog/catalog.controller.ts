/**
 * `GET /api/products` — the catalogue the shop page lists
 * (technical-considerations §2.3, functional spec §2.1).
 */
import { Controller, Get } from "@nestjs/common";

import { CatalogService } from "./catalog.service.js";
import type { CatalogProduct } from "./catalog.types.js";

/**
 * The `/api` prefix is on the controller, exactly as `HealthController` carries
 * it, and there is deliberately **no** `setGlobalPrefix("api")` in `main.ts`:
 * the supplier A stub answers at `POST /internal/suppliers/a/issue`, outside
 * `/api`, because it stands in for a third party rather than for part of this
 * shop's API (technical-considerations §2.3). A global prefix would have to be
 * fought with an exclusion the moment that route arrives.
 */
@Controller("api/products")
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  /**
   * The twelve catalogue items, as a bare JSON array.
   *
   * No envelope and no pagination. The catalogue is a fixed input of twelve
   * rows that the page renders in full; `{ "products": [...] }` would be
   * ceremony around a list that has nothing to say about itself, and a `?page=`
   * parameter would be a feature nobody asked for.
   */
  @Get()
  async listProducts(): Promise<readonly CatalogProduct[]> {
    return this.catalog.listProducts();
  }
}
