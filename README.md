# pi-extensions

Private [pi](https://github.com/earendil-works/pi) extensions.

| Extension | What it does |
|---|---|
| `background-bash.ts` | Replaces `bash` with an always-background runner: commands finishing within 2s return inline, while longer commands move to the background automatically, write output to a temp log, and deliver a follow-up message on exit. Adds `bash_output` and `bash_kill` tools plus `/jobs`. |
| `subagent.ts` | Starts a background consultation with a stronger read-only model (`openrouter/openai/gpt-6-astra`, `--thinking max`). The tool returns a job id immediately and the answer arrives later as a follow-up message, so it never blocks the parent turn. Slash commands: `/subagent`, `/subagents`, `/subagent-kill`. |
| `tps.ts` | Tokens-per-second meter in the status line. |

## Install

Symlink the extensions into pi's user extension directory:

```sh
ln -sf ~/pi-extensions/background-bash.ts ~/.pi/agent/extensions/background-bash.ts
ln -sf ~/pi-extensions/subagent.ts ~/.pi/agent/extensions/subagent.ts
ln -sf ~/pi-extensions/tps.ts ~/.pi/agent/extensions/tps.ts
```

Then run `/reload` in pi.

## Notes

- `background-bash` and `subagent` jobs are in-memory and do not survive `/reload` or a session switch; `session_shutdown` kills them.
- The `subagent` child runs with `--tools read,grep,find,ls` and cannot modify files.
