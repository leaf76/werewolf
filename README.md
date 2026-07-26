# 狼人殺 · Godot 4 Client（2D）

對接 [leaf76/werewolf-demo](https://github.com/leaf76/werewolf-demo) 的 **既有 WebSocket 協定**。  
**規則 / 房間 / 身分保密仍由 Cloudflare Workers + Durable Object 權威處理**；  
Godot 做 **2.5D 圓桌客戶端**（3D 桌面 + 廣告牌像素人、日夜燈光、HUD + 送意圖）。

開源素材說明見 [`assets/ASSETS.md`](assets/ASSETS.md)。

## 架構

```
Godot 4 (本專案)  --HTTP-->  POST /api/rooms, GET /api/rooms/:code
                  --WSS--->  /api/rooms/:code/ws  (JSON 與 protocol.ts 相同)
                              ↓
                     Cloudflare Room DO（權威狀態）
```

| 模組 | 職責 |
|------|------|
| `scripts/protocol.gd` | 常數、中文錯誤/角色名 |
| `scripts/autoload/net.gd` | HTTP + `WebSocketPeer` |
| `scripts/autoload/game_state.gd` | 狀態鏡像、join/重連/secret、意圖 API |
| `scenes/main.tscn` | 建房 / 入房 |
| `scenes/room.tscn` | 對局 UI |

## 需求

- Godot **4.2+**（建議 4.3 / 4.4）
- 可連到後端（預設正式 demo，或本機 `wrangler dev`）

## 開啟專案

1. 安裝 [Godot 4](https://godotengine.org/download)
2. Project → Import → 選本目錄的 `project.godot`
3. 按 F5 執行

## 本機對接 werewolf-demo 後端

```sh
# 在 werewolf-demo repo
npm install
npm run dev          # 預設 http://localhost:8787
```

Godot 大廳把 **伺服器 URL** 改成：

```text
http://localhost:8787
```

然後「建立房間」或輸入房號加入。  
可用瀏覽器 / bot 當其他玩家：

```sh
node scripts/bots.mjs <房號> 5 ws://localhost:8787
```

## 與原 TS client 的對應

| 原 client.ts | Godot |
|--------------|--------|
| `sessionStorage` playerId/secret | `user://seat_<CODE>.cfg` |
| `WebSocket` | `Net` + `WebSocketPeer` |
| `handle(msg)` | `GameState.handle_server_message` |
| `send({ type })` | `GameState.send_*` / `Net.send_message` |
| DOM render | `room.gd` `_render*` |

Client → Server 訊息（勿改欄位名，後端吃 camelCase）：

- `join` `{ playerId, name, secret? }`
- `start_game` `{ revealOnDeath? }`
- `night_action` `{ action: kill|inspect|poison|save|skip, targetId? }`
- `vote` `{ targetId }`
- `hunt` `{ targetId: string|null }`
- `restart` / `chat`

## 建議開發順序

1. **現在**：用桌面 export 連正式 / 本機後端，打通完整一局  
2. **UI**：座位改成圓桌場景、夜/晝主題、角色立繪  
3. **多平台**：Windows / Android；Web 匯出需注意 CORS 與包體  
4. **（可選）後端 Godot 化**：只有當你不要 Cloudflare 時才做；工作量 ≈ 重寫 DO

## 刻意不做的事

- 不在 client 發牌、算票、判勝負  
- 不信任本地「我是狼所以…」——只顯示 unicast（`role_assigned` / `seer_result` / `witch_wake` / `wolf_pick`）

## License

與 demo 相同可自訂；骨架供你繼續開發。
