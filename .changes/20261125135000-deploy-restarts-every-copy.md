---
bump: patch
section: Fixed
---
- `pm:restart` now also restarts any other pm2 process running from this checkout (by id, keeping its own environment), so a second copy started outside `ecosystem.config.cjs` no longer keeps serving the previous build after a deploy
