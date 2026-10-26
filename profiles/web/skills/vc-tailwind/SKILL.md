---
name: vc-tailwind
description: Use when inspecting, configuring, authoring, or debugging Tailwind CSS in an existing web project.
---

# Tailwind workflow

## Find the installed version

Check the lockfile, stylesheet entrypoints, and build scripts. Determine the
Tailwind major version from evidence; never install the newest version by
default. Identify how CSS is built: AssetMapper, Encore, Vite, or the Tailwind
CLI (through `ddev` if configured).

## Follow that version's conventions

- **v3:** `tailwind.config.js` with `content` paths and `@tailwind` directives.
- **v4:** CSS-first, with `@import "tailwindcss"` and `@theme` in CSS.
- Never mix the two styles, and never create `tailwind.config.js` in a v4
  project. If the version is unclear, investigate before making changes that
  depend on it.

## Writing classes

- Use complete literal class names. `"bg-" + color` is invisible to the scanner;
  use a lookup of full class names or CSS variables instead.
- Reuse existing theme tokens and component patterns. Prefer tokens over
  arbitrary values, and extract repeated long utility strings.
- Use semantic HTML, keep focus visible, maintain contrast, and use `motion-safe:`
  or `motion-reduce:` for animation.
- Don't add plugins, frameworks, or a new build setup without asking.

## Verify

Run the existing build and confirm the changed templates are covered by the
scanner, then run lint/tests. Only claim a visual check if you actually saw the page.

## Docs

- Current: https://tailwindcss.com/docs
- v3: https://v3.tailwindcss.com/docs
- Upgrade guide: https://tailwindcss.com/docs/upgrade-guide
