#!/usr/bin/env node
/**
 * Renders the product card art: `scripts/card-art/<name>.svg` → `public/assets/<name>.png`.
 *
 * Run with `pnpm --filter @game-shop/web run assets:card-art`. Node executes
 * this file straight from source through type stripping (the same convention
 * as the root `scripts/with-env.ts`), so there is no build step and the file
 * stays inside the erasable TypeScript subset: no enums, no parameter
 * properties, `import type` for types.
 *
 * ---------------------------------------------------------------------------
 * WHY SVG SOURCES RENDERED THROUGH CHROMIUM, NOT IMAGEMAGICK
 * ---------------------------------------------------------------------------
 * Every card carries a Russian product name and four of them carry «₽». Text
 * rendering is the whole asset, and ImageMagick draws text only with a font
 * it is explicitly given — it ships none, so Cyrillic and U+20BD come out as
 * tofu boxes unless a font file is pinned into the repository and the command
 * line. Chromium resolves `system-ui` through the operating system's fallback
 * chain and finds a glyph for both on any desktop OS. The e2e suite already
 * installs a Chromium (`pnpm exec playwright install chromium`, see
 * `playwright.config.ts`'s preflight), so this script borrows it: one
 * `setContent` per SVG, one `screenshot`, nothing else — tech spec §2.7.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PNG OUTPUTS ARE COMMITTED
 * ---------------------------------------------------------------------------
 * A reviewer installs nothing: `public/` is copied verbatim into the build and
 * served at the same paths by the dev server, so the ten PNGs must exist in
 * the checkout, not be produced by a step the reviewer has to know about. The
 * script exists so a change to the art is reproducible, not so the assets are
 * regenerated on every machine — a different OS renders `system-ui` with a
 * different font, so re-running elsewhere yields a visually equivalent but
 * byte-different PNG. Re-run and commit only when a source SVG changed.
 *
 * ---------------------------------------------------------------------------
 * THE OUTPUT PATHS ARE THE SEED'S AND MUST NOT CHANGE
 * ---------------------------------------------------------------------------
 * `packages/db/src/fixtures/catalog.ts` is the assignment's catalogue
 * transcribed verbatim, and its `image` column already says
 * `assets/steam.png`, `assets/cs2.png`, … — ten distinct files for twelve
 * rows (the three Steam top-ups share one). Those strings are a fixed input;
 * the art was made to fit them, never the reverse. The source file names
 * under `card-art/` are therefore the seed's basenames, and adding, renaming
 * or removing one here without the seed agreeing produces a card whose image
 * does not load. Under the dev server that is NOT a 404 — Vite's SPA fallback
 * answers a missing file with `200 text/html` — which is why the e2e guards
 * it two ways (tech spec R10): every `/assets/*.png` response must carry an
 * `image/*` content-type (`layout.spec.ts`), and no card on the seed may fall
 * back to the empty placeholder (`products.spec.ts`).
 *
 * The output size is 456 × 304: exactly 2× the card's 228 × 152 image box, so
 * the browser downscales on a high-DPI screen and never upscales.
 *
 * Idempotent — every run overwrites all ten files.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A bare specifier: this file lives inside `apps/web`, which declares
// `@playwright/test` as its own dev dependency, so Node's resolution walks up
// to `apps/web/node_modules` and finds it. No `createRequire` scoping needed.
import { chromium } from "@playwright/test";
import type { Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const sourcesDir = join(here, "card-art");
const outputDir = join(webRoot, "public", "assets");

/** 2× of the card's 228 × 152 image box (`.product-card__media`). */
const CARD_WIDTH = 456;
const CARD_HEIGHT = 304;

/** PNG signature (8 bytes) + IHDR length (4) + "IHDR" (4) → width at 16, height at 20. */
const PNG_IHDR_WIDTH_OFFSET = 16;
const PNG_IHDR_HEIGHT_OFFSET = 20;

interface RenderedAsset {
  readonly name: string;
  readonly outputPath: string;
  /** Bytes as Chromium wrote them. */
  readonly rawBytes: number;
  /** Bytes on disk after optimisation (equal to `rawBytes` when none applied). */
  readonly finalBytes: number;
  readonly optimiser: "magick -strip" | "none";
}

function listSources(): readonly string[] {
  if (!existsSync(sourcesDir)) {
    throw new Error(`No card-art sources directory at ${sourcesDir}`);
  }
  const files = readdirSync(sourcesDir)
    .filter((file) => file.endsWith(".svg"))
    .sort();
  if (files.length === 0) {
    throw new Error(`No .svg sources found in ${sourcesDir}`);
  }
  return files;
}

/**
 * Minimal host document: the SVG is the page. `margin: 0` so the panel sits at
 * the origin and the clip below captures exactly it; `display: block` so the
 * inline-SVG baseline gap does not add a strip of body background.
 */
function wrapSvg(svgMarkup: string): string {
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<style>html,body{margin:0;padding:0;background:#000}svg{display:block}</style>" +
    `</head><body>${svgMarkup}</body></html>`
  );
}

function readPngDimensions(png: Buffer): { readonly width: number; readonly height: number } {
  return {
    width: png.readUInt32BE(PNG_IHDR_WIDTH_OFFSET),
    height: png.readUInt32BE(PNG_IHDR_HEIGHT_OFFSET),
  };
}

function isMagickAvailable(): boolean {
  const probe = spawnSync("magick", ["-version"], { stdio: "ignore" });
  return probe.error === undefined && probe.status === 0;
}

/**
 * Lossless pass: drop metadata chunks and ask for zlib's maximum effort.
 * Keeps the optimised file only when it is actually smaller — ImageMagick's
 * encoder is not always tighter than Chromium's — so the result is never
 * worse than the raw screenshot.
 */
function optimiseWithMagick(pngPath: string): boolean {
  const tmpPath = `${pngPath}.tmp`;
  const result = spawnSync(
    "magick",
    [pngPath, "-strip", "-define", "png:compression-level=9", tmpPath],
    { stdio: "inherit" },
  );
  if (result.status !== 0 || !existsSync(tmpPath)) {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
    return false;
  }
  const before = statSync(pngPath).size;
  const after = statSync(tmpPath).size;
  if (after < before) {
    renameSync(tmpPath, pngPath);
    return true;
  }
  unlinkSync(tmpPath);
  return false;
}

async function renderOne(page: Page, sourceFile: string, useMagick: boolean): Promise<RenderedAsset> {
  const name = basename(sourceFile, ".svg");
  const outputPath = join(outputDir, `${name}.png`);
  const svgMarkup = readFileSync(join(sourcesDir, sourceFile), "utf8");

  await page.setContent(wrapSvg(svgMarkup), { waitUntil: "load" });
  // `system-ui` is a local font, but wait for the font set to settle anyway so
  // a first-paint fallback glyph can never be what gets captured.
  await page.evaluate(() => document.fonts.ready);

  const png = await page.screenshot({
    type: "png",
    path: outputPath,
    clip: { x: 0, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT },
  });

  const { width, height } = readPngDimensions(png);
  if (width !== CARD_WIDTH || height !== CARD_HEIGHT) {
    throw new Error(
      `${name}.png rendered at ${String(width)} × ${String(height)}, expected ${String(CARD_WIDTH)} × ${String(CARD_HEIGHT)}`,
    );
  }

  const rawBytes = png.byteLength;
  const optimised = useMagick && optimiseWithMagick(outputPath);
  return {
    name,
    outputPath,
    rawBytes,
    finalBytes: statSync(outputPath).size,
    optimiser: optimised ? "magick -strip" : "none",
  };
}

function formatBytes(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} B`;
}

async function main(): Promise<void> {
  const sources = listSources();
  mkdirSync(outputDir, { recursive: true });

  const useMagick = isMagickAvailable();
  const browser = await chromium.launch();
  const rendered: RenderedAsset[] = [];
  try {
    console.log(
      `card-art: ${String(sources.length)} sources → ${outputDir} ` +
        `(${String(CARD_WIDTH)} × ${String(CARD_HEIGHT)}, Chromium ${browser.version()}, ` +
        `optimiser: ${useMagick ? "magick -strip" : "none — magick not on PATH"})`,
    );
    const page = await browser.newPage();
    await page.setViewportSize({ width: CARD_WIDTH, height: CARD_HEIGHT });
    for (const source of sources) {
      rendered.push(await renderOne(page, source, useMagick));
    }
  } finally {
    await browser.close();
  }

  let total = 0;
  for (const asset of rendered) {
    total += asset.finalBytes;
    const change =
      asset.optimiser === "none"
        ? formatBytes(asset.finalBytes)
        : `${formatBytes(asset.rawBytes)} → ${formatBytes(asset.finalBytes)} (${asset.optimiser})`;
    console.log(`  ${asset.name.padEnd(8)} ${String(CARD_WIDTH)} × ${String(CARD_HEIGHT)}  ${change}`);
  }
  console.log(`total ${String(rendered.length)} files, ${formatBytes(total)}`);
}

await main();
