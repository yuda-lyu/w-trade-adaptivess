import fs from 'fs'
import getTrace from 'wsemi/src/getTrace.mjs'
import { readEvents as readEventsDef, peekRunLock as peekRunLockDef } from './runner.mjs'


//等待一次執行結束(tools/waitEvent.mjs 之本體; 抽出以便注入時間與讀取而測試): 等事件檔出現新的結束類事件(run-done / run-failed / skipped)、鎖檔之行程已不在(異常結束)或逾時
//  waitRunEnd({ fpEvents, fpLock, since, timeoutMs, pollMs, sleep, now, readEvents, peekRunLock, existsSync, print, onTrace }) ⇒ 離開碼(0 = run-done; 1 = run-failed; 3 = skipped; 4 = 逾時; 5 = 鎖檔之行程已不在而無結束事件)
//    since 毫秒時間戳(只看此時間以後之事件)、timeoutMs 最長等待、pollMs 輪詢間隔; sleep / now / readEvents / peekRunLock / existsSync / print 為注入(預設 setTimeout 版、Date.now、runner.mjs 之同名函數、fs.existsSync、console.log)
//    輸出(print): round-done 事件逐列印 `ROUND <JSON>`; 結束時印 `END <JSON>`(與原 tools/waitEvent.mjs 逐字相同)
//    onTrace(選配; 跨套件規格〈計時器相關函數之觀察回調與測試〉, 沿用 wsemi 之 getTrace; 同步呼叫、拋錯與回傳之 rejection 忽略、未給時不組事件物件、回傳離開碼之後不再發出; 事件為凍結物件 { type, ... }):
//      'poll' { events(此時間以後之事件總數)、running(鎖檔之行程是否仍在)、sawLock }(每輪讀完事件與鎖之後)、'round-done' {}(印出一列 ROUND)、'recheck' {}(鎖檔之行程已不在: 睡 1500 毫秒再讀一次事件檔之前)、
//      'sleep' { ms }(每次睡眠之前; 輪詢之 pollMs 與復查之 1500)、'end' { code, event }(即將回傳; event 為結束事件名或 'vanished' / 'timeout')
let CODE = { 'run-done': 0, 'run-failed': 1, 'skipped': 3 }
let RECHECK_MS = 1500
let waitRunEnd = async ({ fpEvents, fpLock, since, timeoutMs, pollMs, sleep = null, now = Date.now, readEvents = readEventsDef, peekRunLock = peekRunLockDef, existsSync = fs.existsSync, print = console.log, onTrace = null }) => {
    let trace = getTrace({ onTrace })
    let sleepFn = typeof sleep === 'function' ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    let t0 = now()
    let seen = 0
    let sawLock = false
    let finish = (code, event, line) => {
        if (line) {
            print(`END ${JSON.stringify(line)}`)
        }
        if (trace) {
            trace('end', { code, event })
        }
        return code
    }
    for (;;) {
        let evs = readEvents(fpEvents).filter((e) => Date.parse(e.at) >= since)
        for (let e of evs.slice(seen)) {
            if (e.event === 'round-done') {
                print(`ROUND ${JSON.stringify(e)}`)
                if (trace) {
                    trace('round-done', {})
                }
            }
            if (e.event in CODE) {
                return finish(CODE[e.event], e.event, e)
            }
        }
        seen = evs.length
        let lk = peekRunLock(fpLock)
        if (lk.running) {
            sawLock = true
        }
        if (trace) {
            trace('poll', { events: evs.length, running: !!lk.running, sawLock })
        }
        if (!lk.running && (sawLock || existsSync(fpLock))) {
            //鎖檔之行程已不在(或鎖已釋放)而未見結束事件: 再讀一次事件檔(結束事件與釋放鎖之間有極短之間隔), 仍無即為異常結束
            if (trace) {
                trace('recheck', {})
                trace('sleep', { ms: RECHECK_MS })
            }
            await sleepFn(RECHECK_MS)
            let again = readEvents(fpEvents).filter((e) => Date.parse(e.at) >= since).slice(seen)
            let end = again.find((e) => e.event in CODE)
            if (end) {
                return finish(CODE[end.event], end.event, end)
            }
            if (sawLock) {
                return finish(5, 'vanished', { event: 'vanished', detail: '執行之行程已不在而事件檔無結束事件(被外力終止、機器休眠或崩潰);請讀 rsi/logs 之最新日誌' })
            }
        }
        if (now() - t0 > timeoutMs) {
            return finish(4, 'timeout', { event: 'timeout', running: lk.running, pid: lk.pid || null })
        }
        if (trace) {
            trace('sleep', { ms: pollMs })
        }
        await sleepFn(pollMs)
    }
}


export { waitRunEnd, CODE as WAIT_CODE }
export default waitRunEnd
