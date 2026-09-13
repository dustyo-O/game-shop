/**
 * The banner: four slides in one panel, two arrows, four dots — moving on its
 * own every five seconds and by hand at once (functional spec §2.2; Figma node
 * `1:641`). Slice 1 rendered it still; this file binds it. DOM events go to
 * the reducer in `../model/carousel.ts`, the state it hands back is painted,
 * and the timer instruction it hands back is applied to the countdown in
 * `../model/countdown.ts` with the one number neither model knows: 5 000 ms.
 *
 * ---------------------------------------------------------------------------
 * THE REDUCER DECIDES THE TIMER; THIS FILE ONLY APPLIES IT
 * ---------------------------------------------------------------------------
 * Every handler below does the same thing: dispatch an event, paint the state,
 * apply the instruction. None of them touches the countdown directly, and none
 * of them knows whether the pointer is on the panel — the reducer does, and it
 * answers `restart`, `cancel` or `keep` accordingly. That is what makes "never
 * more than one pending timeout" a property of the design rather than of
 * handler discipline: the countdown has one slot and `restart` clears before
 * it sets; the reducer emits exactly one instruction per event; and there is
 * exactly one place an instruction becomes a call, {@link applyTimer}. A
 * handler that wanted a timer of its own would have to say so to the reducer,
 * where its wish would join the policy table and the unit test that checks it
 * row by row — not schedule a timeout of its own. That is the "one timer
 * slot" rule in the page's `CLAUDE.md`, and the grep that checks it is the
 * timeout call appearing in `model/countdown.ts` and nowhere else on the page.
 *
 * The 5-second figure is {@link AUTO_ADVANCE_MS}, written here and nowhere
 * else. The reducer speaks in words, the countdown in milliseconds, and this
 * file is the one that knows both.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE POINTER PAUSES IT — THE PANEL, NOT THE BANNER
 * ---------------------------------------------------------------------------
 * `pointerenter` and `pointerleave` are bound to `.banner__panel`, the dark
 * rectangle with the slides in it, and not to the `.banner` section that also
 * holds the arrows and the dots. Crit 6 — an arrow press restarts the 5-second
 * count from that moment — can only be *seen* by a mouse user if pressing an
 * arrow happens with the pointer off the pause region. With the arrows inside
 * it, every mouse press would find the carousel paused, the reducer would
 * answer `cancel` (crit 7), and the restart would never be observable
 * (technical-considerations §2.2; assumption 3). Slice 1 cut the arrow cluster
 * out of the panel in the markup for this reason, and this file relies on that
 * shape.
 *
 * For the same reason there is no `focusin` handler, although the APG carousel
 * pattern suggests one: a mouse click focuses the arrow it pressed, so pausing
 * on focus would pause on every mouse press too.
 *
 * ---------------------------------------------------------------------------
 * THE BACK/FORWARD CACHE: WHY `pagehide` CANCELS AND `pageshow` RESTARTS
 * ---------------------------------------------------------------------------
 * `pagehide` is the last moment a page reliably gets — the moment
 * `pages/order/model/poll.ts` stops its loop. Here it is not only hygiene. A
 * page going into the back/forward cache is frozen with whatever timeouts it
 * has pending, and on restore those timeouts resume with whatever remainder
 * they had: a shopper who pressed Купить 4.8 s after a slide change and came
 * back a minute later would see the banner jump 200 ms after the page
 * reappeared. Cancelling on `pagehide` leaves nothing to resume.
 *
 * Which means a restored page has a banner with no clock, and something has to
 * start it again (technical-considerations §2.3; R1). `pageshow` with
 * `event.persisted === true` is that moment, and it goes through
 * {@link resume} — a `pointer-leave` rather than a bare `restart`, because the
 * state may still say `isPaused` from a pointer that was resting on the panel
 * when the shopper left; after a restore the pointer is not known to be there,
 * so "not paused, count from now" is the right answer either way. Without the
 * cache, back is a full reload: `mountApp` runs again, this file runs again,
 * the carousel starts at slide 1 with a fresh count — the other path §2.3
 * describes, and the only one Playwright can drive.
 *
 * Neither window listener is ever removed. The app has no unmount — a page is
 * built once per document and lives as long as it — and a cached page keeps
 * its listeners along with everything else, which is exactly what lets
 * `pageshow` find this one.
 *
 * ARIA per technical-considerations §2.4: the section is a carousel named
 * «Предложения», each slide a group named «N из 4», the dots named «Слайд N из
 * 4» with `aria-current` on the one showing, the arrows «Предыдущий слайд» /
 * «Следующий слайд». The panel is `aria-live="off"`: a region that rotates on
 * its own must not announce every change (the APG carousel pattern). Headlines
 * are paragraphs, not headings — the page has one h1 and the row's h2, and
 * four rotating h2s would put the outline on a timer. The arrows and dots are
 * buttons, so Enter and Space work with no key handler of their own.
 */
import { createElement } from "../../../shared/lib/dom.js";
import { bannerSlides, type BannerSlide } from "../config/banner-slides.js";
import { dotLabel, slideLabel, text } from "../config/text.js";
import {
  createCarouselState,
  reduceCarousel,
  TimerInstruction,
  type CarouselEvent,
  type CarouselState,
} from "../model/carousel.js";
import { createCountdown } from "../model/countdown.js";
import { createIcon } from "./icon.js";

/**
 * Functional spec §2.2 crit 1: "the banner advances to the next slide every
 * 5 seconds". The only place the duration is written; the reducer never sees
 * it, and `e2e/banner.spec.ts` drives the boundary at 5 000 and not at 4 999.
 */
const AUTO_ADVANCE_MS = 5000;

const slideCount = bannerSlides.length;

/**
 * One slide, with neither `hidden` nor its absence decided here: which slide
 * shows is state, and {@link createBanner}'s `render` is the one place that
 * paints state.
 */
function renderSlide(slide: BannerSlide, index: number): HTMLElement {
  return createElement(
    "div",
    {
      className: "banner__slide",
      attributes: {
        role: "group",
        "aria-roledescription": "slide",
        "aria-label": slideLabel(index + 1, slideCount),
      },
    },
    [
      createElement("p", { className: "banner__headline", text: slide.headline }),
      createElement("p", { className: "banner__text", text: slide.text }),
    ],
  );
}

/** One dot; `aria-current` is state and is painted by `render`, as above. */
function renderDot(_slide: BannerSlide, index: number): HTMLButtonElement {
  return createElement("button", {
    className: "banner__dot",
    attributes: { type: "button", "aria-label": dotLabel(index + 1, slideCount) },
  });
}

function assertNever(value: never): never {
  throw new Error(`Unexpected timer instruction: ${String(value)}`);
}

export function createBanner(): HTMLElement {
  const slides = bannerSlides.map(renderSlide);
  const dots = bannerSlides.map(renderDot);

  let state: CarouselState = createCarouselState(slideCount);

  const countdown = createCountdown(() => {
    dispatch({ type: "tick" });
  });

  /**
   * Paint the state. Both loops compare `i === state.index` rather than
   * subscripting `slides` by `state.index`: under `noUncheckedIndexedAccess`
   * that lookup is `HTMLElement | undefined`, and the `!` it invites would silence
   * exactly the bug it is there to flag — a reducer answering with an index
   * that names no slide (R7). The reducer keeps the index in range and its
   * unit test proves it; iterating asks nothing of that proof.
   */
  function render(): void {
    slides.forEach((slide, i) => {
      slide.hidden = i !== state.index;
    });

    dots.forEach((dot, i) => {
      if (i === state.index) {
        dot.setAttribute("aria-current", "true");
      } else {
        dot.removeAttribute("aria-current");
      }
    });
  }

  /**
   * The one place a carousel event reaches the countdown. Three words in,
   * three calls out — and `keep` is a call to nothing, which is the point: a
   * row of the policy table that leaves the timer alone must not touch it.
   */
  function applyTimer(instruction: TimerInstruction): void {
    switch (instruction) {
      case TimerInstruction.Restart:
        countdown.restart(AUTO_ADVANCE_MS);
        return;

      case TimerInstruction.Cancel:
        countdown.cancel();
        return;

      case TimerInstruction.Keep:
        return;

      default:
        return assertNever(instruction);
    }
  }

  /** Reduce, paint, apply — in that order, every time, for every event. */
  function dispatch(event: CarouselEvent): void {
    const step = reduceCarousel(state, event);
    state = step.state;
    render();
    applyTimer(step.timer);
  }

  /**
   * "The page is in front of the shopper and the pointer is not on the panel:
   * count five seconds from now." A `pointer-leave` says exactly that — it
   * clears `isPaused` and answers `restart` — which is why it is the event for
   * both moments this is called: once the element is built, and after a
   * back/forward-cache restore. A direct `countdown.restart` would do for the
   * first moment but not the second (it would leave a stale `isPaused`
   * standing, and the next tick would be dropped as "while paused"), and
   * going through the reducer for both keeps this file to its rule: the
   * reducer decides, `applyTimer` applies. It also paints, so the first call
   * is what shows slide 1 and puts `aria-current` on the first dot.
   */
  function resume(): void {
    dispatch({ type: "pointer-leave" });
  }

  const panel = createElement(
    "div",
    { className: "banner__panel", attributes: { "aria-live": "off" } },
    slides,
  );

  // The pause region — see the file header for why it is the panel alone.
  panel.addEventListener("pointerenter", () => {
    dispatch({ type: "pointer-enter" });
  });
  panel.addEventListener("pointerleave", () => {
    dispatch({ type: "pointer-leave" });
  });

  const previous = createElement(
    "button",
    {
      className: "banner__arrow banner__arrow--prev",
      attributes: { type: "button", "aria-label": text.banner.previous },
    },
    [createIcon("arrow-left")],
  );
  previous.addEventListener("click", () => {
    dispatch({ type: "prev" });
  });

  const next = createElement(
    "button",
    {
      className: "banner__arrow banner__arrow--next",
      attributes: { type: "button", "aria-label": text.banner.next },
    },
    [createIcon("arrow-right")],
  );
  next.addEventListener("click", () => {
    dispatch({ type: "next" });
  });

  dots.forEach((dot, i) => {
    dot.addEventListener("click", () => {
      dispatch({ type: "dot", index: i });
    });
  });

  const banner = createElement(
    "section",
    {
      className: "banner",
      attributes: { "aria-roledescription": "carousel", "aria-label": text.banner.label },
    },
    [
      panel,
      createElement("div", { className: "banner__arrows" }, [previous, next]),
      createElement("div", { className: "banner__dots" }, dots),
    ],
  );

  // Slide 1 painted and the first count started, before the element is
  // handed to the page. The clock runs from build, not from attach: the
  // milliseconds between the two are a synchronous `replaceChildren` away.
  resume();

  // Page lifecycle — see the file header. Never removed: there is no unmount.
  window.addEventListener("pagehide", () => {
    countdown.cancel();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      resume();
    }
  });

  return banner;
}
