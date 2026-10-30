---
name: vc-symfony
description: Use for PHP and Symfony implementation or diagnosis; discovers installed versions, components, persistence, runner, and tests before choosing APIs
---

# Symfony workflow

## Discover before scaffolding

1. Read `composer.json`, `composer.lock`, and `symfony.lock` to learn the PHP and
   Symfony versions, installed packages, and Flex recipes.
2. Inspect routing, service config, controllers, persistence, templates/API
   entry points, and the existing tests. Don't assume Doctrine ORM, Twig,
   API Platform, Form, Security, or Serializer are installed.
3. If persistence (including "none"), interface (page, API, CLI), or
   authentication is unspecified, ask before scaffolding.
4. Find the runner: `ddev` (load `vc-ddev`), the Symfony CLI, or `bin/console`.
   Check `bin/console help <command>` and the docs for the installed version.

## Implementation

- Keep controllers thin (mapping, authorization, calling a service, building the
  response) and put logic in focused services.
- Use installed components instead of hand-rolling: Form, Validator, Security,
  Serializer, Lock. Ask before adding or upgrading packages.
- Use attributes, autowiring, and promoted constructor injection where the
  installed versions support them.
- Let Flex recipes register and configure bundles; don't hand-wire them.
- Make DTOs `readonly` where PHP allows. DTOs aren't services, so don't make them
  lazy to work around autowiring errors.
- Use `#[MapRequestPayload]`/`#[MapQueryString]` only after confirming the
  installed version supports them and Serializer/Validator are present. Option
  names differ between versions. Don't hand-parse JSON when a framework
  facility fits.
- Preserve existing validation errors, response formats, status codes, and
  access checks.

## Privacy (GDPR/DSGVO)

Every bundle, controller, and template change must comply with GDPR/DSGVO and
TDDDG:

- **No third-party requests before consent.** Serve fonts, CSS, and JS from the
  app (no Google Fonts or CDNs): AssetMapper packages downloaded into
  `assets/vendor/`, not CDN URLs; Encore/Vite bundles. Embeds, analytics, and
  marketing scripts load only after opt-in through the project's consent
  manager.
- **Third-party bundles and packages:** before adding one, check for external
  calls, non-essential cookies, or tracking, and report what you found.
- **Personal data:** collect only what the purpose needs, and state the purpose
  at the form. Keep personal data and full IPs out of logs (redact with Monolog
  processors). Plan retention or deletion and restrict access with Security
  voters.
- Only essential cookies (session, CSRF) without consent; no data to non-EU
  services without the user's explicit approval.
- Flag legal decisions (legal basis, data processing agreement, privacy policy
  text) instead of making them.

## Persistence

Follow whatever persistence is installed. With Doctrine migrations, generate the
migration and review its SQL for data loss. Never use
`doctrine:schema:update --force` instead of a migration. Confirm the target
database before any data-changing command, and ask before destructive ones.
Use the project's secret/env conventions and don't dump `.env` files.

## Commands and tests

```sh
# DDEV project
ddev php bin/console help make:controller
ddev php bin/phpunit tests/Controller/SomeControllerTest.php

# Without DDEV, if that's the documented runner
php bin/console --version
php bin/phpunit
```

- Give Maker commands all required arguments so they don't hang on an
  interactive prompt; ask the user if choices are unknown.
- Write caller-level tests: `WebTestCase` for HTTP, `KernelTestCase` for
  container integration. If there's no test setup, suggest `symfony/test-pack`
  and ask first.
- Run the narrow test first, then the suite and any static checks.
- Respect the project's coding standard. If PHP-CS-Fixer is installed without
  custom rules, use `@Symfony` in check/dry-run mode.
- Use dev logs and the profiler for diagnosis, and redact secrets from anything
  you report.

## References

- [Symfony documentation](https://symfony.com/doc/current/index.html): pick the installed version
- [Controllers and request mapping](https://symfony.com/doc/current/controller.html)
- [Testing](https://symfony.com/doc/current/testing.html)
- [Symfony Flex](https://symfony.com/doc/current/setup/flex.html)
