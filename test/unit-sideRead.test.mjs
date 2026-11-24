import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { SIDE_READ_DEFAULT, sideReadCfgOf, sideReadOf, sideReadTextOf } from '../src/domain/sideRead.mjs'
import { specHash } from '../src/engineApi.mjs'
import { makeTmp } from './tools/synthLedger.mjs'


//全樹之側別讀數(規則 R-REC-50)
//  規格: ①對象 = 已執行、未被否決、相異(選集指紋)之成品;不足 minNodes 個(預設 10)不列 ②讀數 = 做多比例與七相位平均之相關(Pearson)、排序鍵前 10 名之做多比例之範圍
//    ③警示 = 相關之絕對值 ≥ 0.6、或前 10 名之做多比例皆 ≤ 0.2、或皆 ≥ 0.8(恰為門檻者命中);命中時搜尋地圖 §4 與輪末摘要各一列 ④settings.rsi.sideRead = false 關閉
//  合成資料: 各列之 id、選集指紋、做多比例、七相位平均、排序鍵逐列相異(除刻意之同指紋與同鍵)
//pearsonI, 獨立之相關(兩段式: 先求均, 再求共變與變異)
let pearsonI = (xs, ys) => {
    let n = xs.length
    let mx = xs.reduce((a, b) => a + b, 0) / n
    let my = ys.reduce((a, b) => a + b, 0) / n
    let c = xs.map((x, i) => (x - mx) * (ys[i] - my)).reduce((a, b) => a + b, 0)
    let vx = xs.map((x) => (x - mx) ** 2).reduce((a, b) => a + b, 0)
    let vy = ys.map((y) => (y - my) ** 2).reduce((a, b) => a + b, 0)
    return c / Math.sqrt(vx * vy)
}
let rowsOf = (n, f) => Array.from({ length: n }, (_, i) => ({ id: `n${String(i).padStart(2, '0')}x`, sel: `sel${i}`, ...f(i) }))

describe('全樹之側別讀數(sideRead.mjs;規則 R-REC-50)', function () {
    it('設定之解讀:false = 關閉;不合之鍵用預設(不拋錯);lo ≥ hi 者兩者皆回預設', () => {
        assert.deepEqual(SIDE_READ_DEFAULT, { minNodes: 10, top: 10, corrAbs: 0.6, lo: 0.2, hi: 0.8 })
        assert.strictEqual(sideReadCfgOf(false), null)
        for (let v of [undefined, null, true, 'x', [], {}]) {
            assert.deepEqual(sideReadCfgOf(v), { minNodes: 10, top: 10, corrAbs: 0.6, lo: 0.2, hi: 0.8 }, JSON.stringify(v))
        }
        assert.deepEqual(sideReadCfgOf({ minNodes: 4, top: 3, corrAbs: 0.5, lo: 0.1, hi: 0.9 }), { minNodes: 4, top: 3, corrAbs: 0.5, lo: 0.1, hi: 0.9 })
        assert.deepEqual(sideReadCfgOf({ minNodes: 1, top: 2.5, corrAbs: 1.2, lo: -0.1, hi: 'abc' }), { minNodes: 10, top: 10, corrAbs: 0.6, lo: 0.2, hi: 0.8 })
        //排程第 595 項(K4、K7): 數字字串轉為數值後使用(原: 只收 number, '0.7' 被當成未給而用預設 0.8); 布林與空字串仍無效
        assert.deepEqual(sideReadCfgOf({ minNodes: '4', top: ' 3 ', corrAbs: '0.5', lo: '0.1', hi: '0.7' }), { minNodes: 4, top: 3, corrAbs: 0.5, lo: 0.1, hi: 0.7 })
        assert.deepEqual(sideReadCfgOf({ minNodes: true, top: '', corrAbs: false, lo: [], hi: '0x10' }), { minNodes: 10, top: 10, corrAbs: 0.6, lo: 0.2, hi: 0.8 })
        assert.deepEqual(sideReadCfgOf({ lo: 0.85 }), { minNodes: 10, top: 10, corrAbs: 0.6, lo: 0.2, hi: 0.8 })
    })

    it('讀數:相關與獨立之算式相同;選集指紋相同者只計先出現之一列;做多比例或七相位平均非有限數值之列不計;前幾名依排序鍵(同值依 id;非有限數值者在後)', () => {
        let cfg = sideReadCfgOf({ minNodes: 5, top: 3 })
        let rows = rowsOf(9, (i) => ({ longRatio: 0.1 + i * 0.07 + (i % 3) * 0.01, mean: 30 - i * 2.3 + (i % 2) * 4, key: [5, 9, 9, 2, 7, null, 4, 8, 1][i] }))
        //同指紋之第二列(不計)、非有限數值之列(不計)
        rows.push({ id: 'n99x', sel: 'sel3', longRatio: 0.99, mean: 99, key: 100 })
        rows.push({ id: 'n98x', sel: 'selNaN', longRatio: NaN, mean: 5, key: 50 })
        rows.push({ id: 'n97x', sel: 'selInf', longRatio: 0.3, mean: Infinity, key: 50 })
        let sr = sideReadOf(rows, cfg)
        let ok = rows.slice(0, 9)
        assert.equal(sr.n, 9)
        assert(Math.abs(sr.r - pearsonI(ok.map((x) => x.longRatio), ok.map((x) => x.mean))) < 1e-12, String(sr.r))
        //前 3 名: 鍵 9(n01x、n02x;同值依 id)、8(n07x)
        assert.equal(sr.nTop, 3)
        assert.equal(sr.topLo, Math.min(ok[1].longRatio, ok[2].longRatio, ok[7].longRatio))
        assert.equal(sr.topHi, Math.max(ok[1].longRatio, ok[2].longRatio, ok[7].longRatio))
        //鍵非有限數值者排在最後(top = 全部時才含它)
        let sr9 = sideReadOf(rows, sideReadCfgOf({ minNodes: 5, top: 8 }))
        assert(sr9.topHi < ok[5].longRatio || ok.filter((x, i) => i !== 5).some((x) => x.longRatio === sr9.topHi), '鍵為 null 者不在前 8 名')
        //不足下限 ⇒ null(恰為下限者照列); 關閉 ⇒ null
        assert.strictEqual(sideReadOf(rows, sideReadCfgOf({ minNodes: 10 })), null)
        assert.equal(sideReadOf(rows, sideReadCfgOf({ minNodes: 9 })).n, 9)
        assert.strictEqual(sideReadOf(rows, null), null)
        //變異數為 0 ⇒ r = null(不據以警示)
        let flat = rowsOf(6, (i) => ({ longRatio: 0.5, mean: 10 + i, key: i }))
        let sf = sideReadOf(flat, sideReadCfgOf({ minNodes: 5 }))
        assert.strictEqual(sf.r, null)
        assert.equal(sf.warn.corr, false)
    })

    it('警示之邊界:|r| 恰為門檻者命中、略高之門檻不命中;前幾名之做多比例皆 ≤ lo(恰為 lo 者含)/ 皆 ≥ hi 者命中,有一列越過即不命中', () => {
        let rows = rowsOf(8, (i) => ({ longRatio: 0.3 + i * 0.05, mean: 10 + i * i * 0.7, key: 20 - i }))
        let r = pearsonI(rows.map((x) => x.longRatio), rows.map((x) => x.mean))
        let at = sideReadOf(rows, sideReadCfgOf({ minNodes: 5, corrAbs: Math.abs(sideReadOf(rows, sideReadCfgOf({ minNodes: 5 })).r) }))
        assert.equal(at.warn.corr, true)
        assert.equal(sideReadOf(rows, sideReadCfgOf({ minNodes: 5, corrAbs: Math.min(1, Math.abs(r) + 1e-9) })).warn.corr, false)
        //負相關亦以絕對值判
        let neg = rows.map((x) => ({ ...x, mean: -x.mean }))
        assert.equal(sideReadOf(neg, sideReadCfgOf({ minNodes: 5, corrAbs: 0.6 })).warn.corr, true)
        //前 3 名皆 ≤ 0.2(其一恰為 0.2)⇒ short; 其一為 0.2001 ⇒ 不命中
        let sh = rowsOf(6, (i) => ({ longRatio: [0.2, 0.05, 0.12, 0.6, 0.7, 0.9][i], mean: [3, 1, 4, 1, 5, 9][i] + i, key: 10 - i }))
        let s1 = sideReadOf(sh, sideReadCfgOf({ minNodes: 5, top: 3 }))
        assert.deepEqual([s1.warn.short, s1.warn.long], [true, false])
        sh[0].longRatio = 0.2001
        assert.equal(sideReadOf(sh, sideReadCfgOf({ minNodes: 5, top: 3 })).warn.short, false)
        let lg = rowsOf(6, (i) => ({ longRatio: [0.8, 0.95, 0.88, 0.3, 0.2, 0.1][i], mean: [3, 1, 4, 1, 5, 9][i] + i, key: 10 - i }))
        assert.deepEqual([sideReadOf(lg, sideReadCfgOf({ minNodes: 5, top: 3 })).warn.long, sideReadOf(lg, sideReadCfgOf({ minNodes: 5, top: 3 })).warn.short], [true, false])
        lg[0].longRatio = 0.7999
        assert.equal(sideReadOf(lg, sideReadCfgOf({ minNodes: 5, top: 3 })).warn.long, false)
    })

    it('文字:讀數一列與警示之句之字面值;未命中警示 ⇒ 空字串;null ⇒ 兩者皆空', () => {
        assert.deepEqual(sideReadTextOf(null), { line: '', warn: '' })
        let t = sideReadTextOf({ n: 12, r: 0.7134, nTop: 10, topLo: 0.05, topHi: 0.183, warn: { corr: true, short: true, long: false } })
        assert.equal(t.line, '- 側別讀數(回測期;相異成品 12 個):做多比例與七相位平均之相關 0.71;排序鍵前 10 名之做多比例 0.05 ~ 0.18。')
        assert.equal(t.warn, '側別讀數之警示:績效與做多比例高度相關;排序鍵前 10 名皆偏做空(相異成品 12 個)⇒ 樹上之高分可能來自側別之曝險,宜以兩側席次固定之版本與成員穩健性核對')
        let u = sideReadTextOf({ n: 11, r: null, nTop: 10, topLo: 0.85, topHi: 0.9, warn: { corr: false, short: false, long: true } })
        assert(u.line.includes('之相關 —;'))
        assert.equal(u.warn, '側別讀數之警示:排序鍵前 10 名皆偏做多(相異成品 11 個)⇒ 樹上之高分可能來自側別之曝險,宜以兩側席次固定之版本與成員穩健性核對')
        assert.equal(sideReadTextOf({ n: 11, r: 0.1, nTop: 10, topLo: 0.3, topHi: 0.6, warn: { corr: false, short: false, long: false } }).warn, '')
    })
})

describe('側別讀數之接線(搜尋地圖 §4、輪末摘要;規則 R-REC-50)', function () {
    this.timeout(180000)
    let t
    beforeEach(() => {
        t = makeTmp('sideRead')
    })
    afterEach(() => {
        t.cleanup()
    })
    let mk = (rsiExtra = {}) => {
        let st = getSettings()
        let d = path.join(t.dir, `proj_${Math.random().toString(36).slice(2, 8)}`)
        st.resources = {}
        st.rsi = { ...st.rsi, root: path.join(d, 'rsi'), docLimits: false, maxArmsPerNode: 4, ...rsiExtra }
        st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(d, 'ledger')
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthSide' }), 'utf8')
        let dispatch = async (role, { prompt }) => {
            if (role !== 'dream') {
                throw new Error('fake: 不派工')
            }
            let m = /請閱讀 (\S+)\/brief\.md/.exec(prompt)
            let wd = path.resolve(st.FD_ROOT, m[1])
            let tpl = JSON.parse(fs.readFileSync(path.join(wd, 'dream.template.json'), 'utf8'))
            fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify({ audits: tpl.audits.map((x) => ({ nodeId: x.nodeId, trust: 'trusted', action: 'accept', evidence: ['假審計'], issues: [] })), synthesis: { summary: '假做夢', worked: [], failed: [], patterns: [], prevDirections: [] }, guidance: { directions: [], avoid: [], openQuestions: [], improvements: [], armProposals: [] }, expansion: [], docsUpdated: [] }), 'utf8')
            return { ok: true, agent: { kind: 'fake', model: 'fake-dream', effort: 'none' } }
        }
        let P = makeProject(st, { dispatch, gate: null, catalogFile: path.join(d, 'catalog.json') })
        P.rsi.init()
        return { P, st }
    }
    //樹: n 個已執行之節點(臂各異); lrOf(i) = 做多比例、meanOf(i) = 七相位平均; 第 0 個被否決(不計)
    let seed = (P, n, lrOf, meanOf) => {
        //各節點為一個相異之單臂規格(臂目錄之可選臂依序取)
        let arms = P.selectable.map((x) => x.id)
        assert(arms.length >= n, `可選臂 ${arms.length} 個`)
        let ids = []
        for (let i = 0; i < n; i++) {
            let spec = { arms: [arms[i]], base: null }
            let id = P.idOf(spec)
            let metrics = { op: { eqYr: { mean: meanOf(i), min: -3 - i * 0.3, byPhase: [1, 2, 3, 4, 5, 6, 7] }, monthlyOrders: { mean: 70 + i }, peakHold: { max: 10 + i } }, null: { mean: -2, excess: 4 + i, z: 1.5, p: 0.01 }, sel: { longRatio: lrOf(i), sizeMax: 4, sizeMean: 3, sigPerPick: 1.2 }, ext: {} }
            P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round: 1 + (i % 3), raw: { selHash: `sel-${i}`, metrics, issues: [] }, score: { S: 30 + i * 1.7, ladder: 1, flags: { vetoed: i === 0, why: [] } }, evidence: { trust: 'trusted' } })
            ids.push(id)
        }
        return ids
    }
    let mapOf = (st) => fs.readFileSync(path.join(st.rsi.root, 'SEARCH_MAP.md'), 'utf8')

    it('相異成品達下限 ⇒ §4 列讀數(其值 = sideReadOf 對同一組列之結果);被否決者不計;命中 ⇒ 另列警示,輪末摘要亦列一列;不足下限或關閉 ⇒ 不列', async () => {
        //13 個節點(第 0 個被否決 ⇒ 12 個相異)、做多比例與七相位平均正相關
        let { P, st } = mk()
        let ids = seed(P, 13, (i) => 0.2 + i * 0.05, (i) => 5 + i * 3 + (i % 2))
        //別名(選集指紋與較早之節點相同、輪次較晚)不計
        {
            let spec = { arms: [P.selectable[20].id], base: null }
            let src = P.rsi.store.getNode(ids[4])
            P.rsi.store.putNode({ id: P.idOf(spec), spec, specHash: specHash(spec), status: 'executed', parents: [], round: 9, raw: { ...src.raw, metrics: { ...src.raw.metrics, sel: { ...src.raw.metrics.sel, longRatio: 0.99 } } }, score: { S: 99.5, ladder: 1, flags: { vetoed: false, why: [] } }, evidence: { trust: 'trusted' } })
            assert.equal(P.rsi.aliasMap().size, 1, '前提: 別名 1 個')
        }
        P.writeBoard()
        let lines = mapOf(st).split('\n')
        let li = lines.find((l) => l.startsWith('- 側別讀數(回測期;'))
        assert(li, '讀數之列')
        let nodes = ids.slice(1).map((id) => P.rsi.store.getNode(id))
        let rows = nodes.map((n) => ({ id: n.id, sel: n.raw.selHash, longRatio: n.raw.metrics.sel.longRatio, mean: n.raw.metrics.op.eqYr.mean, key: n.score.S })).sort((a, b) => (a.id < b.id ? -1 : 1))
        let want = sideReadTextOf(sideReadOf(rows, sideReadCfgOf()))
        assert.equal(li, want.line)
        assert(li.includes('相異成品 12 個'), li)
        assert(want.warn.startsWith('側別讀數之警示:績效與做多比例高度相關'), want.warn)
        assert(lines.includes(`- ${want.warn}`))
        let r = await P.domain.hooks.afterRound({ round: 3, nodes: [P.rsi.store.getNode(ids[5])] })
        assert.equal(r.lines.filter((l) => l === want.warn).length, 1, r.lines.join('\n'))
        //關閉 ⇒ 不列(搜尋地圖與輪末摘要)
        let q = mk({ sideRead: false })
        seed(q.P, 13, (i) => 0.2 + i * 0.05, (i) => 5 + i * 3 + (i % 2))
        q.P.writeBoard()
        assert(!/側別讀數/.test(mapOf(q.st)))
        //不足下限 ⇒ 不列
        let s = mk()
        seed(s.P, 10, (i) => 0.2 + i * 0.05, (i) => 5 + i * 3)
        s.P.writeBoard()
        assert(!/側別讀數/.test(mapOf(s.st)), '9 個相異(第 0 個被否決)< 10')
    })

    it('不相關且前幾名兩側皆有 ⇒ 只列讀數、不列警示(輪末摘要無警示之列)', async () => {
        let { P, st } = mk()
        let lr = [0.5, 0.3, 0.7, 0.45, 0.62, 0.38, 0.55, 0.41, 0.66, 0.35, 0.58, 0.47, 0.52]
        let mn = [10, 11, 9, 12, 8, 13, 7, 9.5, 11.5, 10.5, 8.5, 12.5, 9.8]
        let ids = seed(P, 13, (i) => lr[i], (i) => mn[i])
        P.writeBoard()
        let m = mapOf(st)
        assert(m.includes('- 側別讀數(回測期;相異成品 12 個)'))
        assert(!m.includes('側別讀數之警示'))
        let r = await P.domain.hooks.afterRound({ round: 3, nodes: [P.rsi.store.getNode(ids[4])] })
        assert(!r.lines.some((l) => l.startsWith('側別讀數之警示')))
    })
})
