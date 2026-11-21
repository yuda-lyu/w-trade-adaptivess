# 處理要點

## 1. 改動本套件

- 一切改動先看規則帳本(`sgud/rule/rulebook.md`):列為規則者(含未完成)是預期功能.
- 改評估器(`src/eval/*`、`src/cli/eval.mjs`)須「只增」:既有欄位、`S`、階梯與 `selHash` 不得因新增功能而變;每項新增附①單元測試(含變異:把新邏輯改壞,測試須失敗)②以真實成品抽樣重放,結果與正本相同.
- 改迴圈之流程(`src/arsi/*`、`src/domain/*`、`src/cli/rsi.mjs`)後,於有真實帳本之專案跑 `node tools/fakeRound.mjs --redream --two`(假 agent;不耗模型額度;離開碼 0;「擴充診斷之補算」之「真實診斷」一項只在共用工具區無該診斷之檔、或第一個節點無其值時略過〔輸出標 `skipped` 與原因,不計失敗,仍離開碼 0〕;該節點之值為錯誤或非 `undefined` 之假值、或補算失敗者仍離開碼 15).
- 改建帳本(`src/eval/ledgerBuild.mjs`、`src/cli/build.mjs`、`src/cli/backtest.mjs`)或假輪次(`src/tools/fakeRound.mjs`)後,另以 `node test/tools/mutateStart.mjs`(帳本起點、一致性核對下界、回測期旗標之起點核對與假輪次補算之變異;**不得有非預期存活**:被殺者之外,只有「語意等價」〔改了寫法而可觀察之行為不變,附理由〕與「已知存活」〔須對產品碼注入測試掛鉤才打得到,套件不為此開掛鉤,附理由〕兩類可存活,皆標於工具之變異表內)與 `test/unit-barHours.test.mjs`、`test/unit-ledgerStart.test.mjs`、`test/unit-fakeRound.test.mjs` 核對;新增之選項須於未給時與發布版逐位相同(以釘死之指紋守住,見 R-EV-45 ①).
- **釘死指紋之重取程序**(`test/unit-ledgerStart.test.mjs` 之 `PIN`、`PIN_Q`):本套件不存舊碼之夾具,釘死值轉紅時(多為相依之 `w-trade-backtest` 升版)**先辨明是 `w-trade-backtest` 等相依之行為變更,還是本套件之回歸**,不得未辨明即更新值(釘死值正是要讓相依之行為變更〔其 `genKLinesTpSl` / `settleOrderPnl` / `calcBaseUnitQuantity` 之輸出不同〕改變帳本鍵與評估紀錄時被察覺;舊碼之夾具反使相依之變更兩邊同變而不被察覺).辨明之作法:①以 1.0.30 之發布包(`npm pack w-trade-adaptivess@1.0.30`;未含 `startTime`)之 `src/eval/ledgerBuild.mjs`,於同一份合成資料(建法見測試 ① 與 ① 之二)與新相依建一次,取其指紋與帳本鍵;②與現行碼於同一份資料與新相依之輸出相同 ⇒ 差異來自相依(更新 `PIN`、`PIN_Q` 為 ① 之值,並於 `sgud/state/state.md` 記錄相依之版本與行為變更);不同 ⇒ 本套件之回歸(修碼,不改值).不得未經 ① 之比對而直接取現行碼之輸出重取(那等於讓守門恆綠).
- 通用層 `src/arsi/` 不得匯入 `src/domain/`、`src/eval/`,不得含交易領域之用語(守門:`test/unit-guard.test.mjs`).
- 起子行程一律 `windowsHide: true`.
- 專案之路徑一律由 `src/cfg.mjs` 之 `FD_ROOT` / `P()` 展開;只有「定位套件自己之檔」才用 `import.meta.url`.
- 新增或改動會寫專案之檔或起行程之命令列程式、工具或其模式時,同時更新 `src/domain/agentEntries.mjs` 之 `ENTRY_RULES`(判定須與該入口之實際解析一致)並於其開頭(讀設定之前)呼叫 `guardEntry`(R-RUN-11);操作掃描之「執行迴圈之寫檔入口」(R-BT-7)取同一張表.`unit-agentGuard` 之接線案核對表與入口一致.
- 在 `src/domain/` 新增**迴圈驗證之判定檔**(判定、門檻、操作掃描之判法等不該讓節點讀到者)時,**檔名以 `verify` 起首**(`backtest` 起首亦可):節點之禁區字樣只涵蓋 `src/domain/verify*`、`src/domain/backtest*`(R-BT-10);非此起首之檔,節點讀之不被列(例:改名前之 `cmdScan.mjs`).節點任務書「不得讀取迴圈驗證之原始碼」一句所列之檔名樣式與禁區字樣同步(守門:`unit-verifyZone`).
- 操作掃描之「可讀之他節點工作夾」(`allowWork`)只經 `src/domain/verify.mjs` 之 `allowWorkOf`(迴圈驗證、`rescanTraces`、`tools/scanCheck.mjs` 共用;R-BT-9),不在呼叫端另算;改其內容後三處之判定一併改(`unit-scanAllowWork` 之 scanCheck 與重掃同組之案守).
- 改操作掃描之指令解析(`src/domain/verifyCmdScan.mjs`:`stripSearchPatterns`、`listRootExempt`、`entryExecOf`、`recursiveRootOf`、`toolListsRoot`、`scriptListsRoot`;規則 R-BT-6、R-BT-7、R-BT-8)之判定前,保存改前之函數(`git archive` 之舊版或複本於 `./tmp/`),改後以差異比對證明「除該次明定之修正外 0 差異」並植入會改變判定之變異證明比對有鑑別力(作法見 `sgud/exp/experience.md` 第 45 條);只搬移或重構者須 0 差異.引號遮蔽只經 `maskQuotes` / `unmaskQuotes`(守門:`unit-cmdScan` ③);解析函數不加入聚合入口.

## 2. 三層之分工(使用端)

| 層 | 做什麼 | 不做什麼 |
|---|---|---|
| 節點 | 依任務書探索或驗證一個方向;交出挑選模組與節點文件 | 不讀迴圈驗證之程式、他節點之工作夾、帳本與策略庫 |
| 做夢 | 審計本輪全部節點(可信 / 部分可信 / 不可信;重做或刪除)、彙整、定下一輪之方向、擴建共用工具、提改進項與臂之提案 | 不改迴圈之程式與評估器 |
| 主控 | 審臂目錄之提案、處置「須改迴圈 / 評估器」之改進項、啟動各輪、(選配)以保留期檢定並只回饋正負號 | 不代寫共用工具、不代做節點與做夢之判讀 |

## 3. 主控每輪之順序(建議)

1. 讀 `rsi/rounds/rNNN/DIGEST.md`.
2. `node tools/armDecide.mjs` 審提案;通過後 `node g_rsi.mjs --mode board`.
3. 處置做夢之改進項(先分類:迴圈架構 / 做夢原則 / 節點原則 / 共用工具 / 績效判準 / 量尺);評估器只增.
4. `npm test`(改了程式則另跑假輪次與抽樣重放)→ `node g_rsi.mjs --mode dry` → `node g_launch.mjs round -- g_rsi.mjs --mode round`.

輪次進行中不改程式、設定與臂目錄;共用同一狀態根之程序不混用不同版本之引擎.

## 4. 擴充診斷之補算

共用工具區新增或改寫擴充診斷後,既有節點要到下一次完整評估才有其值.要補上:`node g_rsi.mjs --mode extfill --ext <診斷名>`(以現行評估器重放各成品,選集指紋與正本相同才併入,只併入該診斷之輸出).所補之診斷不使用虛無時可加 `--null 1` 省時間.

## 5. 回報問題或需求

本套件之缺陷與擴充需求走自有套件之通報流程;通報時附:版本基準(安裝版與最新版)、只用公開介面之最小重現、擬定之修改版(於套件之複本上改好並自測)與測試.

## 6. 改設定之取值、任務書與合約之文字、評估器之指紋(Gitea #184 起)

- **影響評估之數字**(`warmupDays`、`cadenceDays`、`nullDraws`、`actBins`、`sideActHalf`)之取值與檢測只經 `src/eval/cfgNum.mjs` 之 `EVAL_NUMS` / `evalCfgNumsOf`(評估器經 `barGrid.mjs` 之 `evalNumsOf` 另檢「日數 × 每日棒數須為整數」);新增同類之鍵先加入 `EVAL_NUMS`(預設與種類),不另寫取值.值域依評估器內部之實際用法定(讀碼,例:型別陣列之容量),不憑直覺.
- **文字不寫死策略庫之事實**:任務書(`texts.mjs`)與合約之參考版(`initProject.mjs` 之 `CONTRACT_FACTS`)內凡屬設定之值一律取自設定(寫法在 `factsText.mjs`);新增或改動合約之句子後,以 `test/unit-factsResidue.test.mjs` 之殘留掃描核對(新寫法須補 `PHRASES`);錨點表之次序:相位數三錨點在最前,其後之錨點之原文不含「七相位」;設定等於參考值時輸出須與原文逐字相同.
- **評估器之指紋**:只排除 `src/eval/ledgerBuild.mjs`(`fillKeys.mjs` 之 `EVAL_FP_SKIP`);新增 `src/eval/` 之檔預設計入;要排除其他檔須先證明評估器之匯入鏈不含它(`unit-evalFingerprint`).
- **變異檢查**:改了上列任一處後 `node test/tools/mutateBar.mjs`(測試一律經安靜執行器加 `--lock` 執行;每項植入於 `test/_tmp/` 之複本;先跑無變異之對照須全綠 —— 對照 = 守門之測試(`GUARDS`)全綠〔失敗即中止〕+ 所選變異之優先測試(第 4 欄;不在 `GUARDS` 內者各單獨跑一次):優先測試於對照即失敗者(複本內與變異無關之失敗,例:`unit-guard` 之子行程隱藏視窗一案要掃 `test/unit-package.test.mjs`,複本不含該檔而失敗〔實測:「應掃到至少 2 處呼叫, 實得 0」〕),其變異記為 `UNDECIDABLE`(無法判定;不植入、不記為被殺,離開碼 1),`--control-only` 只跑對照並列出所選變異中屬此類者;須全數被殺,等價變異(第 5 欄 `equiv`,各附不可觀察之理由)V02、V13、K07、F04、F05、I14、R11 共 7 項;`--only <編號>`、`--check` 可局部或只核對錨點;新增之守門須同時補變異;優先測試選對照即全綠者,不選於複本內另有失敗之檔).
- **新舊版對拍**(升版前):1.0.26 或前一版以 `git archive` 解到 `./tmp/`,同一夾具之設定取套件之參考設定,比對帳本(含 `meta.json`,去 `builtAt`)、`g_eval.mjs`(quick / full / train / postfit / member / `--null` / `--phases`)、`g_backtest.mjs`、任務書、看板與共同儲存區、`initProject`、`fakeRound`、`node g.mjs`;雜訊之正規化見經驗 40 ⑦.
