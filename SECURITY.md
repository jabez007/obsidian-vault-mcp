# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in obsidian-vault-mcp, please report it responsibly.

**Do not open a public issue.** Instead, use GitHub's [private vulnerability reporting](https://github.com/jabez007/obsidian-vault-mcp/security/advisories/new).

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

## Scope

obsidian-vault-mcp runs entirely locally — no data is sent to external services. The primary security considerations are:

- **File system access** — the extension reads and writes files in your Obsidian vault
- **Local embedding model** — runs via onnxruntime-node, no network calls
- **LanceDB storage** — vector index stored locally on disk

## Supported Versions

Only the latest release is actively supported with security updates.
