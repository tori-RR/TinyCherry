# Claude compatibility links

Canonical guides and the active list live in [`.agents/skills`](../../.agents/skills/README.md). These are developer helpers, separate from bundled application skills. Synchronization is optional: preview `pnpm exec tsx scripts/skills-sync.ts`, explicitly add `--apply` to create missing links/update ignore lists, then run `pnpm exec tsx scripts/skills-check.ts`.

Ordinary files/directories and unexpected links are preserved as conflicts. Link failure rolls back newly created links. Do not change global policies or use recursive deletion to repair a conflict. Private settings and unlisted skills remain local.
