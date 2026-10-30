---
name: vc-web-design
description: Use when defining, reviewing, or implementing a web page's visual direction, layout, typography, color, motion, or interaction states; aims for distinctive, modern, WCAG 2.2 AA compliant design
---

# Web design workflow

The goal is design that looks deliberate and current, moves well, and passes
WCAG 2.2 AA. "Clean and safe" defaults produce average results: commit to a
direction.

## 1. Understand before designing

- Look at the current pages, brand assets, components, tokens, and stylesheets,
  and check the CSS stack (Tailwind v3/v4, plain CSS, Sass) and the browser
  support target.
- Learn the audience, the main task of the page, and the content that actually
  goes on it. Design with real content lengths, not lorem ipsum.
- If there's an existing identity, evolve it rather than replacing it. If a
  key input (audience, brand, references) is missing and matters, ask.

## 2. Commit to a direction

Before writing code, write a short direction (5–10 lines) and follow it:

- **Concept:** three adjectives, e.g. "precise, calm, technical" or "warm,
  editorial, generous", and one reference style it leans on.
- **Typography:** a display/text pairing with a reason, the scale ratio, and
  how headings behave (tight leading, negative tracking at large sizes).
- **Color:** a mostly neutral base, one primary accent used sparingly, and
  semantic colors. Say how dark mode works if the site has it.
- **Layout idea:** the grid, where it breaks deliberately, and the density.
- **Motion character:** e.g. "quick and crisp, no bounce" or "soft and
  continuous", plus the one or two signature moments.

## 3. Build tokens first

Define these as CSS custom properties, or as `@theme` tokens in Tailwind v4,
before styling components:

- **Type:** a fluid scale with `clamp()`, e.g. a ratio of 1.2 on mobile to 1.25
  on desktop. Body text 16–18px, line length 60–75ch, `text-wrap: balance` on
  headings and `pretty` on paragraphs.
- **Space:** one scale (4/8-based), used consistently for padding, gaps, and
  section rhythm. Generous section spacing is the cheapest way to look premium.
- **Color:** in `oklch()`, so steps are perceptually even. Derive tints and
  states with `color-mix()` or relative color syntax. Every text/background pair
  you define must meet contrast (see section 7). Write the ratios down.
- **Surfaces:** radius scale, border colors with alpha, and a small elevation
  scale (2–3 layered shadows, not one big blurry one).
- **Motion:** durations of about 120ms (micro), 200ms (small), 320ms (medium)
  and 500ms (large/page), plus easing curves:
  - `--ease-out: cubic-bezier(0.2, 0, 0, 1)` for entering.
  - `--ease-in: cubic-bezier(0.4, 0, 1, 1)` for leaving.
  - `--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1)` for moving.

## 4. Avoid the "average" look

Check the design against these before calling it done:

| Average | Better |
| --- | --- |
| Centered hero, gradient blob, two buttons | A layout built around the content: asymmetric split, oversized type, a real image or product visual |
| Everything the same size and weight | A clear scale: one dominant element per section, big contrast between display and body text |
| Gray-on-white everywhere | A tinted neutral palette, one confident accent, and real darks |
| Three identical rounded cards in a row | Varied rhythm: feature rows, bento grid with different spans, lists, quotes |
| Default system font for everything | An intentional pairing (variable fonts where possible), with tuned tracking and leading |
| Shadows and borders on every box | Separation through space and tone first, then borders/shadows only where they add meaning |
| Random animations on scroll | A few choreographed moments that support the content |

**Details that make it look finished:** optical alignment, consistent icon
stroke width, hairline borders with alpha, sparing background texture or
gradient meshes, consistent image aspect ratios and art direction, hover states
that feel physical, and designed (not default) empty, loading, and error states.

## 5. Modern CSS: use it, with fallbacks

Check browser support against the project's target, and gate newer features with
`@supports`. The page must work, unanimated, without them.

- **Layout:** container queries (`@container`) for components, `subgrid` for
  aligned card internals, `:has()` for parent/state styling, and `aspect-ratio`.
- **Entry and exit:** `@starting-style` plus `transition-behavior: allow-discrete`
  to animate elements appearing (including `display`, `<dialog>`, and
  `popover`). Use the native `<dialog>` and `popover` instead of JS modals and
  tooltips where you can.
- **Page and state transitions:** the View Transitions API.
  `document.startViewTransition()` for in-page state changes, and
  `@view-transition { navigation: auto; }` for cross-document (MPA, e.g.
  Twig/TYPO3) transitions where supported. Give shared elements a
  `view-transition-name`.
- **Scroll-driven animations:** `animation-timeline: view()` / `scroll()` for
  reveal and progress effects, with no JS scroll listeners. Wrap them in
  `@supports (animation-timeline: view())`.
- **Effects:** `backdrop-filter` (glass, sparingly, with an opaque fallback),
  `mask-image` gradients for fades, `@property` to animate gradients and custom
  properties, `color-mix()` for state colors, and `linear()` easing for
  spring-like curves without JS.
- **Tailwind v4:** tokens live in `@theme`. Use the `motion-safe:`,
  `motion-reduce:`, and `starting:` variants, and `@container` utilities. Load
  `vc-tailwind`.

## 6. Motion rules

- Every animation needs a job: feedback (press, hover), orientation (where did
  this come from?), continuity (state A → B), or one deliberate moment of
  delight. Otherwise, remove it.
- Animate only `transform` and `opacity` (plus `filter`/`clip-path` sparingly).
  Never animate layout properties such as `width`, `height`, `top`, or `margin`.
- Keep distances small (8–24px). Enter with ease-out, exit faster than enter
  with ease-in, and stagger lists by 30–60ms (cap the total at ~300ms).
- Use hover effects only on devices that hover: `@media (hover: hover)`. Give
  touch its own press feedback.
- Use `will-change` only during an animation, never as a blanket rule.
- **Reduced motion is required.** Under `@media (prefers-reduced-motion: reduce)`:
  - Replace movement with an opacity fade or an instant change.
  - Turn off parallax, scroll-driven motion, autoplaying video/carousels, and
    large view transitions.
  - Keep essential feedback, such as focus and state changes.
- Anything that moves automatically for more than 5 seconds needs a visible
  pause control (WCAG 2.2.2). Never flash more than 3 times per second (2.3.1).

## 7. WCAG 2.2 AA: a hard gate

Design and verify against these. Don't hand over a design that fails one.

- **Contrast (1.4.3, 1.4.11):** 4.5:1 for body text, and 3:1 for large text
  (24px+, or 18.66px+ bold), UI component boundaries, icons, and focus
  indicators. Check every token pair, in both light and dark themes, including
  text on images or gradients (add a scrim if needed). Placeholder text counts.
- **Focus (2.4.7, 2.4.11):** a clearly visible `:focus-visible` style with 3:1
  contrast against its surroundings, never removed. Sticky headers and footers
  must not cover the focused element (`scroll-padding-top`).
- **Target size (2.5.8):** interactive targets of at least 24×24px, or enough
  spacing. Aim for 44×44px on touch-heavy UI.
- **Reflow and text (1.4.4, 1.4.10, 1.4.12):** nothing breaks at 320px wide or
  200% zoom, and nothing clips when users increase line, letter, and word
  spacing. Use `rem` and fluid sizes, never fixed heights on text containers.
- **Don't rely on color alone (1.4.1):** errors, links in body text, and status
  need an icon, text, or underline as well.
- **Semantics:** landmarks, one `h1`, a logical heading order, real
  `<button>`/`<a>`, labels tied to inputs, `alt` text, and accessible names for
  icon buttons. Don't put ARIA where native HTML works.
- **Forms (3.3.x):** visible labels, errors next to fields that say how to fix
  them, and no re-entering data already given (3.3.7).
- **Forced colors:** under `@media (forced-colors: active)`, focus and borders
  stay visible. Don't build focus rings only out of `box-shadow`; use `outline`.
- **Motion:** as in section 6.

## 8. Verify

- Compute the contrast ratios of your token pairs (with the project's tooling,
  or a quick script) and list them.
- Keyboard: tab through the whole page. The order must be logical and focus
  always visible and unobscured; dialogs trap focus and Escape closes them.
- Check at 375px, 768px, and 1440px wide, and at 200% zoom. If a browser or
  screenshot tool is available in this session, use it and look at the result.
- Emulate `prefers-reduced-motion: reduce` and `forced-colors`, and check
  dark mode if the site has it.
- Run axe, pa11y, or Lighthouse if the project has them.
- Only report checks you actually ran.

## Hand-off

When `VC-Frontend` builds on your work, give it the direction (section 2), the
token file, the layout per breakpoint, the component states, and the motion
spec (element, property, duration, easing, trigger, reduced-motion behavior).
Say clearly which files each of you owns.

## References

- WCAG 2.2: https://www.w3.org/TR/WCAG22/ and the quick reference at https://www.w3.org/WAI/WCAG22/quickref/
- MDN: View Transitions, scroll-driven animations, `@starting-style`, container queries
- Browser support: https://caniuse.com and https://web.dev/baseline
- Tailwind CSS: https://tailwindcss.com/docs
