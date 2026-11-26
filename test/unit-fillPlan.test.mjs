import assert from 'assert/strict'
import * as FP from '../src/domain/fillPlan.mjs'


//附算與補算之計畫與寫入內容(規則 R-REC-34; 使用端提案, 純新增): 純函數 —— 待算清單(快取之鍵 = 成品之內容雜湊 + 評估器之指紋 + 診斷之內容雜湊)、
//  求解窗後段之值(postfitRowOf)、補算檔之內容(fillDocOf)、摘要之列(fillLinesOf)
//  以命名空間匯入: 於未支援之版本(修前)各案分別失敗, 不因匯入具名之項不存在而整檔無法載入
describe('附算與補算之計畫(規則 R-REC-34)', function () {
    let { planFill, registryOf, sameKey, postfitRowOf, postfitLineOf, fillDocOf, postfitOfFill, fillLinesOf } = FP
    let NOW = '2026-03-01T00:00:00.000Z'
    //各成品之各欄皆不同(雜湊、評估時刻、正本之診斷、補算檔), 使錯位可被看出
    let diags = [{ name: 'dB', hash: 'hb1' }, { name: 'dA', hash: 'ha1' }, { name: 'dC', hash: 'hc1' }]
    let node = (id, pickHash, evaluatedAt, extNames, fill = null) => ({ id, pickHash, evaluatedAt, extNames, fill })

    it('第一次(無登錄、無補算檔):postfit 皆須算;正本已有之診斷視為現行、缺者須補;targets 以外者入 backlog', function () {
        let nodes = [
            node('n3', 'p3', '2026-01-03T00:00:00Z', ['dA', 'dB', 'dC']),
            node('n1', 'p1', '2026-01-01T00:00:00Z', ['dA']),
            node('n2', 'p2', '2026-01-02T00:00:00Z', ['dB', 'dC']),
        ]
        let p = planFill({ nodes, diags, registry: null, evaluator: 'E1', now: NOW })
        assert.deepEqual(p.tasks.map((t) => t.nodeId), ['n1', 'n2', 'n3'])
        assert.deepEqual(p.tasks.map((t) => t.postfit), [true, true, true])
        assert.deepEqual(p.tasks.map((t) => t.ext), [['dB', 'dC'], ['dA'], []])
        assert.deepEqual(p.tasks[0].keys.postfit, { pick: 'p1', evaluator: 'E1' })
        assert.deepEqual(p.tasks[0].keys.ext, { dB: { pick: 'p1', evaluator: 'E1', diag: 'hb1' }, dC: { pick: 'p1', evaluator: 'E1', diag: 'hc1' } })
        assert.deepEqual(p.tasks[1].keys.ext, { dA: { pick: 'p2', evaluator: 'E1', diag: 'ha1' } })
        assert.deepEqual(p.backlog, { postfit: [], ext: { dA: [], dB: [], dC: [] } })
        assert.deepStrictEqual(p.registry, { dA: { hash: 'ha1', since: null }, dB: { hash: 'hb1', since: null }, dC: { hash: 'hc1', since: null } })
        assert.equal(p.nCurrent, 0)
        //targets: 只有 n2 入待算; 其餘之須算者入 backlog(依 id 排序)
        let q = planFill({ nodes, diags, registry: null, evaluator: 'E1', now: NOW, targets: ['n2'] })
        assert.deepEqual(q.tasks.map((t) => [t.nodeId, t.postfit, t.ext]), [['n2', true, ['dA']]])
        assert.deepEqual(q.backlog, { postfit: ['n1', 'n3'], ext: { dA: [], dB: ['n1'], dC: ['n1'] } })
    })

    it('快取之鍵:補算檔有同鍵之值者不重算;成品之雜湊、評估器之指紋、診斷之雜湊任一不同 ⇒ 重算', function () {
        let reg = { dA: { hash: 'ha1', since: null }, dB: { hash: 'hb1', since: null }, dC: { hash: 'hc1', since: null } }
        let fillOf = (pick, ev, extD) => ({
            schema: FP.FILL_SCHEMA,
            nodeId: 'x',
            postfit: { key: { pick, evaluator: ev }, at: '2026-02-01T00:00:00Z', row: { seatsKept: 1 } },
            ext: Object.fromEntries(Object.entries(extD).map(([nm, h]) => [nm, { key: { pick, evaluator: ev, diag: h }, at: '2026-02-01T00:00:00Z', value: { board: nm } }])),
        })
        let nodes = [
            //全部現行(postfit 同鍵; dA 由補算檔〔樹上亦有其值〕、dB / dC 由正本)
            node('a1', 'pa', '2026-01-05T00:00:00Z', ['dA', 'dB', 'dC'], fillOf('pa', 'E1', { dA: 'ha1' })),
            //補算檔有同鍵之 dA 而樹上無其值(被移除)⇒ 以樹為準, 須補
            node('a0', 'pz', '2026-01-04T00:00:00Z', ['dB', 'dC'], fillOf('pz', 'E1', { dA: 'ha1' })),
            //成品重做(補算檔之鍵之 pick 不同)⇒ postfit 與補算檔之 dA 皆過時; 正本之 dB 仍現行(正本隨重做而重算)
            node('a2', 'pa2new', '2026-01-06T00:00:00Z', ['dB', 'dC'], fillOf('pa2old', 'E1', { dA: 'ha1' })),
            //評估器改版 ⇒ postfit 與補算檔之 dA 過時
            node('a3', 'pc', '2026-01-07T00:00:00Z', ['dB', 'dC'], fillOf('pc', 'E0', { dA: 'ha1' })),
            //補算檔之 dA 之診斷雜湊與現行不同 ⇒ dA 過時(postfit 照舊現行)
            node('a4', 'pd', '2026-01-08T00:00:00Z', ['dB', 'dC'], fillOf('pd', 'E1', { dA: 'ha0' })),
            //補算檔之 postfit 無 row(不完整)⇒ 重算
            node('a5', 'pe', '2026-01-09T00:00:00Z', ['dA', 'dB', 'dC'], { ...fillOf('pe', 'E1', {}), postfit: { key: { pick: 'pe', evaluator: 'E1' }, at: 'x' } }),
        ]
        let p = planFill({ nodes, diags, registry: reg, evaluator: 'E1', now: NOW })
        assert.equal(p.nCurrent, 1)
        assert.deepEqual(p.tasks.map((t) => [t.nodeId, t.postfit, t.ext]), [['a0', false, ['dA']], ['a2', true, ['dA']], ['a3', true, ['dA']], ['a4', false, ['dA']], ['a5', true, []]])
        assert.strictEqual(p.tasks[3].keys.postfit, null)
        assert.deepEqual(p.tasks[3].keys.ext.dA, { pick: 'pd', evaluator: 'E1', diag: 'ha1' })
        assert.deepEqual(p.tasks[1].keys.postfit, { pick: 'pa2new', evaluator: 'E1' })
        //force: 只作用於 targets 內者(a1 全部重算; 其餘照常計入 backlog)
        let q = planFill({ nodes, diags, registry: reg, evaluator: 'E1', now: NOW, targets: ['a1'], force: true })
        assert.deepEqual(q.tasks.map((t) => [t.nodeId, t.postfit, t.ext]), [['a1', true, ['dA', 'dB', 'dC']]])
        assert.deepEqual(q.backlog, { postfit: ['a2', 'a3', 'a5'], ext: { dA: ['a0', 'a2', 'a3', 'a4'], dB: [], dC: [] } })
        //postfit: false / ext 指名
        let r = planFill({ nodes, diags, registry: reg, evaluator: 'E1', now: NOW, postfit: false, ext: ['dA'] })
        assert.deepEqual(r.tasks.map((t) => [t.nodeId, t.postfit, t.ext]), [['a0', false, ['dA']], ['a2', false, ['dA']], ['a3', false, ['dA']], ['a4', false, ['dA']]])
        assert.deepEqual(Object.keys(r.backlog.ext), ['dA'])
        let s = planFill({ nodes, diags, registry: reg, evaluator: 'E1', now: NOW, ext: false })
        assert.deepEqual(s.tasks.map((t) => [t.nodeId, t.postfit, t.ext]), [['a2', true, []], ['a3', true, []], ['a5', true, []]])
        //樹上有其值、補算檔之鍵之診斷雜湊與現行不同、正本之評估早於 since ⇒ 須補; 補算檔之鍵與現行相同 ⇒ 現行
        let reg2 = { ...reg, dA: { hash: 'ha1', since: '2026-02-15T00:00:00Z' } }
        let nodes2 = [
            node('c1', 'pf', '2026-01-10T00:00:00Z', ['dA', 'dB', 'dC'], fillOf('pf', 'E1', { dA: 'ha0' })),
            node('c2', 'pg', '2026-01-11T00:00:00Z', ['dA', 'dB', 'dC'], fillOf('pg', 'E1', { dA: 'ha1' })),
        ]
        let u = planFill({ nodes: nodes2, diags, registry: reg2, evaluator: 'E1', now: NOW })
        assert.deepEqual(u.tasks.map((t) => [t.nodeId, t.postfit, t.ext]), [['c1', false, ['dA']]])
        assert.equal(u.nCurrent, 1)
        assert.deepEqual(u.registry.dA, { hash: 'ha1', since: '2026-02-15T00:00:00Z' })
    })

    it('診斷之登錄:改寫(雜湊變)⇒ since = 此刻、正本之評估早於 since 者之正本值過時;不早於者現行;新增之診斷照「缺者須補」', function () {
        let prev = { dA: { hash: 'ha1', since: null }, dB: { hash: 'hb0', since: '2026-01-01T00:00:00Z' }, dOld: { hash: 'ho', since: null } }
        let r = registryOf(prev, diags, NOW)
        //dA 同雜湊 ⇒ 沿用 since(null); dB 改寫 ⇒ since = NOW; dC 新增 ⇒ since = NOW; dOld 已移除 ⇒ 不留; 依名排序
        assert.deepStrictEqual(r, { dA: { hash: 'ha1', since: null }, dB: { hash: 'hb1', since: NOW }, dC: { hash: 'hc1', since: NOW } })
        assert.deepEqual(Object.keys(r), ['dA', 'dB', 'dC'])
        assert.deepStrictEqual(registryOf(null, diags, NOW), { dA: { hash: 'ha1', since: null }, dB: { hash: 'hb1', since: null }, dC: { hash: 'hc1', since: null } })
        //已有 since 而雜湊相同者照留
        assert.deepEqual(registryOf({ dA: { hash: 'ha1', since: '2026-02-02T00:00:00Z' } }, [{ name: 'dA', hash: 'ha1' }], NOW), { dA: { hash: 'ha1', since: '2026-02-02T00:00:00Z' } })
        let nodes = [
            node('b1', 'q1', '2026-02-28T23:59:59.000Z', ['dA', 'dB', 'dC']),
            node('b2', 'q2', '2026-03-01T00:00:00.000Z', ['dA', 'dB', 'dC']),
            node('b3', 'q3', null, ['dA', 'dB']),
            //補算檔有現行雜湊之 dB ⇒ 現行(正本之評估雖早於 since)
            node('b4', 'q4', '2026-01-01T00:00:00Z', ['dA', 'dB', 'dC'], { schema: FP.FILL_SCHEMA, nodeId: 'b4', postfit: null, ext: { dB: { key: { pick: 'q4', evaluator: 'E1', diag: 'hb1' }, at: NOW, value: { board: 1 } } } }),
        ]
        let p = planFill({ nodes, diags, registry: prev, evaluator: 'E1', now: NOW, postfit: false })
        assert.deepEqual(p.tasks.map((t) => [t.nodeId, t.ext]), [['b1', ['dB', 'dC']], ['b3', ['dB', 'dC']], ['b4', ['dC']]])
        assert.equal(p.nCurrent, 1)
    })

    it('參數之檢查:不合者拋錯(訊息不帶輸入值)', function () {
        let ok = { nodes: [], evaluator: 'E', now: NOW }
        let bad = [
            [null, 'invalid opt: must be an object'],
            [{ ...ok, nodes: 'x' }, 'invalid opt.nodes: must be an array'],
            [{ ...ok, diags: [{ name: 'a' }] }, 'invalid opt.diags: must be an array of { name, hash }'],
            [{ ...ok, evaluator: '' }, 'invalid opt.evaluator: must be a non-empty string'],
            [{ ...ok, now: 3 }, 'invalid opt.now: must be a non-empty string'],
            [{ ...ok, targets: 'n1' }, 'invalid opt.targets: must be an array or null'],
            [{ ...ok, diags, ext: ['dZ'] }, 'invalid opt.ext: must name existing diagnostics'],
            [{ ...ok, ext: 'dA' }, 'invalid opt.ext: must be a boolean or an array'],
            [{ ...ok, nodes: [{ id: 'n1' }] }, 'invalid opt.nodes: each must have id and pickHash'],
        ]
        for (let [o, msg] of bad) {
            assert.throws(() => planFill(o), (e) => e.message === msg, msg)
        }
        assert.equal(sameKey({ pick: 'a', evaluator: 'e' }, { pick: 'a', evaluator: 'e', diag: null }), true)
        assert.equal(sameKey({ pick: 'a', evaluator: 'e', diag: 'd1' }, { pick: 'a', evaluator: 'e', diag: 'd2' }), false)
        assert.equal(sameKey(null, { pick: 'a' }), false)
    })

    //合成之 --period postfit 結果檔(各欄之值皆不同)
    let pfResult = (recent) => ({
        ok: true,
        period: { name: 'postfit', label: 'x', start: '2025-04-08T04:00:00', end: '2025-10-06T00:00:00', canonical: false },
        score: null,
        metrics: {
            selHash: 'sel123',
            nullSideAct: { draws: 64, half: 50, mean: 140.1, sd: 6.2, p: 0.0615, z: 1.6464, excess: 10.2871, share: 0.93 },
            afterFit: {
                seatsKept: 27.5,
                seatsDropped: 12.25,
                orders: 818.4,
                halves: [
                    { from: '2025-04-09T00:00:00', to: '2025-07-13T00:00:00', nDecisions: [13], seats: 27, eqYr: { mean: 214.5 }, orders: 324, sideAct: { draws: 64, p: 0.0154, z: 3.7666, excess: 30.3399 }, ...(recent ? { sideActRecent: { draws: 64, p: 0.0308, z: 3.9209, excess: 39.856 } } : {}) },
                    { from: '2025-07-07T00:00:00', to: '2025-10-12T00:00:00', nDecisions: [13], seats: 27, eqYr: { mean: 94.1 }, orders: 499, sideAct: { draws: 64, p: 0.9692, z: -1.845, excess: -15.3368 }, ...(recent ? { sideActRecent: { draws: 64, p: 0.5, z: -0.7, excess: -7.32 } } : {}) },
                ],
                ...(recent ? { sideActRecent: { draws: 64, half: 50, actDays: 90, mean: 127.7, sd: 7.3, p: 0.0462, z: 3.0057, excess: 21.9715 } } : {}),
            },
        },
    })

    it('postfitRowOf:只取所列之鍵(原值);近期活躍度版有則帶、無則不帶;不是求解窗後段之結果者拋錯', function () {
        let r0 = postfitRowOf(pfResult(false))
        assert.deepEqual(r0, {
            from: '2025-04-08T04:00:00',
            to: '2025-10-06T00:00:00',
            seatsKept: 27.5,
            seatsDropped: 12.25,
            comp: { excess: 10.2871, z: 1.6464, p: 0.0615 },
            halves: [
                { from: '2025-04-09T00:00:00', to: '2025-07-13T00:00:00', excess: 30.3399, z: 3.7666, p: 0.0154 },
                { from: '2025-07-07T00:00:00', to: '2025-10-12T00:00:00', excess: -15.3368, z: -1.845, p: 0.9692 },
            ],
            selHash: 'sel123',
        })
        assert.equal('recent' in r0, false)
        let r1 = postfitRowOf(pfResult(true))
        assert.deepEqual(r1.recent, { comp: { excess: 21.9715, z: 3.0057, p: 0.0462 }, halves: [{ excess: 39.856, z: 3.9209, p: 0.0308 }, { excess: -7.32, z: -0.7, p: 0.5 }] })
        assert.deepEqual(Object.keys(r1), ['from', 'to', 'seatsKept', 'seatsDropped', 'comp', 'halves', 'selHash', 'recent'])
        //未算組成對照(nullSideAct 為 null)、不分段(halves 為 null)
        let o2 = pfResult(true)
        o2.metrics.nullSideAct = null
        o2.metrics.afterFit.halves = null
        o2.metrics.afterFit.sideActRecent = null
        let r2 = postfitRowOf(o2)
        assert.strictEqual(r2.comp, null)
        assert.strictEqual(r2.halves, null)
        assert.deepStrictEqual(r2.recent, { comp: null, halves: null })
        //回測期之結果、失敗之結果、無 afterFit 者拋錯
        let msg = 'invalid result: must be an ok result of --period postfit'
        assert.throws(() => postfitRowOf({ ...pfResult(false), period: { name: 'backtest' } }), (e) => e.message === msg)
        assert.throws(() => postfitRowOf({ ...pfResult(false), ok: false }), (e) => e.message === msg)
        assert.throws(() => postfitRowOf({ ...pfResult(false), metrics: { selHash: 'x' } }), (e) => e.message === msg)
        assert.throws(() => postfitRowOf(null), (e) => e.message === msg)
    })

    it('postfitLineOf:以固定之開頭起首;列所留 / 所捨之席、全段與前段 / 後段之超額 / z / p;近期活躍度版有則列', function () {
        //開頭之字樣以字面核對(節點文件之舊列以此辨認而取代; 只比常數本身則改了字樣亦不紅)
        assert.equal(FP.POSTFIT_HEAD, '求解窗後段(佐證;非正本):')
        let l0 = postfitLineOf(postfitRowOf(pfResult(false)))
        assert.equal(l0, `${FP.POSTFIT_HEAD}所留之席 27.5 / 所捨 12.25(每次決策之平均);所留之席之組成對照之超額 +10.3(z 1.65、p 0.0615);前段 +30.3(z 3.77、p 0.0154) / 後段 -15.3(z -1.84、p 0.9692);不入 S、階梯與看板之排序`)
        let l1 = postfitLineOf(postfitRowOf(pfResult(true)))
        assert.ok(l1.includes(';近 90 日活躍度版 +22.0(z 3.01、p 0.0462)(前段 +39.9(z 3.92、p 0.0308) / 後段 -7.3(z -0.70、p 0.5))'), l1)
        let o2 = pfResult(false)
        o2.metrics.nullSideAct = null
        o2.metrics.afterFit.halves = null
        assert.equal(postfitLineOf(postfitRowOf(o2)), `${FP.POSTFIT_HEAD}所留之席 27.5 / 所捨 12.25(每次決策之平均);所留之席之組成對照之超額 未算;不分段;不入 S、階梯與看板之排序`)
    })

    it('fillDocOf / postfitOfFill:同名者取代、其餘照留;未給 postfit 者沿用前次;結構版本或節點不同之前次視同無', function () {
        let kP = { pick: 'p1', evaluator: 'E1' }
        let d1 = fillDocOf(null, { nodeId: 'n1', at: 'T1', postfit: { key: kP, row: { seatsKept: 3 } }, ext: { dB: { key: { ...kP, diag: 'hb' }, value: { board: 2 } } } })
        assert.deepEqual(d1, { schema: FP.FILL_SCHEMA, nodeId: 'n1', postfit: { key: kP, at: 'T1', row: { seatsKept: 3 } }, ext: { dB: { key: { ...kP, diag: 'hb' }, at: 'T1', value: { board: 2 } } } })
        let d2 = fillDocOf(d1, { nodeId: 'n1', at: 'T2', ext: { dA: { key: { ...kP, diag: 'ha' }, value: { board: 1 } }, dB: { key: { ...kP, diag: 'hb2' }, value: { board: 5 } } } })
        assert.deepEqual(d2.postfit, d1.postfit)
        assert.deepEqual(Object.keys(d2.ext), ['dA', 'dB'])
        assert.deepEqual(d2.ext.dB, { key: { ...kP, diag: 'hb2' }, at: 'T2', value: { board: 5 } })
        //前次之結構版本不同 / 節點不同 ⇒ 視同無
        assert.deepStrictEqual(fillDocOf({ ...d1, schema: 'other' }, { nodeId: 'n1', at: 'T3' }), { schema: FP.FILL_SCHEMA, nodeId: 'n1', postfit: null, ext: {} })
        assert.deepStrictEqual(fillDocOf(d1, { nodeId: 'n9', at: 'T3' }), { schema: FP.FILL_SCHEMA, nodeId: 'n9', postfit: null, ext: {} })
        assert.deepEqual(postfitOfFill(d1, kP), { at: 'T1', row: { seatsKept: 3 } })
        assert.strictEqual(postfitOfFill(d1, { pick: 'p1', evaluator: 'E2' }), null)
        assert.strictEqual(postfitOfFill(d1, { pick: 'p2', evaluator: 'E1' }), null)
        assert.strictEqual(postfitOfFill({ ...d1, schema: 'other' }, kP), null)
        assert.strictEqual(postfitOfFill(null, kP), null)
    })

    it('fillLinesOf:有結果者一列(成功 / 失敗之計數與失敗者);有待補算者另一列(含補齊之指令);皆無者為空', function () {
        assert.deepEqual(fillLinesOf({ tasks: [], results: [], backlog: { postfit: [], ext: { dA: [] } }, sec: 0 }), [])
        let L = fillLinesOf({
            tasks: [],
            results: [
                { nodeId: 'aaaaaaaa11', postfit: 'ok', ext: { ok: ['dA'], failed: [] } },
                { nodeId: 'bbbbbbbb22', postfit: 'failed', ext: { ok: [], failed: ['dB', 'dC'] }, error: '逾時\n第二列' },
                { nodeId: 'cccccccc33', postfit: null, ext: { ok: ['dA', 'dB'], failed: [] } },
            ],
            backlog: { postfit: ['x1', 'x2'], ext: { dA: ['x1'], dB: [] } },
            sec: 61.6,
        })
        assert.equal(L.length, 2)
        assert.equal(L[0], '附算(求解窗後段與擴充診斷;佐證,不改 S):3 個成品;求解窗後段 成功 1、**失敗 1**;擴充診斷 補入 3 項、**失敗 2 項**;62 秒;失敗者(再執行補算工具時重試):bbbbbbbb(逾時)')
        //輪末之附算: 重試之時機寫下一次輪末
        let LR = fillLinesOf({ source: 'round', results: [{ nodeId: 'bbbbbbbb22', postfit: 'failed', ext: { ok: [], failed: [] }, error: '逾時' }], backlog: { postfit: [], ext: {} }, sec: 1 })
        assert(LR[0].endsWith('失敗者(下一次輪末重試):bbbbbbbb(逾時)'), LR[0])
        assert.equal(L[1], '待補算之成品(不在本次之範圍;以 `node g_rsi.mjs --mode fill` 補齊,可中斷續跑):求解窗後段 2 個;擴充診斷 dA 1 個')
        assert.deepEqual(fillLinesOf({ results: [], backlog: { postfit: [], ext: { dB: ['y'] } } }, { cmd: 'X' }), ['待補算之成品(不在本次之範圍;以 `X` 補齊,可中斷續跑):求解窗後段 0 個;擴充診斷 dB 1 個'])
    })

    it('正本之選集指紋:補算檔之 postfit.canon.selHash 與節點之正本之選集指紋不同 ⇒ 須重算;相同或任一缺 ⇒ 現行;postfitOfFill / postfitInfoOf 同;fillDocOf 帶 canon', function () {
        let key = { pick: 'p', evaluator: 'e' }
        let row = { seatsKept: 3 }
        let fillOf = (canon) => ({ schema: FP.FILL_SCHEMA, nodeId: 'a1', postfit: { key, at: '2026-01-02T00:00:00Z', row, ...(canon === undefined ? {} : { canon: { selHash: canon, at: '2026-01-01T00:00:00Z' } }) }, ext: {} })
        let plan = (f, sel) => FP.planFill({ nodes: [{ id: 'a1', pickHash: 'p', evaluatedAt: null, extNames: [], fill: f, ...(sel === undefined ? {} : { selHash: sel }) }], diags: [], evaluator: 'e', now: '2026-02-01T00:00:00Z', ext: false })
        assert.deepEqual(plan(fillOf('s1'), 's1').tasks, [], '相同 ⇒ 現行')
        assert.deepEqual(plan(fillOf('s1'), 's2').tasks.map((x) => [x.nodeId, x.postfit]), [['a1', true]], '不同 ⇒ 須重算')
        assert.deepEqual(plan(fillOf(undefined), 's2').tasks, [], '較早之補算檔(無 canon)⇒ 現行')
        assert.deepEqual(plan(fillOf('s1')).tasks, [], '節點無正本之指紋 ⇒ 現行')
        assert.deepEqual(plan(fillOf(null), 's2').tasks, [], 'canon.selHash 為 null ⇒ 現行')
        assert(FP.postfitOfFill(fillOf('s1'), key, 's1') && FP.postfitOfFill(fillOf('s1'), key) && FP.postfitOfFill(fillOf('s1'), key, 's2') === null)
        assert.equal(FP.postfitInfoOf(fillOf('s1'), key, 's1').current, true)
        assert.equal(FP.postfitInfoOf(fillOf('s1'), key, 's2').current, false)
        assert.equal(FP.postfitInfoOf(fillOf('s1'), key).current, true)
        assert.equal(FP.postfitInfoOf(fillOf('s1'), { pick: 'p', evaluator: 'x' }, 's1').current, false, '評估器不同 ⇒ 非現行(既有)')
        let d = FP.fillDocOf(null, { nodeId: 'a1', at: 't', postfit: { key, row, canon: { selHash: 's9', at: 'u' } } })
        assert.deepEqual(d.postfit.canon, { selHash: 's9', at: 'u' })
        assert(!('canon' in FP.fillDocOf(null, { nodeId: 'a1', at: 't', postfit: { key, row } }).postfit))
    })

    it('擴充診斷之鍵併入虛無抽數:以縮減之抽數補算者之鍵帶 nulls;所存之鍵與本次之抽數不同者須補、相同者現行;sameKey 比 nulls(缺鍵視同 null)', function () {
        let diags = [{ name: 'dA', hash: 'h1' }]
        let fillOf = (nulls) => ({ schema: FP.FILL_SCHEMA, nodeId: 'a1', postfit: null, ext: { dA: { key: { pick: 'p', evaluator: 'e', diag: 'h1', ...(nulls ? { nulls } : {}) }, at: '2026-01-02T00:00:00Z', value: { v: 1 } } } })
        //登錄之 since 非 null 且正本之評估時刻不明 ⇒ 正本之值不視為現行(只看補算檔之鍵; 鑑別前提)
        let reg = { dA: { hash: 'h1', since: '2026-01-01T00:00:00Z' } }
        let plan = (f, nd) => FP.planFill({ nodes: [{ id: 'a1', pickHash: 'p', evaluatedAt: null, extNames: ['dA'], fill: f }], diags, registry: reg, evaluator: 'e', now: '2026-02-01T00:00:00Z', postfit: false, ...(nd === undefined ? {} : { nullDraws: nd }) })
        assert.deepEqual(plan(fillOf(null)).tasks, [], '未縮減之鍵、未縮減 ⇒ 現行')
        assert.deepEqual(plan(fillOf(null), null).tasks, [])
        assert.deepEqual(plan(fillOf(null), 8).tasks.map((x) => x.ext), [['dA']], '未縮減之鍵、縮減 8 ⇒ 須補')
        assert.deepEqual(plan(fillOf(null), 8).tasks[0].keys.ext.dA, { pick: 'p', evaluator: 'e', diag: 'h1', nulls: 8 })
        assert.deepEqual(plan(fillOf(8), 8).tasks, [], '同為 8 ⇒ 現行')
        assert.deepEqual(plan(fillOf(8), 16).tasks.map((x) => x.ext), [['dA']])
        assert.deepEqual(plan(fillOf(8)).tasks.map((x) => x.ext), [['dA']], '8 之鍵、未縮減 ⇒ 須補')
        assert.deepEqual(plan(fillOf(null)).tasks.length, 0)
        assert(!FP.sameKey({ pick: 'p', evaluator: 'e', diag: 'h1', nulls: 8 }, { pick: 'p', evaluator: 'e', diag: 'h1' }))
        assert(FP.sameKey({ pick: 'p', evaluator: 'e', diag: 'h1', nulls: null }, { pick: 'p', evaluator: 'e', diag: 'h1' }))
        for (let bad of [0, -1, 1.5, '8', true]) {
            assert.throws(() => plan(fillOf(null), bad), (e) => e.message === 'invalid opt.nullDraws: must be a positive integer or null', String(bad))
        }
    })

    //強制重算之失敗者續為強制重算(Gitea #178 §7 第 11 點之主控裁定): planFill 之 forced = { <節點 id>: { postfit?, ext? } }(狀態檔之待重試所記)
    it('forced:所列之項目不論是否現行皆重算(只作用於 targets 內之成品與本次所計畫之項目);任務帶 forced(因強制而計畫之項目);未強制者不帶此鍵;形狀不合者拋錯', function () {
        let reg = { dA: { hash: 'ha1', since: null }, dB: { hash: 'hb1', since: null } }
        let two = [{ name: 'dA', hash: 'ha1' }, { name: 'dB', hash: 'hb1' }]
        let okFill = (id, pick) => ({
            schema: FP.FILL_SCHEMA,
            nodeId: id,
            postfit: { key: { pick, evaluator: 'E1' }, at: '2026-02-01T00:00:00Z', row: { seatsKept: 1 } },
            ext: {
                dA: { key: { pick, evaluator: 'E1', diag: 'ha1' }, at: '2026-02-01T00:00:00Z', value: { board: 'a' } },
                dB: { key: { pick, evaluator: 'E1', diag: 'hb1' }, at: '2026-02-01T00:00:00Z', value: { board: 'b' } },
            },
        })
        //三個成品皆現行(postfit 與兩個診斷皆有同鍵之值、樹上有其值)
        let nodes = ['n1', 'n2', 'n3'].map((id, k) => ({ id, pickHash: `p${k}`, evaluatedAt: '2026-01-01T00:00:00Z', extNames: ['dA', 'dB'], fill: okFill(id, `p${k}`) }))
        let plan = (o) => FP.planFill({ nodes, diags: two, registry: reg, evaluator: 'E1', now: NOW, ...o })
        assert.deepEqual(plan({}).tasks, [], '對照: 全部現行 ⇒ 無待算(鑑別前提)')
        //forced: n1 只有求解窗後段、n2 只有 dB; n3 未列
        let p = plan({ forced: { n1: { postfit: true }, n2: { ext: ['dB'] } } })
        assert.deepEqual(p.tasks.map((t) => [t.nodeId, t.postfit, t.ext]), [['n1', true, []], ['n2', false, ['dB']]])
        assert.deepEqual(p.tasks.map((t) => t.forced), [{ postfit: true, ext: [] }, { postfit: false, ext: ['dB'] }])
        assert.deepEqual(p.tasks[1].keys.ext, { dB: { pick: 'p1', evaluator: 'E1', diag: 'hb1' } }, '鍵與現況相同(重算後寫回同鍵)')
        assert.equal(p.nCurrent, 1, 'n3 現行')
        //targets: forced 只作用於 targets 內之成品(targets 以外者不入待算、也不入待補算 —— 值仍現行)
        let q = plan({ targets: ['n2'], forced: { n1: { postfit: true }, n2: { ext: ['dB'] } } })
        assert.deepEqual(q.tasks.map((t) => t.nodeId), ['n2'])
        assert.deepEqual(q.backlog, { postfit: [], ext: { dA: [], dB: [] } })
        //本次之選項限縮: --no-postfit 時 forced 之 postfit 不計畫; ext 只含 dA 時 forced 之 dB 不計畫(續留於待重試, 由 fill 沿用)
        assert.deepEqual(plan({ postfit: false, forced: { n1: { postfit: true } } }).tasks, [])
        assert.deepEqual(plan({ ext: ['dA'], forced: { n2: { ext: ['dB'] } } }).tasks, [])
        //已不存在之診斷、形狀不合之項不計畫(不拋錯)
        assert.deepEqual(plan({ forced: { n1: { ext: ['dZ'] }, n2: 5, n3: { postfit: 'yes', ext: 'dA' } } }).tasks, [])
        //全域 force: 全部項目皆因強制而計畫(任務之 forced 涵蓋全部)
        let f = plan({ force: true, targets: ['n3'] })
        assert.deepEqual(f.tasks.map((t) => [t.nodeId, t.forced]), [['n3', { postfit: true, ext: ['dA', 'dB'] }]])
        //forced 與 force 並用: 不重複
        assert.deepEqual(plan({ force: true, forced: { n1: { postfit: true } }, targets: ['n1'] }).tasks[0].forced, { postfit: true, ext: ['dA', 'dB'] })
        //因「過時」(非強制)而計畫之項目不帶 forced
        let stale = plan({ nodes: [{ ...nodes[0], pickHash: 'newpick' }] })
        assert.equal(stale.tasks.length, 1)
        assert.equal('forced' in stale.tasks[0], false, '過時之任務不帶 forced')
        //形狀不合: forced 非物件 ⇒ 拋錯(V19、V20; 訊息不帶輸入值); null / undefined 為未給
        for (let bad of [[], 'n1', 1, true]) {
            assert.throws(() => plan({ forced: bad }), (e) => e.message === 'invalid opt.forced: must be an object or null', String(bad))
        }
        assert.deepEqual(plan({ forced: null }).tasks, [])
        assert.deepEqual(plan({ forced: undefined }).tasks, [])
    })

    it('fillLinesOf:輪末(source round)另列「來源為命令列之待重試」之個數(輪末不自動重試;升版前無來源欄者視為命令列);命令列之補算不列;無者不列', function () {
        let base = { results: [], backlog: { postfit: [], ext: {} }, sec: 0 }
        let ri = [
            { id: 'a', n: 1, last: 'x', source: 'cli' },
            { id: 'b', n: 2, last: 'x', source: 'round' },
            { id: 'c', n: 3, last: null, source: 'cli', force: { ext: ['dA'] } },
            { id: 'd', n: 1, last: null },
        ]
        let CMD = 'node g_rsi.mjs --mode fill'
        let l = fillLinesOf({ ...base, source: 'round', retryInfo: ri })
        assert.deepEqual(l, [`待重試而來源為命令列者 3 個(輪末不自動重試;以 \`${CMD}\` 重試)`], '3 = a、c、d(來源非 round 者)')
        assert.deepEqual(fillLinesOf({ ...base, source: 'round', retryInfo: ri }, { cmd: 'X' }), ['待重試而來源為命令列者 3 個(輪末不自動重試;以 `X` 重試)'])
        assert.deepEqual(fillLinesOf({ ...base, source: 'cli', retryInfo: ri }), [], '命令列之補算不列(其失敗已於「失敗者」列出)')
        assert.deepEqual(fillLinesOf({ ...base, source: 'round', retryInfo: [ri[1]] }), [], '全為輪末者不列')
        assert.deepEqual(fillLinesOf({ ...base, source: 'round', retryInfo: [] }), [])
        assert.deepEqual(fillLinesOf({ ...base, source: 'round' }), [], '未給 retryInfo(舊呼叫端)⇒ 不列、不拋錯')
        //與其他列並存之次序: 結果列、待補算列、其後為本列
        let all = fillLinesOf({ results: [{ nodeId: 'z1', postfit: 'ok', ext: { ok: [], failed: [] }, error: null, kind: null }], backlog: { postfit: ['q1'], ext: {} }, sec: 1, source: 'round', retryInfo: [ri[0]] })
        assert.equal(all.length, 3)
        assert(all[0].startsWith('附算(') && all[1].startsWith('待補算之成品') && all[2].startsWith('待重試而來源為命令列者 1 個'), JSON.stringify(all))
    })
})
