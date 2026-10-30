# OCDB — Open Code Đặc Biệt

OCDB is an agent configuration for **OpenCode V2** aimed at PHP, Symfony, TYPO3,
DDEV, HTML/CSS/JS and Tailwind work. It provides:

- a primary agent (`VC-Orchestrator`) with nine specialised subagents,
- seven skills and six slash commands,
- seven model profiles across OpenAI, OpenCode Go, OpenCode Zen and DeepSeek,
  switchable live from the sidebar,
- a TUI sidebar plugin for agent activity and CPU/RAM, and an optional
  ChatGPT/Codex weekly-quota plugin.

Installation and activation are transactional: every file OCDB writes is
tracked by hash, every config edit is backed up, and both can be reverted
exactly. ("Đặc Biệt" is Vietnamese for "special".)

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [CLI reference](#cli-reference)
- [Agents and model routing](#agents-and-model-routing)
- [Skills and commands](#skills-and-commands)
- [Sidebar plugins](#sidebar-plugins)
- [Configuration changes and state](#configuration-changes-and-state)
- [Security model and limitations](#security-model-and-limitations)
- [Development](#development)

## Requirements

| Component | Version |
| --- | --- |
| Node.js | 22.18 or newer |
| npm, git | any current release |
| OpenCode | 2.x (checked by `ocdb doctor` and `ocdb setup`) |
| OS | Linux or macOS (CI runs on Ubuntu with Node 22 and 24) |

Providers:

| Provider ID | Account required |
| --- | --- |
| `openai` | ChatGPT/Codex subscription |
| `opencode-go` | OpenCode Go subscription |
| `opencode` | OpenCode Zen (pay-as-you-go) |
| `ocdb-deepseek` | DeepSeek API key (pay-as-you-go) |

Model profiles (HQ = quality first, LC = low cost):

| Profile | Label | Requires | Intent |
| --- | --- | --- | --- |
| `oai-hq` | OAI-HQ | `openai` | OpenAI: Sol 6.1 leads and reviews, Terra 6.1 implements, Astra solves |
| `oai-lc` | OAI-LC | `openai` | OpenAI low cost: Terra 6.1 everywhere, Luna for search and checks, Sol 6.1 solves |
| `ocgo-hq` | OCGO-HQ | `opencode-go` | OpenCode Go: Kimi K3.1 Pro leads and reviews, MiniMax M3.1 Flash implements, Gemini 4 Argon designs |
| `ocgo-lc` | OCGO-LC | `opencode-go` | OpenCode Go low cost: DeepSeek V4.1 Flash everywhere, Kimi K2.7 Code designs, Qwen3.8 Max solves |
| `oai-ocgo-mix` | OAI-OCGO-MIX | `openai` + `opencode-go` | Balanced across both subscriptions: OpenAI leads and implements, Go reviews, designs and does the cheap work |
| `opencode-zen` | ZEN | `opencode` | OpenCode Zen pay-as-you-go; GPT models through OpenCode |
| `deepseek` | DEEPSEEK | `ocdb-deepseek` | DeepSeek API directly; pay-as-you-go, untested end to end |

## Installation

An agent can perform the installation. Give it this instruction:

```text
Install and configure OCDB: https://raw.githubusercontent.com/Pluxx/ocdb/main/README.md
```

> **Instructions for agents:** follow the steps below in order and ask the user
> the questions in step 3 before running setup. Never request or handle API
> keys or passwords. Provider sign-in happens in OpenCode (`/connect`); Codex
> sign-in happens through `ocdb quota login`, which the user runs themselves.

### 1. Verify prerequisites

```sh
node --version && npm --version && git --version && opencode --version
```

### 2. Clone and link the CLI

Clone into a permanent location. The quota plugin is symlinked from this
checkout, so it must not be moved or deleted afterwards.

```sh
git clone https://github.com/Pluxx/ocdb.git ~/.local/share/ocdb
cd ~/.local/share/ocdb
npm ci
mkdir -p ~/.local/bin && ln -sf ~/.local/share/ocdb/bin/vc-ocdb.mjs ~/.local/bin/ocdb
ocdb doctor
```

`~/.local/bin` is on `PATH` by default on most Linux distributions (a new shell
may be required). Otherwise, substitute `node bin/vc-ocdb.mjs` for `ocdb`. Avoid
`npm link` with a system-wide Node installation, as it requires root.

### 3. Select options

| Question | Flag |
| --- | --- |
| Which providers do you have? | `--providers openai,opencode-go,...` picks the preferred profile they can run |
| Or: which profile? (see [Requirements](#requirements)) | `--profile oai-hq \| oai-lc \| ocgo-hq \| ocgo-lc \| oai-ocgo-mix \| opencode-zen \| deepseek` |
| Make VC-Orchestrator the default agent? (recommended) | `--activate` |
| Profiles using `openai`: show the weekly quota in the sidebar? | `--openai-quota` |
| Profiles using `openai`: read the quota through the Codex sign-in? | `--codex-quota` (requires `--openai-quota`) |

The installed profile is only the starting point: any other profile can be
selected live from the sidebar afterwards (see [Switching profiles](#switching-profiles)).

With `--codex-quota`, Codex may refresh its stored credentials whenever the
quota is read.

### 4. Preview and apply

```sh
ocdb setup --profile oai-ocgo-mix --activate --openai-quota --codex-quota --dry-run
ocdb setup --profile oai-ocgo-mix --activate --openai-quota --codex-quota --apply
```

If `--codex-quota` was selected and Codex is not signed in, the user runs
`ocdb quota login` (interactive). Running `ocdb setup` without flags in a
terminal prompts for the same options.

### 5. Restart the OpenCode service

Restarting interrupts open OpenCode sessions; confirm with the user first.

```sh
opencode service restart
opencode plugin list    # expect ocdb.hardware, plus openai-weekly with --openai-quota
```

Pressing Tab in the TUI should now show **VC-Orchestrator**. If the provider is
not yet connected, run `/connect` in OpenCode.

### Update, revert, uninstall

```sh
cd ~/.local/share/ocdb && git pull && npm ci
ocdb install --apply       # update installed assets for the current profile
ocdb deactivate --apply    # restore the OpenCode config to its pre-activation bytes
ocdb uninstall --apply     # remove OCDB assets and the quota link (deactivate first)
```

To change profile for the session, use the sidebar switcher. To change the
installed default, run `deactivate`, then `setup` with the new `--profile`.

## CLI reference

```text
ocdb <command> [options]
ocdb quota enable | disable | login [--device-auth]
```

All mutating commands default to `--dry-run` and write only with `--apply`.

| Command | Description | Options |
| --- | --- | --- |
| `setup` | Install assets, optionally activate and add the quota plugin | `--profile`, `--providers`, `--activate`, `--openai-quota`, `--codex-quota`, `--config-dir` |
| `install` | Install or update assets for a profile | same as `setup` |
| `activate` | Apply the config edits for the installed profile | `--profile`, `--config-dir` |
| `deactivate` | Revert the config edits | `--config-dir` |
| `uninstall` | Remove installed assets and the quota link | `--config-dir` |
| `status` | Show managed assets, profile, activation and quota state | `--config-dir` |
| `profiles` | Print the model routing of every profile | — |
| `doctor` | Check the Node.js and OpenCode versions | — |
| `plan` | List the assets that would be installed | — |
| `quota` | Enable, disable or sign in for the quota plugin | `--device-auth` (with `login`) |

- `--config-dir PATH` is the OpenCode config directory; it defaults to
  `$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode` if `XDG_CONFIG_HOME` is
  unset.
- `--providers ID,...` lists the providers you have (`openai`, `opencode-go`,
  `opencode`, `ocdb-deepseek`; also `go`, `zen`, `deepseek`). Without
  `--profile`, the first profile in the preference order
  (`oai-ocgo-mix`, `oai-hq`, `ocgo-hq`, `opencode-zen`, `deepseek`, `oai-lc`,
  `ocgo-lc`) that those providers can run is chosen.
- Profile IDs are case-insensitive. IDs from earlier releases still work:
  `openai` maps to `oai-hq`, and `opencode-go` to `ocgo-lc`.

## Agents and model routing

Agent definitions carry no model. The server part of the sidebar plugin assigns
each agent the model of its role in the selected profile, read from
[`profiles/models.json`](profiles/models.json) as rendered at install time.
`#<variant>` selects the reasoning-effort variant. A model you set for an agent
in `opencode.json` (`agents.<id>.model`) always takes precedence.

| Agent | Mode | Responsibility | Role |
| --- | --- | --- | --- |
| `VC-Orchestrator` | primary | Handles small tasks directly; delegates and verifies the rest | `lead` |
| `VC-Explorer` | subagent | Read-only codebase search; reports `path:line` locations; max. 15 steps | `explore` |
| `VC-Librarian` | subagent | Version-specific documentation research with source links; max. 20 steps | `explore` |
| `VC-Design` | subagent | Visual and motion design, modern CSS, WCAG 2.2 AA | `design` |
| `VC-Frontend` | subagent | HTML, CSS, JavaScript, Tailwind | `implementation` |
| `VC-Symfony` | subagent | PHP, Symfony and TYPO3 (extensions, site packages, upgrades) with tests | `implementation` |
| `VC-DDEV` | subagent | DDEV diagnosis and minimal environment fixes | `implementation` |
| `VC-Tester` | subagent | Discovers and runs project checks; never edits | `tester` |
| `VC-Reviewer` | subagent | Read-only review for correctness, security and regressions | `review` |
| `VC-Solver` | subagent | Read-only analysis of one approved problem, max. 10 steps | `solver` |
| `VC-Solver-Max` | subagent | VC-Solver at the highest effort, generated at install; used by `/vc-solve-max` | `solverMax` |
| `title`, `summary` | built-in | Session titles and summaries | `helper` |
| `compaction` | built-in | Summarises long sessions when the context fills | `compaction` |
| `plan` | built-in | Planning for `/vc-plan` | `lead` |

Role-to-model mapping per profile (`(Go)` marks OpenCode Go models in the mixed
profile; every other model comes from the profile's single provider):

| Role | `oai-hq` | `oai-lc` | `ocgo-hq` | `ocgo-lc` | `oai-ocgo-mix` | `opencode-zen` | `deepseek` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `lead` | `gpt-6.1-sol#high` | `gpt-6.1-terra#high` | `kimi-k3.1-pro#high` | `deepseek-v4.1-flash#high` | `gpt-6.1-sol#high` | `gpt-6.1-sol#high` | `deepseek-flash#high` |
| `implementation` | `gpt-6.1-terra#xhigh` | `gpt-6.1-terra#medium` | `minimax-m3.1-flash#xhigh` | `deepseek-v4.1-flash#high` | `gpt-6.1-terra#high` | `gpt-6-luna#high` | `deepseek-flash#high` |
| `design` | `gpt-6.1-sol#high` | `gpt-6.1-terra#high` | `gemini-4-argon#high` | `kimi-k2.7-code` | `gemini-4-argon#high` (Go) | `gpt-6-luna#medium` | `deepseek-flash#high` |
| `explore` | `gpt-6-luna#low` | `gpt-6-luna#low` | `gpt-6-luna#low` | `gpt-6-luna#low` | `gpt-6-luna#low` (Go) | `gpt-6-luna#low` | `deepseek-flash#high` |
| `tester` | `gpt-6-luna#medium` | `gpt-6-luna#low` | `minimax-m3.1-flash#low` | `deepseek-v4.1-flash#low` | `minimax-m3.1-flash#low` (Go) | `gpt-6-luna#medium` | `deepseek-flash#high` |
| `review` | `gpt-6.1-sol#high` | `gpt-6.1-terra#medium` | `kimi-k3.1-pro#high` | `deepseek-v4.1-flash#high` | `kimi-k3.1-pro#high` (Go) | `gpt-6.1-sol#high` | `deepseek-flash#high` |
| `helper` | `gpt-6-luna#low` | `gpt-6-luna#low` | `mimo-v2.6-flash` | `mimo-v2.6-flash` | `mimo-v2.6-flash` (Go) | `gpt-6-luna#low` | `deepseek-flash#high` |
| `compaction` | `gpt-6.1-terra#medium` | `gpt-6-luna#high` | `minimax-m3.1-flash#medium` | `deepseek-v4.1-flash#high` | `gpt-6.1-terra#medium` | `gpt-6.1-sol#medium` | `deepseek-flash#high` |
| `solver` | `gpt-6-astra#high` | `gpt-6.1-sol#xhigh` | `gemini-4-argon#high` | `qwen3.8-max#medium` | `gpt-6-astra#high` | `gpt-6-astra#high` | `deepseek-v4-pro#high` |
| `solverMax` | `gpt-6-astra#max` | `gpt-6-astra#high` | `kimi-k3.1-pro#max` | `qwen3.8-max#xhigh` | `gpt-6-astra#max` | `gpt-6-astra#max` | `deepseek-v4-pro#max` |

Profile choices:

- **OAI-OCGO-MIX** spreads load across both subscriptions: OpenAI for the
  lead, implementation, compaction and solver; Go for review (a second model
  family), design and the cheap search, test and helper work.
- **OCGO-HQ** uses Kimi K3.1 Pro, the strongest Go model on Terminal-Bench 4.0,
  for the lead and review; MiniMax M3.1 Flash for implementation; and Gemini 4
  Argon for design.
- **LC profiles** trade quality for quota: OAI-LC replaces Sol with Terra 6.1
  and Terra with Luna where it can; OCGO-LC runs on DeepSeek V4.1 Flash.
- Terra 6.1 is not yet offered on Zen, so `opencode-zen` keeps review on Sol.

`ocdb profiles` prints the catalog. Model availability and variants change
upstream; check `/models` in OpenCode.

### Switching profiles

Click the **Profile** line in the OCDB sidebar section, or run `/ocdb-profile`
(also in the command palette), and pick a profile. The switch applies to the
next model request of every OCDB agent, without a restart or file change:

- Profiles whose models are not all offered by your connected providers are
  shown but disabled, with the missing models listed. The installed profile can
  always be selected.
- The choice is stored by the plugin and survives restarts. Reinstalling with a
  different `--profile` resets it to the new installed profile.
- Requests already in flight finish on their current model.
- The default `model` in `opencode.json` (used by agents outside OCDB) stays at
  the installed profile's lead model.

### Delegation

- Subagents start with fresh context and cannot launch further subagents; the
  lead may launch only the VC agents, and VC-Solver only after approval.
- Independent Explorer and Librarian lookups are launched with
  `background: true` and run concurrently with the lead.
- Follow-ups on the same task continue the existing child session via its
  `sessionID` instead of re-briefing a new one.
- VC-Solver is never invoked autonomously: the lead must request approval, or
  the user runs `/vc-solve` or `/vc-solve-max`.

### Permissions

| Agent | Shell | Edit | Skills |
| --- | --- | --- | --- |
| `VC-Orchestrator` | ask; read-only inspection allowed¹ | yes | all |
| `VC-Design`, `VC-Frontend` | ask | yes | `vc-web-design`, `vc-tailwind` (+ non-OCDB skills) |
| `VC-Symfony` | ask | yes | `vc-symfony`, `vc-TYPO3`, `vc-TYPO3-upgrade`, `vc-ddev` (+ non-OCDB skills) |
| `VC-DDEV` | ask | yes | `vc-ddev` (+ non-OCDB skills) |
| `VC-Tester` | ask; inspection¹ and test runners² allowed | no | none |
| `VC-Reviewer` | no | no | all |
| `VC-Explorer`, `VC-Librarian`, `VC-Solver` | no | no | none |

¹ `git status/diff/log/show`, `git branch --show-current`, `ls`, `pwd`,
`composer show`, `npm ls`, `ddev describe`, `ddev composer show`.
² `phpunit` (`vendor/bin/` or `bin/`), `phpstan analyse`,
`php-cs-fixer fix --dry-run`, `composer test`, `npm test`, `npm run test`,
`npm run lint`, each also through `ddev` (`ddev exec`, `ddev composer`,
`ddev npm`). Test runners execute project code and may modify test databases.

Every agent asks before accessing paths outside the project.

## Skills and commands

| Skill | Scope |
| --- | --- |
| `vc-symfony` | Symfony application and bundle development |
| `vc-TYPO3` | Extensions, site packages, TCA, TypoScript, Fluid |
| `vc-TYPO3-upgrade` | Major-version upgrades: Rector, Fractor, changelog review, upgrade wizards, database compare |
| `vc-ddev` | DDEV environments |
| `vc-web-design` | Visual design and accessibility |
| `vc-tailwind` | Tailwind CSS |
| `vc-solving` | Structured analysis of hard problems |

| Command | Behaviour |
| --- | --- |
| `/vc-web <request>` | Route a request to VC-Orchestrator |
| `/vc-plan <request>` | Plan with OpenCode's read-only `plan` agent |
| `/vc-check <target>` | Run the project's checks with VC-Tester |
| `/vc-solve <problem>` | Run VC-Solver once with the `solver` model |
| `/vc-solve-max <problem>` | Run VC-Solver-Max once with the `solverMax` model |
| `/vc-t3u [version]` | Start a TYPO3 major upgrade; proposes the next major if no version is given |

TYPO3 upgrades proceed one major version at a time and require confirmation
before snapshots, version changes and data removal.

## Sidebar plugins

```text
OCDB
Profile  OAI-OCGO-MIX · switch
Agent  VC-Orchestrator · working
CPU  12%
RAM  8.3 GiB / 30.0 GiB
Subagents  2 running · 5 spawned
  ▸ VC-Explorer  Find route definitions
  ▸ VC-Tester  Run PHPUnit suite

OpenAI weekly
Used 7%                Left 93%
Resets Nov 2, 6:59 AM · 6d 23h
```

| Plugin | Source | Behaviour |
| --- | --- | --- |
| `ocdb.hardware` | `plugins/ocdb-hw/` (copied) | Server part: assigns agent models from the selected profile and serves the `ocdb-profiles` RPC for switching. TUI part: shows the profile (click to switch), reads the session tree every 1 s and samples CPU/RAM every 2 s. No network access of its own. |
| `openai-weekly` | `addons/openai-weekly/` (symlinked) | Polls the rolling seven-day ChatGPT/Codex usage window every 60 s through the Codex sign-in, which may be a different account from OpenCode's. Disabled until enabled with `ocdb quota enable`; the setting is stored in `~/.config/opencode-openai-weekly/settings.json`. Uses an undocumented Codex endpoint that may change without notice. |

## Configuration changes and state

All paths are relative to the OpenCode config directory (`~/.config/opencode`
by default).

| Operation | Writes | Reverted by |
| --- | --- | --- |
| `install` | 32 assets under `agents/`, `skills/`, `commands/` and `plugins/ocdb-hw/` (including the rendered profile catalog `catalog.json`); the ledger `.vc-ocdb/state.json` | `uninstall` |
| `--openai-quota` | Symlink `plugins/openai-weekly` → `addons/openai-weekly/`; runs `npm ci` there if needed | `uninstall` |
| `activate` | `opencode.json` or `opencode.jsonc`: `default_agent`, `model` (the installed lead model, for agents outside OCDB), and the `ocdb-deepseek` provider for the DeepSeek profile. Ledger: `.vc-ocdb/activation.json` | `deactivate` |

Guarantees:

- **Ownership:** `install` never overwrites files it did not create, and
  refuses to update managed files whose hash no longer matches the ledger,
  unless the file is byte for byte what the current release renders for it,
  so a stale ledger entry on an untouched file does not block updates.
- **Exact reversal:** `activate` backs up the config before editing it, and
  `deactivate` restores the original bytes. JSONC comments and unrelated keys
  are preserved while active.
- **Conflict detection:** `deactivate` refuses to overwrite a config that was
  modified after activation; a config that is still exactly what OCDB's
  activation writes counts as unmodified. Activation refuses when both `opencode.json` and
  `opencode.jsonc` exist, or when an existing provider definition conflicts.
- **Crash safety:** writes are atomic, operations take a lock, and the
  activation ledger is written before the config, so an interrupted activation
  can be recovered with `deactivate`.

Backups are stored in `.vc-ocdb/backups/`. They contain the original config
verbatim, including any credentials it held, and should be treated as
sensitive.

**DeepSeek profile:** registers the provider `ocdb-deepseek` against
`https://api.deepseek.com` and reads `DEEPSEEK_API_KEY` from the OpenCode
server's environment. End-to-end generation on this route has not been tested.

## Security model and limitations

- Agent permissions and prompts constrain behaviour but are not a sandbox.
  Approved shell commands and test runs can modify files and data.
- OCDB never handles provider credentials; sign-in is delegated to OpenCode and
  Codex.
- OCDB does not verify plan entitlements, install project dependencies or MCP
  servers, or fail over to another provider when a model errors.

## Development

```sh
npm ci && npm test                                  # unit tests, including the quota add-on (also run in CI)
npm run verify:opencode                             # end-to-end check against a real OpenCode
npm run verify:opencode -- --profile ocgo-hq
ocdb setup --profile oai-hq --activate --dry-run --config-dir /tmp/ocdb-preview/opencode
```

`verify:opencode` installs into a temporary config and starts a private
`opencode serve`, leaving the live service untouched. It verifies the model
of every agent, including the built-in `title`, `summary`, `compaction` and
`plan` agents, the default agent, skills, commands, plugins, a live switch to
another available profile and back, and, when the add-on's dependencies are
installed, the quota RPC. Run it after changing
assets or upgrading OpenCode.

Repository layout:

| Path | Contents |
| --- | --- |
| `bin/vc-ocdb.mjs` | CLI entry point |
| `lib/` | Installer, activation, profile rendering, quota add-on management |
| `profiles/web/` | Agent, skill and command sources |
| `profiles/models.json` | Provider profiles and role-to-model routing |
| `plugins/ocdb-hw/` | Sidebar plugin: profile routing and switching, activity, hardware |
| `addons/openai-weekly/` | Weekly-quota sidebar plugin (own `package.json` and tests) |
| `scripts/verify-opencode.mjs` | End-to-end verification against OpenCode |
| `test/` | Unit tests (`node:test`) |

References: [OpenCode V2 docs](https://opencode.ai/v2/docs/cli),
[Symfony](https://symfony.com/doc/current/index.html),
[TYPO3](https://docs.typo3.org/), [DDEV](https://docs.ddev.com/),
[DeepSeek API](https://api-docs.deepseek.com/).
