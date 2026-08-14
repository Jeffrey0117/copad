# copad：閱讀模式 + 貼圖上傳

2026-08-14 · Jeff 核准方向：urusai 圖床（推薦案）＋ 切換鈕與可分享閱讀連結（推薦案）。

## 1. 閱讀模式

- header 加「閱讀」鈕：進入 `body[data-mode="read"]`，隱藏編輯欄與手機分頁列，預覽變成置中單欄文章版面（max-width ~720px），鈕文字變「編輯」可切回。
- 網址同步：切進閱讀模式 `history.replaceState` 加 `?read`，切回移除。開頁時帶 `?read` 直接進閱讀模式 → 「分享連結」複製當下網址，自然就是閱讀版連結。
- 這是 UI 模式不是權限鎖（copad 權限模型維持「知道房號=可編輯」）。
- SSE 同步照常運作：閱讀模式下他人更新即時反映在預覽。

## 2. 貼圖上傳

- **儲存**：外部匿名圖床 urusai.cc（`POST https://api.urusai.cc/v1/upload`，field `file`，回 `data.url_direct`；2026-08-14 實測可用）。copad 零儲存負擔；代價是第三方倒站圖就沒了。
- **Server 代打**（瀏覽器直打會有 CORS）：新增 `POST /api/upload`，收 raw binary（Content-Type: image/*），上限 10MB，用 Node 原生 fetch+FormData 轉送 urusai，回 `{ ok, url }`。簡單 per-IP 節流（20 張/分鐘）防濫用。
- **Client**：textarea `paste` 事件抓 clipboard 圖片 → 游標處插入 `![上傳中…]()` 佔位 → 上傳成功後把佔位換成 `![圖片](url)` 並觸發存檔；失敗把佔位換回空字串並顯示錯誤 status。
- **Renderer**：inline() 加 `![alt](url)` → `<img>`（regex 在連結規則之前跑）。CSS：`.preview img { max-width:100%; border-radius; border }`。
- DEFAULT_CONTENT 加一行提示「貼上圖片會自動上傳」。

## 3. 全螢幕模式（追加，2026-08-14）

- header 加「全螢幕」鈕：Fullscreen API 切換整頁全螢幕，Esc 或再按一次退出；不支援的環境（手機 Safari）自動藏鈕。header 保留（含閱讀/主題鈕，Esc 可退）。

## 不做（YAGNI）

- 拖放上傳、多檔、進度條、本機備援儲存、閱讀模式權限鎖。

## 驗證

- 本機起 server：curl `POST /api/upload` 帶測試 PNG 回 urusai 網址。
- 瀏覽器手測：貼圖 → 預覽出圖 → 同步；`?read` 開頁直接閱讀版面。
- push 後 cloudpipe 自動部署，線上打 `/health` + 行為指紋確認。
