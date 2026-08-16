# 狼人殺 Godot — 逐步完成清單

跟著做；每完成一步再進下一步。

## 第 0 步：用 Godot 打開專案（現在）

1. 開啟 **Godot 4.7**
2. **Import** → 選 **本目錄**（含這份 `STEPS.md` 與 `project.godot`；不要開 repo 根目錄）  

```text
<repo>/godot
```

3. 選中 `project.godot` → Import & Edit
4. 按 **F5**（或右上角 ▶ Play）
5. 應看到大廳：**狼人殺 · Godot Client**

若編輯器下方 **Debugger** 出現紅色錯誤，把文字貼給協助者。

---

## 第 1 步：建房（連線正式後端）

大廳預設伺服器：

`https://werewolf.leafxc0903.workers.dev`

1. 暱稱填 `測試A`（1–12 字）
2. 按 **建立房間**
3. 成功 → 自動進房間場景，上方顯示 **房號 XXXXXX**、連線狀態 **已連線**
4. 玩家列表應有你自己一筆

失敗常見原因：
- 沒網路 / 防火牆擋 HTTPS
- 狀態列顯示 `HTTP 失敗` → 記錄錯誤訊息

---

## 第 2 步：第二位玩家加入

任選一種：

**A. 再開一個 Godot**  
Project → Run Multiple Instances → 2 → F5  
第二個視窗用不同暱稱 + 房號 → **加入房間**

**B. 用瀏覽器**  
開 `https://werewolf.leafxc0903.workers.dev` 建/入同一房  
（Godot 的「複製邀請」會複製瀏覽器連結）

兩邊玩家列表都應看到 2 人。

---

## 第 3 步：Bot 補人開局

在 **repo 根目錄**（有 `package.json` / `scripts/bots.mjs`）：

```sh
node scripts/bots.mjs <房號> 5 wss://werewolf.leafxc0903.workers.dev
```

房主（建立房間的人）勾選可選「死亡亮牌」→ **開始遊戲**  
應看到身分卡、進入夜晚。

---

## 第 4 步：打完整一局

依身分操作：
- 狼：點玩家刀人
- 預言家：點玩家查驗
- 女巫：救 / 毒 / 跳過
- 白天：點玩家投票
- 獵人：槍或收槍
- 聊天：下方輸入框

確認戰況 log、倒數、結束畫面、房主「同房再來一局」。

---

## 第 5 步起：美化與擴充（之後）

- 圓桌座位、日夜背景
- 角色立繪 / 音效
- Export 桌面或手機

---

## 本機後端（可選）

```sh
# repo root
npm run dev
```

大廳伺服器 URL 改成 `http://localhost:8787`
