# Skills

Install a skill repository once and every provider on the environment can use
it. You don't need to install it separately for Claude, Codex, Cursor, Grok,
OpenCode, Pi, and Antigravity.

## Add a repository

Open **Settings → Skills**, choose **Add from GitHub**, and enter a public
repository, such as `mattpocock/skills` or `https://github.com/pbakaus/impeccable`.
T3 Code downloads it to the environment and turns on every skill it finds.

Expand a repository to turn individual skills on or off. The repository switch
turns all of its skills on or off together. Use **Update** in its menu to pull
the latest version. Skills added upstream since then start off.

Skills belong to the environment, so pick the environment in the settings
header first. A remote environment installs them on that machine.

## Where skills go

T3 Code links each skill into the folders providers already read:

- `~/.agents/skills` for Codex, Cursor, Grok, OpenCode, and Pi
- each Claude account's `skills` folder, usually `~/.claude/skills`
- `~/.gemini/config/skills` for Antigravity

Because they are ordinary skill folders, the same skills also work when you run
those tools outside T3 Code. T3 Code never replaces a skill you installed
yourself. If one already uses the same name, the repository's skill shows
**Not linked** instead. Removing a repository removes only the links T3 Code
made.

Running agents pick up changes after **Restart agent session** in the command
palette.
