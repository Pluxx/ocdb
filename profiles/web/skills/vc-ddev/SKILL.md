---
name: vc-ddev
description: Use for existing DDEV projects, container-prefixed application commands, and environment diagnosis with version discovery and consent before disruptive changes
---

# DDEV workflow

## Identify the project

Read `.ddev/config.yaml`, any `config.*.yaml` overrides, custom commands
(`.ddev/commands/`), hooks, add-ons, and service definitions. Note the project
type, docroot, Composer root, PHP/database versions, and ports.

Check what's installed before relying on flags:

```sh
ddev version
ddev describe
ddev help exec
```

If DDEV is missing or the project is stopped, report it and agree on the next
step rather than starting or installing things silently. Online docs may be
newer than the installed version.

## Run commands in the containers

Use `ddev php`, `ddev composer`, and `ddev exec` instead of host PHP/Composer.
Check for project scripts and custom commands before inventing new ones:

```sh
ddev php bin/console --version
ddev composer --version
ddev exec npm run test
```

## Diagnose before changing config

- Read `ddev describe` and the logs: `ddev logs` for web, `ddev logs -s db` for
  the database. Avoid `-f` (follow) in automation, because it never exits.
- Tell apart application errors, service failures, port conflicts, missing
  dependencies, and host/container version mismatches.
- Make the smallest project-scoped change. Don't reset Docker/DDEV globally or
  restart other projects to hide a local problem.

## Ask first

Get explicit consent, stating the affected project, data, and backup situation,
before:

- `ddev delete`, `ddev import-db`, database resets, or destructive SQL.
- Volume pruning or Docker provider resets.
- `ddev poweroff` or anything that stops other projects.
- Changing PHP/database versions, exposing ports, or installing add-ons.

Don't assume a dev database is disposable.

## Validate

Re-run the command that originally failed, recheck service status and logs, and
run the relevant app checks through DDEV. A config edit alone doesn't prove the
fix.

## References

- [DDEV documentation](https://docs.ddev.com/)
- [Commands](https://docs.ddev.com/en/stable/users/usage/commands/)
- [Configuration](https://docs.ddev.com/en/stable/users/configuration/config/)
