// @layer: unit
// @spec: 002-single-issuance-under-races
// @spec: 003-failure-and-recovery
// @spec: 005-promo-codes-with-enforced-limits
// @regression
/**
 * Functional spec §2.8's one testable fact for this phase: *"When the shopper
 * reads any text this phase adds or changes, then that text is in Russian, as
 * established in spec 001 §2.8."*
 *
 * ---------------------------------------------------------------------------
 * EXTENDED FOR SPEC 003 §2.9, RATHER THAN DUPLICATED
 * ---------------------------------------------------------------------------
 * Spec 003 adds a second table of shopper-facing text —
 * `apps/web/src/entities/order/lib/order-recovery-explanation.ts`, the
 * sentence under the status line for `out_of_stock` and `delivery_failed`
 * (technical-considerations §9.2) — and functional spec §2.9's own words are
 * "any text this phase adds **or changes**", which names it directly. The
 * spec 003 task brief ("check the contracts/labels the way this file does,
 * extend it rather than duplicate if that's cleaner") is followed literally
 * below: same regex-over-source-text technique, same "do not import what you
 * are checking" stance, second `describe` block rather than a second file.
 * The second `@spec` line above is deliberate — this file now carries
 * regression coverage for both specs' §2.8/§2.9, and `/awos:regression`'s
 * grep for either spec's tag finds it.
 *
 * ---------------------------------------------------------------------------
 * EXTENDED AGAIN FOR SPEC 005 §2.7 — THE PROMO FORM'S `text` TABLE
 * ---------------------------------------------------------------------------
 * Spec 005 adds a third table: `apps/web/src/features/apply-promo/ui/
 * promo-form.ts`'s `const text = { … } as const` — the field's placeholder
 * (which is also its `aria-label`), the «Применить» button, and the three
 * refusal sentences plus the shared «Заказ не найден…» (technical-
 * considerations §2.4). Functional spec 005 §2.7 names exactly these: *"the
 * field, the button, … the three messages"*. The web has no sweep of its own
 * (its vitest suite is DOM-free reducers and timers), so this file is
 * extended a third time rather than a sibling started: same read-as-text
 * technique, same stance, a third `describe`.
 *
 * The table's keys are plain identifiers rather than `[OrderStatus.X]`, so
 * it has its own extractor — `extractTextTable` isolates the `const text`
 * literal and reads each `key: "…"` line inside it. Doc comments inside the
 * literal do not match (no `key: "` shape), and code outside it is never read.
 *
 * Two of the checks here are about the *shape* of the table, not its script:
 * the three refusal sentences must differ from one another (a shopper must be
 * able to tell "no such code" from "no uses left"), and the source must not
 * mark the input with the browser's mandatory-field attribute — that attribute
 * is the one way an English sentence («Please fill out this field») reaches
 * this page without passing through any `text` table at all.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS WORTH A TEST NOW, WHEN SPEC 001'S SUITE ONLY "VERIFIED BY
 * SOURCE REVIEW"
 * ---------------------------------------------------------------------------
 * `../acceptance/purchase-and-key-delivery.test.ts`'s header explains why
 * Phase 1 left §2.8 to a one-line note: only `created` was reachable through
 * the UI, so the other five labels were unread prose with nothing to exercise.
 * Phase 2 changes that premise — `paid`, `delivering`, `payment_failed` and
 * `out_of_stock` are now genuinely reached by a shopper watching their order
 * settle (§2.5), and this suite's own out-of-order and duplicate-report tests
 * below drive every one of them. A label that was silently left in English, or
 * merged with another status by copy-paste, would now be shown to a real
 * shopper — so it is cheap and real to check, exactly as this task's brief
 * says.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS READS THE FILE'S TEXT RATHER THAN IMPORTING AND CALLING IT
 * ---------------------------------------------------------------------------
 * `apps/web/src/entities/order/lib/order-status-label.ts` belongs to
 * `apps/web` — a separate Vite application with its own build, not a
 * workspace package `apps/api` depends on. Importing it here would either
 * require wiring a second, unrelated app into this package's module
 * resolution for the sake of one string table, or silently rely on a
 * relative path resolving through two different bundlers' rules. Reading the
 * file as **text** and checking its literal content needs neither: it is the
 * same "independent transcription, not a shared import" stance
 * `../concurrency/support/db.ts` documents for `deriveTestRequestId` — a test
 * that imported the very code it is meant to catch a mistake in cannot catch
 * that mistake.
 *
 * This is therefore a `@layer: unit` check in the strict sense: no database,
 * no HTTP, no running process — a deterministic scan of one source file's
 * text, entirely independent of every other test in this spec's suite.
 */
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { orderStatuses, recoverableOrderStatuses } from "@game-shop/contracts";
import { describe, expect, it } from "vitest";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * `apps/web/src/entities/order/lib/order-status-label.ts` — three levels up
 * from `apps/api/test/unit` reaches `apps/`, then down into `web`.
 */
const ORDER_STATUS_LABEL_FILE = resolve(
  TEST_DIR,
  "..",
  "..",
  "..",
  "web",
  "src",
  "entities",
  "order",
  "lib",
  "order-status-label.ts",
);

/** Same directory as {@link ORDER_STATUS_LABEL_FILE}, spec 003's second table (technical-considerations §9.2). */
const ORDER_RECOVERY_EXPLANATION_FILE = resolve(
  TEST_DIR,
  "..",
  "..",
  "..",
  "web",
  "src",
  "entities",
  "order",
  "lib",
  "order-recovery-explanation.ts",
);

/**
 * `apps/web/src/features/apply-promo/ui/promo-form.ts` — the same `apps/`
 * root, then the feature's `ui` segment (spec 005 technical-considerations
 * §2.4).
 */
const PROMO_FORM_FILE = resolve(
  TEST_DIR,
  "..",
  "..",
  "..",
  "web",
  "src",
  "features",
  "apply-promo",
  "ui",
  "promo-form.ts",
);

/**
 * Every `[OrderStatus.X]: "…"` entry in the object literal, in file order.
 * Deliberately does not care about the key names — see the file header on
 * why this is independent of `@game-shop/contracts`'s own naming — only that
 * each bracketed-key line carries a quoted string value.
 */
const LABEL_ENTRY_PATTERN = /\[OrderStatus\.\w+\]:\s*"([^"]*)"/g;

/** The Cyrillic Unicode block — U+0400–U+04FF covers every letter Russian uses, а–я and Ё/ё included. */
const CYRILLIC_PATTERN = /[Ѐ-ӿ]/;

function extractLabels(source: string): readonly string[] {
  return [...source.matchAll(LABEL_ENTRY_PATTERN)].map((match) => match[1] ?? "");
}

/** The whole of a feature's `const text = { … } as const;` literal, and nothing outside it. */
const TEXT_TABLE_PATTERN = /const text = \{([\s\S]*?)\} as const;/;

/** One `key: "…"` line inside that literal — a doc-comment line has no such shape and is skipped. */
const TEXT_ENTRY_PATTERN = /^\s*(\w+):\s*"([^"]*)",?\s*$/gm;

/**
 * Every `key: "…"` entry of a feature's `text` table, keyed, in file order.
 * Throws rather than returning an empty map when the literal is not found, so
 * a renamed table fails loudly instead of passing on zero entries.
 */
function extractTextTable(source: string, file: string): ReadonlyMap<string, string> {
  const literal = TEXT_TABLE_PATTERN.exec(source)?.[1];

  if (literal === undefined) {
    throw new Error(`no \`const text = { … } as const;\` literal found in ${file}`);
  }

  return new Map([...literal.matchAll(TEXT_ENTRY_PATTERN)].map((match) => [match[1] ?? "", match[2] ?? ""]));
}

describe("functional spec §2.8 — every order status label is in Russian", () => {
  const source = readFileSync(ORDER_STATUS_LABEL_FILE, "utf8");
  const labels = extractLabels(source);

  // @regression
  it("the label table defines exactly one entry per lifecycle status — none missing, none duplicated", () => {
    // `orderStatuses` (@game-shop/contracts) is the same list
    // `Record<OrderStatus, string>` is typed against — a total record cannot
    // compile with a status missing, so this is really checking that this
    // independent regex-based read agrees with what the compiler already
    // enforces, per the file header's "do not import what you are checking"
    // stance.
    expect(labels.length, `found ${String(labels.length)} labelled entries in ${ORDER_STATUS_LABEL_FILE}`).toBe(
      orderStatuses.length,
    );
  });

  // @regression
  it("every status label is non-empty and contains a Cyrillic character — not English, not a blank placeholder", () => {
    for (const [index, label] of labels.entries()) {
      expect(label.length, `label #${String(index)} ("${label}") is empty`).toBeGreaterThan(0);
      expect(CYRILLIC_PATTERN.test(label), `label #${String(index)} ("${label}") has no Cyrillic character`).toBe(
        true,
      );
    }
  });

  // @regression
  it("every status has its own distinct wording — no two lifecycle states share one label", () => {
    // A shopper who watches `paid` and `delivering` render identical text
    // cannot tell the shop is still working from the shop being stuck — the
    // exact "unexplained wait" functional spec §2.5's second criterion warns
    // against.
    const distinct = new Set(labels);
    expect(distinct.size, `labels: ${JSON.stringify(labels)}`).toBe(labels.length);
  });
});

/**
 * §2.3's fourth criterion, shopper-visible: both recoverable explanations open
 * with the same reassurance that the payment was not lost. Checked as a
 * literal prefix rather than a Cyrillic-content scan, because this property is
 * about the two sentences *agreeing* with each other, not about either one's
 * script.
 */
const PAYMENT_RETAINED_PREFIX = "Оплата прошла";

describe(
  "functional spec §2.3 criterion 2 & §2.9 — the recovery explanation for each recoverable status is in " +
    "Russian, distinguishable, and opens by confirming the payment was not lost",
  () => {
    const source = readFileSync(ORDER_RECOVERY_EXPLANATION_FILE, "utf8");
    const explanations = extractLabels(source);

    // @regression
    it(
      "the explanation table defines exactly one entry per RECOVERABLE status (out_of_stock, delivery_failed) " +
        "— none missing, none duplicated, and none for a status that needs no apology",
      () => {
        // `order-recovery-explanation.ts` is typed
        // `Readonly<Record<RecoverableOrderStatus, string>>` — total over
        // `recoverableOrderStatuses`, not the whole `OrderStatus` union (see
        // that file's own header for why `delivered`/`payment_failed`/etc.
        // are deliberately absent). This is the same "the compiler already
        // enforces it; this independent read confirms it agrees" stance the
        // block above takes for `order-status-label.ts`.
        expect(
          explanations.length,
          `found ${String(explanations.length)} explanation entries in ${ORDER_RECOVERY_EXPLANATION_FILE}`,
        ).toBe(recoverableOrderStatuses.length);
      },
    );

    // @regression
    it("every recovery explanation is non-empty and contains a Cyrillic character (functional spec §2.9)", () => {
      for (const [index, explanation] of explanations.entries()) {
        expect(explanation.length, `explanation #${String(index)} ("${explanation}") is empty`).toBeGreaterThan(0);
        expect(
          CYRILLIC_PATTERN.test(explanation),
          `explanation #${String(index)} ("${explanation}") has no Cyrillic character`,
        ).toBe(true);
      }
    });

    // @regression
    it(
      "out_of_stock and delivery_failed read differently from each other — functional spec §2.3's second " +
        "criterion, that a shopper can tell the two failures apart",
      () => {
        const distinct = new Set(explanations);
        expect(distinct.size, `explanations: ${JSON.stringify(explanations)}`).toBe(explanations.length);
      },
    );

    // @regression
    it(
      'both explanations open with «Оплата прошла» — functional spec §2.3\'s fourth criterion, that the ' +
        "payment stays recorded rather than being discarded, said to the shopper in the first words they read",
      () => {
        for (const [index, explanation] of explanations.entries()) {
          expect(
            explanation.startsWith(PAYMENT_RETAINED_PREFIX),
            `explanation #${String(index)} ("${explanation}") does not open with "${PAYMENT_RETAINED_PREFIX}"`,
          ).toBe(true);
        }
      },
    );

    // @regression
    it(
      "negative — neither explanation promises a refund or an email, both of which spec 003 §3 puts " +
        "out of scope and the shop cannot deliver",
      () => {
        const outOfScopePromises = [/возврат/iu, /email/iu, /электронн\w*\s+почт/iu];
        for (const [index, explanation] of explanations.entries()) {
          for (const pattern of outOfScopePromises) {
            expect(
              pattern.test(explanation),
              `explanation #${String(index)} ("${explanation}") appears to promise something spec 003 §3 rules out (matched ${pattern.toString()})`,
            ).toBe(false);
          }
        }
      },
    );
  },
);

/**
 * What spec 005 technical-considerations §2.4 says the promo form's table
 * holds, by key: the field (placeholder = `aria-label`), the button, the three
 * refusal sentences and the shared not-found sentence. Transcribed here rather
 * than imported, per the file header.
 */
const PROMO_FORM_TEXT_KEYS = ["placeholder", "apply", "unknown", "exhausted", "notFound", "failed"] as const;

/** The three sentences a shopper can read after a refused code — they must be told apart. */
const PROMO_FORM_REFUSAL_KEYS = ["unknown", "exhausted", "failed"] as const;

/**
 * The attribute that would let the browser show its own (English) bubble on an
 * empty submit. Matched as an attribute entry (`required: "…"` inside the
 * `attributes` object), not as a word — the file may well *discuss* the
 * attribute in a comment.
 */
const MANDATORY_FIELD_ATTRIBUTE_PATTERN = /^\s*"?required"?\s*:\s*"/m;

describe(
  "functional spec 005 §2.7 — the promo form's field, button and the three messages are in Russian " +
    "and tell the refusals apart",
  () => {
    const source = readFileSync(PROMO_FORM_FILE, "utf8");
    const table = extractTextTable(source, PROMO_FORM_FILE);

    // @regression
    it("the text table defines exactly the six entries §2.4 names — the field, the button, three refusals, not-found", () => {
      expect([...table.keys()], `entries in ${PROMO_FORM_FILE}`).toEqual([...PROMO_FORM_TEXT_KEYS]);
    });

    // @regression
    it("every entry is non-empty and contains a Cyrillic character — not English, not a blank placeholder", () => {
      for (const [key, value] of table) {
        expect(value.length, `text.${key} ("${value}") is empty`).toBeGreaterThan(0);
        expect(CYRILLIC_PATTERN.test(value), `text.${key} ("${value}") has no Cyrillic character`).toBe(true);
      }
    });

    // @regression
    it("the three refusal sentences differ from one another — a shopper can tell 'no such code' from 'no uses left'", () => {
      const refusals = PROMO_FORM_REFUSAL_KEYS.map((key) => table.get(key) ?? "");
      expect(new Set(refusals).size, `refusals: ${JSON.stringify(refusals)}`).toBe(refusals.length);
    });

    // @regression
    it("the not-found sentence is the same one the rest of the order page uses for a 404", () => {
      // `pages/order/ui/order-page.ts` and `features/simulate-payment` both
      // say this for a `404`; a third wording for the same situation would be
      // a third thing for a shopper to learn.
      expect(table.get("notFound")).toBe("Заказ не найден. Проверьте адрес страницы.");
    });

    // @regression
    it("negative — the input is not marked mandatory for the browser, so no native English bubble can appear", () => {
      expect(
        MANDATORY_FIELD_ATTRIBUTE_PATTERN.test(source),
        `${PROMO_FORM_FILE} sets the browser's mandatory-field attribute on an element`,
      ).toBe(false);
    });
  },
);
