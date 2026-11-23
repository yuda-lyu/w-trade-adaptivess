import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { P, FD_ROOT, cliMsgOf } from '../cfg.mjs'
import { peekRunLock, appendEvent } from '../arsi/runner.mjs'
import { guardEntry } from '../domain/agentEntries.mjs'


//agent(ARSI_AGENT_ROLE = node / dream)不得起脫離之子行程 ⇒ 拒跑(離開碼 2; 於建日誌夾與任何寫入之前; 規則 R-RUN-11)
guardEntry('launch')


//以脫離之子行程執行長任務(工作階段更替不中斷): node g_launch.mjs <日誌名> -- <node 參數…>
//  例: node g_launch.mjs round -- g_rsi.mjs --mode round   ← **起跑一次執行之唯一入口**(人、代理、作業系統之排程器皆用同一道指令; 設定全部取自 settings.json)
//  子行程之 stdout / stderr 併入 rsi/logs/<日誌名>_<時戳>.log; pid 寫 rsi/logs/<日誌名>.pid; 結束時於日誌末寫「[detached] EXIT=<碼>」
//  一律隱藏視窗(Windows 下脫離之行程無主控台, 其子行程未設隱藏會跳出終端機視窗)
//  同名之鎖檔 rsi/logs/<日誌名>.lock(由被起跑之程式持有; 見 src/arsi/runner.mjs)所記之執行仍在進行時: 不產生子行程、不覆寫其 pid 檔與日誌路徑,
//    於事件檔記 skipped 並以離開碼 3 結束(排程器定時觸發而上一次尚未結束時即走此路)
let argv = process.argv.slice(2)
let k = argv.indexOf('--')
if (k < 1) {
    console.log('用法: node g_launch.mjs <日誌名> -- <node 參數…>')
    process.exit(2)
}
//本進入檔之引數(`--` 之前)只有日誌名一個, 無旗標; 帶等號之 --key=value、任何旗標與多餘之引數與他進入檔同一處置(離開碼 2、不建日誌夾、訊息固定、不帶輸入值; 排程第 590、547 項)
//  `--` 之後為子行程之引數(原樣轉交; node 之選項本身可帶等號, 如 --max-old-space-size=4096): 其進入檔(g_eval.mjs、g_rsi.mjs 等)自行拒收不合之寫法, 結果見日誌末之 [detached] EXIT=2
{
    let argMsg = cliMsgOf('launch', argv.slice(0, k), { positional: 1 })
    if (argMsg !== null) {
        console.log(argMsg)
        process.exit(2)
    }
}
let name = argv[0]
//日誌名(S4 之安全檔名; R-EV-54 ①): 用於 rsi/logs 內之 <名>.lock、<名>.pid、<名>.log.path 與 <名>_<時戳>.log ⇒ 須為 1 ~ 64 個英數、底線、連字號(英數起首), 不得為 Windows 之裝置名(con、nul…);
//  含路徑分隔、`..`、`:` 等者拒收(離開碼 2; 於建日誌夾與任何寫入之前; 訊息固定、不帶輸入值); 原: 不驗 ⇒ `../x` 使鎖檔、pid 檔、日誌落到日誌夾之外(路徑穿越)
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
    console.log('invalid log name: must be 1 to 64 letters, digits, "-" or "_" (starting with a letter or digit; not a reserved device name)')
    process.exit(2)
}
//專案根(環境變數 ARSI_ROOT 或工作目錄)須為既有之資料夾(K7; 原: 指到不存在之資料夾時逕自建出 rsi/logs 於其下, 留下一個只有日誌夾之假專案根)
if (!(fs.existsSync(FD_ROOT) && fs.statSync(FD_ROOT).isDirectory())) {
    console.log('invalid ARSI_ROOT: must be an existing directory')
    process.exit(2)
}
let args = argv.slice(k + 1)
let fdLogs = P('rsi', 'logs')
fs.mkdirSync(fdLogs, { recursive: true })
{
    let lk = peekRunLock(path.join(fdLogs, `${name}.lock`))
    if (lk.running) {
        let msg = `未啟動: 已有執行中(pid ${lk.pid};自 ${lk.startedAt}${lk.stale ? `;心跳已逾時(最後 ${lk.beatAt}),疑似卡住,須人查明` : ''})`
        console.log(msg)
        appendEvent(path.join(fdLogs, 'events.jsonl'), { event: 'skipped', reason: lk.stale ? 'lock-stale' : 'running', pid: lk.pid, by: 'launch', detail: msg })
        process.exit(3)
    }
}
let fpLog = path.join(fdLogs, `${name}_${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
let wrapper = `
const fs = require('fs'), { spawn } = require('child_process');
const fd = fs.openSync(${JSON.stringify(fpLog)}, 'a');
const c = spawn(process.execPath, ${JSON.stringify(args)}, { stdio: ['ignore', fd, fd], windowsHide: true, cwd: ${JSON.stringify(P())}, env: process.env });
fs.writeFileSync(${JSON.stringify(path.join(fdLogs, `${name}.pid`))}, String(c.pid));
c.on('exit', (code, sig) => { fs.closeSync(fd); fs.appendFileSync(${JSON.stringify(fpLog)}, '\\n[detached] EXIT=' + (code === null ? sig : code) + ' ' + new Date().toISOString() + '\\n'); process.exit(0); });
`
let child = spawn(process.execPath, ['-e', wrapper], { detached: true, stdio: 'ignore', windowsHide: true, cwd: P() })
child.unref()
fs.writeFileSync(path.join(fdLogs, `${name}.log.path`), fpLog, 'utf8')
console.log(`已啟動(脫離): 包裝 pid ${child.pid} → ${fpLog}`)
