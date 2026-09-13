/**
 * The four banner slides. Functional spec §2.2: "each a dark panel with a short
 * Russian headline and one line of text".
 *
 * The copy describes what the shop sells — top-ups, keys, subscriptions, gift
 * cards — and promises nothing: no percentages, no "only today", no invented
 * discount (technical-considerations R17; functional spec §3 says the shop
 * "invents no discounts"). The Figma banner is one black image with no text of
 * its own, so these lines are the shop's, written to the seed catalogue: Steam
 * top-ups and keys, Discord, YouTube and Spotify subscriptions, PSN and Xbox
 * cards.
 *
 * Four, not the mockup's six dots (technical-considerations assumption 2): the
 * dots reflect the slides, and four slides is what the spec asks for.
 */
export interface BannerSlide {
  readonly headline: string;
  readonly text: string;
}

export const bannerSlides = [
  {
    headline: "Пополнение Steam",
    text: "Пополняйте кошелёк Steam по логину аккаунта.",
  },
  {
    headline: "Ключи для игр",
    text: "Лицензионные ключи для Steam и других платформ.",
  },
  {
    headline: "Подписки на сервисы",
    text: "Discord, YouTube, Spotify и другие сервисы.",
  },
  {
    headline: "Подарочные карты",
    text: "Карты пополнения для PlayStation, Xbox и Roblox.",
  },
] as const satisfies readonly BannerSlide[];
