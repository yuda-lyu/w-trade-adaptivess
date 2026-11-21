# 狀態(現況)· 套件層與環境

> 自 `state.md` 之 §3、§5 搬出(2026-11-21;原文照搬,只搬移、不改寫;節號與標題不變).索引見 `state.md` 之「拆檔索引」.

## 3. 各功能之現況

| 功能 | 現況 | 規則 / 守門 |
|---|---|---|
| 發布面(`package.json`、`.gitignore`、不設 `.npmignore`) | `scripts` 只有 `test`、`deploy`;`main` 指 `dist/w-trade-adaptivess.umd.js`;`npm pack` 內容 = 版控內容 + `dist/`、`docs/`(建置產物);`.gitignore` 另列 `g.mjs` 之暫存夾 `_test_adaptivess`(中途失敗時不入版控與包) | R-PKG-1;`unit-package` |
| 建置(`script.txt` 之 modifyReadme → cleanFolder → jsdoc → gDocsExams → gDistRollup → genDocsDist) | 各步已實跑、皆成功;jsdoc 0 ERROR / 0 WARNING;`toolg/gDocsExams.mjs` 為標準之 `genDocsExams()`(有 `examples/`,複製至 `docs/examples/`);dist 可以 `require` 與 `import` 載入(Node 24),匯出與聚合入口相同,評估結果之選集指紋與 src 相同 | R-PKG-1 |
| dist 之限制 | 以 `import.meta.url` 定位套件檔者(`initProject`、`makeTexts` 之程式夾)於 dist 內以 `dist/` 為準而定位錯誤:經 dist 呼叫 `initProject` 拋 ENOENT;README 註明一律以 ESM 深層路徑取用 | README §Installation |
| 對外介面之 JSDoc | 聚合入口匯出之函數與常數於定義處皆有 JSDoc(現 79 鍵〔Gitea #174 新增 `isCapitalError`、`normUnit`、`sameUnit`;函數 63、常數 16、定義處 62 個;三者於定義處皆有 JSDoc 與 `@example`〕;以下為 #174 之前之 76 鍵之敘述:函數 60〔別名 `createAdaptivess` 與 `makeProject` 同一實體,定義處 59 個〕、常數 16;`@param` 217、`@example` 64 處;排程第 493 項新增 `ntStaticOf` 之 2 與 1、第 500 項新增 `memberLedger` 之 3 與 1;`makeEvaluator` 之 `@param` 與範例同步改;排程第 500 項另以腳本〔依匯出名稱找定義處之前之 JSDoc 區塊〕重數,HEAD 為函數定義處 58、`@param` 216、`@example` 58,現為 59、219、59 —— 與前次之 214 / 63 之計法不同,惟差皆為 +1 個函數、+3 個 `@param`、+1 個 `@example`);`memberLedger` 之範例流程(`getSettings` → `loadLedger` → `memberLedger` → `ntStaticOf` → `makeEvaluator`,含聚合入口之同流程)以合成帳本與合成之 `settings.json` 實跑核對(兩半互補 25 + 35 = 60;同一實體),`jsdoc` 0 ERROR / 0 WARNING | R-PKG-7;`unit-package`(鍵數、同一實體、`tieBaseOf` / `isSrcIdx` 不併入) |
| 去識別 | 發布檔(含 dist、docs;有 `.git` 時以 `git ls-files` 取範圍)不含本機路徑(磁碟機、file URL、家目錄、UNC)、內網主機名與私有網段位址(通則檢查,不列使用端名稱);註解內可辨識出處之來源輪次、日期、人名、實測統計已清除(作為預設常數或測試資料之數值保留);**執行期字串內者未清**(§5);已知限制見 R-PKG-5 | R-PKG-5;`unit-package` |
| 子行程隱藏視窗 | src 10 處、test 4 處(全集)皆 `windowsHide: true`;守門以括號配對只看該次呼叫引數之頂層物件(含字串內組出者),`child_process` 只准具名不改名;涵蓋 src、套件根 `g*.mjs`、test;已知限制見 R-OPS-1 | R-OPS-1;`unit-guard` |
| 計時器相關之測試 | 測試皆以注入(`opt.sleep` / `opt.read`)或狀態同步,無「延時後斷言」 | R-PKG-8;`unit-run` |
| 測試不得改寫入版控之文件(排程第 580 項之③) | 輪末鉤子末段之專案文件自動整理(R-REC-17)以模組常數 `FD_ROOT` 之 `sgud` 為對象,測試改專案夾到暫存夾並不改變此路徑:8 個測試檔(`unit-dreamOnly`、`unit-envChangedHint`、`unit-fillBacklog`、`unit-fillRevise`、`unit-fillRun`、`unit-guardInline`、`unit-outwardSaturated`、`unit-signsClause`;修前於複本實測共 40 案觸發)於本庫之回饋檔 / 經驗檔逾上限時會改寫版控中之文件並多出 `<名>_<年月日>.md`(2026-11-21 曾產生 `feedback_20261121.md`)⇒ 各專案建構處設 `st.rsi.docLimits = false`(其餘已套者:`unit-evalHints`、`unit-aliasBase`;`unit-reworkId` 之專案建於子行程且 `ARSI_ROOT` 為暫存夾,刻意不套);守門:靜態(建專案且走到輪末鉤子之測試檔須關閉)+ 動態(同一次執行內每個測試前後比對本庫 `sgud`,有變動者於全部測試之後一併失敗並列出測試與檔名);**只動測試與守門,不動 `src`** | R-PKG-10;`unit-sgudUntouched`(4 案 + 動態守門)、變異 TI01 ~ TI09 |
| 於 npm 包內執行測試 | `unit-package` 於無 `.git` 且無 `.gitignore` 時略過 `.gitignore` 之列項檢查、去識別掃描改以包內全部文字檔為範圍(只略過任一層 `node_modules` 與包根下之測試暫存夾);`npm pack` 解開後跑全套 0 失敗(188 通過、4 略過);有 `.git` 而缺 `.gitignore` 者仍失敗 | R-PKG-1、R-PKG-5;`unit-package` |

## 5. 已知缺口與待辦

- **合成帳本之整輪回歸**:`unit-fakeRound` 已以 `test/tools/synthLedger.mjs` 之合成帳本與 `initProject` 之參考檔跑通 `tools/fakeRound.mjs`(離開碼為斷言;補算之「真實診斷」一項於無該診斷之專案略過,R-EV-45 ⑦);fakeRound 內各項之斷言仍在該工具內(以離開碼呈現),尚未逐項移入測試.
- **計時器之觀察回調**:`src/arsi/resources.mjs`(資源取樣與資源閘)、`src/tools/waitEvent.mjs`(事件檔輪詢)、`src/domain/proc.mjs`(子行程逾時)尚未提供 `opt.onTrace`;依跨套件規格須沿用 wsemi 之 `getTrace`(本套件已於 Gitea #156 依賴 wsemi,R-PKG-2 已含;併入後續).
- **輸入參數之檢測機制**(跨套件規格,草案):對外函數之參數由各函數自行檢查,未以 wsemi 共用函數宣告種類(後續;**主控排程第 477 項**之範圍含 Gitea #156 新增之選配參數:`makeDispatch` / `checkQuota` 之 `maxPercent`、`probe`、`probeTimeoutMs`、`inject`,與 `agents.<role>.quotaMaxPercent`;目前非有限數之門檻取 95,`probeTimeoutMs` 原樣交派工套件〔其無效值取其預設 300000〕).
- **領域接線假定專案根有 `sgud/`**:做夢須更新 `sgud/state/state.md`、`sgud/exp/experience.md`(未更新者該輪判為失敗),改進項寫入 `sgud/feedback/feedback.md`,寫法守則讀 `sgud/proc/guide_*.md`;宜改為輪末回調,由專案注入(後續,由使用端另提).
- **執行期字串內之來源專案數值**:任務書與試驗登錄之字串仍含來源專案之輪次與數字(`src/domain/texts.mjs` 做夢任務書之「(r003:…)」、`src/domain/briefTrials.mjs` 之 `metric` / `why` / `closed`),以及寫死之日期(`texts.mjs` 之求解窗止日、`src/domain/pickStore.mjs` 之保留期起日;應自 `settings` 推得).改動即改變任務書之輸出,列後續.
- **`g.mjs` 之暫存夾**:固定為工作目錄下之 `./_test_adaptivess`,啟動與結束時遞迴刪除(與 w-trade-strategy 之 `g.mjs` 同一慣例);工作目錄恰有同名之使用者資料夾時會被刪.改為 `fs.mkdtempSync` 建於系統暫存區、只清自己建立者(後續;README 之範例同步).
- **dist 內以 `import.meta.url` 定位者**:如需 dist 亦可用,改為自模組所在處往上找 `package.json` 之 `name` 為本套件者(後續;目前以 README 限定 ESM 深層路徑).
- 任務書之文字固定為繁體中文,且含交易領域之用語;其他領域須改寫 `src/domain/texts.mjs` 或注入自己之任務書.
- `settings.dispatch.skillsRoot` 之預設為行程使用者之家目錄下之 `.claude/skills`(`os.homedir()` 推得);其他環境請明給或以 `inject.dispatch` 取代.
- 合約由專案維護:升版後須人工比對 `docs/pick-contract.pkg.md` 併入新條文.
- 規則帳本之沿用規則族(R-EV、R-REC 等)之逐條條文仍在程式註解,尚未整理成表.
