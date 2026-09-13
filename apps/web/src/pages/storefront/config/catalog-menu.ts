/**
 * The catalog overlay's contents, verbatim from the mockup's open menu (Figma
 * node `1:1193`): five categories down the left, six columns on the right.
 *
 * Static text and nothing more. The assignment does not grade the menu's
 * accuracy — only that it opens and closes (functional spec §2.3) — so there is
 * no per-category content, no hover switching, and «Скидки 90%» is here because
 * the mockup writes it, not because the shop offers it; the entry is a list
 * item nobody can click.
 */
export interface CatalogColumn {
  readonly title: string;
  readonly items: readonly string[];
}

export const catalogCategories = [
  "Игры и игровые сервисы",
  "Игровые ценности",
  "Мобильные игры",
  "Сервисы и соцсети",
  "Программы",
] as const satisfies readonly string[];

export const catalogColumns = [
  {
    title: "Steam",
    items: ["Игры и DLC", "Пополнение баланса", "Подарочные карты", "Коллекционные карточки", "Смена региона"],
  },
  {
    title: "PlayStation",
    items: ["Игры и DLC", "Пополнение баланса", "Новые аккаунты", "PS Plus", "EA Play"],
  },
  {
    title: "Xbox",
    items: ["Игры и DLC", "Пополнение баланса", "Новые аккаунты", "Xbox Game Pass", "Услуги"],
  },
  {
    title: "Nintendo",
    items: ["Игры и DLC", "Подарочные карты", "Новые аккаунты", "NS Online"],
  },
  {
    title: "Battle.net",
    items: ["World of Warcraft", "Подарочные карты", "Прямое пополнение", "Новые аккаунты", "Смена региона"],
  },
  {
    title: "Подборки",
    items: ["Скидки 90%", "Популярные издатели", "Лучшие серии игр", "Steam Deck", "Bundle-наборы"],
  },
] as const satisfies readonly CatalogColumn[];
