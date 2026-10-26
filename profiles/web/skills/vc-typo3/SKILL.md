---
name: vc-typo3
description: Use for TYPO3 extensions, site packages, TCA, TypoScript, Fluid, and Extbase work; finds the installed TYPO3 version before choosing APIs
---

# TYPO3 workflow

## Find the version first

1. Read `composer.lock` for the installed `typo3/cms-core` version, and the PHP
   version in use (`ddev php -v`, or `composer.json` `config.platform`). Every API
   choice below depends on this major version.
2. Look up anything you're unsure of in the docs for **that** version
   (docs.typo3.org, using the version switcher). TYPO3 changes registration
   APIs often between majors, so code from a blog post or an older project is
   often wrong for this one.
3. Check whether `helhum/typo3-console` is installed. Some commands, such as
   `database:updateschema`, come from it, not from the core.
4. If the project uses DDEV, load `vc-ddev` and run everything through it, e.g.
   `ddev exec vendor/bin/typo3 <command>` or `ddev typo3 <command>` if that
   custom command exists.

## Extension structure

```
my_ext/
  composer.json                # "type": "typo3-cms-extension", extra.typo3/cms.extension-key
  ext_emconf.php               # only if the project or TER still needs it
  ext_localconf.php            # keep minimal; prefer the Configuration/ files below
  ext_tables.sql               # table/field definitions, applied by database compare
  Classes/                     # PSR-4: Controller/, Domain/Model/, Domain/Repository/, EventListener/, Command/
  Configuration/
    Services.yaml              # DI: autowire/autoconfigure, event listeners, commands
    TCA/<table>.php            # own tables; TCA/Overrides/<table>.php to change others
    TypoScript/                # setup.typoscript / constants.typoscript (classic setup)
    Sets/<SetName>/            # site sets (newer versions): config.yaml, settings.definitions.yaml, setup.typoscript
    Backend/Modules.php        # backend modules (newer versions)
    Icons.php                  # icon registration
  Resources/Private/{Templates,Layouts,Partials,Language}/
  Resources/Public/{Css,JavaScript,Icons}/
  Tests/{Unit,Functional}/
```

Check the installed version before relying on anything marked "newer versions".
Follow whatever structure the existing extensions in the project already use.

## Conventions

- **Dependency injection:** use constructor injection with `Services.yaml` and
  autowiring. Don't use `GeneralUtility::makeInstance()` for services that can be
  injected, or `ObjectManager`.
- **Extending the core:** prefer PSR-14 events (an `EventListener` registered in
  `Services.yaml` or with the `#[AsEventListener]` attribute) over hooks. Check
  that the event exists in the installed version.
- **TCA:** put changes to core or other extensions' tables in
  `Configuration/TCA/Overrides/`, never in `ext_tables.php`. New fields need
  both TCA and `ext_tables.sql` (or rely on automatic columns where the version
  supports them).
- **Extbase/Fluid:** keep controllers thin, put logic in services, and use
  repositories for persistence. Register plugins through `ExtensionUtility`
  (`configurePlugin`/`registerPlugin`) as the installed version documents. Escape
  output in Fluid by default, and use `f:format.raw` only on trusted content.
- **Translations:** use XLIFF in `Resources/Private/Language/`. No hardcoded
  user-facing strings.
- **Security:** query through QueryBuilder with named parameters, never by
  concatenating strings. Check backend user permissions in modules, and validate
  input in Extbase actions.

## Site package

A site package is the project's own extension holding its frontend: templates,
TypoScript or site sets, backend layouts, content element tweaks, and assets.

- It usually lives in the project as a local Composer path repository (e.g.
  `packages/site_package`, `"repositories": [{"type": "path", "url": "packages/*"}]`)
  and is required as `"vendor/site-package": "@dev"`.
- Site configuration lives in `config/sites/<identifier>/config.yaml` (and
  `settings.yaml` where used). On versions with site sets, have the site depend
  on the site package's set rather than including TypoScript in a database
  template record.
- Templates: use Fluid page templates and backend layouts (`.tsconfig` or the
  page TSconfig in the set). Keep the asset build (Vite, Webpack, plain CSS)
  whatever the project already uses; load `vc-tailwind` if it uses Tailwind.

## Commands

```sh
ddev exec vendor/bin/typo3 list                 # see what's actually available
ddev exec vendor/bin/typo3 cache:flush
ddev exec vendor/bin/typo3 extension:setup      # set up extensions, apply ext_tables.sql changes
ddev exec vendor/bin/typo3 upgrade:list
```

After adding or changing fields: run the database compare (`extension:setup`,
typo3-console's `database:updateschema`, or Admin Tools → Maintenance → Analyze
Database Structure), then flush caches. Never apply destructive schema changes,
such as dropping or renaming fields and tables, without the user's consent.

## Tests and checks

- Use `typo3/testing-framework` for unit and functional tests if it's installed.
  Functional tests need a database; use the project's existing setup.
- Run the project's static analysis and coding standard (PHPStan, PHP-CS-Fixer
  with the TYPO3 rules) in check mode.
- Check the frontend and backend in the browser only if you actually can; say
  so if you didn't.

## References

- Core API and explained docs: https://docs.typo3.org/m/typo3/reference-coreapi/main/en-us/ (switch to the installed version)
- TCA reference: https://docs.typo3.org/m/typo3/reference-tca/main/en-us/
- TypoScript reference: https://docs.typo3.org/m/typo3/reference-typoscript/main/en-us/
- Core changelog: https://docs.typo3.org/c/typo3/cms-core/main/en-us/
