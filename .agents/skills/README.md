# Project development skills

`.agents/skills` is the single source; `.claude/skills` contains optional compatibility links. These developer guides are separate from application resources in `resources/skills` and `resources/code-cli-skills`.

- `gh-pr-review`: current React/Tauri/Go review.
- `find-simplifications`: evidence-backed cleanup proposals.
- `docs-governance`: current documentation, decisions and requested translations.
- `gh-create-pr`: authorized PR publication.
- `vercel-react-best-practices`: selected React client references.

The list is in `public-skills.txt`. Synchronization is optional and never part of build/install:

```powershell
pnpm exec tsx scripts/skills-sync.ts
pnpm exec tsx scripts/skills-sync.ts --apply
pnpm exec tsx scripts/skills-check.ts
```

The first command only previews. Apply creates missing links and updates managed ignore lists; it refuses ordinary files/directories and unexpected links before any mutation. Link creation failure rolls back newly created links. Resolve conflicts by preserving local content yourself; do not run recursive removal or change global Git/Windows settings to force synchronization. Without link permission, use the canonical source directly or maintain an explicitly chosen local copy.

Root project rules are in `CLAUDE.md`. Claude reads that entry; Codex users need a local standard `AGENTS.md` that tells the agent to read it, or an explicitly configured fallback. Preserve any existing local rules. `AGENTS-og.md` is a historical alias, not a default-discovery guarantee. Verify discovery in the actual client after a fresh checkout.

The complete pre-cleanup skill/notes tree is recoverable at `3b84a66575dcb132f7c832957de67a2cffbd05fa`. Historical guides are outside the active skill index; application resources and feature migration decisions are preserved.
