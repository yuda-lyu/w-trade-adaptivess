# 狀態(現況)

接續工作先讀本檔;只記現況,不寫過程(過程與教訓在 `sgud/exp/experience.md`).

## 1. 版本與來源

- 版本:`package.json` 為 1.0.1(已發布;升版由發布流程處理 —— `script.txt` 之 `addVersion` 列為註解,與 w-recursi、w-trade-strategy 相同).Gitea #154 之修正(§3「方向入前緣之去重」「任務書之程式夾」)、Gitea #156 之修正(§3「額度造成之失敗之處置」)、Gitea #157 之使用端接線(同列;額度失敗之錯誤另帶 `transient: true`)已改於工作樹,待發布流程升版.
- 來源:自一個使用端專案之現行程式抽提(Gitea #150,移入類);抽提時之程式與來源逐檔相同,只改下列「2. 抽提時之改動」.
- 依賴:`w-recursi` ^1.0.12(須含治理之修正〔停用之臂不擋組裝;1.0.10 起〕與暫時性失敗之約定〔評估器拋出之值帶 `transient: true` ⇒ 前緣不計 `retries`、另記 `transients`;1.0.12 起,Gitea #157〕)、`w-trade-backtest` ^1.1.35、`wsemi` ^1.9.61(Gitea #156 新增;僅供派工器遮罩錯誤輸出之 `maskDiagText`).
- 額度用盡即止所需:技能根之 `w-dispatch-ai` 須為含「免費池用盡時於數秒內終止並回 `errorType: 'quota'`」之版本(同期於該套件修正,為 1.0.95 起;見 README §4「節點額度用盡時之行為」);較舊之版本下備援用盡時仍空等至逾時(本套件之處置照常:逾時之失敗不標 `quota`).

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
| 子行程隱藏視窗 | src 10 處、test 4 處(全集)皆 `windowsHide: true`;守門以括號配對只看該次呼叫引數之頂層物件(含字串內組出者),`child_process` 只准具名不改名;涵蓋 src、套件根 `g*.mjs`、test;已知限制見 R-OPS-1 | R-OPS-1;`unit-guard` |
| 計時器相關之測試 | 測試皆以注入(`opt.sleep` / `opt.read`)或狀態同步,無「延時後斷言」 | R-PKG-8;`unit-run` |
| 方向入前緣之去重(Gitea #154) | 探索類方向與樹上既有節點同臂同起點 ⇒ 規格另帶區分用之鍵(依據文字之雜湊)後入前緣;同一探索之重提(鍵之規格已有節點;或既有節點本身即出自同一依據)略過;未相撞者規格不變;樹上無同規格之節點而前緣內已有同臂同起點之待執行提案者維持略過;輪末摘要另列「方向未入前緣」各行(首行筆數,其後一條一行:序號、臂、起點、原因;前緣內之同規格已非待執行者註明其狀態);前次方向回顧之範本依方向之類型附識別文字(探索類列依據之開頭);命令列列示分〔鍵〕與〔主張〕 | R-REC-24、R-REC-28;`unit-claimKey`、`unit-texts` |
| 任務書之程式夾(Gitea #154) | 節點與做夢任務書之「不得改」、診斷腳本「不得匯入」、「讀過評估器或迴圈之其他原始碼」所指之夾由 `codeRootRel` 推得(套件夾內為 `src/`,安裝後為 `node_modules/w-trade-adaptivess/src/`),不含 `lib/`;做夢任務書之禁止段補「暫存檔一律放你的工作夾」;探索類去重說明含仍會略過之情形 | R-PKG-6;`unit-texts` |
| 外部序列介面(Gitea #155;選配、純新增) | `buildLedger` 之 `seriesDir` 與 `settings.source.seriesDir`(相對專案根)建入 `ser.f64`、`meta.seriesNames`;`loadLedger` 之 `L.seriesNames` / `L.ser`;`ctx.series(name, nBack = 180)`(決策棒以前、不含決策棒)與凍結之 `ctx.meta.seriesNames`;合約 §3 與 README 已補,含「時間標記 = 棒之開盤時間、值視為於該棒收盤時已得知、較晚得知者由使用端標在其後之棒」;帳本鍵與既有各欄不變、無此欄之帳本結果逐位不變;變異 37 處(含範圍改為含決策棒、僅特定 nBack 時含決策棒)皆被新增測試擋下 | R-EV-34;`unit-evalCore`、`unit-ledgerSeries` |
| 額度造成之失敗之處置(Gitea #156;分工:偵測與終止屬派工套件,本套件只依 `errorType === 'quota'`) | 派工結果帶 `quota`(主模型達門檻或被限流而不派、派工套件回 `quota`;鏈上每一家皆然才標整體,任一家為其他原因者不標);`runNode` 遇 `quota: true` 不重跑驗證、節點文件記 `failed`、呼叫 `onNodeDone`、拋錯帶 `quota`、`transient: true`(Gitea #157;額度造成之失敗為暫時性失敗,引擎前緣結案不計 `retries`、另記 `transients`,連續額度用盡不封存提案;領域之 `evaluate` 不攔截,原錯誤物件直達引擎;`maxTransient` 未接線 = 不設上限)與 `doc`;`checkQuota` 之 `probe`(起跑前與連跑時之每輪檢查給 `true`;主模型全部金鑰達門檻而有備援時以極小提示詞於暫存夾下新建之空夾試一次免費池備援)、`retryAt`(事件 `skipped` 亦帶)、重置時刻讀 `resetsAt`(舊名亦收)、`tools/quota.mjs --probe`;門檻可設定(`settings.rsi.preflight.quotaMaxPercent` 經 `domain.mjs` 傳入 `makeDispatch`;`agents.<role>.quotaMaxPercent` 優先,大於 100 = 不以用量守門);全部 opencode 條目之 stderr 經 wsemi `maskDiagText` 逐列遮罩後寫 `<主檔名>.stderr.log`;未給新參數者行為不變(門檻 95、`checkQuota` 不探測).真實環境(CLI 與免費池已用盡)未於本輪實跑(測試一律以替身) | R-RUN-8;`unit-dispatchQuota`、`unit-arsi`、`unit-quotaCli`、`unit-frontierTransient` |
| 於 npm 包內執行測試 | `unit-package` 於無 `.git` 且無 `.gitignore` 時略過 `.gitignore` 之列項檢查、去識別掃描改以包內全部文字檔為範圍(只略過任一層 `node_modules` 與包根下之測試暫存夾);`npm pack` 解開後跑全套 0 失敗(188 通過、4 略過);有 `.git` 而缺 `.gitignore` 者仍失敗 | R-PKG-1、R-PKG-5;`unit-package` |

## 4. 測試

- `npm test`:249 項通過、3 項略過(`unit-ledgerReal`:本機無策略庫與帳本時略過;含 Gitea #155 新增之 21 項:`unit-evalCore` 4、`unit-ledgerSeries` 17;含 Gitea #156 新增之 34 項:`unit-dispatchQuota` 26、`unit-quotaCli` 6、`unit-arsi` 2;含 Gitea #157 新增之 5 項:`unit-arsi` 1、`unit-frontierTransient` 4).於 npm 包內(`npm pack` 解開、工作目錄為包夾)為 248 通過、4 略過(另略過 `.gitignore` 之列項檢查;依 244 → 249 推算,未於本輪於包內重跑).
- Gitea #156 之變異 57 處(作法見 `sgud/exp/experience.md` 18;涵蓋 R-RUN-8 之①~⑥與 `rsi.mjs` / `quota.mjs` / `domain.mjs` 之各呼叫站點)皆被新增測試擋下(轉紅),基準全綠.
- Gitea #157 之變異 7 處(作法同上,於 `./tmp/` 之複本逐一套用):拿掉 `transient`(= 修前寫法)、`transient` 為字串 `'true'` 或 `false`、`transient` 誤標於「成品無法評估」之錯誤、領域 `evaluate` 重包錯誤(只留訊息;留 `doc` 與 `quota` 而丟 `transient`)——前 6 項各被 `unit-arsi` 或 `unit-frontierTransient` 擋下(轉紅);對照組(重包但保留 `transient`)仍綠,基準 16 項全綠.
- `node g.mjs`:選集指紋 `d5a093f6b1b07a997c90`,`reproducible: true`.
- `initProject` 對空資料夾寫入 27 檔;重跑 0 檔;對套件夾拒絕.
- 未在套件內執行者:`tools/fakeRound.mjs`(假 agent 之整輪回歸;需真實帳本).

## 5. 已知缺口與待辦

- **輪末摘要「方向未入前緣」之呼叫站點**:該行之組句(`unproposedNoteOf`)有單元測試,而輪末鉤子內之呼叫(`afterRound` 之一行)只能由整輪回歸(`tools/fakeRound.mjs --redream --two`;需真實帳本)觸及,套件內尚無對應之整輪測試(併入下一項之合成帳本整輪回歸).
- **方向入前緣與來源方向對應之既有限制**(Gitea #154 外審所見;皆早於該修正,對驗證類與不帶鍵之探索同樣存在,未在該修正內處置):①`directionOf` 取最近一份做夢文件中臂、起點、鍵相符者,不核對該條是否成功入前緣(同一規格後來被略過之重提會成為來源方向)②方向之 `arms` 含重複時,入前緣以去重後之臂,`directionOf` 只排序不去重而對不到來源③命令列 `--mode frontier --close` 未把 `--base` 傳給 `closeFrontier`,且 `--claim` 值格式不合時退化為不篩選鍵④`rearmFrontier` 之目的規格已有 `blocked` 紀錄時不重開⑤改掛後前緣內留下之 `blocked` 舊項找不到來源方向,命令列列示標〔鍵〕而非〔主張〕⑥區分用之鍵與主張鍵同為 8 個十六進位字:不同文字同鍵之機率約 2^-32,且主張文字恰為 `explore|<探索依據>` 時必同鍵(實務上不致發生).
- **同臂同起點之探索「改寫」與「另一種機制」無從由文字分辨**:已相撞而帶鍵者,依據文字不同即為另一個規格(取後者以免靜默漏掉機制);同一方向跨輪改寫依據文字重提,可能多跑一個節點.若須更嚴,宜由做夢明給機制識別,或改為列出供主控裁示(後續,待使用端回報).
- **外部序列之外審所見而未處置者**(Gitea #155 外審;皆非本次引入,待主控裁示):①**挑選函數可覆寫內建 typed array 之 `slice` 而讀得帳本全欄**(`Object.getPrototypeOf(ctx.xxx(…))` 取得共用原型,暫時把 `slice` 換成回傳 `this`;已實測於既有之 `ctx.entryBars`〔回傳含決策棒以後之全部進場棒〕、`ctx.factor`〔全部因子欄〕,新增之 `ctx.series` 同形);`pickLoader` 之字樣檢查只擋 `__proto__`、未擋 `Object.getPrototypeOf`,其檔頭已註明非安全沙箱、審計仍須讀碼;根治需擷取內建方法於載入時(不經可被覆寫之原型)或於隔離之 realm 執行挑選函數 ②帳本之重建為就地逐檔覆寫(非原子):已加「寫出前先移除舊 `meta.json`」使中斷者載入即失敗,但各欄之間仍無整體切換 ③`ctx.meta.ntAll` 於呼叫端未給 `L.ntStatic` 時取帳本全期進場數(命令列路徑皆會給;直接以 API 組評估器而帳本涵蓋訓練期以後者須自行給)④帳本鍵不含外部序列之內容,評估結果未帶序列之快照識別(序列更新後同鍵之結果不可直接比較;是否於 meta 記序列摘要並帶入評估結果,待裁示).
- **外部序列之已知限制**(Gitea #155):①時間標記之誠實性(值得知之時點不晚於所標記之棒之收盤)由使用端負責,評估器無從檢查(合約 §3 明寫)②另建之帳本(保留期等)要評估用到序列之成品,須以各自之序列夾建入同名序列,否則該成品於該帳本上拋錯③`src/cli/build.mjs` 之 `source.libraryRoot` 未經 `P()` 以專案根解析(相對於工作目錄;與 README「設定檔內之相對路徑一律以專案根解析」不一致,專案根即工作目錄時無差別;早於本項,未處置)④序列以時間字串精確對位,異格式之時間對不到棒(建帳本時於記錄提示對不到棒之列數與一個值也對不到者,不拋錯)⑤終點 `endTime` 與 K 線之 `time` 以字串比較(既有之約定):格式不同或不在棒界時,以開盤時間截斷之棒可含收盤晚於終點者(外審所見;合約已註明 `endTime` 須同格式並落在棒界,程式未檢查).
- **合成帳本之整輪回歸**:`tools/fakeRound.mjs` 需專案之真實帳本;改以 `test/tools/synthLedger.mjs` 之合成帳本即可成為套件內自足之整合測試(後續).
- **計時器之觀察回調**:`src/arsi/resources.mjs`(資源取樣與資源閘)、`src/tools/waitEvent.mjs`(事件檔輪詢)、`src/domain/proc.mjs`(子行程逾時)尚未提供 `opt.onTrace`;依跨套件規格須沿用 wsemi 之 `getTrace`(本套件已於 Gitea #156 依賴 wsemi,R-PKG-2 已含;併入後續).
- **輸入參數之檢測機制**(跨套件規格,草案):對外函數之參數由各函數自行檢查,未以 wsemi 共用函數宣告種類(後續;**主控排程第 477 項**之範圍含 Gitea #156 新增之選配參數:`makeDispatch` / `checkQuota` 之 `maxPercent`、`probe`、`probeTimeoutMs`、`inject`,與 `agents.<role>.quotaMaxPercent`;目前非有限數之門檻取 95,`probeTimeoutMs` 原樣交派工套件〔其無效值取其預設 300000〕).
- **額度處置之已知限制**(Gitea #156):①〔已處置:Gitea #157〕引擎(`w-recursi`)原把失敗之節點記一次重試(`cfg.frontier.maxRetries` 預設 2)、連續兩次即封存有效之方向,額度造成之失敗亦被計入;現 `runNode` 於額度分支所拋之錯誤另帶 `transient: true`(w-recursi 1.0.12 之約定),前緣結案不計 `retries`、另記 `transients`,提案維持 `proposed`;`frontier.maxTransient` 未接線(不設上限,額度長期不恢復時提案逐輪重試而不封存,由起跑前之額度檢查擋下起跑)②`rsi.mjs` 之「連續失敗」計數(`trailingFailures`)把額度造成之失敗輪亦計入,達上限後須 `--force`(起跑前之額度檢查會先擋,通常不致連續)③訂閱(`opencode-go`)到頂時之字樣與 CLI 之行為尚無實例;本套件只依派工套件之 `errorType: 'quota'`,不論條目種類;派工套件對訂閱到頂回何種 `errorType` 不在本套件之保證內④`probe` 每次起跑前最多耗一次極小之請求(備援逾 `probeTimeoutMs` 或失敗者不擋);⑤探測之結果不快取:連跑時每輪各探一次⑥`settings.dispatch.envFile` 未經 `P()` 以專案根解析(相對於工作目錄;與 `source.libraryRoot` 同形,早於本項,未處置)⑦`checkQuota` 之備援探測只在主模型為訂閱(`opencode-go`)且全部金鑰達門檻時進行:主模型為免費池或 claude 者(含 claude 角色之 `fallback`)不探測(claude 角色達門檻即擋,不看其備援;早於本項之既有不對稱)⑧備援為不在條目表之 opencode 條目者視為可用(守門不是故障點;派工時該條目失敗為其他原因,不標 `quota`)⑨多把金鑰時,`makeDispatch` 與 `checkQuota` 對「用量查詢失敗之金鑰」(`ok: false`)視為未達門檻而取用(早於本項);列上之視窗只取未達門檻者(或首把達門檻者)⑩做夢(`runDream`)與重做(`domain.mjs` 之 `rework`)遇額度造成之失敗時,派工之 `quota` 旗標未結構化傳遞(錯誤文字含「額度」;節點評估路徑 `runNode` 已處置)⑪連跑時因額度停止之 `run-done` 事件之 `stopped` 為文字,不另帶 `retryAt`(起跑前之 `skipped` 事件帶)⑫重做(rework)之派工因額度而未完成時,節點文件同其他失敗改記 `failed`(前次已驗證之文件被覆寫,樹上之舊節點不變),工作夾內之成品檔可能為重做中途之半成品(既有行為;`quota` 與否皆同).
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
