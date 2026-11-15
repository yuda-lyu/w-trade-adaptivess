import fs from 'fs'
import path from 'path'
import { getSettings } from '../cfg.mjs'
import { readEvents, peekRunLock } from '../arsi/runner.mjs'

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
let t0 = Date.now()
let seen = 0
let sawLock = false
let sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let CODE = { 'run-done': 0, 'run-failed': 1, 'skipped': 3 }
for (;;) {
    let evs = readEvents(fpEvents).filter((e) => Date.parse(e.at) >= since)
    for (let e of evs.slice(seen)) {
        if (e.event === 'round-done') {
            console.log(`ROUND ${JSON.stringify(e)}`)
        }
        if (e.event in CODE) {
            console.log(`END ${JSON.stringify(e)}`)
            process.exit(CODE[e.event])
        }
    }
    seen = evs.length
    let lk = peekRunLock(fpLock)
    if (lk.running) {
        sawLock = true
    }
    else if (sawLock || fs.existsSync(fpLock)) {
        //鎖檔之行程已不在(或鎖已釋放)而未見結束事件: 再讀一次事件檔(結束事件與釋放鎖之間有極短之間隔), 仍無即為異常結束
        await sleep(1500)
        let again = readEvents(fpEvents).filter((e) => Date.parse(e.at) >= since).slice(seen)
        let end = again.find((e) => e.event in CODE)
        if (end) {
            console.log(`END ${JSON.stringify(end)}`)
            process.exit(CODE[end.event])
        }
        if (sawLock) {
            console.log(`END ${JSON.stringify({ event: 'vanished', detail: '執行之行程已不在而事件檔無結束事件(被外力終止、機器休眠或崩潰);請讀 rsi/logs 之最新日誌' })}`)
            process.exit(5)
        }
    }
    if (Date.now() - t0 > timeoutMs) {
        console.log(`END ${JSON.stringify({ event: 'timeout', running: lk.running, pid: lk.pid || null })}`)
        process.exit(4)
    }
    await sleep(pollMs)
}
