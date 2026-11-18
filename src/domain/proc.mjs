import { spawn } from 'child_process'


//runNodeProc, 以子行程執行 node 腳本並收其輸出(隱藏視窗; 逾時即終止)
//  回 { code, out(stdout + stderr), timeout }; 子行程起不來(工作目錄不存在、spawn 失敗等之 'error' 事件)⇒ 回 { code: null, out, timeout: false, error }(不拋出、不懸置)
let runNodeProc = (args, { cwd, timeoutMs, env = null }) => new Promise((resolve) => {
    let out = ''
    let done = false
    let p
    try {
        p = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) })
    }
    catch (err) {
        resolve({ code: null, out, timeout: false, error: String((err && err.message) || err) })
        return
    }
    p.on('error', (err) => {
        if (!done) {
            done = true
            clearTimeout(timer)
            resolve({ code: null, out, timeout: false, error: String((err && err.message) || err) })
        }
    })
    let timer = setTimeout(() => {
        if (!done) {
            done = true
            try {
                p.kill()
            }
            catch (err) {}
            resolve({ code: null, out, timeout: true })
        }
    }, timeoutMs)
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
            resolve({ code, out, timeout: false })
        }
    })
})


export { runNodeProc }
export default runNodeProc
