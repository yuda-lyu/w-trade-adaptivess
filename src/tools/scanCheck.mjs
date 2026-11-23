import path from 'path'
import fs from 'fs'
import { getSettings, cliGuard, inputMsgOf } from '../cfg.mjs'
import { backtestCfg } from '../domain/backtestCfg.mjs'
import { configMsgOf } from '../eval/barGrid.mjs'
import { scanTrace, setGuardExtra, guardExtraOf, allowWorkOf } from '../domain/verify.mjs'
import { evalHintsOfDocs, isEvalHint } from '../domain/verifyEvalHints.mjs'

//操作掃描之規則改版後, 以現行規則對全樹各節點最近一次交付之操作紀錄重掃, 與節點文件內既有之掃描項並列(唯讀; 不改任何紀錄)
//  node tools/scanCheck.mjs [節點 id 前綴, 逗號分隔]
//  確認變動皆如預期後, 才以 node g_rsi.mjs --mode validate 寫回節點文件(處理要點 §6)
//  planRule 與寫回時相同: 只適用於任務書已有「先寫規劃再評估」/「交付版先定再跑」之節點
//  迴圈檢查之兩條機械提示(規則 R-REC-43 單峰交付、R-REC-44 選集與他節點相同)與寫回時同一判定(evalHintsOfDocs; 以全部節點文件與其評估紀錄求得), 列於掃描項之後一併對照
//  側別曝險之提示(規則 R-REC-48)須以樹上之值(raw.metrics、raw.train、evidence)判定, 本工具唯讀而無樹 ⇒ 不在此對照之內(--mode validate 寫回時才併入; 已知限制見 sgud/state/state_REC2.md)
//  成員依賴之提示(規則 R-REC-51)同(判定讀樹上之 raw.member): 不在此對照之內 —— 節點文件內之該條不列入「節點文件內」之項、不使該份判為不同; --mode validate 之重掃以樹上之值重產(現行者照留一條, 不重複)
//命令列只認一個位置引數(節點 id 前綴, 逗號分隔; TOOL_FLAGS.scanCheck): 任何旗標、多餘之位置引數一律拒收(離開碼 2; 於讀設定之前; 訊息固定、不帶輸入值; 原: 旗標被當成節點 id 前綴)
cliGuard('scanCheck')
let st = getSettings()
//專案另加之禁區字樣(與迴圈之掃描同一組); 設定不合(guard.forbidden、source.libraryRoot 給了而無效; R-EV-54 ①)⇒ 印 ERROR、離開碼 2(唯讀工具; 不以失效之禁區掃描); 其餘錯誤照舊拋出
try {
    setGuardExtra(guardExtraOf(st))
}
catch (err) {
    let msg = inputMsgOf(err)
    if (msg === null) {
        throw err
    }
    console.log(`ERROR ${msg}`)
    process.exit(2)
}
//私有根(settings.backtest.privateRoot): settings.backtest 之數值鍵無效(invalid backtest.<鍵>; 排程第 547 項)⇒ 印 ERROR、離開碼 2(唯讀工具, 不拋堆疊); 其餘錯誤照舊拋出
let privateRoot
try {
    privateRoot = backtestCfg(st).privateRoot
}
catch (err) {
    let msg = configMsgOf(err) || inputMsgOf(err)
    if (msg === null) {
        throw err
    }
    console.log(`ERROR ${msg}`)
    process.exit(2)
}
let root = st.FD_ROOT
let workRoot = st.records.workDir
let only = process.argv[2] ? process.argv[2].split(',') : null
let isScan = (s) => /^(觸及禁區|寫到工作夾外|存取其他節點之工作夾|規劃於評估後才寫)/.test(String(s))
let workRel = path.relative(root, workRoot).replace(/\\/g, '/')
let nDiff = 0
let docs = fs.readdirSync(st.records.nodeDir).filter((x) => x.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(st.records.nodeDir, f), 'utf8')))
//節點 id 前綴(位置引數; 格式已於上之 cliGuard 檢查〔TOOL_FLAGS.scanCheck.pos〕): 每個前綴須至少命中一個節點(排程第 607 項; 原: 未命中者靜默略過而印「與節點文件不同者 0 份」, 看似全部相同)
if (only && only.some((p) => !docs.some((d) => String(d.nodeId).startsWith(p)))) {
    console.log('invalid node: must be id prefixes that each match a node')
    process.exit(2)
}
let hints = evalHintsOfDocs(docs, workRoot)
//可讀之他節點工作夾與寫回(領域之 rescanTraces)同一求法(allowWorkOf; 規則 R-BT-9; 方向內只以 id 指名之節點亦可讀); 本工具唯讀、無樹 ⇒ 可被指名之節點以全部節點文件之 id 為全集
let ids = docs.map((d) => d.nodeId)
for (let d of docs) {
    if (only && !only.some((p) => d.nodeId.startsWith(p))) {
        continue
    }
    let wd = path.join(workRoot, d.nodeId)
    if (!fs.existsSync(wd)) {
        continue
    }
    let allowWork = allowWorkOf(d, { workRel, ids })
    let planRule = false
    try {
        planRule = /交付版先定再跑|先寫規劃再評估/.test(fs.readFileSync(path.join(wd, 'brief.md'), 'utf8'))
    }
    catch (err) {}
    let tr = scanTrace({ workDir: wd, attempt: d.attempt || 1, privateRoot, root, writeRoots: [wd], workRoot, allowWork, nodeRules: true, planRule, stateRoot: st.rsi.root })
    let now = [...tr.issues, ...(hints.get(d.nodeId) || [])]
    let old = ((d.harness && d.harness.checks && d.harness.checks.issues) || []).filter((s) => isScan(s) || isEvalHint(s))
    let same = JSON.stringify(old) === JSON.stringify(now)
    if (!same) {
        nDiff++
    }
    console.log(`${d.nodeId.slice(0, 8)} r${d.round} ${same ? '相同' : '**不同**'} | 現行規則 ${now.length} 項${same ? '' : `: ${now.map((s) => s.slice(0, 80)).join(' ‖ ') || '無'}`}${same ? '' : ` | 節點文件內 ${old.length} 項: ${old.map((s) => s.slice(0, 80)).join(' ‖ ') || '無'}`}`)
}
console.log(`與節點文件不同者 ${nDiff} 份`)
