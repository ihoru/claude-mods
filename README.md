# claude-mods

Small mods for Claude Code and the Claude desktop app.

## open-in-pycharm

Adds a `/pycharm` slash command that opens the session's project (or a path you give it) in PyCharm. Works on Linux, macOS and Windows, with or without JetBrains Toolbox.

- `/pycharm` opens the session's folder, `/pycharm <folder>` opens that folder.
- `/pycharm <file>[:line[:column]]` opens the file in the session's project, at the line if given (relative paths resolve against the session folder).
- It finds PyCharm on PATH and in the usual install locations. If it cannot, Claude searches the machine for it, asks you for the launcher's path if that fails, and saves the path for next time.
- `/pycharm --reset` forgets a saved path.

### Install

At the prompt of a terminal session:

```
/plugin install open-in-pycharm --marketplace ihoru/claude-mods
```

From a shell:

```
claude plugin install open-in-pycharm --marketplace ihoru/claude-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `ihoru/claude-mods`, then Add plugin.
