# 線上多人狼人殺

Cloudflare Workers 做邊緣路由、**每間房一個 Durable Object** 持有權威遊戲狀態、
WebSocket（Hibernation API）即時廣播。

| 路徑 | 角色 |
|------|------|
| `src/`、`test/`、`wrangler.jsonc` | 權威後端（規則、座位、勝負） |
| `public/`、`src/client/` | 網頁客戶端（除錯／沒裝 Godot 時用） |
| `godot/` | Godot 4.7 **2.5D 圓桌客戶端** |

GitHub：[leaf76/werewolf](https://github.com/leaf76/werewolf)（由 `werewolf-demo` + `werewolf-godot` 合併）。  
Worker 部署名稱仍是 `werewolf-demo`，線上 URL 不變。

## 線上玩

➡️ **https://werewolf-demo.leafxc0903.workers.dev**

建房 → 複製邀請連結給朋友（6–12 人）。人不夠可以用 bot 補位：
`node scripts/bots.mjs <房號> 4 wss://werewolf-demo.leafxc0903.workers.dev`

## 玩法規則

- 6–12 人；狼人數依人數（6–8 人 2 狼、9–11 人 3 狼、12 人 4 狼）
- 神職：**預言家**（每晚查驗一人陣營）、**女巫**（一瓶解藥一瓶毒藥，各用一次、
  一夜最多一瓶）；8 人以上加**獵人**（被狼刀或被放逐時可帶走一人；被毒不能開槍）
- 夜晚：狼人共同選獵殺目標（多數決、平票空刀；**狼隊看得到彼此刀向**，並有狼人夜聊頻道）
  → 女巫睜眼決定用藥 → 天亮公布死訊
- 白天：討論（聊天）→ 投票放逐 → **開票公開票型**；平票進入 **PK 決選**（候選人不投票，
  再平則流局）
- **每個階段都有倒數計時**：夜晚 45s、女巫 30s、白天 120s、決選 45s、獵人 30s，
  逾時自動結算（沒行動視同棄票／棄刀／收槍），掛機不會卡住遊戲
- 死亡玩家可留**一句遺言**；房主可在開局前選擇「死亡亮牌」
- 狼人全滅 → 好人勝；狼人數 ≥ 存活好人數 → 狼人勝
- 開局後加入的人自動成為**旁觀者**（只看得到公開狀態）；終局後房主可「**同房再來一局**」
- 房間閒置 24 小時（終局後 2 小時）自動回收

## Godot 客戶端

1. 安裝 [Godot 4.7](https://godotengine.org/download)
2. Project → Import → 選 **`godot/`** 裡的 `project.godot`（不要開 repo 根目錄）
3. 按 F5。大廳可連正式後端或本機 `http://localhost:8787`

逐步操作見 [`godot/STEPS.md`](godot/STEPS.md)，素材說明見 [`godot/assets/ASSETS.md`](godot/assets/ASSETS.md)。

Headless 煙霧（需本機有 Godot CLI）：

```sh
godot --path godot -s res://tools/auto_test_create.gd
```

## 本機執行（後端 + 網頁）

```sh
npm install
npm run dev        # 編譯前端 + wrangler dev，預設 http://localhost:8787
```

> 8787 被其他服務占用時：`npm run build && npx wrangler dev --port 8917`
> （bots 也要跟著指定：`node scripts/bots.mjs <房號> 4 ws://localhost:8917`）

## 兩分頁實測

1. 開 `http://localhost:8787` → **建立房間** → 進入 `/r/<房號>`，取名（這是房主）
2. 按 **複製邀請連結**，開第二個分頁貼上 → 取另一個名字
3. 人數不足 6 人時，用 bot 補位（bots 會刀人／驗人／投票，女巫 bot 囤藥、獵人 bot 會開槍）：

   ```sh
   node scripts/bots.mjs <房號> 4
   ```

4. 房主（可勾「死亡亮牌」）按 **開始遊戲**，依身分行動
5. 任一分頁重新整理 → 會自動回到原座位（playerId 存在 sessionStorage）

> 為什麼是 sessionStorage 而不是 localStorage？同一瀏覽器的多個分頁
> 才能扮演不同玩家（兩分頁對戰的前提），而重新整理仍會回到原座位。

## 測試

```sh
npm test           # Vitest + @cloudflare/vitest-pool-workers（真實 workerd 環境）
npm run check      # tsc 型別檢查（worker / client / test）
npm run e2e        # 協定層 E2E 煙霧測試（需要 dev server 在跑）
```

- `test/game.spec.ts`：純規則單元測試（發牌、女巫兩藥、獵人開槍、PK 決選、
  逾時結算、勝負判定、重開，TDD 先行）
- `test/room.spec.ts`：Worker + DO 的 WebSocket 整合測試（角色保密、狼刀向共享、
  旁觀者、限流、計時器、房間回收、完整一局到分出勝負）
- `scripts/e2e.mjs`：對真實伺服器打完整一局（救人、毒殺、開票、遺言、旁觀、重開）
- CI（GitHub Actions）：`check + test + build` 與 `wrangler dev + e2e` 兩條 job

## 部署

```sh
npm run deploy     # 需要先 wrangler login
```

## 安全設計（server 權威）

- 角色**只單獨送給本人**；狼人隊友與刀向只送狼人；查驗結果只送預言家；
  女巫的睜眼資訊只送女巫；廣播的 `room_state` 不含任何身分
  （「死亡亮牌」開啟時，僅已出局玩家的身分公開）
- **座位憑證**：`playerId` 是公開識別（出現在 `room_state`），但重連／回座位必須帶
  server 在入座時 unicast 的 `secret`（存在瀏覽器 `sessionStorage`）。
  只有公開的 `playerId` **不能**冒充他人；錯誤 secret 也不會踢掉合法連線。
  旁觀者使用 server 配發的 id，不能拿別人的 `playerId` 把在座玩家踢下線。
- 所有動作在 DO 內驗證：階段、身分、存活、目標合法性 —— **deny by default**，
  未授權動作一律回 `error`；旁觀者無法做任何遊戲動作
- 聊天有長度上限與**頻率限制**（token bucket，5 則 / 每 2 秒回填一則）
- 房號 6 碼、去混淆字母表、`crypto.getRandomValues` 產生，配 DO 原子 `claim` 防碰撞
- 沒有帳號、不收個資、無任何硬編碼 secret

## 已知取捨（demo 範圍）

- 這是**課程示範**，不是對抗惡意玩家的產品級對戰平台：建房 API 無全局限流、
  聊天限流是 per-socket（重開連線可重置）、沒有 CAPTCHA／登入。
  公開部署請自備 Cloudflare rate limit / WAF，或僅在課堂時段開服務。
- 勝負只算「屠城」（同數即勝），沒有屠邊規則
- 沒有警長、白痴、邱比特等進階配置；沒有排行榜與資料庫（依 prompt 列為非目標）
- 女巫首夜可自救、狼人可自刀（配合女巫解藥是合法戰術）；預言家不能驗自己

## License

MIT — see [LICENSE](./LICENSE).
