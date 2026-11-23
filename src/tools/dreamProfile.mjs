import fs from 'fs'
import path from 'path'
import { getSettings, cliGuard } from '../cfg.mjs'
import { rsiNumOf } from '../arsi/rsiNums.mjs'

//命令列只認一個位置引數(輪次; TOOL_FLAGS.dreamProfile): 任何旗標、多餘之位置引數一律拒收(離開碼 2; 於讀設定之前; 訊息固定、不帶輸入值)
cliGuard('dreamProfile')

//唯讀(主代理): 做夢 agent 把時間花在哪 —— 解析其逐步事件紀錄(rsi/work/dream_rNNN/agent.log), 依工具呼叫之時間戳分類彙總
//  node tools/dreamProfile.mjs [輪次(預設最近)]
//  分類: 評估(g_eval quick / full)、其他指令、讀檔、寫檔 / 改檔、搜尋; 相鄰兩個事件之時間差記在前一個呼叫上(含模型思考與工具執行)
let st = getSettings()
let work = st.records.workDir
let rounds = fs.readdirSync(work).filter((f) => /^dream_r\d+$/.test(f)).map((f) => Number(f.slice(7))).sort((a, b) => a - b)
//輪次(位置引數; 已於上之 cliGuard 檢查為正整數〔TOOL_FLAGS.dreamProfile.pos〕, 此處取轉換值 —— K4): 給了而無該輪之做夢工作夾 ⇒ 拒收(離開碼 2; 訊息固定、不帶輸入值; 排程第 607 項)
//  原: 值不驗 —— 非數字者被忽略而靜默改為最近一輪; 不存在之輪次於讀紀錄檔時拋原生 ENOENT
let arg = process.argv.slice(2).find((a) => !a.startsWith('--'))
let round = arg !== undefined ? rsiNumOf(arg, 'posInt') : rounds[rounds.length - 1]
if (arg !== undefined && !rounds.includes(round)) {
    console.log('invalid round: must be a round that has a dream work folder')
    process.exit(2)
}
let fp = path.join(work, `dream_r${String(round).padStart(3, '0')}`, 'agent.log')
let evs = []
let walk = (o, ts, outArr) => {
    if (!o || typeof o !== 'object') {
        return
    }
    if (Array.isArray(o)) {
        for (let x of o) {
            walk(x, ts, outArr)
        }
        return
    }
    if (o.type === 'tool_use' && o.input && typeof o.input === 'object') {
        outArr.push({ ts, tool: String(o.name || ''), input: o.input })
        return
    }
    for (let k of Object.keys(o)) {
        if (k !== 'wire_tool_inputs') {
            walk(o[k], ts, outArr)
        }
    }
}
for (let line of fs.readFileSync(fp, 'utf8').split('\n')) {
    if (!line.startsWith('{')) {
        continue
    }
    let j
    try {
        j = JSON.parse(line)
    }
    catch (err) {
        continue
    }
    let ts = j.timestamp ? Date.parse(j.timestamp) : null
    if (ts) {
        walk(j, ts, evs)
    }
}
evs.sort((a, b) => a.ts - b.ts)
let kindOf = (e) => {
    let c = typeof e.input.command === 'string' ? e.input.command : ''
    if (/bash|shell/i.test(e.tool)) {
        if (/g_eval\.mjs/.test(c)) {
            return /--mode[=\s]+full/.test(c) ? '評估 full' : '評估 quick'
        }
        if (/g_toolbox\.mjs/.test(c)) {
            return '共用工具區自檢'
        }
        return '其他指令'
    }
    if (/write|edit/i.test(e.tool)) {
        let f = String(e.input.file_path || e.input.filePath || '')
        return /toolbox/.test(f) ? '寫共用工具區' : (/sgud/.test(f) ? '寫專案文件(sgud)' : (/dream\.json$/.test(f) ? '寫做夢文件' : '寫自己之腳本 / 模組'))
    }
    if (/read/i.test(e.tool)) {
        return '讀檔'
    }
    if (/grep|glob|search/i.test(e.tool)) {
        return '搜尋'
    }
    return `其他(${e.tool})`
}
let agg = new Map()
for (let i = 0; i < evs.length; i++) {
    let k = kindOf(evs[i])
    let dt = i + 1 < evs.length ? (evs[i + 1].ts - evs[i].ts) / 1000 : 0
    let a = agg.get(k) || { n: 0, sec: 0 }
    a.n++
    a.sec += dt
    agg.set(k, a)
}
let total = evs.length ? (evs[evs.length - 1].ts - evs[0].ts) / 1000 : 0
console.log(`做夢 r${String(round).padStart(3, '0')}:工具呼叫 ${evs.length} 個;首末相距 ${Math.round(total)} 秒`)
console.log('| 類別 | 次數 | 秒(含其後之思考) | 占比 |')
console.log('|---|---|---|---|')
for (let [k, a] of [...agg.entries()].sort((x, y) => y[1].sec - x[1].sec)) {
    console.log(`| ${k} | ${a.n} | ${Math.round(a.sec)} | ${total ? (a.sec / total * 100).toFixed(0) : 0}% |`)
}
//每 5 分鐘在做什麼(各段之首個呼叫之摘要)
console.log('\n每 5 分鐘之首個呼叫:')
let t0 = evs.length ? evs[0].ts : 0
let seen = new Set()
for (let e of evs) {
    let b = Math.floor((e.ts - t0) / 300000)
    if (seen.has(b)) {
        continue
    }
    seen.add(b)
    let s = typeof e.input.command === 'string' ? e.input.command : String(e.input.file_path || e.input.filePath || e.input.pattern || '')
    console.log(`  +${b * 5} 分 ${kindOf(e)}: ${s.replace(/\s+/g, ' ').slice(0, 140)}`)
}
