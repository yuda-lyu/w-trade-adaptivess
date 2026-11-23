import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { getSettings, FD_ROOT } from '../src/cfg.mjs'
import * as REC from '../src/arsi/records.mjs'
import * as DOM from '../src/domain/domain.mjs'
import { makeTexts } from '../src/domain/texts.mjs'
import { specHash } from '../src/engineApi.mjs'
import { makeTmp, writeSynthLedger } from './tools/synthLedger.mjs'
//具名匯出以命名空間取得(修前之複本無 FORMS / formOf 時本檔仍可載入, 各案以斷言失敗呈現)
let { checkNodeAgentPart, checkDreamAgentPart, renderNodeMd, renderDreamMd } = REC
let { makeProject } = DOM


//成品之形式之紀錄(規則 R-REC-53; 恆有、不設開關)
//  規格: ①值域 mechanism / clue(〔機制〕/〔線索〕);無值 = 未歸類
//        ②節點文件 conclusion.form: 給了而不在值域 ⇒ 檢核不過;未給或 null 不擋;範本預填 null
//        ③做夢之審計 audits[].form: 給了而不在值域 ⇒ 檢核不過;範本預填該節點之自標(無者 null);採納時做夢有給者寫入樹之 evidence.form 與節點文件之 audit.form,未給者不寫(不以節點自標代替);重做、刪除不寫
//        ④formOf(n) = evidence.form 在值域者之值,其餘 null
//        ⑤tools/formSet.mjs: 列出 / 補記 / 清除;輪次進行中拒;S 與階梯不變;節點文件之 control.form 同步;看板與搜尋地圖重產
//        ⑥節點文件與做夢文件之 md 於有值時列出形式(無值者不多任何字)
//  合成資料: 各節點之臂、輪次、S、選集指紋、自標、做夢所給之形式逐筆相異
let NODE_MSG = 'conclusion.form 須為 mechanism / clue(成品之形式:mechanism = 〔機制〕、clue = 〔線索〕;未歸類給 null)'
let dreamMsg = (id8) => `audits[${id8}].form 須為 mechanism / clue(成品之形式:mechanism = 〔機制〕、clue = 〔線索〕;不表示意見給 null)`
let BAD = ['Mechanism', 'mech', 'clues', '', ' clue', 'none', 1, 0, true, false, [], {}, ['clue']]
let nodePart = (concl = {}) => ({ plan: { target: 't', approach: 'a', hypotheses: [] }, code: { artifact: 'rsi/work/x/pick.mjs', files: [], reused: [], notes: 'n', inactiveArms: [] }, results: { claimed: { S: 1 }, experiments: [] }, conclusion: { outcome: 'neutral', summary: 's', findings: [], limitations: [], nextIdeas: [], armProposals: [], ...concl } })
let dreamPart = (extra) => ({ audits: [{ nodeId: 'n1aaaaaaaaaaaaaa', trust: 'trusted', action: 'accept', evidence: [], issues: [], ...extra }], synthesis: { summary: 's' }, guidance: { directions: [] } })

describe('成品之形式之紀錄(規則 R-REC-53):值域、檢核、範本、渲染', function () {
    it('值域與顯示:FORMS = [mechanism, clue];formLabelOf 值域外(未給、null、他值)為「未歸類」;formOf 只認樹上之 evidence.form 在值域者', () => {
        assert.deepEqual(REC.FORMS, ['mechanism', 'clue'])
        assert.equal(typeof REC.formLabelOf, 'function', '有 formLabelOf')
        assert.deepEqual(['mechanism', 'clue', null, undefined, 'x', 1].map((f) => REC.formLabelOf(f)), ['〔機制〕', '〔線索〕', '未歸類', '未歸類', '未歸類', '未歸類'])
        assert.equal(typeof DOM.formOf, 'function', '有 formOf')
        assert.deepEqual([{ evidence: { form: 'mechanism' } }, { evidence: { form: 'clue' } }, { evidence: { form: null } }, { evidence: { form: 'Mechanism' } }, { evidence: {} }, {}, null].map((n) => DOM.formOf(n)), ['mechanism', 'clue', null, null, null, null, null])
        //不讀節點之自標(形式須經審計)
        assert.equal(DOM.formOf({ conclusion: { form: 'mechanism' }, evidence: { trust: 'trusted' } }), null)
    })

    it('節點文件之檢核:conclusion.form 未給、null、mechanism、clue 合格;給了而不在值域(含大小寫不同、空字串、數字、布林、陣列、物件)⇒ 一條固定之問題', () => {
        for (let v of [undefined, null, 'mechanism', 'clue']) {
            assert.deepEqual(checkNodeAgentPart(nodePart(v === undefined ? {} : { form: v })), [], String(v))
        }
        for (let bad of BAD) {
            assert.deepEqual(checkNodeAgentPart(nodePart({ form: bad })), [NODE_MSG], JSON.stringify(bad))
        }
        //驗證類(無 outcome、有 claimVerdict)同
        assert.deepEqual(checkNodeAgentPart(nodePart({ outcome: undefined, claimVerdict: 'confirmed', form: 'clue' })), [])
        assert.deepEqual(checkNodeAgentPart({ ...nodePart(), conclusion: { summary: 's', claimVerdict: 'refuted', form: 'x' } }), [NODE_MSG])
    })

    it('做夢文件之檢核:audits[].form 未給、null、mechanism、clue 合格;給了而不在值域 ⇒ 一條固定之問題(訊息帶節點 id 前 8 碼);各審計項分別判', () => {
        for (let v of [undefined, null, 'mechanism', 'clue']) {
            assert.deepEqual(checkDreamAgentPart(dreamPart(v === undefined ? {} : { form: v }), ['n1aaaaaaaaaaaaaa']), [], String(v))
        }
        for (let bad of BAD) {
            assert.deepEqual(checkDreamAgentPart(dreamPart({ form: bad }), ['n1aaaaaaaaaaaaaa']), [dreamMsg('n1aaaaaa')], JSON.stringify(bad))
        }
        let two = { ...dreamPart({ form: 'clue' }), audits: [{ nodeId: 'n1aaaaaaaaaaaaaa', trust: 'trusted', action: 'accept', evidence: [], issues: [], form: 'clue' }, { nodeId: 'n2bbbbbbbbbbbbbb', trust: 'partial', action: 'rework', reworkBrief: 'r', evidence: [], issues: [], form: 'MECH' }] }
        assert.deepEqual(checkDreamAgentPart(two, ['n1aaaaaaaaaaaaaa', 'n2bbbbbbbbbbbbbb']), [dreamMsg('n2bbbbbb')])
    })

    it('範本:節點之 conclusion.form 預填 null;做夢之 audits[].form 預填該節點之自標(無自標或不在值域者 null)', () => {
        let st0 = getSettings()
        let st = { ...st0, rsi: { ...st0.rsi, guides: false, formGate: false, backfill: true, exposure: true, rankBy: 'key' } }
        let tx = makeTexts({ st, FD_ROOT: st.FD_ROOT, nStrategies: 70000 })
        let task = { goal: 'g', type: 'explore', claim: null, arms: [{ id: 'A04_act', layer: 'A', layerName: 'A 資格', title: '活躍度', desc: 'd', grid: null }], base: null, refs: [], direction: null, toolbox: null }
        let tpl = tx.nodeTemplate({ workDir: path.join(st.records.workDir, 'x'), task })
        assert(Object.prototype.hasOwnProperty.call(tpl.conclusion, 'form'), '範本有 form 鍵')
        assert.strictEqual(tpl.conclusion.form, null)
        let ctx = { round: 3, nodeIds: ['n1', 'n2', 'n3', 'n4'], reworkedIds: [], workDir: path.join(st.records.workDir, 'dream_r003'), context: { nodes: [{ nodeId: 'n1', form: 'clue', inactiveArms: ['E39_skipWeekend'] }, { nodeId: 'n2', form: 'mechanism' }, { nodeId: 'n3' }, { nodeId: 'n4', form: 'bad' }] } }
        let au = tx.dreamTemplate(ctx).audits
        assert.deepEqual(au.map((a) => a.form), ['clue', 'mechanism', null, null])
        assert.deepEqual(au.map((a) => a.inactiveArms), [['E39_skipWeekend'], [], [], []], '既有之預填不變')
        assert.deepEqual(Object.keys(au[0]), ['nodeId', 'trust', 'action', 'evidence', 'issues', 'inactiveArms', 'form', 'reworkBrief', 'deleteWhy'])
    })

    it('渲染:無形式之文件不多任何字(含 null 與值域外之值);有值者:節點文件之結論段「形式(agent 自填)」、審計段「形式(審計所定)」、主控補記一列;做夢文件之審計段「形式」', () => {
        let nd = { nodeId: 'n1aaaaaaaaaaaaaa', round: 2, attempt: 1, status: 'verified', spec: { arms: ['A04_act'], base: null }, task: { goal: 'g' }, agent: null, plan: { target: 't', approach: 'a', hypotheses: [] }, code: { artifact: 'p.mjs' }, results: { claimed: {}, experiments: [] }, conclusion: { outcome: 'neutral', summary: '摘要甲', findings: [], limitations: [], nextIdeas: [] }, harness: { ok: true, score: { S: 1, ladder: 0, flags: {} } }, audit: { round: 2, by: 'm', trust: 'trusted', action: 'accept', evidence: ['e'], issues: [], reworkBrief: null, deleteWhy: null } }
        let plain = renderNodeMd(nd)
        assert(!plain.includes('形式'), '無形式者無「形式」字樣')
        for (let v of [null, 'x', 1]) {
            assert.equal(renderNodeMd({ ...nd, conclusion: { ...nd.conclusion, form: v }, audit: { ...nd.audit, form: v } }), plain, `值域外(${v})不列`)
        }
        let md = renderNodeMd({ ...nd, conclusion: { ...nd.conclusion, form: 'clue' }, audit: { ...nd.audit, form: 'mechanism' }, control: { form: { form: null, why: '主控覆核:取前 K', at: '2026-01-02T03:04:05.000Z' } } })
        let ls = md.split('\n')
        let iF = ls.indexOf('- 形式(agent 自填): 〔線索〕')
        assert(iF > 0 && iF < ls.findIndex((l) => l.startsWith('- 摘要: ')), '結論段之首(摘要之前)')
        assert(ls.indexOf('- 形式(審計所定): 〔機制〕') > ls.indexOf('## 6. 審計(做夢)'))
        assert(ls.includes('- 形式(主控補記;2026-01-02;以此為準): 未歸類 —— 主控覆核:取前 K'))
        assert(renderNodeMd({ ...nd, control: { form: { form: 'mechanism', why: 'w', at: '2026-01-03T00:00:00.000Z' } } }).includes('- 形式(主控補記;2026-01-03;以此為準): 〔機制〕 —— w'))
        //做夢文件
        let dd = { round: 2, audits: [{ nodeId: 'n1aaaaaaaaaaaaaa', trust: 'trusted', action: 'accept', evidence: ['e'], issues: [] }], harness: null, scope: { nodes: ['n1aaaaaaaaaaaaaa'], reworked: [] }, synthesis: { summary: 's' } }
        let dPlain = renderDreamMd(dd)
        assert(!dPlain.includes('形式'))
        assert.equal(renderDreamMd({ ...dd, audits: [{ ...dd.audits[0], form: null }] }), dPlain)
        let dMd = renderDreamMd({ ...dd, audits: [{ ...dd.audits[0], form: 'clue' }] })
        assert(dMd.split('\n').includes('- 形式: 〔線索〕'), dMd)
    })
})

describe('成品之形式之落地(規則 R-REC-53;真 w-recursi + 真領域 + 假做夢)', function () {
    this.timeout(180000)
    let t
    before(() => {
        t = makeTmp('formRecord')
    })
    after(() => {
        t.cleanup()
    })
    //mk, 暫存夾之專案; dreamOf(tpl) 回假做夢之 audits; 與本案有關之設定明設
    let mk = (dreamOf) => {
        let st = getSettings()
        let d = path.join(t.dir, `proj_${Math.random().toString(36).slice(2, 8)}`)
        st.resources = {}
        st.rsi = { ...st.rsi, root: path.join(d, 'rsi'), docLimits: false, autoFill: false, maxArmsPerNode: 4, formGate: false, backfill: true, exposure: true, rankBy: 'key' }
        st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(d, 'ledger')
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthForm' }), 'utf8')
        let seen = {}
        let dispatch = async (role, { prompt }) => {
            let m = /請閱讀 (\S+)\/brief\.md/.exec(prompt)
            let wd = path.resolve(st.FD_ROOT, m[1])
            let tpl = JSON.parse(fs.readFileSync(path.join(wd, 'dream.template.json'), 'utf8'))
            seen.tpl = tpl
            seen.brief = fs.readFileSync(path.join(wd, 'brief.md'), 'utf8')
            let dream = { audits: dreamOf(tpl), synthesis: { summary: '假做夢', worked: [], failed: [], patterns: [], prevDirections: [] }, guidance: { directions: [], avoid: [], openQuestions: [], improvements: [], armProposals: [] }, expansion: [], docsUpdated: [] }
            fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify(dream), 'utf8')
            return { ok: true, agent: { kind: 'fake', model: 'fake-dream', effort: 'none' } }
        }
        let P = makeProject(st, { dispatch, gate: null, catalogFile: path.join(d, 'catalog.json') })
        P.rsi.init()
        return { P, st, seen }
    }
    //put, 已執行之節點與其節點文件(自標 self: 'mechanism' / 'clue' / undefined)
    let put = (P, { arms, round, S, sel, k, self, ev = {} }) => {
        let spec = { arms, base: null }
        let id = P.idOf(spec)
        let metrics = { op: { eqYr: { mean: 10 + k, min: -3 - k, byPhase: [1, 2, 3, 4, 5, 6, 7].map((v) => v + k) }, monthlyOrders: { mean: 70 + k }, peakHold: { max: 18 + k }, bySide: { long: { orders: 300 + k }, short: { orders: 100 + k } } }, null: { mean: -2 - k, excess: 5 + k, z: 1 + k / 10, p: 0.002 * k }, nullSideAct: { excess: 4 + k, p: 0.01 + k / 1000, share: 0.2 + k / 100, mean: 2 + k, half: 50, triggered: true }, sel: { longRatio: 0.5 + k / 100, sizeMax: 5, sizeMean: 3, sigPerPick: 1.1 } }
        P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round, raw: { selHash: sel, metrics, issues: [], train: { longRatio: 0.5, tags: [], shortShare: 0.25 } }, score: { S, ladder: 1, flags: { vetoed: false, why: [] } }, evidence: { trust: null, ...ev } })
        P.records.putNodeDoc({ nodeId: id, round, attempt: 1, status: 'verified', createdAt: '2026-01-01T00:00:00.000Z', spec, task: { goal: 'g', type: 'explore', claim: null, arms: [], base: null, refs: [], direction: null }, agent: { role: 'node', kind: 'fake', model: 'fake-node', startedAt: 'a', endedAt: 'b', durationSec: 10 + k, ok: true, error: null }, plan: { target: 't', approach: 'a', hypotheses: [] }, code: { artifact: 'pick.mjs', files: [], reused: [] }, results: { claimed: { S }, experiments: [] }, conclusion: { outcome: 'neutral', summary: `摘要${k}`, findings: [], limitations: [], nextIdeas: [], ...(self === undefined ? {} : { form: self }) }, harness: { ok: true, summary: [], notes: [], score: { S, ladder: 1, flags: { vetoed: false, why: [] } }, fingerprint: sel, checks: { issues: [], nEvals: 2 }, validation: null, raw: {}, evalJson: null, error: null }, audit: null, history: [] })
        return id
    }

    it('採納:做夢有給者寫入樹之 evidence.form 與節點文件之 audit.form;未給(或 null)者不寫(不以節點自標代替、既有之值不動);四種組合(自標有 / 無 × 做夢給 / 不給)與既有值之保留;範本之預填 = 自標', async () => {
        let plan = {}
        let { P, seen } = mk((tpl) => tpl.audits.map((x) => ({ nodeId: x.nodeId, trust: 'trusted', action: 'accept', evidence: ['假審計'], issues: [], ...plan[x.nodeId] })))
        let ids = {
            a: put(P, { arms: ['A01_nt'], round: 2, S: 31.1, sel: 'sA', k: 1, self: 'clue' }),
            b: put(P, { arms: ['A02_ntPit'], round: 2, S: 28.4, sel: 'sB', k: 2, self: 'clue' }),
            c: put(P, { arms: ['A04_act'], round: 2, S: 25.7, sel: 'sC', k: 3 }),
            d: put(P, { arms: ['A05_nKeys'], round: 2, S: 22.9, sel: 'sD', k: 4 }),
            e: put(P, { arms: ['A06_scarce'], round: 2, S: 19.3, sel: 'sE', k: 5, self: 'mechanism', ev: { form: 'mechanism' } }),
        }
        plan[ids.a] = { form: 'mechanism' } //自標 clue、做夢判 mechanism(以做夢為準)
        plan[ids.b] = {} //自標 clue、做夢未給 ⇒ 不寫
        plan[ids.c] = { form: 'clue' } //無自標、做夢給
        plan[ids.d] = { form: null } //無自標、做夢 null ⇒ 不寫
        plan[ids.e] = {} //樹上已有 mechanism、做夢未給 ⇒ 不動
        let nodes = Object.values(ids).map((id) => P.rsi.store.getNode(id))
        await P.domain.hooks.afterRound({ round: 2, nodes })
        let tplForm = Object.fromEntries(seen.tpl.audits.map((x) => [x.nodeId, x.form]))
        assert.deepEqual([tplForm[ids.a], tplForm[ids.b], tplForm[ids.c], tplForm[ids.d], tplForm[ids.e]], ['clue', 'clue', null, null, 'mechanism'], '範本預填自標')
        let ev = (id) => P.rsi.store.getNode(id).evidence
        assert.equal(ev(ids.a).form, 'mechanism')
        assert.equal('form' in ev(ids.b), false, '做夢未給 ⇒ 樹不寫(不以自標代替)')
        assert.equal(ev(ids.c).form, 'clue')
        assert.equal('form' in ev(ids.d), false, '做夢給 null ⇒ 不寫')
        assert.equal(ev(ids.e).form, 'mechanism', '既有之值不動')
        let au = (id) => P.records.getNodeDoc(id).audit
        assert.equal(au(ids.a).form, 'mechanism')
        assert.equal('form' in au(ids.b), false)
        assert.equal(au(ids.c).form, 'clue')
        assert.equal('form' in au(ids.d), false)
        assert.deepEqual([ids.a, ids.b, ids.c, ids.d, ids.e].map((id) => DOM.formOf(P.rsi.store.getNode(id))), ['mechanism', null, 'clue', null, 'mechanism'])
        //渲染: 審計所定者列於審計段
        assert(fs.readFileSync(P.records.paths.nodeMd(ids.a), 'utf8').includes('- 形式(審計所定): 〔機制〕'))
        //做夢任務書之審計規程第 1 點要求判定形式
        assert(seen.brief.includes('**判定成品之形式**'))
    })

    it('重做、刪除不寫形式;重做之新成品去掉舊之形式(形式須經審計;與可信度同時失效),無此鍵者 evidence 之鍵與改前相同', async () => {
        let plan = {}
        let { P } = mk((tpl) => tpl.audits.map((x) => ({ nodeId: x.nodeId, evidence: ['假審計'], issues: [], ...plan[x.nodeId] })))
        let r1 = put(P, { arms: ['A07_modePure'], round: 2, S: 17.7, sel: 'sR1', k: 6, self: 'mechanism', ev: { form: 'clue' } })
        let r2 = put(P, { arms: ['A08_win'], round: 2, S: 16.2, sel: 'sR2', k: 7, self: 'clue' })
        let del = put(P, { arms: ['A09_tpSl'], round: 2, S: 14.9, sel: 'sDel', k: 8, self: 'clue' })
        plan[r1] = { trust: 'partial', action: 'rework', reworkBrief: '補對照', form: 'mechanism' }
        plan[r2] = { trust: 'partial', action: 'rework', reworkBrief: '補對照', form: 'mechanism' }
        plan[del] = { trust: 'untrusted', action: 'delete', deleteWhy: '刪', form: 'clue' }
        //重做之派工以替身取代(不派 agent): 回一份新之評估結果
        let raws = {}
        P.arsi.runNode = async ({ nodeId }) => {
            raws[nodeId] = { selHash: `new-${nodeId.slice(0, 4)}`, metrics: P.rsi.store.getNode(nodeId).raw.metrics, issues: [] }
            return { raw: raws[nodeId] }
        }
        let keys0 = Object.keys(P.rsi.store.getNode(r2).evidence)
        await P.domain.hooks.afterRound({ round: 2, nodes: [r1, r2, del].map((id) => P.rsi.store.getNode(id)) })
        let n1 = P.rsi.store.getNode(r1)
        let n2 = P.rsi.store.getNode(r2)
        assert.equal(n1.raw.selHash, `new-${r1.slice(0, 4)}`, '前提:已重做')
        assert.equal('form' in n1.evidence, false, '重做 ⇒ 舊之形式去掉、做夢所給者不寫')
        assert.equal(n1.evidence.trust, null)
        assert.equal('form' in n2.evidence, false)
        //無形式之節點: 重做後 evidence 之鍵 = 改前之鍵 + 重做之鍵(trust、reworkOf、reworkedAt 等)
        assert(keys0.every((k) => k in n2.evidence) && !('form' in n2.evidence))
        assert.equal(P.records.getNodeDoc(r1) && 'form' in (P.records.getNodeDoc(r1).audit || {}), false, '重做之審計不帶 form')
        assert.notEqual(P.rsi.store.getNode(del).status, 'executed', '刪除照既有流程')
    })
})

describe('補記工具 tools/formSet.mjs(規則 R-REC-53)', function () {
    this.timeout(300000)
    let t
    let root
    let ids = {}
    let sc = {}
    let run = (args, env = {}) => {
        let e = { ...process.env, ARSI_ROOT: root, ...env }
        if (!('ARSI_AGENT_ROLE' in env)) {
            delete e.ARSI_AGENT_ROLE
        }
        let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'tools', 'formSet.mjs'), ...args], { cwd: t.dir, env: e, windowsHide: true, encoding: 'utf8', timeout: 150000 })
        return { status: r.status, stdout: r.stdout, stderr: r.stderr }
    }
    let projOf = () => {
        let st = getSettings()
        st.rsi = { ...st.rsi, root: path.join(root, 'rsi'), formGate: true, backfill: true, exposure: true, rankBy: 'key' }
        st.records = { nodeDir: path.join(root, 'rsi/records/nodes'), dreamDir: path.join(root, 'rsi/records/dreams'), trashDir: path.join(root, 'rsi/records/trash'), workDir: path.join(root, 'rsi/work'), toolboxDir: path.join(root, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(root, 'ledger')
        st.resources = {}
        let P = makeProject(st, { dispatch: async () => ({ ok: false }), gate: null, catalogFile: path.join(root, 'catalog_t.json') })
        P.rsi.init()
        return P
    }
    before(() => {
        t = makeTmp('formSetTool')
        root = path.join(t.dir, 'proj')
        fs.mkdirSync(path.join(root, 'skills', 'node_modules', 'w-dispatch-ai'), { recursive: true })
        fs.writeFileSync(path.join(root, 'skills', 'node_modules', 'w-dispatch-ai', 'package.json'), JSON.stringify({ name: 'w-dispatch-ai', main: 'index.cjs' }))
        fs.writeFileSync(path.join(root, 'skills', 'node_modules', 'w-dispatch-ai', 'index.cjs'), 'module.exports = { providers: [{ id: \'oc:opencode/m-free\', kind: \'opencode\', provider: \'opencode\', model: \'opencode/m-free\' }], readEnvFile: () => ({}), opencodeGoUsage: async () => ({ ok: true, usage: {} }), dispatchOpencode: async () => ({ ok: false, error: \'stub\' }), dispatchClaude: async () => ({ ok: false, error: \'stub\' }), getQuotaClaude: async () => ({ ok: true, windows: [] }) }\n')
        fs.mkdirSync(path.join(root, 'arms'), { recursive: true })
        fs.copyFileSync(path.join(FD_ROOT, 'arms', 'base.json'), path.join(root, 'arms', 'base.json'))
        writeSynthLedger(path.join(root, 'ledger'), { n: 40, nBars: 2400, seed: 13 })
        let st = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
        st.periods = { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } }
        st.eval = { ...st.eval, ledgerDir: './ledger', warmupDays: 60, phases: [0, 3], horizons: [7], nullDraws: 4 }
        delete st.eval.fitEnd
        st.dispatch = { skillsRoot: path.join(root, 'skills'), envFile: path.join(root, '.env') }
        //與本案有關之設定明設(只計〔機制〕開啟: 看板有「形式」欄)
        st.rsi = { ...st.rsi, root: './rsi', formGate: true, backfill: true, exposure: true, rankBy: 'key' }
        st.agents = { node: { kind: 'opencode', id: 'oc:opencode/m-free', variant: 'high', timeoutMin: 1 }, dream: { kind: 'claude', model: 'claude-opus-5-5', effort: 'xhigh', timeoutMin: 1 } }
        st.records = { nodeDir: './rsi/records/nodes', dreamDir: './rsi/records/dreams', trashDir: './rsi/records/trash', workDir: './rsi/work', toolboxDir: './rsi/toolbox' }
        st.resources = {}
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(st, null, 1))
        fs.writeFileSync(path.join(root, '.env'), 'X=1\n')
        let P = projOf()
        let putN = (arms, sel, k, self) => {
            let spec = { arms, base: null }
            let id = P.idOf(spec)
            let metrics = { op: { eqYr: { mean: 12 + k, min: -2 - k, byPhase: [1, 2, 3, 4, 5, 6, 7].map((v) => v * k) }, monthlyOrders: { mean: 60 + k }, peakHold: { max: 15 + k }, bySide: { long: { orders: 400 + k }, short: { orders: 150 + k } } }, null: { mean: -3 - k, excess: 7 + k, z: 2, p: 0.003 * k }, nullSideAct: { excess: 5 + k, p: 0.02, share: 0.3, mean: 3, half: 50, triggered: true }, sel: { longRatio: 0.5 + k / 50, sizeMax: 5, sizeMean: 3, sigPerPick: 1.2 } }
            let raw = { selHash: sel, metrics, issues: [], train: { longRatio: 0.5, tags: [], shortShare: 0.25 } }
            let score = P.domain.score(raw, { spec, evidence: { trust: 'trusted' } })
            P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round: 1, raw, score, evidence: { trust: 'trusted' } })
            sc[sel] = score
            P.records.putNodeDoc({ nodeId: id, round: 1, attempt: 1, status: 'verified', createdAt: '2026-01-01T00:00:00.000Z', spec, task: { goal: '合成', type: 'explore', claim: null, arms: [], base: null, refs: [], direction: null }, agent: { role: 'node', kind: 'fake', model: 'fake-node', startedAt: 'a', endedAt: 'b', durationSec: 600 + k, ok: true, error: null }, plan: { target: 't', approach: 'a', hypotheses: [] }, code: { artifact: 'pick.mjs', files: [], reused: [] }, results: { claimed: { S: score.S }, experiments: [] }, conclusion: { outcome: 'neutral', summary: 's', findings: [], limitations: [], nextIdeas: [], ...(self ? { form: self } : {}) }, harness: { ok: true, summary: [], notes: [], score, fingerprint: sel, checks: { issues: [], nEvals: 2 }, validation: null, raw: {}, evalJson: null, error: null }, audit: null, history: [] })
            return id
        }
        ids.a = putN(['A01_nt'], 'selF-a', 1, 'clue')
        ids.b = putN(['A04_act'], 'selF-b', 2, null)
    })
    after(() => {
        t.cleanup()
    })

    it('列出(無引數):全樹之形式與來源(未歸類者列節點之自標);離開碼 0;不寫任何檔', () => {
        let fpBoard = path.join(root, 'rsi', 'ARMS_BOARD.md')
        let r = run([])
        assert.equal(r.status, 0, r.stdout + r.stderr)
        let ls = r.stdout.split('\n')
        assert.equal(ls[0], '樹上已執行之節點 2 個:〔機制〕0、〔線索〕0、未歸類 2(設定 rsi.formGate 開啟:補位之底、方向之起點、量尺與參考節點只計〔機制〕)')
        assert(ls.includes(`- ${ids.a}(A01_nt;S ${sc['selF-a'].S};trusted):未歸類(節點自標 〔線索〕,未經審計)`), r.stdout)
        assert(ls.includes(`- ${ids.b}(A04_act;S ${sc['selF-b'].S};trusted):未歸類(無自標)`), r.stdout)
        assert(!fs.existsSync(fpBoard), '列出不重產看板')
    })

    it('不合者:--form 之值不在值域 ⇒ 離開碼 2 與固定訊息(不寫);缺 --why、缺 --form、前綴不符 ⇒ 離開碼 2;輪次進行中 ⇒ 離開碼 3;agent 帶引數 ⇒ 拒跑', () => {
        let before = JSON.stringify(projOf().rsi.store.getNode(ids.a).evidence)
        let bad = run(['--node', ids.a.slice(0, 10), '--form', 'Mechanism', '--why', 'w'])
        assert.equal(bad.status, 2)
        assert.equal(bad.stdout, 'invalid --form: must be one of mechanism, clue, none\n')
        assert.equal(run(['--node', ids.a.slice(0, 10), '--form', 'clue']).status, 2)
        assert.equal(run(['--node', ids.a.slice(0, 10), '--why', 'w']).status, 2)
        let nf = run(['--node', 'zzzzzz', '--form', 'clue', '--why', 'w'])
        assert.equal(nf.status, 2)
        assert.equal(nf.stderr, '節點前綴符合 0 個(須恰為 1 個)\n')
        let fpLock = path.join(root, 'rsi', 'logs', 'round.lock')
        fs.mkdirSync(path.dirname(fpLock), { recursive: true })
        fs.writeFileSync(fpLock, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), beatAt: new Date().toISOString() }))
        let rl = run(['--node', ids.a.slice(0, 10), '--form', 'clue', '--why', 'w'])
        fs.rmSync(fpLock, { force: true })
        assert.equal(rl.status, 3, rl.stdout + rl.stderr)
        let ag = run(['--node', ids.a.slice(0, 10), '--form', 'clue', '--why', 'w'], { ARSI_AGENT_ROLE: 'node' })
        assert.equal(ag.status, 2)
        assert(ag.stdout.startsWith('拒跑: tools/formSet.mjs 之補記 會寫入專案之檔或起行程'), ag.stdout)
        assert.equal(JSON.stringify(projOf().rsi.store.getNode(ids.a).evidence), before, '皆未寫')
    })

    it('補記與清除:evidence.form 寫入 / 清為 null、S 與階梯不變、節點文件之 control.form 同步並渲染、看板(「形式」欄)與搜尋地圖重產、列出之來源為主控補記', () => {
        let r = run(['--node', ids.a.slice(0, 10), '--form', 'mechanism', '--why', '主控覆核:逐策略之門檻'])
        assert.equal(r.status, 0, r.stdout + r.stderr)
        assert(r.stdout.startsWith(`已記 ${ids.a.slice(0, 8)} 之形式: 未歸類 → 〔機制〕(S ${sc['selF-a'].S}、階梯 ${sc['selF-a'].ladder} 不變);節點文件已同步;看板與搜尋地圖已重產`), r.stdout)
        let P = projOf()
        let n = P.rsi.store.getNode(ids.a)
        assert.equal(n.evidence.form, 'mechanism')
        assert.equal(P.formOf(n), 'mechanism')
        assert.deepEqual([n.score.S, n.score.ladder], [sc['selF-a'].S, sc['selF-a'].ladder])
        let c = P.records.getNodeDoc(ids.a).control.form
        assert.deepEqual([c.form, c.why], ['mechanism', '主控覆核:逐策略之門檻'])
        assert(fs.readFileSync(path.join(root, 'rsi', 'records', 'nodes', `${ids.a}.md`), 'utf8').includes('- 形式(主控補記;'))
        let board = fs.readFileSync(path.join(root, 'rsi', 'ARMS_BOARD.md'), 'utf8')
        let row = board.split('\n').find((l) => l.startsWith(`| \`${ids.a}\``))
        assert(row && row.includes('| trusted | 〔機制〕 | r001 |'), row)
        assert(fs.existsSync(path.join(root, 'rsi', 'SEARCH_MAP.md')))
        assert(run([]).stdout.split('\n').includes(`- ${ids.a}(A01_nt;S ${sc['selF-a'].S};trusted):〔機制〕(主控補記)`))
        //clue(去頭尾空白之值亦收)
        assert.equal(run(['--node', ids.b.slice(0, 10), '--form', ' clue ', '--why', 'w2']).status, 0)
        assert.equal(projOf().rsi.store.getNode(ids.b).evidence.form, 'clue')
        //清除
        let u = run(['--node', ids.a.slice(0, 10), '--form', 'none', '--why', '清除'])
        assert.equal(u.status, 0, u.stdout + u.stderr)
        assert(u.stdout.startsWith(`已記 ${ids.a.slice(0, 8)} 之形式: 〔機制〕 → 未歸類`), u.stdout)
        let P2 = projOf()
        assert.strictEqual(P2.rsi.store.getNode(ids.a).evidence.form, null)
        assert.equal(P2.formOf(P2.rsi.store.getNode(ids.a)), null)
        assert(fs.readFileSync(path.join(root, 'rsi', 'records', 'nodes', `${ids.a}.md`), 'utf8').includes('以此為準): 未歸類 —— 清除'))
    })
})
