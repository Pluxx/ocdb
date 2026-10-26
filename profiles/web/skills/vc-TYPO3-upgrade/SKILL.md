---
name: vc-TYPO3-upgrade
description: Use for TYPO3 major version upgrades; a step-by-step procedure with Rector, Fractor, changelog review, upgrade wizards, and database compare
---

# TYPO3 major upgrade

Load `vc-TYPO3` too (and `vc-ddev` for DDEV projects). Turn the steps below into
a todo list and work through them in order. Upgrade **one major version at a
time** (e.g. 12 → 13, then 13 → 14), even if the target is several versions away.

## 0. Before touching anything

- Record the starting point: the `typo3/cms-core` version and PHP version (from
  `composer.lock`), and all extensions with their versions (`composer show`,
  filtered to TYPO3 extensions).
- Make sure work can be rolled back:
  - The working tree must be clean in git, on its own branch, with one commit
    per step.
  - Take a database snapshot, after asking the user: `ddev snapshot --name
    pre-typo3-<target>` in DDEV projects.
  - Never import, reset, or drop data without explicit consent.
- Get on the **latest patch release of the current major** first, and get it
  working there.
- Fix the deprecations the current version already logs. Enable the deprecation
  log, run the extension scanner (Admin Tools → Upgrade → Scan Extension Files)
  on the project's own extensions, and clear what it flags. Deprecated in N
  usually means removed in N+1.

## 1. Check compatibility

- Check the target version's PHP and database requirements against the project
  (DDEV `php_version` and `database`). Change them only with consent, because it
  restarts containers.
- For every third-party extension, find a release that supports the target major
  (its `composer.json` constraint on `typo3/cms-core`, Packagist, or the TER).
  List any that have none. Those block the upgrade; ask the user whether to wait,
  replace, or fork them.

## 2. Read the breaking changes

Read the core changelog for the target version
(https://docs.typo3.org/c/typo3/cms-core/main/en-us/Changelog/Index.html):
the **Breaking** entries, and the deprecations that are now removed. Note which
ones touch the project's own code, TCA, TypoScript, or templates. Search the
codebase (use `VC-Explorer` for broad searches) for the affected classes, hooks,
TCA options, and TypoScript paths.

## 3. Automated migration

Run these on the project's own extensions and site package, not on `vendor/`:

- **Rector** with the TYPO3 rule sets (`ssch/typo3-rector`), using the sets for
  each version step. Run it with `--dry-run` first, review the diff, then apply.
- **Fractor** (`a9f/typo3-fractor`) for non-PHP files: TypoScript, FlexForms,
  Fluid, YAML, XLIFF.

Install them as dev dependencies if needed (ask first). Commit the result
separately, and review it: automated rules don't cover everything in the
changelog.

## 4. Update Composer

```sh
ddev composer require "typo3/cms-core:^<target>" ... --update-with-all-dependencies
```

- Raise **all** `typo3/cms-*` packages to the same major together, along with
  compatible third-party extension versions and the site package's own
  constraint.
- Resolve conflicts by updating constraints, never by `--ignore-platform-reqs`.

## 5. Migrate the database and run the upgrade wizards

```sh
ddev exec vendor/bin/typo3 extension:setup
ddev exec vendor/bin/typo3 upgrade:list
ddev exec vendor/bin/typo3 upgrade:run          # or run single wizards by identifier
ddev exec vendor/bin/typo3 cache:flush
```

- Run the database compare (Admin Tools → Maintenance → Analyze Database
  Structure, or TYPO3 Console's `database:updateschema`). Additions and changes
  are fine.
- **Removals and renames need the user's consent**, after checking that the data
  has been migrated.
- Repeat `upgrade:list` until nothing required is left. Clear all caches, and
  remove `var/cache` if stale classes persist.

## 6. Fix what's left, then verify

- Work through the breaking changes from step 2 that the automated tools didn't
  handle. Use the version's own docs for each replacement API.
- Check: the PHP error/deprecation log, the TYPO3 system log (Admin Tools →
  Log), the frontend on key pages, the backend (page module, list module, own
  backend modules, content elements, forms), the scheduler, and CLI commands.
- Run the project's tests and static analysis (`VC-Tester`).
- Then start again at step 0 for the next major version, if the target is
  further away.

## Report

For each major step, report:

- Versions before and after.
- Extensions updated, replaced, or blocked.
- What Rector and Fractor changed, and what was fixed by hand.
- Database changes applied and those still awaiting consent.
- The checks you ran, with results.
- What wasn't verified.
