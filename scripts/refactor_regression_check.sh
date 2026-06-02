#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "${ROOT_DIR}/.." && pwd)"

echo "== Canopy frontend unit tests =="
cd "${ROOT_DIR}"
npm test -- --run

echo "== Canopy frontend production build =="
npm run build

echo "== Canopy Rust backend checks =="
cd "${ROOT_DIR}/src-tauri"
cargo check
cargo test

echo "== Canopy mobile TypeScript check =="
cd "${REPO_DIR}/canopy-mobile"
npx tsc --noEmit

if [[ "${RUN_E2E:-0}" == "1" ]]; then
  echo "== Optional Playwright E2E suite =="
  cd "${REPO_DIR}"
  npx playwright test --config playwright.config.ts
else
  echo "== Optional Playwright E2E suite skipped =="
  echo "Set RUN_E2E=1 to include browser journeys."
fi
