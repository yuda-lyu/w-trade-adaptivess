import assert from 'assert'
import { loadLedger } from '../src/eval/ledger.mjs'
import { makeTmp, writeSynthLedger, makeTrainEvaluator as makeEvaluator } from './tools/synthLedger.mjs'
//makeEvaluator: 合成帳本即訓練期帳本 ⇒ makeTrainEvaluator 補上 L.ntStatic 再建評估器(見 test/tools/synthLedger.mjs)


//擴充診斷之既有 api.simulate / api.summarize / api.replaceNull 之輸入(排程第 497 項; 規則 R-EV-38、R-EV-35 ②; 跨套件規格〈輸入參數之檢測機制〉§6 V19、V20)
//  ① 複本之種類: simulate 之各層陣列與選集之 ids / group(陣列、定型陣列、Set)、summarize 之 vals / vals.thirds、replaceNull 之 grp(陣列或定型陣列)—— 合法輸入之結果與改寫前逐位相同; 其他種類(可迭代物、類陣列、原始值)拒收
//  ② 錯誤訊息: 原中文訊息(simulate: …、replaceNull: grp 須為…)改為 invalid <名稱>: must be <種類>(英文、指明名稱與期望、不帶輸入值); 形狀不合者於比對內建物件之後才拋(比對不被跳過)
//  ③ 迭代器: 複本不經可被改寫之迭代器(替身之偵測見 unit-evalIntegrity.test.mjs 同名案)
const CFG = { warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [3, 7], nullDraws: 8, seed: 11 }
let IDS = [1, 4, 7, 10, 13, 16, 19, 22]
let GRP = [0, 0, 0, 1, 1, 1, 2, 2]
let pickG = (ctx) => ({ ids: IDS.map((s) => (s + ctx.k) % ctx.n), group: GRP, tag: ctx.k % 2 ? 'a' : 'b' })
let accept = (sig, book) => book.open < 4
//runExt, 以一個擴充診斷跑一次完整評估; 診斷內之斷言失敗會被評估器記為 ext.<名>.error ⇒ 於此轉為測試失敗
let runExt = (ev, fn, pk = pickG) => {
    let m = ev.evalPolicy(pk, { accept, ext: [{ name: 'd', fn }] })
    assert.strictEqual(m.ext.d.error, undefined, `擴充診斷拋錯: ${m.ext.d.error}`)
    return m
}
let errOf = (fn) => {
    try {
        fn()
    }
    catch (err) {
        return err
    }
    return null
}
let msgOf = (fn) => {
    let err = errOf(fn)
    return err === null ? null : (err instanceof Error ? err.message : `非 Error: ${String(err)}`)
}
let CJK = /[㐀-鿿]/
let json = (x) => JSON.stringify(x)
//setIndexOf / tamperIndexOf, 以屬性描述寫入 Array.prototype.indexOf(受保護清單內之內建方法; 行為不變之替身, 只用來使「內建物件被改」成立; 測後一律以 setIndexOf(原函數) 還原)
//oneGen / threeOne, 新建一個產生器物件(可迭代物之樣本)
let oneGen = () => (function* () {
    yield 1
})()
let threeOne = () => (function* () {
    yield 3
    yield 1
})()
let AP = Array.prototype
let setIndexOf = (fn) => Object.defineProperty(AP, 'indexOf', { value: fn, writable: true, configurable: true, enumerable: false })
let tamperIndexOf = (saved) => setIndexOf(function (...args) {
    return Reflect.apply(saved, this, args)
})
//boomObj, 讀任何屬性(含 length)即拋錯之代理 / 只讀取 length 即拋錯之代理
let boomProxy = (target, onlyLength = false) => new Proxy(target, {
    get(tg, k, rc) {
        if (onlyLength && k !== 'length') {
            return Reflect.get(tg, k, rc)
        }
        throw new Error('BOOM')
    },
})

describe('擴充診斷 api.simulate / api.summarize / api.replaceNull 之輸入:複本之種類與錯誤訊息(排程第 497 項)', function () {
    let t
    let ev
    before(() => {
        t = makeTmp('extApiInput')
        writeSynthLedger(t.dir, { n: 60, nBars: 2400, seed: 6 })
        ev = makeEvaluator(loadLedger(t.dir), CFG)
    })
    after(() => {
        t.cleanup()
    })

    it('api.simulate:合法之選集(陣列 / 定型陣列 / Set / 物件形式之 ids 與 group)之結果彼此逐位相同, 且與改寫前相同之作法(成品自己之選集)重放 = api.obs', () => {
        runExt(ev, (api) => {
            let ref = (f) => api.phases.map((p) => p.sels.map(f))
            let arrs = ref((s) => Array.from(s))
            let base = json(api.simulate(arrs))
            assert.equal(json(api.simulate(ref((s) => Int32Array.from(s)))), base, '定型陣列')
            assert.equal(json(api.simulate(ref((s) => new Set(s)))), base, 'Set')
            assert.equal(json(api.simulate(ref((s) => Uint16Array.from(s)))), base, '另一種定型陣列')
            //spec(合約 §7): simulate 以成品之執行規則重放另一組選集 —— 給成品自己之選集 ⇒ 與成品之等效年化(api.obs)相同
            assert.equal(api.simulate(arrs).mean, api.obs.mean)
            assert.deepEqual(api.simulate(arrs).byPhase, api.obs.byPhase)
            //物件形式: ids 與 group 各為陣列 / 定型陣列 / Set(Set 依插入序走訪: ids 與 group 逐位對應)
            let ids = ref((s) => Array.from(s).slice(0, 3))
            let grp = ref((s) => [2, 0, 1].slice(0, Math.min(3, s.length)))
            let mk = (pi, k, f, g) => ({ ids: f(ids[pi][k]), group: g(grp[pi][k]) })
            let objsA = ids.map((ph, pi) => ph.map((x, k) => mk(pi, k, (v) => v, (v) => v)))
            let objsT = ids.map((ph, pi) => ph.map((x, k) => mk(pi, k, (v) => Int32Array.from(v), (v) => Uint8Array.from(v))))
            let objsS = ids.map((ph, pi) => ph.map((x, k) => mk(pi, k, (v) => new Set(v), (v) => new Set(v))))
            let a = json(api.simulate(objsA))
            assert.equal(json(api.simulate(objsT)), a, '物件形式(定型陣列)')
            assert.equal(json(api.simulate(objsS)), a, '物件形式(Set)')
            //group 不同 ⇒ 結果不同(group 確實被讀入: 子帳之歸因列不同)
            let objsB = ids.map((ph, pi) => ph.map((x, k) => ({ ids: x, group: [0, 0, 0].slice(0, x.length) })))
            assert.notEqual(json(api.simulate(objsB).byGroup), json(api.simulate(objsA).byGroup))
            //tagsByPhase(陣列 → 逐元素取快照): 不同之 tag 交給 accept
            let seen = []
            api.simulate(arrs, api.phases.map((p) => p.sels.map((s, k) => `T${k % 3}`)), {
                accept: (sig) => {
                    seen.push(sig.tag)
                    return true
                },
            })
            assert(seen.length > 0 && seen.every((x) => /^T[012]$/.test(x)), json(seen.slice(0, 5)))
            //tagsByPhase 之某相位不是陣列(null / undefined 等)⇒ 該相位用成品之 tag(原行為); 全給成品之 tag 者與未給相同
            let prodTags = api.phases.map((p) => p.tags)
            assert.equal(json(api.simulate(arrs, [null, undefined])), base, '各相位皆非陣列 = 未給')
            assert.equal(json(api.simulate(arrs, [null, prodTags[1]])), base, '第 0 相位非陣列、第 1 相位給成品之 tag')
            assert.equal(json(api.simulate(arrs, prodTags)), base, '各相位給成品之 tag')
            //分帳(R-EV-27): 元素為 { ids, group } 者一律照用其 group(含全為 0 = 全部歸子帳 0); 未給 group 者沿用成品同一決策之分帳(成品有 3 個子帳)
            let zeroG = arrs.map((ph) => ph.map((x) => ({ ids: x, group: x.map(() => 0) })))
            assert.equal(api.simulate(zeroG).byGroup.length, 1, '明給全 0 ⇒ 只有子帳 0 一列')
            assert(api.simulate(arrs).byGroup.length > 1, '未給 group ⇒ 沿用成品之分帳(多列)')
            //tag 於取得時取快照並凍結(合約 §1; 同挑選函數之 tag): 重放後再改原物件, accept 所見不變
            let tagObj = { k: 1 }
            let frozen = []
            api.simulate(arrs, api.phases.map((p) => p.sels.map(() => tagObj)), {
                accept: (sig) => {
                    frozen.push(Object.isFrozen(sig.tag) && sig.tag !== tagObj)
                    return true
                },
            })
            assert(frozen.length > 0 && frozen.every((x) => x === true), '重放時 accept 所見之 tag 為凍結之快照, 非呼叫端之原物件')
            return { text: 'ok' }
        })
    })

    it('api.simulate 之輸入錯誤:訊息為 invalid <名稱>: must be <種類>(英文、不帶輸入值); 位置帶索引', () => {
        runExt(ev, (api) => {
            let okA = api.phases.map((p) => p.sels.map((s) => Array.from(s)))
            let want = (fn, msg, w) => {
                let m = msgOf(fn)
                assert.strictEqual(m, msg, w)
                assert(!CJK.test(m), `${w}: 英文`)
                assert(!/MARKER|98765/.test(m), `${w}: 不帶輸入值`)
            }
            want(() => api.simulate('MARKER'), 'invalid selsByPhase: must be an array with one entry per phase of phases[]', '非陣列')
            want(() => api.simulate([okA[0]]), 'invalid selsByPhase: must be an array with one entry per phase of phases[]', '相位數不同')
            want(() => api.simulate([5, okA[1]]), 'invalid selsByPhase[0]: must be an array with one entry per decision of phases[0]', '相位之元素非陣列')
            want(() => api.simulate([okA[0], okA[1].slice(1)]), 'invalid selsByPhase[1]: must be an array with one entry per decision of phases[1]', '決策數不同')
            want(() => api.simulate(okA, null, { accept: 'MARKER' }), 'invalid opts.accept: must be a function (sig, book) => boolean', 'opts.accept')
            want(() => api.simulate(okA, null, { orderSalt: 98765.5 }), 'invalid opts.orderSalt: must be an integer (0 for the order of the product itself)', 'opts.orderSalt 小數')
            want(() => api.simulate(okA, null, { orderSalt: '98765' }), 'invalid opts.orderSalt: must be an integer (0 for the order of the product itself)', 'opts.orderSalt 數字字串')
            //檢查之先後同原寫法: 結構(相位數、相位內之決策數)→ opts.accept → opts.orderSalt → 各相位
            want(() => api.simulate(okA, null, { accept: 5, orderSalt: 1.5 }), 'invalid opts.accept: must be a function (sig, book) => boolean', 'accept 先於 orderSalt')
            //元素之種類(排程第 497 項: 只收陣列、定型陣列、Set 與其物件形式; 其他種類不經迭代器複製, 拒收)
            let bad = (el) => {
                let a = okA.map((ph) => ph.slice())
                a[1][2] = el
                return a
            }
            let sel = 'invalid selsByPhase[1][2]: must be an array, a typed array or a Set of strategy indexes, or an object with ids'
            want(() => api.simulate(bad(null)), sel, 'null')
            want(() => api.simulate(bad(undefined)), sel, 'undefined')
            want(() => api.simulate(bad(98765)), sel, '數字')
            want(() => api.simulate(bad('MARKER')), sel, '字串')
            want(() => api.simulate(bad(true)), sel, '布林')
            want(() => api.simulate(bad(() => [1])), sel, '函數')
            want(() => api.simulate(bad(new DataView(new ArrayBuffer(8)))), sel, 'DataView')
            let ids = 'invalid selsByPhase[1][2].ids: must be an array, a typed array or a Set'
            want(() => api.simulate(bad({ tag: 'MARKER' })), ids, '物件缺 ids')
            want(() => api.simulate(bad({ ids: null })), ids, 'ids 為 null')
            want(() => api.simulate(bad({ ids: 98765 })), ids, 'ids 為數字')
            want(() => api.simulate(bad({ ids: 'MARKER' })), ids, 'ids 為字串')
            want(() => api.simulate(bad({ ids: oneGen() })), ids, 'ids 為產生器(可迭代物不收)')
            want(() => api.simulate(bad({ ids: { length: 1, 0: 1 } })), ids, 'ids 為類陣列')
            want(() => api.simulate(bad({ ids: new Map([[1, 2]]) })), ids, 'ids 為 Map')
            want(() => api.simulate(bad({ length: 1, 0: 1 })), ids, '元素為類陣列物件(依物件形式讀其 ids)')
            let grp = 'invalid selsByPhase[1][2].group: must be an array, a typed array or a Set'
            want(() => api.simulate(bad({ ids: [1], group: 98765 })), grp, 'group 為數字')
            want(() => api.simulate(bad({ ids: [1], group: 'MARKER' })), grp, 'group 為字串')
            want(() => api.simulate(bad({ ids: [1], group: { length: 1, 0: 0 } })), grp, 'group 為類陣列')
            //tagsByPhase 之各相位若為陣列而讀取拋錯(已撤銷之代理 / 拋錯之存取子)⇒ 無效(V11; 不透傳)
            let boom = boomProxy([])
            want(() => api.simulate(okA, [boom, []]), 'invalid tagsByPhase[0]: must be an array', 'tagsByPhase 讀取拋錯')
            //各陣列之 length 只讀一次(V11: 每鍵只讀一次; 不先讀一次檢查、再讀一次複製): 讀一次之值決定結果
            let reads = 0
            let counted = new Proxy(okA[0].slice(), {
                get(tg, k, rc) {
                    if (k === 'length') {
                        reads++
                    }
                    return Reflect.get(tg, k, rc)
                },
            })
            assert.equal(json(api.simulate([counted, okA[1]])), json(api.simulate(okA)))
            assert.equal(reads, 1, '相位之陣列之 length 只讀一次')
            let readsOuter = 0
            let countedOuter = new Proxy(okA.slice(), {
                get(tg, k, rc) {
                    if (k === 'length') {
                        readsOuter++
                    }
                    return Reflect.get(tg, k, rc)
                },
            })
            api.simulate(countedOuter)
            assert.equal(readsOuter, 1, '外層陣列之 length 只讀一次')
            //length 較決策數短(代理讀一次即為短值)⇒ 無效
            let shortLen = new Proxy(okA[0].slice(), {
                get(tg, k, rc) {
                    return k === 'length' ? tg.length - 1 : Reflect.get(tg, k, rc)
                },
            })
            want(() => api.simulate([shortLen, okA[1]]), 'invalid selsByPhase[0]: must be an array with one entry per decision of phases[0]', 'length 較短')
            //定型陣列不收為相位之陣列
            want(() => api.simulate([Int32Array.from(okA[0].map(() => 1)), okA[1]]), 'invalid selsByPhase[0]: must be an array with one entry per decision of phases[0]', '相位之元素為定型陣列')
            //相位之陣列讀取拋錯: 結構檢查(.length)先於複本, 其錯誤沿用(與原寫法同); 元素存取子拋錯者於複本段以無效處理
            let acc = okA.map((ph) => ph.slice())
            Object.defineProperty(acc[0], 1, {
                get() {
                    throw new Error('BOOM')
                },
                enumerable: true,
                configurable: true,
            })
            want(() => api.simulate(acc), 'invalid selsByPhase[0]: must be an array with one entry per decision of phases[0]', '元素之存取子拋錯')
            return { text: 'ok' }
        })
    })

    it('api.simulate 之形狀不合於比對內建物件之後才拋(比對不被跳過): 內建物件被改而未改回 + 元素不合 ⇒ 拋 EVAL_INTEGRITY, 非 invalid …', () => {
        let saved = Array.prototype.indexOf
        try {
            let inner = null
            let err = errOf(() => ev.evalPolicy(pickG, {
                accept,
                ext: [{
                    name: 'd',
                    fn: (api) => {
                        let okA = api.phases.map((p) => p.sels.map((s) => Array.from(s)))
                        okA[0][1] = 'MARKER'
                        tamperIndexOf(saved)
                        inner = errOf(() => api.simulate(okA))
                        return { text: 'x' }
                    },
                }],
            }))
            assert.equal(inner && inner.code, 'EVAL_INTEGRITY', inner && inner.message)
            assert.equal(err && err.code, 'EVAL_INTEGRITY')
        }
        finally {
            setIndexOf(saved)
        }
    })

    it('pick 之回傳值(runPick)之可接受種類 = 與 api.simulate 之選集同一組: Array、定型陣列、Set、{ ids, group?, tag? }(ids / group 同); 其他種類(產生器、類陣列、原始值、Map)⇒ 拋 V19(不帶輸入值)(排程第 510 項①: 原沿用 Array.from, 其他可迭代物與類陣列亦收)', () => {
        //盤點(本庫之成品範例、合約、測試夾具之回傳種類): 皆為 Array 或 { ids: Array, group?: Array, tag? }, 一處 Set; 合約只寫「序號陣列或 { ids, tag }」 ⇒ 收窄不影響既有之寫法
        let sel = (f) => Array.from(ev.runPick(f, 0).sels[0])
        //可接受: 結果 = 排序去重之序號(與原寫法 Array.from 之結果逐位相同)
        for (let [name, f, want] of [
            ['Array', () => [3, 1, 3], [1, 3]],
            ['Int32Array', () => Int32Array.from([3, 1]), [1, 3]],
            ['Uint16Array', () => Uint16Array.from([3, 1, 3]), [1, 3]],
            ['Float64Array(整數值)', () => Float64Array.from([3, 1]), [1, 3]],
            ['Set', () => new Set([3, 3, 1]), [1, 3]],
            ['{ ids: Array }', () => ({ ids: [3, 1] }), [1, 3]],
            ['{ ids: Set }', () => ({ ids: new Set([3, 1]) }), [1, 3]],
            ['{ ids: Int32Array, group: Array }', () => ({ ids: Int32Array.from([3, 1]), group: [0, 1] }), [1, 3]],
            ['{ ids: Set, group: Set }', () => ({ ids: new Set([3, 1]), group: new Set([0, 1]) }), [1, 3]],
            ['空陣列', () => [], []],
        ]) {
            assert.deepEqual(sel(f), want, name)
        }
        //group 之對應(依 ids 之位置): ids [3, 1]、group [2, 0] ⇒ 排序後 [1, 3] 之子帳為 [0, 2]
        let g = ev.runPick(() => ({ ids: [3, 1], group: Int32Array.from([2, 0]) }), 0)
        assert.deepEqual(Array.from(g.sels[0]), [1, 3])
        //不可接受(其他可迭代物、類陣列、原始值、Map; 物件形式之 ids / group 亦同): 皆拋 V19 之錯、不回顯輸入
        let SECRET = 'secret-token-xyz'
        let RET = 'invalid pick return value: must be an array, a typed array or a Set of strategy indexes, or { ids, group?, tag? }'
        let IDS = 'invalid pick return value.ids: must be an array, a typed array or a Set of strategy indexes'
        let GRP = 'invalid pick return value.group: must be an array, a typed array or a Set of group numbers'
        let msgOf = (f) => {
            try {
                ev.runPick(f, 0)
            }
            catch (err) {
                return err.message
            }
            return null
        }
        for (let [name, f, want] of [
            ['產生器(物件形式缺 ids)', () => threeOne(), IDS],
            ['類陣列', () => ({ length: 2, 0: 5, 1: 2 }), IDS],
            ['字串', () => `12${SECRET}`, RET],
            ['數字(原: 靜默成空選集)', () => 5, RET],
            ['布林', () => true, RET],
            ['Map', () => new Map([[1, 2]]), IDS],
            ['{ ids: 產生器 }', () => ({ ids: threeOne() }), IDS],
            ['{ ids: 類陣列 }', () => ({ ids: { length: 2, 0: 5, 1: 2 } }), IDS],
            ['{ ids: 數字 }', () => ({ ids: 5 }), IDS],
            ['{ ids: 字串 }', () => ({ ids: SECRET }), IDS],
            ['{ ids: 已撤銷之代理 }', () => {
                let rv = Proxy.revocable([], {})
                rv.revoke()
                return { ids: rv.proxy }
            }, IDS],
            ['{ ids: Array, group: 類陣列 }', () => ({ ids: [1], group: { length: 1, 0: 0 } }), GRP],
            ['{ ids: Array, group: 字串 }', () => ({ ids: [1], group: SECRET }), GRP],
            ['{ ids: Array, group: 產生器 }', () => ({ ids: [1], group: threeOne() }), GRP],
        ]) {
            let m = msgOf(f)
            assert.strictEqual(m, want, name)
            assert(!m.includes(SECRET), `${name}: 不回顯`)
        }
        //模組自己之存取子拋出之錯誤照拋(不被吞成種類不合之訊息; 與原寫法相同)
        let boomOut = {}
        Object.defineProperty(boomOut, 'ids', {
            get: () => {
                throw new Error('boom')
            },
        })
        assert.strictEqual(msgOf(() => boomOut), 'boom')
    })

    it('api.summarize:合法輸入(陣列 / 定型陣列、選配之 thirds)之結果與數學定義相符、彼此相同;元素為物件者以 Number() 取值(同原寫法)', () => {
        runExt(ev, (api) => {
            let a = api.summarize([1, 2, 3, 4])
            //spec(合約 §7): summarize(vals)(一組等效年化 → 均、sd、超額、z、p): mean = 2.5, sd = √1.25(母體標準差)
            assert.equal(a.draws, 4)
            assert.equal(a.mean, 2.5)
            assert.equal(a.sd, Math.round(Math.sqrt(1.25) * 1e4) / 1e4)
            assert.equal(a.excess, Math.round((api.obs.mean - 2.5) * 1e4) / 1e4)
            assert.equal(json(api.summarize(Float64Array.from([1, 2, 3, 4]))), json(a))
            assert.equal(json(api.summarize(Int32Array.from([1, 2, 3, 4]))), json(a))
            assert.equal(json(api.summarize([1, { valueOf: () => 2 }, 3, { valueOf: () => 4 }])), json(a))
            assert(!('thirdsMean' in a))
            let th = api.summarize(Object.assign([1, 2, 3, 4], { thirds: [0.5, 1.5, 2.5] }))
            assert.deepEqual(th.thirdsMean, [0.5, 1.5, 2.5])
            assert.equal(json(api.summarize(Object.assign(Float64Array.from([1, 2, 3, 4]), { thirds: Float64Array.from([0.5, 1.5, 2.5]) }))), json(th))
            assert.equal(json(api.summarize(Object.assign([1, 2, 3, 4], { thirds: [] }))), json({ ...a, thirdsMean: [] }), '空陣列之 thirds 照舊(帶空之 thirdsMean)')
            for (let f of [undefined, null, 0, '', false]) {
                assert.equal(json(api.summarize(Object.assign([1, 2, 3, 4], { thirds: f }))), json(a), `thirds 為 ${String(f)} 視為未給`)
            }
            assert.equal(api.summarize([]).draws, 0)
            return { text: 'ok' }
        })
    })

    it('api.summarize 之輸入錯誤:invalid vals / invalid vals.thirds: must be an array or typed array(不帶輸入值); 讀取拋錯者無效而不透傳', () => {
        runExt(ev, (api) => {
            for (let v of [undefined, null, 98765, 'MARKER', true, {}, { length: 2, 0: 1, 1: 2 }, new Set([1, 2]), new Map(), oneGen(), new DataView(new ArrayBuffer(8)), () => [1]]) {
                let m = msgOf(() => api.summarize(v))
                assert.strictEqual(m, 'invalid vals: must be an array or typed array', String(typeof v))
            }
            for (let th of [98765, 'MARKER', true, {}, { length: 1, 0: 1 }, new Set([1])]) {
                let m = msgOf(() => api.summarize(Object.assign([1, 2], { thirds: th })))
                assert.strictEqual(m, 'invalid vals.thirds: must be an array or typed array', String(typeof th))
                assert(!CJK.test(m) && !/MARKER|98765/.test(m))
            }
            //讀取拋錯(已撤銷之代理、拋錯之存取子): 視為無效, 不透傳
            let boomLen = boomProxy([1, 2], true)
            assert.strictEqual(msgOf(() => api.summarize(boomLen)), 'invalid vals: must be an array or typed array')
            //length 為負或非整數之代理 ⇒ 無效(不當作空陣列)
            for (let len of [-1, 1.5, '2', NaN, Infinity]) {
                let odd = new Proxy([1, 2], {
                    get(tg, k, rc) {
                        return k === 'length' ? len : Reflect.get(tg, k, rc)
                    },
                })
                assert.strictEqual(msgOf(() => api.summarize(odd)), 'invalid vals: must be an array or typed array', `length 為 ${String(len)}`)
            }
            let thBoom = [1, 2]
            Object.defineProperty(thBoom, 'thirds', {
                get() {
                    throw new Error('BOOM')
                },
                enumerable: true,
            })
            assert.strictEqual(msgOf(() => api.summarize(thBoom)), 'invalid vals.thirds: must be an array or typed array')
            return { text: 'ok' }
        })
    })

    it('api.summarize / api.replaceNull(grp)之形狀不合於比對內建物件之後才拋: 內建物件被改而未改回 + 輸入不合 ⇒ 拋 EVAL_INTEGRITY, 非 invalid …', () => {
        let saved = Array.prototype.indexOf
        try {
            let inners = {}
            let err = errOf(() => ev.evalPolicy(pickG, {
                accept,
                ext: [{
                    name: 'd',
                    fn: (api) => {
                        tamperIndexOf(saved)
                        inners.sum = errOf(() => api.summarize('MARKER'))
                        inners.th = errOf(() => api.summarize(Object.assign([1], { thirds: 5 })))
                        inners.grp = errOf(() => api.replaceNull({ grp: 'MARKER', nGroups: 2 }))
                        return { text: 'x' }
                    },
                }],
            }))
            //第一個呼叫即偵測(其後皆為黏著之同一個錯誤)
            for (let k of ['sum', 'th', 'grp']) {
                assert.equal(inners[k] && inners[k].code, 'EVAL_INTEGRITY', `${k}: ${inners[k] && inners[k].message}`)
            }
            assert.equal(err && err.code, 'EVAL_INTEGRITY')
        }
        finally {
            setIndexOf(saved)
        }
    })

    it('物件元素之 valueOf 於複本段(比對之前)執行:valueOf 內改了內建物件而不改回 ⇒ 該次 api 呼叫即拋 EVAL_INTEGRITY(summarize 之 vals 與 thirds、replaceNull 之 grp)', () => {
        //複本段(第一段)可能執行模組之程式(存取子、valueOf), 其後才比對; 若元素之取值移到比對之後(第二段), 此處之改動要到診斷結束才被發現, 該次呼叫不拋
        let saved = Array.prototype.indexOf
        let cases = {
            summarizeVals: (api, evil) => api.summarize([1, evil]),
            summarizeThirds: (api, evil) => api.summarize(Object.assign([1, 2], { thirds: [evil] })),
            replaceNullGrp: (api, evil) => api.replaceNull({ grp: Array.from({ length: api.n }, (v, i) => (i === 0 ? evil : 0)), nGroups: 2, draws: 2 }),
        }
        try {
            for (let [nm, call] of Object.entries(cases)) {
                let inner = null
                let evil = {
                    valueOf() {
                        tamperIndexOf(saved)
                        return 0
                    },
                }
                let err = errOf(() => ev.evalPolicy(pickG, {
                    accept,
                    ext: [{
                        name: 'd',
                        fn: (api) => {
                            inner = errOf(() => call(api, evil))
                            return { text: 'x' }
                        },
                    }],
                }))
                setIndexOf(saved)
                assert.equal(inner && inner.code, 'EVAL_INTEGRITY', `${nm}: ${inner && inner.message}`)
                assert.equal(err && err.code, 'EVAL_INTEGRITY', `${nm}: 評估失敗`)
            }
        }
        finally {
            setIndexOf(saved)
        }
    })

    it('api.replaceNull 之 grp:陣列 / 定型陣列(元素依 Int32 轉型: 小數、數字字串、物件之 valueOf、布林)之結果與整數陣列逐位相同; 假值視為未給', () => {
        runExt(ev, (api) => {
            let grp = Array.from({ length: api.n }, (v, i) => i % 3)
            let want = json(api.replaceNull({ grp, nGroups: 3, draws: 4 }))
            assert(/"draws":4/.test(want))
            //grp 確實被讀入: 全為 0(單一組)之結果與上列不同
            assert.notEqual(json(api.replaceNull({ grp: new Array(api.n).fill(0), nGroups: 3, draws: 4 })), want, 'grp 不同 ⇒ 結果不同')
            assert.equal(json(api.replaceNull({ grp: Int32Array.from(grp), nGroups: 3, draws: 4 })), want, 'Int32Array')
            assert.equal(json(api.replaceNull({ grp: Uint8Array.from(grp), nGroups: 3, draws: 4 })), want, 'Uint8Array')
            assert.equal(json(api.replaceNull({ grp: Float64Array.from(grp, (x) => x + 0.7), nGroups: 3, draws: 4 })), want, 'Float64Array(小數 → 取整)')
            assert.equal(json(api.replaceNull({ grp: grp.map((x) => x + 0.7), nGroups: 3, draws: 4 })), want, '小數')
            assert.equal(json(api.replaceNull({ grp: grp.map((x) => String(x)), nGroups: 3, draws: 4 })), want, '數字字串')
            assert.equal(json(api.replaceNull({ grp: grp.map((x) => ({ valueOf: () => x })), nGroups: 3, draws: 4 })), want, '物件之 valueOf')
            let b = grp.map((x) => x % 2)
            assert.equal(json(api.replaceNull({ grp: b.map((x) => x === 1), nGroups: 2, draws: 4 })), json(api.replaceNull({ grp: b, nGroups: 2, draws: 4 })), '布林')
            //假值之 grp 視為未給(預設為多空分組)
            let dflt = json(api.replaceNull({ draws: 4 }))
            for (let f of [null, undefined, 0, '', false]) {
                assert.equal(json(api.replaceNull({ grp: f, draws: 4 })), dflt, `grp 為 ${String(f)}`)
            }
            return { text: 'ok' }
        })
    })

    it('api.replaceNull 之 grp / nGroups 之輸入錯誤:invalid opt.grp: must be … / invalid opt.nGroups: must be a positive integer(不帶輸入值); 檢查先 grp 之種類與長度、再 nGroups、再 grp 之值域; 先於 onlyGroups / onlyDecisions', () => {
        runExt(ev, (api) => {
            let G = 'invalid opt.grp: must be an array or typed array with one integer from 0 to opt.nGroups - 1 per strategy (api.n entries)'
            let N = 'invalid opt.nGroups: must be a positive integer'
            let ok = Array.from({ length: api.n }, (v, i) => i % 2)
            let want = (o, msg, w) => {
                let m = msgOf(() => api.replaceNull(o))
                assert.strictEqual(m, msg, w)
                assert(!CJK.test(m) && !/MARKER|98765/.test(m), `${w}: 英文且不帶輸入值`)
            }
            //grp 之種類與長度
            for (let [w, g] of [['字串', 'MARKER'], ['數字', 98765], ['Set', new Set([0, 1])], ['類陣列', { length: api.n }], ['短一個', ok.slice(1)], ['長一個', ok.concat([0])], ['空陣列', []], ['產生器', (function* () {
                yield 0
            })()], ['DataView', new DataView(new ArrayBuffer(8))]]) {
                want({ grp: g, nGroups: 2, draws: 2 }, G, w)
            }
            //讀取拋錯之 grp(已撤銷之代理): 無效, 不透傳
            want({ grp: boomProxy([]), nGroups: 2 }, G, 'grp 讀取拋錯')
            //nGroups(使用者給 grp 時才檢查; 未給 grp 者之預設 2 不檢查)
            for (let [w, v] of [['未給', undefined], ['0', 0], ['負數', -1], ['小數', 1.5], ['字串', '2'], ['NaN', NaN], ['null', null]]) {
                want({ grp: ok, nGroups: v, draws: 2 }, N, `nGroups ${w}`)
            }
            //grp 之值域(值 < 0 或 ≥ nGroups)
            want({ grp: ok.map((x, i) => (i === 3 ? 2 : x)), nGroups: 2 }, G, '值 ≥ nGroups')
            want({ grp: ok.map((x, i) => (i === 3 ? -1 : x)), nGroups: 2 }, G, '值 < 0')
            //先後: grp 之長度 → nGroups → grp 之值域 → onlyGroups / onlyDecisions
            want({ grp: ok.slice(1), nGroups: 0 }, G, 'grp 長度先於 nGroups')
            want({ grp: ok.map((x, i) => (i === 3 ? 5 : x)), nGroups: 0 }, N, 'nGroups 先於 grp 之值域')
            want({ grp: ok, nGroups: 0, onlyGroups: [] }, N, 'nGroups 先於 onlyGroups')
            want({ grp: ok.slice(1), nGroups: 2, onlyGroups: [], onlyDecisions: 5 }, G, 'grp 先於 onlyGroups / onlyDecisions')
            want({ grp: ok, nGroups: 2, onlyGroups: [] }, 'invalid opt.onlyGroups: must be a non-empty array or typed array of integers from 0 to 3', 'grp 合法者再依新選項')
            return { text: 'ok' }
        })
    })

    it('api.simulate 之選集內容之錯誤(序號不合法、group 與 ids 不等長、group 值不合法)依 V19、V20:帶位置(含 ids / group 之索引)、不帶輸入值;挑選函數之回傳值(runPick)之訊息同為 V19', () => {
        runExt(ev, (api) => {
            let n = api.n
            let okA = api.phases.map((p) => p.sels.map((s) => Array.from(s)))
            let bad = (el) => {
                let a = okA.map((ph) => ph.slice())
                a[0][3] = el
                return a
            }
            let want = (el, msg, w) => {
                let m = msgOf(() => api.simulate(bad(el)))
                assert.strictEqual(m, msg, w)
                assert(!CJK.test(m) && !/MARKER|98765|123456/.test(m), `${w}: 英文且不帶輸入值`)
            }
            let at = 'selsByPhase[0][3]'
            let idOut = (i) => `invalid ${at}[${i}]: must be an integer from 0 to ${n - 1}`
            let idOutObj = (i) => `invalid ${at}.ids[${i}]: must be an integer from 0 to ${n - 1}`
            want([1, 123456], idOut(1), '陣列:序號超出範圍')
            want([1.5], idOut(0), '陣列:序號為小數')
            want([-1], idOut(0), '陣列:序號為負')
            want(['3'], idOut(0), '陣列:序號為字串')
            want(Int32Array.from([1, n]), idOut(1), '定型陣列:序號 = n')
            want(new Set([2, 123456]), idOut(1), 'Set:序號超出範圍(依插入序之索引)')
            want({ ids: [1, 123456] }, idOutObj(1), '物件形式:序號超出範圍')
            want({ ids: [{}] }, idOutObj(0), '物件形式:序號為物件(不轉字串)')
            want({ ids: [1, 2], group: [0] }, `invalid ${at}.group: must have the same number of entries as ${at}.ids`, 'group 與 ids 不等長')
            want({ ids: [1, 2], group: [0, 7] }, `invalid ${at}.group[1]: must be an integer from 0 to 3`, 'group 值超出範圍')
            want({ ids: [1, 2], group: [0, 'MARKER'] }, `invalid ${at}.group[1]: must be an integer from 0 to 3`, 'group 值為字串')
            //挑選函數之回傳值(runPick; 非 strict)之訊息同為 V19、V20(位置名稱 pick return value; 排程第 510 項④: 原為中文訊息並帶輸入值之描述)
            assert.strictEqual(msgOf(() => ev.runPick(() => [0, n], 0)), `invalid pick return value[1]: must be an integer from 0 to ${n - 1}`)
            assert.strictEqual(msgOf(() => ev.runPick(() => ({ ids: [1, 2], group: [0] }), 0)), 'invalid pick return value.group: must have the same number of entries as pick return value.ids')
            assert.strictEqual(msgOf(() => ev.runPick(() => ({ ids: [1, 2], group: [0, 7] }), 0)), 'invalid pick return value.group[1]: must be an integer from 0 to 3')
            return { text: 'ok' }
        })
    })

    it('讀取拋錯(存取子、代理、元素之 valueOf、BigInt / Symbol 之轉型)一律視為無效(V11):不透傳模組之錯誤(SECRET_*), 於比對之後以固定訊息拒收', () => {
        runExt(ev, (api) => {
            let okA = api.phases.map((p) => p.sels.map((s) => Array.from(s)))
            let SECRET = () => {
                throw new Error('SECRET_X')
            }
            let want = (fn, msg, w) => {
                let m = msgOf(fn)
                assert.strictEqual(m, msg, w)
                assert(!/SECRET/.test(m), `${w}: 不透傳`)
            }
            //simulate: opts 之存取子、opts 本身為拋錯之代理、selsByPhase 之索引存取子拋錯(代理)
            want(() => api.simulate(okA, null, {
                get accept() {
                    return SECRET()
                }
            }), 'invalid opts.accept: must be a function (sig, book) => boolean', 'opts.accept 之存取子')
            want(() => api.simulate(okA, null, {
                get orderSalt() {
                    return SECRET()
                }
            }), 'invalid opts.orderSalt: must be an integer (0 for the order of the product itself)', 'opts.orderSalt 之存取子')
            want(() => api.simulate(okA, null, boomProxy({})), 'invalid opts.accept: must be a function (sig, book) => boolean', 'opts 為拋錯之代理')
            want(() => api.simulate(new Proxy(okA, {
                get(tg, k, rc) {
                    return k === '1' ? SECRET() : Reflect.get(tg, k, rc)
                }
            })), 'invalid selsByPhase[1]: must be an array with one entry per decision of phases[1]', 'selsByPhase 之索引拋錯')
            //已撤銷之代理(Array.isArray 本身拋 TypeError)與讀 length 即拋錯之代理 ⇒ 無效; tagsByPhase 讀取拋錯之相位 ⇒ 視為非陣列(沿用成品之 tag)
            let revoked = Proxy.revocable([], {})
            revoked.revoke()
            want(() => api.simulate(revoked.proxy), 'invalid selsByPhase: must be an array with one entry per phase of phases[]', 'selsByPhase 為已撤銷之代理')
            want(() => api.simulate(boomProxy(okA.slice(), true)), 'invalid selsByPhase: must be an array with one entry per phase of phases[]', 'selsByPhase 讀 length 拋錯')
            assert.equal(json(api.simulate(okA, boomProxy([]))), json(api.simulate(okA)), 'tagsByPhase 讀取拋錯 ⇒ 沿用成品之 tag')
            //summarize: 元素之 valueOf 拋錯、thirds 之元素拋錯
            want(() => api.summarize([1, { valueOf: SECRET }]), 'invalid vals: must be an array or typed array', 'vals 元素之 valueOf 拋錯')
            want(() => api.summarize(Object.assign([1], { thirds: [{ valueOf: SECRET }] })), 'invalid vals.thirds: must be an array or typed array', 'thirds 元素之 valueOf 拋錯')
            //replaceNull: grp / nGroups 之存取子、grp 元素之轉型(valueOf 拋錯、BigInt、Symbol)
            let G = 'invalid opt.grp: must be an array or typed array with one integer from 0 to opt.nGroups - 1 per strategy (api.n entries)'
            let ok = Array.from({ length: api.n }, (v, i) => i % 2)
            want(() => api.replaceNull({
                get grp() {
                    return SECRET()
                },
                nGroups: 2
            }), G, 'grp 之存取子')
            want(() => api.replaceNull({
                grp: ok,
                get nGroups() {
                    return SECRET()
                }
            }), 'invalid opt.nGroups: must be a positive integer', 'nGroups 之存取子')
            want(() => api.replaceNull({ grp: ok.map((x, i) => (i === 2 ? { valueOf: SECRET } : x)), nGroups: 2 }), G, 'grp 元素之 valueOf 拋錯')
            want(() => api.replaceNull({ grp: new BigInt64Array(api.n), nGroups: 2 }), G, 'grp 為 BigInt 定型陣列')
            want(() => api.replaceNull({ grp: ok.map((x, i) => (i === 2 ? Symbol('s') : x)), nGroups: 2 }), G, 'grp 元素為 Symbol')
            want(() => api.replaceNull(null), 'invalid opt: must be an object', 'opt 為 null')
            //half 之存取子拋錯 ⇒ 視為未給(沿用「不合者用預設」)
            let dflt = json(api.replaceNull({ draws: 4 }))
            assert.equal(json(api.replaceNull({
                draws: 4,
                get half() {
                    return SECRET()
                }
            })), dflt)
            //actDays、draws 之存取子拋錯 ⇒ 無效(V11; 與 fillRandom 同一口徑, 排程第 574 項: 原「視為未給」): 不透傳模組之錯誤, 以固定訊息拒收(不帶輸入值)
            want(() => api.replaceNull({
                draws: 4,
                get actDays() {
                    return SECRET()
                }
            }), 'invalid opt.actDays: must be a non-negative integer (0 for the cumulative entry count)', 'actDays 之存取子')
            want(() => api.replaceNull({
                get draws() {
                    return SECRET()
                }
            }), 'invalid opt.draws: must be an integer from 1 to 64', 'draws 之存取子')
            return { text: 'ok' }
        })
    })

    it('api.simulate 之選集元素與 tagsByPhase 之讀取:物件元素之 ids / group 之存取子拋錯、已撤銷之代理元素 ⇒ 無效(V11; 不透傳); 物件之 tag 欄不讀取(存取子、不可複製之值不影響); tagsByPhase 之不可複製之元素 ⇒ 無效', () => {
        runExt(ev, (api) => {
            let okA = api.phases.map((p) => p.sels.map((s) => Array.from(s)))
            let base = json(api.simulate(okA))
            let SECRET = () => {
                throw new Error('SECRET_X')
            }
            let put = (el) => {
                let a = okA.map((ph) => ph.slice())
                a[1][2] = el
                return a
            }
            let want = (fn, msg, w) => {
                let m = msgOf(fn)
                assert.strictEqual(m, msg, w)
                assert(!/SECRET/.test(m), `${w}: 不透傳`)
            }
            let ids = 'invalid selsByPhase[1][2].ids: must be an array, a typed array or a Set'
            let grp = 'invalid selsByPhase[1][2].group: must be an array, a typed array or a Set'
            want(() => api.simulate(put({
                get ids() {
                    return SECRET()
                }
            })), ids, 'ids 之存取子拋錯')
            want(() => api.simulate(put({
                ids: [1],
                get group() {
                    return SECRET()
                }
            })), grp, 'group 之存取子拋錯')
            let rv = Proxy.revocable({}, {})
            rv.revoke()
            want(() => api.simulate(put(rv.proxy)), ids, '元素為已撤銷之代理')
            let rvArr = Proxy.revocable([], {})
            rvArr.revoke()
            want(() => api.simulate(put(rvArr.proxy)), ids, '元素為已撤銷之陣列代理(依物件形式讀其 ids)')
            //物件之 tag 欄不讀取、不快照: 存取子拋錯、函數值(不可結構化複製)皆不影響結果
            let withTag = (tagDesc) => put(Object.defineProperty({ ids: okA[1][2] }, 'tag', tagDesc))
            let plain = json(api.simulate(put({ ids: okA[1][2] })))
            assert.equal(json(api.simulate(withTag({
                get() {
                    return SECRET()
                },
                enumerable: true
            }))), plain, 'tag 之存取子不被呼叫')
            assert.equal(json(api.simulate(withTag({ value: () => 1, enumerable: true }))), plain, 'tag 為函數不被快照')
            //tagsByPhase: 相位之陣列含不可結構化複製之元素(函數)⇒ 無效(比對之後拋, 不透傳 structuredClone 之錯誤)
            let tagMsg = (i) => `invalid tagsByPhase[${i}]: must be an array of structured-cloneable data (no functions, symbols or shared memory)`
            want(() => api.simulate(okA, [[() => 1], []]), tagMsg(0), 'tagsByPhase 第 0 相位含函數')
            want(() => api.simulate(okA, [[], [Symbol('s')]]), tagMsg(1), 'tagsByPhase 第 1 相位含 Symbol')
            //已撤銷之代理相位 ⇒ 視為非陣列(沿用成品之 tag)
            let rvTag = Proxy.revocable([], {})
            rvTag.revoke()
            assert.strictEqual(json(api.simulate(okA, [rvTag.proxy, []])), json(api.simulate(okA, [null, []])), 'tagsByPhase 之相位為已撤銷之代理')
            //length 為負之代理 ⇒ 無效
            let negLen = new Proxy(okA[0].slice(), {
                get(tg, k, rc) {
                    return k === 'length' ? -1 : Reflect.get(tg, k, rc)
                },
            })
            want(() => api.simulate([negLen, okA[1]]), 'invalid selsByPhase[0]: must be an array with one entry per decision of phases[0]', 'length 為負')
            //同一相位內有兩個無效選集 ⇒ 報第一個
            let twoSame = okA.map((ph) => ph.slice())
            twoSame[0][1] = 'x'
            twoSame[0][4] = null
            assert.strictEqual(msgOf(() => api.simulate(twoSame)), 'invalid selsByPhase[0][1]: must be an array, a typed array or a Set of strategy indexes, or an object with ids')
            //選集與 tagsByPhase 皆不合 ⇒ 報選集(第一處; 發現後不再讀其後之參數)
            assert.strictEqual(msgOf(() => api.simulate(twoSame, [[() => 1], []])), 'invalid selsByPhase[0][1]: must be an array, a typed array or a Set of strategy indexes, or an object with ids')
            let revTags = Proxy.revocable([], {})
            revTags.revoke()
            assert.strictEqual(msgOf(() => api.simulate(twoSame, revTags.proxy)), 'invalid selsByPhase[0][1]: must be an array, a typed array or a Set of strategy indexes, or an object with ids')
            assert.equal(json(api.simulate(okA)), base)
            return { text: 'ok' }
        })
    })

    it('超長之輸入不逐索引讀取:length 遠大於決策數 / 策略數之代理 ⇒ 直接無效(不讀任何索引、不查自有屬性)', () => {
        runExt(ev, (api) => {
            let okA = api.phases.map((p) => p.sels.map((s) => Array.from(s)))
            let counted = (target, len) => {
                let n = { reads: 0 }
                let proxy = new Proxy(target, {
                    get(tg, k, rc) {
                        if (k === 'length') {
                            return len
                        }
                        n.reads++
                        return Reflect.get(tg, k, rc)
                    },
                    getOwnPropertyDescriptor(tg, k) {
                        n.reads++
                        return Reflect.getOwnPropertyDescriptor(tg, k)
                    },
                })
                return { proxy, n }
            }
            let c1 = counted(okA[0].slice(), 5000000)
            assert.strictEqual(msgOf(() => api.simulate([c1.proxy, okA[1]])), 'invalid selsByPhase[0]: must be an array with one entry per decision of phases[0]')
            assert.equal(c1.n.reads, 0, 'simulate: 相位之陣列')
            let c2 = counted([], 5000000)
            let G = 'invalid opt.grp: must be an array or typed array with one integer from 0 to opt.nGroups - 1 per strategy (api.n entries)'
            assert.strictEqual(msgOf(() => api.replaceNull({ grp: c2.proxy, nGroups: 2 })), G)
            assert.equal(c2.n.reads, 0, 'replaceNull: grp')
            return { text: 'ok' }
        })
    })

    it('形狀不合(含 simulate 之結構檢查:selsByPhase / opts / 相位之陣列;replaceNull(null))於比對內建物件之後才拋:內建物件被改而未改回 ⇒ 該次呼叫拋 EVAL_INTEGRITY, 非 invalid …', () => {
        let saved = Array.prototype.indexOf
        let cases = {
            selsNotArray: (api) => api.simulate('MARKER'),
            selsWrongLength: (api) => api.simulate([[]]),
            optsAccept: (api) => api.simulate(api.phases.map((p) => p.sels.map((s) => Array.from(s))), null, { accept: 5 }),
            optsSalt: (api) => api.simulate(api.phases.map((p) => p.sels.map((s) => Array.from(s))), null, { orderSalt: 1.5 }),
            phaseNotArray: (api) => api.simulate([5, 6]),
            elementGetter: (api) => api.simulate(api.phases.map((p) => p.sels.map((s, k) => (k === 1
                ? {
                    get ids() {
                        throw new Error('SECRET')
                    },
                }
                : Array.from(s))))),
            tagsUncloneable: (api) => api.simulate(api.phases.map((p) => p.sels.map((s) => Array.from(s))), [[() => 1], []]),
            replaceNullNull: (api) => api.replaceNull(null),
            replaceNullGrpGetter: (api) => api.replaceNull({
                get grp() {
                    throw new Error('SECRET')
                }
            }),
        }
        try {
            for (let [nm, call] of Object.entries(cases)) {
                let inner = null
                let err = errOf(() => ev.evalPolicy(pickG, {
                    accept,
                    ext: [{
                        name: 'd',
                        fn: (api) => {
                            tamperIndexOf(saved)
                            inner = errOf(() => call(api))
                            return { text: 'x' }
                        },
                    }],
                }))
                setIndexOf(saved)
                assert.equal(inner && inner.code, 'EVAL_INTEGRITY', `${nm}: ${inner && inner.message}`)
                assert.equal(err && err.code, 'EVAL_INTEGRITY', `${nm}: 評估失敗`)
            }
        }
        finally {
            setIndexOf(saved)
        }
    })

    it('錯誤之優先序與邊界:多處不合時報第一處;summarize 之 undefined / 洞為缺值(統計為 NaN, 同原寫法);選集物件之 tag 欄於 simulate 不採用(accept 所見為成品之 tag)', () => {
        runExt(ev, (api) => {
            let okA = api.phases.map((p) => p.sels.map((s) => Array.from(s)))
            //多處不合: 相位 0 之第 2 個元素與相位 1 之第 1 個元素皆不合 ⇒ 報相位 0
            let two = okA.map((ph) => ph.slice())
            two[0][2] = null
            two[1][1] = 'x'
            assert.strictEqual(msgOf(() => api.simulate(two)), 'invalid selsByPhase[0][2]: must be an array, a typed array or a Set of strategy indexes, or an object with ids')
            //同一元素之 ids 與 group 皆不合 ⇒ 報 ids
            let both = okA.map((ph) => ph.slice())
            both[0][1] = { ids: 5, group: 5 }
            assert.strictEqual(msgOf(() => api.simulate(both)), 'invalid selsByPhase[0][1].ids: must be an array, a typed array or a Set')
            //相位之形狀不合先於其後之相位之元素
            let phs = okA.map((ph) => ph.slice())
            phs[1] = 'x'
            phs[0][0] = null
            assert.strictEqual(msgOf(() => api.simulate(phs)), 'invalid selsByPhase[0][0]: must be an array, a typed array or a Set of strategy indexes, or an object with ids')
            //summarize: 缺值(undefined、洞)不被丟棄, 統計為 NaN(沿用原寫法; 非數字不檢查)
            // eslint-disable-next-line no-sparse-arrays
            for (let v of [[1, undefined, 3], [1, , 3]]) {
                assert(Number.isNaN(api.summarize(v).mean), json(v))
                assert.equal(api.summarize(v).draws, 3)
            }
            //選集物件之 tag 欄不採用(合約 §7: 重放時之 tag 由 tagsByPhase 或成品給)
            let seen = new Set()
            api.simulate(okA.map((ph) => ph.map((x) => ({ ids: x, tag: 'OWN_TAG' }))), null, {
                accept: (sig) => {
                    seen.add(sig.tag)
                    return true
                },
            })
            assert(seen.size > 0 && !seen.has('OWN_TAG') && [...seen].every((x) => x === 'a' || x === 'b'), json([...seen]))
            return { text: 'ok' }
        })
    })
})
