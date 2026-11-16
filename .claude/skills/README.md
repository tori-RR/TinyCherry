# Claude Skills Mirror

This directory is a synced mirror for Claude-compatible skill files.

- Do not create new skills directly under `.claude/skills`.
- Create and maintain skills under `.agents/skills` only.
- Update `.agents/skills/public-skills.txt`, then run `pnpm exec tsx scripts/skills-sync.ts`.
- `pnpm exec tsx scripts/skills-check.ts` verifies `.claude/skills/<skill>` is a valid symlink to `.agents/skills/<skill>`.
