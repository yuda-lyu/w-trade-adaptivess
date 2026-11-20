// 派工器之最小探測(讀 + 寫 + 跑指令): 節點角色(Go 版 deepseek)與做夢角色(opus5.5)各一次; 用法: node tools/smokeDispatch.mjs [node|dream|both|deny]
import fs from 'fs'
import path from 'path'
import { getSettings, FD_ROOT, P } from '../cfg.mjs'
import { makeDispatch } from '../arsi/dispatchers.mjs'
import { guardEntry } from '../domain/agentEntries.mjs'

//agent(ARSI_AGENT_ROLE = node / dream)不得派工 ⇒ 拒跑(離開碼 2; 於任何寫入之前; 規則 R-RUN-11)
guardEntry('smokeDispatch')

let st = getSettings()
let which = process.argv[2] || 'both'
let agents = JSON.parse(JSON.stringify(st.agents))
agents.node.timeoutMin = 4
agents.node.fallback = []
agents.dream.timeoutMin = 4
agents.dream.effort = 'low'
let dispatch = makeDispatch({ agents, skillsRoot: st.dispatch.skillsRoot, envFile: st.dispatch.envFile, cwd: FD_ROOT, maxPercent: st.rsi && st.rsi.preflight ? st.rsi.preflight.quotaMaxPercent : undefined })
let dir = P('tmp', 'smoke')
fs.rmSync(dir, { recursive: true, force: true })
fs.mkdirSync(dir, { recursive: true })

let one = async (role) => {
    let out = `tmp/smoke/${role}-out.txt`
    let prompt = `請依序完成(工作目錄即專案根):\n1. 讀取 examples/pick_example.mjs, 記下第 1 行原文。\n2. 執行指令 node -e "console.log(6*7)" 並記下輸出。\n3. 建立檔案 ${out}, 內容兩行: 第一行為步驟 1 之原文, 第二行為步驟 2 之輸出。\n4. 最後只回一行: READ=<第1行原文> RUN=<輸出> WRITE=<DONE 或 FAILED>`
    let t0 = Date.now()
    let r = await dispatch(role, { prompt, tag: `smoke-${role}`, logFile: path.join(dir, `${role}.log`) })
    let fp = P(out)
    let body = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : null
    console.log(`[${role}] ok ${r.ok} ${((Date.now() - t0) / 1000).toFixed(1)}s agent ${JSON.stringify(r.agent)} error ${r.error || '-'}`)
    console.log(`[${role}] stdout 末段: ${String(r.stdout || '').trim().slice(-300)}`)
    console.log(`[${role}] 產物: ${body === null ? '未建立' : JSON.stringify(body)}`)
}
//deny: 節點角色於「寫檔路徑落在專案夾外而被拒」之後是否續做(規則 R-RUN-7; opencode 升版後重驗)
//  通過 = 專案夾內之檔有寫出、專案夾外之檔未寫出; 未通過時先看派工設定之 experimental.continue_loop_on_deny 是否仍被該版本採用
let deny = async () => {
    let outside = `${FD_ROOT}_x${path.sep}smoke-deny.txt`
    let inside = 'tmp/smoke/deny-in.txt'
    let prompt = `請依序做兩步, 每步只用寫檔工具(不要用 bash):\n步驟 1: 把文字 X 寫到絕對路徑 ${outside} (照此路徑, 不要更改)。\n步驟 2: 不論步驟 1 成功或失敗, 都建立檔案 ${inside}, 內容為 DONE。\n最後只回一行: STEP1=<OK 或 FAILED> STEP2=<OK 或 FAILED>`
    let r = await dispatch('node', { prompt, tag: 'smoke-deny', logFile: path.join(dir, 'deny.log') })
    let inOk = fs.existsSync(P(inside))
    let outWritten = fs.existsSync(outside)
    console.log(`[deny] ok ${r.ok} 專案夾內之檔 ${inOk ? '已寫出' : '未寫出'};專案夾外之檔 ${outWritten ? '已寫出(不應發生)' : '未寫出'} ⇒ ${inOk && !outWritten ? 'PASS(被拒後續做)' : 'FAIL'}`)
    process.exitCode = inOk && !outWritten ? 0 : 1
}
if (which === 'deny') {
    await deny()
}
else {
    let roles = which === 'both' ? ['node', 'dream'] : [which]
    await Promise.all(roles.map(one))
}
