# OCDB — Open Code Đặc Biệt

"Đặc Biệt" is Vietnamese for "special". OCDB is a web-development setup for
**OpenCode V2**, covering PHP, Symfony, DDEV, HTML/CSS/JS and Tailwind. It
installs a lead agent with specialist subagents, skills, slash commands,
per-provider model profiles, and two sidebar plugins: agent activity with
CPU/RAM, and optionally your ChatGPT/Codex weekly quota. It replaces
oh-my-opencode-slim (OMO-Slim) but doesn't depend on it.

## Install

To have an agent install it, tell it:

```text
Install and configure OCDB: https://raw.githubusercontent.com/Pluxx/ocdb/main/README.md
```

> **Agents:** to install, follow these steps in order. Ask the user the
> questions in step 3 before running setup. Never ask for or handle API keys or
> passwords: provider sign-in happens in OpenCode (`/connect`), and Codex
> sign-in through `ocdb quota login`.

**1. Check the prerequisites.** You need Node.js 22.18 or newer, npm, git, and
OpenCode 2.x:

```sh
node --version && npm --version && git --version && opencode --version
```

**2. Clone to a permanent location and install.** The quota plugin is linked
from this checkout, so don't move or delete it afterwards:

```sh
git clone https://github.com/Pluxx/ocdb.git ~/.local/share/ocdb
cd ~/.local/share/ocdb
npm ci
mkdir -p ~/.local/bin && ln -sf ~/.local/share/ocdb/bin/vc-ocdb.mjs ~/.local/bin/ocdb
ocdb doctor
```

`~/.local/bin` is on the PATH by default on Ubuntu and most distros (you may
need to open a new shell). If it isn't, use `node bin/vc-ocdb.mjs` wherever this
README says `ocdb`. Avoid `npm link` with a system Node, because it needs sudo.

**3. Ask the user:**

- **Which provider do you have?** This sets the `--profile` value:
  - `openai`: ChatGPT/Codex subscription
  - `opencode-go`: OpenCode Go
  - `opencode-zen`: OpenCode Zen
  - `deepseek`: DeepSeek API key
- **Make OCDB the default agent?** (`--activate`; recommended)
- **Remove oh-my-opencode-slim if it's installed?** (`--disable-omo`; requires `--activate`)
- `openai` only: **Show the weekly ChatGPT quota in the sidebar?** (`--openai-quota`)
  - If yes: **Read it through your Codex sign-in?** (`--codex-quota`). Codex may
    renew its saved credentials when the quota is checked.

**4. Preview, then apply.** For example, for an OpenAI user who wants everything:

```sh
ocdb setup --profile openai --activate --disable-omo --openai-quota --codex-quota --dry-run
ocdb setup --profile openai --activate --disable-omo --openai-quota --codex-quota --apply
```

If the user chose `--codex-quota` and Codex isn't signed in yet, they run
`ocdb quota login` themselves, because it's interactive.

**5. Restart OpenCode's background service.** This interrupts open OpenCode
sessions, so confirm with the user first:

```sh
opencode service restart
opencode plugin list    # expect ocdb.hardware (and openai-weekly with --openai-quota)
```

In the TUI, Tab should now show **VC-Orchestrator**. Run `/connect` in OpenCode
to sign in to the provider if it isn't already connected.

Running `ocdb setup` with no flags in a terminal asks the same questions
interactively.

### Update, undo, remove

```sh
cd ~/.local/share/ocdb && git pull && npm ci
ocdb install --apply            # update the installed files for the current profile
ocdb deactivate --apply         # restore opencode.json / tui.json exactly as before
ocdb uninstall --apply          # remove OCDB's files and the quota link (deactivate first)
ocdb status
```

Every mutating command previews with `--dry-run` and only writes with `--apply`.
To switch profile, run `deactivate`, then `setup` with the new profile.

## What you get

| Agent | Role | OpenAI model | Go model |
| --- | --- | --- | --- |
| `VC-Orchestrator` | Lead (Tab/default): handles small tasks itself, delegates the rest | `gpt-6.1-sol#high` | `minimax-m3#thinking` |
| `VC-Explorer` | Cheap read-only code search returning `path:line` locations | `gpt-6-luna#low` | `gpt-6-luna#low` |
| `VC-Design` | Visual direction, layout, UX | `gpt-6-luna#medium` | `kimi-k2.7-code` |
| `VC-Frontend` | HTML, CSS, JS, Tailwind | `gpt-6-luna#high` | `deepseek-v4.1-flash#high` |
| `VC-Symfony` | PHP/Symfony backend and tests | `gpt-6-luna#high` | `deepseek-v4.1-flash#high` |
| `VC-DDEV` | DDEV diagnosis and fixes | `gpt-6-luna#high` | `deepseek-v4.1-flash#high` |
| `VC-Tester` | Runs checks, never edits | `gpt-6-luna#medium` | `deepseek-v4.1-flash#high` |
| `VC-Reviewer` | Read-only review | inherits the lead | inherits the lead |
| `VC-Solver` | Expensive read-only analysis, only with your approval | `gpt-6-astra#high` (`#max`) | `qwen3.8-max#medium` (`#xhigh`) |

Activation also points OpenCode's hidden `title` and `summary` agents at a cheap
model (`gpt-6-luna#low` / `mimo-v2.6-flash`), unless you've already set one.
The Zen and DeepSeek routes, and every model, are in
[`profiles/models.json`](profiles/models.json); `ocdb profiles` prints them.

**Skills:** `vc-symfony`, `vc-ddev`, `vc-web-design`, `vc-tailwind`,
`vc-solving`.

**Commands:**

| Command | What it does |
| --- | --- |
| `/vc-web <request>` | Hand a request to VC-Orchestrator |
| `/vc-plan <request>` | Plan with OpenCode's read-only `plan` agent |
| `/vc-check <target>` | Run the project's checks with VC-Tester |
| `/vc-solve <problem>` | One VC-Solver analysis at default effort |
| `/vc-solve-max <problem>` | One VC-Solver analysis at highest effort |

VC-Solver never runs on its own initiative: the lead must ask first, or you run
`/vc-solve`. It's read-only and limited to 10 steps.

### Sidebar

```
OCDB
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

- **OCDB section:** reads OpenCode's session tree every second and samples
  CPU/RAM every two seconds. It shows the local machine and makes no network
  calls.
- **OpenAI weekly:** polls the rolling seven-day ChatGPT/Codex window every 60
  seconds through your Codex sign-in. That sign-in can be a different account
  from the one OpenCode uses. It's off until you opt in:
  `ocdb quota enable | login [--device-auth] | disable`. The opt-in is stored in
  `~/.config/opencode-openai-weekly/settings.json`. The data comes from an
  unofficial Codex endpoint that may change.

## How it changes your config

- **Install** copies 24 files into `~/.config/opencode` (agents, skills,
  commands, `plugins/ocdb-hw/`) and records their hashes in
  `.vc-ocdb/state.json`. It never overwrites files it doesn't own, and refuses
  to update files you've edited. The quota add-on is a symlink to
  `addons/openai-weekly/`, which keeps its own `node_modules`.
- **Activate** edits `opencode.json`: it sets `default_agent`, the default
  `model` and the helper agents' models, and adds the custom provider for the
  DeepSeek profile. With `--disable-omo` it also removes the OMO-Slim plugin
  entries from `opencode.json` and `tui.json`. It backs up both files first.
  `deactivate` restores them byte for byte, and refuses if you've edited them
  since.
- Backups live in `~/.config/opencode/.vc-ocdb/backups/`. They can contain
  whatever was in your original config, credentials included, so keep them
  private.

**DeepSeek profile:** it registers provider `ocdb-deepseek` against
`https://api.deepseek.com` and reads `DEEPSEEK_API_KEY` from the OpenCode
server's environment. API usage is pay-as-you-go. End-to-end generation through
this route hasn't been tested.

## Limits

Permissions and prompts guide the agents, but they aren't a sandbox: approved
shell commands and tests can still change files and data. OCDB doesn't sign in
to providers, check what your plan includes, install project dependencies or
MCP servers, or fall back to another provider when a model fails. Model
catalogs and variants change; check `/models` in OpenCode.

## Development

```sh
npm ci && npm test      # OCDB tests plus the quota add-on's tests
ocdb setup --profile openai --activate --dry-run --config-dir /tmp/ocdb-preview/opencode
```

`--config-dir` is the exact OpenCode config directory to use. Agent, skill and
command sources are in `profiles/web/`; the installer writes each profile's
models into them at install time.

References: [OpenCode V2 docs](https://opencode.ai/v2/docs/cli),
[Symfony](https://symfony.com/doc/current/index.html),
[DDEV](https://docs.ddev.com/), [DeepSeek API](https://api-docs.deepseek.com/).
