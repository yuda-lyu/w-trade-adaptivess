import { spawn } from 'child_process'


//runNodeProc, 以子行程執行 node 腳本並收其輸出(隱藏視窗; 逾時即終止)
//  回 { code, out(stdout + stderr), timeout }
let runNodeProc = (args, { cwd, timeoutMs, env = null }) => new Promise((resolve) => {
    let out = ''
    let p = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) })
    let done = false
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
