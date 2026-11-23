import { spawn } from 'child_process'
import getTrace from 'wsemi/src/getTrace.mjs'


//runNodeProc, 以子行程執行 node 腳本並收其輸出(隱藏視窗; 逾時即終止)
//  回 { code, out(stdout + stderr), timeout }; 子行程起不來(工作目錄不存在、spawn 失敗等之 'error' 事件)⇒ 回 { code: null, out, timeout: false, error }(不拋出、不懸置)
//  onTrace(選配; 跨套件規格〈計時器相關函數之觀察回調與測試〉, 沿用 wsemi 之 getTrace; 同步呼叫、拋錯與回傳之 rejection 忽略、未給時不組事件物件、已有結果之後不再發出; 事件為凍結物件 { type, ... }):
//    'spawn' { pid, timeoutMs }(子行程已起; 起不來者不發)、'timeout' { timeoutMs }(逾時, 即將終止子行程)、'exit' { code }(子行程結束; 逾時者不發)、'error' { message }(子行程起不來)
let runNodeProc = (args, { cwd, timeoutMs, env = null, onTrace = null }) => new Promise((resolve) => {
    let trace = getTrace({ onTrace })
    let out = ''
    let done = false
    let p
    try {
        p = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) })
    }
    catch (err) {
        if (trace) {
            trace('error', { message: String((err && err.message) || err) })
        }
        resolve({ code: null, out, timeout: false, error: String((err && err.message) || err) })
        return
    }
    p.on('error', (err) => {
        if (!done) {
            done = true
            clearTimeout(timer)
            if (trace) {
                trace('error', { message: String((err && err.message) || err) })
            }
            resolve({ code: null, out, timeout: false, error: String((err && err.message) || err) })
        }
    })
    let timer = setTimeout(() => {
        if (!done) {
            done = true
            if (trace) {
                trace('timeout', { timeoutMs })
            }
            try {
                p.kill()
            }
            catch (err) {}
            resolve({ code: null, out, timeout: true })
        }
    }, timeoutMs)
    //子行程起不來者(pid 為 undefined; 其 'error' 事件隨後發出)不發 'spawn'
    if (trace && typeof p.pid === 'number') {
        trace('spawn', { pid: p.pid, timeoutMs })
    }
    p.stdout.on('data', (d) => {
        out += d
    })
    p.stderr.on('data', (d) => {
        out += d
    })
    p.on('exit', (code) => {
        if (!done) {
            done = true
            clearTimeout(timer)
            if (trace) {
                trace('exit', { code })
            }
            resolve({ code, out, timeout: false })
        }
    })
})


export { runNodeProc }
export default runNodeProc
