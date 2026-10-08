# claude_router

A Claude Code mod (`model-router`) that hard-routes work between models, makes Opus hand work off in a fixed document format, runs Haiku coders in parallel, has Sonnet review every change, and meters tokens per model.

| Role | Model | Enforced by |
|---|---|---|
| Main chat | Opus 5.5, high effort | every main-chat model request is rewritten to `claude-opus-5-5` / `high`; a system-prompt section teaches Opus the protocol |
| File edits | Haiku 5.5 | `Edit`/`Write`/`NotebookEdit` are denied outside `model-router:coder` subagents, which always run on `claude-haiku-5-5` in the foreground |
| Handoff | — | a coder prompt without the headings `## Goal`, `## Context`, `## Files`, `## Steps`, `## Done when` is refused with the template |
| Parallel work | Haiku 5.5 | coders spawned in one message run at once; a file one running coder edits is locked for the others |
| Review | Sonnet 5.5 | after each coder, `claude-sonnet-5-5` reviews the files that coder changed, given the user's request, Opus's notes, the handoff document and the coder's report; the review is appended to the coder's result |

## How it works

```mermaid
flowchart TD
    U([You]) -->|prompt| O["Opus 5.5 · high effort<br/>plans and talks, never edits"]
    O -->|Edit or Write| G{{"edit guard"}}
    G -->|denied: delegate| O
    O -->|"handoff document<br/>Goal · Context · Files · Steps · Done when"| H{{"handoff check"}}
    H -->|"missing headings: template sent back"| O
    H --> C1["Haiku 5.5 coder 1"]
    H --> C2["Haiku 5.5 coder 2"]
    H --> CN["Haiku 5.5 coder n"]
    C1 & C2 & CN -->|"edit own files, one coder per file"| F[("working tree")]
    C1 & C2 & CN -->|report| R["Sonnet 5.5 review"]
    F -->|"diff of that coder's files"| R
    O -.->|"user request, Opus notes, handoff"| R
    R -->|"review appended to the coder result"| O
    O -->|answer| U
    O & C1 & C2 & CN & R -.->|tokens| M[("meter: per model, per day")]
    M -.-> S["status line · /router-usage"]
```

## Requirements

- Claude Code 2.1.292 or newer (the function-hooks plugin API is early access).
- Access to `claude-opus-5-5`, `claude-haiku-5-5` and `claude-sonnet-5-5` on your account.
- `git` on your PATH (the reviewer diffs each coder's files).

## Install

`/plugin` is interactive and exists only in a terminal session: in the VS Code extension it answers `/plugin isn't available in this environment`. The `claude plugin` CLI does the same install from any shell, including VS Code's integrated terminal.

### From GitHub (any shell)

```
claude plugin install model-router --marketplace AndreaScotti01/claude_router --scope user
```

This adds the `claude-router` marketplace to your user settings and installs the plugin. In a terminal Claude Code session the interactive equivalent is `/plugin install model-router --marketplace AndreaScotti01/claude_router` (answer `y` to **Add marketplace?**, then pick the **user** scope).

### From a local clone (no push needed)

```
git clone https://github.com/AndreaScotti01/claude_router.git ~/PycharmProjects/claude_router
claude plugin marketplace add ~/PycharmProjects/claude_router
claude plugin install model-router@claude-router --scope user
```

The plugin is then read from the folder itself (`claude plugin list` shows `Read from: <folder>`): edit it and run `/reload-plugins`, no reinstall.

### Load it without installing (one session)

```
claude --plugin-dir ~/PycharmProjects/claude_router
```

Where no flag can be given (VS Code, SDK hosts), name the folder in `~/.claude/settings.json` and open a new session:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/claude_router" } }
```

### Then

Open a new session (in VS Code: a new Claude Code tab); sessions started before the install do not load it. Do not combine an install with `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS` on the same folder: the plugin would load twice (double metering, double reviews).

## Check it is active

| Check | Terminal | VS Code |
|---|---|---|
| Run `claude plugin list` | shows `model-router@claude-router`, `Status: ✔ enabled` | same (VS Code terminal) |
| Type `/router-usage` | table of tokens per model per day | same |
| Ask Claude to change any file | an agent row labelled `Haiku 5.5 · <task>`; after it, Opus quotes the Sonnet review | same |
| Toast `Sonnet 5.5 review: …` | after each coder | where the extension shows plugin toasts |
| Status line `router · today opus 33k · haiku 12k · sonnet 11k` | under the prompt | where the extension shows plugin status lines |
| **Model router** pane: `● model-router active`, model per role, today's tokens, running coders, last review | opens at session start (wide terminals) or with your first prompt | opens with your first prompt |
| Type `/router` | reopens the pane | same |

Usage history is stored in `~/.claude/plugins/store/model-router_*.json`.

## Update

- Installed from GitHub: `claude plugin update model-router@claude-router`, then open a new session.
- Installed from a local clone: `git pull` in the folder, then `/reload-plugins` in open sessions.

## Uninstall

```
claude plugin uninstall model-router@claude-router --scope user
claude plugin marketplace remove claude-router
```

## Configure

The models are constants at the top of `hooks/register.tsx`: `MAIN`, `CODER`, `REVIEWER`. Change them, then update the plugin.

## Known limits

- The main chat can still change files through Bash (`sed -i`, heredocs).
- Coder bookkeeping lives in memory: a hot reload while a coder runs denies that coder's edits; re-delegate.
- The plugin API is early access; a Claude Code update can break it.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
tsc -p .   # after the plugin has loaded once (the engine lays .claude-plugin/types/)
```
