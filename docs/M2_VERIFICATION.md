# M2-T1 第一天驗證報告（P1、P2a、P6、P7、P8、P9、第一批錄製）

- 日期：2026-11-18（UTC 05:44–05:58 前段；Orca 重啟 06:04:21Z；P2a 驗證與清理 06:04–06:10）
- 執行者：M2-T1 worker（claude，Orca task `task_cf8e032daff7`；P2a 續做 `task_ec86f64a7779`）
- 環境：Orca **1.4.259**（runtime `c3b09d0f…`，app pid 82375）、Claude Code（claude-opus-5-5）、Codex（gpt-6-astra）、git（spike repo）、macOS
- 測試 repo：`ClarkeYeh/ai-office-spike`（Orca repo id `9403ea2c-…`）。只用 `aio-test-*` worktree、`ai-office-test/*` 分支；main 未動。
- CLI 執行方式：`horca` 包裝 = `cd <scratch>/cli-cwd && env -i HOME PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/Applications/Orca.app/Contents/Resources/bin orca …`；所有變更類命令帶 `--from <shim>` 與自產 `--retry-request <uuid>`。
- 原始錄製、spec、stub、狀態檔：`~/.ai-office/test-state/m2-t1/`（0700／0600，repo 外）。sanitized fixtures：分支 `ClarkeYeh/m2-t1-verify` 的 `fixtures/orca/1.4.259/*.json`（52 份，含 9 份重啟後的錄製）。

## 總結表

| 項目 | 結果 | 一句話 |
|---|---|---|
| **P1** shim 建在 folder workspace | ✅ 通過 | `repo add --kind folder ~/.ai-office/orca-home`（只做一次）→ shim terminal → run-create → worker-start → consuming check 收到 worker_done；`coordinator_handle`＝shim；shim 只看到啟動指令 |
| **P6** keep-open 後 `send` 喚醒 | ✅ 通過（Claude、Codex 都過） | 150 秒後 `terminalState: retained`、`autoReleaseAt: null`；`send` 產生**新的 task＋dispatch**（`delivery: follow_up`、`followUpOf`），第 2 回合 submit、ask→reply、worker_done 全部成功；沒有 turn-unobserved 或假 escalation |
| **P7** commit sha 當 base | ✅ 通過 | A（sha）與 B（`origin/<b>`）HEAD＝sha、分支名精確；C（落後的本機名）HEAD＝落後 commit（M1 教訓證實）；comment `aio:… base:<40hex>` 完整保存 |
| **P8** checkoutExisting 機制 | ⚠️ 1、3 失敗（如預期的退路情境）；2、4 通過 | **只存在於遠端的名稱也算 taken** → Orca 靜默建立 `W-2`（path 也加 `-2`），`warnings: []`。改用退路（Orca 暫存分支 → `git checkout -B W <sha>` → 刪暫存分支）或「先建本機 W＝sha 再 `--branch W`」都得到精確名稱 |
| **P9** 呈現方式與身分環境 | ✅ 通過 | 目前設定＝**terminal**（receipt `mode: terminal, preferred: terminal, reason: user_default`）；兩家的 handle、pane key 都存在並能對回 dispatch。chat 模式（單次 `--surface chat`）**沒有** `ORCA_TERMINAL_HANDLE`／`ORCA_PANE_KEY`／`ORCA_WORKTREE_ID` |
| **錄製** | ✅ | 52 份 sanitized fixtures（含 9 份重啟後），`pnpm fixtures:scan` 通過；成功＋失敗（`no_active_sender_terminal`、`request_mismatch`、`consumer_fenced`×2、`stable_pane_required`、worker-start exit 1、check `--wait` stderr keepalive 等） |
| **P2a** Orca 重啟恢復（CLI 層級） | ✅ 通過 | Orca app 重啟（新 pid／新 runtimeId，版本不變 1.4.259）後：shim、run 綁定、generation、兩個 worker 的**原程序**都存活；request ID 可查、check 可重播；inbox 不漏不重、重啟期間沒有任何新訊息（沒有假的 lost escalation）；對存活的 keep-open worker `send` 下一輪成功 |

---

## P1　shim 建在 folder workspace　✅

步驟與證據（fixtures 名稱在括號內）：

1. `repo add --path ~/.ai-office/orca-home --kind folder --json` → repo id `1aa3d5cf-04ac-4d6e-83a7-adfd666de8fa`，`displayName: "orca-home"`（`repo-add.folder.ok`）。**沒有**改顯示名稱（`project setup-existing-folder --display-name` 屬另一次 C 級變更，未做；若要「AI Office」顯示名需另行同意）。
2. `terminal create --worktree path:~/.ai-office/orca-home --title "AI Office · 請勿關閉 aio-shim:test" --command "exec cat > /dev/null"` → `term_64deb21b-…`，回傳含 `paneKey`、`incarnationId`、`surface: visible`（`terminal-create.shim.ok`）。
3. `run-create --from <shim> --retry-request U1` → `run_3d70ed17e5de`、`consumer_generation: 1`；同 U1 重送 `replayed: true`、同 runId（`run-create.ok`、`run-create.replayed.ok`）；`request-show --request U1` 為 `completed`＋完整 receipt（注意旗標是 `--request`，不是 `--id`）。
4. `worktree create --repo path:<spike> --name aio-test-p1 --branch ai-office-test/p1 --base-branch <main sha> --no-parent --setup skip --comment aio:p1` ✅。
5. `worker-start --run R --from <shim> --agent claude --worktree path:… --task-title "aio:p1 echo" --spec-file … --retry-request U2 --json --full` → `state: ready`、`turnStart: observed`、`mutation.requestId == U2`。
6. `check --terminal <shim> --run R --wait --types worker_done --retry-request U3` → 收到 worker_done（約 30 秒）。
7. `run-show --full`：`coordinator_handle == <shim>`；`terminal read <shim>` 只有 `❯ exec cat > /dev/null`；`worktree list` 中沒有任何路徑在 cli-cwd 之上。

**設計影響**：`orca.shimLocation` 預設維持 folder workspace（`~/.ai-office/orca-home`）；T4 依此實作。folder 專案保持註冊（負責人同意，之後的正式 shim 也用它）。

## P6　keep-open dispatch 的第 2 回合　✅

- Claude（`ctx_13c3f9458cc1`）與 Codex（`ctx_fbb183823fc4`）以 `--keep-open` 啟動，第 1 回合 stub submit＋worker_done（05:48:03／05:48:07）。
- 150 秒左右的 `worker-list --run R --full`：兩者 `terminalState: retained`、`resource.retainedReason: user_requested`、`autoReleaseAt: null`。對照：非 keep-open 的 P1 worker 在 worker_done 約 2 分鐘後 `released`。
- `send --run R --from <shim> --to dispatch:<id> --subject "round 2" --body … --retry-request U`：
  - receipt 與 worker-start 同型（`state: ready`、`turnStart: observed`、`effects` 中 terminal `reused`），另有 **`delivery: "follow_up"`、`followUpOf: <舊 dispatch>`**，並產生**新的 taskId 與 dispatchId**（Claude：`task_7a371298f52a`／`ctx_89eb9ce72392`）。
  - **新 task 的 title＝`send` 的 `--subject`**（"round 2"），**不會**自動帶 `aio:`。→ adapter 要把 `aio:` 標記放進 subject（第 3 回合用 `"aio:p2a round 3"` 已驗證可行）。
  - worker-list 中 resource 的 `ownerDispatchId` 移到新 dispatch、`originDispatchId` 保留最初的 dispatch；新 dispatch 仍是 retained（keep-open 繼承）。
  - `prompt.requestId` 在 follow-up 時等於新 dispatchId（不是 mutation requestId）。
- 第 2 回合：兩家都完成 stub submit → ask → (reply) → stub submit（帶答案 `TEAL-FINCH-31`／`AMBER-MOLE-58`）→ worker_done（05:53:15／05:53:19）。
- **沒有**「turn start unobserved」escalation，也沒有 ask 後的假 escalation（本次時序下）。
- **ask 之後 `worker-show` 的 `observation.agentWait` 與 `terminal.agentWait` 都是 `null`**，`projection.stage.activity: "done"`、liveness `live`。→ `waiting_input` **不能**靠 agentWait 判定，要靠「該 dispatch 有未回答的 question」（question 訊息在 run mailbox，`reply` 後 status `answered`）。
- inbox（`inbox --terminal run:R --full`）：
  - **會列出已被 consuming check 處理過的信**（`read: 1`），未處理的為 `read: 0`。
  - `sequence` **全域單調遞增**（606→621；中間 611、612 是送往 `dispatch:` mailbox 的 reply，不在 run mailbox），列表新到舊。
  - 欄位：`id, run_id, delivery_contract, from_handle, to_handle, subject, body, type, priority, thread_id, payload, read, sequence, created_at, delivered_at, sender_pane_key, pointer_*`。
  - consuming `check` 回傳的 message **沒有** `sequence` 與 `read` 欄位 → cursor 的 `lastSeq` 必須從 inbox 取得（或以 message id 對 inbox）。
- check `--wait` 的 stderr keepalive：每 15 秒一行 `{"_keepalive":true,"_heartbeat":true,"elapsedMs":…,"deadlineMs":…}`。
- consuming check 的 batch 可能混入非等待類型的信（例：`--types worker_done` 等到的 batch 同時含 `escalation` `stopReason: lost`）→ 攝取必須處理整批，不能只看 `--types`。

**設計影響**：P6 通過，不需要「每回合 spawn 新 attempt」的退路（不需要 PP4 `multiTurnKeepOpen`）。T5／T6：follow-up 回合以新 dispatchId 對應同一個 attempt（以 `followUpOf` 串鏈、或以 AgentRef 映射 terminal/originDispatchId）；subject 帶 `aio:`；inbox 補收可行（已讀信可列、sequence 單調）。

## P7　commit sha 作為 worktree base　✅

遠端 `ai-office-test/p7-<ts>` 有 C1＝`f5f5fce…`；本機同名分支落後在 main `1e6c7ac…`。

| 情境 | `--base-branch` | HEAD | branch | `baseRef` 回傳 |
|---|---|---|---|---|
| A | `<sha>` | `f5f5fce` ✅ | `refs/heads/ai-office-test/p7a`（無後綴） | `<sha>` |
| B | `origin/<b>` | `f5f5fce` ✅ | `…/p7b` | `refs/remotes/origin/<b>` |
| C | `<b>`（本機，落後） | `1e6c7ac`（落後）⚠️ | `…/p7c` | `<b>` |

- `worktree show` 的 `comment` 完整保存 `aio:p7a base:<40 hex>`。
- 無效 base（全 0 sha）→ exit 1、`error.code: runtime_error`、message `fatal: invalid reference: …`（`worktree-create.invalid-ref.err`）。
- `git fetch origin <b>` 會同時更新 `origin/<b>`（情境 B 可用）。

**設計影響**：T5 以 **sha** 為 base（先 fetch、取 sha），建立後驗證 HEAD＝baseSha；本機名當 base 會拿到過時 commit。comment 可存 baseSha，不必另存 AdapterStateStore。

## P8　`checkoutExisting` 的 adapter 機制　⚠️（結果導向的變更適用）

遠端分支 W＝`ai-office-test/p8w-<ts>`，tip `5850c28…`。

1. **只存在於遠端**（本機無 W）：`worktree create --name aio-test-p8a --branch W --base-branch <W sha>` → **branch `W-2`、path `aio-test-p8a-2`**（displayName 仍是 `aio-test-p8a`），`warnings: []`，exit 0。**遠端名稱算 taken**。❌（預期中的退路情境）
2. **後綴偵測**：
   - 本機 W 存在、未被佔用、**tip＝base** → Orca 直接使用 W（無後綴）。
   - 本機 W 存在、未被佔用、**tip≠base**（落後在 main）→ `W-2`／`…-2` 路徑，HEAD＝base，本機 W 不變。
   - 偵測方式：比對 receipt 的 `worktree.branch`（`refs/heads/<name>`）與要求的名稱；`path` 也同步加後綴，所以 **adapter 一律以 receipt 的 `path`／`branch` 為準，不能自行推導**。
3. **刪除後以精確名稱建立**（設計的 (iii)→(iv)）：`merge-base --is-ancestor W origin/W` 成立 → `git branch -D W` → `--branch W` → 仍然得到 `W-2`（因為遠端 W 存在，等同情境 1）。❌
   - **退路 B（計畫中的變更）**：以暫存名 `--branch ai-office-test/p8tmp --base-branch <sha>` 建立 → 在新 worktree 內 `git checkout -B W <sha>` → `git branch -D ai-office-test/p8tmp` → 分支名精確、HEAD＝sha，`worktree show` 立即反映 `refs/heads/W` ✅。
   - **退路 A（新發現，更簡單）**：本機沒有 W 時先 `git branch --no-track W <sha>`（未被佔用、tip＝base）→ `--branch W --base-branch <sha>` → Orca 直接使用 W、無後綴 ✅（見情境 2 第一項）。本機 W 已存在且無未推送 commit 時 `git branch -f W <sha>` 後同樣可用（未逐一驗證 `-f` 版本，但等同 tip＝base 的情況）。
4. **佔用檢查與整合者修補**：W 被 `aio-test-p8e` 佔用時 `git worktree list --porcelain` 正確顯示 `worktree …/branch refs/heads/W`；另一個 worktree 中 `git checkout -B W origin/W`、`git switch -C W origin/W` 都被拒（`already used by worktree at …`）；`git checkout --detach origin/W` ✅ → commit → `git push origin HEAD:refs/heads/W` 快轉推送 `5850c28..a9f7528`，不需 force ✅。

其他觀察：`worktree rm --delete-branch` 對「Orca 無法證明已合併」的分支會**保留**（回傳 `preservedBranch`）→ 測試清理與 adapter 的回收都要另外 `git branch -D`（只限自己建立的分支）。

**設計影響（T5）**：(iv) 改為退路 A 或 B（engine 不受影響，W1 不變）。建議 A：fetch → 本機無 W 則 `git branch --no-track W <sha>`；本機 W 存在、未佔用、無未推送 commit 則 `git branch -f W <sha>`；之後 `worktree create --branch W --base-branch <sha>`，以 receipt 的 branch 驗證，不符就移除該 worktree（與後綴分支）並 `guard`。B 作為第二道退路。

## P9　worker 的呈現方式與身分環境　✅

1. **唯讀偵測（不改設定）**：每個 `worker-start` 與 follow-up `send` 的 receipt 都有 `mode: {mode: "terminal", preferred: "terminal", reason: "user_default", detail: "Started a terminal agent worker, the default for new agent tabs in your settings."}`；worker-list 有 `agentTerminalHandle`；`worker-read --source auto` 回 `source: transcript`（transcript 原文未保存成 fixture）。`orca status --json` 的 capabilities 含 `orchestration.worker-launch-preferences.v1`、`settings.agent-launch.v1`，但 CLI 沒有唯讀查詢設定的指令；receipt 就是偵測來源。**結論：負責人目前的「新 agent 分頁」＝ terminal**。
2. **目前模式（terminal）完整驗證**：stub 在 Claude 與 Codex 都看到 27 個 `ORCA_*` 鍵；`ORCA_TERMINAL_HANDLE`＝worker-list 的 `agentTerminalHandle`；`ORCA_PANE_KEY`＝`worker-show --full` 的 `dispatch.assigneePaneKey`；Claude 有 `CLAUDE_CODE_SESSION_ID`，Codex 有 `CODEX_THREAD_ID`。同一個 keep-open worker 的 handle 與 pane key 在 follow-up 回合不變。
3. **另一種模式（chat，只作參考）**：`agent launch --agent claude --worktree path:<aio-test-p7c> --surface chat --prompt …`（單次覆寫，不改設定）→ `outcome.kind: structured`、handle `structured-agent-session-claude_…`、`receipt.reason: requested`。其環境：**沒有 `ORCA_TERMINAL_HANDLE`、`ORCA_PANE_KEY`、`ORCA_WORKTREE_ID`**；有 `ORCA_AGENT_SESSION_ID`、`ORCA_AGENT_SESSION_SPAWN_TOKEN`、`ORCA_STRUCTURED_SESSION`、`ORCA_CHAT_SCRATCH_DIR`、`ORCA_CLI_COMMAND`、`ORCA_PAIRING_CODE` 等 13 個鍵（只記鍵名，值未記錄）；`CLAUDE_CODE_SESSION_ID` 存在。`terminal close` 不接受 structured handle（`terminal_handle_stale`）；該 session 隨 `worktree rm` 一起停止。

**設計影響**：目前是 terminal 模式 → **T4／T5 只實作 terminal 模式**；chat worker 沒有 handle，若負責人將來改成 chat，身分檢核需退化（token＋`worker-show` assignee 比對，或以 `ORCA_AGENT_SESSION_ID` 對應），M2 只做偵測：health 在 receipt `mode.mode != "terminal"` 時顯示 `chat_worker_identity_degraded`。另注意 chat 環境含 `ORCA_PAIRING_CODE`：submit CLI 與 redactor 絕不可記錄 env 值。

## 錄製（fixtures）

- 位置：`fixtures/orca/1.4.259/*.json`（52 份；其中 `after-restart.*` 9 份為 P2a 重啟後的 status、run-show、shim terminal-read、worker-list、check 重播、inbox、consuming check、follow-up send，另有 `task-update.failed.ok`），全部經 `scripts/fixtures/sanitize`，`pnpm fixtures:scan` 通過。
- 外層格式（T8 未合併，暫定）：`{orcaVersion, recordedAt, argv, exitCode, response, stderrLines[, note]}`。**不用 `stdout`／`stderr` 當鍵名**：sanitizer 會把這兩個鍵的整個值摘要成 hash。argv 中 `--body/--prompt/--spec-file/--question/--objective` 的值已換成 `<redacted:test-input>`。
- sanitizer 的副作用（T3／T6 寫 Zod 時要知道）：`deliveryId`（`delivery_…`）被高熵規則遮成 `<redacted>`；所有 `body` 變成長度＋sha256；home 路徑變 `/Users/<redacted>/…`；`projectId` 中的 owner 名稱被遮。
- 成功：status、repo add、terminal create／read、run-create（含 replay）、request-show、worktree create（sha／origin ref／過時本機名／遠端名後綴／本機名沿用／本機名分歧後綴）、worktree show／rm、worker-start（claude；codex keep-open）、check `--wait`、worker-list（reclaimable／retained／follow-up）、worker-show、send（follow-up ×2）、reply、inbox（run／dispatch）、worker-stop（already settled）、worker-release、agent launch（chat）。
- 失敗：`no_active_sender_terminal`、`request_mismatch`（含 `originalCommand`）、`consumer_fenced`（send，訊息文字誤寫成 "worker-start needs…"，只能以 code 判斷）、`consumer_fenced`（check）、`stable_pane_required`、`runtime_error`（無效 ref）、`terminal_handle_stale`、worker-start **exit 1 但 `ok: true`**（`state: failed`、`failedStage: agent_readiness`、`lastError: timeout`、`residualResources`、`recovery` 指令）、check `--wait` 的 stderr keepalive（partial）。
- **未能錄到**：worker-start 在「turn 尚未觀察到」時的輸出。`--timeout-ms 1000`（Claude）turn 仍被觀察到；`--timeout-ms 1`（Codex）則在更早的 `agent_readiness` 階段失敗。之後的 M2 錄製（T8／T16）可再試。
- worker-read 的回應含 transcript 原文，未做成 fixture（欄位清單見 M0.5 報告；本次 `sourceExact: true`、`contentComplete: false`）。

## 用量（訂閱制，只記錄，不設上限）

| worker | agent | input | output | cache write | cache read |
|---|---|---|---|---|---|
| P1 | Claude | 6 | 963 | 22,108 | 125,525 |
| P6c（r1–r3，含跨重啟的第 3 回合） | Claude | 38 | 3,997 | 26,414 | 834,026 |
| P6x（r1、r2、重啟後的 r4） | Codex | 315,372（cached 288,000） | 1,007 | 0 | — |
| P9 chat | Claude | 4 | 337 | 46,546 | 40,947 |
| unobs（Claude）、unobs2（Codex，readiness 失敗） | — | 未計 | | | |

## P2a　Orca 重啟後 shim／run 的恢復（CLI 層級）　✅

### 重啟前（06:00Z 前完成，見 `~/.ai-office/test-state/m2-t1/p2a-state.json`）

- 待安裝更新：`orca status` 的 `remoteUpdateSupport = {installMode: interactive, automatic: true, reason: available}`（只表示支援遠端更新）；`~/Library/Caches/orca-updater/pending/` 內是 `Orca-1.4.259-arm64-mac.zip`（＝當時版本，2026-11-16 安裝時的殘留）；`ShipItState.plist` 指向的暫存 bundle 已不存在 → 沒有待安裝的新版本。重啟前版本 1.4.259，runtime `c3b09d0f…`，app pid 82375。
- 測試組合：shim `term_64deb21b-…`＋run `run_3d70ed17e5de`（`coordinator_handle`＝shim、`consumer_generation: 1`）＋2 個 keep-open worker：
  - 進行中：Claude `ctx_34b96984e89c`（第 3 回合，迴圈 `sleep 540` 等待 release 檔）；
  - 已 worker_done、等下一輪：Codex `ctx_344f220389d5`（retained）。
- 未消費訊息：`msg_0f5f9db25307`（seq 621，status）。inbox `lastSeq: 621`；task 數 8。
- `orca:p2 prepare` 測試工具尚不存在（T8 未合併），改為手動寫狀態檔（0600）與 `RESUME.md`。
- coordinator 清空其他 worker 後，由負責人親手重啟 Orca（app 程序開始時間 **06:04:21Z**；coordinator 轉述約 06:10Z）。

### 重啟後的觀察（§5 P2 的 (2)–(10)）

| # | 觀察 | 結果 |
|---|---|---|
| (2) | 舊 shim 是否還在、是否仍是活的 pane | ✅ `terminal list` 有同一個 handle `term_64deb21b-…`，**`incarnationId` 不變**；`terminal read` 顯示 `status: running`、只有 `❯ exec cat > /dev/null`。小差異：`terminal list` 的 `title` 變成 `null`（重啟前是 "AI Office · 請勿關閉 aio-shim:test"） |
| (3) | `ensure()`／`run-use`／generation | ✅ 不需要：`run-show` 的 `coordinator_handle` 仍是原 shim、`consumer_generation` 仍是 1；以原 shim 做 consuming check、`send`、`task-update` 全部成功。**沒有**執行 `run-use`，也沒有建新 shim |
| (4) | 兩個 worker 是否存活 | ✅ **原程序存活，不是被 Orca 重新啟動**：Claude worker pid 28816、Codex worker pid 28982 的開始時間都是 05:47Z（重啟前），重啟後 Claude worker 的 `sleep 540` 迴圈仍在跑（新的一輪 `sleep` 在 06:04:31Z 由同一個 pid 啟動）。worker-list：`ctx_34b96984e89c` 仍是 `ready／dispatched／retained`、activity `working`、`endpointIncarnation` 不變；liveness `live`（source `agent_status`） |
| (5) | 重啟前 request ID 的 `request-show` | ✅ worker-start、check、send、run-create 的 request ID 都回 `state: completed`＋原 method |
| (6) | 重啟前的 check 能否重播 | ✅ 以重啟前最後一次 check 的 request ID 重送 → 同一個 `deliveryId`、同樣 2 則訊息、`mutation.replayed: true`。注意 `result.replayed` 仍是 `false`（保存的是原始回應），**判斷重播要看 `mutation.replayed`** |
| (7) | inbox 補收：不漏、不重複 | ✅ `inbox --terminal run:R --full`：10 則、無重複 id；seq 621 仍 `read: 0`；**重啟期間沒有任何新訊息**（沒有 escalation、沒有 lost）。之後的 consuming check 正好只回 seq 621 這一則 |
| (8) | 對存活的 keep-open worker `send` 下一輪 | ✅ 對 Codex `ctx_344f220389d5` 送 `"aio:p2a round 4"` → 新 dispatch `ctx_83ee3694f71d`（`turnStart: observed`），06:06:08Z worker_done；Claude worker 收到 release 後 06:06:05Z 完成第 3 回合並 worker_done |
| (9) | `task-list --run R` 的 task 數 | ✅ 9＝重啟前 8＋重啟後 1 個 follow-up；沒有重複派工 |
| (10) | 版本 | 1.4.259 → **1.4.259**（不變）；app pid 82375 → 53045；runtimeId `c3b09d0f…` → `20f39d2e…` |

### 為什麼都存活：terminal 由獨立的 daemon 承載

- 所有 Orca terminal（shim、worker、coordinator 與本 session）的 PTY 父程序鏈是 `login` → `Orca Agents.app`（`~/Library/Application Support/orca/daemon-host/macos/terminal-host-…/Orca Agents.app`，pid 82816，自 2026-11-16 起執行，`ppid 1`）。重啟的是 Orca **app**（Electron，pid 82375 → 53045），terminal-host daemon 沒有重啟。
- **coordinator 的 worker 與本 T1 session 也一樣**：本 session 的 `claude` 程序（pid 24177）開始於 05:45Z，重啟後仍是同一個程序，對話脈絡完整保留（不是 tab 還原後以 `--resume` 重新啟動）。重啟後看到的 `liveness: live` 反映的是**真的存活**，不是「分頁還原＝新程序」。同時存在的其他 claude／codex worker 程序（13:44–13:54 本地時間啟動）也都還在。
- 因此 P2a 實際驗證到的是「Orca app 重啟、terminal-host daemon 存活」的情況。**沒有**驗證到 daemon 也一起死掉的情況（例如登出、重開機、daemon 升級或當機）；那種情況下 worker 程序必然結束，屬於 P2 的失敗分支 (c)。

### 設計影響

- T4 `ensure()`：重啟後先以 `terminal list` 確認 shim handle 存在、`incarnationId` 不變，再以 `run-show` 確認 `coordinator_handle`／generation 未變 → 直接沿用，**不必** `run-use`、不產生 `identity_restored` 以外的副作用（generation 沒變，不會誤判 hijack）。只有 handle 消失或 incarnation 改變時才建新 shim＋`run-use`。不要依賴 `terminal list` 的 `title` 辨識 shim（重啟後可能為 null）；以 handle（存在 AdapterStateStore）辨識。
- T6：Orca 不可達期間不會產生訊息，重啟後以 inbox `sequence` 補收即可；冪等落地照 `orca:msg:<messageId>`。check 重播判斷用 `mutation.replayed`。
- T6／T10：重啟後 worker 的 liveness 可信（daemon 存活時程序真的存活），不需要把「Orca 重啟」一律當成全部 worker lost；但 daemon 也重啟時要能處理全部 lost（走既有失敗流程）。SPEC §16 可補述這兩種情況。
- P2b（T16）要再確認：AI Office 後端以脫離 Orca 程序樹的方式執行時，不可達期間的 breaker／`paused{runtime_unhealthy}`。本次 CLI 在重啟後第一次呼叫（06:04:48Z）已正常，app 不可達的時間很短（不到 30 秒）。

### 清理清單

- [x] P1、P7a/b/c、P8e worktree 已 `worktree rm`（含停止 p7c 的 chat session）
- [x] 測試 repo 本機分支 `ai-office-test/p1`、`p7-*`、`p7a/b/c`、`p8w-*`、`p8tmp`、`*-2` 已刪除
- [x] 遠端 `ai-office-test/p7-20261118134815`、`ai-office-test/p8w-20261118134847` 已刪除（`git fetch --prune` 後無殘留）
- [x] shim B（`term_38f2852f-…`）已關閉；暫時 clone 已刪
- [x] 測試 dispatch `ctx_95a2dd7598c2`（readiness 失敗）stop＋release；`ctx_8934904f1861` 已自動 release
- [x] P2a 之後：`ctx_34b96984e89c`、`ctx_83ee3694f71d` stop＋release（`closed_agent_terminal`）；worker-list 中本 run 沒有任何非 released 的 terminal
- [x] `worktree rm --delete-branch` `aio-test-p6c`、`aio-test-p6x`（分支與 main 相同，已一併刪除）；測試 repo 無任何 `ai-office-test/*`、`aio-test-*` 本機或遠端分支
- [x] shim `term_64deb21b-…` 已關閉；`orca-home` 與 spike 測試 worktree 下沒有殘留 terminal
- [x] run 內 8 個 completed task 以 `task-update --status failed --result "cancelled (M2-T1 test cleanup)"` 標記（shim 已關閉後仍可用 `--from <shim>`；`aio:unobs2` 原本就是 failed）
- 保留：folder 專案 `~/.ai-office/orca-home`（P1，負責人同意，正式用途）；`run_3d70ed17e5de` 本身（Orca 沒有刪除 run 的指令）

## SPEC／計畫待釐清

1. P8：計畫 (iv)「以精確名稱 W 建立」在遠端 W 存在時不可能 → T5 依「結果導向的變更」改用退路 A／B（engine 不變）。§5 P8 文字應更新。
2. P6：follow-up 回合產生新 task／dispatch；SPEC §7.1／§11.1 的 AgentRef 與 dispatch 對應需寫明「一個 attempt 可對應多個 dispatch（以 `followUpOf` 串連）」。
3. P6：`waiting_input` 判定不能用 `observation.agentWait`（ask 後為 null）；SPEC 若依賴 agentWait 需改為依未回答的 question。
4. consuming check 的 message 沒有 `sequence`；cursor `lastSeq` 只能從 inbox 取得。
5. `consumer_fenced` 的訊息文字不分命令（send 也說 "worker-start needs…"）；只依 `error.code`。
6. worker-start 可能 **exit 1 但 `ok: true`**（`state: failed`）；T3 的錯誤分類不能只看 `ok`。
7. 錄製格式的鍵名不能用 `stdout`／`stderr`（sanitizer 會摘要整個值）；T8 定義 replay 格式時要注意。
8. P2：SPEC／計畫假設「重啟會殺掉 coordinator 與所有 worker」不成立（至少在 terminal-host daemon 存活時）；§1.4 與 §5 P2 的前提可放寬，但 coordinator 仍應在重啟前清空 worker，因為 daemon 是否存活無法事先保證。
9. P2：`check` 重播時 `result.replayed` 與 `mutation.replayed` 不一致；adapter 以 `mutation.replayed` 為準。
