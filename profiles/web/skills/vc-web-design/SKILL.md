---
name: vc-web-design
description: Use when defining, reviewing, or implementing a web page's visual direction, layout, typography, color, responsive behavior, or accessible interaction states.
---

# Web design workflow

## Learn the project

Look at the current pages, components, design tokens, and stylesheets. Work
within the existing stack and identity. If a consequential choice depends on the
audience or a reference you don't have, ask; otherwise decide and note why.

## Set a direction

- Give each view a clear focal point. Make deliberate choices about type scale,
  spacing, color, content width, and alignment.
- Reuse existing tokens and components. If there's no system, define a small
  coherent set instead of one-off values.
- Avoid generic template looks and decoration that serves no purpose.
- Design for real content and for narrow screens: say how navigation, columns,
  and media adapt, rather than just shrinking the desktop layout.
- Treat controls as states: default, hover, focus-visible, disabled, invalid,
  and success. Ensure keyboard use, labels, contrast, target size, and
  zoom/reflow.
- Use motion only with a purpose, and respect `prefers-reduced-motion`.

## Hand off

When `VC-Frontend` builds on your work, give it concrete specs (layout, type,
colors, breakpoints, states) and say clearly which files each of you owns.

## Review

Check the result at different viewport sizes, with the keyboard, and at zoom. Fix
real usability problems before aesthetic ones. Only claim a visual check if you
actually saw the page.

## References

- Tailwind CSS: https://tailwindcss.com/docs
- Symfony: https://symfony.com/doc/current/index.html
- Twig: https://twig.symfony.com/doc/
