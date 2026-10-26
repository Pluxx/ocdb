---
description: Start a TYPO3 major upgrade session (vc-TYPO3-upgrade procedure, one major version per pass)
agent: VC-Orchestrator
subagent: false
---

Upgrade this TYPO3 project: $ARGUMENTS

Load `vc-TYPO3-upgrade` and follow it. If no target version is given, read the
installed version from `composer.lock`, propose the next major version, and
confirm with the user before starting.
