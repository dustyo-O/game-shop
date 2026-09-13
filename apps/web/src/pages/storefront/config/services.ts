/**
 * The eleven service tiles, in the mockup's order (Figma nodes `1:498`…`1:542`).
 *
 * Captions are the brands as the mockup writes them — the two the design tool
 * truncates («PUBG Mob...», «Mobile Leg..») are spelled out here and truncated
 * by the stylesheet instead, so the ellipsis follows the real width of the tile
 * rather than being typed into the text (technical-considerations R16).
 *
 * The icon paths are a contract with the artwork under `public/icons/services/`:
 * nine brand tiles are rasters exported from the Figma file at `<slug>.png`,
 * downscaled to 144 × 144; TikTok and «еще 841» are hand-authored SVGs (the
 * Figma export budget ran out mid-task — `docs/walkthrough/phase-4-slice-1-
 * the-structure.md` §6.3). A wrong path here is a
 * broken tile, which is why the paths are spelled out rather than derived.
 */
export interface ServiceTile {
  readonly slug: string;
  readonly caption: string;
  readonly icon: string;
}

export const services = [
  { slug: "steam", caption: "Steam", icon: "/icons/services/steam.png" },
  { slug: "telegram", caption: "Telegram", icon: "/icons/services/telegram.png" },
  { slug: "roblox", caption: "Roblox", icon: "/icons/services/roblox.png" },
  { slug: "brawl-stars", caption: "Brawl Stars", icon: "/icons/services/brawl-stars.png" },
  { slug: "pubg-mobile", caption: "PUBG Mobile", icon: "/icons/services/pubg-mobile.png" },
  { slug: "app-store", caption: "App Store", icon: "/icons/services/app-store.png" },
  { slug: "chatgpt", caption: "ChatGPT", icon: "/icons/services/chatgpt.png" },
  { slug: "playstation", caption: "PlayStation", icon: "/icons/services/playstation.png" },
  { slug: "tiktok", caption: "TikTok", icon: "/icons/services/tiktok.svg" },
  { slug: "mobile-legends", caption: "Mobile Legends", icon: "/icons/services/mobile-legends.png" },
  { slug: "more", caption: "еще 841", icon: "/icons/services/more.svg" },
] as const satisfies readonly ServiceTile[];

/** The Steam block reuses the Steam tile's artwork (Figma node `1:1426` is the same image). */
export const steamIcon = "/icons/services/steam.png";
