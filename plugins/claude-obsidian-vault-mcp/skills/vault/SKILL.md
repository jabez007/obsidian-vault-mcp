---
name: vault
description: >-
  Use when the user wants to set or change their Obsidian vault path, or says
  "vault", "set vault", or "change vault".
---

# Set Vault Path

Configure the Obsidian vault path for this session.

## With Argument

If the user provides a path after `/vault`:
- Call `obsidian_set_vault` with the provided path

## Without Argument

If no path is provided:
- Ask the user: "What is the absolute path to your Obsidian vault?"
- Once they respond, call `obsidian_set_vault` with their path

## Confirmation

After setting, confirm: "Vault path set to: [path]"

## Tips

- You can also set a custom `workspace_path` (for metadata storage) or a `vault_id` (for sharing metadata across machines) using the `obsidian_set_vault` tool.
- The `obsidian_set_vault` tool does not validate the vault path upfront; if the path is invalid, later commands may fail and the agent may then prompt for a correction.
