# 開源素材說明（2D 狼人殺）

本專案使用 **CC0** 開源素材 + 自行生成的佔位圖。

## 已內建

| 來源 | 路徑 | 授權 | 用途 |
|------|------|------|------|
| **Kenney – UI pack: RPG extension** | `assets/kenney/ui_rpg/` | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) | 大廳 Theme 按鈕／面板 |
| **Kenney – Interface Sounds** | `assets/kenney/sounds/` + `assets/sfx/` | CC0 | 點擊、投票、夜/晝切換等 |
| **Kenney Shape Characters** | `assets/kenney/shape_characters/` + 合成 `assets/characters/shape/` | **CC0** | 2.5D 座位人物（你選的 A） |
| 舊像素人（備用） | `assets/characters/char_*.png` | 可自由替換 | 先前佔位 |
| 專案生成圖 | `assets/generated/` | 可自由使用 | 圓桌、背景、角色圖示 |

音效捷徑（`assets/sfx/`）：`click` `confirm` `error` `start` `vote` `night` `day` `phase` `death`

Kenney 原文授權：可用於個人與商業專案；署名（Kenney / kenney.nl）非必須但建議。

下載來源：  
https://opengameart.org/content/ui-pack-rpg-extension  
https://kenney.nl/assets

## 強烈建議再下載（同為 CC0）

| 素材包 | 連結 | 適合用途 |
|--------|------|----------|
| **Kenney UI Pack** | https://kenney.nl/assets/ui-pack | 大廳/按鈕/進度條 |
| **Kenney Board Game Icons** | https://kenney.nl/assets （搜尋 board / icons） | 角色、道具小圖 |
| **Kenney Fantasy UI Borders** | https://kenney.nl/assets | 邊框、卷軸風 UI |
| **Kenney Audio**（音樂/音效） | https://kenney.nl/assets/category:Audio | 夜/晝切換、投票、死亡 |
| **OpenGameArt – RPG UI** | https://opengameart.org | 更多面板風格 |

### 角色立繪 / 狼人主題

| 素材 | 連結 | 注意 |
|------|------|------|
| **LPC 系列**（Liberated Pixel Cup） | https://opengameart.org/content/lpc-collection | 多為 CC-BY-SA，**需署名 + 同源分享** |
| **Tiny Characters** 等 CC0 像素人 | OpenGameArt 搜尋 `CC0 character` | 確認授權頁面 |
| **itch.io – CC0 characters** | https://itch.io/game-assets/free/tag-cc0 | 下載前看授權標籤 |

> 狼人殺沒有「官方」免費立繪包；實務上多用 **通用像素人 + 角色色/徽章** 區分狼/神/民。

## 建議目錄結構（之後替換圖）

```
assets/
  kenney/ui_rpg/          # 已解壓 CC0 UI
  generated/              # 目前遊戲使用的圖（可被覆蓋）
    bg_night.png
    bg_day.png
    bg_lobby.png
    bg_hunt.png
    table.png
    seat_*.png
    role_*.png
  characters/             # （可選）之後放立繪
  sfx/                    # （可選）音效
```

替換時保持**檔名相同**，或改 `scripts/room.gd` / `seat_token.gd` 的 `preload` 路徑。

## Godot 匯入

1. 把 PNG 放進 `assets/`
2. 回到編輯器自動匯入
3. 在 Inspector 可調 Filter（像素風建議 **Nearest**）

## 本專案 2.5D 架構

- `scenes/game/table_world_3d.tscn` — 3D 地板／圓桌／燈光／斜俯視相機
- `scenes/game/seat_token_3d.tscn` — **Sprite3D 廣告牌** 像素人 + Label3D + Area3D 點選
- `scenes/room.tscn` — `SubViewport`（3D 世界）+ 2D HUD 疊層
- 舊版 2D：`table_world.tscn` / `seat_token.tscn` 仍保留可參考
- 協定/連線邏輯不變（仍連 Cloudflare Workers）

### 什麼是這裡的 2.5D？

| 部分 | 技術 |
|------|------|
| 場景 | 真 3D mesh（桌、地板）+ 燈光 |
| 人物 | 2D 像素貼圖貼在 **Sprite3D**，Y-billboard 面向相機 |
| 操作 | 斜 45° 俯視，像桌遊俯角 |
| UI | 仍是 2D Control 疊在最上層 |
