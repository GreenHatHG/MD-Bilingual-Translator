#!/bin/sh
# Translation mode: no global extensions/packages, no shell tools, custom system
# prompt (AGENTS.md is embedded in it instead). See .pi/extensions/translate.ts
# and .pi/extensions/translate-prompt.ts.
# Usage: ./translate.sh [pi args...]   (e.g. ./translate.sh -p "translate @x.md")
PI_TRANSLATE_MODE=1 exec pi \
  --no-extensions \
  --no-context-files \
  --tools "read,grep,split,terms_set,doubao,arbitrate_next,arbitrate_submit,collect,verify" \
  -e .pi/extensions/translate.ts \
  -e .pi/extensions/translate-prompt.ts \
  "$@"
