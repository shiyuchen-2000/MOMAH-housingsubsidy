#!/usr/bin/env bash
# One-step local deploy: rebuild standalone.html, commit, and push.
# GitHub Actions then auto-deploys to Pages. Usage:  ./deploy.sh "your message"
set -e
cd "$(dirname "$0")"

echo "→ Building standalone.html ..."
node scripts/build-standalone.mjs

git add -A
if git diff --cached --quiet; then
  echo "Nothing to commit — working tree clean."
  exit 0
fi
git commit -m "${1:-update demo}"
echo "→ Pushing to GitHub ..."
git push
echo "✓ Pushed. GitHub Actions will publish to Pages in ~1 minute."
