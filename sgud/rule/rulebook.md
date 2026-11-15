# 規則帳本(藍圖)

以規則為單位記本套件須長成什麼樣;每條附位置與守門之測試.程式註解內之規則編號(R-EV、R-REC、R-ARM、R-RUN、R-BT、R-TB、R-MON、R-OPS、R-RSI)沿用抽提前之編號,其條文見各檔之檔頭與該段註解(§2 列出各族之範圍與守門之測試檔);本檔 §1 為套件層之規則.

## 1. 套件層

| 編號 | 規則 | 位置 | 守門 |
|---|---|---|---|
| R-PKG-1 | 發布面:`package.json` 之 `scripts` 只有 `test` 與 `deploy`;`test` = `mocha --no-parallel "test/*.test.mjs" --timeout 180000`;不設 `exports` / `files` / `type`;`main` 指 `dist/w-trade-adaptivess.umd.js`;不提供 `.mocharc.json` 與 `.npmignore`;`.gitignore` 列 `node_modules`、`tmp`、`test/_tmp`、`CLAUDE*.md`、`rsi`、`data`,不排除 `sgud`、`src`、`test` | `package.json`、`.gitignore` | `test/unit-package.test.mjs` |
| R-PKG-2 | 依賴:`src/` 實際匯入之 npm 套件 = `dependencies`(`w-recursi`、`w-trade-backtest`);自有套件一律以其 `src` 深層路徑引用;node 內建模組不帶 `node:` 前綴;引擎 `w-recursi` 只經 `src/engineApi.mjs`、`src/engineProtocol.mjs` 取用;派工套件 `w-dispatch-ai` 不列為依賴(由 `dispatch.skillsRoot` 定位,或以 `inject.dispatch` 取代) | `src/**` | `test/unit-package.test.mjs`、`test/unit-guard.test.mjs` |
| R-PKG-3 | 專案根之錨點:`src/cfg.mjs` 之 `FD_ROOT` = 環境變數 `ARSI_ROOT`,未設時為行程之工作目錄;**不以套件檔之位置推導**(安裝後會落在 `node_modules`).進入檔先把 `ARSI_ROOT` 設為自身所在之資料夾,再以動態匯入載入命令列程式(靜態匯入先於設定,不得用);起子行程時沿用環境變數.套件自己之檔案(工具、參考檔)才以 `import.meta.url` 定位 | `src/cfg.mjs`、套件根之 `g_*.mjs`、`src/tools/initProject.mjs`(`shimOf`)、`src/cli/rsi.mjs`(`FP_DIGEST`)、`src/domain/texts.mjs`(`codeRel`) | `test/unit-package.test.mjs` |
| R-PKG-4 | 專案接入:`initProject({ root, dry, force })` 產生進入檔(`g_*.mjs`、`tools/<名>.mjs`)與參考檔;已存在而非本工具所產生之同名進入檔不覆寫(`force` 才覆寫);`settings.json`、`arms/base.json`、`docs/pick-contract.md` 只在不存在時寫;合約與參考版不同時另寫 `docs/pick-contract.pkg.md` 並列出;重跑不變;專案根不可為套件夾 | `src/tools/initProject.mjs` | `test/unit-package.test.mjs` |
| R-PKG-5 | 發布內容(版控與 npm 包之全部文字檔,含建置產物 `dist/`、`docs/`;範圍:套件夾有 `.git` 者取 `git ls-files -co --exclude-standard`(= `git add -A` 之範圍,含 `.gitignore` 之全部語意),否則以簡化規則讀 `.gitignore`;文字檔以內容判別,UTF-16 依 BOM 解碼)不含宿主之痕跡:磁碟機絕對路徑(含根目錄之檔;測試之示意路徑 `D:/demo-strategy-lib`、`D:\projHalf` 及其下除外,相似前綴不豁免)、file URL 之本機路徑(含 `file://localhost/`)、POSIX 形式之家目錄路徑、本機家目錄、UNC 分享(JS/JSON 檔只認跳脫形)、內網主機名(`.internal`、`.intranet`、`.corp`、`.lan`、`.ts.net`、`.home.arpa`)、私有網段之 IPv4 位址(RFC 1918、100.64/10、169.254/16;有無埠皆算;無 `v` 前綴之四段版本號無從區分,依原則 3 列出).已知限制:JS 註解或 `String.raw` 內原文兩個反斜線之 UNC、未列舉之內網網域不在涵蓋內.**測試只做通則檢查,不得列出任何使用端名稱**(名單寫進公開庫即是洩漏);使用端之名稱、帳號與單獨之使用者名稱不在測試之涵蓋內,由發布前之外部去識別檢查負責.**使用端之輪次、日期、統計等案情**:註解與測試標題已清除;**執行期字串(任務書、試驗登錄)內者尚未清除**(改動即改變任務書之輸出,列 §3),此部分目前不合本條.禁區字樣中與專案有關者(策略庫所在之資料夾名等)由設定推得(`guardExtraOf`),不寫死於套件.盤點:`npx mocha test/unit-package.test.mjs --grep 宿主` | 全部發布檔;`src/domain/verify.mjs`(`setGuardExtra`、`guardExtraOf`) | `test/unit-package.test.mjs`(檢查本身之正反例與家目錄分支之單獨驗證 + 全檔掃描,並斷言掃描範圍含代表檔、建置產物存在時含之、版控所排除者不含)、`test/unit-guard.test.mjs` |
| R-PKG-7 | 對外介面之 JSDoc:聚合入口 `src/WTradeAdaptivess.mjs` 匯出之每個函數於定義處有 JSDoc(說明、`@param`、`@returns`、`@example`),常數有 `@type` 與一句說明;內容一律以程式碼為準(不寫不存在之參數或欄位),範例之輸出值須實跑核對才寫;`.jsdoc` 實跑無 ERROR.站點全集:聚合入口之 74 鍵(函數 58、常數 16;函數之中 `createAdaptivess` 為 `makeProject` 之別名,定義處 57 個).盤點:`node node_modules/jsdoc/jsdoc.js -c .jsdoc` 之輸出無 ERROR,`docs/global.html` 列有各函數 | `src/**`(聚合入口所列之定義處) | 建置時之 jsdoc;未自動化之內容核對由審查負責 |
| R-PKG-8 | 計時器相關之測試以事件或狀態同步,不以「延時後斷言」:被測函數有計時器者以注入之時間源(`opt.sleep`、`opt.read`、`opt.rand`)驗證;被測函數無計時器者改等可觀察條件(不為測試在 src 加計時器或回調);跨套件規格之 `opt.onTrace` 尚未提供(§3).站點全集(src):`src/arsi/resources.mjs`(`sleep` 預設、背景取樣 `setInterval`)、`src/tools/waitEvent.mjs`(輪詢)、`src/domain/proc.mjs`(子行程逾時);(test):無延時同步之案(`unit-run` 之心跳案以狀態同步;`unit-pickLoader:43` 之 `setTimeout` 為靜態掃描之輸入字串,非計時器).盤點:Grep `setTimeout|setInterval|setImmediate|sleep\(|delay\(` 於 `src`、`test` | `src/arsi/resources.mjs`、`src/tools/waitEvent.mjs`、`src/domain/proc.mjs`、`test/unit-run.test.mjs` | `test/unit-run.test.mjs` |
| R-PKG-6 | 節點 agent 之禁區須涵蓋套件安裝後之配置:迴圈驗證之程式(`<程式夾>/domain/backtest*`、`verify*`;程式夾 = `src`,安裝後為 `node_modules/w-trade-adaptivess/src`)不得讀取;以目錄或萬用字元涵蓋程式夾、其 `domain` 夾或套件夾者列出;指名之其他檔與經進入檔之評估不列.任務書所寫之路徑由 `texts.mjs` 以自身位置推得 | `src/domain/verify.mjs`(`forbiddenPats`、`NODE_CMD_PATS`、`PKG_NAME`)、`src/domain/texts.mjs` | `test/unit-guard.test.mjs` |

## 2. 沿用之規則族(條文在程式註解)

| 族 | 範圍 | 主要位置 | 守門之測試檔 |
|---|---|---|---|
| R-EV | 評估器:訂單帳本與官方回測一致、無前視、`ctx` 各介面、執行規則與分帳、各虛無與對照、歸因、擴充診斷之介面、判讀與階梯 | `src/eval/*`、`src/cli/eval.mjs`、`contract/pick-contract.md` | `unit-evalCore`、`unit-score`、`unit-pickLoader`、`unit-ledgerReal` |
| R-REC | 紀錄與流程:節點文件與做夢文件之規格、任務類型、方向之配比與去重、看板、搜尋地圖、共同儲存區、擴充診斷之看板值 / 子集 / 補算 | `src/arsi/records.mjs`、`src/arsi/arsi.mjs`、`src/domain/domain.mjs`、`src/domain/texts.mjs`、`src/domain/pickStore.mjs` | `unit-records`、`unit-arsi`、`unit-texts`、`unit-claimKey`、`unit-pickStore`、`unit-guard` |
| R-ARM | 臂目錄:節點與做夢提案、主控審定、生效目錄 = 基底 + 擴充(引擎之治理)、前緣改掛 | `src/domain/armCatalog.mjs`、`src/domain/domain.mjs`、`src/tools/armDecide.mjs` | `unit-armCatalog` |
| R-RUN | 執行:每輪節點數與併行、一次跑幾輪、資源閘、單一執行之鎖、事件檔、起跑前之額度檢查、補做夢 | `src/arsi/runner.mjs`、`src/arsi/resources.mjs`、`src/cli/rsi.mjs`、`src/cli/launch.mjs` | `unit-run` |
| R-BT | 禁區與檢定:私有根在專案夾外、檢定工具須授權、agent 操作紀錄之掃描、保留期之數字不入專案 | `src/domain/verify.mjs`、`src/domain/backtest*.mjs`、`src/cli/backtest.mjs` | `unit-guard`、`unit-backtestGrade` |
| R-TB | 共用工具區:由做夢擴建、迴圈只做機械檢查(快照、逐檔檢查與還原、索引一致) | `src/arsi/toolbox.mjs`、`src/domain/toolboxRules.mjs`、`src/cli/toolbox.mjs` | `unit-toolbox` |
| R-MON | 任務書條款之隨機對照、寫法守則(由做夢維護之檔,原文附於任務書) | `src/domain/briefTrials.mjs`、`src/domain/texts.mjs` | `unit-briefTrials`、`unit-guides` |
| R-OPS | 起子行程一律隱藏視窗(R-OPS-1:`spawn`、`spawnSync`、`exec`、`execSync`、`execFile`、`execFileSync`、`fork` 之每一處皆以**該次呼叫之引數之頂層物件**帶 `windowsHide: true`(括號配對取範圍,略過字串與樣板字串;巢狀物件與字串內之字樣不算;字串內組出之呼叫同樣比對);`child_process`(含 `node:child_process`)只以具名且不改名之方式取用,預設匯入、命名空間、改名、重新匯出、動態 `import()`、以變數承接 `require`(含無宣告之賦值)、`require(…)` 後直接取方法者皆不准;已知限制:以字元掃描而非語法樹,區塊註解之記號出現在字串內、描述文字內含呼叫形之字樣時可能誤判;範圍 = `src`、套件根之 `g*.mjs`、`test`;全集 src 10 處、test 3 處);指引文件逾上限自動整理 | 全部起子行程處;`src/domain/archiveDocs.mjs` | `unit-guard`(守門本身之正反例 + 全檔掃描,並斷言代表之呼叫點皆被找到)、`unit-archiveDocs` |
| R-RSI | 引擎只經兩個接縫檔取用 | `src/engineApi.mjs`、`src/engineProtocol.mjs` | `unit-guard` |

## 3. 未完成(預期功能;不是死碼)

- 各規則族之逐條條文尚未整理成本檔之表(目前在程式註解):逐族補入時須去識別(不寫使用端之輪次、節點與數字).
- `tools/fakeRound.mjs` 目前需要專案之真實帳本;改以合成帳本即可成為套件內自足之整合測試.
- 計時器相關函數(R-PKG-8 之 src 三處)之 `opt.onTrace`(跨套件規格〈計時器相關函數之觀察回調與測試〉;須沿用 wsemi `getTrace`,本套件尚未依賴 wsemi).
- 對外函數之參數檢測依跨套件規格〈輸入參數之檢測機制〉(草案)以 wsemi 共用函數宣告種類.
- 執行期字串(任務書、試驗登錄)內之來源專案輪次與數字、寫死之日期(求解窗止日、保留期起日)改為中性寫法或自設定推得(改動即改變任務書之輸出).
- 領域接線之 `sgud/` 假定改為輪末回調,由專案注入.
