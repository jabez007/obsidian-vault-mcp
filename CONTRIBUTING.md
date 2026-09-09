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

3.  **Build the Project**
    We use TypeScript. You can build once or watch for changes:
    ```bash
    npm run build
    # or
    npm run watch
    ```

4.  **Local Testing**
    To test your changes, you can install the extension locally in the Gemini CLI:
    ```bash
    gemini install .
    ```
    Then, use the CLI to trigger your modified tools:
    ```bash
    /obsidian:list_notes
    ```

## Project Structure

- `src/index.ts`: Entry point. Handles MCP server setup and CLI argument parsing.
- `src/rag/`: Logic for Retrieval Augmented Generation.
    - `store.ts`: LanceDB vector store management.
    - `embedder.ts`: Embeddings generation using `@xenova/transformers`.
- `commands/`: TOML configuration for Gemini CLI slash commands.
- `hooks/`: Configuration for automated hooks (e.g., re-indexing after note creation).

## Guidelines

- **TypeScript**: Ensure your code is typed. Avoid `any` where possible.
- **Tools**: If adding a new tool, define its schema in `src/index.ts` and add the implementation logic in the `CallToolRequestSchema` handler.
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
2. Update `package.json` and `package-lock.json` with `npm version <version> --no-git-tag-version`.
3. Run `npm run sync-assets` and update `CHANGELOG.md` and `RELEASE_NOTES.md`.
4. Commit the version changes and generated assets, then open a PR to `main` for CodeRabbit review and CI.
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
