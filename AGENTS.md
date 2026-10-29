<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Commit authorship

For commits created by the coding agent, use command-scoped identity overrides: `git -c user.name=codex-ai-agent -c user.email=codex-ai-agent@users.noreply.github.com commit ...`. Preserve the human user's repository and global Git identity settings so their own commits remain distinguishable. Use English commit messages. Existing commits retain their authorship unless the user requests rewriting them.

## Commit and push review

Before creating a commit or pushing changes, present the proposed English title and descriptive body, including changes and validation, for the user's review. Commit and push only after the user approves that text.
