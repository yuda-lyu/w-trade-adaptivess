import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { getSettings } from '../src/cfg.mjs'
import { makeProject, rankKeyOf, contentOf } from '../src/domain/domain.mjs'
import { specHash } from '../src/engineApi.mjs'
import { makeTmp, writeSynthLedger, FD_ROOT } from './tools/synthLedger.mjs'


//量尺之並列與選配之主鍵之候選對齊「有內容」(規則 R-REC-49 ⑤)
//  規格: 「有內容」為單一定義(搜尋地圖之量尺、看板與輪末摘要之並列、選配之主鍵 rsi.rankBy = 'content'、補位之底共用; P.hasContent):
//    內建之組成對照之超額 > 0、p ≤ 階梯 1 之虛無 p、組成可重現之比例 < 0.8, 有近期活躍度版之值者其條件亦成立, 未自述 notContent
//    ①並列之「挑選內容最高」只取「有內容」者; 有挑選內容之值而不符者不為候選 ②主鍵: 不符者視同無其值(排在有內容者之後、依排序鍵), 註記寫「不符「有內容」」
//    ③估法(tools/rankCompare.mjs)之候選同一定義, 另列「有值而不符有內容」之個數
//  鑑別之前提: 不符「有內容」者之挑選內容之值高於「有內容」者(改前之候選規則會選到它)—— 各案另斷言
describe('量尺之並列與選配之主鍵之候選對齊「有內容」(規則 R-REC-49 ⑤)', function () {
    this.timeout(240000)
    let t
    beforeEach(() => {
        t = makeTmp('gaugeContent')
    })
    afterEach(() => {
        t.cleanup()
    })
    let mk = (rsiExtra = {}) => {
        let st = getSettings()
        let d = path.join(t.dir, `proj_${Math.random().toString(36).slice(2, 8)}`)
        st.resources = {}
        st.rsi = { ...st.rsi, root: path.join(d, 'rsi'), docLimits: false, maxArmsPerNode: 4, autoFill: false, ...rsiExtra }
        st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(d, 'ledger')
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthGC' }), 'utf8')
        let P = makeProject(st, { dispatch: async () => ({ ok: false, error: 'fake' }), gate: null, catalogFile: path.join(d, 'catalog.json') })
        P.rsi.init()
        return { P, st }
    }
    //put: comp = 組成對照 { excess, p, share }(null = 無 ⇒ 無挑選內容之值); reps = 重放之 S; 各欄逐節點相異
    let put = (P, { arms, round = 1, S, sel, k, comp, reps = null, trust = 'trusted', fix = false }) => {
        let spec = { arms, base: null }
        let id = P.idOf(spec)
        let metrics = {
            op: { eqYr: { mean: 18 + k * 1.7, min: -2 - k * 0.4, byPhase: [1, 2, 3, 4, 5, 6, 7].map((v) => v + k) }, monthlyOrders: { mean: 60 + k }, peakHold: { max: 12 + k } },
            null: { mean: -3 - k, excess: 7 + k, z: 1.8 + k / 10, p: 0.002 * (k + 1), sigPerPick: 1.0 },
            ...(comp === null ? {} : { nullSideAct: { excess: comp.excess, p: comp.p, share: comp.share, mean: 5 + k, half: 50, triggered: true } }),
            sel: { longRatio: fix ? 0.97 : 0.5 + k / 100, sizeMax: 4, sizeMean: 3, sigPerPick: 1.05 + k / 100 },
            ext: {},
        }
        let raw = { selHash: sel, metrics, issues: [], train: { longRatio: fix ? 0.96 : 0.51 + k / 100, tags: [], shortShare: 0.24 }, ...(reps ? { seedS: reps.slice(), replays: reps.map((s, i) => ({ S: s, comp: comp === null ? null : comp.excess + 0.5 * (i + 1), recent: null })) } : {}) }
        P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round, raw, score: { S, ladder: 1, flags: { vetoed: false, why: [] } }, evidence: { trust } })
        return id
    }
    let read = (st, f) => fs.readFileSync(path.join(st.rsi.root, f), 'utf8')
    let nodesOf = (P) => P.rsi.store.listIndex().map((r) => P.rsi.store.getNode(r.id))
    let f1 = (x) => x.toFixed(1)
    //K = 排序鍵最高(有內容)、A = 有內容而挑選內容次之、B = 挑選內容最高而 p 過門檻、C = 挑選內容次高而組成可重現 ≥ 0.8、D = 無組成對照
    let tree = (P) => ({
        K: put(P, { arms: ['A01_nt'], S: 70.4, sel: 'sK', k: 1, comp: { excess: 1.5, p: 0.01, share: 0.21 } }),
        A: put(P, { arms: ['A04_act'], S: 50.6, sel: 'sA', k: 2, comp: { excess: 6.2, p: 0.02, share: 0.32 } }),
        B: put(P, { arms: ['A02_ntPit'], S: 60.3, sel: 'sB', k: 3, comp: { excess: 12.4, p: 0.2, share: 0.33 } }),
        C: put(P, { arms: ['B14_pitKey'], S: 55.1, sel: 'sC', k: 4, comp: { excess: 10.7, p: 0.004, share: 0.85 } }),
        D: put(P, { arms: ['A01_nt', 'B14_pitKey'], S: 45.9, sel: 'sD', k: 5, comp: null }),
    })

    it('①「有內容」之單一定義(P.hasContent)與搜尋地圖之「有內容」相同;並列之「挑選內容最高」只取有內容者(看板之段落之字面值)', () => {
        let { P, st } = mk()
        let x = tree(P)
        let n = (k) => P.rsi.store.getNode(x[k])
        assert.deepEqual(['K', 'A', 'B', 'C', 'D'].map((k) => P.hasContent(n(k))), [true, true, false, false, false])
        //鑑別之前提: 不符者之挑選內容之值高於有內容者
        assert(contentOf(n('B')).v > contentOf(n('A')).v && contentOf(n('C')).v > contentOf(n('A')).v)
        P.writeBoard()
        //搜尋地圖之譜系之「有內容」與同一定義相同
        let m = read(st, 'SEARCH_MAP.md')
        for (let k of ['K', 'A', 'B', 'C', 'D']) {
            let l = m.split('\n').find((s) => s.includes(`\`${x[k].slice(0, 8)}\` `))
            assert.equal(l.includes(';**有內容**'), P.hasContent(n(k)), k)
        }
        let gd = P.gaugeDualOf(nodesOf(P))
        assert.equal(gd.content.id, x.A, '挑選內容最高(有內容者中)= A(改前為 B)')
        let cA = contentOf(n('A'))
        let para = read(st, 'ARMS_BOARD.md').split('\n').find((l) => l.startsWith('**量尺(並列)**'))
        assert.equal(para, `**量尺(並列)**:挑選內容最高且可信者 \`${x.A.slice(0, 8)}\`(挑選內容 ${f1(cA.v)},${cA.kind},${cA.n} 抽之均;S 50.6) / 排序鍵最高且可信者 \`${x.K.slice(0, 8)}\`(S 70.4;排序鍵 ${f1(rankKeyOf(n('K')))}) —— 兩者不同時,排序鍵之高低可能只是組成之水準或側別之曝險;判進度以挑選內容為準(同搜尋地圖之量尺)。`)
        //搜尋地圖之量尺之「挑選內容最高」(改前已只取有內容者)與並列同一個
        assert(m.includes(`;**挑選內容最高** \`${x.A.slice(0, 8)}\`:`), '搜尋地圖之量尺與並列同一個')
    })

    it('並列之註記:可信者皆無「有內容」之挑選內容而排序鍵最高者為側別曝險 ⇒ 註明「皆不符」;皆無挑選內容之值者照改前之字樣', () => {
        let { P, st } = mk()
        let k1 = put(P, { arms: ['A01_nt'], S: 70.4, sel: 'sX', k: 1, comp: { excess: 8.8, p: 0.3, share: 0.2 }, fix: true })
        put(P, { arms: ['A04_act'], S: 50.6, sel: 'sY', k: 2, comp: { excess: 3.1, p: 0.01, share: 0.9 } })
        P.writeBoard()
        let para = read(st, 'ARMS_BOARD.md').split('\n').find((l) => l.startsWith('**量尺(並列)**'))
        assert(para.startsWith('**量尺(並列)**:挑選內容最高且可信者 —(可信者之挑選內容皆不符「有內容」) / 排序鍵最高且可信者 `' + k1.slice(0, 8)), para)
        let { P: P2, st: st2 } = mk()
        put(P2, { arms: ['A01_nt'], S: 70.4, sel: 'sX', k: 1, comp: null, fix: true })
        P2.writeBoard()
        let p2 = read(st2, 'ARMS_BOARD.md').split('\n').find((l) => l.startsWith('**量尺(並列)**'))
        assert(p2.startsWith('**量尺(並列)**:挑選內容最高且可信者 —(可信者皆無挑選內容之值) / '), p2)
    })

    it('②主鍵 rsi.rankBy = content:不符「有內容」者視同無其值 —— 補位之底、看板之次序、各臂之最佳、搜尋地圖之最高與其註記(「不符「有內容」」)', () => {
        let { P, st } = mk({ rankBy: 'content' })
        let x = tree(P)
        //第 3 輪: X = 挑選內容之值最高而 p 過門檻、排序鍵最高(S 較低); Y = 無組成對照、S 最高 ⇒ 兩者皆無主鍵之值 ⇒ 依排序鍵取 X(與 S 最高者不同 ⇒ 註記)
        let X = put(P, { arms: ['A01_nt', 'A04_act'], round: 3, S: 60.2, sel: 'sX3', k: 6, comp: { excess: 15.3, p: 0.3, share: 0.2 }, reps: [90.4, 89.6] })
        let Y = put(P, { arms: ['A02_ntPit', 'A04_act'], round: 3, S: 70.8, sel: 'sY3', k: 7, comp: null })
        let n = (id) => P.rsi.store.getNode(id)
        assert(contentOf(n(X)).v > contentOf(n(x.A)).v, '鑑別之前提')
        //補位之底(可信、未被否決、臂數未滿; 主鍵 = 有內容者之挑選內容)= A(改前為 X:其值最高)
        let cs = P.domain.carriers()
        let bases = [...new Set(Object.values(cs).map((c) => c.base).filter(Boolean))]
        assert.deepEqual(bases, [x.A], JSON.stringify(cs))
        P.writeBoard()
        let b = read(st, 'ARMS_BOARD.md').split('\n')
        let order = b.filter((l) => /^\| `[0-9a-f]{16}` \|/.test(l)).map((l) => /^\| `([0-9a-f]{16})`/.exec(l)[1])
        //有內容者(K、A)依其值在前(A 6.2 > K 1.5), 其後無其值者(B、C、D、X、Y)依排序鍵
        let rest = [x.B, x.C, x.D, X, Y].map((id) => n(id)).sort((p, q) => rankKeyOf(q) - rankKeyOf(p)).map((v) => v.id)
        assert.deepEqual(order, [x.A, x.K, ...rest])
        let mp = read(st, 'SEARCH_MAP.md')
        let r3 = mp.split('\n').find((l) => l.startsWith('| r003 |'))
        assert(r3.includes(`60.2〔依挑選內容:不符「有內容」,排序鍵 ${f1(rankKeyOf(n(X)))}〕(\`${X.slice(0, 8)}\`)`), r3)
        assert(mp.includes('只計「有內容」者 —— 不符者視同無其值'), '§1 之說明')
        assert(b.some((l) => l.includes('只計搜尋地圖之「有內容」者(不符者視同無其值)')), '看板之主鍵一段')
        //各可選臂之最佳: A04_act 之最佳 = A(有內容)而非 X(值最高而不符)
        let armRow = b.find((l) => l.startsWith('| A04_act |'))
        assert(armRow.includes(`50.6(依挑選內容;內容 ${f1(contentOf(n(x.A)).v)})`), armRow)
    })

    it('③估法 tools/rankCompare.mjs:候選 = 有內容者;另列「有值而不符有內容」之個數(唯讀)', () => {
        let root = path.join(t.dir, 'proj')
        fs.mkdirSync(path.join(root, 'skills', 'node_modules', 'w-dispatch-ai'), { recursive: true })
        fs.writeFileSync(path.join(root, 'skills', 'node_modules', 'w-dispatch-ai', 'package.json'), JSON.stringify({ name: 'w-dispatch-ai', main: 'index.cjs' }))
        fs.writeFileSync(path.join(root, 'skills', 'node_modules', 'w-dispatch-ai', 'index.cjs'), 'module.exports = { providers: [], readEnvFile: () => ({}), dispatchOpencode: async () => ({ ok: false, error: \'stub\' }), dispatchClaude: async () => ({ ok: false, error: \'stub\' }) }\n')
        fs.mkdirSync(path.join(root, 'arms'), { recursive: true })
        fs.copyFileSync(path.join(FD_ROOT, 'arms', 'base.json'), path.join(root, 'arms', 'base.json'))
        writeSynthLedger(path.join(root, 'ledger'), { n: 40, nBars: 2400, seed: 13 })
        let stJ = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
        stJ.periods = { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } }
        stJ.eval = { ...stJ.eval, ledgerDir: './ledger', warmupDays: 60, phases: [0, 3], horizons: [7], nullDraws: 4 }
        delete stJ.eval.fitEnd
        stJ.dispatch = { skillsRoot: path.join(root, 'skills'), envFile: path.join(root, '.env') }
        stJ.rsi = { ...stJ.rsi, root: './rsi' }
        stJ.records = { nodeDir: './rsi/records/nodes', dreamDir: './rsi/records/dreams', trashDir: './rsi/records/trash', workDir: './rsi/work', toolboxDir: './rsi/toolbox' }
        stJ.resources = {}
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(stJ, null, 1))
        fs.writeFileSync(path.join(root, '.env'), 'X=1\n')
        let st = getSettings()
        st.rsi = { ...st.rsi, root: path.join(root, 'rsi') }
        st.records = { nodeDir: path.join(root, 'rsi/records/nodes'), dreamDir: path.join(root, 'rsi/records/dreams'), trashDir: path.join(root, 'rsi/records/trash'), workDir: path.join(root, 'rsi/work'), toolboxDir: path.join(root, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(root, 'ledger')
        st.resources = {}
        let P = makeProject(st, { dispatch: async () => ({ ok: false }), gate: null, catalogFile: path.join(root, 'catalog_t.json') })
        P.rsi.init()
        let x = tree(P)
        let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'tools', 'rankCompare.mjs')], { cwd: t.dir, env: { ...process.env, ARSI_ROOT: root }, windowsHide: true, encoding: 'utf8', timeout: 150000 })
        assert.equal(r.status, 0, r.stderr)
        let L = r.stdout.split('\n')
        assert.equal(L[1], '候選(可信、未被否決、有內容且有挑選內容之值)2 個;另有挑選內容之值而不符「有內容」者 2 個(不計入;主鍵視同無其值)')
        //候選 = K、A(B、C 有值而不符; D 無值): 挑選內容之第一名 = A(改前為 B)
        assert.equal(L[2], `第一名:排序鍵 ${x.K.slice(0, 8)} / 挑選內容 ${x.A.slice(0, 8)}(不同)`)
    })
})
