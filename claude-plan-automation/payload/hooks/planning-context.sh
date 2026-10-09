#!/usr/bin/env bash
# SessionStart (compact): after compaction, point Claude at the planning files.
# Silent unless a feature is still in the interview or review phase.
f=$(ls -t "$CLAUDE_PROJECT_DIR"/docs/plans/*/_planning/STATE.md 2>/dev/null | head -1)
[ -n "$f" ] || exit 0
grep -Eq 'phase:[[:space:]]*(interview|review)' "$f" || exit 0
d=$(dirname "$f")
echo "A feature is being planned. Before you continue, re-read $d/STATE.md and $d/requirements.md."
echo "Those files, not the chat, are the record of every decision."
