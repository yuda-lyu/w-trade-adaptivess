# w-trade-adaptivess
A framework for searching adaptive strategy-picking policies over a quantitative-trading strategy library: a no-lookahead evaluator (pick contract, order ledger, nulls and diagnostics), agentic nodes that write picking modules, an agentic dream that audits and synthesizes, and a controller layer, all running on the recursive search engine w-recursi.

![language](https://img.shields.io/badge/language-JavaScript-orange.svg)
[![npm version](http://img.shields.io/npm/v/w-trade-adaptivess.svg?style=flat)](https://npmjs.org/package/w-trade-adaptivess)
[![license](https://img.shields.io/npm/l/w-trade-adaptivess.svg?style=flat)](https://npmjs.org/package/w-trade-adaptivess)
[![npm download](https://img.shields.io/npm/dt/w-trade-adaptivess.svg)](https://npmjs.org/package/w-trade-adaptivess)
[![npm download](https://img.shields.io/npm/dm/w-trade-adaptivess.svg)](https://npmjs.org/package/w-trade-adaptivess)
[![jsdelivr download](https://img.shields.io/jsdelivr/npm/hm/w-trade-adaptivess.svg)](https://www.jsdelivr.com/package/npm/w-trade-adaptivess)

## Documentation
To view documentation or get support, visit [docs](https://yuda-lyu.github.io/w-trade-adaptivess/global.html).

## Installation

### Using npm(ES6 module):
```alias
npm i w-trade-adaptivess
```
依賴:`w-recursi`(遞迴搜尋引擎)、`w-trade-backtest`(建訂單帳本時之官方回測)、`wsemi`(共用函數;派工之錯誤輸出留存時之遮罩).原始碼為 ES module,**請以 ESM 深層路徑取用**(`w-trade-adaptivess/src/WTradeAdaptivess.mjs`;套件不設 `exports`).派發 agent 之套件 `w-dispatch-ai` 不列為依賴,由設定之 `dispatch.skillsRoot` 指到其所在處(或以 `inject.dispatch` 換成自己的派工方式;見 §7).

`package.json` 之 `main` 依自有套件之慣例指向打包檔 `dist/w-trade-adaptivess.umd.js`(只含聚合入口;命令列程式與工具不在其內).打包檔之限制:以 `import.meta.url` 定位套件自己之檔者於打包檔內會以 `dist/` 為準而定位錯誤 —— 經打包檔呼叫 `initProject` 會找不到套件之 `src/tools`(拋錯),`makeTexts` 寫入任務書之「迴圈驗證之程式夾」會指向 `dist`.這兩者與命令列程式一律經 ESM 深層路徑(或 `initProject` 所產生之進入檔)使用.

#### Example:
> **Link:** [[dev source code](https://github.com/yuda-lyu/w-trade-adaptivess/blob/master/g.mjs)]
```alias
import fs from 'fs'
import WTradeAdaptivess from './src/WTradeAdaptivess.mjs'
import { writeSynthLedger } from './test/tools/synthLedger.mjs'


let { loadLedger, ntStaticOf, makeEvaluator, loadPick } = WTradeAdaptivess


let test = async () => {
    let ms = []

    //root, 範例之工作夾(離線可跑): 以合成之訂單帳本示範評估器; 實務上帳本由策略庫建置(node g_build.mjs; 設定見 settings.json 之 source)
    let root = './_test_adaptivess'
    fs.rmSync(root, { recursive: true, force: true })
    let info = writeSynthLedger(`${root}/ledger`, { n: 60, nBars: 2400, seed: 1 })
    ms.push({ ledger: { nStrategies: info.n, nBars: info.nBars, nOrders: info.nOrders } })

    //L, ev: 讀帳本並建評估器(暖機 60 日後每 7 日決策一次; 每次決策只看得到決策棒以前之資訊)
    //  訓練期之界線須明給(ctx.meta.ntAll 只計訓練期之進場數): 此帳本全為訓練期, 給 L.nBars; 帳本涵蓋訓練期以後者給訓練期之終點棒序
    let L = loadLedger(`${root}/ledger`)
    L.ntStatic = ntStaticOf(L, L.nBars)
    let ev = makeEvaluator(L, { warmupDays: 60, cadenceDays: 7 })

    //pk: 挑選模組(依合約 contract/pick-contract.md 撰寫之檔: 預設匯出 pick(ctx), 選配匯出 accept(sig, book)); 節點 agent 所寫者即此形式
    let pk = await loadPick('./examples/pick_example.mjs')

    //m: 評估結果(相位 0 與 3、3 / 7 日新鮮度、同劑量虛無 16 抽); selHash 為選集與下單序列之指紋, 同一模組重跑必相同
    let m = ev.evalPolicy(pk.pick, { accept: pk.accept, phases: [0, 3], horizons: [3, 7], nullDraws: 16, seed: 11 })
    ms.push({
        eqYr: m.op.eqYr.mean,
        worstPhase: m.op.eqYr.min,
        monthlyOrders: m.op.monthlyOrders.mean,
        peakHold: m.op.peakHold.max,
        nullExcess: m.null.excess,
        nullP: m.null.p,
        byGroup: m.op.byGroup,
        selHash: m.selHash,
    })

    //同一模組重跑: 指紋相同
    let m2 = ev.evalPolicy(pk.pick, { accept: pk.accept, phases: [0, 3], horizons: [3, 7], nullDraws: 16, seed: 11 })
    ms.push({ reproducible: m2.selHash === m.selHash })

    fs.rmSync(root, { recursive: true, force: true })

    console.log(JSON.stringify(ms, null, 1))
    return ms
}
await test()
    .catch((err) => {
        console.log(err)
    })

//node g.mjs
```

## 1. 定位

對一個已建好之**策略庫**(數萬隻單一策略;例如以 `w-trade-strategy` 建置者),探尋「**自適應挑選策略**」:每個決策日只憑過去之資訊,自策略庫挑出一組策略去下單,使評估期(回測期)之等效年化報酬穩定為正.本套件提供三樣東西:

| 部分 | 位置 | 做什麼 |
|---|---|---|
| 評估器 | `src/eval/` | 把策略庫轉成「訂單帳本」;以**無前視**之方式評估一個挑選模組(等效年化、新鮮度、同劑量 / 同活躍度 / 同側同活躍度等虛無、損益歸因、擴充診斷);可單獨使用 |
| 代理式迴圈之通用層 | `src/arsi/` | 節點(agent 依任務書寫挑選模組)→ 迴圈重跑驗證 → 節點文件;做夢(agent 審計、彙整、定方向)→ 做夢文件;派工、紀錄、共用工具區、資源閘、單一執行之鎖與事件檔.不含交易領域之用語,以依賴注入接領域 |
| 領域接線 | `src/domain/` | 把上兩者接到 `w-recursi` 之樹、臂目錄與治理:任務書、驗證與操作掃描、看板、搜尋地圖、共同儲存區、全樹重算與補算 |

三層分工:**節點**(探索或驗證一個方向,交出挑選模組與節點文件)、**做夢**(每輪審計全部節點、歸納、定下一輪之方向、擴建共用工具)、**主控**(人或另一個 agent:審臂目錄之提案、處置結構性之改進、啟動各輪).

## 2. 專案接入

套件之程式不放專案之資料;一個專案 = 專案根之設定、進入檔與狀態:

```alias
npm i w-trade-adaptivess
node node_modules/w-trade-adaptivess/src/tools/initProject.mjs --root .
```

`initProject` 產生(升版後重新執行即更新):

- 進入檔 `g_eval.mjs`、`g_rsi.mjs`、`g_build.mjs`、`g_launch.mjs`、`g_toolbox.mjs`、`g_backtest.mjs` 與 `tools/<名>.mjs`:各只做兩件事 —— 把**專案根**(進入檔所在之資料夾)寫入環境變數 `ARSI_ROOT`,再載入套件之對應程式.已存在而非本工具所產生之同名檔不覆寫(確認可捨棄後加 `--force`).
- `examples/pick_example.mjs`(範例挑選模組).
- 只在不存在時才寫:`settings.json`(參考設定)、`arms/base.json`(臂目錄之基底,74 臂)、`docs/pick-contract.md`(挑選模組之合約;含專案自己之數值,由專案維護 —— 與套件之參考版不同時不覆寫,另寫 `docs/pick-contract.pkg.md` 供比對).

**專案根之決定**:環境變數 `ARSI_ROOT`(進入檔設定;其子行程繼承),未設時為行程之工作目錄;不以套件檔之位置推導.設定檔內之相對路徑一律以專案根解析.

`settings.json` 之主要欄:`source`(策略庫位置、K 線之鍵、每根小時數;選配之 `seriesDir` = 外部序列之資料夾,相對專案根,見 §3)、`periods`(訓練期 / 回測期 / 保留期之起點)、`eval`(帳本夾、暖機日數、決策間隔、相位、新鮮度地平線、虛無抽數、硬上限)、`score`(階梯門檻)、`rsi`(狀態根、每輪節點數、併行數、一次跑幾輪)、`records`(節點文件 / 做夢文件 / 工作夾 / 共用工具區之路徑)、`agents`(節點與做夢各用哪個 agent 與模型)、`dispatch`(派工套件之位置、金鑰之 `.env`)、`resources`(全機 CPU / 記憶體上限)、`guard.forbidden`(選配;專案另加之禁區字樣 `[{ pattern, label }]`).

## 3. 評估器與挑選模組之合約

- 建帳本:`node g_build.mjs`(由 `source.libraryRoot` 之策略庫與 K 線,產生各策略之進出場與每單位損益;止於回測期終點).
- 外部序列(選配):策略庫以外、屬標的自身之序列,由專案備成與因子檔同格式之檔 `<名>.json` = `[{ time, value }]`(`time` 為 K 棒之開盤時間,與 K 線同一字串格式;缺值之棒不列),置於 `settings.source.seriesDir`;建帳本時對位到 K 棒並於帳本終點截斷(`ser.f64`、`meta.seriesNames`),挑選函數以 `ctx.series(name, nBack)` 取決策棒以前之值(不含決策棒).序列之值視為於其標記之棒收盤時已得知,得知較晚者須由使用端標在其後之棒(見合約).名稱限英文字母起首之英數與底線(至多 32 字);檔名以底線起首者略過.未設定者不建入,既有結果不變(帳本鍵不因此改變).
- 評估:`node g_eval.mjs --pick <模組.mjs> --mode quick|full [--out <結果.json>]`.挑選函數自帳本起點連續執行,只有落在評估期之決策計入績效.
- 直接以 API 單獨使用評估器(`makeEvaluator(L, cfg)`):須明給訓練期之界線 —— `L.ntStatic = ntStaticOf(L, 訓練期之終點棒序)`(**評估帳本涵蓋訓練期與回測期,界線為訓練期之終點棒序〔依帳本之 `time0` 與每棒小時數自 `settings.periods.train.end` 換算〕,不可給 `L.nBars`**;只有全為訓練期之帳本〔如 `g.mjs` 之合成帳本〕才給 `ntStaticOf(L, L.nBars)`),`ctx.meta.ntAll` 只計訓練期之進場數;未給(或型態、長度不合)者拋 `invalid L.ntStatic: must be …`,**不回退為帳本全期之進場數**(帳本涵蓋訓練期以後者,回退會把其後之資訊帶進該欄).命令列(`g_eval.mjs`、`g_backtest.mjs`)自設定之訓練期終點給界線,行為不變.`loadLedger` 對 K 線欄 `px.f64`(有此檔者)核對長度 = 5 × K 棒數,不符拋 `invalid px.f64: must be …(請重建帳本)`(舊帳本無此檔者 `px` 為 null,取用 `ctx.market` 時拋「帳本無 K 線欄」).
- 挑選模組之形狀、`ctx` 之每個介面(`stat`、`orders`、`entryDays` / `entryBars`、`exitDays` / `exitBars`、`market`、`factor`、`series`、`meta`、`state`、`rand`)、`accept(sig, book)`、分帳、輸出之讀法與擴充診斷之寫法,全部寫在合約 `contract/pick-contract.md`(專案內為 `docs/pick-contract.md`).
- 判讀:`S = 0.7 × 七相位平均 + 0.3 × 最差相位`;階梯 1 ~ 3 與否決見 `src/eval/score.mjs` 檔頭.
- 擴充診斷:共用工具區 `metrics/*.mjs` 每次完整評估自動載入;可自帶看板值(`board`)、提示(`flag`)、「不計為挑選內容」(`notContent`)與量尺之子集(`subset`).診斷可用 `api.market(bar, nBack)`、`api.factor(ki, bar, nBack)`、`api.series(name, bar, nBack)` 取某棒以前之 K 線、因子、外部序列之值(與 `ctx` 之同名介面於決策棒 `bar` 之取值逐位相同),依各決策當時之狀態把成品之選集分組後以 `api.simulate` 重放;為某次決策分組時 `bar` 須用該決策自己之決策棒或更早者(不以程式強制,見合約 §7).`api.replaceNull` 可只替換一部分之席:`onlyGroups`(只換所列子帳之席,其餘原樣)、`onlyDecisions`(只換遮罩內之決策之席,遮罩外之決策給空選集;配對之成品值為「成品只留遮罩內決策」之重放),給任一者時另回 `applicable`、`obs`、`obsPnl`、`pnlMean`、`pnlSd`(成品未分帳而給 `onlyGroups` 者只回 `applicable: false` 與 `reason`;各遮罩為獨立重放,損益與等效年化皆不保證可跨遮罩相加);皆未給時回傳不變(見合約 §7).
- 評估器之狀態不受模組之寫入影響(挑選模組、擴充診斷模組與評估器同在一個 JavaScript realm;合約 §1):
  - 資料不共用:交給模組之物件一律為複本或凍結 / 封裝之物件(`ctx.meta` 每次執行一份、`ctx.prev` 為複本、`accept` 之 `sig` / `book` 每次呼叫前重寫、擴充診斷之 `api` 每個診斷一份,其九個函數〔`simulate`、`summarize`、`replaceNull`、`sideGroups`、`geoGroups`、`rand`、`market`、`factor`、`series`〕之函數物件亦每個診斷各一份並凍結);`tag` 只收可結構化複製之資料,於 `pick` 回傳時取快照並凍結;`ctx` 之函數只在該次 `pick` 呼叫內有效.
  - 內建物件之完整性:評估器只用載入時擷取之內建方法(`src/eval/intrinsics.mjs`);載入模組後、評估器各方法與 `loadLedger` 之入口、每次 `pick` 後、每批 `accept` 後、每個擴充診斷後、讀帳本前與輸出前比對受保護之內建物件,被改即評估失敗(錯誤 code `EVAL_INTEGRITY`,列出被改之項目;`g_eval.mjs` 印 `ERROR EVAL_INTEGRITY …`、離開碼 3,`--ext-test` 印 `EXT_FAIL`、離開碼 4).
  - 仍只靠合約與審計者:模組層變數跨相位 / 跨模擬保存、檔案與行程介面之取用(靜態檢查為字樣層級之防呆)、受保護清單以外之內建物件;不另隔離 realm.
  - 成本:每次比對約 80 µs(約 1000 個屬性描述);一次完整評估約一萬次比對(每批 `accept` 呼叫一次);合成帳本之實測耗時增加約兩成至三成,大半在逐訊號迴圈之交出物件重寫與擷取函數之呼叫,比對本身約占 1 ~ 2%(見 `sgud/state/state.md`).

## 4. 迴圈

- 起跑一輪(脫離式;人、agent、作業系統之排程器皆用同一道指令):`node g_launch.mjs round -- g_rsi.mjs --mode round`;先看計畫:`node g_rsi.mjs --mode dry`.
- 等待結束:`node tools/waitEvent.mjs --since <起跑之 UTC 時刻>`;事件檔 `rsi/logs/events.jsonl`;輪末一頁摘要 `rsi/rounds/rNNN/DIGEST.md`.
- 節點與做夢各依任務書工作;交付之文件有固定規格(`arsi.node/3`、`arsi.dream/3`;見 `src/arsi/records.mjs` 檔頭),由迴圈檢核、渲染與存檔.
- 迴圈對每個節點之成品**重跑**取得正本數字(另換亂數種子與同分次序重放),並掃描 agent 之操作紀錄(禁區、工作夾外之寫入、評估次數).
- 主控之工具:`node tools/armDecide.mjs`(審臂目錄之提案)、`node g_rsi.mjs --mode frontier|board|annotate|reverify|extfill`、`node tools/quota.mjs`、`node tools/replayCheck.mjs`、`node tools/fakeRound.mjs`(以假 agent 走完整一輪,不耗模型額度;改流程後之回歸).
- 節點額度用盡時之行為:主模型(`opencode-go` 之條目)用量達門檻(預設 95)時派工改用 `fallback`.備援為 opencode 之免費池者,用量用盡時 CLI 不會自行結束;偵測與終止由派工套件 `w-dispatch-ai` 負責(其結果 `errorType` 為 `quota`,數秒內回),本套件依此欄判定 —— 派工結果帶 `quota: true`(鏈上每一家皆因額度而未完成,含主模型因用量達門檻而不派;任一家為其他原因之失敗者不標),節點記為失敗且**不重跑驗證、不以半成品入樹**,提案留在前緣待日後重試.額度造成之失敗為暫時性失敗:節點拋出之錯誤另帶 `transient: true`,引擎 `w-recursi`(1.0.12 起)據此於前緣結案時**不消耗重試次數 `retries`**、另記 `transients`,故連續多輪額度用盡不會把該提案封存(其他原因之失敗照舊計 `retries`).引擎之 `frontier.maxTransient`(暫時性失敗之累計上限;預設不設)目前未開放於專案設定,即不設上限.起跑前與連跑時之額度檢查會實際試一次備援,備援亦因額度而不可用即不啟動(離開碼 3;事件 `skipped`,`reason: quota`,帶 `retryAt` = 達門檻之視窗全部重置之時刻);`node tools/quota.mjs --probe` 可先行試算(未給 `--probe` 只看用量、不探測).門檻取 `settings.rsi.preflight.quotaMaxPercent`,各角色另可設 `agents.<role>.quotaMaxPercent`(優先;派工與起跑前之檢查同一個值;大於 100 = 不以用量守門,用到訂閱實際用盡為止,被限流者仍不派).每次 opencode 派工之錯誤輸出(stderr;已經 wsemi 之共用遮罩遮去本次讀到之金鑰)附寫於派工紀錄檔同夾之 `<主檔名>.stderr.log`.額度用盡即止需 `dispatch.skillsRoot` 之 `w-dispatch-ai` 為含此修正之版本(1.0.95 起;技能根經 AI 設定庫更新後取得);較舊之版本下備援用盡時仍會空等至逾時.
- 專案自有之收尾(例如更新專案之指引文件)以輪末回調與事件提供,不寫死在通用層.

## 5. 依賴注入

`makeProject(st, inject)`:`inject.dispatch`(換掉派工器;測試以假 agent 注入)、`inject.catalogFile`.通用層 `createArsi({ records, texts, dispatch, verify, … })` 之每一件皆由外部給定:紀錄之路徑與儲存(`createFileRecords` 或自備同介面之物件)、任務書文字、驗證函數、共用工具區之規則.

## 6. 測試

```alias
npm test
```

| 測試檔 | 案例數 | 範圍 |
|---|---|---|
| `unit-evalCore.test.mjs` | 37 | 評估核心:無前視、執行規則、各虛無、歸因、擴充診斷之介面 |
| `unit-evalIntegrity.test.mjs` | 41 | 評估器之狀態不受模組之寫入影響:交出之物件為複本或凍結(改寫 `ctx.prev` / `ctx.meta` / `book` / `tag` 結果不變)、內建物件被改即 `EVAL_INTEGRITY`(挑選函數、`accept`、擴充診斷、模組頂層與延後執行之程式、延遲讀取帳本欄)、ctx 之各函數與逐訊號模擬不經可被改寫之方法;擴充診斷之資料存取(`api.market` / `factor` / `series`)與 `simulate` 等需比對之 api 函數同樣於入口比對(含 `api.replaceNull` 之 `onlyGroups` / `onlyDecisions`);含命令列之載入處 |
| `unit-extData.test.mjs` | 14 | 擴充診斷之資料存取:`api.market` / `api.factor` / `api.series` 之取值與 `ctx` 之同名介面逐位相同、只含棒序 < `bar` 者、`nBack` 之各種寫法、`bar` / `ki` / `name` 之檢查與訊息(不帶輸入值)、帳本缺欄、回傳為複本、api 九個函數之函數物件凍結且每個診斷各一份、不改既有數字、依狀態分組重放之用法 |
| `unit-extReplacePart.test.mjs` | 18 | 擴充診斷之 `api.replaceNull` 只替換一部分之席(`onlyGroups`、`onlyDecisions`):皆未給時回傳不變、「全部」時與未給 / 只給另一個逐位相同、逐席核對(dense 帳本,由訊號還原各抽之選集:未列子帳之席原樣、席數與子帳不變、替換者不重複)、遮罩外之決策無訊號且配對之成品值 = 成品只留遮罩內決策之重放、獨立重算(各抽之選集交 `simulate` 重放,核對均 / 標準差 / p / z / excess / 損益 / 三等分段)、未分帳 ⇒ 不適用、參數之檢查與訊息(V19;不帶輸入值)、形狀以內部槽判定而不經迭代器、重入、不改既有數字與 `selHash` |
| `unit-guard.test.mjs` | 31 | 架構邊界(含子行程隱藏視窗之守門與其自驗);agent 操作紀錄之掃描與禁區 |
| `unit-run.test.mjs` | 18 | 執行規模、資源閘、單一執行之鎖、事件檔 |
| `unit-records.test.mjs` | 16 | 節點文件與做夢文件之規格、檢核、渲染 |
| `unit-texts.test.mjs` | 12 | 任務書文字(含「不得改」之程式夾由所在推得、探索類方向之去重說明、前次方向回顧之範本) |
| `unit-armCatalog.test.mjs` | 10 | 臂目錄之提案、審定與生效目錄 |
| `unit-backtestGrade.test.mjs` | 10 | 檢定旗標之分級 |
| `unit-score.test.mjs` | 10 | S、階梯與否決 |
| `unit-arsi.test.mjs` | 12 | 通用流程(派工、驗證、任務書皆以假件注入;含額度用盡而未完成之節點不重跑驗證、不入樹,其錯誤帶 `quota` 與 `transient`,額度以外之失敗不帶) |
| `unit-frontierTransient.test.mjs` | 4 | 額度失敗不消耗前緣重試之接縫:真 `w-recursi` + 真領域,只把派工換成假的;額度用盡 ⇒ 前緣提案維持 `proposed`、`retries` 不增、`transients` 逐輪加一,一般失敗照舊計 `retries` 至封存 |
| `unit-dispatchQuota.test.mjs` | 26 | 派工之額度處置(派工套件以替身注入):結果帶 `quota`、用量門檻(全域與各角色)、錯誤輸出留存與遮罩、起跑前之備援探測與 `retryAt` |
| `unit-quotaCli.test.mjs` | 6 | 額度處置之接線:以命令列程式於合成專案根實跑(替身派工套件),驗起跑前與連跑時之探測、事件 `skipped` 之 `retryAt`、門檻經領域層傳到派工器、`tools/quota.mjs --probe` |
| `unit-package.test.mjs` | 11 | 發布面、依賴、專案根之錨點、`initProject`、去識別(本機路徑、內網主機名與位址之通則檢查與其自驗);於 npm 包內(無 `.git` 亦無 `.gitignore`)略過 `.gitignore` 之列項檢查、掃描範圍改為包內全部文字檔 |
| `unit-toolbox.test.mjs` | 7 | 共用工具區之機械檢查 |
| `unit-briefTrials.test.mjs` | 6 | 任務書條款之隨機對照 |
| `unit-claimKey.test.mjs` | 8 | 驗證類方向之主張鍵;探索類方向與既有節點同臂同起點時另帶區分用之鍵(含已執行者逐字重提之略過);輪末摘要「方向未入前緣」各行 |
| `unit-pickLoader.test.mjs` | 4 | 挑選模組之靜態檢查與載入 |
| `unit-pickStore.test.mjs` | 11 | 共同儲存區;挑選模組載入時(含延後執行之程式)改了內建物件 ⇒ 中止更新(不寫任何檔、拋 `EVAL_INTEGRITY`;命令列工具離開碼 3);同行程前次已被改者入口即中止 |
| `unit-evalCli.test.mjs` | 3 | 命令列對 `L.ntStatic` 之接線:`g_eval.mjs` 兩條路徑(帳本涵蓋回測期 / 只涵蓋訓練期)與 `g_backtest.mjs`(全期帳本)實跑,`ctx.meta.ntAll` 只計訓練期之進場數 |
| `unit-ledgerReal.test.mjs` | 3 | 真實帳本與官方回測逐張一致(本機無策略庫與帳本時略過) |
| `unit-archiveDocs.test.mjs` | 2 | 指引文件之自動整理 |
| `unit-guides.test.mjs` | 2 | 寫法守則 |

## 7. 限制與注意

- 只能於 Node.js 執行;Windows 下所有子行程皆隱藏視窗.
- 任務書與文件為繁體中文.
- `tools/fakeRound.mjs` 與 `unit-ledgerReal` 需要專案已建好之帳本.
- 命令列程式與工具是指令稿,不在聚合入口內;請經專案根之進入檔執行.
- 節點 agent 不得讀取迴圈驗證之原始碼(本套件之 `src/domain/backtest*`、`verify*`)與以目錄方式涵蓋套件之程式夾;操作掃描已涵蓋 `node_modules/w-trade-adaptivess/src`.
- **領域接線假定專案根有 `sgud/`**(指引要求文件之配置):做夢須更新 `sgud/state/state.md` 與 `sgud/exp/experience.md`(輪末檢查;未更新者該輪判為失敗),改進項逐筆寫入 `sgud/feedback/feedback.md`,寫法守則在 `sgud/proc/guide_dream.md`、`sgud/proc/guide_node.md`(有則附於任務書);經驗檔與回饋檔逾上限時自動把較舊之內容搬出.做夢之寫入範圍亦含 `sgud/`.不採此配置之專案須自備這些檔,或另行改寫領域接線(日後擬改為輪末回調,由專案注入).
- **`dispatch.skillsRoot` 之預設**為行程使用者之家目錄下之 `.claude/skills`(以 `os.homedir()` 推得,不寫死使用者名;`src/cfg.mjs`),`w-dispatch-ai` 須安裝於 `<skillsRoot>/node_modules/w-dispatch-ai`.其他環境請於 `settings.json` 明給 `dispatch.skillsRoot`,或以 `inject.dispatch` 換成自己的派工方式.額度用盡即止所需之 `w-dispatch-ai` 版本見 §4 之「節點額度用盡時之行為」.

## License
MIT
