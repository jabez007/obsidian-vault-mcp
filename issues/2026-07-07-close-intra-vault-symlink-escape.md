## Summary
Vault boundary does not survive symlinks inside the vault

## Context
The confused-deputy hardening (commit `06d2cc9`) realpath-resolves the *vault path itself* (`resolveRealPathAllowMissing` in `src/index.ts`), but `getSafeFilePath` (`src/utils.ts`) validates containment lexically via `path.resolve`, which does not follow symlinks. A symlink inside the vault pointing at, e.g., `~/.ssh` passes the containment check, and all read/write tools will follow it. The indexer additionally globs with `follow: true`, so a symlinked directory pulls external files into the embedding index. Given the stated threat model — a confused LLM as the deputy — this is the remaining hole in the fence.

## Proposed Changes
1. **Harden `getSafeFilePath`**: Realpath-resolve the deepest existing ancestor of the target (mirroring `resolveRealPathAllowMissing` in `src/index.ts`) and re-verify containment against the realpath'd vault root.
2. **Decide and document the glob policy**: Either drop `follow: true` from the indexer/list/search globs, or verify each followed file's realpath stays inside an allowed root before reading it.
3. **Tests**: Add cases with an in-vault symlink pointing outside the vault for `obsidian_read_note`, `obsidian_create_note`, and `indexVault` — all must refuse or skip the escaped path.
4. **Escape hatch**: Users who intentionally symlink vault folders should be supported via `OBSIDIAN_ALLOWED_VAULTS` — a followed path landing inside any allowed root is permitted.

## Expected Behavior
- No tool can read or write outside the allowed vault roots, even through symlinks created inside the vault.
- The indexer never embeds content from outside the allowed roots.
- Intentional symlink setups keep working when the target root is listed in `OBSIDIAN_ALLOWED_VAULTS`.

## Impact
**High (security)** — Behavior change for users relying on unlisted symlinked folders; document the migration path (`OBSIDIAN_ALLOWED_VAULTS`) in the README and CHANGELOG.

## Additional Context
Follows up on commit `06d2cc9` ("Enforce a vault boundary against confused-deputy misuse"). The lexical check in `src/utils.ts:8` predates that work and was not updated with it.
