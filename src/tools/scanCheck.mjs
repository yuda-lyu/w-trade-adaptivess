import path from 'path'
import fs from 'fs'
import { getSettings } from '../cfg.mjs'
import { backtestCfg } from '../domain/backtestCfg.mjs'
import { scanTrace, setGuardExtra, guardExtraOf } from '../domain/verify.mjs'

//操作掃描之規則改版後, 以現行規則對全樹各節點最近一次交付之操作紀錄重掃, 與節點文件內既有之掃描項並列(唯讀; 不改任何紀錄)
//  node tools/scanCheck.mjs [節點 id 前綴, 逗號分隔]
//  確認變動皆如預期後, 才以 node g_rsi.mjs --mode validate 寫回節點文件(處理要點 §6)
//  planRule 與寫回時相同: 只適用於任務書已有「先寫規劃再評估」/「交付版先定再跑」之節點
let st = getSettings()
setGuardExtra(guardExtraOf(st)) //專案另加之禁區字樣(與迴圈之掃描同一組)
let root = st.FD_ROOT
let workRoot = st.records.workDir
let only = process.argv[2] ? process.argv[2].split(',') : null
let isScan = (s) => /^(觸及禁區|寫到工作夾外|存取其他節點之工作夾|規劃於評估後才寫)/.test(String(s))
let relWork = path.relative(root, workRoot).replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
let nDiff = 0
for (let f of fs.readdirSync(st.records.nodeDir).filter((x) => x.endsWith('.json')).sort()) {
    let d = JSON.parse(fs.readFileSync(path.join(st.records.nodeDir, f), 'utf8'))
    if (only && !only.some((p) => d.nodeId.startsWith(p))) {
        continue
    }
    let wd = path.join(workRoot, d.nodeId)
    if (!fs.existsSync(wd)) {
        continue
    }
    let dir = d.task && d.task.direction
    let dirIds = [...`${(dir && dir.rationale) || ''} ${(dir && dir.expect) || ''}`.matchAll(new RegExp(`${relWork}/([A-Za-z0-9_]+)`, 'g'))].map((m) => m[1])
    let allowWork = [...(d.spec && d.spec.base ? [d.spec.base] : []), ...(((d.task && d.task.refs) || []).filter((r) => r.nodeId).map((r) => r.nodeId)), ...dirIds]
    let planRule = false
    try {
        planRule = /交付版先定再跑|先寫規劃再評估/.test(fs.readFileSync(path.join(wd, 'brief.md'), 'utf8'))
    }
    catch (err) {}
    let tr = scanTrace({ workDir: wd, attempt: d.attempt || 1, privateRoot: backtestCfg(st).privateRoot, root, writeRoots: [wd], workRoot, allowWork, nodeRules: true, planRule })
    let old = ((d.harness && d.harness.checks && d.harness.checks.issues) || []).filter(isScan)
    let same = JSON.stringify(old) === JSON.stringify(tr.issues)
    if (!same) {
        nDiff++
    }
    console.log(`${d.nodeId.slice(0, 8)} r${d.round} ${same ? '相同' : '**不同**'} | 現行規則 ${tr.issues.length} 項${same ? '' : `: ${tr.issues.map((s) => s.slice(0, 80)).join(' ‖ ') || '無'}`}${same ? '' : ` | 節點文件內 ${old.length} 項: ${old.map((s) => s.slice(0, 80)).join(' ‖ ') || '無'}`}`)
}
console.log(`與節點文件不同者 ${nDiff} 份`)
