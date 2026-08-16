# 狼人殺 · Godot 4 Client（2.5D）

本目錄是 monorepo [leaf76/werewolf](https://github.com/leaf76/werewolf) 的 **Godot 客戶端**。  
**規則 / 房間 / 身分保密**由 repo 根目錄的 Cloudflare Workers + Durable Object 處理；  
此處只做 2.5D 圓桌（3D 桌面 + 廣告牌像素人、日夜燈光、HUD + 送意圖）。

開源素材說明見 [`assets/ASSETS.md`](assets/ASSETS.md)。  
本機逐步操作見 [`STEPS.md`](STEPS.md)。

## 架構

```
Godot 4 (this folder)  --HTTP-->  POST /api/rooms, GET /api/rooms/:code
                       --WSS--->  /api/rooms/:code/ws  (JSON 與 src/protocol.ts 相同)
                                   ↓
                          Cloudflare Room DO（權威狀態）
```

| 模組 | 職責 |
|------|------|
| `scripts/autoload/protocol.gd` | 常數、中文錯誤/角色名 |
| `scripts/autoload/net.gd` | HTTP + `WebSocketPeer` |
| `scripts/autoload/game_state.gd` | 狀態鏡像、join/重連/secret、意圖 API |
| `scripts/autoload/sfx.gd` | 輕量音效 |
| `scenes/main.tscn` | 建房 / 入房 |
| `scenes/room.tscn` | 對局 HUD + `table_world_3d` |
| `scenes/game/table_world_3d.tscn` | 3D 圓桌、燈光、座位 |
| `scenes/game/seat_token_3d.tscn` | Sprite3D 廣告牌座位 |

## 需求

- Godot **4.7**（`project.godot` features；4.2+ 理論可開，以 4.7 為準）
- 可連到後端（預設正式 demo，或 repo 根目錄 `npm run dev`）

## 開啟專案

1. 安裝 [Godot 4.7](https://godotengine.org/download)
2. Project → Import → 選 **這個 `godot/` 資料夾** 的 `project.godot`
3. 按 F5 執行

## 本機對接後端

在 **repo 根目錄**（不是 `godot/`）：

```sh
npm install
npm run dev          # 預設 http://localhost:8787
```

Godot 大廳把 **伺服器 URL** 改成：

```text
http://localhost:8787
```

然後「建立房間」或輸入房號加入。  
可用瀏覽器 / bot 當其他玩家（仍在 repo 根目錄）：

```sh
node scripts/bots.mjs <房號> 5 ws://localhost:8787
```

## 與網頁 client 的對應

| `src/client/client.ts` | Godot |
|------------------------|--------|
| `sessionStorage` playerId/secret | `user://seat_<CODE>.cfg` |
| `WebSocket` | `Net` + `WebSocketPeer` |
| `handle(msg)` | `GameState.handle_server_message` |
| `send({ type })` | `GameState.send_*` / `Net.send_message` |
| DOM render | `room.gd` `_render*` + 3D seats |

Client → Server 訊息（勿改欄位名，後端吃 camelCase）：

- `join` `{ playerId, name, secret? }`
- `start_game` `{ revealOnDeath? }`
- `night_action` `{ action: kill|inspect|poison|save|skip, targetId? }`
- `vote` `{ targetId }`
- `hunt` `{ targetId: string|null }`
- `restart` / `chat`

## 刻意不做的事

- 不在 client 發牌、算票、判勝負
- 不信任本地「我是狼所以…」——只顯示 unicast（`role_assigned` / `seer_result` / `witch_wake` / `wolf_pick`）

## 工具腳本

見 [`tools/`](tools/)（headless create smoke、Windows e2e 輔助）。從 **此資料夾** 執行：

```sh
godot --path . -s res://tools/auto_test_create.gd
```

或從 repo 根目錄：`godot --path godot -s res://tools/auto_test_create.gd`

## License

與根目錄相同（MIT）。Kenney CC0 素材見 `assets/ASSETS.md`。
