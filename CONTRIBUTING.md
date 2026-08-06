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

1.  Create a feature branch (`git checkout -b feature/amazing-feature`).
2.  Commit your changes.
3.  Push to the branch.
4.  Open a Pull Request.

Please describe your changes and the problem they solve.
