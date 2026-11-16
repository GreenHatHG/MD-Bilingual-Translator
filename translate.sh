#!/bin/sh
# Translation mode: no global extensions/packages, no shell tools — only the
# repo's workflow tools plus read/grep. See .pi/extensions/translate.ts.
# Usage: ./translate.sh [pi args...]   (e.g. ./translate.sh -p "translate @x.md")
PI_TRANSLATE_MODE=1 exec pi \
  --no-extensions \
  --tools "read,grep,split,terms_set,doubao,arbitrate_next,arbitrate_submit,collect,verify" \
  -e .pi/extensions/translate.ts \
  "$@"
