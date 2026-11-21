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
- 參考設定與合約之參考版依每根 K 棒之時長與專案之設定產出(規則 R-REC-36):每根之時長取 `--bar-hours <h>` 或專案既有之 `settings.json` 之 `source.barHours`(兩者皆給而不同即拒絕;皆無為 4;`--bar-hours` 其後無值、為另一個旗標或不合者亦拒絕 —— 皆未寫任何檔、離開碼 2).全新專案根所寫之參考設定之 `source.barHours` 為該值(4 小時者與套件之 `settings.json` 逐位相同;其餘逐字不變),重複同一指令為冪等.合約所寫之使用端之事實 —— 訓練期與回測期、保留期起點、回測期長度、求解窗、決策間隔、暖機、新鮮度地平線、虛無抽數、判讀之門檻、硬上限、活躍度分層、名次寬度、資源閘之等待 —— 一律取自專案之設定(數值之取值同評估器:數字字串轉為數值)(全新專案根取所寫之參考設定;求解窗與保留期起點未給者寫通稱、不寫日期);每根 4 小時且設定之值與參考設定相同者與套件之 `contract/pick-contract.md` 逐字相同.例:日線之專案 `node node_modules/w-trade-adaptivess/src/tools/initProject.mjs --root . --bar-hours 24`.

**專案根之決定**:環境變數 `ARSI_ROOT`(進入檔設定;其子行程繼承),未設時為行程之工作目錄;不以套件檔之位置推導.設定檔內之相對路徑一律以專案根解析.

**agent 之角色**(規則 R-RUN-11):派工器於節點與做夢之 agent 子行程設環境變數 `ARSI_AGENT_ROLE` = `node` / `dream`(只注入該次子行程;迴圈之行程與其所起之評估、驗證不帶).帶之者執行寫專案之檔或起行程之進入檔與模式即拒跑 —— 印一行理由(不帶輸入值)、離開碼 2、不寫任何檔:`g_rsi.mjs` 之 `status`(預設)、`dry`、`frontier`(未給 `--close` / `--rearm` 之值)、`fill --dry` 以外之模式,`g_launch.mjs`、`g_build.mjs`、`g_backtest.mjs`,`tools/` 之 archiveDocs、buildCatalog、pickStore、searchMap、smokeDispatch、fakeRound、replayCheck,以及 armDecide / armInactive 帶引數者、briefPreview / roundDigest 帶 `--out` 者、quota 帶 `--probe` 者、`initProject` 未帶 `--dry` 者.任務書要 agent 執行之 `g_eval.mjs`、`g_toolbox.mjs` 與只列出內容之工具照常;未設此變數(或為其他值)者行為不變.另:指令或路徑等工具輸入提到 `ARSI_AGENT_ROLE` 者併入既有之禁區字樣「迴圈專用之環境變數」(與 `ARSI_HARNESS` 同一條、同一個標籤;節點與做夢皆查,做夢以之為搜尋樣式者不算存取).

`settings.json` 之主要欄:`source`(策略庫位置、K 線之鍵、每根小時數 `barHours`〔須整除 24,例 4、24;未給為 4〕;選配之 `seriesDir` = 外部序列之資料夾,相對專案根,見 §3;選配之 `seriesOffGridMax` = 外部序列對不到棒之比例上限;選配之 `startTime` = 帳本之起點〔無時區之時間字串,含;須為 K 線檔內某一根之開盤時間、早於該帳本之終點(評估帳本為回測期終點、`--train` 帳本為訓練期終點)且其後之 K 線不少於 100 根;未給 = 自 K 線檔之第一根〕,見 §3)、`periods`(訓練期 / 回測期 / 保留期之起點)、`eval`(帳本夾、暖機日數、決策間隔、相位、新鮮度地平線、虛無抽數、硬上限)、`score`(階梯門檻)、`rsi`(狀態根、每輪節點數、併行數、一次跑幾輪;選配之 `fillParallel` = 附算與補算之併行數〔預設 3、上限 8;數字字串亦收;無效者用預設〕、`autoFill` = 輪末之附算〔只有 `false` 關閉〕)、`records`(節點文件 / 做夢文件 / 工作夾 / 共用工具區之路徑)、`agents`(節點與做夢各用哪個 agent 與模型)、`dispatch`(派工套件之位置、金鑰之 `.env`)、`resources`(全機 CPU / 記憶體上限)、`guard.forbidden`(選配;專案另加之禁區字樣 `[{ pattern, label }]`).

## 3. 評估器與挑選模組之合約

- 建帳本:`node g_build.mjs`(由 `source.libraryRoot` 之策略庫與 K 線,產生各策略之進出場與每單位損益;止於回測期終點;只有 `--limit`、`--train` 兩個旗標).回測期旗標(`g_backtest.mjs`)另以全期帳本(私有根;須與評估帳本由同一策略庫建出)重放,**全期帳本不由 `g_build.mjs` 建**(無 `--full` 旗標;其涵蓋回測期,建置之授權由使用端決定):由使用端以聚合入口之 `buildLedger` 自建於 `settings.backtest.ledgerDir`(預設 `<privateRoot>/ledger/full`),且與評估帳本用同一個 `source.startTime`(見下);未建時迴圈之說明與訊息(`g_rsi.mjs --mode validate` 之「未執行: 全期帳本未建(…)」、回測期旗標之 `error` 欄)即指此作法.啟動時核對兩者於訓練期終點以前之進場數逐策略一致(以評估帳本自身之 `ntStaticOf` 與全期帳本比對,不把評估帳本之 `off.u32` 差值〔全期計數〕當作訓練期之進場數);策略數或任一策略之計數不同、評估帳本無法載入、兩帳本之時間座標或 `off` 欄無效、帳本未涵蓋訓練期終點者即拒絕(離開碼 5).
- 外部序列(選配):策略庫以外、屬標的自身之序列,由專案備成與因子檔同格式之檔 `<名>.json` = `[{ time, value }]`(`time` 為 K 棒之開盤時間,與 K 線同一字串格式;缺值之棒不列),置於 `settings.source.seriesDir`;建帳本時對位到 K 棒並於帳本終點截斷(`ser.f64`、`meta.seriesNames`),挑選函數以 `ctx.series(name, nBack)` 取決策棒以前之值(不含決策棒).序列之值視為於其標記之棒收盤時已得知,得知較晚者須由使用端標在其後之棒(見合約).名稱限英文字母起首之英數與底線(至多 32 字);檔名以底線起首者略過.未設定者不建入,既有結果不變(帳本鍵不因此改變).
- 每根 K 棒之時長(規則 R-EV-44;日線等其他週期):`source.barHours` 須整除 24 小時(例:1、2、4、6、12、24;數字字串亦收),不合者建帳本時不讀檔即拒絕(`g_build.mjs` 印 `ERROR invalid source.barHours…`、離開碼 2);策略檔帶 `settings.intervalSec`(每根秒數之宣告)者須等於 `barHours × 3600`,不合者不寫出(離開碼 2);選配之 `source.seriesOffGridMax`(0 ~ 1)= 外部序列「時間落在帳本範圍內而對不到棒之開盤時間」之列之占比上限,超過即不建(給了上限而序列沒有任何列落在帳本範圍內者亦不建;未給 ⇒ 只記錄,行為不變;此占比只量「有列而對不到棒」—— 較粗之序列餵給較細之帳本〔例:每日一列之序列給每根 4 小時之帳本〕時占比為 0 而照建,其餘之棒為缺值,序列之格線須由使用端與帳本對齊);`eval.fitEnd` 之兩側(有給者)與換算成棒序之期間之界線(`periods.train.end`、`periods.backtest.start`;`g_backtest.mjs` 之同劑量判讀另含 `periods.backtest.end`)須落在帳本之棒格線上,否則 `g_eval.mjs` / `g_backtest.mjs` 印 `ERROR invalid <位置>…`、離開碼 2(`g_eval.mjs` 給 `--out` 者另寫 `{ ok: false, code: 'CONFIG_INVALID', error }`);迴圈組裝專案時(`makeProject`)即以同一組檢查預檢,不合者整輪不派工(`g_rsi.mjs` 與 `tools/` 之 searchMap、briefPreview、armInactive、armDecide、fakeRound 皆印 `ERROR invalid …`、離開碼 2);影響評估之數字 `warmupDays`、`cadenceDays`、`nullDraws`(含評估器之 `opt.nullDraws` 與命令列之 `--null N`)、`actBins`、`sideActHalf` 給了而無效即拒絕、不退回預設:`warmupDays` 須為非負數、`cadenceDays` 為正數(兩者與每日棒數之積須為整數,即換成棒序後不得有小數)、`nullDraws`(0 = 不算虛無)與 `sideActHalf` 為非負整數、`actBins` 為 1 ~ 256 之整數(評估器以 8 位元存層號);未給(或 `null`)取預設(180、7、64、10、50);數字字串收受並轉為數值(與任務書、合約同一取值;數字者逐位不變);不合者 `g_eval.mjs` / `g_backtest.mjs` 印 `ERROR invalid eval.<鍵>: must be …`、離開碼 2,迴圈組裝專案時整輪不派工(訊息不帶輸入值);缺 `periods.train` 或 `periods.backtest`、或其 `train.start` / `backtest.end` 不是可解析之時刻字串亦同(`ERROR invalid periods.…`、離開碼 2,不以 TypeError 結束);選配之 `eval.trainFromStart`(布林;預設不設)= `ctx.meta.ntAll` 與 `--period train` 以訓練期起點(`periods.train.start`,須在格線上)為下界 —— 帳本之資料起點早於訓練期起點(因子之暖機)者用之;未給者自帳本起點計數(行為不變;帳本起點 = 訓練期起點者給與不給之結果逐位相同);另一作法為令帳本本身自訓練期起點起(`source.startTime`,見下一條),挑選函數可見之全部歷史與暖機皆自該起點,兩者可併用.評估器之各量以日換算(`barsPerDay = 24 ÷ barHours`):決策間隔、相位、回看日數、新鮮度、等效年化之年數、月均單皆以日為單位;`ctx.market` / `factor` / `series` 之 `nBack` 與 `lastEntryAgo` 以根為單位(每根 1 日者 180 根 = 180 日).
- 帳本之起點(選配;規則 R-EV-45):策略庫之 K 線因因子之暖機而早於求解窗(訓練期)之起點者,帳本預設仍自 K 線檔之第一根起 —— 挑選函數經 `ctx.stat`、`ctx.orders`、`ctx.entryDays` 等「全部歷史」看得到求解窗起點以前之進場,暖機後之第一個決策亦自 K 線檔之第一根起算.`settings.source.startTime`(`buildLedger` 之 `opt.startTime`;無時區之時間字串,**含**;與終點對稱)有給者,帳本(評估帳本與 `g_build.mjs --train` 之訓練期帳本皆然)之 K 線取 `startTime ≤ time < 終點`:`meta.time0` = 起點、`meta.startTime` 記下所給之值,進場、出場、損益、因子欄、K 線欄、外部序列欄與基礎單位名義皆自該根起算,其以前之單不入帳本(進場早於起點而出場在其後者亦不入);評估器不改 —— 暖機自帳本起點起算,第一個決策 = 起點 + `eval.warmupDays`,`eval.trainFromStart` 之語意不變(訓練期起點早於帳本起點者以第 0 根為下界).給了起點之帳本 ≡ 未給者「只留進場棒 ≥ 起點、棒序平移」(各策略之進場棒、出場棒〔未結者仍為 -1〕、損益逐單相同,逐棒之欄為原欄之切片).起點須為 K 線檔內某一根之開盤時間(與 K 線同一字串格式)、早於該帳本之終點,且其後之 K 線不少於 100 根;不合者(非字串、帶時區字尾、不在 K 線上、不早於終點、其後不滿 100 根)於寫出之前拒絕:`g_build.mjs` 印 `ERROR invalid source.startTime…`、離開碼 2、不寫出任何檔,`buildLedger` 拋 `invalid startTime…`(訊息不帶輸入值;`g_build.mjs` 之起首列與改前逐字相同、不回顯起點,起點見於記錄之 `ohlc` 列與摘要行之 `startTime` 欄);未給(或 `null`)⇒ 帳本、`meta.json` 與輸出與未加入本選項時逐位相同.給了 `startTime` 而晚於 `periods.train.start` 者(帳本未涵蓋訓練期起點;以時刻比較,訓練期起點寫法不同而同一時刻者不印,非字串或無法解析者不印),`g_build.mjs` 於建置成功後另印一行 `WARN`(離開碼仍 0;評估帳本與 `--train` 帳本皆然):暖機與 `ctx.meta.ntAll` 自帳本起點起算.帳本鍵之雜湊輸入含 `time0`、棒數與逐單之進場棒 ⇒ 起點不同之帳本其鍵必不同(以評估帳本之鍵為依據之評估紀錄隨之重算).`initProject` 之參考設定不含此鍵(選配;預設不啟用).**回測期旗標(`g_backtest.mjs`)所用之全期帳本**(`backtest.ledgerDir`;使用端以聚合入口之 `buildLedger` 自建,不經 `g_build.mjs`)**須以同一個 `startTime` 建**:任一帳本之 `meta.json` 帶 `startTime` 而兩帳本之 `meta.time0` 不同者,`g_backtest.mjs` 印專屬之 `ERROR`(列出兩個 `time0`)、離開碼 5(帳本不一致)—— 給了 `eval.trainFromStart` 使訓練期進場數核對通過者亦然(回測期重放所見之「全部歷史」與暖機會自較早之起點,與評估帳本不同);兩帳本皆未給 `startTime`、或 `time0` 相同者(例:評估帳本之 `startTime` 即 K 線檔第一根而全期帳本未給)不受影響,行為與改前相同.
- 建帳本之一致性核對(`meta.check`;規則 R-EV-45):策略檔之 `numTrade` 為求解窗 `[summary.timeOhlcStart, summary.timeOhlcEnd]` 內之進場數,帳本只計同窗(求解窗起點棒 ≤ 進場棒 ≤ 求解窗終點棒)者與之比;策略檔無 `timeOhlcStart` 者自帳本第 0 根起(同原寫法).「未帶」= `undefined` 或 `null`;其餘(含空字串、非字串)而求解窗起點不在本帳本之棒上者 —— 早於帳本起點(帳本未涵蓋完整之求解窗,例:給了較晚之 `startTime`)或不在棒之開盤時間 —— 不納入核對(不計入 `compared`),隻數記於 `meta.check.skipped`,記錄另列一行(附第一個被略過者之檔名與其 `summary.timeOhlcStart`〔JSON 字串化後截至 40 字〕;全數略過者以 `WARN` 起首);起點晚於終點之策略照核對(窗內計數為 0,與 `numTrade` 不同即計為不符);無略過時 `meta.check` 無 `skipped` 鍵(**缺此鍵 = 0**).K 線之起點早於求解窗起點之專案(因子之暖機),未給 `startTime` 者核對亦全數相符(原寫法自第 0 根起計而於此類專案誤報不符).**未給 `startTime` 者與舊版之唯二差異即此**(帳本各檔與 `meta.json` 其餘各欄、命令列輸出逐位相同):除上述外,策略檔之 `summary.timeOhlcStart` 若不是帳本之棒之開盤時間(格式與 K 線不同、空字串、非字串等),舊版仍計入核對(自第 0 根起計,與 `numTrade` 不同即報不符),新版改為不納入核對 —— `compared` 減少、`meta.check` 多 `skipped` 鍵、記錄多一行(全數略過者 `WARN`).K 線之連續性(相鄰兩根之間隔須為一根之時長,否則拋「K 線不連續」)只檢截取後之範圍:`startTime` 設在缺口之後者可建(未給者缺口在 endTime 以前即拒絕,同舊).
- 不隨週期換算之量(規則 R-EV-44;使用端換週期時須知):① 看板與判讀之下單流量偏一側之基準(`SIDE_FLOW` 預設:全體隨機之做空比例訓練期約 0.22、回測期約 0.16)是**每根 4 小時**之策略庫之實測值;他週期之策略庫宜自設 `settings.score.sideFlow.baseShort`(`{ train, backtest }`;看板之說明、節點文件之「下單之做空比例」一列與判讀取同一份),未設者仍用此預設;升版後新產生之節點文件(或經 `rescanSideFlow`、`reverifyAll` 重產者)之該列才改印設定值,**既有之節點文件不自動改寫**(要更新舊節點文件之該列,升版後以 `reverifyAll` 重產〔命令列:`node g_rsi.mjs --mode reverify --why "<原因>"`,可加 `--only <id 前綴,…>` 只重產指定節點、`--keep-flags` 沿用既有之回測期旗標;此為以現行評估器重跑,非僅重產文字〕;`rescanSideFlow` 只處理「有變動」之節點,基準字樣之改變不計為變動).② `sel.orders.barTop1Share`、`perBarMax`(評估結果之下單集中度)以**棒**為單位:每根 1 日者「前 1% 之進場棒」= 前 1% 之日,其值不能與每根 4 小時之專案互相比較.
- 評估器之指紋(附算與補算之快取之鍵;規則 R-REC-34)不含只用於建帳本之 `src/eval/ledgerBuild.mjs`(評估器不匯入它;測試核對匯入鏈):只改建帳本之升版不使附算與補算之值過時;評估器所匯入之其他檔之任何改動(含註解)仍使之過時.
- 下單之基礎單位(選配;規則 R-EV-43):`settings.source.unit` = `{ rule: { stepSize, minQty, minNotional, asOf?, source? }, buffer = 0.1, uIni }`(交易所之交易規則、名義門檻之緩衝、研究用本金;數值收數字與數字字串,通過即轉為數值,`'0.001'` 與 `0.001` 得同一帳本鍵;不寫死任何標的之數值).有給者建帳本時另存每根棒之基礎單位名義(`unit.f64`、`meta.unit`、`meta.unitStat`;帳本鍵併入交易規則與緩衝;每根棒之名義由 `w-trade-backtest` 之 `calcBaseUnitQuantity` 求得,須 1.1.40 以上,只於給了設定時才匯入),評估器之等效年化改依實際名義(損益和 ÷ 最大同時持倉名義 ÷ 年數);挑選函數與執行規則所見之統計仍為每單位損益與單數(同一挑選模組之選集不變).成品之操作績效之最大同時持倉名義超過研究用本金即不評估(`ERROR EVAL_UNIT_CAPITAL`,離開碼 3);設定與帳本之 `meta.unit` 不同者不評估(`LEDGER_UNIT_MISMATCH`,離開碼 2;請重建帳本).未給者帳本、評估與輸出與未加入本功能時逐位相同.聚合入口另匯出 `isCapitalError`、`normUnit`、`sameUnit`.
- 評估:`node g_eval.mjs --pick <模組.mjs> --mode quick|full [--out <結果.json>]`.挑選函數自帳本起點連續執行,只有落在評估期之決策計入績效.
- 成員重抽:`node g_eval.mjs --pick <模組.mjs> --mode full --member <鹽>:<0|1>` 只把策略庫之一半(依各策略之同分次鍵與鹽之雜湊切半;`0` 甲半、`1` 乙半;鹽為 0 ~ 4294967295 之整數,十進位或 `0x` 十六進位)交給同一個模組,檢驗其內容是否依賴特定成員;結果另記 `member`、不是正本,格式不合離開碼 2.API 為 `memberLedger(L, salt, half)`(聚合入口 `WTradeAdaptivess.memberLedger`,亦可自 `src/eval/ledger.mjs` 深層取用;回重新編號之半庫帳本,其 `srcIdx` 使評估器沿用各策略於全庫之同分次鍵;`salt`、`half` 為整數〔依 `iseint`,數字字串亦收;`0x` 十六進位寫法只於命令列解析〕),其後照常 `ntStaticOf` 與 `makeEvaluator`.
- 子庫(規則 R-EV-47;`--member` 之一般化):`node g_eval.mjs --pick <模組.mjs> --mode full --subset <規則>[,<規則>…]` 只把符合**全部**規則(交集;各條各自於全庫上判定)之策略交給同一個模組與虛無抽樣;結果另記 `subset: { rule, n, nFull, nLong, nShort[, topFamilies] }`(`rule` = 正規化之規則字串)、不是正本,評估紀錄每列帶 `subset`(兩條機械提示不計其列);評估次數之計法、與 `--ref` / `--ext-test` / `--period` / `--phases` 之併用同 `--member`;不與 `--member` 併用;格式不合、旗標重複、只給旗標、帶等號之 `--subset=<規則>`(須寫成 `--subset <規則>`,空格而非等號;`--member=…` 同:須寫成 `--member <鹽>:<半>`)者離開碼 2(不寫結果檔、不記評估紀錄,訊息不帶輸入值);規則使留下 0 隻者(空子庫)照常評估(離開碼 0、選集恆空),畫面於「子庫 …」一列之後另加一句警示「警告: 子庫為空…」(結果檔與評估紀錄不變).規則:`rand:<p>:<鹽>[:<0|1>]`(`u < p` 或 `u ≥ 1 − p`;`u` 同 `--member` 之切半之式 ⇒ `rand:0.5:<鹽>:<h>` 之子庫 = `--member <鹽>:<h>` 之半庫,結果檔除規則欄外逐位相同)、`tp:<lo>:<hi>` / `sl:<lo>:<hi>`(止盈 / 止損;帳本之 float32 值與 `Math.fround(界)` 比;兩端含、任一端可空)、`hold:<lo>:<hi>`(各策略之進場與出場皆在訓練期內之已結單之持倉天數之中位;無此類單者不屬任何帶)、`keys:<lo>:<hi>`(進場條件數)、`side:long|short`、`siderand:<long|short>:<鹽>[:<p>]`(另一側全留、所指之側留 `u < p`,預設 0.5)、`nofam:<N>:<家族>`(去除用到該家族之策略;家族 = 因子名以底線切段、去掉前 N 段後接回,N 必給〔0 ~ 32;無預設 —— 套件不假定因子名之分段〕,段數不足者無家族)、`nofam:<N>:top:<比例>`(依用到該家族之策略數由多到少〔同數依家族名〕逐一去除,至去除之比例 ≥ 所給之比例;所去除之家族記於 `subset.topFamilies`;家族名不得為 `top`).API:`parseSubsetRule`、`subsetMaskOf`(`src/eval/subsetRule.mjs`)與 `subsetLedger(L, sel, rule)`(`src/eval/ledger.mjs`;深層路徑取用,聚合入口不併入).
- 求解窗後段:`node g_eval.mjs --pick <模組.mjs> --mode full --period postfit`(診斷用;**此結果不是正本**)只計決策棒落在「最早之求解窗終點棒(設定 `eval.fitEnd`)之次一根 ~ 回測期起點」之決策,且每個決策只留「求解窗之終點棒早於決策棒」之席;挑選函數照常執行(`ctx.prev`、`ctx.state` 為其完整之選集).輸出所留之席之等效年化、組成對照(同側同活躍度)之超額與 p、下單數與前段 / 後段之分段(結果檔之 `metrics.afterFit`),另列近 90 日活躍度版之組成對照(全段與各段;`sideActRecent`;算法同擴充診斷之 `api.replaceNull({ actDays: 90 })`);作為佐證,**不計 S**(結果檔之 `score` 為 `null`)、不印判讀列、評估紀錄記 `period` 且不算版本之評估.須有虛無;每個所評估之相位須於段內有決策棒(否則不評估);不與 `--ref`、`--ext-test` 併用,擴充診斷不載入;`--member`、`--phases` 可併用.API 為 `evalPolicy` 之 `opt.afterFitOnly`(布林;須有 `cfg.fitEnd`,不與 `opt.ext` 併用;等同挑選函數自行只回所留之席).效度限制:以過往損益為輸入之排序鍵,其輸入於此段之前段多為樣本內之單,宜看分段;替換池為全庫之各虛無於此段讀組成對照.
- 直接以 API 單獨使用評估器(`makeEvaluator(L, cfg)`):須明給訓練期之界線 —— `L.ntStatic = ntStaticOf(L, 訓練期之終點棒序)`(**評估帳本涵蓋訓練期與回測期,界線為訓練期之終點棒序〔依帳本之 `time0` 與每棒小時數自 `settings.periods.train.end` 換算〕,不可給 `L.nBars`**;只有全為訓練期之帳本〔如 `g.mjs` 之合成帳本〕才給 `ntStaticOf(L, L.nBars)`),`ctx.meta.ntAll` 只計訓練期之進場數;未給(或型態、長度不合)者拋 `invalid L.ntStatic: must be …`,**不回退為帳本全期之進場數**(帳本涵蓋訓練期以後者,回退會把其後之資訊帶進該欄).命令列(`g_eval.mjs`、`g_backtest.mjs`)自設定之訓練期終點給界線,行為不變.`loadLedger` 對 K 線欄 `px.f64`(有此檔者)核對長度 = 5 × K 棒數,不符拋 `invalid px.f64: must be …(請重建帳本)`(舊帳本無此檔者 `px` 為 null,取用 `ctx.market` 時拋「帳本無 K 線欄」).
- 挑選模組之形狀、`ctx` 之每個介面(`stat`、`orders`、`entryDays` / `entryBars`、`exitDays` / `exitBars`、`market`、`factor`、`series`、`meta`、`state`、`rand`)、`accept(sig, book)`、分帳、輸出之讀法與擴充診斷之寫法,全部寫在合約 `contract/pick-contract.md`(專案內為 `docs/pick-contract.md`).
- 判讀:`S = 0.7 × 七相位平均 + 0.3 × 最差相位`;階梯 1 ~ 3 與否決見 `src/eval/score.mjs` 檔頭.
- 擴充診斷:共用工具區 `metrics/*.mjs` 每次完整評估自動載入;可自帶看板值(`board`)、提示(`flag`)、「不計為挑選內容」(`notContent`)與量尺之子集(`subset`).核心另以名稱讀取 `nullRecentAct`(近期活躍度版之組成對照):其 `side.excess` 與 `side.p` 皆為有限數值者入搜尋地圖之「有內容」之判定(另須超額 > 0、p ≤ 階梯 1 之門檻;與內建之組成對照一過一不過者於譜系與看板標「活躍度定義不一致」、不計入;樹上皆無其值者搜尋地圖與看板不變;R-REC-38);量尺之「挑選內容」與看板之「正本與重放之均」取其超額時與「有內容」同一個取值(超額須為有限數值,只用超額、不要求 p;NaN、±Infinity、字串、缺、帶 `error` 者視為無值);迴圈之驗證之重放之紀錄與節點文件之重放一列、共同儲存區之 `backtest.content` 亦取同一個值(單一定義於 `src/domain/diagRead.mjs`;R-REC-38 ⑦).核心另以名稱讀取 `neutralExec`(中性執行之參考)之 `delta`:排序鍵(§4;R-REC-40)以之扣除執行層之增益.診斷可用 `api.market(bar, nBack)`、`api.factor(ki, bar, nBack)`、`api.series(name, bar, nBack)` 取某棒以前之 K 線、因子、外部序列之值(與 `ctx` 之同名介面於決策棒 `bar` 之取值逐位相同),依各決策當時之狀態把成品之選集分組後以 `api.simulate` 重放;為某次決策分組時 `bar` 須用該決策自己之決策棒或更早者(不以程式強制,見合約 §7).`api.replaceNull` 可只替換一部分之席:`onlyGroups`(只換所列子帳之席,其餘原樣)、`onlyDecisions`(只換遮罩內之決策之席,遮罩外之決策給空選集;配對之成品值為「成品只留遮罩內決策」之重放),給任一者時另回 `applicable`、`obs`、`obsPnl`、`pnlMean`、`pnlSd`(成品未分帳而給 `onlyGroups` 者只回 `applicable: false` 與 `reason`;各遮罩為獨立重放,損益與等效年化皆不保證可跨遮罩相加);皆未給時回傳不變(見合約 §7).`api.fillRandom(statesByPhase, { actDays, draws, pool })` 依各決策之兩側席數(`{ short, long }`)以活躍度匹配隨機填席,回 `draws` 組可直接交給 `api.simulate` 之選集(每席自同側、依決策棒以前之活躍度名次匹配成品之同側之席之名次分佈;與 `replaceNull` 同一套排名與鄰域;`pool: 'toDate'`〔預設〕取至該決策為止之席、只用決策棒以前之資訊,`'phase'` 取本相位全部決策之席、供狀態序列跨時間置換之對照、不是只用決策棒以前之資訊;見合約 §7).
- 評估器之狀態不受模組之寫入影響(挑選模組、擴充診斷模組與評估器同在一個 JavaScript realm;合約 §1):
  - 資料不共用:交給模組之物件一律為複本或凍結 / 封裝之物件(`ctx.meta` 每次執行一份、`ctx.prev` 為複本、`accept` 之 `sig` / `book` 每次呼叫前重寫、擴充診斷之 `api` 每個診斷一份,其十個函數〔`simulate`、`summarize`、`replaceNull`、`sideGroups`、`geoGroups`、`rand`、`market`、`factor`、`series`、`fillRandom`〕之函數物件亦每個診斷各一份並凍結);`tag` 只收可結構化複製之資料,於 `pick` 回傳時取快照並凍結;`ctx` 之函數只在該次 `pick` 呼叫內有效.
  - 內建物件之完整性:評估器只用載入時擷取之內建方法(`src/eval/intrinsics.mjs`);載入模組後、評估器各方法與 `loadLedger` 之入口、每次 `pick` 後、每批 `accept` 後、每個擴充診斷後、讀帳本前與輸出前比對受保護之內建物件,被改即評估失敗(錯誤 code `EVAL_INTEGRITY`,列出被改之項目;`g_eval.mjs` 印 `ERROR EVAL_INTEGRITY …`、離開碼 3,`--ext-test` 印 `EXT_FAIL`、離開碼 4).
  - 仍只靠合約與審計者:模組層變數跨相位 / 跨模擬保存、檔案與行程介面之取用(靜態檢查為字樣層級之防呆)、受保護清單以外之內建物件;不另隔離 realm.
  - 成本:每次比對約 80 µs(約 1000 個屬性描述);一次完整評估約一萬次比對(每批 `accept` 呼叫一次);合成帳本之實測耗時增加約兩成至三成,大半在逐訊號迴圈之交出物件重寫與擷取函數之呼叫,比對本身約占 1 ~ 2%(見 `sgud/state/state_EV1.md`).

## 4. 迴圈

- 起跑一輪(脫離式;人、agent、作業系統之排程器皆用同一道指令):`node g_launch.mjs round -- g_rsi.mjs --mode round`;先看計畫:`node g_rsi.mjs --mode dry`.
- 前緣為空(下一輪之計畫為 0 個節點、無閘門拒絕、無待重審之節點)時 `--mode round` 不起空輪:事件 `run-done` 帶 `reason: 'frontier-empty'`(`rounds` 為已跑之輪數;不耗輪號、不記為失敗輪、離開碼 0);連跑多輪時第 2 輪起每輪開始前亦判斷(第 1 輪於起跑前之自檢與補做夢之後判斷).有認領中(planned / running)之節點者照起(由正式之探索先回收遺留之認領).起跑前之乾跑本身拋錯者不擋(由正式之探索照原樣報錯).
- 做夢已宣告向外飽和(`synthesis.overview.outwardSaturated`;R-REC-29)之輪,輪末摘要於「任務類型 … 配比 …」一列之後另列「向外飽和:…」一行(`ROUND.json` 之 `hook.lines` 與一頁摘要之「一眼看完」亦見);執行結束時最近一份做夢文件已宣告者,事件 `run-done` 與 `rsi/STATUS.json` 之 `run` 帶 `outwardSaturated: { round }`(宣告所在之輪;前緣為空而未起輪之執行亦帶;其後之做夢未重申者不再帶;補做夢後輪末回調失敗而早退之 `run-done` 不帶),日誌附一句;未宣告者無此行、無此鍵.
- 要讓做夢在沒有新節點之情形下重新彙整並給方向(工具或資訊源更新之後,或對上一份做夢文件有須回應之註記):`node g_launch.mjs round -- g_rsi.mjs --mode round --dream-only --file <文字檔>`.文字檔(UTF-8;相對路徑依命令列之工作目錄,經 `g_launch.mjs` 起跑時為專案根)= 對本輪做夢之要求,原文列於做夢任務書之最前(「## 0. 主控之要求」)與做夢文件;審計 0、輪號照常遞增、只跑 1 輪(`--rounds` 不採);檔讀不到、為無效之 UTF-8 或為空 ⇒ 印 `invalid --file: must be …` 與用法、離開碼 2、不取鎖、不記事件(此檢查先於專案之組裝).下一輪之計畫有節點、有待重審之節點或有認領中之節點時不受理(事件 `run-done` 帶 `reason: 'dream-only-busy'`、離開碼 0:起一般輪次即可,做夢照常).該輪之 `round-done.ok` = 做夢已交付且輪末回調未失敗;事件 `run-start`、`round-done` 與 `rsi/STATUS.json` 帶 `dreamOnly: true`,`ROUND.json` 記 `dreamOnly.why`.要求只存於本行程之記憶體,輪末鉤子取用即清除(做夢未交付者須重新要求);未帶 `--dream-only` 時,0 個可審計之節點之輪次照舊略過做夢、做夢任務書逐字不變.
- 等待結束:`node tools/waitEvent.mjs --since <起跑之 UTC 時刻>`;事件檔 `rsi/logs/events.jsonl`;輪末一頁摘要 `rsi/rounds/rNNN/DIGEST.md`.
- 節點與做夢各依任務書工作;交付之文件有固定規格(`arsi.node/3`、`arsi.dream/3`;見 `src/arsi/records.mjs` 檔頭),由迴圈檢核、渲染與存檔.
- 「向外 0 條」之例外:做夢任務書之配比除「預先核對 3 種以上而皆無內容」(例外之一;`synthesis.overview.outwardChecked`)外,於派做夢當下可選之臂皆已試過(`context.outward.nUntried === 0`)時另列例外之二 —— 做夢宣告「現行資訊範圍內已無可試之向外方向」(`synthesis.overview.outwardSaturated = { basis }`;每輪重申,迴圈不跨輪記憶)者,方向可只含驗證類;輪末摘要依套用做夢之審計後之樹判定(做夢判刪除某臂之唯一已試節點 ⇒ 該臂回到未試,此例外不適用),記為「向外 0(已宣告向外飽和)」.未給 `context.outward` 或尚有未試之臂者,任務書與範本不變.
- 做夢任務書之方向之條目另列一句(規則 R-REC-37):預先核對(跑前登錄)之設計取捨不得以求解窗後段為判準 —— 此段只於設計定案後附報,否則該段對該設計即非獨立之佐證.句內附所指之處:已有共同儲存區者為其 `postfit` 欄,尚無者為節點文件摘要之「求解窗後段(佐證;非正本)」一列.節點任務書不提求解窗後段.
- 任務書之「可疑方向」與資訊來源之三級(規則 R-REC-47;只動任務書與合約之文字,不改評估器、迴圈、檔案格式與節點文件 / 做夢文件之規格):做夢任務書 §3 於整體研判之後、方向之條目之前另列「**可疑方向**」一段 —— 資訊來源分三級(第 1 級 = 策略自身之量、第 2 級 = 庫內相對、第 3 級 = 庫彙總量〔把策略庫當行情之感測器〕;**用到第 3 級之成品須於隨機半庫〔至少 6 個;`--member`〕與分層子庫重算仍在才可稱挑選內容**,未做者只列為候選)與六種形狀之處置(側別曝險冒充挑選不列為已驗證之最高、不作為其後方向與預先核對之起點;以庫彙總量定側別或席次同第 3 級之要求;以落後之延續規則定側別須有兩種以上行情段之證據;同一個底之連續疊加時探索類之方向與預先核對至少一半改用側別中性之底;成員依賴〔內容保持率之中位 < 0.5 或任一半庫之相位平均為負〕不列 `worked`;內容只在庫之某一類成員成立者標示範圍、不外推);`synthesis.summary` 之量尺句改為並列「內容最高且可信」與「S 最高且可信」之成品;審計規程第 8 點(審組成)末加一句(迴圈檢查列「下單流量偏一側」、或擴充診斷之提示指出成品等同某一個固定狀態〔例 `fixedState`〕、同比例隨機時機之安慰劑〔`placeboTiming`〕無內容者,其優勢歸為側別曝險);節點任務書 §6 新增第 7 條(用到庫彙總量者於 `conclusion.summary` 自報「資訊來源:第 3 級(…)」,探索類另交一個兩側席次固定之對照版,不新增結構化欄位);合約 §5 新增「判讀名詞」(資訊來源之三級、側別中性、組成位移、內容保持率).`fixedState`、`placeboTiming` 為擴充診斷之例示名(由專案之共用工具區自建,套件不內建).升版後每份做夢任務書多此一段、節點任務書多此一條,新舊比對之差為預期改動;專案之 `docs/pick-contract.md` 須比對參考版併入(重跑 `initProject` 會另寫 `docs/pick-contract.pkg.md`).
- 迴圈對每個節點之成品**重跑**取得正本數字(另換亂數種子與同分次序重放),並掃描 agent 之操作紀錄(禁區、工作夾外之寫入、評估次數;節點之「列出工作夾之根」只列以之為目標者 —— 字樣只在搜尋指令之樣式引數內者不列,無法確定者照列;R-BT-6;執行上述拒跑之進入檔與模式者〔節點與做夢皆查〕、節點以遞迴方式列出狀態根或其上層者〔`ls -R`、`find`、`tree`、`dir /s`、`Get-ChildItem -Recurse`、遞迴之搜尋、搜尋 / 列目錄工具、內嵌或寫入之腳本走訪目錄〕另各列一項,無法解析者從嚴列出;R-BT-7).輪末摘要之「待核對」(保留期 / 他標 / 他幣 / 號之字樣)不列「組成對照 / 重放 / 同分次序之同號 / 異號」之句(同句另有其他字樣者照列;R-REC-39).
- **排序鍵**(R-REC-40;`rankKeyOf`):看板之次序與各臂之「回測期最佳 S」、搜尋地圖之各「最高」(本輪、量尺、有內容、子集、各層)、節點任務書之參考節點、補位之底共用一個鍵 = 正本與各次重放之 S 之均;成品有擴充診斷 `neutralExec` 之值(`delta` = 成品之 S − 中性執行之 S;物件、不帶 `error`、`delta` 為有限數值)者,每抽之 S 先減去該抽之 `delta`(重放未帶者用正本之值)。S 照列(不改 S、階梯、否決、可信度與共同儲存區);依鍵與依 S 之結果相同之處逐字不變,不同之處註明「依排序鍵」與鍵之值。
- **起點不取別名**(R-REC-45;別名 = 選集指紋〔評估結果之 `selHash`〕與較早之節點相同之節點,引擎之 `rsi.aliasMap()`):迴圈交給前置閘門之節點視圖不含別名,別名為起點者一律被拒 —— ①補位之底(`carrierBase`;補位載體之起點)取排序鍵最高者中**非別名**者(別名表只在有候選時才求一次;取不到〔引擎無此函數、拋錯、非 Map〕視同無別名);②做夢方向之起點為別名者,`proposeDirection` 改以其正本為起點入前緣(規格之 id、同規格之判定、主張鍵與區分用之鍵皆依改掛後之起點,同一方向以別名或正本各寫一次為同一個規格),回傳之 `note` 註明「(起點 X 為 Y 之別名(選集相同),已改以 Y 為起點)」並另帶 `baseUsed`(實用之起點;記入做夢文件之 `harness.applied.proposals[]`,節點之來源方向依此對應),方向入前緣者於做夢文件加一則迴圈註記(未入前緣者〔正本被否決、同規格已存在等〕不加),輪末摘要列「方向之起點為別名 n 條」一段(選集相同不蘊含臂集合與交付程式相同:改掛後節點任務書之起點成品〔臂、`base_pick.mjs`〕取正本者);③仍到達閘門之別名起點(例:升版前已入前緣之提案)照拒,訊息改為「起點 X 為 Y 之別名(選集相同);請以 Y 為起點」(起點不存在或未執行者之訊息不變).樹上無別名、起點非別名者之輸出與改前逐字相同.
- **輪末之附算一併處理待補算**(R-REC-41):輪末之附算於本輪之成品之後,接著以同一套計畫、鍵與執行補入樹上既有之成品之待補算(依成品之先後;待重試之紀錄中之成品除外),於看板、共同儲存區與下一輪之計畫之前完成;總時長之上限 `settings.rsi.fillBacklogSec`(秒;預設 1800;0 = 不處理,只列於摘要),尚餘者列於摘要、下一次輪末續算;取用者中有失敗者,摘要不寫「已補齊」、改註失敗之個數(失敗者見「附算」與「附算之失敗而不重試」之列)。重跑結果相同而不入待重試之失敗(參數不合、持倉超過研究用本金、完整性檢查未過、選集指紋與正本不同)以「該次失敗之項目之待算之鍵之指紋」記於 `fill_state.json` 之 `blocked`(選配之欄;無紀錄者不帶),一併處理時其待算之鍵未變者不取(摘要註明略過之個數;仍列於待補算),成品、評估器或診斷改版而鍵改變者再取一次;本輪之成品、待重試者與 `--mode fill` 不略過。`--mode fill` 不變(只多更新此欄)。
- **迴圈之重放一併載入擴充診斷**(R-REC-42):換亂數種子與同分次序之重放於 `nullRecentAct` 之外另載入 `settings.rsi.replicaExt` 所指之診斷(`'board'`〔預設〕= 正本帶看板值者,另加正本之 `neutralExec`〔其 `delta` 為有限數值者,不論有無看板值;排序鍵每抽讀各重放自己之 `delta`〕、`'all'`、`'none'`〔= 改前〕、名之陣列〔照所列,不自動加 `neutralExec`:此時排序鍵每抽用正本之 `delta`〕);`harness_seed*.json` 帶其值,`raw.replays[].ext` 存看板值與 `neutralExec` 之 `delta`,看板之「正本與重放之均」與節點文件之重放一列並列各診斷之看板值之多抽之均(看板值之數字逐位平均;樣板不同者不列)。不改重放之次數、種子與同分次序;另載入者使重放失敗時以改前之引數再重放。耗時:每多一個 32 抽之 `replaceNull` 約一次重放之一至兩成(合成帳本實測:300 隻 × 2400 根、七相位 +14%;提案端 300 隻 × 4000 根 +19%;只 `simulate` 一次約 +7%;實際依該診斷之成本而定)。
- **迴圈檢查之兩條機械提示**(R-REC-43、R-REC-44;只提示、不否決;讀各節點工作夾之 `.evals.log` 之「成功、完整評估、評估期、不帶成員抽樣、非參考檔〔`control.mjs`、`base_pick.mjs`、`ref_*.mjs`〕」之列,各計至該節點之 agent 結束之時刻):①「**提示(單峰交付)**」—— 相異之選集指紋 ≥ 6、交付版之 S > 0 且不低於其餘每一個、其餘之 S 之中位 < 交付版之一半;②「**提示(選集與他節點相同)**」—— 交付版之選集指紋等於他節點(含同輪)之某次完整評估者,臂組合不同 ⇒ 多出之臂於評估期間未作用、臂組合相同 ⇒ 同一成品(驗證類與其起點、方向內指名之節點之間不比;本節點之臂為對方之真子集者不列;兩方皆為驗證類而臂組合相同者不列 —— 刻意之重複驗證)。於輪末(派做夢之前、做夢之處置之後)產生於本輪之節點,`--mode reverify` 之後亦重產;較早之節點要 `--mode validate`(重掃)才補上(先以 `node tools/scanCheck.mjs` 唯讀對照);各處之判定失敗只記錄、主流程照常(重掃時既有之提示照留)。看板之節點一覽於 `S` 一欄標「單峰交付」、`臂` 一欄標「選集與他節點相同」並於表前列出;**提示之字串與看板之段落不列門檻之值**(節點讀得到;門檻之值只在本文件、規則帳本、state 與 `verifyEvalHints.mjs` 之 `EVAL_HINT`;判定另立此檔,檔名以 `verify` 起首 ⇒ 節點之禁區字樣 `src/domain/verify*` 涵蓋之〔R-BT-10〕);不改 S、階梯、選集指紋、排序鍵與「已試之臂」之計法。
- 主控之工具:`node tools/armDecide.mjs`(審臂目錄之提案)、`node g_rsi.mjs --mode frontier|board|annotate|reverify|extfill|fill`(`fill`:全樹之求解窗後段之附算與擴充診斷之補算,可中斷續跑、已算者不重算;`--dry` 只列計畫並印解析後之選項;輪末只算本輪之節點與待重試者〔輪末摘要另列「來源為命令列之待重試」之個數;強制重算(`--force`)而失敗者留在待重試且下次仍為強制重算,直到成功〕;**以程式呼叫專案物件之 `fill` / `extFill` 者須自行持有與輪次同一把鎖**〔`acquireRunLock(<狀態根>/logs/round.lock)`,結束時 `release`;長時間者以 `fill({ onEach })` 更新心跳〕—— 兩者會改寫樹、節點文件與補算檔,不得與輪次或另一次重算並行;命令列之 `--mode fill` / `extfill` 已代為持鎖)、`node tools/quota.mjs`、`node tools/replayCheck.mjs`、`node tools/fakeRound.mjs`(以假 agent 走完整一輪,不耗模型額度;改流程後之回歸).
- 庫況體檢(主控用;唯讀、只印;規則 R-EV-48):`node tools/libCheck.mjs [--json] [--dir-hi <0 ~ 1>] [--dir-lo <0 ~ 1>]` 由評估帳本列出兩側之策略數與訂單之比例、止盈 / 止損之各候選值之占比、持倉天數之分佈、兩側於訓練期與評估期(另列評估期三等分)之勝率與獲利因子、進場頻率之分佈,並判「方向性之庫」(評估期一側之勝率 ≥ 0.75 而另一側 ≤ 0.30;門檻以參數覆寫);設定(`settings.json`)讀不到(不存在、不可讀、不是合法之 JSON、缺必要欄位)、評估期間 / 求解窗 / 訓練期下界之設定不合、帳本讀不到、參數不合者離開碼 2(訊息一句;設定讀不到者只帶 `settings.json` 之路徑,不帶原錯誤之內容);`initProject` 之後、首次起跑之前由主控執行,不擋起跑;其輸出含評估期內全庫之統計(事後資訊),節點與做夢之 agent 一律拒跑(理由另為一句).
- 節點額度用盡時之行為:主模型(`opencode-go` 之條目)用量達門檻(預設 95)時派工改用 `fallback`.備援為 opencode 之免費池者,用量用盡時 CLI 不會自行結束;偵測與終止由派工套件 `w-dispatch-ai` 負責(其結果 `errorType` 為 `quota`,數秒內回),本套件依此欄判定 —— 派工結果帶 `quota: true`(鏈上每一家皆因額度而未完成,含主模型因用量達門檻而不派;任一家為其他原因之失敗者不標),節點記為失敗且**不重跑驗證、不以半成品入樹**,提案留在前緣待日後重試.額度造成之失敗為暫時性失敗:節點拋出之錯誤另帶 `transient: true`,引擎 `w-recursi`(1.0.12 起)據此於前緣結案時**不消耗重試次數 `retries`**、另記 `transients`,故連續多輪額度用盡不會把該提案封存(其他原因之失敗照舊計 `retries`).引擎之 `frontier.maxTransient`(暫時性失敗之累計上限;預設不設)目前未開放於專案設定,即不設上限.起跑前與連跑時之額度檢查會實際試一次備援,備援亦因額度而不可用即不啟動(離開碼 3;事件 `skipped`,`reason: quota`,帶 `retryAt` = 達門檻之視窗全部重置之時刻);`node tools/quota.mjs --probe` 可先行試算(未給 `--probe` 只看用量、不探測).門檻取 `settings.rsi.preflight.quotaMaxPercent`,各角色另可設 `agents.<role>.quotaMaxPercent`(優先;派工與起跑前之檢查同一個值;大於 100 = 不以用量守門,用到訂閱實際用盡為止,被限流者仍不派).每次 opencode 派工之錯誤輸出(stderr;已經 wsemi 之共用遮罩遮去本次讀到之金鑰)附寫於派工紀錄檔同夾之 `<主檔名>.stderr.log`.額度用盡即止需 `dispatch.skillsRoot` 之 `w-dispatch-ai` 為含此修正之版本(1.0.95 起;技能根經 AI 設定庫更新後取得);較舊之版本下備援用盡時仍會空等至逾時.
- 專案自有之收尾(例如更新專案之指引文件)以輪末回調與事件提供,不寫死在通用層.

## 5. 依賴注入

`makeProject(st, inject)`:`inject.dispatch`(換掉派工器;測試以假 agent 注入)、`inject.catalogFile`、`inject.evalHints`(迴圈檢查之兩條機械提示之判定;測試以拋錯之替身驗各呼叫點之失敗處置;R-REC-44 ⑥).通用層 `createArsi({ records, texts, dispatch, verify, … })` 之每一件皆由外部給定:紀錄之路徑與儲存(`createFileRecords` 或自備同介面之物件)、任務書文字、驗證函數、共用工具區之規則.

## 6. 測試

```alias
npm test
```

| 測試檔 | 案例數 | 範圍 |
|---|---|---|
| `unit-evalCore.test.mjs` | 37 | 評估核心:無前視、執行規則、各虛無、歸因、擴充診斷之介面 |
| `unit-barHours.test.mjs` | 30 | 每根 K 棒之時長之一般化(R-EV-44)與文字不寫死策略庫之事實(R-REC-36):`barHours` 須整除 24(建帳本於讀檔之前檢查;數字字串)、每根 1 日之策略庫之建置與載入、策略檔之 `settings.intervalSec` 之核對(含非整數之近值)、外部序列對不到棒之比例上限(含恰等於之邊界、範圍內無任何列)、`g_build.mjs` 之離開碼;`eval.fitEnd` 與期間之界線之格線(`g_eval.mjs` / `g_backtest.mjs` 之離開碼 2 與 `CONFIG_INVALID` 之結果檔;4 小時之 04:00 不誤拒;迴圈組裝時之預檢與 `g_rsi.mjs`、五個工具之離開碼);數值類設定之數字字串(評估結果與數字者逐位相同);`eval.trainFromStart`(`ntStaticOf` 之 `fromBar`、`g_eval.mjs` 與 `g_backtest.mjs` 之接線〔兩帳本之 `time0` 不同亦各自換算〕、`--period train` 之起點、帳本起點 = 訓練期起點時給與不給逐位相同、設定不合之離開碼 2);每根 1 日之帳本之時間語意與每根 4 小時者等義(決策時刻、星期、日序、回看 30 日、每日下單數、峰值持倉、等效年化、月均單;以時刻獨立計算)、與官方 `runStrategy`(`timeBasis` 為 open 與 span)逐張一致;任務書之隻數(四捨五入至萬)/ 間隔(含 14 日)/ 地平線 / 求解窗 / 回測期長度、看板之基準、節點文件之「下單之做空比例」一列之基準(迴圈之驗證與補算兩個呼叫點之接線;補算重產之補充列與迴圈之驗證所產者逐列相同,含半庫版之說明列)、合約之參考版(`renderContract`:參考設定逐字相同、另一個策略庫之設定逐項改寫;`initProject` 之參考設定、冪等與命令列之 `--bar-hours`)、共同儲存區之保留期起點;組裝時之預檢另含影響評估之數字與期間之另兩端、看板之「虛無 p 於 N 抽之下限」取自 `eval.nullDraws` |
| `unit-evalNums.test.mjs` | 13 | 影響評估之數字(`warmupDays`、`cadenceDays`、`nullDraws`、`actBins`、`sideActHalf`)給了而無效即拒絕(R-EV-44 ④之二、④之三):`cfgNumOf` / `evalCfgNumsOf` 之取值(未給與 `null` 取預設、數字原樣、數字字串轉數值、布林 / `NaN` / ±Infinity / 非數字字串 / 陣列 / 物件 / BigInt 無效、各種類之值域與 `actBins` 之上界 256、訊息依 V19 且不帶輸入值)、日數 × 每日棒數須為整數(每日 6 根與 1 根)、`makeEvaluator` 與 `evalPolicy` 之 `opt.nullDraws`(檢測先於執行挑選函數)、`checkEvalSettings`(含訓練期起點與回測期終點)、`configMsgOf`;命令列:`g_eval.mjs` 之設定不合(quick 與 full;離開碼 2、`CONFIG_INVALID`、不記評估紀錄)、數字字串與數字者之結果逐位相同(嚴格比對,含 quick 之地平線)、`--null` 無效值(負數、小數、非數字、無值,含併 `--period train` / `postfit`)、缺 `periods.*` 不以 TypeError 結束;`g_backtest.mjs` 同 |
| `unit-factsResidue.test.mjs` | 8 | 套件文字不寫死策略庫之事實之殘留掃描(R-REC-36):以各項皆與參考值不同之設定產出合約之參考版(每根 1 日與每根 4 小時)與節點 / 做夢任務書,參考值之字樣(由參考設定之值求得之清單 `PHRASES`)不得殘留;相位數之寫法與「七層」不受影響、虛無抽數與 p 門檻等於參考值者逐字不變、影響評估之數字無效時 `renderContract` / `initProject` / `makeTexts` 拒絕且不寫任何檔、下限之寫法 |
| `unit-ledgerStart.test.mjs` | 27 | 帳本之起點 `startTime` 與一致性核對之下界(R-EV-45):未給 / `undefined` / `null` 之輸出與發布版逐位相同(兩個釘死值:基本輸入;含基礎單位、只有 `summary.numTrade` 之策略檔、`_vbs_` 類因子、非 `>` / `<` 之比較符號、外部序列)、起點之檢查(型別含帶時區字尾於讀檔之前、不在 K 線上 / 不早於終點、其後不滿 100 根;不寫出、訊息不帶值;命令列對假值〔空字串、0、false、空陣列、空物件〕亦拒絕,只有 `undefined` / `null` 為未給)、與外部序列之 `seriesOffGridMax` 並用(起點以前之列不計為對不到棒)、給了起點之帳本 ≡ 未給者只留進場棒 ≥ 起點(每根 1 日與每根 4 小時 × 外部序列與基礎單位;進場由合成資料獨立重算、與官方 `runStrategy` 逐張一致)、帳本鍵、第一個決策 = 起點 + 暖機日數、`meta.check` 之下界(逐策略之各種起點欄之寫法:帳本內 / 未帶 / `null` / 空字串與非字串 / 不在棒上 / 晚於終點;略過之記錄與 `WARN`)、`g_build.mjs` 之 `source.startTime`(起首列與摘要行之鍵與 1.0.30 逐字相同、`--train`、離開碼 2、晚於訓練期起點之 `WARN`〔以時刻比較:訓練期起點寫法不同而同一時刻者不印、非字串者不印〕)與 `g_eval.mjs`、`g_backtest.mjs` 之兩帳本起點核對(R-EV-45 ⑧);變異 `node test/tools/mutateStart.mjs` |
| `unit-fakeRound.test.mjs` | 18 | `tools/fakeRound.mjs` 之量尺之子集一項於該診斷帶近期活躍度版之 `side` 而不過門檻時照常通過(R-REC-38;一併改成過門檻、驗後還原)與擴充診斷之補算(R-EV-45 ⑦;合成帳本與 `initProject` 之參考檔,假 agent):無該診斷之檔 ⇒ 「真實診斷」一項略過(標 `skipped` 與原因)、離開碼 0(含 `--redream --two`);有該檔而第一個節點無其值(以進入檔刪去結果檔內之值造出)⇒ 略過;「真實診斷」取檔之夾 = 評估之子行程之解析(`settings.records.toolboxDir`,未給 = `<rsi.root>/toolbox`):診斷檔只在 `records.toolboxDir` 指向之夾 ⇒ 取得到、值相同(`fill: true`);設定未給 `records.toolboxDir` ⇒ 取 `<rsi.root>/toolbox`;只在預設位置而 `records.toolboxDir` 指向別處 ⇒ 略過(無此診斷);有該檔而診斷拋錯、載入失敗(值為錯誤)或值為 `null` 等非 `undefined` 之假值 ⇒ 失敗(`valueError`、離開碼 15);有值而補算之評估失敗(故障注入)⇒ 失敗(離開碼 15);值正常 ⇒ 行為不變(`fill: true`、值相同、離開碼 0);各情形下自備假診斷(替身評估)之補算通過;「臂目錄之提案 / 擴充」一項(離開碼 8)與節點之派工次序無關(⑦;以 `test/tools/fakeRoundCopy.mjs` 之複本釘死第 1 輪之派工次序):範本第 1、2、3 個節點最先派工、及第 2 個先派工並帶 `--redream --two`,皆離開碼 0 且提案帳、做夢任務書之「本輪節點之提案」、提案者之節點文件三處如預期(提案者恆為計畫第 1 個節點);故障注入(假節點不提提案)⇒ 離開碼 8;故障注入(第 1 個節點派工前把 `plan.json` 改名)⇒ 離開碼非 0(特別之節點讀不到計畫即拋錯,不改以派工次序決定) |
| `unit-fullLedgerHint.test.mjs` | 3 | 全期帳本未建之說明與訊息不指向不存在之 `--full` 旗標(`g_build.mjs` 只有 `--limit`、`--train`;R-EV-45 ⑨):回測期旗標之出口(`makeBacktest().run` 之 `error`)與補算旗標之出口(`domain.validatePending` 之 `why`)改指「由使用端以聚合入口之 `buildLedger` 自建於 `settings.backtest.ledgerDir`、與評估帳本用同一個 `source.startTime`」(未啟用者之字樣不變);盤點 `src/`、`contract/`、`examples/`、`arms/`、`README.md`、`settings.json` 與進入檔無指向 `g_build.mjs` 之 `--full` 旗標之字樣 |
| `unit-evalFingerprint.test.mjs` | 2 | 評估器之指紋(R-REC-34)不含只用於建帳本之 `ledgerBuild.mjs`:評估器之匯入鏈(靜態與動態)不含它;逐檔核對(真實之 `src/eval/` 全部檔名)只改它不變、改任一其他檔或 `cli/eval.mjs` 即變 |
| `unit-evalIntegrity.test.mjs` | 42 | 評估器之狀態不受模組之寫入影響:交出之物件為複本或凍結(改寫 `ctx.prev` / `ctx.meta` / `book` / `tag` 結果不變)、內建物件被改即 `EVAL_INTEGRITY`(挑選函數、`accept`、擴充診斷、模組頂層與延後執行之程式、延遲讀取帳本欄)、ctx 之各函數與逐訊號模擬不經可被改寫之方法;擴充診斷之資料存取(`api.market` / `factor` / `series`)與 `simulate` 等需比對之 api 函數同樣於入口比對(含 `api.replaceNull` 之 `onlyGroups` / `onlyDecisions`);`api.simulate` / `api.summarize` / `api.replaceNull`(`grp`)之複本不經可被改寫之迭代器(替身於 Array / 定型陣列 / `Set` / 陣列迭代器 / `Set` 迭代器之迭代方法,13 種呼叫 × 8 種替身逐組核對);含命令列之載入處 |
| `unit-extData.test.mjs` | 14 | 擴充診斷之資料存取:`api.market` / `api.factor` / `api.series` 之取值與 `ctx` 之同名介面逐位相同、只含棒序 < `bar` 者、`nBack` 之各種寫法、`bar` / `ki` / `name` 之檢查與訊息(不帶輸入值)、帳本缺欄、回傳為複本、api 九個函數之函數物件凍結且每個診斷各一份、不改既有數字、依狀態分組重放之用法 |
| `unit-extReplacePart.test.mjs` | 18 | 擴充診斷之 `api.replaceNull` 只替換一部分之席(`onlyGroups`、`onlyDecisions`):皆未給時回傳不變、「全部」時與未給 / 只給另一個逐位相同、逐席核對(dense 帳本,由訊號還原各抽之選集:未列子帳之席原樣、席數與子帳不變、替換者不重複)、遮罩外之決策無訊號且配對之成品值 = 成品只留遮罩內決策之重放、獨立重算(各抽之選集交 `simulate` 重放,核對均 / 標準差 / p / z / excess / 損益 / 三等分段)、未分帳 ⇒ 不適用、參數之檢查與訊息(V19;不帶輸入值)、形狀以內部槽判定而不經迭代器、重入、不改既有數字與 `selHash` |
| `unit-extFillRandom.test.mjs` | 15 | 擴充診斷之 `api.fillRandom`(R-EV-46):回傳之形狀與確定性、與 `replaceNull` 之一致性(含不匹配活躍度之對照)、全 0 席、活躍度匹配之結構與統計(名次由帳本獨立重算)、目標名次之池(`pool`:未給與 `'toDate'` 逐位相同、`'phase'` 之結構與早段無某側之席時之匹配)、資訊邊界(`'toDate'`:決策棒以後之帳本與狀態不影響較早之決策;`'phase'` 於同一構造下較早之決策會改變)、不足與後備(池為空、鄰域用盡、該側無策略)、輸入檢測與先後、讀取(存取子、代理、`length` 只讀一次)、入口比對與不經迭代器、函數物件凍結且各診斷各一份、重入、不影響其他 api 函數與正本之亂數 |
| `unit-guard.test.mjs` | 32 | 架構邊界(含子行程隱藏視窗之守門與其自驗);agent 操作紀錄之掃描與禁區;半庫版之判定(`isHalfOf`)與補充列之半庫版說明列 |
| `unit-run.test.mjs` | 18 | 執行規模、資源閘、單一執行之鎖、事件檔 |
| `unit-records.test.mjs` | 16 | 節點文件與做夢文件之規格、檢核、渲染 |
| `unit-texts.test.mjs` | 19 | 任務書文字(含「不得改」之程式夾由所在推得、探索類方向之去重說明、前次方向回顧之範本、其他標的之正負號之說明只依 `_cross.json` 之有無且只在共同儲存區之說明內;R-REC-47:做夢任務書 §3「可疑方向」之位置與六種形狀之處置、量尺句與審計規程第 8 點之一句、節點任務書 §6 第 7 條〔去掉後與改前逐字相同之釘死雜湊〕、合約 §5 之判讀名詞) |
| `unit-armCatalog.test.mjs` | 10 | 臂目錄之提案、審定與生效目錄 |
| `unit-backtestGrade.test.mjs` | 10 | 檢定旗標之分級 |
| `unit-score.test.mjs` | 10 | S、階梯與否決 |
| `unit-arsi.test.mjs` | 12 | 通用流程(派工、驗證、任務書皆以假件注入;含額度用盡而未完成之節點不重跑驗證、不入樹,其錯誤帶 `quota` 與 `transient`,額度以外之失敗不帶) |
| `unit-frontierTransient.test.mjs` | 4 | 額度失敗不消耗前緣重試之接縫:真 `w-recursi` + 真領域,只把派工換成假的;額度用盡 ⇒ 前緣提案維持 `proposed`、`retries` 不增、`transients` 逐輪加一,一般失敗照舊計 `retries` 至封存 |
| `unit-dispatchQuota.test.mjs` | 26 | 派工之額度處置(派工套件以替身注入):結果帶 `quota`、用量門檻(全域與各角色)、錯誤輸出留存與遮罩、起跑前之備援探測與 `retryAt` |
| `unit-quotaCli.test.mjs` | 6 | 額度處置之接線:以命令列程式於合成專案根實跑(替身派工套件),驗起跑前與連跑時之探測、事件 `skipped` 之 `retryAt`、門檻經領域層傳到派工器、`tools/quota.mjs --probe` |
| `unit-package.test.mjs` | 12 | 發布面、依賴、聚合入口之站點全集(79 鍵:函數 63、常數 16;`memberLedger` 併入;基礎單位之 `isCapitalError`、`normUnit`、`sameUnit` 併入)、專案根之錨點、`initProject`、去識別(本機路徑、內網主機名與位址之通則檢查與其自驗);於 npm 包內(無 `.git` 亦無 `.gitignore`)略過 `.gitignore` 之列項檢查、掃描範圍改為包內全部文字檔 |
| `unit-toolbox.test.mjs` | 7 | 共用工具區之機械檢查 |
| `unit-toolboxRewrite.test.mjs` | 10 | 共用工具區之已發布之檔於檔頭註解以外不得改寫(R-TB-6):檔頭之判定與本體之比對、改寫還原與只改檔頭註解照留、`metrics/` 第一層之例外、自檢之基準檔、專案物件與命令列之接線 |
| `unit-testResources.test.mjs` | 2 | 測試之合成設定不沿用參考設定之資源閘(R-RUN-10;靜態守門) |
| `unit-envChangedHint.test.mjs` | 5 | 節點任務書之口徑提示(R-REC-35):評估環境之鍵於方向寫定後改變 ⇒ 來源方向之前列一句固定之提示(含端到端之派工之任務書) |
| `unit-guardInline.test.mjs` | 18 | 操作稽核之內嵌腳本(R-BT-5):比對式不列為觸及禁區、被去掉之片段含禁區字樣者列待核對、不變式(原指令命中之字樣必在兩類之一)、實際之存取照列、腳本之選項不當內嵌腳本、畸形指令之判定時間、比對函數之清單逐一、跳脫之雙引號之重組(其後 grep 之樣式照去)、一頁摘要(`roundDigest`)之待核對一列 |
| `unit-scanListRoot.test.mjs` | 7 | 操作掃描之「列出工作夾之根」只列以之為目標者(R-BT-6):兩種紀錄之格式 × 路徑分隔 `/` 與 `\`;字樣只在 grep / rg / findstr / Select-String 之樣式引數內者不列(`-e`、`--regexp`、帶值之選項、`--`、重導向、管線之後段);以根為目標者、路徑引數為根之上層或無路徑之遞迴者、無法解析者(變數、命令替換、引號、群組、未知之選項或指令、指令本身含佔位符所用之控制字元〔不拋錯〕)、工作目錄不確定者照列;指令以外之欄、他節點 id 與其他判定照舊 |
| `unit-agentGuard.test.mjs` | 8 | 進入檔之拒跑(R-RUN-11):角色之辨識、判定表之各類、理由之原文(不帶輸入值)、各入口於讀設定之前呼叫一次;合成專案實跑 —— 帶角色之寫入模式與工具離開碼 2、只印一行、專案夾之雜湊不變;唯讀之模式與工具、任務書之指令(`g_eval` 之 quick / full / `--ref`、`g_toolbox`)帶與不帶角色之輸出逐字相同;未設角色者之改前原文 |
| `unit-agentDispatchEnv.test.mjs` | 2 | 派工器設角色之環境變數(R-RUN-11):真 w-dispatch-ai 經 `makeDispatch` 派 node / dream / 其他角色,外部 CLI 以記錄環境之程式代之(無 w-dispatch-ai 者略過);假 agent 之整輪 —— 節點執行 `g_rsi.mjs --mode validate`、做夢執行 `--mode board` 皆被拒,節點文件之迴圈檢查列出該指令與遞迴列出,控制端之重掃與唯讀對照保留之 |
| `unit-scanEntryExec.test.mjs` | 11 | 操作掃描之兩項新判定(R-BT-7):執行寫入之進入檔(路徑前綴、`/` 與 `\`、引號、前綴、無法解析者從嚴;唯讀之模式、任務書之指令、讀取類之引數、寫入文件之文字不列)、遞迴列出狀態根或其上層(各指令、殼層之 `-c`、xargs、here-doc、內嵌腳本、工作目錄、搜尋 / 列目錄工具、寫入之程式檔);做夢只查前者;合規之指令兩項皆不列 |
| `unit-signsNarrow.test.mjs` | 4 | 輪末摘要之「待核對」之收窄(R-REC-39):組成對照 / 重放 / 同分次序之同號 / 異號之句不列;保留期 / 他標 / 他幣 / holdout、其他之「號」、未提三詞、主詞在另一句者照列;句末之全形與半形標點、逗號不切;欄級;改前之回傳之字面值 |
| `unit-cmdScan.test.mjs` | 3 | 操作掃描所用之指令解析模組 `src/domain/verifyCmdScan.mjs`(原 `cmdScan.mjs`;改名使節點之禁區字樣〔`src/domain/verify*`〕涵蓋之,R-BT-10;R-BT-6、R-BT-7、R-BT-8、R-RUN-11):① 搜尋樣式取自檔(`grep` 族與 `rg` 之 `-f` / `--file` / 短選項群含 `f`、`findstr` 之 `/G:`、`rg --files`;含選項置於運算元之後)⇒ 其後之第一個非選項引數是路徑、禁區之路徑照查,有樣式者照去;② `ARSI_HARNESS` 與 `ARSI_AGENT_ROLE` 同一條禁區字樣、同一個標籤(節點與做夢;搜尋樣式內者做夢不列);③ 結構(引號遮蔽只一份、常數不重複、解析函數只在 verifyCmdScan.mjs) |
| `unit-searchMapRecent.test.mjs` | 4 | 搜尋地圖之「有內容」與近期活躍度版之組成對照(R-REC-38;真 `w-recursi` 之樹 + 真領域之 `writeBoard`;⑥ 量尺之「挑選內容」與看板之均之取值:超額為有限數值、NaN / ±Infinity / 字串 / 缺 / 帶 `error` 者視為無值、有限值不變、只給超額不給 p 者仍取其超額):無值之九種形與不帶此鍵者之搜尋地圖與看板逐字相同、說明與譜系之列為改前原文;兩版之四種組合與邊界、譜系與看板之「活躍度定義不一致」、量尺 / 子集 / 各層之覆蓋 / 集中度不計入;否決與 notContent 之排除;門檻取自設定 |
| `unit-rankKey.test.mjs` | 10 | 排序鍵(R-REC-40):`rankKeyOf` 之定義(無重放 = S 逐位相同、均、各抽全相同者取該值本身〔不留 1 ULP 尾差〕、中性執行之差之三種來源與無值之形);真之樹與領域:無重放與次序不變之重放 ⇒ 改前之原文與次序,次序改變 ⇒ 看板之次序與各臂之最佳、搜尋地圖之各「最高」、任務書之參考節點、補位之底之字面值,分母型之成品不為最佳,無值之形 ⇒ 各檔逐字相同,同鍵之次序 |
| `unit-fillBacklog.test.mjs` | 17 | 輪末之附算一併處理待補算(R-REC-41):取用者中有失敗者不寫「已補齊」、改註失敗之個數(⑧;`fillLinesOf` 與輪末鉤子:暫時性、重跑結果相同、本輪之成品之失敗不計)、設定之取值、摘要之列、先後與「與 `--mode fill` 所得之值、鍵、評估之參數相同」、新增診斷後之下一輪、上限(假時鐘)與續算、併行時過資源閘後之再核、失敗之分類與待重試之排除、無待補算者逐列不變、只做夢輪次、`--mode fill` 不變、做夢任務書之一句;不重試之失敗之紀錄(待算之鍵之指紋、記入 / 略過 / 改版後再取 / 命令列不略過 / 移除、舊狀態檔與無此類失敗者不變、本輪之成品之失敗於下一次輪末略過) |
| `unit-replayExt.test.mjs` | 16 | 迴圈之重放一併載入擴充診斷(R-REC-42):`'board'` 另加正本之 `neutralExec`(其 `delta` 有值者,不論有無看板值;⑧:引數、重放之紀錄帶各抽之 `delta`、排序鍵依各抽之差計與用正本之差者可分辨;正本之 `neutralExec` 無值、`'none'`、名之陣列、`'all'` 之範圍)、範圍之設定與引數、紀錄之摘要、看板值之均、`notesOf` 與看板之改前之字面值;子行程(合成帳本 + 真之評估入口):預設之範圍與結果檔、重放之 S 與既有兩項不變、拋錯之診斷、完整性錯誤之再重放、無診斷之專案、`'all'`、另載入會抽亂數之診斷(檔名序在 `nullRecentAct` 之前與之後各一)時 `none` / `board` / `all` 三者之重放之 S、組成對照、近期版與 `nullRecentAct` 之輸出逐位相同(⑤)、近期活躍度版之診斷之各形(帶 `error`、超額為字串、只給超額)於重放之紀錄與重放一列之取值(R-REC-38 ⑦) |
| `unit-verifyZone.test.mjs` | 5 | 節點之禁區涵蓋迴圈驗證之全部原始碼(R-BT-10;④ 另涵蓋庫況體檢之程式 `src/domain/libStats.mjs`、`src/tools/libCheck.mjs`:節點讀取、匯入皆列,執行照列「執行迴圈之寫檔入口」,其他檔不列):`src/domain/` 下檔名以 `verify` 或 `backtest` 起首之每個檔(含 `verifyCmdScan.mjs`、`verifyEvalHints.mjs`),節點讀取(路徑、指令、`node_modules` 下之套件夾)皆列「觸及禁區」;節點任務書「不得讀取迴圈驗證之原始碼」一句所列之檔名樣式(`backtest*.mjs`、`verify*.mjs`)與禁區字樣同一組(不寫 `verify.mjs` 單檔、不另列未涵蓋之檔);判定不置於非 `verify` 起首之檔(改名前之 `cmdScan.mjs` 讀之不被列 —— 邊界) |
| `unit-scanAllowWork.test.mjs` | 7 | 操作掃描之「可讀之他節點工作夾」(R-BT-9;迴圈驗證、`--mode validate` 之重掃與 `tools/scanCheck.mjs` 共用 `verify.mjs` 之 `dirWorkIdsOf` / `dirNodeIdsOf` / `allowWorkOf`):三函數之各值與邊界(前綴 8 ~ 16 碼、對應不唯一不算、主張 / 依據 / 預期之範圍、根之字元當字面、次序);真之樹:方向內只以 id 前 8 碼指名之節點 ⇒ 重掃與 `scanCheck` 同列未指名者、重掃後 `scanCheck` 為「相同」(修前 `scanCheck` 另把被指名者列為觸犯)、任務書之參考列方向指名之節點、三處不各自再算一份(結構) |
| `unit-evalHints.test.mjs` | 23 | 迴圈檢查之提示「單峰交付」與「選集與他節點相同」(R-REC-43、R-REC-44):參考檔之定義(單一來源)、所計之列之篩選、單峰交付之四個條件與邊界(相異 5 / 6 個、S 為 0 / 負、同分、中位恰一半 / 略低、偶數個之中位、同一指紋多列取最後一列)與字面值、兩種句式與「只對方多出者不列」、驗證類之指名(起點、方向內之前綴、前綴不唯一)、兩方皆驗證類之同臂(不列)/ 不同臂(列)、一方驗證類一方探索類(列)、同時命中應列與不列者、多個命中之次序與上限與所列之檔、雙向、紀錄缺 / 空 / 壞、agent 結束之後之列;真之樹與領域:輪末鉤子(假做夢;派做夢之前與處置之後)、`--mode validate` 之重掃、`reverify` 之後、看板之標記與表前一段(未觸發之樹不含其字樣、表頭為改前原文)、提示之字串與看板之段落不列門檻之值(以常數動態比對)、判定拋錯時之四個呼叫點(注入;只記錄、主流程照常、重掃時既有之提示照留)、節點文件已寫而樹之更新拋錯者再呼叫時補樹、`tools/scanCheck.mjs`(子行程;唯讀);結構:判定與門檻只在 `src/domain/verifyEvalHints.mjs`(`verify.mjs` 不含、不匯出;聚合入口不加) |
| `unit-recentDiag.test.mjs` | 5 | 近期活躍度版之組成對照之「有值」之唯一判準(R-REC-38 ⑥ ⑦):取值函數 `recentDiagOf`(有限值回 `side`、其餘十四種形與七種缺 / 非物件之 `metrics` 回 `null`);節點文件之重放一列(有限值 ⇒ 改前原文、無值之形 ⇒ 不列「(正本 …)」);共同儲存區 `infoOf` 與 `buildPickStore`(有限值之 `backtest.content` 逐位不變、無值之形 ⇒ `recent` / `pRecent` 為 `null`、`mean` = 內建之超額) |
| `unit-mutateIds.test.mjs` | 3 | 變異工具之編號唯一(R-PKG-9):`dupIdsOf`;`mutateBar.mjs`、`mutateStart.mjs` 之 `--check` 於複本之專案根實跑(植入重複之編號 ⇒ 列出、離開碼非 0、不跑錨點;無重複 ⇒ 印編號唯一之項數) |
| `unit-briefTrials.test.mjs` | 6 | 任務書條款之隨機對照 |
| `unit-aliasBase.test.mjs` | 15 | 起點為別名(選集與較早之節點相同)時之一致處理(R-REC-45;真 `w-recursi` + 真領域 + 假做夢):補位之底不取別名(別名之 id 較小 / 較大、排序鍵較高、正本不合底之條件、無別名之字面值與別名表之求值次數、別名表取不到)、前置閘門之別名訊息、方向之起點為別名者改掛(note / `baseUsed` 之字面值、重提去重、主張鍵與區分用之鍵、否決、節點之來源方向對應、迴圈註記、輪末摘要) |
| `unit-sgudUntouched.test.mjs` | 4 | 測試不得改寫入版控之文件(R-PKG-10):輪末鉤子之專案文件自動整理(R-REC-17)以 `FD_ROOT` 之 `sgud` 為對象,建專案且走到輪末鉤子(`afterRound`、`redream`)之測試檔須設 `st.rsi.docLimits = false`(判定函數之合成夾案、本庫測試夾之違規 0 與已知 10 檔);快照差異(新增 / 刪除 / 變動,含只有修改時間不同者);另有動態守門 —— 同一次執行內每個測試前後比對本庫 `sgud` 各檔,有變動者於全部測試之後一併失敗並列出測試與檔名 |
| `unit-claimKey.test.mjs` | 8 | 驗證類方向之主張鍵;探索類方向與既有節點同臂同起點時另帶區分用之鍵(含已執行者逐字重提之略過);輪末摘要「方向未入前緣」各行 |
| `unit-pickLoader.test.mjs` | 4 | 挑選模組之靜態檢查與載入 |
| `unit-pickStore.test.mjs` | 11 | 共同儲存區;挑選模組載入時(含延後執行之程式)改了內建物件 ⇒ 中止更新(不寫任何檔、拋 `EVAL_INTEGRITY`;命令列工具離開碼 3);同行程前次已被改者入口即中止 |
| `unit-pickStoreCross.test.mjs` | 9 | 共同儲存區之其他標的之正負號(`_cross.json`;R-REC-30):無此檔或形狀不合時各產出檔與 1.0.17 逐位相同、有此檔時插兩欄與 `cross` 鍵、只收 `"+"` / `"-"` / `"0"`(其他值忽略並計數、不帶進任何產出檔)、`infoOf` 之直接呼叫、命令列之統計;保留期之 `_holdout.json` 同樣只收號(數字不進任何產出檔) |
| `unit-pickStoreExt.test.mjs` | 3 | 共同儲存區之各列帶各擴充診斷自帶之 `board` / `flag` / `notContent` / `subset`(`ext`;R-REC-31):原值不改寫、有無之判定同看板(`extSurfaceOf`)、出錯者只有 `error`、與節點文件同一份值、欄位定義與 README、總表之欄不變 |
| `unit-fillPlan.test.mjs` | 12 | 附算與補算之計畫(R-REC-34;純函數):待算清單與待補算、快取之鍵(成品之內容雜湊、評估器之指紋、診斷之內容雜湊)、診斷之登錄(改寫 ⇒ since)、`force` 只作用於 `targets` 內、`forced`(強制重算而失敗者續為強制重算,只作用於 `targets` 內與本次所計畫之項目)、參數檢查(V19、V20)、求解窗後段之值(原值;近期活躍度版有則帶)與摘要之列(含輪末之「來源為命令列之待重試」列)、補算檔之內容、共同儲存區之 `postfit` 欄、一頁摘要之列 |
| `unit-fillRun.test.mjs` | 5 | 附算與補算之執行(R-REC-34;真之樹、節點文件、補算檔、共同儲存區與輪末鉤子,只有評估之執行本身為替身):全樹之第一次補齊(正本之結果檔與分數不動、補算檔、節點文件之摘要一列、共同儲存區)、再跑不重算、待補算與待重試、選集指紋不同者不併入、成品重做 / 診斷改寫 / 評估器之指紋變之重算、`extFill` 之回傳形與同步、輪末鉤子之範圍(本輪 + 待重試)與摘要、拋錯不影響輪次、`autoFill: false` |
| `unit-fillCli.test.mjs` | 4 | `g_rsi.mjs --mode fill`(R-REC-34;子行程、不用替身:合成帳本 + 真之評估入口):`--dry` 只列計畫且不寫檔、參數不合之離開碼 2、有輪次之鎖之離開碼 3、父行程帶改帳本之環境變數而子行程收不到、實跑之值 = 以評估入口直接跑 `--period postfit` 之結果(逐位)、完整結果檔、共同儲存區之 `postfit`、不記入節點之評估紀錄、再跑不重算、狀態檔未寫成之離開碼 5;旗標之解析(`--force`、`--no-postfit`、`--ext`〔名單 / `none` / 不存在之名〕、`--only`、`--null`、`--par` 與設定之 `fillParallel`;`--dry` 與實跑皆印「選項(解析後)」一列)及其對實際評估之作用;`--mode extfill` 於狀態檔未寫成時之離開碼 5 |
| `unit-fillRevise.test.mjs` | 43 | 附算與補算之採信、失敗分類與一致性(R-REC-34;只有評估之執行本身為替身):補算檔只讀狀態根、寫檔失敗轉為該成品之失敗、寫入之序(併入失敗仍待算、補算檔未寫成則重算)、待重試之次數、上限與來源(輪末只重試來源為輪末者;輪末摘要列來源為命令列之個數)、強制重算(`--force`)而失敗者留在待重試且帶 `force`、下次重試仍為強制重算直到成功、狀態檔損毀、遺失與未寫成、結果檔須為本次之輸出、`{ error }` 與部分缺值不補入而記失敗、原子寫入、節點文件之補回、指紋讀不到即拒絕、研究用本金與評估器版本常數(`EVAL_VERSION`;單一定義,只改該常數 ⇒ 附算過時、共同儲存區之 `current` 為 `false`)併入指紋、重跑結果相同之失敗不重試、本輪無節點不附算、殘留暫存檔不採信、中斷之暫存檔之清除、輪末之附算拋錯不影響輪次、`extFill` 之回傳之既有欄位、打包進主入口時之指紋、併行數 `settings.rsi.fillParallel`(K3、K4、K7)、`autoFill` 只有 `false` 關閉、資訊界線(不讀不寫 `_holdout.json`、`_cross.json`) |
| `unit-loaderRewrite.test.mjs` | 10 | 載入器(`loadPick`、`loadExt`)之匯入快取鍵 = 本次所讀原始碼之內容雜湊:同一路徑連續寫入不同內容(以 `utimes` 把修改時間釘成同一值,不依賴計時)各載入一次,每次執行到的皆為該次寫入之內容;內容相同者共用同一份模組、實體檔不同者各有其模組;A → B → A;讀檔與匯入之間來源檔被改動 ⇒ `PICK_CHANGED` / `EXT_CHANGED` 且該鍵不再被信任(重讀不到、匯入失敗者亦然;經實體路徑與目錄連結路徑一致);因完整性錯誤被拒者還原內建物件後同內容再載入仍被拒;CRLF 與 BOM 不誤判 |
| `unit-memberLedger.test.mjs` | 18 | 成員重抽(`memberLedger`、`L.srcIdx`、`g_eval.mjs --member`;含空半庫、已結單欄之獨立重算、失敗之結果檔與評估紀錄之 `member`、旗標重複):`tieBaseOf` 與原寫法逐值相同、兩半互補且各欄(含每策略 3 值之 `cls`、段長不一之進場規則欄)與全庫逐位相同、逐棒之欄共用、半庫上之評估器所見(`ctx.n`、`tie`、`ntAll`)、「全庫限半庫」與「半庫帳本」之評估結果逐值相同(含持倉上限下之同棒次序)、半庫內再切、參數與 `L.srcIdx` 之檢查(訊息不帶輸入值)、入口比對內建物件、命令列之標記(結果檔、評估紀錄含失敗者、畫面)與格式不合之離開碼 2;`memberLedger` 與聚合入口之 JSDoc `@example` 取出實跑(R-PKG-7) |
| `unit-subsetLedger.test.mjs` | 19 | 子庫(R-EV-47;`parseSubsetRule`、`subsetMaskOf`、`subsetLedger`、`g_eval.mjs --subset`):正規化之字面值、格式不合之各形(固定訊息、不帶輸入值)、`rand:0.5:<鹽>:<h>` 與 `memberLedger` / `--member` 之所留逐隻相同且結果檔除規則欄外逐位相同(兩半)、各屬性帶(float32 之界、兩端含、空界)、`hold`(進出場皆在訓練期內之單、出場在終點之後之單不計、無單者去除)、`side` / `siderand`、`nofam` 與 `nofam:top`(家族之切段、去除之次序與停止、所去除之家族)、交集、子庫帳本之各欄與巢狀、參數檢查、空子庫、`ctx.meta.tie`、兩條機械提示不計子庫之列;命令列之結果檔與評估紀錄、`--ref` / `--ext-test`、失敗之結果檔、不合者之離開碼 2、帶等號之 `--subset=…` / `--member=…` 之拒收(十種組合)、空子庫之警示(留 0 隻者有、留 ≥ 1 隻者與未給者無) |
| `unit-libCheck.test.mjs` | 6 | 庫況體檢(R-EV-48;`libReportOf`、`libTextOf`、`directionalOf`、`tools/libCheck.mjs`):各量與獨立之算式相同(逐單依進場棒歸期;三等分)、方向性之庫之邊界與門檻、命令列之 `--json` 與文字之輸出 = 函數之結果且不寫任何檔、方向性之庫之實例、參數不合與帳本讀不到之離開碼 2、設定讀不到(不存在、為資料夾、不合法之 JSON、缺欄位)之離開碼 2 與固定訊息、agent 一律拒跑與其理由 |
| `unit-evalCli.test.mjs` | 10 | 命令列對 `L.ntStatic` 之接線:`g_eval.mjs` 兩條路徑(帳本涵蓋回測期 / 只涵蓋訓練期)與 `g_backtest.mjs`(標準配置:評估帳本 = 全期帳本之前綴)實跑,`ctx.meta.ntAll` 只計訓練期之進場數;`g_backtest.mjs` 之帳本一致性核對(以評估帳本自身之訓練期進場數與全期帳本逐策略比對):標準配置不誤報、評估帳本之訓練期進場數少一筆 / 多一筆 / 策略數不同皆拒絕(離開碼 5)、全期帳本與評估帳本同終點不誤報、評估帳本之 `time0` 或棒長(`barHours`)不同(同一時刻之進場)不誤報、評估帳本無法載入(缺檔 / 缺 `meta`)與核對之前提不合(`off` 欄長度、`time0` / `barHours` 無效含負棒長、帳本未涵蓋訓練期終點)皆明確訊息與離開碼 5 |
| `unit-extApiInput.test.mjs` | 16 | 擴充診斷之 `api.simulate` / `api.summarize` / `api.replaceNull`(`grp`)之輸入:複本之可接受種類(陣列、定型陣列、`Set`、物件形式)之結果逐位相同、其他種類拒收、錯誤訊息依 V19、V20(英文、指明名稱與期望、帶索引、不帶輸入值;讀取拋錯者無效而不透傳)、形狀不合者於比對內建物件之後才拋、檢查之先後、挑選函數之回傳值之可接受種類不變(迭代器之偵測見 `unit-evalIntegrity`)、選集內容之錯誤依 V19(帶索引、不帶值)、讀取拋錯與元素轉型拋錯視為無效而不透傳、結構檢查與 `replaceNull(null)` 亦於比對之後才拋、錯誤之優先序與邊界 |
| `unit-evalPostfit.test.mjs` | 27 | 只留求解窗已結束之席(`opt.afterFitOnly`)與 `g_eval.mjs --period postfit`:參數檢查與只讀一次、未給時逐位不變、兩種方向之逐席判定與邊界(含終點 = 帳本起點、早於帳本起點)、等同挑選函數自行只回所留之席(含分帳)、`ctx.prev` 不受影響、分段與以公開方法重算者相同(含 `sideActHalf`、`sig.k` / `sig.tag`);命令列之段之起訖與邊界、`score` 為 `null` 且不印判讀列、畫面數字、擴充診斷不載入、可併用與拒絕之各情形(每個所評估之相位須有決策棒)、預設值、任務書不提此選項(做夢任務書只有 R-REC-37 之一句) |
| `unit-evalPostfitRecent.test.mjs` | 6 | 求解窗後段之近期活躍度版之組成對照(`afterFit.sideActRecent`;R-EV-42):全段與前段 / 後段 = `api.replaceNull({ actDays: 90 })` 於同一選集、同一亂數種子之結果(逐值;兩種方向 × 兩個種子 × `half` 50 / 3 / 0)、替換池之抽查(獨立計算之池;做多與做空;鑑別前提:累計進場數之池與不分方向之池皆不同)、只增輸出(鍵與其次序、抽數取自 `opt.nullDraws` 且 > 64 時不設上限、未給 `opt.afterFitOnly` 時無此欄)、有組成對照時才有;命令列之一行(內容、位置、未算、其他期間不印) |
| `unit-outwardSaturated.test.mjs` | 26 | 向外飽和之宣告:`outwardNoteOf` 之 `saturated`、任務書之例外之二(`context.outward.nUntried === 0` 才列)與範本、做夢文件之 `outwardSaturated`(檢核、計數、渲染)、輪末鉤子(真 `w-recursi` + 真領域 + 假派工:任務書與摘要之兩個時點〔含與向外之判定連動〕、「已試之臂」之口徑〔`offDefArms`、`inactiveArms`〕、補做夢之路徑、每輪重申);向外飽和之標示(R-REC-46):`saturatedLineOf` 之字面值與未宣告之各種形、輪末鉤子之「向外飽和」一行(已宣告 / 未宣告、預先核對達門檻、方向 0 條、尚有未試之臂) |
| `unit-reworkId.test.mjs` | 1 | 評估環境之鍵改變後之重做與展開(R-REC-33;真 `w-recursi` + 真領域 + 假派工):帳本重建而鍵改變、全樹重算後節點與其 id 不變且不另建以新 id 為名之工作夾;算子自舊節點展開之起點 = 父節點於樹上之 id(存在、閘門通過、理由文字用同一 id;同規格之非已執行之存根不取、快速路徑命中之存根〔非已執行〕而同規格另有已執行者 ⇒ 取已執行者、對照表所選之 id 被刪除 ⇒ 重建後再取);做夢判舊節點重做 ⇒ 工作夾與複本、參考清單不含自己、沿用隨機對照之組別;鍵未變時行為不變 |
| `unit-evalUnit.test.mjs` | 46 | 下單之基礎單位(R-EV-43):設定之檢查與數字字串(通過即轉為數值、`'0.001'` 與 `0.001` 同鍵、每欄只讀一次、訊息不帶值)、每根棒之名義(獨立之整數算式)、帳本之建置與載入(帳本鍵、`unitStat`、單一策略之峰值只記錄、半庫共用)、評估器之實際名義口徑(獨立之定義;挑選與執行規則所見者不變;研究用本金之檢查)、未給設定時評估結果各物件之鍵之次序與 1.0.21 相同、命令列(`g_build.mjs` 與 `g_eval.mjs` 之比對、離開碼與結果檔)、相依之隔離(回測套件不含 `calcBaseUnitQuantity` 時未給設定之路徑照常)、領域接線(`envKey`、重跑失敗之 `code`、啟用後之全樹重算)、聚合入口之匯出 |
| `unit-ledgerReal.test.mjs` | 3 | 真實帳本與官方回測逐張一致(本機無策略庫與帳本時略過) |
| `unit-archiveDocs.test.mjs` | 2 | 指引文件之自動整理 |
| `unit-guides.test.mjs` | 2 | 寫法守則 |

## 7. 限制與注意

- 只能於 Node.js 執行;Windows 下所有子行程皆隱藏視窗.
- 任務書與文件為繁體中文.
- `tools/fakeRound.mjs` 與 `unit-ledgerReal` 需要專案已建好之帳本.`tools/fakeRound.mjs` 之「擴充診斷之補算」之「真實診斷」一項以正式之共用工具區(`settings.records.toolboxDir`,未給 = `<rsi.root>/toolbox`;與評估之子行程載入擴充診斷之位置為同一個解析)有該診斷之檔(工具內寫死之既有名稱)且第一個節點有其(非錯誤之)值為前提:無該檔、或有該檔而第一個節點無其值者該項略過 —— 輸出標 `skipped` 與原因,不計為失敗、不影響離開碼(全新之專案尚無任何擴充診斷);有該檔而第一個節點之值為錯誤(診斷載入失敗或拋錯,輸出標 `valueError`)或為 `null` 等非 `undefined` 之假值(評估器不產生)、或有值而補算失敗者為失敗(離開碼 15,同改前;「無其值」只認 `undefined`).「自備假診斷」一項(以替身取代評估之子行程,只驗補算之接線)不依賴共用工具區、恆執行,不合另印專屬之一行、仍為離開碼 15.「臂目錄之提案 / 擴充」一項(離開碼 8)之提案者(假節點中自報可共用之輔助與未作用之臂、提臂目錄之提案者,即「特別之節點」)為第 1 輪之計畫第 1 個節點(= 做夢範本之第 1 個 = 假做夢之採納者),與節點之派工先後無關(實跑時派工先後由派工前之閘〔資源閘〕之放行次序決定,全機負載高時不定).`unit-fakeRound` 以合成帳本跑通整個假輪次.
- 命令列程式與工具是指令稿,不在聚合入口內;請經專案根之進入檔執行.
- 進入檔之拒跑(`ARSI_AGENT_ROLE`;R-RUN-11)是防誤用而非防惡意:agent 自行清除此變數再執行者不被擋,其寫入模式之執行由操作掃描列出(R-BT-7);提到此變數之工具輸入亦列為觸及禁區(區分大小寫,同 `ARSI_HARNESS`).做夢之操作稽核去搜尋指令之樣式(R-BT-8)之已知不修:`ag` / `ack` 之 `-f`、`-e` 附值(`-efoo`)與置於運算元之後之 `-e` 之情形下,被搜尋之路徑可能被當成樣式去掉(既有;`-f` 檔 / `/G:` / `rg --files` 者已不去).自行以程式呼叫專案物件(`makeProject`)者不經進入檔,不受此拒跑.
- 節點 agent 不得讀取迴圈驗證之原始碼(本套件之 `src/domain/backtest*`、`verify*`)與以目錄方式涵蓋套件之程式夾;操作掃描已涵蓋 `node_modules/w-trade-adaptivess/src`.
- **領域接線假定專案根有 `sgud/`**(指引要求文件之配置):做夢須更新 `sgud/state/state.md` 與 `sgud/exp/experience.md`(輪末檢查;未更新者該輪判為失敗),改進項逐筆寫入 `sgud/feedback/feedback.md`,寫法守則在 `sgud/proc/guide_dream.md`、`sgud/proc/guide_node.md`(有則附於任務書);經驗檔與回饋檔逾上限時自動把較舊之內容搬出.做夢之寫入範圍亦含 `sgud/`.不採此配置之專案須自備這些檔,或另行改寫領域接線(日後擬改為輪末回調,由專案注入).
- **`dispatch.skillsRoot` 之預設**為行程使用者之家目錄下之 `.claude/skills`(以 `os.homedir()` 推得,不寫死使用者名;`src/cfg.mjs`),`w-dispatch-ai` 須安裝於 `<skillsRoot>/node_modules/w-dispatch-ai`.其他環境請於 `settings.json` 明給 `dispatch.skillsRoot`,或以 `inject.dispatch` 換成自己的派工方式.額度用盡即止所需之 `w-dispatch-ai` 版本見 §4 之「節點額度用盡時之行為」.

## License
MIT
