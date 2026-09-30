# Backseat — agent brief

You don't have to be Muse to drive Backseat. Backseat is an open
protocol — a private GitHub repo where tasks and results move as JSON
files — and any agentic AI with shell + git access can sit in the
architect seat: Muse, Grok, Dots, Clawdbot, a homegrown agent.

**Read `MUSE.md` for the full setup brief and `protocol.md` for the
exact task/status JSON schemas.** The brief is named for Muse because
that's who Backseat was designed and dogfooded with, but every step is
agent-agnostic:

1. Get the user's private copy of this template repo and clone it.
2. Get GitHub read/write access (`gh auth login` device flow — no tokens
   to create).
3. Queue work as JSON in `tasks/pending/`, watch `tasks/active/` +
   `tasks/status/` + `tasks/done/`, report results back in chat.

The VS Code extension on the user's PC only ever sees task files. It
cannot tell which agent wrote them, and it doesn't care.
