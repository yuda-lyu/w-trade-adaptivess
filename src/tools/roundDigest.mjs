import fs from 'fs'
import path from 'path'
import { getSettings, readJson, cliGuard } from '../cfg.mjs'
import { phaseCountOfMetrics, phaseCountOfAll, phaseText } from '../eval/cfgNum.mjs'
import { guardEntry } from '../domain/agentEntries.mjs'

//agent(ARSI_AGENT_ROLE = node / dream)⇒ 帶 --out(寫出 DIGEST.md)者拒跑(離開碼 2; 規則 R-RUN-11); 只印出者照常
guardEntry('roundDigest')
//命令列只認 [輪次] 與 --out(TOOL_FLAGS.roundDigest): 未列之旗標、等號、重複、多餘之位置引數一律拒收(離開碼 2; 於讀設定與任何寫入之前; 訊息固定、不帶輸入值)
cliGuard('roundDigest')

//唯讀: 某一輪之一頁摘要(不含回測期數字; 只讀輪次結果檔、節點文件、做夢文件與各工作夾之 .evals.log)
//  node tools/roundDigest.mjs [輪次(預設最近一輪)] [--out]     --out: 另存為 rsi/rounds/rNNN/DIGEST.md
//  用途: 無人監控(排程執行)時, 回來看這一頁即知該輪做了什麼、有無異常、下一輪要做什麼
let st = getSettings()
let rel = (p) => path.relative(st.FD_ROOT, p).replace(/\\/g, '/')
let nd = st.records.nodeDir
let dd = st.records.dreamDir || path.join(path.dirname(nd), 'dreams')
let docs = fs.readdirSync(nd).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(nd, f))).filter(Boolean)
let argRound = process.argv.slice(2).find((a) => /^\d+$/.test(a))
let round = argRound ? Number(argRound) : Math.max(...docs.map((d) => d.round || 0))
let rn = `r${String(round).padStart(3, '0')}`
let fdRound = path.join(st.rsi.root, 'rounds', rn)
let R = readJson(path.join(fdRound, 'ROUND.json'), null)
let dream = readJson(path.join(dd, `${rn}.json`), null)
let out = []
let P = (s = '') => out.push(s)
P(`# ${rn} 摘要${R ? `(${R.at};${R.wallMin} 分)` : '(輪次尚未結束或無 ROUND.json)'}`)
P('')
//0. 白話摘要(做夢所寫, 給使用者; 規則 R-REC-16): 只讀這一段即知現況; 其後為迴圈之機械摘要
{
    let plain = dream && dream.synthesis && typeof dream.synthesis.plain === 'string' ? dream.synthesis.plain.trim() : ''
    if (plain && ![0xFF08, 0x28].includes(plain.charCodeAt(0))) {
        P('## 白話摘要(做夢所寫)')
        P('')
        P(plain)
        P('')
    }
    let lines = (R && R.hook && R.hook.lines) || []
    //量尺之並列與側別讀數之警示(規則 R-REC-49、R-REC-50): 輪末摘要有其列者才取(無者與改前逐字相同)
    let facts = [/^整體研判/, /^向外飽和/, /^額度/, /^改進項/, /^做夢之操作稽核/, /^量尺\(並列/, /^側別讀數之警示/].map((re) => lines.find((l) => re.test(l))).filter(Boolean)
    if (R) {
        P('## 一眼看完(迴圈之機械摘要)')
        P('')
        P(`- 本輪 ${R.wallMin} 分;節點執行 ${R.summary ? R.summary.nExecuted : '—'}、錯誤 ${R.summary ? R.summary.nError : '—'};輪末回調 ${R.hook && R.hook.failed ? '**失敗**' : '正常'}`)
        //只做夢輪次(規則 R-RUN-9): 主控要求、本輪無節點; 要求之原文(截短)
        if (R.dreamOnly && typeof R.dreamOnly.why === 'string') {
            P(`- **只做夢輪次**(主控要求;本輪無節點、審計 0):${R.dreamOnly.why.replace(/\s*\r?\n\s*/g, ' ').slice(0, 300)}`)
        }
        for (let f of facts) {
            P(`- ${f}`)
        }
        P('')
    }
}
//1. 節點
let rows = docs.filter((d) => d.round === round).sort((a, b) => a.nodeId.localeCompare(b.nodeId))
let hex = /\b[0-9a-f]{20}\b/g
P('## 節點')
P('')
//評估期 = 回測期; 欄為回測期之 S / 階梯、七相位平均 / 最差相位、組成對照(同側同活躍度虛無)之超額與可重現比例、換種子與同分次序之 S
P(`| 節點 | 類型 | 臂(←起點) | 回測期 S / 階梯 | ${phaseText(phaseCountOfAll(rows.map((d) => phaseCountOfMetrics(d.harness && d.harness.raw && d.harness.raw.metrics)), st.eval), '相位')}平均 / 最差相位 | 組成對照之超額 / p / 可重現 | 換種子與同分次序之 S | agent 秒 | 評估(完整 / 相異選集) | 迴圈檢查 | 方向指定之選集指紋 | 共用工具 | 試驗 |`)
P('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
let f1 = (x) => (typeof x === 'number' ? x.toFixed(1) : '—')
let nFullAll = 0
let nSelAll = 0
for (let d of rows) {
    let h = d.harness || {}
    let ck = h.checks || {}
    let wd = path.join(st.records.workDir, d.nodeId)
    let evs = []
    try {
        evs = fs.readFileSync(path.join(wd, '.evals.log'), 'utf8').split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l))
    }
    catch (err) {}
    let full = evs.filter((e) => e.ok === true && e.mode === 'full')
    let sel = new Set(full.map((e) => e.selHash).filter(Boolean))
    nFullAll += full.length
    nSelAll += sel.size
    //來源方向之文字內指定之選集指紋(20 位十六進位), 是否出現在本節點之評估紀錄內
    let dir = d.task && d.task.direction ? `${d.task.direction.rationale || ''} ${d.task.direction.expect || ''}` : ''
    let want = [...new Set(dir.match(hex) || [])]
    let got = new Set(evs.map((e) => e.selHash).filter(Boolean))
    let hit = want.filter((x) => got.has(x))
    let reused = ((d.code && d.code.reused) || []).map(String)
    let tb = reused.filter((s) => /toolbox/i.test(s)).length
    let issues = (ck.issues || []).map(String)
    let mm = h.raw && h.raw.metrics
    let ns = mm && mm.nullSideAct
    let sd = h.raw && Array.isArray(h.raw.seedS) && h.raw.seedS.length ? h.raw.seedS.map((v) => f1(v)).join(' / ') : '—'
    P(`| \`${d.nodeId.slice(0, 8)}\` | ${d.task && d.task.type === 'verify' ? '驗證' : '探索'} | ${d.spec.arms.join(' + ')}${d.spec.base ? ` ←${d.spec.base.slice(0, 8)}` : ''} | ${h.score ? `**${h.score.S}** / ${h.score.ladder}` : '—'} | ${mm && mm.op ? `${f1(mm.op.eqYr.mean)} / ${f1(mm.op.eqYr.min)}` : '—'} | ${ns ? `${f1(ns.excess)} / ${ns.p} / ${typeof ns.share === 'number' ? `${Math.round(ns.share * 100)}%` : '—'}` : '—'} | ${sd} | ${d.agent && d.agent.durationSec} | ${evs.length}(${full.length} / ${sel.size}) | ${issues.length ? issues.map((s) => s.slice(0, 60)).join(';') : '無異常'} | ${want.length ? `${hit.length} / ${want.length} 個出現於評估紀錄` : '—'} | ${tb ? `引用 ${tb} 項` : '未引用'}${d.code && Array.isArray(d.code.shareable) && d.code.shareable.length ? `;自報 ${d.code.shareable.length}` : ''} | ${d.task && d.task.trial ? `${d.task.trial.id}/${d.task.trial.variant}` : '—'} |`)
}
P('')
P(`完整評估 ${nFullAll} 次、相異選集 ${nSelAll} 個(比 ${nSelAll ? (nFullAll / nSelAll).toFixed(2) : '—'})。`)
if (R && R.nodes) {
    let bad = R.nodes.filter((n) => n.status !== 'executed')
    if (bad.length) {
        P(`未交付可評估成品之節點 ${bad.length} 個:${bad.map((n) => `\`${n.id.slice(0, 8)}\`(${n.error || n.status})`).join(';')}`)
    }
}
P('')
//2. 迴圈之輪末摘要(原文)
P('## 迴圈之輪末摘要')
P('')
if (R && R.hook) {
    P(`- 輪末回調:${R.hook.failed ? '**失敗**' : '正常'}${(R.hook.errors || []).length ? `;錯誤:${R.hook.errors.join(';').slice(0, 300)}` : ''}`)
    for (let l of R.hook.lines || []) {
        P(`- ${String(l).slice(0, 400)}`)
    }
    if (R.resources) {
        P(`- 資源:CPU 平均 ${R.resources.cpuMean}%、最高 ${R.resources.cpuPeak}%;已用記憶體最高 ${R.resources.ramPeakGB} GB;超過上限之取樣 CPU ${R.resources.overCpu} / 記憶體 ${R.resources.overRam}`)
    }
}
else {
    P('(無)')
}
P('')
//3. 做夢: 審計、前次方向之回顧、下一輪之方向、改進項、擴建
P('## 做夢')
P('')
if (dream) {
    let au = dream.audits || []
    P(`- 審計:${au.map((a) => `\`${String(a.nodeId).slice(0, 8)}\` ${a.trust}/${a.action}`).join('、') || '無'}`)
    let syn = dream.synthesis || {}
    for (let p of syn.prevDirections || []) {
        P(`- 前次方向 ${Array.isArray(p.arms) ? p.arms.join(' + ') : ''}:**${p.verdict}** —— ${String(p.note || p.why || '').slice(0, 160)}`)
    }
    let g = dream.guidance || {}
    P('')
    P('下一輪之方向:')
    P('')
    for (let [i, x] of (g.directions || []).entries()) {
        P(`${i + 1}. 〔${x.type === 'verify' ? '驗證' : '探索'}〕${(x.arms || []).join(' + ')}${x.base ? ` ←${String(x.base).slice(0, 8)}` : ''}${x.claim ? `;主張:${String(x.claim).slice(0, 140)}` : ''} —— ${String(x.rationale || '').slice(0, 200)}`)
    }
    P('')
    let imp = g.improvements || []
    P(`改進項 ${imp.length} 筆${imp.length ? ':' : ''}`)
    for (let x of imp) {
        P(`- 〔${x.kind}〕${String(x.target || '').slice(0, 80)}:${String(x.what || x.change || x.spec || '').slice(0, 220)}`)
    }
    let ex = dream.expansion || []
    if (ex.length) {
        P('')
        P(`擴建 ${ex.length} 項:${ex.map((x) => `${x.decision} ${String(x.item).slice(0, 40)}`).join(';')}`)
    }
    let tr = dream.harness && dream.harness.trace
    P('')
    P(`做夢之操作稽核:${tr && (tr.issues || []).length ? `**${tr.issues.length} 項** —— ${tr.issues.map((s) => String(s).slice(0, 120)).join(';')}` : '0 項'}${tr && (tr.inlineNotes || []).length ? `;待核對 ${tr.inlineNotes.length} 處(內嵌腳本之比對式含禁區字樣,不計為觸及禁區):${tr.inlineNotes.map((s) => String(s).slice(0, 80)).join('、')}` : ''}${dream.harness && dream.harness.toolbox ? `;共用工具區:${dream.harness.toolbox.ok ? '檢查通過' : '有問題'}(還原 ${(dream.harness.toolbox.reverted || []).length} 檔)` : ''};做夢耗時 ${dream.agent && dream.agent.durationSec ? dream.agent.durationSec : '—'} 秒`)
}
else {
    P('(做夢文件尚未產生)')
}
P('')
//4. 樹之現況(回測期之階梯分佈與 S 最高之前 3 個)
let cnt = {}
for (let d of docs) {
    let f = d.harness && d.harness.score ? `階梯 ${d.harness.score.ladder}` : '無分數'
    cnt[f] = (cnt[f] || 0) + 1
}
P(`## 樹之現況`)
P('')
P(`${docs.length} 個節點:${Object.keys(cnt).sort().map((k) => `${k} × ${cnt[k]}`).join('、')}`)
let top = docs.filter((d) => d.harness && d.harness.score && !(d.harness.score.flags && d.harness.score.flags.vetoed)).sort((a, b) => b.harness.score.S - a.harness.score.S).slice(0, 3)
if (top.length) {
    P('')
    P(`回測期 S 最高者:${top.map((d) => {
        let ns = d.harness.raw && d.harness.raw.metrics && d.harness.raw.metrics.nullSideAct; return `\`${d.nodeId.slice(0, 8)}\`(${d.spec.arms.join(' + ')})S ${d.harness.score.S}、階梯 ${d.harness.score.ladder}${ns && typeof ns.share === 'number' ? `、組成可重現 ${Math.round(ns.share * 100)}%` : ''}`
    }).join(';')}`)
}
let text = out.join('\n') + '\n'
console.log(text)
if (process.argv.includes('--out')) {
    let fp = path.join(fdRound, 'DIGEST.md')
    fs.writeFileSync(fp, text, 'utf8')
    console.log(`→ ${rel(fp)}`)
}
