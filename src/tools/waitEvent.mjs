import path from 'path'
import { getSettings, cliGuard } from '../cfg.mjs'
import { waitRunEnd } from '../arsi/waitEnd.mjs'

//命令列之旗標只認 --timeout-min、--since、--poll-sec(TOOL_FLAGS.waitEvent; 空白分隔): 等號、未列、重複、無值、多餘之值一律拒收(離開碼 2; 於讀設定之前; 訊息固定、不帶輸入值; 原: 靜默忽略而等到預設之時限)
cliGuard('waitEvent')

//等待一次執行結束(監看端用; 唯讀): 等事件檔 rsi/logs/events.jsonl 出現新的結束類事件(run-done / run-failed / skipped), 印出後結束
//  node tools/waitEvent.mjs [--timeout-min 110] [--since <ISO 時間>] [--poll-sec 20]
//    --since      只看此時間以後之事件(預設 = 本工具啟動之時刻; 起跑後才啟動本工具而怕錯過者, 給起跑之時刻)
//    --timeout-min 最長等待(預設 110 分; 背景指令之時限為 120 分, 逾時即印 TIMEOUT 並以離開碼 4 結束, 由呼叫端重掛)
//  輸出(最後一行為機器可讀之一列 JSON): 事件本身; 其間之 round-done 事件逐列印出
//  離開碼: 0 = run-done; 1 = run-failed; 3 = skipped; 4 = 逾時(執行仍在進行); 5 = 鎖檔之行程已不在而無結束事件(異常結束)
let st = getSettings()
let arg = (k, def) => {
    let i = process.argv.indexOf(`--${k}`)
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def
}
let fdLogs = path.join(st.rsi.root, 'logs')
let fpEvents = path.join(fdLogs, 'events.jsonl')
let fpLock = path.join(fdLogs, 'round.lock')
let since = Date.parse(arg('since', new Date().toISOString()))
let timeoutMs = Number(arg('timeout-min', 110)) * 60000
let pollMs = Math.max(2, Number(arg('poll-sec', 20))) * 1000
//本體在 src/arsi/waitEnd.mjs(注入時間與讀取、帶觀察回調 opt.onTrace, 供測試以事件同步; 輸出與離開碼與原迴圈逐字相同)
process.exit(await waitRunEnd({ fpEvents, fpLock, since, timeoutMs, pollMs }))
