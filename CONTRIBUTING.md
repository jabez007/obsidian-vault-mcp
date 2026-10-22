# Contributing to Obsidian Vault MCP Extension

Thank you for your interest in contributing! We welcome pull requests, bug reports, and feature suggestions to make this the best AI companion for Obsidian users.

## Development Setup

1.  **Fork and Clone**
    ```bash
    git clone https://github.com/YOUR_USERNAME/obsidian-vault-mcp.git
    cd obsidian-vault-mcp
    ```

2.  **Install Dependencies**
    ```bash
    npm install
    ```

3.  **Build and Test**
    ```bash
    npm run build
    npm test
    npm run lint
    npm run type-check
    ```
    Commit the rebuilt `dist/index.js` with your source changes. Plugin hosts install from Git and run that file, and CI fails when it doesn't match the source.

4.  **Try the Plugin Locally**
    Run `claude --plugin-dir .` to start Claude Code with your checkout as a plugin. For another MCP host, point it at `node /absolute/path/to/obsidian-vault-mcp/dist/index.js`.

## Project Structure

- `src/index.ts`: Entry point. Starts the MCP server or runs one tool from the command line.
- `src/tools/`: The tool registry. Each tool is defined once in `registry.ts`, which drives both MCP and CLI dispatch.
- `src/note-policy.ts`: Decides which notes discovery, indexing, and writes include, including `.obsidian-mcpignore` rules.
- `src/rag/`: Retrieval Augmented Generation.
    - `store.ts`: LanceDB vector store management.
    - `embedder.ts`: Embeddings through `@huggingface/transformers`.
    - `snapshot.ts`: Index snapshot preparation.
- `skills/`: Skills for Claude Code and Codex.
- `commands/`, `agents/`: Slash commands and agents for Gemini CLI.
- `hooks/hooks.json`, `scripts/session-init.sh`: The session-start hook that reports vault status and refreshes the RAG index.

## Guidelines

- **Issue tracking**: Use [GitHub Issues](https://github.com/jabez007/obsidian-vault-mcp/issues) for bug reports, feature requests, and work status. Do not commit duplicate issue records or PR description drafts.
- **TypeScript**: Ensure your code is typed. Avoid `any` where possible.
- **Tools**: Add a new tool to `src/tools/registry.ts`. MCP and CLI dispatch pick it up from there.
- **Dependencies**: Keep dependencies minimal. This extension runs locally, so download size and startup time matter.

## Pull Requests

Use `main` as the only long-lived branch. Create a new branch for each change, including fixes and release preparation.

1. Update your local `main` and create a branch:

   ```bash
   git switch main
   git pull --ff-only origin main
   git switch -c feat/amazing-feature
   ```

2. Commit your changes and push the branch:

   ```bash
   git push -u origin feat/amazing-feature
   ```

3. Open a PR targeting `main`. Describe the problem, the change, and how you tested it.
4. Address CodeRabbit's review and wait for CI to pass.
5. Squash merge the PR. Delete the source branch if GitHub does not delete it automatically.
6. Confirm that the PR is merged and that the branch has no additional work. Update your local `main` and remove the merged local branch:

   ```bash
   git switch main
   git pull --ff-only origin main
   git fetch origin --prune
   git branch -D feat/amazing-feature
   ```

   Squash merges create a new commit, so Git's `-d` check can reject a branch whose changes are already in `main`.

Start the next change from the updated `main`. Do not reuse a squash-merged branch or maintain a separate `development` branch.

## Publish a release

1. Create a release preparation branch from `main`.
2. Run `npm version <version> --no-git-tag-version`. It updates `package.json` and `package-lock.json`, then runs `npm run sync-version` to copy the version into the host manifests.
3. Update `CHANGELOG.md` and `RELEASE_NOTES.md`.
4. Commit the version changes, then open a PR to `main` for CodeRabbit review and CI.
5. Merge the PR and update your local `main`:

   ```bash
   git switch main
   git pull --ff-only origin main
   ```

6. Confirm that the intended release commit has passed CI. Tag that commit on `main` using the version in its `package.json`. For example, for version `2.0.1` at the current tip:

   ```bash
   git tag -a v2.0.1 -m "Release v2.0.1" main
   git push origin v2.0.1
   ```

Pushing a `v*` tag starts the Release workflow and publishes the package to npm after validation. The workflow requires the tagged commit to belong to `main` and the tag version to match `package.json`. Keep published release tags unchanged.
