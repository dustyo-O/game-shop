// @layer: unit
// @spec: 002-single-issuance-under-races
// @spec: 003-failure-and-recovery
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
