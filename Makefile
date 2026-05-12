SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c

.DEFAULT_GOAL := help

PI_USER_EXT_DIR ?= $(HOME)/.pi/agent/extensions
MODE ?= copy

PLUGIN_NAMES := $(shell { find plugins -maxdepth 1 -type f -name '*.ts' -printf '%f\n' | sed 's/\.ts$$//'; find plugins -mindepth 2 -maxdepth 2 -type f -name index.ts -printf '%h\n' | sed 's#^plugins/##'; } 2>/dev/null | sort)
PLUGINS ?= $(PLUGIN_NAMES)
PROJECT_DIR ?=

.PHONY: help list-plugins install user-install install-extensions project-install make-project-install _install-extensions

help:
	@printf '%s\n' \
	  'Pi extension deployment' \
	  '' \
	  'Targets:' \
	  '  make install' \
	  '      Install all plugins to the user-level pi extension directory.' \
	  '  make user-install [PLUGINS="todo hooks"] [MODE=copy|symlink]' \
	  '      Install selected plugins to $(PI_USER_EXT_DIR).' \
	  '  make project-install PROJECT_DIR=/path/to/project [PLUGINS="todo hooks"] [MODE=copy|symlink]' \
	  '      Install selected plugins to /path/to/project/.pi/extensions.' \
	  '  make make-project-install PROJECT_DIR=/path/to/project [PLUGINS="todo hooks"]' \
	  '      Alias for project-install.' \
	  '  make list-plugins' \
	  '      Show plugins discovered under plugins/.' \
	  '' \
	  'Defaults:' \
	  '  PLUGINS="$(PLUGIN_NAMES)"' \
	  '  MODE=$(MODE)' \
	  '  PI_USER_EXT_DIR=$(PI_USER_EXT_DIR)'

list-plugins:
	@printf '%s\n' $(PLUGIN_NAMES)

install: user-install

user-install install-extensions:
	@$(MAKE) --no-print-directory _install-extensions DEST_DIR='$(PI_USER_EXT_DIR)' PLUGINS='$(PLUGINS)' MODE='$(MODE)'

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
