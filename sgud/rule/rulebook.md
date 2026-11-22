# 規則帳本(藍圖)

以規則為單位記本套件須長成什麼樣;每條附位置與守門之測試.程式註解內之規則編號(R-EV、R-REC、R-ARM、R-RUN、R-BT、R-TB、R-MON、R-OPS、R-RSI)沿用抽提前之編號,其條文見各檔之檔頭與該段註解(§2 列出各族之範圍與守門之測試檔);本檔 §1 為套件層之規則.

## 拆檔索引(依類型;2026-11-21 起)

本檔過長(約 250 KB)而依類型拆檔(role-writer-sgud §3):各條之原文照搬(只搬移、不改寫),節號、條號與標題不變;要查某條規則,依下表找檔(各檔皆為同一張四欄表〔編號 | 規則 | 位置 | 守門〕之列,列之次序同原檔).§2(規則族)與 §3(未完成)仍在本檔;§1 套件層與 §2.1 之條文在下列各檔.程式註解與他處所引之「`sgud/rule/rulebook.md` 之 R-xxx-n」,依本表找檔.

| 檔 | 內容 | 條號 |
|---|---|---|
| `rulebook_PKG.md` | §1 套件層:發布面、依賴、專案根之錨點、專案接入、發布內容(版控與 npm 包)、對外介面之 JSDoc、計時器相關之測試、節點禁區涵蓋套件安裝後之配置、變異工具、測試不得改寫入版控之文件 | R-PKG-1 ~ R-PKG-10(10 條) |
| `rulebook_EV1.md` | 外部序列、評估器之狀態與無前視、擴充診斷之資料存取、訓練期之界線與 K 線欄之長度核對、`api.replaceNull`、載入器之匯入快取鍵、成員重抽之半庫帳本 | R-EV-34 ~ R-EV-40(7 條) |
| `rulebook_EV2.md` | 求解窗後段(`--period postfit`)、其近期活躍度版之組成對照、下單之基礎單位 | R-EV-41 ~ R-EV-43(3 條) |
| `rulebook_EV3.md` | 每根 K 棒之時長之一般化、帳本之起點與求解窗核對之下界、`api.fillRandom`、子庫之規則與 `--subset`、庫況體檢 | R-EV-44 ~ R-EV-48(5 條) |
| `rulebook_REC1.md` | 方向之主張鍵與去重、向外飽和之宣告、共同儲存區之正負號與看板值、保留期與其他標的之正負號、評估環境之鍵改變後之重做、附算與補算、節點任務書之口徑提示 | R-REC-24、R-REC-28 ~ R-REC-35(9 條) |
| `rulebook_REC2.md` | 文字不寫死策略庫之事實、做夢任務書之預先核對、搜尋地圖之「有內容」、輪末摘要之「待核對」、排序鍵、輪末之附算一併處理待補算 | R-REC-36 ~ R-REC-41(6 條) |
| `rulebook_REC3.md` | 迴圈之重放一併載入擴充診斷、迴圈檢查之兩條提示(單峰交付、選集與他節點相同)、起點不取別名、向外飽和之標示、任務書之「可疑方向」與資訊來源之三級、側別曝險不作為底、量尺之並列與選配之主鍵、全樹之側別讀數、成員穩健性之附算與「成員依賴」之提示 | R-REC-42 ~ R-REC-51(10 條) |
| `rulebook_RUNBT.md` | 額度造成之失敗、前緣為空與只做夢輪次、測試之成敗不隨機器之負載而變、agent 之角色之環境變數與進入檔之拒跑、共用工具區之已發布之檔、操作稽核與操作掃描(R-BT-5 ~ R-BT-10) | R-RUN-8 ~ R-RUN-11、R-TB-6、R-BT-5 ~ R-BT-10(11 條;表內之次序為 R-RUN-8、R-RUN-9、R-TB-6、R-RUN-10、R-RUN-11、R-BT-5 ~ R-BT-10) |

## 1. 套件層

條文(R-PKG-1 ~ R-PKG-10)已搬至 `rulebook_PKG.md`(原文照搬,列之次序同原檔).

## 2. 沿用之規則族(條文在程式註解)

| 族 | 範圍 | 主要位置 | 守門之測試檔 |
|---|---|---|---|
| R-EV | 評估器:訂單帳本與官方回測一致、無前視、`ctx` 各介面、執行規則與分帳、各虛無與對照、歸因、擴充診斷之介面、判讀與階梯、評估器之狀態不受模組之寫入影響(R-EV-35)、擴充診斷之資料存取(R-EV-36)、訓練期之界線明給與 K 線欄之長度核對(R-EV-37)、`api.replaceNull` 只替換一部分之席(R-EV-38)、載入器之匯入快取鍵(R-EV-39)、成員重抽之半庫帳本(R-EV-40)、只留求解窗已結束之席與求解窗後段(R-EV-41)、求解窗後段之近期活躍度版之組成對照(R-EV-42)、下單之基礎單位(R-EV-43)、每根 K 棒之時長之一般化(R-EV-44)、帳本之起點與求解窗核對之下界(R-EV-45)、子庫之規則與命令列之 `--subset`(R-EV-47)、庫況體檢 `tools/libCheck.mjs`(R-EV-48) | `src/eval/*`、`src/cli/eval.mjs`、`src/cli/build.mjs`、`src/cli/backtest.mjs`、`contract/pick-contract.md` | `unit-evalCore`、`unit-evalIntegrity`、`unit-evalCli`、`unit-extData`、`unit-extReplacePart`、`unit-ledgerSeries`、`unit-score`、`unit-pickLoader`、`unit-loaderRewrite`、`unit-memberLedger`、`unit-ledgerReal`、`unit-evalPostfit`、`unit-evalPostfitRecent`、`unit-evalUnit`、`unit-barHours`、`unit-evalNums`、`unit-evalFingerprint`、`unit-ledgerStart`、`unit-fakeRound`、`unit-fullLedgerHint`、`unit-subsetLedger`、`unit-libCheck` |
| R-REC | 紀錄與流程:節點文件與做夢文件之規格、任務類型、方向之配比與去重(含向外飽和之宣告 R-REC-29)、看板、搜尋地圖、共同儲存區(含其他標的之正負號 R-REC-30、各列之擴充診斷之看板值 R-REC-31、求解窗後段之佐證 R-REC-34)、保留期與其他標的之正負號之用法(做夢任務書之一句與輪末摘要之機械提示 R-REC-32)、擴充診斷之看板值 / 子集 / 補算、評估環境之鍵改變後之重做與展開(R-REC-33)、附算與補算(R-REC-34)、節點任務書之口徑提示(R-REC-35)、套件之文字不寫死任何策略庫之事實(R-REC-36)、做夢任務書之預先核對不以求解窗後段為判準(R-REC-37)、搜尋地圖之「有內容」另看近期活躍度版之組成對照(R-REC-38)、輪末摘要之「待核對」不列組成對照 / 重放 / 同分次序之同號 / 異號之句(R-REC-39)、「最佳 / 最高」、參考節點與補位之底之排序鍵(R-REC-40)、輪末之附算一併處理待補算(R-REC-41)、迴圈之重放一併載入擴充診斷(R-REC-42)、迴圈檢查之提示「單峰交付」與「選集與他節點相同」(R-REC-43、R-REC-44)、任務書之「可疑方向」與資訊來源之三級(R-REC-47)、側別曝險不作為底(R-REC-48)、量尺之並列與選配之主鍵(R-REC-49)、全樹之側別讀數(R-REC-50)、成員穩健性之附算與「成員依賴」之提示(R-REC-51) | `src/arsi/records.mjs`、`src/arsi/arsi.mjs`、`src/domain/domain.mjs`、`src/domain/texts.mjs`、`src/domain/factsText.mjs`、`src/domain/pickStore.mjs`、`src/domain/fillPlan.mjs`、`src/domain/fillKeys.mjs`、`src/tools/initProject.mjs`、`src/domain/verifyEvalHints.mjs`(R-REC-43、R-REC-44 之判定;檔名以 `verify` 起首 ⇒ 節點之禁區字樣涵蓋之,R-BT-10)、`src/tools/scanCheck.mjs`、`contract/pick-contract.md`(R-REC-47 之判讀名詞)、`src/domain/verifyExposure.mjs`(檔名以 `verify` 起首,R-BT-10)、`src/domain/sideRead.mjs`、`src/domain/rankCompare.mjs`、`src/tools/exposure.mjs`、`src/tools/rankCompare.mjs`(R-REC-48 ~ R-REC-50)、`src/domain/verifyMember.mjs`(R-REC-51 之判定;檔名以 `verify` 起首,R-BT-10) | `unit-records`、`unit-arsi`、`unit-texts`、`unit-claimKey`、`unit-pickStore`、`unit-pickStoreCross`、`unit-pickStoreExt`、`unit-guard`、`unit-outwardSaturated`、`unit-signsClause`、`unit-reworkId`、`unit-fillPlan`、`unit-fillRun`、`unit-fillCli`、`unit-fillRevise`、`unit-envChangedHint`、`unit-barHours`、`unit-dreamOnly`、`unit-factsResidue`、`unit-searchMapRecent`、`unit-fakeRound`、`unit-signsNarrow`、`unit-rankKey`、`unit-fillBacklog`、`unit-replayExt`、`unit-evalHints`、`unit-exposure`、`unit-gaugeDual`、`unit-sideRead`、`unit-memberCheck`、`unit-gaugeContent` |
| R-ARM | 臂目錄:節點與做夢提案、主控審定、生效目錄 = 基底 + 擴充(引擎之治理)、前緣改掛 | `src/domain/armCatalog.mjs`、`src/domain/domain.mjs`、`src/tools/armDecide.mjs` | `unit-armCatalog` |
| R-RUN | 執行:每輪節點數與併行、一次跑幾輪、資源閘、單一執行之鎖、事件檔、起跑前之額度檢查、補做夢、前緣為空不起空輪與只做夢輪次(R-RUN-9)、測試之成敗不隨機器之負載而變(R-RUN-10)、agent 之角色之環境變數與進入檔之拒跑(R-RUN-11) | `src/arsi/runner.mjs`、`src/arsi/resources.mjs`、`src/cli/rsi.mjs`、`src/cli/launch.mjs`、`src/arsi/dispatchers.mjs`、`src/arsi/agentRole.mjs`、`src/domain/agentEntries.mjs` | `unit-run`、`unit-dispatchQuota`、`unit-quotaCli`、`unit-dreamOnly`、`unit-testResources`、`unit-agentGuard`、`unit-agentDispatchEnv` |
| R-BT | 禁區與檢定:私有根在專案夾外、檢定工具須授權、agent 操作紀錄之掃描、保留期與其他標的之數字不入專案(兩者之正負號只經共同儲存區,且只收 `+` / `-` / `0`;R-REC-30)、操作稽核之內嵌腳本之比對式不列為觸及禁區(R-BT-5)、操作掃描之「列出工作夾之根」只列以之為目標者(R-BT-6)、操作掃描之「執行迴圈之寫檔入口」與「遞迴列出狀態根」(R-BT-7)、做夢之操作稽核之搜尋樣式之去除(R-BT-8)、操作掃描之「可讀之他節點工作夾」三處共用同一求法(R-BT-9)、節點之禁區涵蓋迴圈驗證之全部原始碼(`src/domain/verify*`、`src/domain/backtest*`;R-BT-10) | `src/domain/verify.mjs`、`src/domain/verifyCmdScan.mjs`(指令解析;原 `verifyCmdScan.mjs`)、`src/domain/verifyEvalHints.mjs`(兩條機械提示之判定)、`src/domain/verifyExposure.mjs`(側別曝險之判定;R-REC-48、R-BT-10 ⑤)、`src/domain/verifyMember.mjs`(成員依賴之判定;R-REC-51、R-BT-10 ⑥)、`src/domain/backtest*.mjs`、`src/cli/backtest.mjs`、`src/tools/scanCheck.mjs` | `unit-guard`、`unit-backtestGrade`、`unit-guardInline`、`unit-scanListRoot`、`unit-scanEntryExec`、`unit-cmdScan`、`unit-scanAllowWork`、`unit-verifyZone` |
| R-TB | 共用工具區:由做夢擴建、迴圈只做機械檢查(快照、逐檔檢查與還原、索引一致;已發布之檔於檔頭註解以外不得改寫 R-TB-6) | `src/arsi/toolbox.mjs`、`src/domain/toolboxRules.mjs`、`src/cli/toolbox.mjs` | `unit-toolbox`、`unit-toolboxRewrite` |
| R-MON | 任務書條款之隨機對照、寫法守則(由做夢維護之檔,原文附於任務書) | `src/domain/briefTrials.mjs`、`src/domain/texts.mjs` | `unit-briefTrials`、`unit-guides` |
| R-OPS | 起子行程一律隱藏視窗(R-OPS-1:`spawn`、`spawnSync`、`exec`、`execSync`、`execFile`、`execFileSync`、`fork` 之每一處皆以**該次呼叫之引數之頂層物件**帶 `windowsHide: true`(括號配對取範圍,略過字串與樣板字串;巢狀物件與字串內之字樣不算;字串內組出之呼叫同樣比對);`child_process`(含 `node:child_process`)只以具名且不改名之方式取用,預設匯入、命名空間、改名、重新匯出、動態 `import()`、以變數承接 `require`(含無宣告之賦值)、`require(…)` 後直接取方法者皆不准;已知限制:以字元掃描而非語法樹,區塊註解之記號出現在字串內、描述文字內含呼叫形之字樣時可能誤判;範圍 = `src`、套件根之 `g*.mjs`、`test`;全集 src 10 處、test 4 處);指引文件逾上限自動整理 | 全部起子行程處;`src/domain/archiveDocs.mjs` | `unit-guard`(守門本身之正反例 + 全檔掃描,並斷言代表之呼叫點皆被找到)、`unit-archiveDocs` |
| R-RSI | 引擎只經兩個接縫檔取用 | `src/engineApi.mjs`、`src/engineProtocol.mjs` | `unit-guard` |

### 2.1 已整理成表之個別條文(沿用規則族內)

逐條條文已依類型搬至上列「拆檔索引」之各檔(原文照搬;表頭同).

## 3. 未完成(預期功能;不是死碼)

- 各規則族之逐條條文尚未整理成本檔之表(目前在程式註解):逐族補入時須去識別(不寫使用端之輪次、節點與數字).
- `tools/fakeRound.mjs` 原需要專案之真實帳本;`unit-fakeRound` 已以合成帳本與 `initProject` 之參考檔跑通(離開碼 0 為斷言之一;補算之「真實診斷」一項於無該診斷之專案略過,R-EV-45 ⑦).fakeRound 各項之斷言仍在該工具內(以離開碼呈現),尚未逐項移入測試.
- 計時器相關函數(R-PKG-8 之 src 三處)之 `opt.onTrace`(跨套件規格〈計時器相關函數之觀察回調與測試〉;須沿用 wsemi `getTrace`;`wsemi` 已於 Gitea #156 列為依賴,可併入).
- 對外函數之參數檢測依跨套件規格〈輸入參數之檢測機制〉(草案)以 wsemi 共用函數宣告種類(含 Gitea #156 新增之選配參數 `makeDispatch` / `checkQuota` 之 `maxPercent`、`probe`、`probeTimeoutMs`、`inject` 與 `agents.<role>.quotaMaxPercent`:目前於函數內自行處理,非有限數之門檻取 95;主控排程第 477 項).
- 執行期字串(任務書、試驗登錄)內之來源專案輪次與數字、寫死之日期(求解窗止日、保留期起日)改為中性寫法或自設定推得(改動即改變任務書之輸出).
- 領域接線之 `sgud/` 假定改為輪末回調,由專案注入.
