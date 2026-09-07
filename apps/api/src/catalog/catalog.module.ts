/**
 * `catalog` — "Read the product list" (technical-considerations §2.4).
 *
 * The smallest of the five backend modules and the only read-only one. It owns
 * no state transition and no invariant; everything interesting about it is that
 * it answers from the database rather than from a fixture.
 */
import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { CatalogController } from "./catalog.controller.js";
import { CatalogService } from "./catalog.service.js";

@Module({
  imports: [DatabaseModule],
  controllers: [CatalogController],
  providers: [CatalogService],
})
export class CatalogModule {}
