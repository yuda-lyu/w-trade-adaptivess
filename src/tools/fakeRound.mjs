// 以假 agent 走完整一輪(不耗任何模型額度): 節點派工 → 重跑驗證 → 節點文件 → 入樹 → 做夢(審計: 採納 / 重做 / 刪除;方向含一條不合法者)→ 寫回 → 前緣 → 看板
//  狀態根與紀錄皆落 tmp/fake(不動正式之 rsi/; 結束後可刪); 用法: node tools/fakeRound.mjs [--two] [--redream]
//  離開碼: 0 = 全部如預期; 3 改進項之分類、4 前次方向之回顧、5 擴建、6 整體研判 / 驗證類、7 補做夢、8 臂目錄之提案 / 擴充、9 補位載體、10 未作用之臂、11 擴充診斷之看板值、12 前緣改掛、13 已試之修正、14 擴充診斷之 notContent、15 量尺之子集 / 擴充診斷之補算
//  (規則 R-EV-45 ⑦; 擴充診斷之補算:「真實診斷」一項以正式之共用工具區〔settings.records.toolboxDir, 未給 = <rsi.root>/toolbox; 與評估之子行程之解析相同〕之 metrics/ 內有本檔寫死之診斷名(nullRecentAct)之檔、且第一個節點有其(非錯誤之)值為前提 ——
//   無該名之檔、或第一個節點無其值(undefined)者該項略過(輸出標 skipped 與原因, 不計為失敗、不影響離開碼); 有該檔而第一個節點之值為錯誤(診斷載入失敗或拋錯)或非 undefined 之假值者為失敗(valueError; 離開碼 15), 有值而補算失敗者亦同;
//   「自備假診斷(替身評估)」一項不依賴共用工具區, 恆執行, 不合另印專屬之一行、仍為離開碼 15)
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { getSettings, FD_ROOT, P } from '../cfg.mjs'
import { peekRound, nextLayerId, makePaths, readArmExtensions } from '../engineApi.mjs'
import { writeJson } from '../engineProtocol.mjs'
import { makeProjectOrExit } from '../domain/domain.mjs'
import { decideArgsOf } from '../domain/armCatalog.mjs'

let st = getSettings()
let root = P('tmp', 'fake')
fs.rmSync(root, { recursive: true, force: true })
let realRoot = st.rsi.root
//真實專案之共用工具區(「真實診斷」一項取其 metrics/ 內之診斷檔; 與評估之子行程〔src/cli/eval.mjs〕及 domain.mjs 同一個解析: settings.records.toolboxDir, 未給 = <rsi.root>/toolbox; 規則 R-EV-45 ⑦);
//  須於下一行改寫 st.rsi.root 與 st.records 之前取得(其後 st 為假專案之設定)
let realToolboxDir = st.records.toolboxDir || path.join(realRoot, 'toolbox')
st.rsi.root = path.join(root, 'rsi')
st.records = { nodeDir: path.join(root, 'rsi/records/nodes'), dreamDir: path.join(root, 'rsi/records/dreams'), trashDir: path.join(root, 'rsi/records/trash'), workDir: path.join(root, 'rsi/work') }

st.backtest = { ...(st.backtest || {}), resultDir: path.join(root, 'private-backtest') } //假輪次之回測期結果不與正式者混放(全期帳本仍用正式之私有根)

let example = fs.readFileSync(P('examples', 'pick_example.mjs'), 'utf8')
//第 1 個節點用「訓練期可過階梯 1」之挑法(近 210 日勝率升冪; 已知回測期 fail), 以走到回測期旗標與否決之路徑
let winAsc = `export const meta = { arms: [], params: { lookbackDays: 210, minClosed: 5, take: 40, maxHold: 30 }, desc: '假節點: 近210日勝率(升冪)前40; 同時持倉<30' }
export default function pick(ctx) {
    let cfg = meta.params
    let st = ctx.stat(cfg.lookbackDays)
    let cands = []
    for (let s = 0; s < ctx.n; s++) {
        if (st.closed[s] >= cfg.minClosed) cands.push(s)
    }
    let score = (s) => st.wins[s] / st.closed[s]
    cands.sort((a, b) => score(a) - score(b) || a - b)
    return cands.slice(0, cfg.take)
}
export function accept(sig, book) {
    return book.open < 30
}
`
let nNodeCalls = 0
//--redream: 第 1 次做夢派工回失敗且不寫 dream.json(模擬額度用盡), 供驗「補做夢」(規則 R-RUN-6)
let failDream = process.argv.includes('--redream') ? 1 : 0
let dispatch = async (role, { prompt, logFile }) => {
    let m = /請閱讀 (\S+)\/brief\.md/.exec(prompt)
    let wd = path.resolve(FD_ROOT, m[1])
    fs.appendFileSync(logFile, `fake ${role} ${wd}\n`)
    if (role === 'node') {
        let brief = fs.readFileSync(path.join(wd, 'brief.md'), 'utf8')
        let arms = /export const meta = \{ arms: \[([^\]]*)\]/.exec(brief)[1]
        let isRework = /本次為重做/.test(brief)
        let first = nNodeCalls++ === 0
        let src = (first ? winAsc : example).replace(/arms: \[\]/, `arms: [${arms}]`).replace('book.open < 30', isRework ? 'book.open < 20' : 'book.open < 30')
        fs.writeFileSync(path.join(wd, 'pick.mjs'), src, 'utf8')
        spawnSync(process.execPath, [P('g_eval.mjs'), '--pick', path.join(wd, 'pick.mjs'), '--mode', 'full', '--out', path.join(wd, 'result_full.json')], { cwd: FD_ROOT, windowsHide: true })
        let r = JSON.parse(fs.readFileSync(path.join(wd, 'result_full.json'), 'utf8'))
        let doc = {
            plan: { target: '假節點: 驗流程', approach: '套用範例挑選模組', hypotheses: ['流程可走完'] },
            //第 1 個節點自報一筆可共用之輔助(應列於做夢任務書之「本輪節點自報」)
            //第 1 個節點另自報「指派之第 1 個臂於交付版未作用」(應預填於做夢範本之該節點審計; 規則 R-REC-20)
            code: { artifact: path.relative(FD_ROOT, path.join(wd, 'pick.mjs')).replace(/\\/g, '/'), files: [], reused: ['g_eval.mjs', 'ctx.stat(180)'], notes: '全部為中性預設', shareable: first ? [{ file: 'helper.mjs', what: '假輔助: 依側配席' }] : [], inactiveArms: first ? arms.split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean).slice(0, 1) : [] },
            results: { claimed: { S: r.score.S, ladder: r.score.ladder, eqYrMean: r.metrics.op.eqYr.mean, eqYrMin: r.metrics.op.eqYr.min, monthlyOrders: r.metrics.op.monthlyOrders.mean, peakHold: r.metrics.op.peakHold.max, nullP: r.metrics.null.p, selHash: r.metrics.selHash }, experiments: [{ what: '範例參數', outcome: `S ${r.score.S}` }] },
            //第 1 個節點另提一筆臂目錄之提案(應列於做夢任務書之「本輪節點之提案」; 做夢之提案以 sources 涵蓋它 ⇒ 不另記入帳)
            conclusion: { outcome: 'neutral', summary: '假節點', findings: [], limitations: [], nextIdeas: [], ...(first ? { armProposals: [{ kind: 'new', layer: 'A', title: '假新機制', mechanism: '假節點所提: 依假指紋分類' }] } : {}) },
        }
        fs.writeFileSync(path.join(wd, 'node.json'), JSON.stringify(doc, null, 1), 'utf8')
        return { ok: true, agent: { kind: 'fake', model: 'fake-node' } }
    }
    if (failDream > 0) {
        failDream--
        return { ok: false, error: 'fake: 額度用盡(未交付 dream.json)', agent: { kind: 'fake', model: 'fake-dream', effort: 'none' } }
    }
    let tpl = JSON.parse(fs.readFileSync(path.join(wd, 'dream.template.json'), 'utf8'))
    let ids = tpl.audits.map((a) => a.nodeId)
    let audits = ids.map((id, i) => {
        if (i === 1) {
            return { nodeId: id, trust: 'partial', action: 'rework', evidence: ['假審計'], issues: ['持倉上限過高'], reworkBrief: '把持倉上限降為 20 並重跑' }
        }
        if (i === 2) {
            return { nodeId: id, trust: 'untrusted', action: 'delete', evidence: ['假審計'], issues: ['未實作指定之臂'], deleteWhy: '成品與指定之臂無關, 修正等於重做' }
        }
        //第 1 個受審節點(採納者): 審計定其第 1 個臂為「未作用」(規則 R-REC-20); 其餘節點不表示意見(沿用節點自報)
        let armsOf = () => {
            try {
                return JSON.parse(fs.readFileSync(path.join(st.records.nodeDir, `${id}.json`), 'utf8')).spec.arms
            }
            catch (err) {
                return []
            }
        }
        return { nodeId: id, trust: 'trusted', action: 'accept', evidence: ['假審計'], issues: [], ...(i === 0 ? { inactiveArms: armsOf().slice(0, 1) } : {}) }
    })
    //擴建(共用工具; 做夢親手寫入共用工具區): 一個合格之函式片段、一個不合格之診斷腳本(匯入 lib/ ⇒ 應被迴圈還原), 並更新索引
    let tbDir = path.join(st.rsi.root, 'toolbox')
    let tbRel = path.relative(FD_ROOT, tbDir).replace(/\\/g, '/')
    fs.mkdirSync(path.join(tbDir, 'snippets'), { recursive: true })
    fs.mkdirSync(path.join(tbDir, 'diag'), { recursive: true })
    fs.writeFileSync(path.join(tbDir, 'snippets', 'draw.mjs'), '//自池中以 ctx.rand 不重複抽 k 個(消耗 k 次 ctx.rand)\nexport let draw = (ctx, pool, k) => {\n    let a = pool.slice()\n    let out = []\n    for (let i = 0; i < k && a.length; i++) {\n        out.push(a.splice(Math.floor(ctx.rand() * a.length), 1)[0])\n    }\n    return out\n}\n', 'utf8')
    fs.writeFileSync(path.join(tbDir, 'diag', 'bad.mjs'), 'import { makeEvaluator } from \'../../../src/eval/evalCore.mjs\'\nconsole.log(typeof makeEvaluator)\n', 'utf8')
    fs.appendFileSync(path.join(tbDir, 'README.md'), '| snippets/draw.mjs | 不重複隨機抽取 | 複製函數 | 假做夢 | 假驗證 | r001 |\n| diag/bad.mjs | 假診斷 | — | 假做夢 | — | r001 |\n', 'utf8')
    let dream = {
        audits,
        //整體研判(synthesis.overview): 判為「過於集中」而向外之方向不到一半 ⇒ 輪末摘要應標「研判與配比不一致」
        synthesis: { summary: '假做夢', worked: [], failed: [], patterns: [], prevDirections: (tpl.synthesis.prevDirections || []).map((x) => ({ ...x, verdict: 'not-run', note: '假回顧' })), overview: { families: [{ name: '假家族', nodes: [ids[0]], basis: '假依據' }], coverage: { verdict: 'concentrated', why: '假依據' }, progress: { verdict: 'unknown', why: '節點太少' }, localOptimum: { risk: 'medium', why: '假依據' }, blindSpots: ['G 層未試'], adjust: '假調整', prevReview: '' } },
        expansion: [
            { item: '不重複隨機抽取', sources: [ids[0]], decision: 'built', files: [`${tbRel}/snippets/draw.mjs`], verify: '假驗證' },
            { item: '假診斷(匯入 lib/, 應被還原)', decision: 'built', files: [`${tbRel}/diag/bad.mjs`], verify: '假驗證' },
            { item: '假輔助: 依側配席', sources: [ids[0]], decision: 'declined', note: '只有一個節點用得到' },
        ],
        guidance: {
            //方向: 第 2 條為驗證類(附待驗之主張), 其餘省略 type(= 探索)
            directions: [{ arms: ['E38_maxHoldN', 'A01_nt'], base: ids[0], rationale: '於已採納節點上加持倉上限', expect: 'S 上升' }, { type: 'verify', claim: '假主張: 去重有內容', arms: ['D27_dedup'], base: null, rationale: '未試之層' }, { arms: ['Z99_none'], base: null, rationale: '不合法之臂(應被擋)' }],
            avoid: [],
            openQuestions: [],
            //改進項: 兩筆合法(迴圈架構、節點原則)+ 一筆類別不在值域者(應列為文件問題並計入未分類)
            improvements: [{ kind: 'loop', target: '操作掃描', what: '假改進甲', evidence: '假依據' }, { kind: 'node', target: '節點任務書', what: '假改進乙' }, { kind: 'misc', target: 'x', what: '類別不在值域(應被指出)' }],
            //臂目錄之提案(規則 R-ARM-1): 一筆新臂(彙整第 1 個節點所提)、一筆修訂 ⇒ 入提案帳待主控審; 第 2 輪再提同樣兩筆 ⇒ 不另立、補記再提
            armProposals: [{ kind: 'new', layer: 'A', title: '假新機制', mechanism: '依假指紋分類', boundary: '與 A10 之差', evidence: '假依據', sources: [ids[0]] }, { kind: 'revise', arm: 'A10_behaviorPre', mechanism: '假修訂後之定義' }],
        },
        docsUpdated: [],
    }
    fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify(dream, null, 1), 'utf8')
    return { ok: true, agent: { kind: 'fake', model: 'fake-dream', effort: 'none' } }
}

//臂目錄(規則 R-ARM-2): 以「現行目錄 + 一個假新層與其下一個假新臂」走整輪, 驗引擎、看板與搜尋地圖接受擴充後之目錄
//  假狀態根之擴充以正式狀態根之擴充起始(= 現行之生效目錄; 去掉出處, 免與假提案帳之編號相混); 假新層與假新臂由主控經引擎之治理審定
//  (與 tools/armDecide.mjs 同一套審定參數: decideArgsOf → rsi.governance.decide), 再組裝走整輪
//  供 agent 閱讀之生效目錄寫到 tmp/fake/arms/catalog.json; 正式之 arms/catalog.json 不得被改寫(離開碼 8 之核對)
let fpCatOut = path.join(root, 'arms', 'catalog.json')
let fpCatReal = P('arms', 'catalog.json')
let readOr = (fp) => (fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : null)
let catRealBefore = readOr(fpCatReal)
let realExt = readArmExtensions(makePaths(realRoot))
if (realExt) {
    let strip = (x) => {
        let y = { ...x }
        delete y.origin
        return y
    }
    let fakeGov = makePaths(st.rsi.root)
    fs.mkdirSync(fakeGov.governance, { recursive: true })
    writeJson(fakeGov.govExtensions, { layers: realExt.layers.map(strip), arms: realExt.arms.map(strip) })
}
let P0 = makeProjectOrExit(st, { dispatch, catalogFile: fpCatOut })
let g0 = P0.rsi.governance
let fakeLayer = nextLayerId(P0.catalog)
g0.propose({ round: 0, from: '假主控', items: [{ kind: 'layer', title: '假新層', mechanism: '驗擴充' }, { kind: 'new', layer: fakeLayer, title: '假新臂', mechanism: '假機制之中性描述' }] })
let decideFake = (id, o) => {
    let a = decideArgsOf(g0.list().find((x) => x.id === id), { accept: true, why: '假審定', ...o, catalog: g0.effectiveCatalog() })
    if (a.error) {
        throw new Error(a.error)
    }
    return g0.decide(id, a.args)
}
decideFake('P001', { desc: '驗擴充' })
let fakeArm = decideFake('P002', { name: 'fakeNew' }).item.decision.ref
let Pj = makeProjectOrExit(st, { dispatch, catalogFile: fpCatOut })
Pj.rsi.init()
let round = peekRound(Pj.rsi.paths)
let res = await Pj.rsi.auto({ by: 'fake', protocol: { round }, arms: 3, novelty: 3, workers: 3, noDream: true })
if (process.argv.includes('--redream')) {
    //補做夢(規則 R-RUN-6): 第 1 次做夢未交付 ⇒ 輪末回調失敗、節點維持未審、pendingDream 指到本輪之全部已執行節點;
    //  redream 後: 做夢文件有審計、pendingDream 為空; 其後之各項核對(改進項、擴建、整體研判、前緣)與一般輪次相同
    let exec = res.nodes.filter((n) => n.status === 'executed')
    let pd = Pj.pendingDream()
    let trustOf = (id) => {
        let x = Pj.rsi.store.getNode(id); return (x && x.evidence && x.evidence.trust) || null
    }
    let okFail = res.hook.failed === true && (res.hook.lines || []).some((l) => l.includes('未交付做夢文件')) && !!pd && pd.round === round && pd.nodeIds.length === exec.length && exec.every((n) => pd.nodeIds.includes(n.id) && trustOf(n.id) === null)
    let hk = await Pj.redream(round)
    let dd = Pj.records.getDreamDoc(round)
    let okRe = !!(hk && hk.dream) && Pj.pendingDream() === null && Array.isArray(dd.audits) && dd.audits.length === exec.length && trustOf(exec[0].id) === 'trusted'
    console.log('\n=== 補做夢 ===')
    console.log(JSON.stringify({ firstHookFailed: res.hook.failed, pending: pd ? { round: pd.round, n: pd.nodeIds.length } : null, okFail, redreamDelivered: !!(hk && hk.dream), pendingAfter: Pj.pendingDream(), okRe }))
    if (!okFail || !okRe) {
        console.error('補做夢不如預期')
        process.exitCode = 7
    }
    res.hook = { failed: hk.failed === true, errors: hk.errors || [], lines: hk.lines || [] }
}
console.log('\n=== 結果 ===')
console.log('nodes:', res.nodes.map((n) => `${n.id.slice(0, 8)} ${n.status} S ${n.score ? n.score.S : '-'} L${n.score ? n.score.ladder : '-'}`).join(' | '))
console.log('hook:', JSON.stringify({ failed: res.hook.failed, errors: res.hook.errors, lines: res.hook.lines }, null, 1))
let idx = Pj.rsi.store.listIndex()
console.log('index:', idx.map((r) => `${r.id.slice(0, 8)} ${r.status}`).join(' | '))
for (let r of idx) {
    let n = Pj.rsi.store.getNode(r.id)
    console.log(`  ${r.id.slice(0, 8)} status ${n.status} trust ${n.evidence ? n.evidence.trust : '-'} S ${n.score ? n.score.S : '-'} 階梯 ${n.score ? n.score.ladder : '-'} 回測期 ${n.score ? n.score.flags.backtest : '-'} vetoed ${n.score ? n.score.flags.vetoed : '-'} attempt ${n.raw ? n.raw.attempt : '-'}`)
}
console.log('frontier:', Pj.rsi.store.listFrontier().map((f) => `${f.spec.arms.join('+')}${f.spec.base ? `←${f.spec.base.slice(0, 6)}` : ''} ${f.status} p${f.priority}`).join(' | '))
console.log('records/nodes:', fs.readdirSync(st.records.nodeDir).join(' '))
console.log('records/trash:', fs.existsSync(st.records.trashDir) ? fs.readdirSync(st.records.trashDir).length : 0, '檔')
console.log('records/dreams:', fs.readdirSync(st.records.dreamDir).join(' '))
let dry = await Pj.rsi.explore({ dry: true, arms: 3, novelty: 3 })
console.log('下一輪計畫:', dry.items.map((it) => `${it.spec.arms.join('+')}${it.spec.base ? `←${it.spec.base.slice(0, 6)}` : ''}(${it.kindOf})`).join(' | '))
console.log('state:', JSON.stringify(Pj.getState()))
console.log('做夢方向之處置:', JSON.stringify((Pj.records.getDreamDoc(round).harness.applied || {}).proposals))
{
    //改進項之分類: 筆數(迴圈架構 1、節點原則 1、未分類 1)與文件問題(類別不在值域)須如預期, 否則以非 0 離開
    let h = Pj.records.getDreamDoc(round).harness
    let im = (h.tally && h.tally.improvements) || {}
    console.log('改進項之分類:', JSON.stringify(h.tally), '| 文件問題:', JSON.stringify(h.docIssues))
    let md = fs.readFileSync(Pj.records.paths.dreamMd(round), 'utf8')
    let ok = im.total === 3 && im.loop === 1 && im.node === 1 && im.unclassified === 1 && (h.docIssues || []).some((x) => /improvements\[2\]\.kind/.test(x)) && md.includes('〔迴圈架構〕操作掃描:假改進甲(依據:假依據)') && (res.hook.lines || []).some((l) => /改進項 3 筆:迴圈架構 1、節點原則 1、未分類 1/.test(l))
    if (!ok) {
        console.error('改進項之分類不如預期')
        process.exitCode = 3
    }
    //擴建(共用工具; 做夢統籌): 合格之片段留下、匯入 lib/ 之診斷腳本被還原; 做夢任務書列出節點自報; 節點任務書指向索引; 摘要列筆數
    let tb = h.toolbox || {}
    let tbDir = path.join(st.rsi.root, 'toolbox')
    let dBrief = fs.readFileSync(path.join(Pj.arsi.dreamWorkDir(round), 'brief.md'), 'utf8')
    let nBrief = fs.readFileSync(path.join(st.records.workDir, res.nodes[0].id, 'brief.md'), 'utf8')
    console.log('擴建:', JSON.stringify(h.tally.expansion), '| 共用工具區:', JSON.stringify(tb), '| 區內之檔:', Pj.toolbox.list().map((f) => f.rel).join(' '))
    let okTb = fs.existsSync(path.join(tbDir, 'snippets', 'draw.mjs')) && !fs.existsSync(path.join(tbDir, 'diag', 'bad.mjs')) &&
        (tb.reverted || []).length === 1 && /診斷腳本只可匯入 node 內建模組/.test(tb.reverted[0].why) &&
        (tb.issues || []).some((x) => /diag\/bad\.mjs 不在共用工具區/.test(x)) && (tb.issues || []).some((x) => /索引未列|README/.test(x)) === false &&
        h.tally.expansion.total === 3 && h.tally.expansion.built === 2 && h.tally.expansion.declined === 1 &&
        /本輪節點自報:`[0-9a-f]{8}` helper\.mjs/.test(dBrief) && dBrief.includes('## 4. 擴建:共用工具') &&
        nBrief.includes('**共用工具索引**') && nBrief.includes('**任務類型:探索**') &&
        (res.hook.lines || []).some((l) => /3 項:新增 2、不納入 1;節點自報可共用 1 筆/.test(l) && /還原 1 檔/.test(l)) &&
        md.includes('〔新增〕不重複隨機抽取') && md.includes('2. 〔驗證〕臂 D27_dedup;起點 無;待驗之主張: 假主張: 去重有內容') &&
        //配比: 假做夢之 3 條方向皆非向外(有起點者、驗證類、不在目錄之臂)⇒ 摘要列「向外 0、向內 3」並標出無向外之方向
        (res.hook.lines || []).some((l) => /配比 向外 0、向內 3;\*\*無向外之方向\*\*/.test(l))
    if (!okTb) {
        console.error('擴建(共用工具)不如預期')
        process.exitCode = 5
    }
    //整體研判(synthesis.overview; 規則 R-REC-14): 做夢任務書要求此欄並指向搜尋地圖; 搜尋地圖已產生; 三個判定列入輪末摘要與做夢文件;
    //  假做夢判「過於集中」而探索類之方向(2 條)皆未標押新家族 ⇒ 摘要標「研判與配比不一致」; 家族之歸類入搜尋地圖
    let fpMap = path.join(st.rsi.root, 'SEARCH_MAP.md')
    let map = fs.existsSync(fpMap) ? fs.readFileSync(fpMap, 'utf8') : ''
    let okOv = dBrief.includes('`synthesis.overview`') && dBrief.includes('rsi/SEARCH_MAP.md') && dBrief.includes('`newFamily`')
    okOv = okOv && /## 1\. 逐輪趨勢[\s\S]*## 2\. 各層之覆蓋[\s\S]*## 3\. 譜系[\s\S]*## 4\. 集中度之機械指標/.test(map) &&
        map.includes('〔假家族〕') && /\*\*機制家族\*\*.做夢 r\d+ 之歸類..假家族 1 個/.test(map) &&
        h.tally.overview && h.tally.overview.coverage === 'concentrated' && h.tally.overview.progress === 'unknown' && h.tally.overview.localOptimum === 'medium' && h.tally.overview.nFamilies === 1 &&
        (res.hook.lines || []).some((l) => /整體研判:機制家族 1 個;搜尋之集中度 過於集中、進度 樣本不足以判定、卡在局部最佳點之風險 中;探索類方向 2 條中押新家族者 0 條;\*\*研判與配比不一致\*\*/.test(l)) &&
        md.includes('### 整體研判') && md.includes('搜尋之集中度:**過於集中**') && md.includes('- **假家族**:')
    console.log('整體研判:', JSON.stringify(h.tally.overview), '| hook:', JSON.stringify((res.hook.lines || []).filter((l) => /整體研判/.test(l))))
    if (!okOv) {
        console.error('整體研判不如預期')
        process.exitCode = 6
    }
    //臂目錄之提案與擴充(規則 R-ARM-1、R-ARM-2): 節點與做夢之任務書皆明寫可提; 節點所提者列於做夢任務書; 做夢之 2 筆入提案帳待審(節點那筆已被做夢彙整, 不另記);
    //  輪末摘要列筆數與待審數; 擴充後之目錄: 假新臂為可選、所屬之層為假新層、看板與搜尋地圖列出
    //  提案帳為引擎之治理(<狀態根>/governance/): 假主控之 2 筆已通過(新層、新臂; ref 為所配之代號)+ 本輪做夢之 2 筆待審
    //  引擎之目錄(rsi.arms)與領域同一份生效目錄: 假新臂可選(其算子已登錄 ⇒ 無「治理之擴充」之警告);
    //  供 agent 閱讀之生效目錄已寫出(含假新層與假新臂、不含出處、臂數 = 生效目錄); 正式之 arms/catalog.json 未被改寫
    let led = Pj.rsi.governance.ledger()
    let pend = led.items.filter((x) => x.status === 'pending')
    let ledMd = readOr(Pj.rsi.paths.govProposalsMd) || ''
    let catOut = JSON.parse(readOr(fpCatOut) || 'null')
    let boardMd = fs.readFileSync(path.join(st.rsi.root, 'ARMS_BOARD.md'), 'utf8')
    let okArm = nBrief.includes('`conclusion.armProposals`') && nBrief.includes('臂目錄不是封閉的') && dBrief.includes('`guidance.armProposals`') && dBrief.includes('governance/PROPOSALS.md') &&
        /本輪節點之提案[^\n]*`[0-9a-f]{8}` 〔新臂〕假新機制/.test(dBrief) &&
        led.items.length === 4 && led.items.slice(0, 2).every((x) => x.status === 'accepted' && x.decision.by === '主控') && led.items[0].decision.ref === fakeLayer && led.items[1].decision.ref === fakeArm &&
        pend.length === 2 && pend.every((x) => x.from === 'dream' && x.round === round) && pend[0].kind === 'new' && pend[1].kind === 'revise' && pend[1].note === null &&
        ledMd.includes('## 待審(2 筆)') && ledMd.includes('〔新臂〕假新機制(層:A)') &&
        Pj.rsi.arms.list({ selectable: true }).some((a) => a.id === fakeArm) && !(Pj.rsi.arms.warnings || []).some((w) => w.includes(fakeArm)) &&
        !!catOut && catOut.layers[fakeLayer] === '假新層:驗擴充' && catOut.arms.some((a) => a.id === fakeArm && a.selectable === true) && catOut.arms.every((a) => a.origin === undefined) && catOut.arms.length === Pj.catalog.arms.length &&
        readOr(fpCatReal) === catRealBefore &&
        (res.hook.lines || []).some((l) => l.includes('臂目錄之提案:做夢 2 筆(新臂 1、修訂 1)、節點 1 筆;**待主控審 2 筆**')) &&
        h.tally.armProposals.total === 2 && md.includes('- 臂目錄之提案(待主控審查;通過者下一輪加入目錄):') &&
        //提案之節點(第 1 個派工者)於假審計中可能被判刪除 ⇒ 其文件在回收夾; 兩處都找
        [st.records.nodeDir, st.records.trashDir].some((dir) => fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.md') && fs.readFileSync(path.join(dir, f), 'utf8').includes('- 臂目錄之提案(由做夢彙整、主控審查):'))) &&
        Pj.selectable.some((a) => a.id === fakeArm) && Pj.layerOfSpec({ arms: [fakeArm, 'A01_nt'] }) === fakeLayer && boardMd.includes(fakeArm) && map.includes(`| ${fakeLayer} 假新層:驗擴充 |`)
    console.log('臂目錄之提案:', JSON.stringify(led.items.map((x) => `${x.id} ${x.kind} ${x.status}`)), '| 假新臂:', fakeArm, '| 供 agent 之目錄:', catOut ? `${catOut.arms.length} 臂` : '未寫出', '| 正式之 arms/catalog.json:', readOr(fpCatReal) === catRealBefore ? '未動' : '**被改寫**', '| hook:', JSON.stringify((res.hook.lines || []).filter((l) => l.includes('臂目錄之提案'))))
    if (!okArm) {
        console.error('臂目錄之提案 / 擴充不如預期')
        process.exitCode = 8
    }
    //補位載體(規則 R-REC-19): 樹上已有「可信、未被否決、臂數未滿」之成品時, 尚未試過之取法 / 執行層(D、E)之臂以其中 S 最高者為底(arms = 底之臂 + 該臂);
    //  其餘層照舊為單臂根節點; 無此成品(冷啟動、或唯一可信者被否決)⇒ D / E 亦為單臂根節點; 有底之載體其任務之起點即該成品
    let cs = Pj.domain.carriers()
    let bt = idx.map((r) => Pj.rsi.store.getNode(r.id)).filter((n) => n && n.status === 'executed' && n.score && !(n.score.flags && n.score.flags.vetoed) && n.evidence && n.evidence.trust === 'trusted' && n.spec.arms.length < 4).sort((a, b) => b.score.S - a.score.S)[0] || null
    let cD = cs.D30_volumeCut
    let cE = cs.E39_skipWeekend
    let cA = cs.A02_ntPit
    //底之臂只帶作用中者(規則 R-REC-20): 載體之臂 = 底之作用中之臂 + 該臂; 任務之起點另列底之未作用之臂
    let btOff = bt ? Pj.inactiveArmsOf(bt) : []
    let btAct = bt ? bt.spec.arms.filter((a) => !btOff.includes(a)) : []
    let okCar = !!cD && !!cE && !!cA && cA.base === null && cA.arms.length === 1 &&
        (bt
            ? cD.base === bt.id && cD.arms.includes('D30_volumeCut') && btAct.every((a) => cD.arms.includes(a)) && cD.arms.length === btAct.length + 1 && cE.base === bt.id && Pj.taskFor(cD).base.arms.join('+') === bt.spec.arms.join('+') && Pj.taskFor(cD).base.inactiveArms.join('+') === btOff.join('+')
            : cD.base === null && cD.arms.length === 1 && cE.base === null)
    console.log('補位載體:', bt ? `以 ${bt.id.slice(0, 8)}(${bt.spec.arms.join('+')}${btOff.length ? `;未作用 ${btOff.join('+')}` : ''})為底` : '樹上無可信且未被否決之成品 ⇒ 中性底', '| D30:', JSON.stringify(cD), '| E39:', JSON.stringify(cE), '| A02:', JSON.stringify(cA))
    if (!okCar) {
        console.error('補位載體不如預期')
        process.exitCode = 9
    }
    //未作用之臂(規則 R-REC-20): 節點任務書要求自報、做夢任務書要求定案; 做夢範本以節點自報預填(只有第 1 個派工之節點自報 1 個);
    //  審計所定者記入樹(evidence.inactiveArms)並渲染於做夢文件; 看板之節點一覽與搜尋地圖之譜系標「未作用」; 看板之該臂列「其中交付版未作用 1」而最佳 S 不計它
    let tplD = JSON.parse(fs.readFileSync(path.join(Pj.arsi.dreamWorkDir(round), 'dream.template.json'), 'utf8'))
    let x0 = Pj.rsi.store.getNode(tplD.audits[0].nodeId)
    let off0 = x0 ? Pj.inactiveArmsOf(x0) : []
    let okOff = nBrief.includes('`code.inactiveArms`') && dBrief.includes('**定未作用之臂** `inactiveArms`') &&
        tplD.audits.every((a) => Array.isArray(a.inactiveArms)) && tplD.audits.filter((a) => a.inactiveArms.length === 1).length === 1 &&
        !!x0 && !!x0.evidence && Array.isArray(x0.evidence.inactiveArms) && off0.length === 1 && off0[0] === x0.spec.arms[0] &&
        boardMd.includes(`${off0[0]}(未作用)`) && map.includes(`${off0[0]}(未作用)`) &&
        boardMd.split('\n').some((l) => l.startsWith(`| ${off0[0]} |`) && l.trimEnd().endsWith('| 1 | 1 | — | — |')) &&
        md.includes(`- 未作用之臂(指派而交付版未實現者): ${off0[0]}`)
    console.log('未作用之臂:', x0 ? `${x0.id.slice(0, 8)} ${JSON.stringify(off0)}` : '—', '| 範本預填:', JSON.stringify(tplD.audits.map((a) => a.inactiveArms)))
    if (!okOff) {
        console.error('未作用之臂不如預期')
        process.exitCode = 10
    }
    //擴充診斷自帶之看板值與提示(規則 R-REC-21): 做夢任務書寫明此約定; 於一個節點之重放結果補入假診斷之 board / boardLabel 後重產看板 ⇒
    //  看板之表前列欄名、該節點之列有「診斷名 值」、其餘節點為「—」; 搜尋地圖之譜系該節點帶「擴充診斷 …」; 出錯之診斷不列
    if (x0) {
        Pj.rsi.store.updateNode(x0.id, (x) => {
            x.raw = { ...x.raw, metrics: { ...x.raw.metrics, ext: { ...((x.raw.metrics && x.raw.metrics.ext) || {}), fakeDiag: { text: '假診斷', board: '98.5 / +13.4', boardLabel: '假欄名(重啟之均 / 承接差)', flag: '假提示' }, fakeBoom: { error: '壞了', board: '不應出現' } } } }
        })
        Pj.writeBoard()
        let b2 = fs.readFileSync(path.join(st.rsi.root, 'ARMS_BOARD.md'), 'utf8')
        let m2 = fs.readFileSync(path.join(st.rsi.root, 'SEARCH_MAP.md'), 'utf8')
        let row = b2.split('\n').find((l) => l.startsWith(`| \`${x0.id}\` |`)) || ''
        let others = b2.split('\n').filter((l) => /^\| `[0-9a-f]{16}` \|/.test(l) && !l.startsWith(`| \`${x0.id}\` |`))
        let nCol = (l) => l.split('|').length
        let head = b2.split('\n').find((l) => l.startsWith('| 節點 | 臂 |')) || ''
        let okExt = dBrief.includes('`board` / `boardLabel`') && head.includes('| 擴充診斷之看板值 |') &&
            b2.includes('`fakeDiag` = 假欄名(重啟之均 / 承接差)') && row.includes('fakeDiag 98.5 / +13.4') && !b2.includes('不應出現') &&
            others.length > 0 && others.every((l) => !l.includes('fakeDiag')) && [row, ...others].every((l) => nCol(l) === nCol(head)) &&
            m2.split('\n').some((l) => l.includes(`\`${x0.id.slice(0, 8)}\``) && l.includes('擴充診斷 fakeDiag 98.5 / +13.4'))
        console.log('擴充診斷之看板值:', JSON.stringify({ head: head.includes('擴充診斷之看板值'), row: row.includes('fakeDiag 98.5 / +13.4'), others: others.length, cols: nCol(head) }))
        if (!okExt) {
            console.error('擴充診斷之看板值不如預期')
            process.exitCode = 11
        }
        //擴充診斷自述「組成對照不是挑選內容之量」(規則 R-REC-22): 假診斷帶 notContent ⇒ 看板之表前列出該節點與理由、搜尋地圖之譜系於組成對照後註明、
        //  搜尋地圖之「有內容」不計該節點; 拿掉後皆復原(其後之各項核對不受影響)
        {
            let nContentOf = (md) => {
                let mm = /有內容之節點 (\d+) 個/.exec(md); return mm ? Number(mm[1]) : null
            }
            let setNc = (v) => Pj.rsi.store.updateNode(x0.id, (x) => {
                let fd = { ...x.raw.metrics.ext.fakeDiag }
                if (v) {
                    fd.notContent = v
                }
                else {
                    delete fd.notContent
                }
                x.raw = { ...x.raw, metrics: { ...x.raw.metrics, ext: { ...x.raw.metrics.ext, fakeDiag: fd } } }
            })
            let read = () => ({ b: fs.readFileSync(path.join(st.rsi.root, 'ARMS_BOARD.md'), 'utf8'), m: fs.readFileSync(path.join(st.rsi.root, 'SEARCH_MAP.md'), 'utf8') })
            let n0 = nContentOf(m2)
            setNc('假理由|含直線')
            Pj.writeBoard()
            let a = read()
            let lineA = a.m.split('\n').find((l) => l.includes(`\`${x0.id.slice(0, 8)}\``) && l.includes('不計為挑選內容')) || ''
            let okNc = dBrief.includes('`notContent`') && a.b.includes('組成對照不是挑選內容之量') && a.b.includes(`\`${x0.id.slice(0, 8)}\`(fakeDiag: 假理由 含直線)`) &&
                lineA.includes('fakeDiag: 假理由 含直線') && !lineA.includes('**有內容**') && nContentOf(a.m) !== null && nContentOf(a.m) <= n0
            setNc(null)
            Pj.writeBoard()
            let z = read()
            okNc = okNc && !z.b.includes('組成對照不是挑選內容之量**(搜尋地圖') && !z.m.split('\n').some((l) => l.includes('不計為挑選內容 ——')) && nContentOf(z.m) === n0
            console.log('擴充診斷之 notContent:', JSON.stringify({ board: a.b.includes('組成對照不是挑選內容之量'), map: !!lineA, nContent: [n0, nContentOf(a.m), nContentOf(z.m)] }))
            if (!okNc) {
                console.error('擴充診斷之 notContent 不如預期')
                process.exitCode = 14
            }
        }
        //量尺之子集與擴充診斷之補算(規則 R-REC-27):
        //  ①子集: 假診斷帶 subset 且該節點「有內容且可信」⇒ 搜尋地圖 §1 之後列「量尺之子集」與該節點; 拿掉後不列
        //  ②補算: 拿掉該節點之一個真實擴充診斷之值 → extFill 只補該診斷 ⇒ 值與原本相同(同一算法)、選集指紋與分數不變、節點文件註明; 指名不存在之診斷 ⇒ 拋錯
        {
            let readMap = () => fs.readFileSync(path.join(st.rsi.root, 'SEARCH_MAP.md'), 'utf8')
            let n1 = Pj.rsi.store.getNode(x0.id)
            let keepNsa = n1.raw.metrics.nullSideAct
            let keepTrust = n1.evidence ? n1.evidence.trust : null
            let keepVeto = !!(n1.score && n1.score.flags && n1.score.flags.vetoed)
            Pj.rsi.store.updateNode(x0.id, (x) => {
                x.raw = { ...x.raw, metrics: { ...x.raw.metrics, nullSideAct: { ...(x.raw.metrics.nullSideAct || {}), excess: 5, p: 0.01, share: 0.1, mean: 1 }, ext: { ...x.raw.metrics.ext, fakeDiag: { ...x.raw.metrics.ext.fakeDiag, subset: '假子集|含直線' } } } }
                if (x.score && x.score.flags) {
                    x.score = { ...x.score, flags: { ...x.score.flags, vetoed: false } }
                }
            })
            Pj.writeBoard()
            let ma = readMap()
            let lineS = ma.split('\n').find((l) => l.startsWith('- 「假子集 含直線」')) || ''
            let okSub = dBrief.includes('`subset`') && keepTrust === 'trusted' && ma.includes('**量尺之子集**') && lineS.includes('擴充診斷 `fakeDiag`') && lineS.includes(`\`${x0.id.slice(0, 8)}\``) && lineS.includes('其中 1 個屬此子集')
            Pj.rsi.store.updateNode(x0.id, (x) => {
                let fd = { ...x.raw.metrics.ext.fakeDiag }
                delete fd.subset
                x.raw = { ...x.raw, metrics: { ...x.raw.metrics, nullSideAct: keepNsa, ext: { ...x.raw.metrics.ext, fakeDiag: fd } } }
                if (x.score && x.score.flags) {
                    x.score = { ...x.score, flags: { ...x.score.flags, vetoed: keepVeto } }
                }
            })
            Pj.writeBoard()
            okSub = okSub && !readMap().includes('**量尺之子集**')
            //②補算: 假輪次之子行程評估取用正式之共用工具區 ⇒ 於假共用工具區放同名之檔, 使迴圈端認得此診斷名(驗後移除)
            let nm = 'nullRecentAct'
            let fdM = path.join(st.rsi.root, 'toolbox', 'metrics')
            let srcM = path.join(realToolboxDir, 'metrics', `${nm}.mjs`) //真實專案之共用工具區(同評估之子行程之解析); fdM 為假專案之(st.rsi.root 已改為假根)
            let okFill = false
            let info = {}
            let n2 = Pj.rsi.store.getNode(x0.id)
            let orig = n2.raw.metrics.ext && n2.raw.metrics.ext[nm]
            if (fs.existsSync(srcM) && orig && !orig.error) {
                fs.mkdirSync(fdM, { recursive: true })
                fs.copyFileSync(srcM, path.join(fdM, `${nm}.mjs`))
                try {
                    let s0 = n2.score.S
                    let h0 = n2.raw.metrics.selHash
                    Pj.rsi.store.updateNode(x0.id, (x) => {
                        let e = { ...x.raw.metrics.ext }
                        delete e[nm]
                        x.raw = { ...x.raw, metrics: { ...x.raw.metrics, ext: e } }
                    })
                    let threw = false
                    try {
                        await Pj.extFill({ names: ['noSuchDiag'] })
                    }
                    catch (err) {
                        threw = /無此擴充診斷/.test(String(err.message))
                    }
                    let rf = await Pj.extFill({ names: [nm], only: [x0.id] })
                    let n3 = Pj.rsi.store.getNode(x0.id)
                    let strip = (o) => {
                        let c = { ...(o || {}) }; delete c.ms; return JSON.stringify(c)
                    }
                    let d3 = Pj.records.getNodeDoc(x0.id)
                    //第二次: 已有值 ⇒ 不重算
                    let rf2 = await Pj.extFill({ names: [nm], only: [x0.id] })
                    info = { threw, results: rf.results.map((x) => ({ ok: x.ok, filled: x.filled, error: x.error })), same: strip(n3.raw.metrics.ext[nm]) === strip(orig), S: [s0, n3.score.S], again: rf2.results.length }
                    okFill = threw && rf.nNodes === 1 && rf.results.length === 1 && rf.results[0].ok === true && rf.results[0].filled.join() === nm &&
                        info.same && n3.score.S === s0 && n3.raw.metrics.selHash === h0 && !!n3.raw.metrics.ext.fakeDiag &&
                        !!d3 && d3.harness.notes.some((s) => String(s).includes(`補算擴充診斷:${nm}`)) && strip(d3.harness.raw.metrics.ext[nm]) === strip(orig) &&
                        rf2.results.length === 0 &&
                        !(fs.existsSync(path.join(st.rsi.root, 'fill')) && fs.readdirSync(path.join(st.rsi.root, 'fill')).some((f) => f.includes('.tmp-')))
                }
                finally {
                    fs.rmSync(path.join(fdM, `${nm}.mjs`), { force: true })
                }
            }
            else if (!fs.existsSync(srcM)) {
                //略過之兩種情形之一: 正式之共用工具區無該名之診斷檔
                info = { skipped: `正式之共用工具區無此診斷(無 metrics/${nm}.mjs)` }
            }
            else if (orig === undefined) {
                //略過之兩種情形之二: 有該診斷之檔而第一個節點無其值(只認 undefined; 評估器只產生物件〔診斷之輸出; 載入失敗或拋錯者為 { error }〕或 undefined〔未載入〕)
                info = { skipped: '第一個節點無其值' }
            }
            else {
                //有該診斷之檔、第一個節點有其值而不是正常之結果: 為錯誤(診斷載入失敗或執行拋錯; 帶 error), 或非 undefined 之假值(null、0、false 等; 評估器不產生, 同改前視為失敗)
                //  ⇒ 不是略過 —— 為失敗(離開碼 15; 同改前); 文字對 null 等值安全(假值不取 .error)
                info = { valueError: `該節點之值為錯誤: ${(orig && orig.error ? String(orig.error).split('\n')[0] : `非診斷之結果(${JSON.stringify(orig)})`).slice(0, 120)}` }
            }
            //②之二 自備之假診斷(不依賴使用端之共用工具區; 名稱為中性之 fakeProbe): 於假共用工具區放一個診斷檔(使迴圈端認得此診斷名), 補算之評估(原為 g_eval.mjs 之子行程;
            //  其載入之共用工具區為專案之正式者)以替身 runEval 取代 —— 替身回「正本之選集指紋 + 假診斷之值」之結果檔; 只驗補算之接線(extFill → fill → 併入樹與節點文件 → 補算檔):
            //  值併入、分數與選集指紋不變、節點文件註明、補算檔寫成而無暫存檔、已有值者再補不重算、指名不存在者拋錯(評估本身之同一算法需要真實之擴充診斷, 見上一段; 無者略過)
            let pn = 'fakeProbe'
            let probeInfo = {}
            let okProbe = false
            {
                let n4 = Pj.rsi.store.getNode(x0.id)
                let sel4 = n4.raw.metrics.selHash
                let s4 = n4.score.S
                let val = { text: '假探針', n: 3 }
                let calls = []
                let stub = async ({ nodeId, kind, args }) => {
                    calls.push({ nodeId, kind, only: args[args.indexOf('--ext-only') + 1] })
                    writeJson(args[args.indexOf('--out') + 1], { ok: true, metrics: { selHash: sel4, ext: { [pn]: val } } })
                    return { code: 0, timeout: false }
                }
                fs.mkdirSync(fdM, { recursive: true })
                fs.writeFileSync(path.join(fdM, `${pn}.mjs`), 'export default function (api) {\n    return { text: \'假探針\' }\n}\n', 'utf8')
                try {
                    let threw2 = false
                    try {
                        await Pj.extFill({ names: ['noSuchProbe'], runEval: stub })
                    }
                    catch (err) {
                        threw2 = /無此擴充診斷/.test(String(err.message))
                    }
                    let rp = await Pj.extFill({ names: [pn], only: [x0.id], runEval: stub })
                    let n5 = Pj.rsi.store.getNode(x0.id)
                    let d5 = Pj.records.getNodeDoc(x0.id)
                    let rp2 = await Pj.extFill({ names: [pn], only: [x0.id], runEval: stub })
                    probeInfo = { threw: threw2, results: rp.results.map((x) => ({ ok: x.ok, filled: x.filled, error: x.error })), calls: calls.length, again: rp2.results.length }
                    okProbe = threw2 && rp.nNodes === 1 && rp.results.length === 1 && rp.results[0].ok === true && rp.results[0].filled.join() === pn &&
                        calls.length === 1 && calls[0].nodeId === x0.id && calls[0].kind === 'ext' && calls[0].only === pn &&
                        JSON.stringify(n5.raw.metrics.ext[pn]) === JSON.stringify(val) && n5.score.S === s4 && n5.raw.metrics.selHash === sel4 && !!n5.raw.metrics.ext.fakeDiag &&
                        !!d5 && d5.harness.notes.some((s) => String(s).includes(`補算擴充診斷:${pn}`)) &&
                        rp2.results.length === 0 &&
                        !(fs.existsSync(path.join(st.rsi.root, 'fill')) && fs.readdirSync(path.join(st.rsi.root, 'fill')).some((f) => f.includes('.tmp-')))
                }
                finally {
                    fs.rmSync(path.join(fdM, `${pn}.mjs`), { force: true })
                }
            }
            //補算之「真實診斷」一項只在兩種情形略過(不計為失敗, 輸出明示略過與原因): ①正式之共用工具區無該名之診斷檔(例: 全新之專案尚無任何擴充診斷)②第一個節點無其值;
            //  有檔而第一個節點之值為錯誤、或有值而補算失敗者為失敗(離開碼 15; 同改前); 子集之項與自備假診斷之項照常核對
            let fillSkipped = info.skipped !== undefined
            console.log('量尺之子集與擴充診斷之補算:', JSON.stringify({ subset: okSub, fill: fillSkipped ? 'skipped' : okFill, ...info }))
            console.log('自備假診斷之補算(替身評估):', JSON.stringify({ probe: okProbe, ...probeInfo }))
            let failMain = !okSub || (!fillSkipped && !okFill)
            if (failMain) {
                console.error('量尺之子集 / 擴充診斷之補算不如預期')
            }
            if (!okProbe) {
                console.error('自備假診斷之補算(替身評估)不如預期 —— 套件之補算接線有誤(與專案之共用工具區無關)')
            }
            if (failMain || !okProbe) {
                process.exitCode = 15
            }
        }
        //「已試」之兩項修正(規則 R-REC-19、R-REC-20):
        //  ①前緣內尚未執行之做夢方向已含之臂不另出載體(假做夢之方向含 D27_dedup、E38_maxHoldN、A01_nt)
        //  ②依修訂後之定義不屬該臂者(evidence.offDefArms)不計入已試: 該臂無其他節點時, 回到看板之「未試之可選臂」; 清除後復原
        let cs0 = Pj.domain.carriers()
        let arm0 = x0.spec.arms[0]
        let onlyOne = idx.map((r) => Pj.rsi.store.getNode(r.id)).filter((n) => n && n.status === 'executed' && n.spec.arms.includes(arm0)).length === 1
        //(全形括號與冒號以 . 比對, 避免半形 / 全形打錯而靜默不中)
        let unOf = () => (/未試之可選臂.(\d+)..([^\n]*)/.exec(fs.readFileSync(path.join(st.rsi.root, 'ARMS_BOARD.md'), 'utf8')) || [])[2] || ''
        let un0 = unOf()
        Pj.rsi.setEvidence(x0.id, { offDefArms: [arm0] }, { ref: '假主控', note: '假:依修訂後之定義不屬該臂' })
        Pj.writeBoard()
        let un1 = unOf()
        let b3 = fs.readFileSync(path.join(st.rsi.root, 'ARMS_BOARD.md'), 'utf8')
        let okOd = Pj.offDefArmsOf(Pj.rsi.store.getNode(x0.id)).join('+') === arm0 && b3.includes(`${arm0}(未作用;依修訂後之定義不屬此臂)`) &&
            (!onlyOne || (!un0.split('、').includes(arm0) && un1.split('、').includes(arm0)))
        Pj.rsi.setEvidence(x0.id, { offDefArms: [] }, { ref: '假主控', note: '假:復原' })
        Pj.writeBoard()
        let okPend = !cs0.D27_dedup && !cs0.E38_maxHoldN && !cs0.A01_nt && !!cs0.D30_volumeCut
        console.log('已試之修正:', JSON.stringify({ pendSkipped: okPend, arm0, onlyOne, untriedBefore: un0.split('、').includes(arm0), untriedAfter: un1.split('、').includes(arm0), restored: !unOf().split('、').includes(arm0) || !onlyOne }))
        if (!okPend || !okOd || (onlyOne && unOf().split('、').includes(arm0))) {
            console.error('已試之修正(方向已含之臂不出載體 / 不屬該臂者不計入已試)不如預期')
            process.exitCode = 13
        }
    }
}
if (process.argv.includes('--two')) {
    //第 2 輪(--two): 走「有前次方向」之路徑 —— 做夢範本須預填前次做夢之全部方向(含不合法者), 出自方向之節點於做夢任務書標明來源, 回顧之筆數記入 tally
    //前緣改掛(規則 R-ARM-4): 第 1 輪之驗證類方向(暫掛 D27_dedup)於第 2 輪起跑前改掛假新臂 —— 舊提案結案、新提案入前緣、做夢文件之該條方向改列新臂並註記原臂;
    //  其後第 2 輪之節點依新臂派出, 任務書之來源方向(類型、主張)照舊對得上; 不合法之改掛(不在目錄之臂、前緣無此提案)被擋下
    let badArm = Pj.rearmFrontier({ arms: ['D27_dedup'], to: ['Z99_none'], why: '假:不在目錄' })
    let badHit = Pj.rearmFrontier({ arms: ['A01_nt', 'B14_pitKey', 'C19_jaccard'], to: [fakeArm], why: '假:前緣無此提案' })
    let ra = Pj.rearmFrontier({ arms: ['D27_dedup'], base: null, to: [fakeArm], why: '假:新臂通過後改掛' })
    let fr = Pj.rsi.store.listFrontier()
    let dd1 = Pj.records.getDreamDoc(round)
    let dir1 = ((dd1.guidance && dd1.guidance.directions) || []).find((x) => Array.isArray(x.rearmedFrom))
    let okRa = badArm.ok === false && badHit.ok === false && ra.ok === true && ra.arms.join('+') === fakeArm &&
        fr.some((f) => f.status === 'blocked' && f.spec.arms.join('+') === 'D27_dedup') && fr.some((f) => f.status === 'proposed' && f.spec.arms.join('+') === fakeArm && !f.spec.base && f.priority === 1) &&
        !!dir1 && dir1.arms.join('+') === fakeArm && dir1.rearmedFrom.join('+') === 'D27_dedup' && dir1.type === 'verify' &&
        fs.readFileSync(Pj.records.paths.dreamMd(round), 'utf8').includes(`〔驗證〕臂 ${fakeArm}(原暫掛 D27_dedup;臂之提案通過後由主控改掛);起點 無;待驗之主張: 假主張: 去重有內容`) &&
        ((dd1.harness && dd1.harness.addendum) || []).some((x) => String(x.text).includes(`主控改掛方向之臂:D27_dedup → ${fakeArm}`)) &&
        //改掛後: 假新臂已在待執行之方向內 ⇒ 不出載體; D27_dedup 不再有待執行之方向 ⇒ 載體重新出現
        !Pj.domain.carriers()[fakeArm] && !!Pj.domain.carriers().D27_dedup
    console.log('\n前緣改掛:', JSON.stringify({ badArm: badArm.why, badHit: badHit.why, ra }))
    if (!okRa) {
        console.error('前緣改掛不如預期')
        process.exitCode = 12
    }
    let round2 = peekRound(Pj.rsi.paths)
    let res2 = await Pj.rsi.auto({ by: 'fake', protocol: { round: round2 }, arms: 3, novelty: 3, workers: 3, noDream: true })
    let wd2 = Pj.arsi.dreamWorkDir(round2)
    let tpl2 = JSON.parse(fs.readFileSync(path.join(wd2, 'dream.template.json'), 'utf8'))
    let brief2 = fs.readFileSync(path.join(wd2, 'brief.md'), 'utf8')
    let doc2 = Pj.records.getDreamDoc(round2)
    let pd = tpl2.synthesis.prevDirections || []
    let nFrom = (brief2.match(/\| 做夢 r\d+ \|/g) || []).length
    console.log(`\n=== 第 2 輪(${round2})===`)
    console.log('nodes:', res2.nodes.map((n) => `${n.id.slice(0, 8)} ${n.spec.arms.join('+')} ${n.status}`).join(' | '))
    console.log('範本預填之前次方向:', JSON.stringify(pd.map((x) => `r${x.round}:${x.arms.join('+')}`)), '| 任務書標明來源方向之節點數:', nFrom)
    console.log('回顧之筆數:', JSON.stringify(doc2.harness.tally.prevDirections), '| hook:', JSON.stringify((res2.hook.lines || []).filter((l) => /改進項/.test(l))))
    let ok2 = pd.length === 3 && pd.every((x) => x.round === round) && nFrom >= 1 && doc2.harness.tally.prevDirections.total === 3 && doc2.harness.tally.prevDirections['not-run'] === 3 && (res2.hook.lines || []).some((l) => /前次方向之回顧 3 \/ 3 條/.test(l)) && fs.readFileSync(Pj.records.paths.dreamMd(round2), 'utf8').includes('前次方向之回顧')
    if (!ok2) {
        console.error('前次方向之回顧不如預期')
        process.exitCode = 4
    }
    //任務類型: 出自驗證類方向(原暫掛 D27_dedup、已改掛假新臂; 附待驗之主張)之節點, 其任務書為驗證類之做法要求; 節點文件記類型; 做夢任務書之表列其類型; 共用工具索引之工具數為 1
    let nv = res2.nodes.find((n) => n.spec.arms.join('+') === fakeArm && !n.spec.base)
    let bv = nv ? fs.readFileSync(path.join(st.records.workDir, nv.id, 'brief.md'), 'utf8') : ''
    let dv = nv ? Pj.records.getNodeDoc(nv.id) : null
    console.log('驗證類節點:', nv ? `${nv.id.slice(0, 8)} type ${dv && dv.task ? dv.task.type : '-'}` : '(無)', '| 摘要:', JSON.stringify((res2.hook.lines || []).filter((l) => /任務類型/.test(l))))
    let ok3 = !!nv && bv.includes('**任務類型:驗證**') && bv.includes('- **待驗之主張**:假主張: 去重有內容') && bv.includes('**只做方向指明之版本與對照**') && bv.includes('現有 1 個') &&
        dv.task.type === 'verify' && dv.task.claim === '假主張: 去重有內容' && fs.readFileSync(Pj.records.paths.nodeMd(nv.id), 'utf8').includes('任務類型: **驗證**(verify)') &&
        /\| 無 \| 驗證 \| 做夢 r\d+ \|/.test(brief2) && (res2.hook.lines || []).some((l) => /任務類型:本輪節點 探索 \d+、驗證 1/.test(l))
    if (!ok3) {
        console.error('任務類型(驗證類)不如預期')
        process.exitCode = 6
    }
    //臂目錄之提案: 第 2 輪之做夢再提同樣兩筆 ⇒ 帳上不另立(仍 2 筆待審), 原列補記「再提」, 輪末摘要註明
    let led2 = Pj.rsi.governance.ledger()
    let pend2 = led2.items.filter((x) => x.status === 'pending')
    let okArm2 = led2.items.length === 4 && pend2.length === 2 && pend2.every((x) => /再提/.test(x.note || '')) && (res2.hook.lines || []).some((l) => l.includes('其中 2 筆為帳上已有者之再提') && l.includes('**待主控審 2 筆**'))
    if (!okArm2) {
        console.error('臂目錄之提案(再提)不如預期')
        process.exitCode = 8
    }
}
console.log('--- 看板(節錄)---')
console.log(fs.readFileSync(path.join(st.rsi.root, 'ARMS_BOARD.md'), 'utf8').split('\n').slice(0, 22).join('\n'))
console.log('--- 第 1 節點文件之績效節 ---')
let d0 = fs.readFileSync(path.join(st.records.nodeDir, `${res.nodes[0].id}.md`), 'utf8')
console.log(d0.slice(d0.indexOf('## 4. 績效'), d0.indexOf('### 實驗紀錄')))
