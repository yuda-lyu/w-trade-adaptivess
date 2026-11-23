import path from 'path'
import { createRequire } from 'module'
import { getSettings, cliGuard, argNumOf } from '../cfg.mjs'
import { checkQuota } from '../arsi/dispatchers.mjs'
import { guardEntry } from '../domain/agentEntries.mjs'
import { preflightOf } from '../arsi/rsiNums.mjs'

//agent(ARSI_AGENT_ROLE = node / dream)⇒ 帶 --probe(實際派一次備援)者拒跑(離開碼 2; 規則 R-RUN-11); 只看用量者照常
guardEntry('quota')
//命令列之旗標只認 --max <N>、--all、--probe(TOOL_FLAGS.quota): 等號、未列、重複、無值、多餘之值一律拒收(離開碼 2; 於讀設定與任何探測之前; 訊息固定、不帶輸入值)
cliGuard('quota')

//查各角色(節點 agent、做夢 agent)所用訂閱之用量, 與起跑前之額度守門同一查詢(規則 R-RUN-5); 只印角色、視窗名、百分比與重置時刻, 不印金鑰與帳號
//  node tools/quota.mjs [--max 95] [--all] [--probe]     --all: 另列 Claude 訂閱之全部視窗;  --max: 以此上限試算「此刻起跑會不會被擋」(預設取 settings.rsi.preflight.quotaMaxPercent, 無則 95; 各角色之 agents.<role>.quotaMaxPercent 優先)
//    --probe: 與起跑前之守門相同 —— 主模型達門檻而有備援時實際試一次備援(免費池用盡即算擋下; 規則 R-RUN-8); 未給則只看用量(不探測)
let st = getSettings()
//門檻之取值同起跑前之額度守門(preflightOf: 數字字串轉數值, 無效者用預設 95; 排程第 595 項); --max 之值為十進位寫法之有限數(同 preflightOf 之 quotaMaxPercent)
//  --max 給了而不是有限數 ⇒ 已於上之 cliGuard 拒收(CLI_VALUES.quota; 排程第 607 項; 原: 靜默取設定之值 —— `--max abc` 以為在試算 abc 卻是 95); 此處取檢查合格之轉換值(K4)
let preNum = preflightOf(st.rsi)
let max = argNumOf('max', 'num', preNum.quotaMaxPercent)
let q = await checkQuota({ agents: st.agents || {}, skillsRoot: st.dispatch.skillsRoot, envFile: st.dispatch.envFile, maxPercent: max, probe: process.argv.includes('--probe') })
for (let r of q.rows) {
    console.log(`${r.role}(${r.model}): ${r.windows.map((w) => `${w.label} ${w.percent === null ? '—' : `${w.percent}%`}${w.resetAt ? `(重置 ${String(w.resetAt).slice(0, 16)}Z)` : ''}`).join(' | ') || '—'}${r.blocked ? ` 【已達起跑門檻 ${r.maxPercent}%】` : ''}${r.note ? ` (${r.note})` : ''}`)
}
//--all: 另列 Claude 訂閱之全部用量視窗(含各模型專屬者; 主控自己所用之模型亦在其中), 供主控估自己之餘裕
if (process.argv.includes('--all')) {
    try {
        let wda = createRequire(import.meta.url)(path.join(st.dispatch.skillsRoot, 'node_modules', 'w-dispatch-ai'))
        let qc = await wda.getQuotaClaude()
        console.log(qc && qc.ok === true && Array.isArray(qc.windows) ? `Claude 訂閱之全部視窗: ${qc.windows.map((w) => `${w.label} ${w.usedPercent}%`).join(' | ')}` : 'Claude 訂閱之全部視窗: 查詢失敗')
    }
    catch (err) {
        console.log(`Claude 訂閱之全部視窗: 查詢失敗(${String((err && err.message) || err).slice(0, 120)})`)
    }
}
console.log(q.ok ? `此刻起跑: 不會被額度擋下(起跑門檻 ${max}%)` : `此刻起跑: 會被擋下 —— ${q.why}(可加 --force 起跑一次)`)
//用字: 百分比是進位後之顯示值, 讀到 100% 不等於用盡 —— 是否用盡以 agent 之訊息出現額度用盡為準; 在此之前只能說「接近上限」
if (q.rows.some((r) => r.windows.some((w) => typeof w.percent === 'number' && w.percent >= 99))) {
    console.log('註: 百分比為進位後之顯示值; 讀到 99 ~ 100% 只代表接近上限, 是否用盡以 agent 之訊息出現額度用盡為準')
}
