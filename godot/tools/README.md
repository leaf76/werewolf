# Tools

Helper scripts (not required to play).

| File | Purpose |
|------|---------|
| `auto_test_create.gd` | Headless: create room against live/demo API |
| `e2e_test.ps1` | Windows-oriented e2e helper |
| `click_create.ps1` | Windows UI automation helper |

## Headless create smoke

```sh
# From repo root; requires Godot on PATH
godot --path . -s res://tools/auto_test_create.gd
```
