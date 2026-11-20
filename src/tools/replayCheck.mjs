import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { FD_ROOT } from '../cfg.mjs'
import { guardEntry } from '../domain/agentEntries.mjs'

//agent(ARSI_AGENT_ROLE = node / dream)不得以迴圈專用之旗標重放 ⇒ 拒跑(離開碼 2; 於任何寫入之前; 規則 R-RUN-11)
guardEntry('replayCheck')

//評估器改動後之抽樣重放(主控用): 以現行評估器重跑指定節點之成品(迴圈專用之旗標; 不記入節點之評估紀錄), 與樹上之正本(harness_full.json)比 S、階梯與 selHash
//  node tools/replayCheck.mjs <節點 id 前綴> [...]        離開碼 0 = 全部相同; 1 = 有不同或重放失敗
//  用於「純新增、不應改變既有數字」之評估器改動(例: ctx 加一個存取函式); 會改變模擬或判讀者仍須全樹重算(node g_rsi.mjs --mode reverify)
//  輪次進行中不要跑(與節點之評估搶 CPU; 且改評估器本來就須在輪次之間)
let wdRoot = path.join(FD_ROOT, 'rsi', 'work')
let fdTmp = path.join(FD_ROOT, 'tmp', 'replay')
fs.mkdirSync(fdTmp, { recursive: true })
let bad = 0
for (let pre of process.argv.slice(2)) {
    let id = fs.readdirSync(wdRoot).find((d) => d.startsWith(pre) && !d.includes('_deleted'))
    if (!id) {
        console.log(`${pre}: 找不到此節點之工作夾`)
        bad++
        continue
    }
    let wd = path.join(wdRoot, id)
    let out = path.join(fdTmp, `replay_${pre}.json`)
    let t0 = Date.now()
    let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'g_eval.mjs'), '--pick', path.join(wd, 'pick.mjs'), '--mode', 'full', '--no-log', '--out', out], { cwd: FD_ROOT, windowsHide: true, encoding: 'utf8', env: { ...process.env, ARSI_HARNESS: '1' } })
    let a = JSON.parse(fs.readFileSync(path.join(wd, 'harness_full.json'), 'utf8'))
    let b = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null
    let same = !!b && a.score.S === b.score.S && a.score.ladder === b.score.ladder && a.metrics.selHash === b.metrics.selHash
    console.log(`${id.slice(0, 8)}: 正本 S ${a.score.S} 階梯 ${a.score.ladder} selHash ${a.metrics.selHash} | 重放 ${b ? `S ${b.score.S} 階梯 ${b.score.ladder} selHash ${b.metrics.selHash}` : `失敗(離開碼 ${r.status})`} | ${same ? '相同' : '**不同**'}(${Math.round((Date.now() - t0) / 1000)} 秒)`)
    fs.rmSync(out, { force: true })
    if (!same) {
        bad++
    }
}
process.exitCode = bad ? 1 : 0
