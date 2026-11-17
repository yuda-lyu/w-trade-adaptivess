import assert from 'assert'
import path from 'path'
import { loadLedger } from '../src/eval/ledger.mjs'
import { makeTmp, writeSynthLedger, makeTrainEvaluator as makeEvaluator } from './tools/synthLedger.mjs'
//makeEvaluator: 合成帳本即訓練期帳本 ⇒ makeTrainEvaluator 補上 L.ntStatic 再建評估器(見 test/tools/synthLedger.mjs)


//擴充診斷之 api.replaceNull 之「只替換一部分之席」(規則 R-EV-38; Gitea #160): onlyGroups(只換所列子帳之席, 其餘原樣)、onlyDecisions(只換遮罩內之決策之席, 遮罩外之決策給空選集)
//  合約 §7: 兩者皆未給時行為與回傳逐位不變; 某一個為「全部」(所列子帳涵蓋成品之全部子帳、或遮罩全為真)時等同只給另一個, 兩者皆為「全部」(或另一個未給)時各抽之選集與既有欄與未給時逐位相同;
//    給任一者時回傳另帶 applicable、obs(配對之成品值)、obsPnl / pnlMean / pnlSd; 成品未分帳而給 onlyGroups 者回 { applicable: false, reason };
//    參數不合者拋 invalid opt.onlyGroups / invalid opt.onlyDecisions: must be …(跨套件規格〈輸入參數之檢測機制〉§6 V19; 不帶輸入值 V20); 不改 S、階梯、selHash 與任何既有欄
//  內建物件被改時之行為(與既有之 api 函數一致)見 unit-evalIntegrity.test.mjs
const CFG = { warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [3, 7], nullDraws: 16, seed: 11 }
let IDS = [1, 4, 7, 10, 13, 16, 19, 22]
let GRP = [0, 0, 0, 1, 1, 1, 2, 2]
//成品: 8 席分三帳(子帳 0 三席、子帳 1 三席、子帳 2 兩席; 子帳 3 無席); 每次決策之名單平移一格
let pickG = (ctx) => ({ ids: IDS.map((s) => (s + ctx.k) % ctx.n), group: GRP, tag: ctx.k % 2 ? 'a' : 'b' })
//未分帳之成品(同名單)
let pickPlain = (ctx) => ({ ids: IDS.map((s) => (s + ctx.k) % ctx.n), tag: ctx.k % 2 ? 'a' : 'b' })
//spy, 記下 replaceNull 期間執行規則所見之每個訊號 [決策序, 策略序號, 子帳](擴充診斷於呼叫前後開關)
let spy = null
let accept = (sig, book) => {
    if (spy) {
        spy.push([sig.k, sig.sid, sig.group])
    }
    return book.open < 3
}
//runExt, 以一個擴充診斷跑一次完整評估; 診斷內之斷言失敗會被評估器記為 ext.<名>.error ⇒ 於此轉為測試失敗
let runExt = (ev, fn, pk = pickG) => {
    let m = ev.evalPolicy(pk, { accept, ext: [{ name: 'd', fn }] })
    assert.equal(m.ext.d.error, undefined, `擴充診斷拋錯: ${m.ext.d.error}`)
    return m
}
let msgOf = (fn) => {
    try {
        fn()
    }
    catch (err) {
        return err instanceof Error ? err.message : `非 Error: ${String(err)}`
    }
    return null
}
//OLD_KEYS, 未給新選項時之回傳欄(逐位不變之範圍)
let OLD_KEYS = ['draws', 'mean', 'sd', 'p', 'z', 'excess', 'thirdsMean']
let NEW_KEYS = ['applicable', 'obs', 'obsPnl', 'pnlMean', 'pnlSd']
let r4 = (x) => Math.round(x * 1e4) / 1e4
//zOk, z = (配對之成品值 − 各抽之均) / 標準差(sd = 0 時為 0); 回傳之 excess 與 sd 各取到四位小數, 故 z 須落在由兩者之捨入區間算出之範圍內(再留 1e-4 之捨入餘裕)
let zOk = (r) => {
    if (!(r.sd > 0)) {
        return r.z === 0
    }
    let c = []
    for (let de of [-5e-5, 5e-5]) {
        for (let ds of [-5e-5, 5e-5]) {
            c.push((r.excess + de) / (r.sd + ds))
        }
    }
    return r.z >= Math.min(...c) - 1e-4 && r.z <= Math.max(...c) + 1e-4
}
//spyOf, 於 fn 執行期間記錄執行規則所見之訊號
let spyOf = (fn) => {
    spy = []
    let r
    let seen
    try {
        r = fn()
    }
    finally {
        seen = spy
        spy = null
    }
    return { r, seen }
}
//segmentsOf, 把訊號序列依決策序遞減處分段(重放之次序: 各相位依序 { 各抽: 完整重放 + 三等分段之接續重放 }, 之後給 onlyDecisions 者另有各相位一次成品之遮罩重放)
let segmentsOf = (seen) => {
    let segs = []
    let last = Infinity
    let cur = null
    for (let s of seen) {
        if (s[0] < last) {
            cur = []
            segs.push(cur)
        }
        cur.push(s)
        last = s[0]
    }
    return segs
}
//replaysOf, 由訊號序列還原各相位各抽之完整重放所用之選集: out[ri][d] = Map(決策序 k → Map(策略序號 → 子帳)); extra = 其後之段(成品之遮罩重放)
//  僅適用 dense 帳本(每個被選之策略於其決策視窗內至少一個訊號 ⇒ 訊號之策略 = 選集); 段數不符即拋錯(防誤解析)
let replaysOf = (seen, nP, draws) => {
    let segs = segmentsOf(seen)
    let per = 2 //完整重放 + 三等分段之接續重放(各相位之決策數皆 ≥ 6)
    assert(segs.length >= nP * draws * per, `段數不足: ${segs.length}`)
    let mapOf = (seg) => {
        let m = new Map()
        for (let [k, sid, g] of seg) {
            if (!m.has(k)) {
                m.set(k, new Map())
            }
            m.get(k).set(sid, g)
        }
        return m
    }
    let out = []
    for (let ri = 0; ri < nP; ri++) {
        out.push([])
        for (let d = 0; d < draws; d++) {
            let m = mapOf(segs[(ri * draws + d) * per])
            //防誤解析: 同一抽同一相位之「三等分段之接續重放」用同一組選集 ⇒ 與完整重放之選集逐決策相同(次序錯位者必不同)
            let m3 = mapOf(segs[(ri * draws + d) * per + 1])
            assert.deepStrictEqual([...m3.keys()].sort((a, b) => a - b), [...m.keys()].sort((a, b) => a - b), `相位 ${ri} 抽 ${d}: 完整重放與三等分段之決策集合不同(分段誤解析?)`)
            for (let [k, sel] of m) {
                assert.deepStrictEqual([...m3.get(k)].sort((a, b) => a[0] - b[0]), [...sel].sort((a, b) => a[0] - b[0]), `相位 ${ri} 抽 ${d} 決策 ${k}: 完整重放與三等分段之選集不同(分段誤解析?)`)
            }
            out[ri].push(m)
        }
    }
    return { out, extra: segs.slice(nP * draws * per) }
}
//prodOf, 成品各相位各決策之選集 Map(策略序號 → 子帳; 未分帳者子帳 0)
let prodOf = (api) => api.phases.map((p) => p.sels.map((s, k) => new Map(Array.from(s, (sid, i) => [sid, p.groups[k] ? p.groups[k][i] : 0]))))

describe('擴充診斷之 api.replaceNull:只替換一部分之席(onlyGroups / onlyDecisions)', function () {
    let t
    let L
    let Ld
    let ev
    let ev1
    let evD
    let evD1
    before(() => {
        t = makeTmp('extReplacePart')
        writeSynthLedger(path.join(t.dir, 's'), { n: 60, nBars: 2400, seed: 5 })
        L = loadLedger(path.join(t.dir, 's'))
        ev = makeEvaluator(L, CFG)
        //單相位(執行規則所見之決策序即該相位之決策序)
        ev1 = makeEvaluator(L, { ...CFG, phases: [0] })
        //dense 帳本: 每隻策略逐棒進場 ⇒ 任一決策視窗內每個被選之策略皆有訊號, 可由訊號還原各抽之選集(逐席核對, 不只看統計值)
        writeSynthLedger(path.join(t.dir, 'd'), { n: 60, nBars: 2400, seed: 7, dense: true })
        Ld = loadLedger(path.join(t.dir, 'd'))
        evD = makeEvaluator(Ld, CFG)
        evD1 = makeEvaluator(Ld, { ...CFG, phases: [0] })
    })
    after(() => {
        spy = null
        t.cleanup()
    })

    it('皆未給時回傳之欄不變;遮罩全為真、所列子帳涵蓋成品之全部子帳(及兩者並用、搭配 actDays / 自訂分組)時,既有欄與各抽之選集(執行規則所見之逐訊號序列)與未給時逐位相同,另帶五個新欄', () => {
        runExt(ev, (api) => {
            let allD = api.phases.map((p) => p.bars.map(() => true))
            let g = api.geoGroups(2, 2)
            let cases = [{}, { actDays: 30 }, { grp: g.grp, nGroups: g.nGroups }, { half: 5 }]
            for (let base of cases) {
                let ra = spyOf(() => api.replaceNull({ draws: 8, ...base }))
                let a = ra.r
                assert.deepEqual(Object.keys(a), OLD_KEYS, '未給新選項: 回傳之欄與次序不變')
                assert(ra.seen.length > 100, '樣本不足')
                let vars = [
                    { onlyDecisions: allD },
                    { onlyDecisions: allD.map((ph) => Uint8Array.from(ph, () => 1)) },
                    { onlyGroups: [0, 1, 2] },
                    { onlyGroups: [0, 1, 2, 3] },
                    { onlyGroups: Uint8Array.from([2, 0, 1]) },
                    { onlyGroups: ['2', ' 0 ', 1, 1] },
                    { onlyGroups: Uint8Array.from([2, 0, 1]), onlyDecisions: allD },
                ]
                for (let v of vars) {
                    let rb = spyOf(() => api.replaceNull({ draws: 8, ...base, ...v }))
                    let b = rb.r
                    let w = `${JSON.stringify(Object.keys(v))} / ${JSON.stringify(Object.keys(base))}`
                    assert.deepEqual(Object.keys(b), [...OLD_KEYS, ...NEW_KEYS])
                    for (let k of OLD_KEYS) {
                        assert.deepStrictEqual(b[k], a[k], `${w} 之 ${k}`)
                    }
                    //各抽之選集逐位相同: 執行規則所見之訊號序列(決策序、策略序號、子帳)前段與未給時相同; 給 onlyDecisions 者其後多出成品本身之重放(配對之成品值)
                    assert.deepStrictEqual(rb.seen.slice(0, ra.seen.length), ra.seen, `${w}: 各抽之選集`)
                    if (!v.onlyDecisions) {
                        assert.strictEqual(rb.seen.length, ra.seen.length, `${w}: 只給 onlyGroups 不另行重放成品`)
                    }
                    assert.strictEqual(b.applicable, true)
                    assert.strictEqual(b.obs, api.obs.mean, `${w}: 配對之成品值 = 成品之相位平均(逐位; 不四捨五入)`)
                    assert(Number.isFinite(b.obsPnl) && Number.isFinite(b.pnlMean) && b.pnlSd >= 0)
                    //損益三欄皆為四位小數
                    for (let k of ['obsPnl', 'pnlMean', 'pnlSd']) {
                        assert.strictEqual(b[k], r4(b[k]), `${w}: ${k} 之四位小數`)
                    }
                    assert(zOk(b), `${w}: z = 超額 / 標準差`)
                }
            }
            return { text: 'ok' }
        })
    })

    it('onlyGroups:未列子帳之席原樣保留(其訊號之策略皆為成品該次決策之同子帳之席);所列子帳之席確被替換,且替換者不落在保留之席上;重複與次序不影響結果', () => {
        let m = ev1.evalPolicy(pickG, {
            accept,
            ext: [{
                name: 'd',
                fn: (api) => {
                    let ph = api.phases[0]
                    //各決策: 策略序號 → 成品之子帳
                    let gOf = ph.sels.map((s, k) => new Map(Array.from(s, (sid, i) => [sid, ph.groups[k][i]])))
                    for (let only of [[1], [0, 2], [2]]) {
                        let { r, seen } = spyOf(() => api.replaceNull({ draws: 6, onlyGroups: only }))
                        assert.strictEqual(r.applicable, true)
                        let kept = seen.filter((x) => !only.includes(x[2]))
                        let rep = seen.filter((x) => only.includes(x[2]))
                        assert(kept.length > 50 && rep.length > 50, `樣本不足: 保留 ${kept.length}、替換 ${rep.length}`)
                        assert(kept.every(([k, sid, g]) => gOf[k].get(sid) === g), `onlyGroups ${only}: 保留之席被換掉`)
                        assert(rep.some(([k, sid]) => !gOf[k].has(sid)), `onlyGroups ${only}: 所列子帳之席未被替換`)
                        assert(rep.every(([k, sid]) => {
                            let g0 = gOf[k].get(sid); return g0 === undefined || only.includes(g0)
                        }), `onlyGroups ${only}: 替換者落在保留之席上(同一選集重複)`)
                        //各抽不全同(確有隨機替換)
                        assert(r.sd > 0 && r.pnlSd > 0)
                    }
                    //重複與次序不影響結果
                    assert.deepStrictEqual(api.replaceNull({ draws: 4, onlyGroups: [2, 0, 2, 0] }), api.replaceNull({ draws: 4, onlyGroups: [0, 2] }))
                    return { text: 'ok' }
                }
            }]
        })
        assert.equal(m.ext.d.error, undefined, `擴充診斷拋錯: ${m.ext.d.error}`)
    })

    it('onlyGroups:成品只在部分決策分帳時,未分帳之決策其席皆屬子帳 0(列子帳 1 ⇒ 該決策全部原樣;列子帳 0 ⇒ 該決策全部替換)', () => {
        //奇數次決策不回傳 group(未分帳), 偶數次分三帳
        let pickMix = (ctx) => (ctx.k % 2 ? { ids: IDS.map((s) => (s + ctx.k) % ctx.n) } : { ids: IDS.map((s) => (s + ctx.k) % ctx.n), group: GRP })
        let m = ev1.evalPolicy(pickMix, {
            accept,
            ext: [{
                name: 'd',
                fn: (api) => {
                    let ph = api.phases[0]
                    assert(ph.groups.some((g) => g === null) && ph.groups.some((g) => g !== null))
                    let setOf = ph.sels.map((s) => new Set(s))
                    let a = spyOf(() => api.replaceNull({ draws: 6, onlyGroups: [1] }))
                    assert.strictEqual(a.r.applicable, true, '部分決策分帳 ⇒ 適用')
                    let odd = a.seen.filter(([k]) => ph.groups[k] === null)
                    assert(odd.length > 50 && odd.every(([k, sid, g]) => g === 0 && setOf[k].has(sid)), '列子帳 1: 未分帳之決策應全部原樣')
                    assert(a.seen.some(([k, sid, g]) => ph.groups[k] !== null && g === 1 && !setOf[k].has(sid)), '列子帳 1: 分帳之決策之子帳 1 應被替換')
                    let b = spyOf(() => api.replaceNull({ draws: 6, onlyGroups: [0] }))
                    let odd2 = b.seen.filter(([k]) => ph.groups[k] === null)
                    assert(odd2.length > 50 && odd2.some(([k, sid]) => !setOf[k].has(sid)), '列子帳 0: 未分帳之決策應被替換')
                    assert(b.seen.filter(([k, sid, g]) => ph.groups[k] !== null && g !== 0).every(([k, sid]) => setOf[k].has(sid)), '列子帳 0: 分帳之決策之其他子帳應原樣')
                    return { text: 'ok' }
                }
            }]
        })
        assert.equal(m.ext.d.error, undefined, `擴充診斷拋錯: ${m.ext.d.error}`)
    })

    it('onlyGroups:所列子帳於成品無席 ⇒ 各抽皆為成品本身(均 = 成品、標準差 0、超額 0);obs 與 api.obs.mean 逐位相同、obsPnl 與 simulate 之兩側損益和相符', () => {
        runExt(ev, (api) => {
            let r = api.replaceNull({ draws: 5, onlyGroups: [3] })
            assert.strictEqual(r.obs, api.obs.mean)
            assert.strictEqual(r.mean, r4(api.obs.mean))
            assert.strictEqual(r.sd, 0)
            assert.strictEqual(r.excess, 0)
            assert.strictEqual(r.z, 0)
            assert.strictEqual(r.p, 1)
            assert.strictEqual(r.pnlSd, 0)
            assert.strictEqual(r.pnlMean, r.obsPnl)
            let s = api.simulate(api.phases.map((p) => p.sels.map((x, k) => ({ ids: x, group: p.groups[k] }))), api.phases.map((p) => p.tags))
            assert(Math.abs(s.mean - api.obs.mean) < 1e-9)
            assert(Math.abs((s.bySide.long.pnl + s.bySide.short.pnl) - r.obsPnl) < 3e-4, `obsPnl ${r.obsPnl} vs simulate ${s.bySide.long.pnl + s.bySide.short.pnl}`)
            //損益之各抽(列子帳 1 ⇒ 部分之席被換): 與成品之差不為 0, 且各抽之均與標準差為有限數
            let q = api.replaceNull({ draws: 6, onlyGroups: [1] })
            assert(q.pnlSd > 0 && Number.isFinite(q.pnlMean) && q.pnlMean !== q.obsPnl)
            return { text: 'ok' }
        })
    })

    it('onlyDecisions:遮罩外之決策無任何訊號;配對之成品值 = 成品只留遮罩內決策之重放;p 對配對之成品值計;遮罩全為假 ⇒ 全為 0', () => {
        let m = ev1.evalPolicy(pickG, {
            accept,
            ext: [{
                name: 'd',
                fn: (api) => {
                    let ph = api.phases[0]
                    let mask = ph.bars.map((_, k) => k % 3 !== 1)
                    let { r, seen } = spyOf(() => api.replaceNull({ draws: 6, onlyDecisions: [mask] }))
                    //各抽之重放(訊號) + 其後成品只留遮罩內決策之重放: 遮罩外之決策皆無訊號
                    assert(seen.length > 100)
                    assert(seen.every(([k]) => mask[k]), '遮罩外之決策出現訊號')
                    let ks = new Set(seen.map((x) => x[0]))
                    assert(mask.filter(Boolean).length - ks.size <= 2, '遮罩內之決策大多應有訊號')
                    //配對之成品值: 以 simulate 重放「只留遮罩內決策」之成品
                    let s = api.simulate([ph.sels.map((x, k) => (mask[k] ? { ids: x, group: ph.groups[k] } : []))], [ph.tags])
                    assert(Math.abs(r.obs - s.mean) < 1e-9, `obs ${r.obs} vs simulate ${s.mean}`)
                    assert(Math.abs(r.obs - api.obs.mean) > 1e-6, '遮罩後之成品值應異於全體')
                    assert(Math.abs((s.bySide.long.pnl + s.bySide.short.pnl) - r.obsPnl) < 3e-4)
                    //超額 = 配對之成品值 − 各抽之均(取到四位小數)
                    assert(Math.abs(r.excess - r4(r.obs - r.mean)) <= 1.01e-4)
                    assert(r.sd > 0 && zOk(r), `z 應對配對之成品值計(z ${r.z}、超額 ${r.excess}、sd ${r.sd})`)
                    //0 / 1 之定型陣列亦可; 結果與布林相同
                    let r2 = api.replaceNull({ draws: 6, onlyDecisions: [Uint8Array.from(mask, (b) => (b ? 1 : 0))] })
                    assert.deepStrictEqual(r2, r)
                    //p 對配對之成品值計: 單抽時 p = (1 + [抽 ≥ 配對之成品值]) / 2(各抽之值以 mean 取代; 差距足夠大才比)
                    for (let mk of [mask, ph.bars.map((_, k) => k % 2 === 0), ph.bars.map((_, k) => k < 10), ph.bars.map((_, k) => k >= 10)]) {
                        let one = api.replaceNull({ draws: 1, onlyDecisions: [mk] })
                        assert.strictEqual(one.sd, 0)
                        if (Math.abs(one.obs - one.mean) > 1e-3) {
                            assert.strictEqual(one.p, one.mean >= one.obs ? 1 : 0.5, `p 應對配對之成品值計(obs ${one.obs}、抽 ${one.mean})`)
                        }
                    }
                    //全為假: 無選集 ⇒ 成品值與各抽皆 0
                    let z = spyOf(() => api.replaceNull({ draws: 4, onlyDecisions: [mask.map(() => false)] }))
                    assert.strictEqual(z.seen.length, 0)
                    assert.deepStrictEqual([z.r.obs, z.r.mean, z.r.sd, z.r.excess, z.r.obsPnl, z.r.pnlMean, z.r.pnlSd, z.r.p], [0, 0, 0, 0, 0, 0, 0, 1])
                    //並用: 遮罩外無訊號, 遮罩內未列子帳之席原樣
                    let gOf = ph.sels.map((x, k) => new Map(Array.from(x, (sid, i) => [sid, ph.groups[k][i]])))
                    let b = spyOf(() => api.replaceNull({ draws: 6, onlyGroups: [1], onlyDecisions: [mask] }))
                    assert(b.seen.length > 100 && b.seen.every(([k]) => mask[k]))
                    assert(b.seen.filter((x) => x[2] !== 1).every(([k, sid, g]) => gOf[k].get(sid) === g))
                    assert(b.seen.filter((x) => x[2] === 1).some(([k, sid]) => !gOf[k].has(sid)))
                    assert.strictEqual(b.r.obs, r.obs, '並用時配對之成品值只依決策遮罩')
                    return { text: 'ok' }
                }
            }]
        })
        assert.equal(m.ext.d.error, undefined, `擴充診斷拋錯: ${m.ext.d.error}`)
    })

    it('成品未分帳(含 group 全為 0):給 onlyGroups ⇒ 回 { applicable: false, reason }(不拋錯、不重放);只給 onlyDecisions 照常', () => {
        for (let pk of [pickPlain, (ctx) => ({ ...pickPlain(ctx), group: [0, 0, 0, 0, 0, 0, 0, 0] })]) {
            runExt(ev, (api) => {
                let { r, seen } = spyOf(() => api.replaceNull({ draws: 4, onlyGroups: [0] }))
                assert.deepStrictEqual(Object.keys(r), ['applicable', 'reason'])
                assert.strictEqual(r.applicable, false)
                assert(/未分帳/.test(r.reason))
                assert.strictEqual(seen.length, 0, '不適用時不應重放')
                //兩者並用而未分帳: 同樣不適用(不因給了 onlyDecisions 而重放)
                let allD = api.phases.map((p) => p.bars.map(() => true))
                let both = spyOf(() => api.replaceNull({ draws: 4, onlyGroups: [0], onlyDecisions: allD }))
                assert.strictEqual(both.r.applicable, false)
                assert.strictEqual(both.seen.length, 0)
                let a = api.replaceNull({ draws: 4 })
                let b = api.replaceNull({ draws: 4, onlyDecisions: allD })
                for (let k of OLD_KEYS) {
                    assert.deepStrictEqual(b[k], a[k])
                }
                assert.strictEqual(b.applicable, true)
                return { text: 'ok' }
            }, pk)
        }
    })

    it('參數不合者拋 invalid opt.onlyGroups / invalid opt.onlyDecisions: must be …(V19;位置帶索引;不帶輸入值;物件元素不取值);形狀之檢查先於「未分帳」之判定;null / undefined 視同未給', () => {
        let called = 0
        let boom = {
            valueOf() {
                called++
                throw new Error('不應取值 987654')
            },
            toString() {
                called++
                return '1'
            },
        }
        let G0 = /^invalid opt\.onlyGroups: must be a non-empty array or typed array of integers from 0 to 3$/
        let run = (pk) => runExt(ev, (api) => {
            let nd = api.phases.map((p) => p.bars.length)
            let ok = api.phases.map((p) => p.bars.map(() => true))
            //onlyGroups 整體不合(非陣列、空、類陣列、Set)
            for (let v of ['x', 987654, true, [], new Uint8Array(0), { 0: 1, length: 1 }, new Set([0]), new DataView(new ArrayBuffer(4)), () => [0]]) {
                let msg = msgOf(() => api.replaceNull({ draws: 2, onlyGroups: v }))
                assert(msg && G0.test(msg), `onlyGroups ${typeof v}: ${msg}`)
            }
            //onlyGroups 元素不合: 訊息帶索引(不帶值); iseint 不收 4、負數、小數與其字串、空字串、非數字字串、NaN、無限、超出安全整數、布林、null、undefined、BigInt、符號、物件
            let badE = [4, -1, 1.5, '1.5', 'x', '', ' ', NaN, Infinity, 2 ** 53, 987654, '987654', true, null, undefined, 1n, Symbol('s'), boom, {}, []]
            for (let x of badE) {
                for (let pos of [0, 2]) {
                    let arr = [0, 1, 2].slice(0, pos)
                    arr.push(x)
                    let msg = msgOf(() => api.replaceNull({ draws: 2, onlyGroups: arr }))
                    assert.strictEqual(msg, `invalid opt.onlyGroups[${pos}]: must be an integer from 0 to 3`, `元素 ${typeof x}@${pos}`)
                }
            }
            //定型陣列之元素(浮點非整數、超界)
            assert(/^invalid opt\.onlyGroups\[1\]: must be/.test(msgOf(() => api.replaceNull({ onlyGroups: Float64Array.from([0, 1.5]) }))))
            assert(/^invalid opt\.onlyGroups\[0\]: must be/.test(msgOf(() => api.replaceNull({ onlyGroups: Int32Array.from([4]) }))))
            assert.strictEqual(called, 0, '物件元素不被取值')
            //onlyDecisions 整體不合
            let D0 = 'invalid opt.onlyDecisions: must be an array with one array or typed array per phase of phases[]'
            for (let v of ['x', 987654, true, [], [ok[0]], [...ok, ok[0]], new Set(ok), { 0: ok[0], 1: ok[1], length: 2 }, new Uint8Array(2)]) {
                assert.strictEqual(msgOf(() => api.replaceNull({ draws: 2, onlyDecisions: v })), D0)
            }
            //各相位不合: 帶相位索引
            let P = (i) => `invalid opt.onlyDecisions[${i}]: must be an array or typed array with one entry per decision of phases[${i}]`
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyDecisions: ok.map((ph, i) => (i === 0 ? ph.slice(1) : ph)) })), P(0))
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyDecisions: ok.map((ph, i) => (i === 1 ? [...ph, true] : ph)) })), P(1))
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyDecisions: ok.map((ph, i) => (i === 1 ? 987654 : ph)) })), P(1))
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyDecisions: ok.map((ph, i) => (i === 0 ? null : ph)) })), P(0))
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyDecisions: ok.map((ph, i) => (i === 0 ? 'x'.repeat(nd[0]) : ph)) })), P(0))
            //元素不合: 帶相位與決策索引(只收 true / false / 1 / 0)
            for (let x of ['true', 'false', 2, -1, 0.5, null, undefined, NaN, boom, {}, [], 1n, '1', 987654]) {
                let msg = msgOf(() => api.replaceNull({ draws: 2, onlyDecisions: ok.map((ph, i) => (i === 1 ? ph.map((b, k) => (k === 2 ? x : b)) : ph)) }))
                assert.strictEqual(msg, 'invalid opt.onlyDecisions[1][2]: must be a boolean or 0 or 1', `元素 ${typeof x}`)
            }
            assert.strictEqual(called, 0, '物件元素不被取值')
            //兩者皆給而其一不合: 拋錯(不因成品未分帳而先回「不適用」; 兩者皆不合者先報 onlyGroups)
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyGroups: [0], onlyDecisions: [] })), D0)
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyGroups: [9], onlyDecisions: ok })), 'invalid opt.onlyGroups[0]: must be an integer from 0 to 3')
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyGroups: [9], onlyDecisions: [] })), 'invalid opt.onlyGroups[0]: must be an integer from 0 to 3')
            //訊息一律不帶輸入值
            for (let fnx of [() => api.replaceNull({ onlyGroups: [987654] }), () => api.replaceNull({ onlyDecisions: 987654 }), () => api.replaceNull({ onlyDecisions: ok.map((ph, i) => (i === 0 ? ph.map((b, k) => (k === 1 ? 987654 : b)) : ph)) })]) {
                assert(!/987654/.test(msgOf(fnx)))
            }
            //null / undefined 視同未給
            assert.deepEqual(Object.keys(api.replaceNull({ draws: 2, onlyGroups: null, onlyDecisions: undefined })), OLD_KEYS)
            assert.deepEqual(Object.keys(api.replaceNull({ draws: 2, onlyGroups: undefined, onlyDecisions: null })), OLD_KEYS)
            assert(nd.every((x) => x > 6))
            return { text: 'ok' }
        }, pk)
        run(pickG)
        run(pickPlain)
    })

    it('onlyGroups / onlyDecisions 各只讀一次(存取子計次);元素於比對之後才判定;不改呼叫端傳入之陣列', () => {
        runExt(ev, (api) => {
            let gets = { g: 0, d: 0 }
            let og = [0, 1, '2']
            let od = api.phases.map((p) => p.bars.map((_, k) => k % 2 === 0))
            let ogCopy = [...og]
            let odCopy = od.map((ph) => [...ph])
            let opts = {
                draws: 2,
                get onlyGroups() {
                    gets.g++
                    return og
                },
                get onlyDecisions() {
                    gets.d++
                    return od
                },
            }
            let r = api.replaceNull(opts)
            assert.strictEqual(r.applicable, true)
            assert.deepStrictEqual(gets, { g: 1, d: 1 })
            assert.deepStrictEqual(og, ogCopy)
            assert.deepStrictEqual(od, odCopy)
            return { text: 'ok' }
        })
    })

    it('逐席核對(dense 帳本,由訊號還原各抽之選集):onlyGroups(含並用 onlyDecisions)⇒ 未列子帳之席原樣、各子帳之席數不變、共 8 個相異之策略(替換者不與保留者或彼此重複)、所列子帳之席確被替換;遮罩外之決策無訊號', () => {
        runExt(evD1, (api) => {
            let prod = prodOf(api)[0]
            let nd = prod.length
            assert(nd >= 30)
            let mask = api.phases[0].bars.map((_, k) => k % 3 !== 1)
            for (let withMask of [false, true]) {
                for (let only of [[1], [0, 2], [2], [0], [1, 2], [0, 1, 2]]) {
                    let w = `onlyGroups ${only}${withMask ? ' + onlyDecisions' : ''}`
                    let { r, seen } = spyOf(() => api.replaceNull({ draws: 5, onlyGroups: only, ...(withMask ? { onlyDecisions: [mask] } : {}) }))
                    let { out, extra } = replaysOf(seen, 1, 5)
                    assert.strictEqual(extra.length, withMask ? 1 : 0, `${w}: 只給 onlyGroups 不另行重放成品`)
                    assert.strictEqual(r.applicable, true)
                    let replaced = 0
                    for (let d = 0; d < 5; d++) {
                        for (let k = 0; k < nd; k++) {
                            let m = out[0][d].get(k)
                            if (withMask && !mask[k]) {
                                assert(!m, `${w}: 抽 ${d} 遮罩外之決策 ${k} 出現訊號`)
                                continue
                            }
                            assert(m && m.size === 8, `${w}: 抽 ${d} 決策 ${k} 應有 8 個相異之策略(實 ${m && m.size})`)
                            for (let [sid, g] of prod[k]) {
                                if (!only.includes(g)) {
                                    assert.strictEqual(m.get(sid), g, `${w}: 抽 ${d} 決策 ${k} 之保留之席(策略 ${sid} 子帳 ${g})被換掉`)
                                }
                            }
                            for (let g = 0; g < 4; g++) {
                                let cnt = (mm) => [...mm.values()].filter((x) => x === g).length
                                assert.strictEqual(cnt(m), cnt(prod[k]), `${w}: 抽 ${d} 決策 ${k} 之子帳 ${g} 席數`)
                            }
                            for (let sid of m.keys()) {
                                if (!prod[k].has(sid)) {
                                    replaced++
                                }
                            }
                        }
                    }
                    assert(replaced > 30, `${w}: 所列子帳之席應被替換(實 ${replaced})`)
                }
            }
            return { text: 'ok' }
        })
    })

    it('逐席核對配對之鄰域(獨立重算):每個被替換之席之策略須與被替換者同組(預設 = 方向)且在其活躍度名次 ± half 內(各決策存在完全配對);未被替換之席與遮罩外之決策不涉及', () => {
        runExt(evD1, (api) => {
            let prod = prodOf(api)[0]
            let bars = api.phases[0].bars
            let n = api.n
            //獨立重算: 組 = 方向(mode > 0 為做多), 活躍度 = 決策棒以前之累計進場數, 同值依 tie 之名次(tie 取自 api.meta.tie)
            let tie = api.meta.tie
            let tieIdx = Array.from({ length: n }, (_, i) => i).sort((a, b) => (tie[a] - tie[b]) || (a - b))
            let tieRank = new Array(n)
            tieIdx.forEach((s, i) => {
                tieRank[s] = i
            })
            let side = (s) => (Ld.mode[s] > 0 ? 0 : 1)
            let order = (b) => {
                let cnt = (s) => {
                    let c = 0
                    for (let e = Ld.off[s]; e < Ld.off[s + 1]; e++) {
                        if (Ld.ent[e] < b) {
                            c++
                        }
                    }
                    return c
                }
                return Array.from({ length: n }, (_, s) => s).sort((x, y) => (side(x) - side(y)) || (cnt(x) - cnt(y)) || (tieRank[x] - tieRank[y]))
            }
            let nbhd = (ord, s, half) => {
                let p = ord.indexOf(s)
                let out = []
                for (let i = Math.max(0, p - half); i <= Math.min(n - 1, p + half); i++) {
                    if (side(ord[i]) === side(s)) {
                        out.push(ord[i])
                    }
                }
                return out
            }
            //是否存在完全配對(被替換者 → 其鄰域內互異之新策略; Kuhn 之擴充路徑)
            let matchable = (olds, news, nb) => {
                let owner = new Map()
                let tryAssign = (o, seenSet) => {
                    for (let v of nb.get(o)) {
                        if (!news.includes(v) || seenSet.has(v)) {
                            continue
                        }
                        seenSet.add(v)
                        if (!owner.has(v) || tryAssign(owner.get(v), seenSet)) {
                            owner.set(v, o)
                            return true
                        }
                    }
                    return false
                }
                return olds.every((o) => tryAssign(o, new Set()))
            }
            let mask = [bars.map((_, k) => k % 3 !== 1)]
            let cases = [
                { onlyGroups: [1], half: 2 },
                { onlyGroups: [0, 2], half: 1 },
                { onlyGroups: [0, 1, 2], half: 3 },
                { onlyDecisions: mask, half: 2 },
                { onlyGroups: [2], onlyDecisions: mask, half: 4 },
            ]
            for (let opt of cases) {
                let { seen } = spyOf(() => api.replaceNull({ draws: 4, ...opt }))
                let { out } = replaysOf(seen, 1, 4)
                let only = opt.onlyGroups || [0, 1, 2, 3]
                let nChecked = 0
                for (let d = 0; d < 4; d++) {
                    for (let k = 0; k < bars.length; k++) {
                        let m = out[0][d].get(k)
                        if (opt.onlyDecisions && !mask[0][k]) {
                            continue
                        }
                        let ord = order(bars[k])
                        let olds = [...prod[k].keys()].filter((s) => only.includes(prod[k].get(s)))
                        let kept = [...prod[k].keys()].filter((s) => !only.includes(prod[k].get(s)))
                        let news = [...m.keys()].filter((s) => !kept.includes(s))
                        assert.strictEqual(news.length, olds.length, `${JSON.stringify(opt.half)}: 抽 ${d} 決策 ${k} 之替換席數`)
                        let nb = new Map(olds.map((o) => [o, nbhd(ord, o, opt.half)]))
                        assert(matchable(olds, news, nb), `onlyGroups ${opt.onlyGroups} half ${opt.half}: 抽 ${d} 決策 ${k} 之替換者 ${news} 不在被替換者 ${olds} 之同組鄰域內`)
                        nChecked++
                    }
                }
                assert(nChecked > 100, `樣本不足 ${nChecked}`)
            }
            return { text: 'ok' }
        })
    })

    it('逐席核對:成品只在部分決策分帳時,未分帳之決策其席皆屬子帳 0(列子帳 1 ⇒ 該決策之選集原樣;列子帳 0 ⇒ 該決策之 8 席皆可被換)', () => {
        let pickMix = (ctx) => (ctx.k % 2 ? { ids: IDS.map((s) => (s + ctx.k) % ctx.n) } : { ids: IDS.map((s) => (s + ctx.k) % ctx.n), group: GRP })
        runExt(evD1, (api) => {
            let ph = api.phases[0]
            let prod = prodOf(api)[0]
            let nd = prod.length
            let plain = (k) => ph.groups[k] === null
            assert(ph.groups.some((g) => g === null) && ph.groups.some((g) => g !== null))
            let a = replaysOf(spyOf(() => api.replaceNull({ draws: 4, onlyGroups: [1] })).seen, 1, 4)
            let replacedPlain = 0
            let b = replaysOf(spyOf(() => api.replaceNull({ draws: 4, onlyGroups: [0] })).seen, 1, 4)
            for (let d = 0; d < 4; d++) {
                for (let k = 0; k < nd; k++) {
                    let ma = a.out[0][d].get(k)
                    let mb = b.out[0][d].get(k)
                    assert(ma && ma.size === 8 && mb && mb.size === 8, `決策 ${k} 應有 8 席`)
                    if (plain(k)) {
                        assert.deepStrictEqual([...ma].sort((x, y) => x[0] - y[0]), [...prod[k]].sort((x, y) => x[0] - y[0]), `列子帳 1: 未分帳之決策 ${k} 之選集應原樣`)
                        for (let sid of mb.keys()) {
                            if (!prod[k].has(sid)) {
                                replacedPlain++
                            }
                        }
                    }
                    else {
                        for (let [sid, g] of prod[k]) {
                            assert(g === 1 || ma.get(sid) === g, `列子帳 1: 決策 ${k} 之子帳 ${g} 之席應原樣`)
                            assert(g === 0 || mb.get(sid) === g, `列子帳 0: 決策 ${k} 之子帳 ${g} 之席應原樣`)
                        }
                    }
                }
            }
            assert(replacedPlain > 20, `列子帳 0: 未分帳之決策應被替換(實 ${replacedPlain})`)
            return { text: 'ok' }
        }, pickMix)
    })

    it('逐席核對:onlyDecisions ⇒ 遮罩外之決策無任何訊號(各抽與成品之遮罩重放皆然)、遮罩內之決策各 8 個相異之策略且確被替換;成品之遮罩重放之選集 = 成品該次之選集', () => {
        runExt(evD1, (api) => {
            let prod = prodOf(api)[0]
            let nd = prod.length
            let mask = api.phases[0].bars.map((_, k) => k % 3 !== 1)
            let { seen } = spyOf(() => api.replaceNull({ draws: 4, onlyDecisions: [mask] }))
            let { out, extra } = replaysOf(seen, 1, 4)
            assert.strictEqual(extra.length, 1, '其後為成品之遮罩重放(一個相位)')
            let replaced = 0
            for (let d = 0; d < 4; d++) {
                for (let k = 0; k < nd; k++) {
                    let m = out[0][d].get(k)
                    if (!mask[k]) {
                        assert(!m, `抽 ${d} 遮罩外之決策 ${k} 出現訊號`)
                        continue
                    }
                    assert(m && m.size === 8, `抽 ${d} 遮罩內之決策 ${k} 應有 8 個相異之策略`)
                    for (let sid of m.keys()) {
                        if (!prod[k].has(sid)) {
                            replaced++
                        }
                    }
                }
            }
            assert(replaced > 50, `遮罩內之決策之席應被替換(實 ${replaced})`)
            //成品之遮罩重放: 遮罩外無訊號; 遮罩內之選集 = 成品該次之選集(含子帳)
            let m0 = new Map()
            for (let [k, sid, g] of extra[0]) {
                if (!m0.has(k)) {
                    m0.set(k, new Map())
                }
                m0.get(k).set(sid, g)
            }
            for (let k = 0; k < nd; k++) {
                if (mask[k]) {
                    assert.deepStrictEqual([...m0.get(k)].sort((x, y) => x[0] - y[0]), [...prod[k]].sort((x, y) => x[0] - y[0]), `成品之遮罩重放: 決策 ${k}`)
                }
                else {
                    assert(!m0.has(k), `成品之遮罩重放: 遮罩外之決策 ${k} 出現訊號`)
                }
            }
            return { text: 'ok' }
        })
    })

    it('某一個選項為「全部」時等同只給另一個;兩者皆為「全部」時等同皆未給(各抽之選集逐位相同、既有欄與新欄相同);「部分」者與未給確實不同(防比較空轉)', () => {
        runExt(evD1, (api) => {
            let allD = [api.phases[0].bars.map(() => true)]
            let mask = [api.phases[0].bars.map((_, k) => k % 3 !== 1)]
            let run = (opt) => spyOf(() => api.replaceNull({ draws: 4, ...opt }))
            let base = run({})
            let gOnly = run({ onlyGroups: [1] })
            let dOnly = run({ onlyDecisions: mask })
            //onlyDecisions 為全部 ⇒ 等同只給 onlyGroups: 回傳全相同; 各抽之選集相同(其後多出成品本身之重放)
            let x = run({ onlyGroups: [1], onlyDecisions: allD })
            assert.deepStrictEqual(x.r, gOnly.r)
            assert.deepStrictEqual(x.seen.slice(0, gOnly.seen.length), gOnly.seen)
            //onlyGroups 涵蓋全部子帳 ⇒ 等同只給 onlyDecisions: 回傳與全部訊號(含遮罩重放)皆相同
            let y = run({ onlyGroups: [0, 1, 2, 3], onlyDecisions: mask })
            assert.deepStrictEqual(y.r, dOnly.r)
            assert.deepStrictEqual(y.seen, dOnly.seen)
            //兩者皆為全部 ⇒ 等同皆未給
            let z = run({ onlyGroups: [0, 1, 2], onlyDecisions: allD })
            for (let k of OLD_KEYS) {
                assert.deepStrictEqual(z.r[k], base.r[k], k)
            }
            assert.deepStrictEqual(z.seen.slice(0, base.seen.length), base.seen)
            //「部分」者與未給不同
            assert.notDeepStrictEqual(gOnly.seen, base.seen)
            assert.notStrictEqual(gOnly.r.mean, base.r.mean)
            assert.notStrictEqual(dOnly.r.mean, base.r.mean)
            return { text: 'ok' }
        })
    })

    it('獨立重算(多相位;onlyGroups、onlyDecisions、並用、所列子帳無席):各抽之選集(由訊號還原)交 simulate 重放,其等效年化、損益與三等分段之均 / 標準差 / p / z / excess / pnlMean / pnlSd / thirdsMean / obs / obsPnl 與回傳相符', () => {
        runExt(evD, (api) => {
            let nP = api.phases.length
            assert.strictEqual(nP, 2)
            let tags = api.phases.map((p) => p.tags)
            let avg = (a) => a.reduce((s, v) => s + v, 0) / a.length
            let sdOf = (a) => Math.sqrt(avg(a.map((v) => (v - avg(a)) ** 2)))
            let pnlOf = (s) => s.bySide.long.pnl + s.bySide.short.pnl
            let M1 = api.phases.map((p) => p.bars.map((_, k) => k % 3 !== 1))
            let M2 = api.phases.map((p, i) => p.bars.map((_, k) => (i === 0 ? k % 2 === 0 : k > 2)))
            let DRAWS = 4
            for (let [nm, opt] of [['onlyGroups', { onlyGroups: [1] }], ['onlyDecisions', { onlyDecisions: M1 }], ['並用', { onlyGroups: [0, 2], onlyDecisions: M2 }], ['無席', { onlyGroups: [3] }]]) {
                let { r, seen } = spyOf(() => api.replaceNull({ draws: DRAWS, ...opt }))
                let { out, extra } = replaysOf(seen, nP, DRAWS)
                let mask = opt.onlyDecisions || null
                assert.strictEqual(extra.length, mask ? nP : 0, nm)
                let sims = []
                for (let d = 0; d < DRAWS; d++) {
                    let sels = api.phases.map((p, ri) => p.bars.map((_, k) => {
                        let m = out[ri][d].get(k)
                        if (mask && !mask[ri][k]) {
                            assert(!m, `${nm}: 遮罩外之決策出現訊號`)
                            return []
                        }
                        assert(m && m.size === 8, `${nm}: 相位 ${ri} 抽 ${d} 決策 ${k} 應有 8 個相異之策略`)
                        let ids = [...m.keys()].sort((a, b) => a - b)
                        return { ids, group: ids.map((s) => m.get(s)) }
                    }))
                    sims.push(api.simulate(sels, tags))
                }
                let eq = sims.map((s) => s.mean)
                let pn = sims.map(pnlOf)
                //配對之成品值: 成品(只留遮罩內決策)之重放
                let prodSel = api.phases.map((p, ri) => p.sels.map((x, k) => (mask && !mask[ri][k] ? [] : { ids: x, group: p.groups[k] })))
                let sp = api.simulate(prodSel, tags)
                assert(Math.abs(r.obs - sp.mean) < 1e-9, `${nm}: obs ${r.obs} vs ${sp.mean}`)
                assert(Math.abs(r.obsPnl - pnlOf(sp)) < 3e-4, `${nm}: obsPnl`)
                if (!mask) {
                    assert.strictEqual(r.obs, api.obs.mean)
                }
                assert(Math.abs(r.mean - r4(avg(eq))) <= 1.01e-4, `${nm}: mean`)
                assert(Math.abs(r.sd - r4(sdOf(eq))) <= 1.01e-4, `${nm}: sd`)
                assert.strictEqual(r.p, r4((1 + eq.filter((v) => v >= r.obs).length) / (1 + DRAWS)), `${nm}: p`)
                assert(Math.abs(r.excess - r4(r.obs - avg(eq))) <= 1.01e-4, `${nm}: excess`)
                assert(zOk(r), `${nm}: z`)
                assert(Math.abs(r.pnlMean - avg(pn)) < 3e-4, `${nm}: pnlMean ${r.pnlMean} vs ${avg(pn)}`)
                assert(Math.abs(r.pnlSd - sdOf(pn)) < 5e-4, `${nm}: pnlSd ${r.pnlSd} vs ${sdOf(pn)}`)
                for (let g = 0; g < 3; g++) {
                    let th = avg(sims.map((s) => s.thirds[g]))
                    assert(Math.abs(r.thirdsMean[g] - th) <= 1.01e-4, `${nm}: thirdsMean[${g}] ${r.thirdsMean[g]} vs ${th}`)
                }
                if (nm !== '無席') {
                    assert(r.sd > 0 && r.pnlSd > 0, `${nm}: 各抽應不全同`)
                }
            }
            return { text: 'ok' }
        })
    })

    it('形狀以內部槽判定、不經迭代器:DataView(含偽造之 length 與索引)、自訂迭代器之陣列、已分離之定型陣列、類陣列物件不被當作陣列;代理之 length 只讀一次;訊息一律為 V19 格式', () => {
        let G0 = 'invalid opt.onlyGroups: must be a non-empty array or typed array of integers from 0 to 3'
        runExt(ev, (api) => {
            let nd = api.phases.map((p) => p.bars.length)
            let ok = api.phases.map((p) => p.bars.map(() => true))
            let P = (i) => `invalid opt.onlyDecisions[${i}]: must be an array or typed array with one entry per decision of phases[${i}]`
            //DataView(含偽造之 length 與 0 號元素)
            let dv = new DataView(new ArrayBuffer(4))
            dv.length = 1
            dv[0] = 1
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyGroups: dv })), G0)
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyDecisions: ok.map((ph, i) => (i === 0 ? dv : ph)) })), P(0))
            let dv0 = new DataView(new ArrayBuffer(0))
            dv0.length = nd[0]
            for (let k = 0; k < nd[0]; k++) {
                dv0[k] = true
            }
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyDecisions: ok.map((ph, i) => (i === 0 ? dv0 : ph)) })), P(0))
            //自訂迭代器: 不被呼叫; 以實際之 length 與索引判定(length 不符 ⇒ 拒收; 相符 ⇒ 取索引之值)
            let called = 0
            let it1 = [true]
            it1[Symbol.iterator] = function* () {
                called++
                for (let i = 0; i < nd[0]; i++) {
                    yield true
                }
            }
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyDecisions: ok.map((ph, i) => (i === 0 ? it1 : ph)) })), P(0))
            let it2 = [0, 1]
            it2[Symbol.iterator] = function* () {
                called++
                yield 3
            }
            assert.deepStrictEqual(api.replaceNull({ draws: 2, onlyGroups: it2 }), api.replaceNull({ draws: 2, onlyGroups: [0, 1] }))
            assert.strictEqual(called, 0, '迭代器不被呼叫')
            //已分離之定型陣列(長度為 0): 以一般之訊息拒收, 不拋引擎之 TypeError
            let det = Uint8Array.from([0, 1])
            structuredClone(det.buffer, { transfer: [det.buffer] })
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyGroups: det })), G0)
            let det2 = Uint8Array.from(ok[1])
            structuredClone(det2.buffer, { transfer: [det2.buffer] })
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyDecisions: ok.map((ph, i) => (i === 1 ? det2 : ph)) })), P(1))
            //定型陣列以內部槽取長度(自有之 length 屬性不影響)
            let ta = Uint8Array.from([0, 1])
            Object.defineProperty(ta, 'length', { value: 5 })
            assert.deepStrictEqual(api.replaceNull({ draws: 2, onlyGroups: ta }), api.replaceNull({ draws: 2, onlyGroups: [0, 1] }))
            //類陣列物件、偽造原型之物件、外層為定型陣列
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyGroups: { length: 1, 0: 1 } })), G0)
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyGroups: Object.setPrototypeOf({ length: 1, 0: 1 }, Uint8Array.prototype) })), G0)
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyDecisions: new Uint8Array(nd.length) })), 'invalid opt.onlyDecisions: must be an array with one array or typed array per phase of phases[]')
            //讀取拋錯(已撤銷之代理、拋錯之存取子)即無效(跨套件規格 V11): 以 V19 訊息拒收, 不透傳引擎或模組之錯誤
            let rv = Proxy.revocable([0, 1], {})
            rv.revoke()
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyGroups: rv.proxy })), G0)
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyDecisions: rv.proxy })), 'invalid opt.onlyDecisions: must be an array with one array or typed array per phase of phases[]')
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyDecisions: ok.map((ph, i) => (i === 0 ? rv.proxy : ph)) })), P(0))
            assert.strictEqual(msgOf(() => api.replaceNull({
                get onlyGroups() {
                    throw new Error('boom')
                },
            })), G0)
            assert.strictEqual(msgOf(() => api.replaceNull({
                get onlyDecisions() {
                    throw new Error('boom')
                },
            })), 'invalid opt.onlyDecisions: must be an array with one array or typed array per phase of phases[]')
            //稀疏陣列之洞視為 undefined(不沿原型鏈取值): 元素不合 ⇒ V19(帶索引)
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyGroups: new Array(2) })), 'invalid opt.onlyGroups[0]: must be an integer from 0 to 3')
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyDecisions: ok.map((ph, i) => (i === 0 ? new Array(nd[0]) : ph)) })), 'invalid opt.onlyDecisions[0][0]: must be a boolean or 0 or 1')
            //超長之形狀錯誤不逐索引讀取(外層長於相位數、內層長於決策數): 代理之索引讀取與自有性查詢皆為 0 次
            let reads = 0
            let big = (len) => new Proxy(new Array(len), {
                get(t, p, rcv) {
                    if (typeof p === 'string' && /^\d+$/.test(p)) {
                        reads++
                    }
                    return Reflect.get(t, p, rcv)
                },
                getOwnPropertyDescriptor(t, p) {
                    reads++
                    return Reflect.getOwnPropertyDescriptor(t, p)
                },
            })
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyDecisions: big(100000) })), 'invalid opt.onlyDecisions: must be an array with one array or typed array per phase of phases[]')
            assert.strictEqual(msgOf(() => api.replaceNull({ onlyDecisions: ok.map((ph, i) => (i === 0 ? big(100000) : ph)) })), P(0))
            assert.strictEqual(reads, 0, '超長之形狀錯誤不逐索引讀取')
            //代理(Array)之 length 只讀一次; 結果與一般陣列相同
            let n = 0
            let px = new Proxy([0, 1], {
                get(t, p, rcv) {
                    if (p === 'length') {
                        n++
                    }
                    return Reflect.get(t, p, rcv)
                },
            })
            assert.deepStrictEqual(api.replaceNull({ draws: 2, onlyGroups: px }), api.replaceNull({ draws: 2, onlyGroups: [0, 1] }))
            assert.strictEqual(n, 1, '代理之 length 只讀一次')
            return { text: 'ok' }
        })
    })

    it('於執行規則(accept)之內呼叫 api.replaceNull ⇒ 依合約拋重入之錯誤(含成品未分帳而給 onlyGroups 之短路);既有 grp 之檢查先於新選項', () => {
        for (let pk of [pickG, pickPlain]) {
            runExt(ev, (api) => {
                let sels = api.phases.map((p) => p.sels)
                let mask = api.phases.map((p) => p.bars.map((_, k) => k % 2 === 0))
                let msgs = []
                for (let call of [() => api.replaceNull({ draws: 1, onlyGroups: [0] }), () => api.replaceNull({ draws: 1 }), () => api.replaceNull({ draws: 1, onlyDecisions: mask })]) {
                    let msg = null
                    let i = 0
                    api.simulate(sels, null, {
                        accept: () => {
                            if (++i === 3) {
                                msg = msgOf(call)
                            }
                            return true
                        },
                    })
                    msgs.push(msg)
                }
                assert(msgs.every((m) => m && /重入/.test(m)), JSON.stringify(msgs))
                //grp 之既有檢查先於新選項(訊息自排程第 497 項起依 V19; 原為中文之 replaceNull: grp 須為…); grp 合法者再依新選項(V19)
                assert(/^invalid opt\.grp: must be /.test(msgOf(() => api.replaceNull({ grp: [0], nGroups: 1, onlyGroups: [] }))))
                assert.strictEqual(msgOf(() => api.replaceNull({ grp: new Array(api.n).fill(0), nGroups: 1, onlyGroups: [] })), 'invalid opt.onlyGroups: must be a non-empty array or typed array of integers from 0 to 3')
                return { text: 'ok' }
            }, pk)
        }
    })

    it('既有呼叫端(nullSideActOf / nullSideGeoOf)之回傳形狀不變:可列舉之鍵不含 pnl(數值之回歸由 unit-evalCore 與全套之既有數字守住)', () => {
        let runs = null
        ev.evalPolicy(pickG, {
            accept,
            onRuns: (r) => {
                runs = r
            },
        })
        assert(runs && runs.length === 2)
        let a = ev.nullSideActOf(runs, accept, 3, 123, 5)
        let b = ev.nullSideGeoOf(runs, accept, 3, 123, 5, 2, 2)
        assert.deepStrictEqual(Object.keys(a), ['0', '1', '2', 'comp', 'thirds'])
        assert.deepStrictEqual(Object.keys(b), ['0', '1', '2', 'comp', 'thirds'])
        assert.strictEqual(a.pnl, undefined)
        assert.strictEqual(b.pnl, undefined)
    })

    it('用到新選項之擴充診斷不改任何既有數字與 selHash;輸出可序列化;同選項重跑結果相同', () => {
        let base = ev.evalPolicy(pickG, { accept })
        let diag = (api) => {
            let mask = api.phases.map((p) => p.bars.map((_, k) => k % 2 === 0))
            return { text: 'ok', a: api.replaceNull({ draws: 4, onlyGroups: [0] }), b: api.replaceNull({ draws: 4, onlyDecisions: mask }), c: api.replaceNull({ draws: 4, onlyGroups: [1, 2], onlyDecisions: mask, actDays: 30 }) }
        }
        let m = runExt(ev, diag)
        assert.equal(m.selHash, base.selHash)
        assert.deepEqual(m.op, base.op)
        assert.deepEqual(m.null, base.null)
        assert.deepEqual(m.fresh, base.fresh)
        for (let k of ['a', 'b', 'c']) {
            assert.deepEqual(Object.keys(m.ext.d[k]), [...OLD_KEYS, ...NEW_KEYS], k)
            assert.deepEqual(JSON.parse(JSON.stringify(m.ext.d[k])), m.ext.d[k])
        }
        //同一設定重跑: 結果相同(亂數只依種子與選項)
        let m2 = runExt(ev, diag)
        let strip = (o) => {
            let { ms, ...rest } = o; return rest
        }
        assert.deepEqual(strip(m2.ext.d), strip(m.ext.d))
    })
})
