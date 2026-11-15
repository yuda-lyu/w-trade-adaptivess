# 狀態(現況)

接續工作先讀本檔;只記現況,不寫過程(過程與教訓在 `sgud/exp/experience.md`).

## 1. 版本與來源

- 版本:`package.json` 為 1.0.0(尚未發布;升版由發布流程處理 —— `script.txt` 之 `addVersion` 列為註解,與 w-recursi、w-trade-strategy 相同).
- 來源:自一個使用端專案之現行程式抽提(Gitea #150,移入類);抽提時之程式與來源逐檔相同,只改下列「2. 抽提時之改動」.
- 依賴:`w-recursi` ^1.0.10(須含治理之修正:停用之臂不擋組裝)、`w-trade-backtest` ^1.1.34.

## 2. 抽提時之改動(相對於來源專案)

| 項 | 內容 |
|---|---|
| 配置 | `lib/` → `src/`;`g_*.mjs` 之本體 → `src/cli/*.mjs`;通用工具 → `src/tools/*.mjs`;套件根留進入檔、參考設定、範例、臂目錄基底、合約(`contract/`) |
| 專案根 | `src/cfg.mjs`:由「以檔案位置推導」改為環境變數 `ARSI_ROOT`(進入檔設定)或工作目錄(R-PKG-3) |
| 專案接入 | 新增 `src/tools/initProject.mjs`(R-PKG-4) |
| 禁區規則 | 策略庫之專案名改由設定推得(`setGuardExtra` / `guardExtraOf`;另收 `settings.guard.forbidden`);迴圈驗證之程式與程式夾之樣式涵蓋 `src` 與安裝後之 `node_modules/w-trade-adaptivess/src`(R-PKG-5、R-PKG-6) |
| 任務書 | 「不得讀取迴圈驗證之原始碼」所寫之路徑改由 `texts.mjs` 以自身位置推得 |
| 輪末摘要 | `src/cli/rsi.mjs` 以套件內之位置起 `roundDigest`(不依賴專案之 `tools/` 進入檔) |
| 臂目錄基底 | `buildCatalog` 移至 `src/tools/`,輸出改以專案根定位;基底之名稱改為中性 |
| 合約 | 屬個別策略庫之數值(標的名、策略數、因子數)改為通用寫法;期間之日期與參考設定一致 |
| 聚合入口與範例 | 新增 `src/WTradeAdaptivess.mjs`、`g.mjs`(合成帳本;離線可跑) |

## 3. 各功能之現況

| 功能 | 現況 | 規則 / 守門 |
|---|---|---|
| 發布面(`package.json`、`.gitignore`、不設 `.npmignore`) | `scripts` 只有 `test`、`deploy`;`main` 指 `dist/w-trade-adaptivess.umd.js`;`npm pack` 內容 = 版控內容 + `dist/`、`docs/`(建置產物);`.gitignore` 另列 `g.mjs` 之暫存夾 `_test_adaptivess`(中途失敗時不入版控與包) | R-PKG-1;`unit-package` |
| 建置(`script.txt` 之 modifyReadme → cleanFolder → jsdoc → gDocsExams → gDistRollup → genDocsDist) | 各步已實跑、皆成功;jsdoc 0 ERROR / 0 WARNING;`toolg/gDocsExams.mjs` 為標準之 `genDocsExams()`(有 `examples/`,複製至 `docs/examples/`);dist 可以 `require` 與 `import` 載入(Node 24),匯出與聚合入口相同,評估結果之選集指紋與 src 相同 | R-PKG-1 |
| dist 之限制 | 以 `import.meta.url` 定位套件檔者(`initProject`、`makeTexts` 之程式夾)於 dist 內以 `dist/` 為準而定位錯誤:經 dist 呼叫 `initProject` 拋 ENOENT;README 註明一律以 ESM 深層路徑取用 | README §Installation |
| 對外介面之 JSDoc | 聚合入口匯出之函數與常數於定義處皆有 JSDoc(`@param` 212、`@example` 62 處) | R-PKG-7 |
| 去識別 | 發布檔(含 dist、docs;有 `.git` 時以 `git ls-files` 取範圍)不含本機路徑(磁碟機、file URL、家目錄、UNC)、內網主機名與私有網段位址(通則檢查,不列使用端名稱);註解內可辨識出處之來源輪次、日期、人名、實測統計已清除(作為預設常數或測試資料之數值保留);**執行期字串內者未清**(§5);已知限制見 R-PKG-5 | R-PKG-5;`unit-package` |
| 子行程隱藏視窗 | src 10 處、test 3 處(全集)皆 `windowsHide: true`;守門以括號配對只看該次呼叫引數之頂層物件(含字串內組出者),`child_process` 只准具名不改名;涵蓋 src、套件根 `g*.mjs`、test;已知限制見 R-OPS-1 | R-OPS-1;`unit-guard` |
| 計時器相關之測試 | 測試皆以注入(`opt.sleep` / `opt.read`)或狀態同步,無「延時後斷言」 | R-PKG-8;`unit-run` |

## 4. 測試

- `npm test`:181 項通過、3 項略過(`unit-ledgerReal`:本機無策略庫與帳本時略過).
- `node g.mjs`:選集指紋 `d5a093f6b1b07a997c90`,`reproducible: true`.
- `initProject` 對空資料夾寫入 27 檔;重跑 0 檔;對套件夾拒絕.
- 未在套件內執行者:`tools/fakeRound.mjs`(假 agent 之整輪回歸;需真實帳本).

## 5. 已知缺口與待辦

- **合成帳本之整輪回歸**:`tools/fakeRound.mjs` 需專案之真實帳本;改以 `test/tools/synthLedger.mjs` 之合成帳本即可成為套件內自足之整合測試(後續).
- **計時器之觀察回調**:`src/arsi/resources.mjs`(資源取樣與資源閘)、`src/tools/waitEvent.mjs`(事件檔輪詢)、`src/domain/proc.mjs`(子行程逾時)尚未提供 `opt.onTrace`;依跨套件規格須沿用 wsemi 之 `getTrace`,而本套件目前未依賴 wsemi(後續;需新增依賴並改 R-PKG-2 與其測試).
- **輸入參數之檢測機制**(跨套件規格,草案):對外函數之參數由各函數自行檢查,未以 wsemi 共用函數宣告種類(後續).
- **領域接線假定專案根有 `sgud/`**:做夢須更新 `sgud/state/state.md`、`sgud/exp/experience.md`(未更新者該輪判為失敗),改進項寫入 `sgud/feedback/feedback.md`,寫法守則讀 `sgud/proc/guide_*.md`;宜改為輪末回調,由專案注入(後續,由使用端另提).
- **執行期字串內之來源專案數值**:任務書與試驗登錄之字串仍含來源專案之輪次與數字(`src/domain/texts.mjs` 做夢任務書之「(r003:…)」、`src/domain/briefTrials.mjs` 之 `metric` / `why` / `closed`),以及寫死之日期(`texts.mjs` 之求解窗止日、`src/domain/pickStore.mjs` 之保留期起日;應自 `settings` 推得).改動即改變任務書之輸出,列後續.
- **`g.mjs` 之暫存夾**:固定為工作目錄下之 `./_test_adaptivess`,啟動與結束時遞迴刪除(與 w-trade-strategy 之 `g.mjs` 同一慣例);工作目錄恰有同名之使用者資料夾時會被刪.改為 `fs.mkdtempSync` 建於系統暫存區、只清自己建立者(後續;README 之範例同步).
- **dist 內以 `import.meta.url` 定位者**:如需 dist 亦可用,改為自模組所在處往上找 `package.json` 之 `name` 為本套件者(後續;目前以 README 限定 ESM 深層路徑).
- 任務書之文字固定為繁體中文,且含交易領域之用語;其他領域須改寫 `src/domain/texts.mjs` 或注入自己之任務書.
- `settings.dispatch.skillsRoot` 之預設為行程使用者之家目錄下之 `.claude/skills`(`os.homedir()` 推得);其他環境請明給或以 `inject.dispatch` 取代.
- 合約由專案維護:升版後須人工比對 `docs/pick-contract.pkg.md` 併入新條文.
- 規則帳本之沿用規則族(R-EV、R-REC 等)之逐條條文仍在程式註解,尚未整理成表.

## 6. 使用端升版時要做的事

1. `npm i w-trade-adaptivess@<新版>`(無輪次執行中;共用同一狀態根之程序須同時升版).
2. `node node_modules/w-trade-adaptivess/src/tools/initProject.mjs --root .`(首次由舊配置改用時加 `--force`,並先備份原有之 `g_*.mjs`、`tools/`).
3. 比對合約之參考版;`npm test`(專案自有之測試)、`node tools/fakeRound.mjs --redream --two`、`node tools/replayCheck.mjs <節點 id…>`(抽樣重放須與正本相同).
