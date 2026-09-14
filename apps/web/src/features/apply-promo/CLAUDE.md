# `features/apply-promo`

The promo-code field on the order page: a real `<form data-promo-form>` shown only while the order is `created` with no code on it; its `submit` handler calls `preventDefault()` and `applyPromo` from `entities/order`, and Enter in the field applies. Argued in `ui/promo-form.ts`'s header:

- **Success paints nothing — the poll does.** The form calls `onOrderMayHaveChanged()` and discards the returned order; `showOrder` in `pages/order` is the one writer of the content region, and `poll.refreshNow()` queues behind an in-flight read so a stale `promo: null` can never land after the row. The form stays busy until that refresh replaces it. The page's memo must compare `promoCode` for this to work at all (`order-page.ts`, `RenderedOrder`).
- **No `required` on the input.** The browser's native bubble is in English; emptiness is checked in the handler after `trim()`, and an empty submit sends nothing. `readOnly` on the field during the request, not `disabled` — focus survives.
