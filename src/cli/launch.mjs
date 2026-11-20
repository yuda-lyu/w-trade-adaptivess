import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { P } from '../cfg.mjs'
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
let name = argv[0]
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
