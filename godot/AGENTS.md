# AGENTS.md — godot/ (Werewolf client)

Godot **4.7** client inside the `werewolf` monorepo. Open **this folder** in the Godot editor (`project.godot`).

- Authority stays in repo-root Workers + Room DO (`src/`).
- This tree: 2.5D table + HUD + intents over WSS.
- Keep `protocol.gd` camelCase fields in sync with `../src/protocol.ts`.

Prefer `GameState.send_*` over ad-hoc `Net.send_message`. Private UI only from unicast handlers in `GameState.handle_server_message`.

Headless smoke from this directory:

```sh
godot --path . -s res://tools/auto_test_create.gd
```

Full agent notes: repo-root [`AGENTS.md`](../AGENTS.md).
