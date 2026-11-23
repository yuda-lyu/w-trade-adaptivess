import { guardEntry } from '../domain/agentEntries.mjs'
import { getSettings, argStrOf, P, cliGuard } from '../cfg.mjs'
import { loadLedger } from '../eval/ledger.mjs'
import { trainFromBarOf, checkEvalSettings, periodAt, configMsgOf } from '../eval/barGrid.mjs'
import { libReportOf, libTextOf, LIB_DIR_HI, LIB_DIR_LO } from '../domain/libStats.mjs'

//agent(ARSI_AGENT_ROLE = node / dream)⇒ 一律拒跑(離開碼 2; 於讀設定之前): 本工具之輸出含評估期內全庫之統計(事後資訊), 只供主控(規則 R-RUN-11、R-EV-48)
guardEntry('libCheck')
//命令列之旗標只認 --json、--dir-hi <0 ~ 1>、--dir-lo <0 ~ 1>(TOOL_FLAGS.libCheck): 等號、未列、重複、多餘之值一律拒收(離開碼 2; 於讀設定之前; 訊息固定、不帶輸入值);
//  --dir-hi、--dir-lo 之無值與值不合沿用下方 rateArg 之固定訊息(own)
cliGuard('libCheck')

//庫況體檢(主控用; 唯讀、只印, 不寫任何檔; 規則 R-EV-48): 由評估帳本(settings.eval.ledgerDir)列出策略庫之組成, 供 initProject 之後、首次起跑之前判讀(不擋起跑)
//  node tools/libCheck.mjs [--json] [--dir-hi <0 ~ 1>] [--dir-lo <0 ~ 1>]
//  ① 兩側之策略數與訂單之比例 ② 止盈、止損之各候選值之占比 ③ 持倉天數之分佈 ④ 兩側於訓練期與評估期(另列評估期三等分)之勝率與獲利因子
//  ⑤ 進場頻率之分佈 ⑥ 方向性之庫(評估期一側之勝率 ≥ --dir-hi〔預設 0.75〕而另一側 ≤ --dir-lo〔預設 0.30〕)—— 計算與定義見 src/domain/libStats.mjs
//  期間: 訓練期 = [訓練期之下界(eval.trainFromStart 者為訓練期起點, 否則第 0 根), 訓練期終點); 評估期 = [回測期起點, min(回測期終點, 帳本終點))
//  --json: 同內容以 JSON 印出; 離開碼 0(含方向性之庫); 設定(settings.json)讀不到或不合、帳本讀不到、評估期間 / 求解窗 / 訓練期下界之設定不合、參數不合 ⇒ 2(訊息不帶輸入值; 設定讀不到之訊息只帶 settings.json 之路徑)
let RE_RATE = /^(?:\d+(?:\.\d+)?|\.\d+)$/
let rateArg = (k, def) => {
    let v = argStrOf(k, null)
    if (v === null) {
        return def
    }
    let x = typeof v === 'string' && RE_RATE.test(v) ? Number(v) : NaN
    if (!(x >= 0 && x <= 1)) {
        console.log(`invalid --${k}: must be a number from 0 to 1`)
        process.exit(2)
    }
    return x
}
let dirHi = rateArg('dir-hi', LIB_DIR_HI)
let dirLo = rateArg('dir-lo', LIB_DIR_LO)

//設定讀不到(settings.json 不存在、不可讀、不是合法之 JSON、缺必要欄位)⇒ 離開碼 2, 訊息一句固定(只帶 settings.json 之路徑, 不帶原錯誤之內容: JSON 之解析錯誤會回顯檔案之內容; 依跨套件規格〈診斷輸出與遮罩〉D2)
let st = null
try {
    st = getSettings()
}
catch (err) {
    console.log(`ERROR 無法讀取專案設定(settings.json 不存在、不可讀或內容不合; ${P('settings.json')});請於專案根執行, 或設定 ARSI_ROOT`)
    process.exit(2)
}
let L = null
try {
    L = loadLedger(st.eval.ledgerDir)
}
catch (err) {
    console.log(`ERROR 無法載入評估帳本(settings.eval.ledgerDir;${String((err && err.message) || err).split('\n')[0].slice(0, 200)});請先建帳本: node g_build.mjs`)
    process.exit(2)
}
let barMs = L.meta.barHours * 3600000
let time0Ms = Date.parse(`${L.meta.time0}Z`)
let barOf = (iso) => Math.round((Date.parse(`${iso}Z`) - time0Ms) / barMs)
let isoOf = (b) => new Date(time0Ms + b * barMs).toISOString().slice(0, 19)
let trainEnd = 0
let trainFrom = 0
try {
    checkEvalSettings(st, L.meta)
    trainEnd = barOf(st.periods.train.end)
    let f = trainFromBarOf(st, L.meta, trainEnd)
    trainFrom = f === null ? 0 : f
}
catch (err) {
    let msg = configMsgOf(err)
    console.log(`ERROR ${msg === null ? String((err && err.message) || err).split('\n')[0] : msg}`)
    process.exit(2)
}
let evFrom = barOf(periodAt(st, 'backtest', 'start'))
let evTo = Math.min(L.nBars, barOf(periodAt(st, 'backtest', 'end')))
let rep = libReportOf(L, { trainFrom, trainEnd, evFrom, evTo, isoOf, dirHi, dirLo })
console.log(process.argv.includes('--json') ? JSON.stringify(rep, null, 2) : libTextOf(rep))
