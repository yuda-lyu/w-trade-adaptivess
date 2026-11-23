import { spawn } from 'child_process'
import getTrace from 'wsemi/src/getTrace.mjs'
import { isPlain, numOrDef } from '../arsi/inputs.mjs'

//RUN_NODE_PROC_TIMEOUT_MS, runNodeProc 之逾時之預設(毫秒): 900000 = 15 分鐘 = settings.eval.timeoutSec 之預設 900 秒(領域之呼叫端皆以 evalRunNumOf 取同一預設), 使缺值或無效值時與迴圈之評估逾時一致
let RUN_NODE_PROC_TIMEOUT_MS = 900000


//runNodeProc(args, { cwd, timeoutMs, env, onTrace }), 以子行程執行 node 腳本並收其輸出(隱藏視窗; 逾時即終止)
//  輸入之檢測見函數內(args、cwd、env 無效 ⇒ 回失敗之結果、不 spawn; timeoutMs 缺或無效 ⇒ 預設 RUN_NODE_PROC_TIMEOUT_MS)
//  回 { code, out(stdout + stderr), timeout }; 子行程起不來(工作目錄不存在、spawn 失敗等之 'error' 事件)⇒ 回 { code: null, out, timeout: false, error }(不拋出、不懸置)
//  onTrace(選配; 跨套件規格〈計時器相關函數之觀察回調與測試〉, 沿用 wsemi 之 getTrace; 同步呼叫、拋錯與回傳之 rejection 忽略、未給時不組事件物件、已有結果之後不再發出; 事件為凍結物件 { type, ... }):
//    'spawn' { pid, timeoutMs }(子行程已起; 起不來者不發)、'timeout' { timeoutMs }(逾時, 即將終止子行程)、'exit' { code }(子行程結束; 逾時者不發)、'error' { message }(子行程起不來)
let runNodeProc = (args, opt) => new Promise((resolve) => {
    //輸入之檢測(跨套件規格 V4、§3.7、§5.1; R-EV-54; 回傳結果物件者 ⇒ 回失敗之結果物件 { code: null, out: '', timeout: false, error }, 不 spawn、不拋):
    //  args 須為非空之字串陣列、opt 須為一般物件(null、undefined 視為 {}); cwd(子行程之工作目錄 = 專案根)與 env(帶 ARSI_HARNESS 之授權)給了而不是非空字串 / 一般物件 ⇒ 失敗之結果(安全相關: 不在錯誤之目錄或環境下執行);
    //  timeoutMs 為計時值(§3.7): 正數且不超過 2147483647, 數字字串轉為數值; 缺、無效(NaN、負數、0、超過上限、非數字)⇒ 用預設 900000(15 分鐘 = settings.eval.timeoutSec 之預設 900 秒; 原: 非有效值使計時器於約 1 毫秒觸發而子行程即被終止並回 timeout)
    //  本函數之失敗訊息為固定詞彙、不帶輸入值
    //  失敗者亦依觀察回調之約定發 'error' 事件(子行程起不來; 與 spawn 同步拋出者同: 只有 error 事件、結果之 error 同訊息)
    let o = isPlain(opt) ? opt : {}
    let trace = getTrace({ onTrace: o.onTrace })
    let fail = (error) => {
        if (trace) {
            trace('error', { message: error })
        }
        resolve({ code: null, out: '', timeout: false, error })
    }
    if (!(Array.isArray(args) && args.length > 0 && args.every((a) => typeof a === 'string'))) {
        fail('invalid args: must be a non-empty array of strings')
        return
    }
    if (opt !== undefined && opt !== null && !isPlain(opt)) {
        fail('invalid opt: must be an object')
        return
    }
    if (o.cwd !== undefined && o.cwd !== null && (typeof o.cwd !== 'string' || o.cwd === '')) {
        fail('invalid opt.cwd: must be a non-empty string')
        return
    }
    if (o.env !== undefined && o.env !== null && !isPlain(o.env)) {
        fail('invalid opt.env: must be an object')
        return
    }
    let cwd = o.cwd === undefined || o.cwd === null ? undefined : o.cwd
    let env = o.env === undefined ? null : o.env
    let timeoutMs = numOrDef(o.timeoutMs, 'timerMs', RUN_NODE_PROC_TIMEOUT_MS)
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
