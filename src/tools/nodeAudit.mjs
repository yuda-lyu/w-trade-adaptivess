import fs from 'fs'
import path from 'path'
import { settingsOrExit, cliGuard } from '../cfg.mjs'

//命令列之旗標只認 --nodes、--shape(TOOL_FLAGS.nodeAudit): 等號、未列、重複、多餘之值一律拒收(離開碼 2; 於讀設定之前; 訊息固定、不帶輸入值)
cliGuard('nodeAudit')

//唯讀(主代理): 跨輪盤點節點之行為, 供研判「節點任務書要改什麼」(不含回測期數字; 只讀節點文件、做夢文件與工作夾之 .evals.log)
//  node tools/nodeAudit.mjs            逐輪彙總
//  node tools/nodeAudit.mjs --nodes    另列逐節點
//  node tools/nodeAudit.mjs --shape    印一份節點文件之欄位結構(看有哪些欄可盤點)
let st = settingsOrExit()
let rel = (p) => path.relative(st.FD_ROOT, p).replace(/\\/g, '/')
let nd = st.records.nodeDir
let docs = fs.readdirSync(nd).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(nd, f), 'utf8')))
if (process.argv.includes('--shape')) {
    let d = docs.sort((a, b) => (b.round || 0) - (a.round || 0))[0]
    let walk = (o, pre, depth) => {
        for (let [k, v] of Object.entries(o || {})) {
            let t = Array.isArray(v) ? `[${v.length}]${v.length && typeof v[0] === 'object' ? ` of {${Object.keys(v[0] || {}).join(', ')}}` : ''}` : (v && typeof v === 'object' ? '{…}' : typeof v)
            console.log(`${pre}${k}: ${t}`)
            if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) {
                walk(v, `${pre}  `, depth + 1)
            }
        }
    }
    console.log(`節點文件 ${d.nodeId}(r${d.round}):`)
    walk(d, '  ', 0)
    process.exit(0)
}
//迴圈檢查之問題分類
let BUCKETS = [
    ['觸及禁區', /^觸及禁區/],
    ['寫到工作夾外(被拒,未寫出)', /^寫到工作夾外之企圖/],
    ['寫到工作夾外', /^寫到工作夾外(?!之企圖)/],
    ['存取他人工作夾', /^存取其他節點之工作夾/],
    ['規劃於評估後才寫', /^規劃於評估後才寫/],
    ['無檔可重現之版本', /無檔可重現/],
    ['--no-log', /--no-log/],
    ['自報與正本不符', /自報|claimed|與重跑|不同\(|不符/],
    ['成品之臂 / 硬編', /meta\.arms|長整數陣列|未涵蓋/],
    ['文件欄位', /缺|須為|型別|欄/],
]
let bucketOf = (s) => {
    for (let [name, re] of BUCKETS) {
        if (re.test(s)) {
            return name
        }
    }
    return '其他'
}
//做夢之審計(可信度、處置)
let trust = new Map()
let dd = st.records.dreamDir || path.join(path.dirname(nd), 'dreams')
if (fs.existsSync(dd)) {
    for (let f of fs.readdirSync(dd).filter((x) => x.endsWith('.json'))) {
        let j = JSON.parse(fs.readFileSync(path.join(dd, f), 'utf8'))
        for (let a of (j.audits || j.audit || [])) {
            if (a && a.nodeId) {
                trust.set(a.nodeId, { trust: a.trust || a.credibility || null, action: a.action || a.disposition || null, nIssues: Array.isArray(a.issues) ? a.issues.length : null })
            }
        }
    }
}
let med = (a) => {
    if (!a.length) {
        return null
    }
    let s = a.slice().sort((x, y) => x - y)
    return s[Math.floor(s.length / 2)]
}
let rows = docs.map((d) => {
    let h = d.harness || {}
    let ck = h.checks || {}
    let issues = (ck.issues || []).map(String)
    let wd = path.join(st.records.workDir, d.nodeId)
    let nFull = null
    let nSel = null
    let nFail = 0
    try {
        let sel = new Set()
        nFull = 0
        for (let l of fs.readFileSync(path.join(wd, '.evals.log'), 'utf8').split('\n')) {
            if (!l.trim().startsWith('{')) {
                continue
            }
            let j = JSON.parse(l)
            if (j.ok !== true) {
                nFail++
            }
            else if (j.mode === 'full') {
                nFull++
                if (j.selHash) {
                    sel.add(j.selHash)
                }
            }
        }
        nSel = sel.size
    }
    catch (err) {}
    let c = d.conclusion || {}
    let cd = d.code || {}
    let t = trust.get(d.nodeId) || {}
    return {
        id: d.nodeId.slice(0, 8),
        round: d.round,
        type: (d.task && d.task.type) || 'explore',
        attempt: d.attempt || 1,
        trial: d.task && d.task.trial && d.task.trial.id ? `${d.task.trial.id}/${d.task.trial.variant}` : null,
        sec: d.agent && typeof d.agent.durationSec === 'number' ? d.agent.durationSec : null,
        nEvals: typeof ck.nEvals === 'number' ? ck.nEvals : null,
        nFull,
        nSel,
        nFail,
        buckets: issues.map(bucketOf),
        nIssues: issues.length,
        outcome: c.outcome || null,
        nExp: ((d.results && d.results.experiments) || []).length,
        nFollow: (c.nextIdeas || c.followups || []).length,
        nLimit: (c.limitations || []).length,
        nReused: (cd.reused || []).length,
        nShare: (cd.shareable || []).length,
        flag: (h.validation && h.validation.flag) || null,
        S: h.score ? h.score.S : null,
        ladder: h.score ? h.score.ladder : null,
        trust: t.trust || null,
        action: t.action || null,
        auditIssues: t.nIssues,
        hasControl: fs.existsSync(path.join(wd, 'control.mjs')),
        usedRef: fs.existsSync(wd) && fs.readdirSync(wd).some((f) => /ref/i.test(f) && f.endsWith('.json')),
    }
}).sort((a, b) => a.round - b.round || a.id.localeCompare(b.id))
let rounds = [...new Set(rows.map((r) => r.round))]
console.log('| 輪 | 節點 | 驗證類 | agent 秒(中位 / 最長) | 評估次數(中位) | 完整 / 相異選集(合計) | 評估失敗 | 迴圈檢查有問題之節點 | 問題分類 | 重做 | 做夢審計 trusted / partial / 其他 | 無 control | 自報可共用 / 引用共用 |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for (let rd of rounds) {
    let rs = rows.filter((r) => r.round === rd)
    let cnt = {}
    for (let r of rs) {
        for (let b of r.buckets) {
            cnt[b] = (cnt[b] || 0) + 1
        }
    }
    let secs = rs.map((r) => r.sec).filter((v) => v !== null)
    let tr = { trusted: 0, partial: 0, other: 0 }
    for (let r of rs) {
        if (r.trust === 'trusted') {
            tr.trusted++
        }
        else if (r.trust === 'partial') {
            tr.partial++
        }
        else {
            tr.other++
        }
    }
    let sum = (k) => rs.reduce((s, r) => s + (r[k] || 0), 0)
    console.log(`| r${String(rd).padStart(3, '0')} | ${rs.length} | ${rs.filter((r) => r.type === 'verify').length} | ${med(secs)} / ${secs.length ? Math.max(...secs) : '—'} | ${med(rs.map((r) => r.nEvals).filter((v) => v !== null))} | ${sum('nFull')} / ${sum('nSel')} | ${sum('nFail')} | ${rs.filter((r) => r.nIssues > 0).length} | ${Object.entries(cnt).map(([k, v]) => `${k} ${v}`).join('、') || '—'} | ${rs.filter((r) => r.attempt > 1).length} | ${tr.trusted} / ${tr.partial} / ${tr.other} | ${rs.filter((r) => !r.hasControl).length} | ${sum('nShare')} / ${sum('nReused')} |`)
}
//任務書條款之隨機對照(src/domain/briefTrials.mjs): 依組別彙總事先定之指標
let trialKeys = [...new Set(rows.map((r) => r.trial).filter(Boolean))].sort()
if (trialKeys.length) {
    console.log('\n| 試驗 / 組 | 節點 | 完整評估 ÷ 相異選集 | agent 秒(中位) | 迴圈檢查有問題之節點 | 審計非 trusted | 評估失敗 |')
    console.log('|---|---|---|---|---|---|---|')
    for (let k of trialKeys) {
        let rs = rows.filter((r) => r.trial === k)
        let f = rs.reduce((s, r) => s + (r.nFull || 0), 0)
        let q = rs.reduce((s, r) => s + (r.nSel || 0), 0)
        console.log(`| ${k} | ${rs.length}(${rs.map((r) => `r${r.round} ${r.id}`).join('、')}) | ${f} ÷ ${q} = ${q ? (f / q).toFixed(2) : '—'} | ${med(rs.map((r) => r.sec).filter((v) => v !== null))} | ${rs.filter((r) => r.nIssues > 0).length} | ${rs.filter((r) => r.trust && r.trust !== 'trusted').length} | ${rs.reduce((s, r) => s + r.nFail, 0)} |`)
    }
}
if (process.argv.includes('--nodes')) {
    console.log('')
    for (let r of rows) {
        console.log(`r${String(r.round).padStart(3, '0')} ${r.id} ${r.type === 'verify' ? '驗證' : '探索'}${r.trial ? `〔${r.trial}〕` : ''} 第 ${r.attempt} 次 | agent ${r.sec}s | 評估 ${r.nEvals}(完整 ${r.nFull}、相異選集 ${r.nSel}、失敗 ${r.nFail})| 實驗 ${r.nExp} 筆 | 判定 ${r.outcome} | 後續想法 ${r.nFollow}、限制 ${r.nLimit} | 引用 ${r.nReused}、自報 ${r.nShare} | 回測期 S ${r.S} 階梯 ${r.ladder}${r.flag ? ` 檢定旗標 ${r.flag}` : ''} | 審計${r.trust}/${r.action}(問題 ${r.auditIssues})| 迴圈檢查 ${r.nIssues}${r.buckets.length ? `: ${r.buckets.join('、')}` : ''}${r.hasControl ? '' : ' | 無 control'}${r.usedRef ? ' | 用了 --ref' : ''}`)
    }
}
console.log(`\n(${rows.length} 個節點;來源 ${rel(nd)})`)
