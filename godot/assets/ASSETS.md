# 開源素材說明（2.5D 狼人殺 client）

本專案使用 **CC0** 開源素材（Kenney）+ 自行生成的佔位圖。  
Repo 只追蹤 **runtime 用到的檔**；完整 Kenney 包請自行從官網下載，不要再整包 commit。

## Runtime 目錄

```
assets/
  ui/                      # Theme 用 Kenney UI 切片（CC0）
  sfx/                     # 遊戲音效 ogg（自 Kenney Interface Sounds 轉出）
  characters/roguelike/    # 2.5D 座位人物（CC0 Roguelike Characters 切片）
  generated/               # 圓桌貼圖、大廳背景、角色 HUD 圖示
```

| 路徑 | 授權 | 用途 |
|------|------|------|
| `assets/ui/` | Kenney UI pack RPG extension · [CC0](https://creativecommons.org/publicdomain/zero/1.0/) | Theme 按鈕／面板（7 張） |
| `assets/sfx/` | Kenney Interface Sounds · CC0 | click / vote / night / day 等 |
| `assets/characters/roguelike/` | Kenney Roguelike Characters · CC0 | Sprite3D 座位人物（池 12 + me/dead/wolf） |
| `assets/generated/` | 專案生成 | `table.png`、`bg_lobby.png`、`role_*.png` |

授權檔：`assets/ui/LICENSE_KENNEY_UI.txt`、`assets/characters/roguelike/LICENSE_KENNEY_ROGUELIKE.txt`  
Kenney 原文：可用於個人與商業；署名非必須但建議（Kenney / kenney.nl）。

下載來源：  
https://kenney.nl/assets · https://kenney.nl/assets/roguelike-characters · https://opengameart.org/content/ui-pack-rpg-extension

## 2.5D 架構（與素材對應）

| 部分 | 技術 / 素材 |
|------|-------------|
| 場景 | `table_world_3d`：3D mesh + 燈光；桌面貼 `generated/table.png` |
| 人物 | `seat_token_3d`：`characters/roguelike/*` → Sprite3D Y-billboard |
| HUD 角色圖 | `room.gd` preload `generated/role_*.png` |
| 大廳背景 | `main.tscn` → `generated/bg_lobby.png` |
| UI Theme | `themes/werewolf_theme.tres` → `assets/ui/*` |
| 音效 | `Sfx` autoload → `assets/sfx/*.ogg` |

日夜氣氛目前靠 **3D 燈光**，不依賴背景圖。

## 替換素材

1. 保持檔名與路徑，或同步改 `preload` / Theme  
2. 像素風在 Godot Import 建議 **Nearest** filter  
3. 若要擴充座位造型：只加 `characters/roguelike/`（16×16 切片後 nearest 放大），並更新 `seat_token_3d.gd` 的 `POOL`

## 刻意不進 repo 的東西

- 完整 Kenney zip / 未使用 PNG/WAV/Vector  
- 舊 2D 佔位圖（`char_*`、未用 seat/bg）  
- 雙份 sounds 原始解壓樹

需要完整素材包時到 kenney.nl 重抓即可。
