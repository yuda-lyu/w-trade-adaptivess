import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { getSettings, inputMsgOf } from '../src/cfg.mjs'
import { makeProject, unproposedNoteOf } from '../src/domain/domain.mjs'
import { specHash } from '../src/engineApi.mjs'
import { makeTmp } from './tools/synthLedger.mjs'


//只計〔機制〕(規則 R-REC-54; 選配: settings.rsi.formGate === true 才生效)
//  規格: ①給了而不是布林 ⇒ 組裝時拋 invalid rsi.formGate: must be boolean(inputMsgOf 認得);未給 / null / false = 關閉
//        ②補位之底只取〔機制〕(排序鍵較高之〔線索〕與未歸類者不取);無〔機制〕之底時 D / E / G 之未試臂不出載體,其餘層照出
//        ③方向之起點與前置閘門:起點之形式不是〔機制〕者拒(次序在不存在、別名改掛、否決、側別曝險之後;訊息寫明形式與出路);輪末摘要之「方向未入前緣」列出
//        ④量尺(看板之表前一段、輪末摘要之一列、搜尋地圖 §1 之量尺欄與子集)只計〔機制〕,〔線索〕與未歸類者另列其最高(供趨勢參考);全樹無〔機制〕者不拋錯
//        ⑤其餘之「最高」與純列表:次序不變、加註形式(看板之「形式」欄、各臂之最佳 S;搜尋地圖之本輪最高、有內容之最高、各層、譜系、§4)
//        ⑥節點任務書之參考節點只取〔機制〕;做夢任務書之量尺句改述
//        ⑦關閉時(false 與未給)看板、搜尋地圖、載體、乾跑之計畫、閘門逐位相同(與基準之逐位相同另以跨版本之比對證成)
//  合成資料: 各節點之臂、輪次、S、選集指紋、組成對照、形式逐筆相異; 與本案有關之設定(formGate、backfill、exposure、rankBy)於夾具明設
describe('只計〔機制〕(規則 R-REC-54)', function () {
    this.timeout(180000)
    let t
    beforeEach(() => {
        t = makeTmp('formGate')
    })
    afterEach(() => {
        t.cleanup()
    })
    let mk = ({ formGate, dreamDirs = null, rsiExtra = {} } = {}) => {
        let st = getSettings()
        let d = path.join(t.dir, `proj_${Math.random().toString(36).slice(2, 8)}`)
        st.resources = {}
        st.rsi = { ...st.rsi, root: path.join(d, 'rsi'), docLimits: false, autoFill: false, maxArmsPerNode: 4, backfill: true, exposure: false, rankBy: 'key', ...(formGate === 'unset' ? {} : { formGate }), ...rsiExtra }
        if (formGate === 'unset') {
            delete st.rsi.formGate
        }
        st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(d, 'ledger')
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthGate' }), 'utf8')
        let seen = {}
        let dispatch = async (role, { prompt }) => {
            let m = /請閱讀 (\S+)\/brief\.md/.exec(prompt)
            let wd = path.resolve(st.FD_ROOT, m[1])
            let tpl = JSON.parse(fs.readFileSync(path.join(wd, 'dream.template.json'), 'utf8'))
            seen.brief = fs.readFileSync(path.join(wd, 'brief.md'), 'utf8')
            let dream = { audits: tpl.audits.map((x) => ({ nodeId: x.nodeId, trust: 'trusted', action: 'accept', evidence: ['假審計'], issues: [] })), synthesis: { summary: '假做夢', worked: [], failed: [], patterns: [], prevDirections: [] }, guidance: { directions: dreamDirs ? dreamDirs() : [], avoid: [], openQuestions: [], improvements: [], armProposals: [] }, expansion: [], docsUpdated: [] }
            fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify(dream), 'utf8')
            return { ok: true, agent: { kind: 'fake', model: 'fake-dream', effort: 'none' } }
        }
        let P = makeProject(st, { dispatch, gate: null, catalogFile: path.join(d, 'catalog.json') })
        P.rsi.init()
        return { P, st, seen }
    }
    //put, 已執行之節點; form = 樹上之 evidence.form(未給 = 未歸類); content = 組成對照之超額(> 0 且 p 小 ⇒ 有內容)
    let put = (P, { arms, base = null, round, S, sel, k, form, trust = 'trusted', vetoed = false, content = 6 }) => {
        let spec = { arms, base }
        let id = P.idOf(spec)
        let metrics = { op: { eqYr: { mean: 15 + k * 1.7, min: -3 - k * 0.4, byPhase: [1, 2, 3, 4, 5, 6, 7].map((v) => v + k) }, monthlyOrders: { mean: 70 + k }, peakHold: { max: 19 + k }, bySide: { long: { orders: 500 + k }, short: { orders: 180 + k } } }, null: { mean: -4 - k, excess: 8 + k, z: 2 + k / 10, p: 0.001 * k }, nullSideAct: { excess: content + k / 10, p: 0.004 + k / 1000, share: 0.25 + k / 100, mean: 2 + k, half: 50, triggered: true }, sel: { longRatio: 0.48 + k / 100, sizeMax: 5, sizeMean: 3 + k / 10, sigPerPick: 1.05 + k / 100 } }
        P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round, raw: { selHash: sel, metrics, issues: [], train: { longRatio: 0.49 + k / 100, tags: [], shortShare: 0.24 } }, score: { S, ladder: 1, flags: { vetoed, why: vetoed ? ['合成之否決'] : [] } }, evidence: { trust, ...(form === undefined ? {} : { form }) } })
        return id
    }
    let read = (st, f) => fs.readFileSync(path.join(st.rsi.root, f), 'utf8')
    let BASED = (cs) => Object.keys(cs).filter((a) => /^[DEG]\d/.test(a))
    let view = (P) => ({ nodes: P.rsi.view.policyView().filter((n) => !n.aliasOf) })
    let whyOf = (id, lab) => `起點 ${id.slice(0, 8)} 之形式為${lab},不是〔機制〕;只計〔機制〕(設定 rsi.formGate)者不以之為起點 —— 要沿用其線索者,改為無起點之方向並指派其臂`

    it('設定:未給 / null / false / true 照組裝;給了而不是布林 ⇒ 拋 invalid rsi.formGate: must be boolean(不帶輸入值;入口以 inputMsgOf 認得)', () => {
        for (let v of ['unset', null, false, true]) {
            let { P } = mk({ formGate: v })
            assert.equal(P.formGate, v === true, String(v))
        }
        for (let bad of ['true', 'false', 1, 0, '', 'yes', [], {}, [true]]) {
            let err = null
            try {
                mk({ formGate: bad })
            }
            catch (e) {
                err = e
            }
            assert(err && err.message === 'invalid rsi.formGate: must be boolean', `${JSON.stringify(bad)}: ${err && err.message}`)
            assert.equal(inputMsgOf(err), 'invalid rsi.formGate: must be boolean')
        }
    })

    it('補位之底:開啟 ⇒ 只取〔機制〕(排序鍵較高之〔線索〕與未歸類者不取);關閉 ⇒ 照排序鍵(與未給相同)', () => {
        for (let fg of [true, false, 'unset']) {
            let { P } = mk({ formGate: fg })
            let hi = put(P, { arms: ['A01_nt'], round: 1, S: 70.2, sel: 's-hi', k: 1, form: 'clue' })
            put(P, { arms: ['A02_ntPit'], round: 1, S: 55.6, sel: 's-un', k: 2 })
            let me = put(P, { arms: ['A04_act'], round: 1, S: 31.9, sel: 's-me', k: 3, form: 'mechanism' })
            let c = P.domain.carriers().D30_volumeCut
            assert.deepEqual(c, fg === true ? { arms: ['A04_act', 'D30_volumeCut'], base: me } : { arms: ['A01_nt', 'D30_volumeCut'], base: hi }, String(fg))
            assert.equal(P.domain.carriers().E37_dayCap.base, fg === true ? me : hi)
        }
    })

    it('無〔機制〕之底:開啟 ⇒ D / E / G 之未試臂不出載體、其餘層(A / B / C / F)照出單臂根節點;關閉 ⇒ D / E / G 以〔線索〕之成品為底照出', () => {
        let on = mk({ formGate: true }).P
        let off = mk({ formGate: false }).P
        for (let P of [on, off]) {
            put(P, { arms: ['A01_nt'], round: 1, S: 60.4, sel: 's1', k: 1, form: 'clue' })
            put(P, { arms: ['B14_pitKey'], round: 1, S: 48.1, sel: 's2', k: 2 })
        }
        let cOn = on.domain.carriers()
        let cOff = off.domain.carriers()
        assert.deepEqual(BASED(cOn), [], '開啟:D / E / G 皆不出')
        assert(BASED(cOff).length > 10, '關閉:D / E / G 照出')
        assert.deepEqual(cOn.A02_ntPit, { arms: ['A02_ntPit'], base: null })
        assert.deepEqual(cOn.C19_jaccard, { arms: ['C19_jaccard'], base: null })
        assert.deepEqual(cOn.F46_retSign, { arms: ['F46_retSign'], base: null })
        assert.deepEqual(Object.keys(cOn).sort(), Object.keys(cOff).filter((a) => !/^[DEG]\d/.test(a)).sort(), '其餘層與關閉時相同')
        //樹上無任何成品(冷啟動):開啟者 D / E / G 亦不出(無〔機制〕之底)
        let cold = mk({ formGate: true }).P
        assert.deepEqual(BASED(cold.domain.carriers()), [])
    })

    it('方向之提出與前置閘門:起點為〔線索〕/ 未歸類 ⇒ 拒(訊息寫明形式與出路;不入前緣;輪末摘要之「方向未入前緣」列出);〔機制〕照常;次序在否決、不存在之後;關閉者不拒', () => {
        let { P } = mk({ formGate: true })
        let cl = put(P, { arms: ['A01_nt'], round: 1, S: 52.3, sel: 's-cl', k: 1, form: 'clue' })
        let un = put(P, { arms: ['A02_ntPit'], round: 1, S: 41.8, sel: 's-un', k: 2 })
        let me = put(P, { arms: ['A04_act'], round: 1, S: 35.5, sel: 's-me', k: 3, form: 'mechanism' })
        let vt = put(P, { arms: ['A05_nKeys'], round: 1, S: 66.6, sel: 's-vt', k: 4, form: 'clue', vetoed: true })
        let v = view(P)
        assert.deepEqual(P.domain.gates.pre({ arms: ['A01_nt', 'B14_pitKey'], base: cl }, { view: v }), { ok: false, why: whyOf(cl, '〔線索〕') })
        assert.deepEqual(P.domain.gates.pre({ arms: ['A02_ntPit', 'B14_pitKey'], base: un }, { view: v }), { ok: false, why: whyOf(un, '未歸類') })
        assert.deepEqual(P.domain.gates.pre({ arms: ['A04_act', 'B14_pitKey'], base: me }, { view: v }), { ok: true })
        assert.deepEqual(P.domain.gates.pre({ arms: ['B14_pitKey'], base: null }, { view: v }), { ok: true }, '無起點不受影響')
        assert.equal(P.domain.gates.pre({ arms: ['A05_nKeys', 'B14_pitKey'], base: vt }, { view: v }).why, `起點 ${vt.slice(0, 8)} 已被否決`, '否決先判')
        let nf = P.rsi.store.listFrontier().length
        let r = P.proposeDirection({ arms: ['A01_nt', 'B14_pitKey'], base: cl, type: 'explore', rationale: '延伸線索' }, 2)
        assert.deepEqual([r.ok, r.note], [false, whyOf(cl, '〔線索〕')])
        assert.equal(P.proposeDirection({ arms: ['A02_ntPit', 'B14_pitKey'], base: un, type: 'explore', rationale: '延伸未歸類' }, 2).note, whyOf(un, '未歸類'))
        assert.equal(P.rsi.store.listFrontier().length, nf, '不入前緣(不留存根)')
        assert(P.proposeDirection({ arms: ['A04_act', 'B14_pitKey'], base: me, type: 'explore', rationale: '延伸機制' }, 2).ok)
        assert.equal(P.proposeDirection({ arms: ['A05_nKeys', 'B14_pitKey'], base: vt, type: 'explore', rationale: '否決者' }, 2).note.startsWith(`起點 ${vt.slice(0, 8)} 已被否決`), true)
        assert.equal(P.proposeDirection({ arms: ['A06_scarce'], base: 'ffffffffffffffff', type: 'explore', rationale: '不存在' }, 2).note, '起點 ffffffff 不存在或未執行')
        assert.deepEqual(unproposedNoteOf([{ ...r, arms: ['A01_nt', 'B14_pitKey'], base: cl }]).slice(1), [`方向未入前緣:方向 1(A01_nt + B14_pitKey;起點 ${cl.slice(0, 8)}):${whyOf(cl, '〔線索〕')}`])
        //別名之正本為〔線索〕⇒ 改掛後亦拒(訊息之末另註改掛)
        let al = put(P, { arms: ['A07_modePure'], round: 2, S: 52.3, sel: 's-cl', k: 5 })
        let [aliasId, canonId] = [...P.rsi.aliasMap()][0]
        assert.deepEqual([aliasId, canonId].sort(), [al, cl].sort())
        let ra = P.proposeDirection({ arms: ['A07_modePure', 'C22_calendar'], base: aliasId, type: 'explore', rationale: '別名' }, 2)
        assert.equal(ra.ok, false)
        assert(ra.note.includes('不是〔機制〕'), ra.note)
        //關閉者: 同一棵樹之〔線索〕起點照常
        let off = mk({ formGate: false }).P
        let cl2 = put(off, { arms: ['A01_nt'], round: 1, S: 52.3, sel: 's-cl', k: 1, form: 'clue' })
        assert.deepEqual(off.domain.gates.pre({ arms: ['A01_nt', 'B14_pitKey'], base: cl2 }, { view: view(off) }), { ok: true })
        assert(off.proposeDirection({ arms: ['A01_nt', 'B14_pitKey'], base: cl2, type: 'explore', rationale: '延伸線索' }, 2).ok)
    })

    it('前置閘門攔下已在前緣之殘留者:關閉時入前緣之方向,開啟後之乾跑之計畫拒之(rejected 之 why)', async () => {
        let d0 = null
        let off = mk({ formGate: false })
        let cl = put(off.P, { arms: ['A01_nt'], round: 1, S: 52.3, sel: 's-cl', k: 1, form: 'clue' })
        assert(off.P.proposeDirection({ arms: ['A01_nt', 'B14_pitKey'], base: cl, type: 'explore', rationale: '殘留' }, 2).ok)
        d0 = off.st
        //同一個狀態根改以開啟之設定組裝
        let st = { ...d0, rsi: { ...d0.rsi, formGate: true } }
        let P = makeProject(st, { dispatch: async () => ({ ok: false }), gate: null, catalogFile: path.join(path.dirname(d0.rsi.root), 'catalog2.json') })
        P.rsi.init()
        let dry = await P.rsi.explore({ dry: true, arms: 3, novelty: 3 })
        let rj = dry.rejected.find((x) => x.spec.base === cl)
        assert(rj, JSON.stringify(dry.rejected))
        assert.equal(rj.why, whyOf(cl, '〔線索〕'))
        assert(!dry.items.some((x) => x.spec.base === cl))
    })

    it('量尺:看板之一段與輪末摘要之一列只計〔機制〕、〔線索〕與未歸類者另列;P.gaugeDualOf 只計〔機制〕;全樹無〔機制〕者「—(尚無〔機制〕之可信成品)」、不拋錯;關閉者依既有之出現條件', async () => {
        let { P, st } = mk({ formGate: true })
        let cl = put(P, { arms: ['A01_nt'], round: 1, S: 72.5, sel: 's-cl', k: 1, form: 'clue', content: 9 })
        let me = put(P, { arms: ['A04_act'], round: 1, S: 38.1, sel: 's-me', k: 2, form: 'mechanism', content: 3 })
        let n3 = put(P, { arms: ['B14_pitKey'], round: 2, S: 44.4, sel: 's-n3', k: 3, trust: null })
        let ns = [cl, me, n3].map((id) => P.rsi.store.getNode(id))
        assert.equal(P.gaugeDualOf(ns).key.id, me)
        assert.equal(P.gaugeClueOf(ns).key.id, cl)
        //鑑別:〔機制〕之排序鍵與挑選內容皆最高時,〔線索〕之最高仍只取〔線索〕與未歸類者
        let w = mk({ formGate: true })
        let wm = put(w.P, { arms: ['A01_nt'], round: 1, S: 90.3, sel: 'w1', k: 1, form: 'mechanism', content: 9 })
        let wc = put(w.P, { arms: ['A02_ntPit'], round: 1, S: 45.6, sel: 'w2', k: 2, form: 'clue', content: 2 })
        let wn = [wm, wc].map((id) => w.P.rsi.store.getNode(id))
        assert.deepEqual([w.P.gaugeClueOf(wn).key.id, w.P.gaugeClueOf(wn).content.id], [wc, wc])
        assert.deepEqual([w.P.gaugeDualOf(wn).key.id, w.P.gaugeDualOf(wn).content.id], [wm, wm])
        P.writeBoard()
        let bd = read(st, 'ARMS_BOARD.md')
        let para = bd.split('\n').find((l) => l.startsWith('**量尺(並列;只計〔機制〕)**:'))
        assert(para, bd.slice(0, 2000))
        assert(para.includes(`挑選內容最高且可信者 \`${me.slice(0, 8)}\``) && para.includes(`排序鍵最高且可信者 \`${me.slice(0, 8)}\``), para)
        assert(para.includes(`**〔線索〕之最高(供趨勢參考;〔線索〕與未歸類者)**:挑選內容最高且可信者 \`${cl.slice(0, 8)}\``), para)
        //輪末摘要之一列(n3 為本輪節點; 假做夢採納 ⇒ n3 可信但未歸類)
        let hk = await P.domain.hooks.afterRound({ round: 2, nodes: [P.rsi.store.getNode(n3)] })
        let line = hk.lines.find((l) => l.startsWith('量尺(並列'))
        assert(line && line.startsWith('量尺(並列;樹上可信者;只計〔機制〕):挑選內容最高且可信者 `' + me.slice(0, 8)), JSON.stringify(hk.lines))
        assert(line.includes(';〔線索〕之最高(供趨勢參考):挑選內容最高且可信者 `' + cl.slice(0, 8)), line)
        //無〔機制〕
        let z = mk({ formGate: true })
        put(z.P, { arms: ['A01_nt'], round: 1, S: 60.1, sel: 'z1', k: 1, form: 'clue' })
        z.P.writeBoard()
        let zp = read(z.st, 'ARMS_BOARD.md').split('\n').find((l) => l.startsWith('**量尺(並列;只計〔機制〕)**:'))
        assert(zp && zp.startsWith('**量尺(並列;只計〔機制〕)**:—(尚無〔機制〕之可信成品);'), zp)
        assert(read(z.st, 'SEARCH_MAP.md').includes('—(尚無〔機制〕之成品)'))
        //關閉: 挑選內容最高與排序鍵最高相同 ⇒ 不列(既有之出現條件)
        let o = mk({ formGate: false })
        put(o.P, { arms: ['A01_nt'], round: 1, S: 72.5, sel: 's-cl', k: 1, form: 'clue', content: 9 })
        o.P.writeBoard()
        assert(!read(o.st, 'ARMS_BOARD.md').includes('**量尺(並列'), '關閉 ⇒ 依既有之條件不列')
    })

    it('搜尋地圖:§1 之量尺欄只計〔機制〕、末欄「〔線索〕之最高」、說明加一句;量尺之子集只計〔機制〕;其餘之「最高」與譜系、§4 加註形式(次序不變)', () => {
        let { P, st } = mk({ formGate: true })
        let cl = put(P, { arms: ['A01_nt'], round: 1, S: 72.5, sel: 's-cl', k: 1, form: 'clue', content: 9 })
        let me = put(P, { arms: ['A04_act'], round: 1, S: 38.1, sel: 's-me', k: 2, form: 'mechanism', content: 3 })
        //子集: 兩者皆帶同一子集之自述
        for (let id of [cl, me]) {
            P.rsi.store.updateNode(id, (x) => {
                x.raw.metrics.ext = { subDiag: { subset: '時效 ≥ 15', text: 't' } }
            })
        }
        P.writeBoard()
        let sm = read(st, 'SEARCH_MAP.md')
        let ls = sm.split('\n')
        assert(ls.some((l) => l.includes('**量尺只計〔機制〕**(設定 `rsi.formGate`')), '§1 之說明')
        let head = ls.find((l) => l.startsWith('| 輪 | 節點(探索 / 驗證)'))
        assert(head.endsWith(' 〔線索〕之最高(供趨勢參考;「有內容且可信」之〔線索〕與未歸類者) |'), head)
        let r1 = ls.find((l) => l.startsWith('| r001 |'))
        let cells = r1.split(' | ')
        assert(cells[4].startsWith(`\`${me.slice(0, 8)}\`:`), `量尺之格:${cells[4]}`)
        assert(cells[cells.length - 1].startsWith(`\`${cl.slice(0, 8)}\`:`), `〔線索〕之格:${cells[cells.length - 1]}`)
        assert.equal(r1.split(' | ').length, head.split(' | ').length, '欄數一致')
        //本輪最高 S(次序不變;加註形式)
        assert(cells[3].includes(`\`${cl.slice(0, 8)}\` 〔線索〕`), cells[3])
        //子集只計〔機制〕
        let sub = ls.find((l) => l.startsWith('- 「時效 ≥ 15」'))
        assert(sub && sub.includes(`\`${me.slice(0, 8)}\``) && !sub.includes(`\`${cl.slice(0, 8)}\``), sub)
        assert(ls.some((l) => l.includes('「有內容且可信」且為〔機制〕之 1 個節點中')), '子集之說明')
        //譜系與 §4
        assert(ls.some((l) => l.startsWith(`- \`${cl.slice(0, 8)}\``) && l.includes(';trusted;〔線索〕')))
        assert(ls.some((l) => l.startsWith(`- \`${me.slice(0, 8)}\``) && l.includes(';trusted;〔機制〕')))
        assert(ls.some((l) => l.startsWith('- 有內容之節點 2 個(其中〔機制〕 1 個)')))
    })

    it('看板:節點一覽加「形式」欄(次序不變);各可選臂之「回測期最佳 S」註形式;關閉者無此欄與註記', () => {
        for (let fg of [true, false]) {
            let { P, st } = mk({ formGate: fg })
            let cl = put(P, { arms: ['A01_nt'], round: 1, S: 72.5, sel: 's-cl', k: 1, form: 'clue' })
            let me = put(P, { arms: ['A04_act'], round: 1, S: 38.1, sel: 's-me', k: 2, form: 'mechanism' })
            P.writeBoard()
            let bd = read(st, 'ARMS_BOARD.md').split('\n')
            let head = bd.find((l) => l.startsWith('| 節點 | 臂 |'))
            assert.equal(head.includes('| 可信度 | 形式 | 輪 |'), fg, head)
            let rows = bd.filter((l) => l.startsWith('| `'))
            assert.deepEqual(rows.map((l) => l.slice(3, 11)), [cl.slice(0, 8), me.slice(0, 8)], '次序不變(依 S)')
            assert.equal(rows[0].includes('| trusted | 〔線索〕 | r001 |'), fg)
            assert.equal(rows[1].includes('| trusted | 〔機制〕 | r001 |'), fg)
            let a01 = bd.find((l) => l.startsWith('| A01_nt |'))
            assert.equal(a01.includes('| 72.5 〔線索〕 |'), fg, a01)
            assert.equal(a01.includes('| 72.5 |'), !fg, a01)
        }
    })

    it('節點任務書之參考節點:開啟 ⇒ 只取〔機制〕(文字註明);無〔機制〕者不列參考節點;關閉 ⇒ 依既有之次序', () => {
        let { P } = mk({ formGate: true })
        put(P, { arms: ['A01_nt'], round: 1, S: 72.5, sel: 's-cl', k: 1, form: 'clue' })
        let me = put(P, { arms: ['A04_act'], round: 1, S: 38.1, sel: 's-me', k: 2, form: 'mechanism' })
        put(P, { arms: ['B14_pitKey'], round: 1, S: 50.5, sel: 's-un', k: 3 })
        let refs = P.taskFor({ arms: ['C19_jaccard'], base: null }).refs.filter((r) => r.kind === 'node')
        assert.deepEqual(refs.map((r) => r.nodeId), [me])
        assert(refs[0].why.startsWith('目前回測期 S 較高之〔機制〕節點('), refs[0].why)
        let z = mk({ formGate: true })
        put(z.P, { arms: ['A01_nt'], round: 1, S: 72.5, sel: 's-cl', k: 1, form: 'clue' })
        assert.deepEqual(z.P.taskFor({ arms: ['C19_jaccard'], base: null }).refs.filter((r) => r.kind === 'node'), [], '無〔機制〕 ⇒ 不列')
        let o = mk({ formGate: false })
        let ocl = put(o.P, { arms: ['A01_nt'], round: 1, S: 72.5, sel: 's-cl', k: 1, form: 'clue' })
        let ome = put(o.P, { arms: ['A04_act'], round: 1, S: 38.1, sel: 's-me', k: 2, form: 'mechanism' })
        let oun = put(o.P, { arms: ['B14_pitKey'], round: 1, S: 50.5, sel: 's-un', k: 3 })
        let orefs = o.P.taskFor({ arms: ['C19_jaccard'], base: null }).refs.filter((r) => r.kind === 'node')
        assert.deepEqual(orefs.map((r) => r.nodeId), [ocl, oun, ome])
        assert(orefs[0].why.startsWith('目前回測期 S 較高之節點('))
    })

    it('做夢任務書:開啟 ⇒ 量尺句、progress、補位一句、更新 state 之句改述為只計〔機制〕(〔線索〕另述為趨勢);關閉 ⇒ 原句', async () => {
        for (let fg of [true, false]) {
            let { P, seen } = mk({ formGate: fg })
            let n = put(P, { arms: ['A01_nt'], round: 1, S: 40.2, sel: 's1', k: 1 })
            await P.domain.hooks.afterRound({ round: 1, nodes: [P.rsi.store.getNode(n)] })
            let d = seen.brief
            assert.equal(d.includes('**目前樹上〔機制〕之成品中「內容(組成對照之超額)最高且可信」者與「回測期 S 最高且可信」者各是哪一個'), fg)
            assert.equal(d.includes('**目前樹上「內容(組成對照之超額)最高且可信」之成品與「回測期 S 最高且可信」之成品各是哪一個'), !fg)
            assert.equal(d.includes(';〔線索〕與未歸類者之最高另述為趨勢(不是進度)。'), fg)
            assert.equal(d.includes('**以「有內容且可信」之〔機制〕成品對組成對照之超額為主**(只計〔機制〕;〔線索〕與未歸類者之升降只作趨勢,不計為進度;S 含組成之水準'), fg)
            assert.equal(d.includes('**以「有內容且可信」者對組成對照之超額為主**(S 含組成之水準'), !fg)
            assert.equal(d.includes('以樹上最佳之可信〔機制〕成品為底、對照即該成品,尚無〔機制〕之成品者這些層不補位;其餘為單臂'), fg)
            assert.equal(d.includes('**目前〔機制〕之成品中「挑選內容(組成對照之超額)最高且可信」者與「回測期 S 最高且可信」者(並列;同一個者寫一次並註明;只計〔機制〕 —— 尚無者寫明,〔線索〕與未歸類者之最高另述為趨勢,不是進度)**'), fg)
            assert.equal(d.includes('**目前「挑選內容(組成對照之超額)最高且可信」之成品與「回測期 S 最高且可信」之成品(並列;同一個者寫一次並註明)**'), !fg)
        }
    })

    it('關閉:false 與未給之看板、搜尋地圖、載體與乾跑之計畫逐位相同(同一棵樹)', async () => {
        let outs = []
        for (let fg of [false, 'unset']) {
            let { P, st } = mk({ formGate: fg })
            put(P, { arms: ['A01_nt'], round: 1, S: 72.5, sel: 's-cl', k: 1, form: 'clue', content: 9 })
            put(P, { arms: ['A04_act'], round: 1, S: 38.1, sel: 's-me', k: 2, form: 'mechanism', content: 3 })
            put(P, { arms: ['B14_pitKey'], round: 2, S: 50.5, sel: 's-un', k: 3 })
            P.writeBoard()
            let dry = await P.rsi.explore({ dry: true, arms: 4, novelty: 4 })
            outs.push(JSON.stringify([read(st, 'ARMS_BOARD.md'), read(st, 'SEARCH_MAP.md'), P.domain.carriers(), dry.items.map((x) => [x.spec, x.reason]), dry.rejected]).split(path.dirname(st.rsi.root)).join('<D>'))
        }
        assert.equal(outs[0], outs[1])
        assert(!outs[0].includes('〔機制〕') && !outs[0].includes('〔線索〕'), '關閉者不出現形式之標記')
    })
})
