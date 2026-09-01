SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c

.DEFAULT_GOAL := help

PI_USER_AGENT_DIR ?= $(HOME)/.pi/agent
PI_USER_EXT_DIR ?= $(PI_USER_AGENT_DIR)/extensions
PI_USER_SKILL_DIR ?= $(PI_USER_AGENT_DIR)/skills
AGENT_CONTEXT_SOURCE ?= agent-context/AGENTS.md
AGENT_CONTEXT_BACKUP_DIR ?= $(HOME)/.pi/backups/neutral-agent-context
MODE ?= copy

PLUGIN_NAMES := $(shell { find plugins -maxdepth 1 -type f -name '*.ts' ! -name '*.test.ts' ! -iname 'dreamer.ts' -printf '%f\n' | sed 's/\.ts$$//'; find plugins -mindepth 2 -maxdepth 2 -type f -name index.ts ! -ipath 'plugins/dreamer/*' -printf '%h\n' | sed 's#^plugins/##'; } 2>/dev/null | sort)
SKILL_NAMES := $(shell find skills -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort)

NEUTRAL_PARITY_POLICY ?= deploy/neutral-parity-allowlist.json
ROLE ?= narwhal
COMPONENT ?= capabilities
RELEASE_DIR ?=
TARGET_ROOT ?=
BACKUP_ROOT ?=
PLUGINS ?= $(PLUGIN_NAMES)
SKILLS ?= $(SKILL_NAMES)
PROJECT_DIR ?=
WAYANG_DIR ?= $(HOME)/src/wayang

.PHONY: help list-plugins list-skills install install-all check-identity-neutral user-install install-extensions install-skills install-hooks install-agent-context install-neutral-context install-dreamer-cron install-companion-policy check-companion-policy project-install make-project-install _install-extensions neutral-parity-plan neutral-parity-build neutral-parity-verify neutral-parity-install-plan neutral-parity-test

help:
	@printf '%s\n' \
	  'Pi extension deployment' \
	  '' \
	  'Targets:' \
	  '  make install' \
	  '      Install all plugins to the user-level pi extension directory.' \
	  '  make install-all' \
	  '      Install identity-neutral plugins, skills, hooks config, and dreamer timer; global context is excluded.' \
	  '  make install-neutral-context' \
	  '      Back up both context layers, install neutral AGENTS.md, and remove any identity append.' \
	  '  make check-identity-neutral' \
	  '      Verify installable context and install-all cannot activate a named identity.' \
	  '  make install-companion-policy' \
	  '      Back up and install reviewed Dream/Agent Teams policy, runner, cron, and skills.' \
	  '  make check-companion-policy' \
	  '      Run synthetic Dream/Agent Teams policy and runner regression tests.' \
	  '  make user-install [PLUGINS="todo hooks"] [MODE=copy|symlink]' \
	  '      Install selected plugins to $(PI_USER_EXT_DIR).' \
	  '  make project-install PROJECT_DIR=/path/to/project [PLUGINS="todo hooks"] [MODE=copy|symlink]' \
	  '      Install selected plugins to /path/to/project/.pi/extensions.' \
	  '  make make-project-install PROJECT_DIR=/path/to/project [PLUGINS="todo hooks"]' \
	  '      Alias for project-install.' \
	  '  make list-plugins' \
	  '      Show plugins discovered under plugins/ (excludes tests and Dreamer).' \
	  '  make neutral-parity-plan ROLE=narwhal|sceptre COMPONENT=capabilities|neutral-context' \
	  '      Print the explicit immutable-manifest plan and candidate classifications.' \
	  '  make neutral-parity-build ROLE=... COMPONENT=... RELEASE_DIR=/new/path' \
	  '      Build a deterministic staged payload, manifest, archive, and SHA-256 sidecars.' \
	  '  make neutral-parity-verify RELEASE_DIR=/path' \
	  '      Verify staged hashes, sizes, and modes.' \
	  '  make neutral-parity-install-plan RELEASE_DIR=/path TARGET_ROOT=/isolated/root' \
	  '      Dry-run only; this Makefile intentionally provides no live apply target.' \
	  '  make neutral-parity-test' \
	  '      Run installer tests using synthetic temporary roots only.' \
	  '' \
	  'Defaults:' \
	  '  PLUGINS="$(PLUGIN_NAMES)"' \
	  '  MODE=$(MODE)' \
	  '  PI_USER_EXT_DIR=$(PI_USER_EXT_DIR)'

list-plugins:
	@printf '%s\n' $(PLUGIN_NAMES)

list-skills:
	@printf '%s\n' $(SKILL_NAMES)

neutral-parity-plan:
	@node scripts/neutral-parity.mjs plan --policy '$(NEUTRAL_PARITY_POLICY)' --source . --role '$(ROLE)' --component '$(COMPONENT)'

neutral-parity-build:
	@if [[ -z '$(RELEASE_DIR)' ]]; then echo 'RELEASE_DIR is required and must be a new path outside the source worktree.' >&2; exit 2; fi
	@node scripts/neutral-parity.mjs build --policy '$(NEUTRAL_PARITY_POLICY)' --source . --role '$(ROLE)' --component '$(COMPONENT)' --output '$(RELEASE_DIR)'

neutral-parity-verify:
	@if [[ -z '$(RELEASE_DIR)' ]]; then echo 'RELEASE_DIR is required.' >&2; exit 2; fi
	@node scripts/neutral-parity.mjs verify --manifest '$(RELEASE_DIR)/manifest.json' --payload '$(RELEASE_DIR)/payload'

neutral-parity-install-plan:
	@if [[ -z '$(RELEASE_DIR)' ]]; then echo 'RELEASE_DIR is required.' >&2; exit 2; fi
	@if [[ -z '$(TARGET_ROOT)' ]]; then echo 'TARGET_ROOT is required and should be an isolated temporary root.' >&2; exit 2; fi
	@args=(install --manifest '$(RELEASE_DIR)/manifest.json' --payload '$(RELEASE_DIR)/payload' --target '$(TARGET_ROOT)'); \
	if [[ -n '$(BACKUP_ROOT)' ]]; then args+=(--backup-root '$(BACKUP_ROOT)'); fi; \
	node scripts/neutral-parity.mjs "$${args[@]}"

neutral-parity-test:
	@node --test tests/neutral-parity.test.mjs

install: user-install

install-all: check-identity-neutral user-install install-skills install-hooks install-dreamer-cron

check-identity-neutral:
	@bash scripts/test-identity-neutral-distribution.sh

user-install install-extensions:
	@$(MAKE) --no-print-directory _install-extensions DEST_DIR='$(PI_USER_EXT_DIR)' PLUGINS='$(PLUGINS)' MODE='$(MODE)'

install-skills:
	@mkdir -p '$(PI_USER_SKILL_DIR)'; \
	for skill in $$(printf '%s' '$(SKILLS)' | tr ',' ' '); do \
	  if [[ -d "skills/$$skill" ]]; then \
	    rm -rf '$(PI_USER_SKILL_DIR)'/"$$skill"; \
	    cp -a "skills/$$skill" '$(PI_USER_SKILL_DIR)'/"$$skill"; \
	    echo "installed skill $$skill -> $(PI_USER_SKILL_DIR)/$$skill"; \
	  else \
	    echo "Unknown skill '$$skill'. Run: make list-skills" >&2; \
	    exit 2; \
	  fi; \
	done; \
	if [[ -f plugins/agent-teams/SKILL.md ]]; then \
	  mkdir -p '$(PI_USER_SKILL_DIR)'/agent-teams; \
	  install -m 0644 plugins/agent-teams/SKILL.md '$(PI_USER_SKILL_DIR)'/agent-teams/SKILL.md; \
	  echo "installed skill agent-teams -> $(PI_USER_SKILL_DIR)/agent-teams"; \
	fi

install-hooks:
	@mkdir -p '$(PI_USER_AGENT_DIR)'; \
	install -m 0644 hooks.json.example '$(PI_USER_AGENT_DIR)'/hooks.json; \
	echo "installed hooks config -> $(PI_USER_AGENT_DIR)/hooks.json"

install-agent-context: install-neutral-context

install-neutral-context:
	@bash scripts/install-neutral-context.sh '$(AGENT_CONTEXT_SOURCE)' '$(PI_USER_AGENT_DIR)' '$(AGENT_CONTEXT_BACKUP_DIR)'

install-companion-policy:
	@PI_AGENT_DIR='$(PI_USER_AGENT_DIR)' bash scripts/install-companion-policy-runtime.sh

check-companion-policy:
	@node scripts/validate-extensions.js
	@node --test tests/agent-teams-companion-policy.test.ts tests/agent-teams-durable-reports.test.ts
	@node scripts/test-agent-teams-tool-ceiling.mjs
	@node scripts/test-dream-companion-policy.mjs
	@bash scripts/test-dreamer-cron.sh
	@node --test '$(WAYANG_DIR)/scripts/tests/dream-authorized-sessions.test.mjs'
	@node --test plugins/privileged-exec-protocol.test.ts

install-dreamer-cron:
	@mkdir -p '$(PI_USER_AGENT_DIR)' '$(HOME)/.pi/logs' '$(HOME)/.config/systemd/user'; \
	install -m 0755 scripts/dreamer-cron.sh '$(PI_USER_AGENT_DIR)'/dreamer-cron.sh; \
	install -m 0644 scripts/mypi-dreamer.service '$(HOME)/.config/systemd/user/mypi-dreamer.service'; \
	install -m 0644 scripts/mypi-dreamer.timer '$(HOME)/.config/systemd/user/mypi-dreamer.timer'; \
	if command -v crontab >/dev/null 2>&1; then \
	  ( crontab -l 2>/dev/null | grep -v 'dreamer-cron.sh' | grep -v 'Dream cycle' || true ) | crontab -; \
	fi; \
	systemctl --user daemon-reload; \
	systemctl --user enable --now mypi-dreamer.timer; \
	echo "installed dreamer systemd user timer"

project-install make-project-install:
	@if [[ -z '$(PROJECT_DIR)' ]]; then \
	  echo 'PROJECT_DIR is required.' >&2; \
	  echo 'Usage: make project-install PROJECT_DIR=/path/to/project PLUGINS="todo hooks"' >&2; \
	  exit 2; \
	fi
	@$(MAKE) --no-print-directory _install-extensions DEST_DIR='$(PROJECT_DIR)/.pi/extensions' PLUGINS='$(PLUGINS)' MODE='$(MODE)'

_install-extensions:
	@if [[ '$(MODE)' != 'copy' && '$(MODE)' != 'symlink' ]]; then \
	  echo 'MODE must be copy or symlink.' >&2; \
	  exit 2; \
	fi
	@dest='$(DEST_DIR)'; \
	mode='$(MODE)'; \
	plugins='$(PLUGINS)'; \
	mkdir -p "$$dest"; \
	if [[ -z "$$plugins" ]]; then \
	  echo 'No plugins selected.' >&2; \
	  exit 2; \
	fi; \
	for plugin in $$(printf '%s' "$$plugins" | tr ',' ' '); do \
	  src_file="plugins/$$plugin.ts"; \
	  src_dir="plugins/$$plugin"; \
	  if [[ -f "$$src_file" ]]; then \
	    rm -rf "$$dest/$$plugin"; \
	    if [[ "$$mode" == 'symlink' ]]; then \
	      src_abs="$$(cd "$$(dirname "$$src_file")" && pwd -P)/$$(basename "$$src_file")"; \
	      ln -sfn "$$src_abs" "$$dest/$$plugin.ts"; \
	    else \
	      install -m 0644 "$$src_file" "$$dest/$$plugin.ts"; \
	    fi; \
	    echo "installed $$plugin -> $$dest/$$plugin.ts ($$mode)"; \
	  elif [[ -f "$$src_dir/index.ts" ]]; then \
	    rm -f "$$dest/$$plugin.ts"; \
	    rm -rf "$$dest/$$plugin"; \
	    if [[ "$$mode" == 'symlink' ]]; then \
	      src_abs="$$(cd "$$(dirname "$$src_dir")" && pwd -P)/$$(basename "$$src_dir")"; \
	      ln -sfn "$$src_abs" "$$dest/$$plugin"; \
	    else \
	      cp -a "$$src_dir" "$$dest/$$plugin"; \
	    fi; \
	    echo "installed $$plugin -> $$dest/$$plugin/ ($$mode)"; \
	  else \
	    echo "Unknown plugin '$$plugin'. Run: make list-plugins" >&2; \
	    exit 2; \
	  fi; \
	done
