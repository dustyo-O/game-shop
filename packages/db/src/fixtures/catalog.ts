/**
 * The supplied catalogue — twelve products, **verbatim from the assignment**.
 *
 * This is a fixed input, not a design decision (technical-considerations §3,
 * "System Dependencies": *the supplied catalog, key pool and webhook contract
 * are fixed inputs and must be used verbatim*). It is kept as a flat table of
 * literals, in the assignment's own order and with the assignment's own units,
 * so a reviewer can diff this file against the brief line by line. Nothing here
 * is computed, sorted, or normalised; everything derived lives in `../seed.ts`.
 *
 * ---------------------------------------------------------------------------
 * PRICES ARE IN WHOLE ROUBLES HERE. THE DATABASE STORES MINOR UNITS.
 * ---------------------------------------------------------------------------
 * The brief writes «Пополнение Steam 500 ₽»; `products.price_minor` holds
 * `50000`. That conversion is deliberately **not** applied in this file — if it
 * were, the numbers below would no longer match the brief and the fixture would
 * stop being diffable, which is its whole purpose. The multiplication happens in
 * exactly one expression in `../seed.ts`, against {@link MINOR_UNITS_PER_ROUBLE}.
 */

/**
 * The catalogue's categories, as the assignment names them.
 *
 * A plain `as const` array rather than a TypeScript `enum`: no runtime class is
 * emitted and the values interoperate with the plain strings that come back out
 * of `products.type`, which the schema stores as `text`.
 */
export const productTypes = ["topup", "key", "subscription", "giftcard"] as const;

export type ProductType = (typeof productTypes)[number];

/**
 * Which category the shop actually sells (assumption A4,
 * technical-considerations §Assumptions): the three products of type `key` are
 * purchasable, the other nine are display-only.
 *
 * Exported as the *rule* rather than baked into the rows below as a `purchasable`
 * column, so the fixture stays a transcription of the brief and the policy stays
 * in one place. The seed applies it — see `../seed.ts`.
 */
export const purchasableProductType: ProductType = "key";

/** ISO 4217 code for every row in the supplied catalogue. */
export const catalogCurrency = "RUB";

/**
 * Kopecks per rouble. The single conversion factor between this file's units
 * and the database's; see the header.
 */
export const MINOR_UNITS_PER_ROUBLE = 100;

/** One row of the supplied catalogue, in the assignment's own units. */
export interface CatalogItem {
  /** The shop's public handle for the item; `products.sku`, UNIQUE. */
  readonly sku: string;
  /** Russian display name, verbatim (functional spec §2.8). */
  readonly name: string;
  readonly type: ProductType;
  /**
   * **Whole roubles**, exactly as the brief prints them — not minor units.
   * Multiplied by {@link MINOR_UNITS_PER_ROUBLE} on its way into
   * `products.price_minor`.
   */
  readonly priceRub: number;
  /** Image reference from the catalogue, relative to the web app's asset root. */
  readonly image: string;
}

/**
 * The twelve products. Order, spelling, punctuation and prices are the brief's.
 *
 * `satisfies` rather than a type annotation: the literal types survive (so a
 * typo in a `type` value is a compile error here, not a runtime surprise in the
 * seed) while the shape is still checked against {@link CatalogItem}.
 */
export const productCatalog = [
  {
    sku: "STEAM-TOPUP-500",
    name: "Пополнение Steam 500 ₽",
    type: "topup",
    priceRub: 500,
    image: "assets/steam.png",
  },
  {
    sku: "STEAM-TOPUP-1000",
    name: "Пополнение Steam 1000 ₽",
    type: "topup",
    priceRub: 1000,
    image: "assets/steam.png",
  },
  {
    sku: "STEAM-TOPUP-2500",
    name: "Пополнение Steam 2500 ₽",
    type: "topup",
    priceRub: 2500,
    image: "assets/steam.png",
  },
  {
    sku: "KEY-CS2-PRIME",
    name: "CS2 Prime Status ключ",
    type: "key",
    priceRub: 1290,
    image: "assets/cs2.png",
  },
  {
    sku: "KEY-GTA5",
    name: "GTA V ключ активации",
    type: "key",
    priceRub: 1990,
    image: "assets/gta5.png",
  },
  {
    sku: "KEY-EFT",
    name: "Escape from Tarkov ключ",
    type: "key",
    priceRub: 3490,
    image: "assets/eft.png",
  },
  {
    sku: "SUB-DISCORD-1M",
    name: "Discord Nitro 1 месяц",
    type: "subscription",
    priceRub: 399,
    image: "assets/discord.png",
  },
  {
    sku: "SUB-YT-3M",
    name: "YouTube Premium 3 месяца",
    type: "subscription",
    priceRub: 1490,
    image: "assets/youtube.png",
  },
  {
    sku: "SUB-SPOTIFY-1M",
    name: "Spotify Premium 1 месяц",
    type: "subscription",
    priceRub: 299,
    image: "assets/spotify.png",
  },
  {
    sku: "GIFT-PSN-1000",
    name: "PlayStation Store карта 1000 ₽",
    type: "giftcard",
    priceRub: 1000,
    image: "assets/psn.png",
  },
  {
    sku: "GIFT-XBOX-1500",
    name: "Xbox Gift Card 1500 ₽",
    type: "giftcard",
    priceRub: 1500,
    image: "assets/xbox.png",
  },
  {
    sku: "GIFT-ROBLOX-800",
    name: "Roblox 800 Robux",
    type: "giftcard",
    priceRub: 890,
    image: "assets/roblox.png",
  },
] as const satisfies readonly CatalogItem[];

/** Twelve. Named so a caller asserting on the catalogue does not hard-code it. */
export const CATALOG_SIZE = productCatalog.length;
