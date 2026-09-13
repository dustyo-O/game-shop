/**
 * Every word the storefront shows a shopper, in Russian, in one place — the
 * labels, placeholders, accessible names, and the three states of the product
 * row. Functional spec §2.10 ("everything I read is in Russian") is reviewed by
 * reading this file and its three siblings, not by hunting through `ui/`.
 *
 * The block labels are the mockup's own words, copied as it writes them:
 * «Игра, приложение или услуга...» with three dots, «Оплатить 500$» with the
 * dollar after the sum, «5%» as drawn. The mockup pairs an active «$» with a
 * sum in roubles; that mismatch is reproduced on purpose (functional spec
 * §2.4 — recalculation is waived).
 *
 * The row's three sentences are Phase 1's, verbatim. Functional spec §2.6 crit
 * 5 asks for "the shop's existing Russian message" when the catalogue cannot be
 * loaded — so the sentence is the one a reviewer has already seen, not a new
 * one that says the same thing differently.
 */
export const text = {
  /** Visually hidden; heads the outline so «Популярные товары» can be the h2. */
  title: "Магазин",

  header: {
    catalog: "Каталог",
    search: "Поиск",
    searchPlaceholder: "Игра, приложение или услуга...",
    favourites: "Избранное",
    find: "Найти",
    profile: "Профиль",
  },

  banner: {
    label: "Предложения",
    previous: "Предыдущий слайд",
    next: "Следующий слайд",
  },

  catalogMenu: {
    label: "Каталог товаров",
  },

  steamTopup: {
    title: "Пополнение Steam",
    badge: "5%",
    promo: "Ввести промокод",
    login: "Логин Steam",
    sumLabel: "Сумма",
    sum: "500 ₽",
    currency: "Валюта",
    pay: "Оплатить 500$",
  },

  popular: {
    title: "Популярные товары",
    chips: {
      donate: "Донат",
      subscriptions: "Подписки",
      items: "Предметы",
      accounts: "Аккаунты",
      keys: "Ключи",
      gameCurrency: "Игровая валюта",
      other: "Другое",
    },
    loading: "Загрузка каталога…",
    empty: "Каталог пуст.",
    error: "Не удалось загрузить каталог. Проверьте соединение и обновите страницу.",
  },
} as const;

/**
 * The three currency options, in the mockup's order. The symbol is both the
 * radio's value and its visible label — there is nothing else to say about a
 * control whose whole job is to show which one is active.
 */
export const currencies = [
  { id: "currency-usd", symbol: "$" },
  { id: "currency-kzt", symbol: "₸" },
  { id: "currency-rub", symbol: "₽" },
] as const;

/** The accessible name of one slide: «1 из 4». Positions are 1-based, as spoken. */
export function slideLabel(position: number, count: number): string {
  return `${position} из ${count}`;
}

/** The accessible name of one dot: «Слайд 1 из 4». */
export function dotLabel(position: number, count: number): string {
  return `Слайд ${position} из ${count}`;
}
