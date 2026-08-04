# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in obsidian-vault-mcp, please report it responsibly.

**Do not open a public issue.** Instead, use GitHub's [private vulnerability reporting](https://github.com/jabez007/obsidian-vault-mcp/security/advisories/new).

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

## Scope

Vault content and embeddings are processed locally and are not intentionally sent to external services. The primary security considerations are:

- **File system access** — the extension reads and writes files in your Obsidian vault
- **Local embedding model** — inference runs locally via `@huggingface/transformers`; the first model load may download model files from Hugging Face unless they are already cached
- **LanceDB storage** — vector index stored locally on disk

## Dependency Advisories

As of version 2.0.0, `npm audit` reports four high-severity findings in transitive `adm-zip` and `sharp` dependencies included by `@huggingface/transformers`. `adm-zip` has no fixed release. The `sharp` vulnerabilities are fixed in 0.35.0, but Transformers 4.2.0 declares `sharp` as `^0.34.5` and therefore still resolves version 0.34.5.

The server embeds Markdown text and does not expose ZIP extraction or image-processing tools. `adm-zip` is used by the ONNX runtime installation path, while the vulnerable `sharp` functionality is not used by the text embedding pipeline. This limits the current runtime exposure, but the dependencies will be updated when compatible fixes become available.

## Supported Versions

Only the latest release is actively supported with security updates.
