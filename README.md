## Quick start

```shell
pi install npm:@ilya-lesikov/pi-pi
```

Recommended extensions:
```shell
pi install npm:pi-tool-display
pi install npm:pi-mcp-adapter
```

Open `pi`, check health:
```
/pp > Settings > Info > Doctor
```

Implement something:
```
/pp > Task > Implement > New
```

There is only one `/pp` command, nothing else. It will let you start tasks, progress through them and pick the next action, display useful info and configure pi-pi.

## ACP clients (Zed)

pi-pi works in ACP clients through the [pi-acp fork](https://github.com/ilya-lesikov/pi-acp), which spawns `pi --mode rpc` with `PI_ACP=1`. There, every pi-pi interaction (`/pp`, the `pp_phase_complete` gate, `ask_user`) degrades from the rich terminal dialogue to the client's own select/confirm/input dialogs; the terminal experience is unchanged.

The footer pi-pi draws in the terminal cannot render in an ACP client, so instead pi-pi publishes the same task state — phase, mode, run status, and the live subagent fleet — as a `pp:state` session entry that the adapter turns into a client-side task list. The entry never enters the model's context, and nothing is published outside `PI_ACP=1`.

## Flant

`/pp > Settings > Flant` enables Flant AI Infrastructure integration.
