import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeProject, rankKeyOf, contentOf } from '../src/domain/domain.mjs'
import { rankCompareOf } from '../src/domain/rankCompare.mjs'
import { specHash } from '../src/engineApi.mjs'
import { makeTmp } from './tools/synthLedger.mjs'


//量尺之並列與選配之主鍵(規則 R-REC-49)
//  規格: ①看板之表前一段與輪末摘要之一列:「挑選內容最高且可信」與「排序鍵最高且可信」不同、或後者為側別曝險時才列;summary.best 不動
//    ②做夢更新 state 之一句改為並列 ③settings.rsi.rankBy = 'content' ⇒ 看板與搜尋地圖之「最高」與補位之底以挑選內容為主鍵(無其值者在後)、排序鍵為次鍵;'key' 與未給 = 現行、其餘之值拒絕(R-EV-54 ②)
//    ④對名次之影響之估法(rankCompareOf):兩種次序之第一名、Spearman ρ、Kendall τ-b、前 k 名之交集、曝險者之個數
//  合成資料: 各節點之臂、S、重放之 S、組成對照之超額、選集指紋逐筆相異
describe('量尺之並列與選配之主鍵(規則 R-REC-49)', function () {
    this.timeout(180000)
    let t
    beforeEach(() => {
        t = makeTmp('gaugeDual')
    })
    afterEach(() => {
        t.cleanup()
    })
    let briefs = []
    let mk = (rsiExtra = {}) => {
        let st = getSettings()
        let d = path.join(t.dir, `proj_${Math.random().toString(36).slice(2, 8)}`)
        st.resources = {}
        st.rsi = { ...st.rsi, root: path.join(d, 'rsi'), docLimits: false, maxArmsPerNode: 4, ...rsiExtra }
        st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(d, 'ledger')
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthGauge' }), 'utf8')
        let dispatch = async (role, { prompt }) => {
            if (role !== 'dream') {
                throw new Error('fake: 不派工')
            }
            let m = /請閱讀 (\S+)\/brief\.md/.exec(prompt)
            let wd = path.resolve(st.FD_ROOT, m[1])
            briefs.push(fs.readFileSync(path.join(wd, 'brief.md'), 'utf8'))
            let tpl = JSON.parse(fs.readFileSync(path.join(wd, 'dream.template.json'), 'utf8'))
            fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify({ audits: tpl.audits.map((x) => ({ nodeId: x.nodeId, trust: 'trusted', action: 'accept', evidence: ['假審計'], issues: [] })), synthesis: { summary: '假做夢', worked: [], failed: [], patterns: [], prevDirections: [] }, guidance: { directions: [], avoid: [], openQuestions: [], improvements: [], armProposals: [] }, expansion: [], docsUpdated: [] }), 'utf8')
            return { ok: true, agent: { kind: 'fake', model: 'fake-dream', effort: 'none' } }
        }
        let P = makeProject(st, { dispatch, gate: null, catalogFile: path.join(d, 'catalog.json') })
        P.rsi.init()
        return { P, st }
    }
    //put: comp = 組成對照之超額(null = 無組成對照 ⇒ 無挑選內容之值); reps = 重放之 S; x.fix = 固定側別(側別曝險)
    let put = (P, { arms, round, S, sel, k, comp, reps = null, trust = 'trusted', fix = false }) => {
        let spec = { arms, base: null }
        let id = P.idOf(spec)
        let metrics = {
            op: { eqYr: { mean: 18 + k * 1.7, min: -2 - k * 0.4, byPhase: [1, 2, 3, 4, 5, 6, 7].map((v) => v + k) }, monthlyOrders: { mean: 60 + k }, peakHold: { max: 12 + k }, bySide: { long: { orders: 800 + k }, short: { orders: 200 + k } } },
            null: { mean: -3 - k, excess: 7 + k, z: 1.8 + k / 10, p: 0.002 * k, sigPerPick: 1.0 },
            ...(comp === null ? {} : { nullSideAct: { excess: comp, p: 0.01 + k / 1000, share: 0.2 + k / 100, mean: 5 + k, half: 50, triggered: true } }),
            sel: { longRatio: fix ? 0.97 : 0.5 + k / 100, sizeMax: 4, sizeMean: 3, sigPerPick: 1.05 + k / 100 },
            ext: {},
        }
        let raw = { selHash: sel, metrics, issues: [], train: { longRatio: fix ? 0.96 : 0.51 + k / 100, tags: [], shortShare: 0.24 }, ...(reps ? { seedS: reps.slice(), replays: reps.map((s, i) => ({ S: s, comp: comp === null ? null : comp + 0.5 * (i + 1), recent: null })) } : {}) }
        P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round, raw, score: { S, ladder: 1, flags: { vetoed: false, why: [] } }, evidence: { trust } })
        return id
    }
    let read = (st, f) => fs.readFileSync(path.join(st.rsi.root, f), 'utf8')
    let f1 = (x) => x.toFixed(1)

    it('並列:兩者不同 ⇒ 看板之表前一段與輪末摘要之一列(字面值);兩者相同且非曝險 ⇒ 皆不列;排序鍵最高者為曝險(同一個)⇒ 列並註明', async () => {
        let { P, st } = mk()
        let hiS = put(P, { arms: ['A01_nt'], round: 1, S: 66.2, sel: 's1', k: 1, comp: 2.1, reps: [64.8, 65.1] })
        let hiC = put(P, { arms: ['A04_act'], round: 1, S: 51.7, sel: 's2', k: 2, comp: 9.4, reps: [50.2] })
        put(P, { arms: ['A02_ntPit'], round: 1, S: 40.3, sel: 's3', k: 3, comp: null })
        let nKey = P.rsi.store.getNode(hiS)
        let nC = P.rsi.store.getNode(hiC)
        let cC = contentOf(nC)
        let want = `挑選內容最高且可信者 \`${hiC.slice(0, 8)}\`(挑選內容 ${f1(cC.v)},${cC.kind},${cC.n} 抽之均;S 51.7) / 排序鍵最高且可信者 \`${hiS.slice(0, 8)}\`(S 66.2;排序鍵 ${f1(rankKeyOf(nKey))})`
        P.writeBoard()
        let para = read(st, 'ARMS_BOARD.md').split('\n').find((l) => l.startsWith('**量尺(並列)**'))
        assert.equal(para, `**量尺(並列)**:${want} —— 兩者不同時,排序鍵之高低可能只是組成之水準或側別之曝險;判進度以挑選內容為準(同搜尋地圖之量尺)。`)
        let r = await P.domain.hooks.afterRound({ round: 1, nodes: [nKey] })
        assert.deepEqual(r.lines.filter((l) => l.startsWith('量尺(並列')), [`量尺(並列;樹上可信者):${want}`])
        //做夢更新 state 之一句: 並列(舊句已無)
        let b = briefs[briefs.length - 1]
        assert(b.includes('**目前「挑選內容(組成對照之超額)最高且可信」之成品與「回測期 S 最高且可信」之成品(並列;同一個者寫一次並註明)**(各列 id、臂、S、七相位平均、最差相位、為正之相位數、對隨機挑之超額與 p、換亂數種子與同分次序之 S、可信度;為側別曝險者註明)'), '做夢任務書之 state 一句')
        assert(!b.includes('**目前回測期 S 最高且可信之成品**'))
        //兩者相同且非曝險 ⇒ 不列
        let q = mk()
        put(q.P, { arms: ['A01_nt'], round: 1, S: 66.2, sel: 's1', k: 1, comp: 9.9 })
        put(q.P, { arms: ['A04_act'], round: 1, S: 51.7, sel: 's2', k: 2, comp: 3.3 })
        //非可信者(部分可信、未審)之挑選內容雖最高, 不是候選
        put(q.P, { arms: ['A02_ntPit'], round: 1, S: 33.1, sel: 's3', k: 3, comp: 25.5, trust: 'partial' })
        put(q.P, { arms: ['B14_pitKey'], round: 1, S: 31.4, sel: 's4', k: 4, comp: 27.5, trust: null })
        q.P.writeBoard()
        assert(!read(q.st, 'ARMS_BOARD.md').includes('**量尺(並列)**'))
        let rq = await q.P.domain.hooks.afterRound({ round: 1, nodes: [q.P.rsi.store.getNode(q.P.idOf({ arms: ['A01_nt'], base: null }))] })
        assert(!rq.lines.some((l) => l.startsWith('量尺(並列')))
        //排序鍵最高者為曝險(且即挑選內容最高者)⇒ 列並註明
        let x = mk()
        let ex = put(x.P, { arms: ['A01_nt'], round: 1, S: 66.2, sel: 's1', k: 1, comp: 9.9, fix: true })
        put(x.P, { arms: ['A04_act'], round: 1, S: 51.7, sel: 's2', k: 2, comp: 3.3 })
        x.P.writeBoard()
        let px = read(x.st, 'ARMS_BOARD.md').split('\n').find((l) => l.startsWith('**量尺(並列)**'))
        assert(px && px.includes(`/ 排序鍵最高且可信者 \`${ex.slice(0, 8)}\`(S 66.2;排序鍵 66.2);**後者為側別曝險**(固定側別)`), px)
        //無挑選內容之值者(候選皆無組成對照)且非曝險 ⇒ 不列
        let z = mk()
        put(z.P, { arms: ['A01_nt'], round: 1, S: 66.2, sel: 's1', k: 1, comp: null })
        put(z.P, { arms: ['A04_act'], round: 1, S: 51.7, sel: 's2', k: 2, comp: null })
        z.P.writeBoard()
        assert(!read(z.st, 'ARMS_BOARD.md').includes('**量尺(並列)**'))
    })

    it('rsi.rankBy = content:補位之底、看板之次序與各臂之最佳、搜尋地圖之量尺依挑選內容(無其值者在後;同值依排序鍵);key 與未給 = 現行(看板與搜尋地圖逐字相同);其餘之值拒絕(R-EV-54)', () => {
        let build = (rsiExtra) => {
            let p = mk(rsiExtra)
            let ids = {
                hiS: put(p.P, { arms: ['A01_nt'], round: 1, S: 66.2, sel: 's1', k: 1, comp: 2.1, reps: [64.8, 65.1] }),
                hiC: put(p.P, { arms: ['A04_act'], round: 1, S: 51.7, sel: 's2', k: 2, comp: 9.4, reps: [50.2] }),
                noC: put(p.P, { arms: ['A02_ntPit'], round: 2, S: 70.3, sel: 's3', k: 3, comp: null }),
                midC: put(p.P, { arms: ['A01_nt', 'B14_pitKey'], round: 2, S: 49.9, sel: 's4', k: 4, comp: 9.4 }),
            }
            p.P.writeBoard()
            return { ...p, ids }
        }
        let c = build({ rankBy: 'content' })
        assert.equal(c.P.rankBy, 'content')
        //補位之底: 挑選內容最高者(hiC 與 midC 之內容: hiC = 9.4 與重放 9.9 之均 9.65 > midC 9.4)
        assert(contentOf(c.P.rsi.store.getNode(c.ids.hiC)).v > contentOf(c.P.rsi.store.getNode(c.ids.midC)).v)
        assert.equal(c.P.domain.carriers().D30_volumeCut.base, c.ids.hiC)
        let board = read(c.st, 'ARMS_BOARD.md')
        assert(board.includes('## 節點一覽(未被否決者在前;其內依挑選內容由高至低 —— 見表前之「主鍵」一段)'))
        assert(board.includes('**主鍵 = 挑選內容**(設定 `rsi.rankBy` = `content`;節點一覽之次序'))
        let order = board.split('\n').filter((l) => /^\| `[0-9a-f]/.test(l)).map((l) => l.slice(3, 11))
        assert.deepEqual(order, [c.ids.hiC, c.ids.midC, c.ids.hiS, c.ids.noC].map((id) => id.slice(0, 8)), '有內容者依內容、無其值者在後')
        assert(board.split('\n').find((l) => l.startsWith(`| \`${c.ids.hiC}\``)).includes(`**51.7**(內容 ${f1(contentOf(c.P.rsi.store.getNode(c.ids.hiC)).v)})`))
        //各可選臂之最佳: A01_nt 含 hiS(S 66.2)與 midC(S 49.9、內容較高)⇒ 依挑選內容取 midC
        let armRow = board.split('\n').find((l) => l.startsWith('| A01_nt |'))
        assert(armRow.includes('| 49.9(依挑選內容;內容 9.4) |'), armRow)
        let map = read(c.st, 'SEARCH_MAP.md')
        assert(map.includes(`〔依挑選內容 ${f1(contentOf(c.P.rsi.store.getNode(c.ids.hiC)).v)}〕`), '搜尋地圖之標記')
        assert(map.includes('標「〔依挑選內容 …〕」者:該處之「最高」以**主鍵 = 挑選內容**選取'))
        //'key' 與未給(null)= 現行: 看板與搜尋地圖與未設定者逐字相同; 其餘之值(S、1、true…)給了而無效 ⇒ 組裝時拒絕(R-EV-54 ②: rankBy 決定「最高」與補位之底; 原: 靜默視為排序鍵)
        let k0 = build({})
        for (let v of ['S', 1, true, 'Content', '', {}]) {
            assert.throws(() => build({ rankBy: v }), /^Error: invalid rsi\.rankBy: must be one of content, key$/, String(v))
        }
        for (let v of ['key', null]) {
            let k1 = build({ rankBy: v })
            assert.equal(k1.P.rankBy, 'key', String(v))
            assert.equal(read(k1.st, 'ARMS_BOARD.md'), read(k0.st, 'ARMS_BOARD.md'), String(v))
            assert.equal(read(k1.st, 'SEARCH_MAP.md').replace(/`[0-9a-f]{8}`/g, ''), read(k0.st, 'SEARCH_MAP.md').replace(/`[0-9a-f]{8}`/g, ''), String(v))
            assert.equal(k1.P.domain.carriers().D30_volumeCut.base, k0.P.domain.carriers().D30_volumeCut.base)
        }
        assert.equal(k0.P.domain.carriers().D30_volumeCut.base, k0.ids.noC, '現行: 排序鍵最高者')
    })

    it('對名次之影響之估法(rankCompareOf):第一名、ρ 與 τ-b 與獨立之算式相同、前 k 名之交集與曝險者之個數', () => {
        let rows = [
            { id: 'a1', key: 60, content: 2, exposure: true },
            { id: 'b2', key: 55, content: 9, exposure: false },
            { id: 'c3', key: 50, content: 9, exposure: false },
            { id: 'd4', key: 45, content: 4, exposure: true },
            { id: 'e5', key: 45, content: 7, exposure: false },
            { id: 'f6', key: 30, content: 1, exposure: false },
            { id: 'bad', key: NaN, content: 1, exposure: false },
        ]
        let r = rankCompareOf(rows, { k: 3 })
        assert.equal(r.n, 6)
        assert.deepEqual(r.byKey, ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'])
        assert.deepEqual(r.byContent, ['b2', 'c3', 'e5', 'd4', 'a1', 'f6'])
        assert.deepEqual([r.firstKey, r.firstContent, r.sameFirst], ['a1', 'b2', false])
        assert.deepEqual([r.overlap, r.exposureKey, r.exposureContent], [2, 1, 0])
        //獨立: 平均名次之 Pearson = Spearman; τ-b = (C − D) / √((n0 − n1)(n0 − n2))
        let rk = (vs) => vs.map((v) => vs.filter((w) => w > v).length + (vs.filter((w) => w === v).length + 1) / 2)
        let ok = rows.slice(0, 6)
        let x = rk(ok.map((o) => o.key))
        let y = rk(ok.map((o) => o.content))
        let m = (v) => v.reduce((s, a) => s + a, 0) / v.length
        let cov = x.map((v, i) => (v - m(x)) * (y[i] - m(y))).reduce((s, a) => s + a, 0)
        let rho = cov / Math.sqrt(x.map((v) => (v - m(x)) ** 2).reduce((s, a) => s + a, 0) * y.map((v) => (v - m(y)) ** 2).reduce((s, a) => s + a, 0))
        assert(Math.abs(r.spearman - rho) < 1e-12, `${r.spearman} ${rho}`)
        let C = 0
        let D = 0
        let n0 = 0
        let n1 = 0
        let n2 = 0
        for (let i = 0; i < 6; i++) {
            for (let j = i + 1; j < 6; j++) {
                n0++
                let dx = ok[i].key - ok[j].key
                let dy = ok[i].content - ok[j].content
                n1 += dx === 0 ? 1 : 0
                n2 += dy === 0 ? 1 : 0
                C += dx * dy > 0 ? 1 : 0
                D += dx * dy < 0 ? 1 : 0
            }
        }
        assert(Math.abs(r.kendall - (C - D) / Math.sqrt((n0 - n1) * (n0 - n2))) < 1e-12)
        assert.deepEqual(rankCompareOf([{ id: 'z', key: 1, content: 1 }]).spearman, null)
        assert.equal(rankCompareOf([], {}).firstKey, null)
    })
})
