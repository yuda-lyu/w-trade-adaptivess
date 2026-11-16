/* eslint-disable no-extend-native, accessor-pairs -- 違約樣本: 本檔刻意暫時改寫內建原型(測後一律以 keep 還原), 驗評估器之偵測 */
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { loadLedger } from '../src/eval/ledger.mjs'
import { makeEvaluator } from '../src/eval/evalCore.mjs'
import { loadPick } from '../src/eval/pickLoader.mjs'
import { makeTmp, writeSynthLedger, FD_ROOT } from './tools/synthLedger.mjs'


//規則 R-EV-35: 評估器之狀態與「無前視」不受挑選模組與擴充診斷模組之寫入影響(sgud/rule/rulebook.md; 合約 contract/pick-contract.md §1、§3、§4、§7)
//  ① 資料不共用: 交給模組之物件一律為複本或凍結物件(ctx.prev、ctx.meta、ctx.stat 之回傳物件、tag、accept 之 sig / book、擴充診斷之 api)
//  ② 內建物件之完整性: 評估器只用載入時擷取之參照; 載入模組後、每次 pick 後、每批 accept 後、每個擴充診斷後比對受保護之內建物件, 被改 ⇒ code 為 EVAL_INTEGRITY 之錯誤
//  違約樣本一律為最小者(對內建物件之方法重新賦值、或改寫交出之物件), 測後一律還原
const CFG = { warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [3, 7], nullDraws: 8, seed: 11 }
const TA_PROTO = Object.getPrototypeOf(Int8Array.prototype)

//keep, 先記下要被改之屬性描述, fn 結束後(含拋錯)逐一還原(新增者刪除)
let keep = (targets, fn) => {
    let saved = targets.map(([o, k]) => [o, k, Object.getOwnPropertyDescriptor(o, k)])
    try {
        return fn()
    }
    finally {
        for (let [o, k, d] of saved) {
            if (d) {
                Object.defineProperty(o, k, d)
            }
            else {
                delete o[k]
            }
        }
    }
}
let keepAsync = async (targets, fn) => {
    let saved = targets.map(([o, k]) => [o, k, Object.getOwnPropertyDescriptor(o, k)])
    try {
        return await fn()
    }
    finally {
        for (let [o, k, d] of saved) {
            if (d) {
                Object.defineProperty(o, k, d)
            }
            else {
                delete o[k]
            }
        }
    }
}
let integrityOf = (fn) => {
    try {
        fn()
    }
    catch (err) {
        return err
    }
    return null
}

describe('evalCore 資料不共用(R-EV-35 ①):模組改寫交出之物件, 評估器之結果不受影響', function () {
    let t
    let L
    let ev
    before(() => {
        t = makeTmp('evalIntegrity1')
        writeSynthLedger(t.dir, { n: 60, nBars: 2400, seed: 5, series: ['a'] })
        L = loadLedger(t.dir)
        ev = makeEvaluator(L, CFG)
    })
    after(() => {
        t.cleanup()
    })

    //idsOf, 與 tie / prev 無關之固定選集(隨決策序平移)
    let idsOf = (ctx) => [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34].map((s) => (s + ctx.k) % ctx.n)

    it('ctx.prev 為前一選集之複本:挑選函數改寫它,已記錄之選集與 selHash 不變', () => {
        //合約 §3: ctx.prev = 上一次決策之選集; R-EV-35 ①: 改它不得改到評估器所記錄之選集
        let accept = (sig, book) => book.open < 4
        let base = ev.evalPolicy((ctx) => idsOf(ctx), { accept })
        let seenCopy = true
        let m = ev.evalPolicy((ctx) => {
            if (ctx.prev.length) {
                ctx.prev.fill(0)
                ctx.prev[0] = 59
            }
            return idsOf(ctx)
        }, { accept })
        assert.equal(m.selHash, base.selHash)
        assert.deepEqual(m.op, base.op)
        assert.deepEqual(m.null, base.null)
        //runPick 之選集逐一與固定選集相同(未被改寫)
        let r = ev.runPick((ctx) => {
            if (ctx.prev.length) {
                seenCopy = seenCopy && Array.from(ctx.prev).join() === idsOf({ k: ctx.k - 1, n: ctx.n }).sort((a, b) => a - b).join()
                ctx.prev.fill(0)
            }
            return idsOf(ctx)
        }, 0, CFG.seed)
        assert(seenCopy, 'ctx.prev 之內容 = 前一選集(排序後)')
        r.sels.forEach((sel, k) => assert.deepEqual(Array.from(sel), idsOf({ k, n: L.n }).sort((a, b) => a - b), `決策 ${k}`))
    })

    it('ctx.meta 為每次 runPick 之複本:改寫 tie 不改同一進場棒之訊號先後;改寫 tp / sl 不改幾何對照;不影響其他相位與 ev.meta', () => {
        //合約 §4: 同一根進場棒之多個訊號依 ctx.meta.tie 由小到大 —— 持倉上限 2 使先後決定誰得席位
        //各用新建之評估器(幾何分組與同值次序之名次為延遲計算後快取: 須於改寫之後才首次計算, 才驗得到)
        let accept = (sig, book) => book.open < 2
        let base = makeEvaluator(L, CFG).evalPolicy((ctx) => idsOf(ctx), { accept })
        let evM = makeEvaluator(L, CFG)
        let tie0 = Array.from(evM.meta.tie)
        let tp0 = Array.from(evM.meta.tp)
        let fresh = []
        let m = evM.evalPolicy((ctx) => {
            //每次 runPick 之第一個決策: meta 為未改之複本(前一相位之改寫不帶過來)
            if (ctx.k === 0) {
                fresh.push(Array.from(ctx.meta.tie).join() === tie0.join() && Array.from(ctx.meta.tp).join() === tp0.join())
            }
            ctx.meta.tie.fill(0)
            ctx.meta.tp.fill(ctx.k % 2)
            ctx.meta.sl.reverse()
            return idsOf(ctx)
        }, { accept })
        assert.equal(m.selHash, base.selHash, 'selHash(含逐訊號下單序列之雜湊)不變')
        assert.deepEqual(m.op, base.op)
        assert.deepEqual(m.nullSideAct, base.nullSideAct)
        assert.deepEqual(m.nullSideGeo, base.nullSideGeo, '幾何分組依帳本之止盈 / 止損, 不讀交出之 meta')
        assert.deepEqual(fresh, [true, true], '各相位各給一份未改之 meta')
        assert.deepEqual(Array.from(evM.meta.tie), tie0)
        assert.deepEqual(Array.from(evM.meta.tp), tp0)
        evM.runPick((ctx) => {
            assert(Object.isFrozen(ctx.meta) && ctx.meta !== evM.meta && ctx.meta.tie !== evM.meta.tie)
            assert.deepEqual(Object.keys(ctx.meta), Object.keys(evM.meta), '鍵與順序同 ev.meta')
            return []
        }, 0)
    })

    it('ctx.stat 之暫存陣列被轉移(分離)後, 其後之決策另建一組:統計與選集與未轉移者相同', () => {
        //R-EV-35 ①: stat 之陣列為評估器跨決策重用之暫存; 模組以 structuredClone 之 transfer 使其分離, 不得使其後之統計變空
        let pickOf = (detach) => (ctx) => {
            let S = ctx.stat(30)
            let ids = Array.from({ length: ctx.n }, (_, s) => s).sort((a, b) => (S.entries[b] - S.entries[a]) || (ctx.meta.tie[a] - ctx.meta.tie[b])).slice(0, 8)
            if (detach) {
                structuredClone(S.entries, { transfer: [S.entries.buffer] })
            }
            return ids
        }
        let base = ev.evalPolicy(pickOf(false), { accept: (sig, book) => book.open < 3 })
        let m = ev.evalPolicy(pickOf(true), { accept: (sig, book) => book.open < 3 })
        assert.equal(m.selHash, base.selHash)
        assert.deepEqual(m.op, base.op)
    })

    it('ctx.stat 之回傳物件凍結:各欄不可換成他物(陣列內容為每次決策重寫之暫存)', () => {
        //合約 §3: stat 之陣列會被重複使用, 只在本次 pick 內有效
        let ok = 0
        ev.runPick((ctx) => {
            let S = ctx.stat(30)
            assert(Object.isFrozen(S))
            assert.throws(() => {
                S.closed = new Int32Array(ctx.n)
            }, TypeError)
            ok++
            return []
        }, 0)
        assert(ok > 10)
    })

    it('accept 之 book 為交出物件:改寫 book 不改評估器之持倉計數(持倉峰值、下單與損益與未改者相同)', () => {
        //合約 §4: 硬限制(最大同時持倉)以評估器之計數為準; accept 改 book.open 不得使峰值或下單改變
        let base = ev.evalPolicy((ctx) => idsOf(ctx), { accept: (sig, book) => book.open < 3 })
        let m = ev.evalPolicy((ctx) => idsOf(ctx), {
            accept: (sig, book) => {
                let ok = book.open < 3
                book.open = -100
                book.openLong = -100
                book.openShort = -100
                book.nAccepted = -1
                book.openGroup[0] = -100
                try {
                    book.openGroup = [9, 9, 9, 9]
                }
                catch (err) {}
                return ok
            },
        })
        assert.equal(m.op.peakHold.max, 3, '持倉上限 3 ⇒ 最大同時持倉 3')
        assert.equal(base.op.peakHold.max, 3)
        assert.equal(m.selHash, base.selHash)
        assert.deepEqual(m.op, base.op)
        assert.deepEqual(m.null, base.null)
        assert.deepEqual(m.fresh, base.fresh)
        //accept 把 book 凍結(使評估器寫不進)⇒ 判違約(EVAL_INTEGRITY), 不是一般之執行錯誤
        let errF = null
        try {
            ev.evalPolicy((ctx) => idsOf(ctx), {
                nullDraws: 0,
                accept: (sig, book) => {
                    let ok = book.open < 3
                    Object.freeze(book)
                    return ok
                },
            })
        }
        catch (e) {
            errF = e
        }
        assert.equal(errF && errF.code, 'EVAL_INTEGRITY', String(errF))
        assert.equal(errF.where, 'accept')
        //book / sig 為封裝之物件: 不可加欄、不可改為存取子
        ev.evalPolicy((ctx) => idsOf(ctx), {
            nullDraws: 0,
            accept: (sig, book) => {
                assert(Object.isSealed(book) && Object.isSealed(sig) && Object.isSealed(book.openGroup))
                assert.equal(book.openGroup.reduce((a, v) => a + v, 0), book.open)
                return book.open < 3
            },
        })
    })

    it('tag 於 pick 回傳時取快照:挑選函數其後再改它所保留之物件, accept 收到者仍為回傳當時之內容;快照凍結', () => {
        //合約 §1: tag 只收可結構化複製之資料, 於回傳時取快照 —— 否則可於較晚之決策把較晚之資訊寫進較早之決策之 tag
        let mk = (mutate) => {
            let last = null
            return (ctx) => {
                if (mutate && last) {
                    last.k = -1
                    last.arr.push(9)
                }
                let tag = { k: ctx.k, arr: [ctx.k] }
                last = tag
                return { ids: idsOf(ctx), tag }
            }
        }
        let seen = []
        let accept = (sig, book) => {
            if (sig.tag.k !== sig.k || sig.tag.arr.length !== 1) {
                seen.push(sig.k)
            }
            let frozen = Object.isFrozen(sig.tag) && Object.isFrozen(sig.tag.arr)
            try {
                sig.tag.k = 12345
            }
            catch (err) {}
            return frozen && book.open < 3
        }
        let base = ev.evalPolicy(mk(false), { accept })
        let m = ev.evalPolicy(mk(true), { accept })
        assert.deepEqual(seen, [], 'accept 收到之 tag = 回傳當時之內容')
        assert.equal(m.selHash, base.selHash)
        assert.deepEqual(m.op, base.op)
        assert.deepEqual(m.sel.tagPerf, base.sel.tagPerf)
        assert(m.op.nOrders.every((x) => x > 0), '快照凍結 ⇒ accept 有下單')
        //不可結構化複製之 tag(函數)⇒ 拋錯
        assert.throws(() => ev.runPick(() => ({ ids: [1], tag: { f: () => 1 } }), 0), /可結構化複製/)
        //原始值與無法凍結之內容(Map)照常; Map 每個視窗另給複本
        let r = ev.runPick((ctx) => ({ ids: [1], tag: ctx.k % 2 ? 'x' : new Map([[1, ctx.k]]) }), 0)
        assert.equal(r.tags[1], 'x')
        assert(r.tags[0] instanceof Map && r.tags[0].get(1) === 0)
    })

    it('凍結擋不住之 tag(Map、RegExp)每次呼叫 accept 另給複本:accept 改它, 其後之訊號與其他模擬看到的仍是回傳當時之內容;下單與未改者相同', () => {
        //R-EV-35 ①: 同一份 tag 於同一視窗之各訊號、操作績效、新鮮度、虛無各模擬重複交給 accept; 共用時前一次之改寫會帶到後面
        let pick = (ctx) => ({ ids: idsOf(ctx), tag: ctx.k % 2 ? new Map([['k', ctx.k]]) : new RegExp(`k${ctx.k}`) })
        let valOf = (sig) => (sig.tag instanceof Map ? sig.tag.get('k') : sig.tag.source)
        let want = (sig) => (sig.k % 2 ? sig.k : `k${sig.k}`)
        let base = ev.evalPolicy(pick, { accept: (sig, book) => valOf(sig) === want(sig) && book.open < 3 })
        let calls = 0
        let bad = 0
        let m = ev.evalPolicy(pick, {
            accept: (sig, book) => {
                calls++
                let ok = valOf(sig) === want(sig)
                if (!ok) {
                    bad++
                }
                if (sig.tag instanceof Map) {
                    sig.tag.set('k', -1)
                }
                else {
                    try {
                        sig.tag.compile('changed')
                    }
                    catch (err) {}
                }
                return ok && book.open < 3
            },
        })
        assert(calls > 100)
        assert.equal(bad, 0, '每次呼叫皆為回傳當時之內容')
        assert.equal(m.selHash, base.selHash)
        assert.deepEqual(m.op, base.op)
    })

    it('accept 之兩次呼叫之間逐訊號模擬不經可被改寫之方法:accept 於第一次呼叫裝上會拋錯之替身、最後一次呼叫才還原, 結果與未裝者相同', () => {
        //R-EV-35 ②: 一批 accept 呼叫之間(模組之程式已執行而尚未比對)評估器只用擷取之參照與定型陣列(含損益依 tag 之歸因)
        let r = ev.runPick((ctx) => ({ ids: idsOf(ctx), tag: ctx.k % 3 }), 0, CFG.seed)
        let colOf = () => ({ strat: new Int32Array(L.n), bar: new Int32Array(L.nBars + 2), side: new Float64Array(8), tags: new Map(), grp: new Float64Array(16) })
        let colA = colOf()
        let ctl = ev.opOf(r.sels, r.bars, r.tags, (sig, book) => book.open < 3, { col: colA })
        let N = ctl.nSignals
        assert(N > 100)
        let targets = [
            [Math, 'imul'], [Math, 'floor'], [Math, 'max'], [Map.prototype, 'get'], [Map.prototype, 'set'], [WeakMap.prototype, 'get'], [WeakMap.prototype, 'has'],
            [JSON, 'stringify'], [String.prototype, 'slice'], [Array.prototype, 'push'], [TA_PROTO, 'fill'], [TA_PROTO, 'length'], [TA_PROTO, 'slice'],
        ]
        let fired = Object.create(null)
        let saved = null
        let c = 0
        let SENT = new Error('替身被呼叫')
        let accept = (sig, book) => {
            c++
            if (c === 1) {
                saved = targets.map(([o, k]) => [o, k, Object.getOwnPropertyDescriptor(o, k)])
                for (let [o, k, d] of saved) {
                    let stub = function () {
                        fired[k] = true
                        throw SENT
                    }
                    Object.defineProperty(o, k, d.get ? { ...d, get: stub } : { ...d, value: stub })
                }
            }
            if (c === N) {
                for (let i = 0; i < saved.length; i++) {
                    Object.defineProperty(saved[i][0], saved[i][1], saved[i][2])
                }
            }
            return book.open < 3
        }
        let colB = colOf()
        let o = keep(targets, () => ev.opOf(r.sels, r.bars, r.tags, accept, { col: colB }))
        assert.equal(c, N)
        assert.deepEqual(Object.keys(fired), [], `被呼叫之替身: ${Object.keys(fired).join(', ')}`)
        assert.deepEqual(o, ctl)
        assert.deepEqual([...colB.tags], [...colA.tags], '依 tag 之歸因相同')
        assert.deepEqual(Array.from(colB.side), Array.from(colA.side))
    })

    it('擴充診斷之 api 每個診斷各一份:前一個診斷改寫 api 之選集 / tag / meta, 後一個診斷看到的仍是原值', () => {
        //合約 §7: api 全為唯讀之複本 —— 一個診斷不得改到其他診斷之輸入(其輸出寫入結果檔)
        let pick = (ctx) => ({ ids: idsOf(ctx), tag: { k: ctx.k } })
        let accept = (sig, book) => book.open < 3
        let rec = (api) => ({ s0: api.phases[0].sels[0][0], t0: api.phases[0].tags[0].k, tie0: api.meta.tie[0], b0: api.phases[0].bars[0], obs0: api.obs.byPhase[0] })
        let m = ev.evalPolicy(pick, {
            accept,
            ext: [
                { name: 'before', fn: rec },
                {
                    name: 'mut',
                    fn: (api) => {
                        api.phases[0].sels[0][0] = 999
                        api.phases[0].bars[0] = -1
                        api.obs.byPhase[0] = -1
                        api.meta.tie[0] = 7
                        try {
                            api.phases[0].tags[0].k = -1
                        }
                        catch (err) {}
                        return { text: 'mut' }
                    },
                },
                { name: 'after', fn: rec },
            ],
        })
        let { ms: _a, ...before } = m.ext.before
        let { ms: _b, ...after } = m.ext.after
        assert.deepEqual(after, before)
        assert.equal(before.tie0, ev.meta.tie[0])
    })
})

describe('evalCore 內建物件之完整性(R-EV-35 ②):被改即評估失敗(EVAL_INTEGRITY)', function () {
    let t
    let L
    let ev
    before(() => {
        t = makeTmp('evalIntegrity2')
        writeSynthLedger(t.dir, { n: 60, nBars: 2400, seed: 6, series: ['a'] })
        L = loadLedger(t.dir)
        ev = makeEvaluator(L, CFG)
    })
    after(() => {
        t.cleanup()
    })
    let ids = (ctx) => [2, 5, 8, 11, 14, 17, 20, 23].map((s) => (s + ctx.k) % ctx.n)

    it('挑選函數內對內建原型之方法重新賦值 ⇒ runPick / evalPolicy 拋 code 為 EVAL_INTEGRITY 之錯誤(where = pick, items 指出該方法)', () => {
        let err = keep([[TA_PROTO, 'slice']], () => integrityOf(() => ev.runPick((ctx) => {
            TA_PROTO.slice = function () {
                return new Int32Array(0)
            }
            return ids(ctx)
        }, 0)))
        assert(err, '須拋錯')
        assert.equal(err.code, 'EVAL_INTEGRITY')
        assert.equal(err.where, 'pick')
        assert(err.items.includes('%TypedArray%.prototype.slice'), err.message)
        assert(/EVAL_INTEGRITY/.test(err.message) && /%TypedArray%\.prototype\.slice/.test(err.message))
        //全域綁定、新增之屬性亦然
        let err2 = keep([[Math, 'floor'], [Array.prototype, 'extra']], () => integrityOf(() => ev.evalPolicy((ctx) => {
            Math.floor = Math.ceil
            Array.prototype.extra = 1
            return ids(ctx)
        }, {})))
        assert.equal(err2 && err2.code, 'EVAL_INTEGRITY')
        assert(err2.items.includes('Math.floor') && err2.items.includes('Array.prototype.extra(新增)'), err2.message)
        //還原後照常
        assert.equal(typeof ev.evalPolicy(ids, {}).selHash, 'string')
    })

    it('挑選函數改而拋錯:仍以 EVAL_INTEGRITY 失敗(不被當成一般之執行錯誤)', () => {
        let err = keep([[Math, 'max']], () => integrityOf(() => ev.runPick(() => {
            Math.max = Math.min
            throw new Error('自己拋')
        }, 0)))
        assert.equal(err && err.code, 'EVAL_INTEGRITY')
        //未改而拋錯者: 原訊息照轉(評估器自建之錯誤)
        let err2 = integrityOf(() => ev.runPick(() => {
            throw new TypeError('自己拋')
        }, 0))
        assert.equal(String(err2), 'TypeError: 自己拋')
        assert.equal(err2.code, undefined)
    })

    it('runPick 開始前內建物件已被改(例: 模組之延後程式)⇒ 先拋 EVAL_INTEGRITY, 不執行評估器之一般程式', () => {
        //入口比對: runPick 開頭之一般寫法(決策棒之陣列等)須在比對之後才執行
        let fired = Object.create(null)
        let SENT = new Error('替身被呼叫')
        let err = keep([[Array.prototype, 'push']], () => {
            Object.defineProperty(Array.prototype, 'push', {
                ...Object.getOwnPropertyDescriptor(Array.prototype, 'push'),
                value: function () {
                    fired.push = true
                    throw SENT
                },
            })
            return integrityOf(() => ev.runPick(ids, 0))
        })
        assert.equal(err && err.code, 'EVAL_INTEGRITY', String(err))
        assert(err.items.includes('Array.prototype.push'))
        assert.deepEqual(Object.keys(fired), [])
    })

    it('accept 內對內建物件重新賦值 ⇒ evalPolicy 拋 EVAL_INTEGRITY(where = accept)', () => {
        let n = 0
        let err = keep([[Math, 'imul']], () => integrityOf(() => ev.evalPolicy(ids, {
            accept: (sig, book) => {
                if (++n === 3) {
                    Math.imul = (a, b) => a * b
                }
                return book.open < 3
            },
        })))
        assert.equal(err && err.code, 'EVAL_INTEGRITY')
        assert.equal(err.where, 'accept')
        assert(err.items.includes('Math.imul'))
    })

    //STUB_TARGETS, 評估器之 ctx 各函數原本會經過之內建方法(原型之方法、存取子、靜態函數)
    let stubTargets = () => [
        [TA_PROTO, 'slice'], [TA_PROTO, 'subarray'], [TA_PROTO, 'set'], [TA_PROTO, 'fill'], [TA_PROTO, 'length'], [TA_PROTO, 'buffer'], [TA_PROTO, 'byteOffset'], [TA_PROTO, 'byteLength'],
        [Object.getPrototypeOf(Int8Array), 'from'], [ArrayBuffer.prototype, 'slice'],
        [Map.prototype, 'get'], [Map.prototype, 'set'], [Map.prototype, 'has'], [Set.prototype, 'has'], [Set.prototype, 'add'],
        [Array.prototype, 'push'], [Array.prototype, 'join'],
        [Math, 'floor'], [Math, 'round'], [Math, 'max'], [Math, 'min'], [Math, 'imul'], [Number, 'isInteger'], [Number, 'isFinite'],
    ]
    //withStubs, 把 targets 換成會拋錯之替身後執行 fn, 結束即還原; 替身只記名稱(不呼叫任何內建方法, 免得替身遞迴)
    let withStubs = (targets, fired, fn) => keep(targets, () => {
        let SENT = new Error('替身被呼叫')
        for (let [o, k] of targets) {
            let d = Object.getOwnPropertyDescriptor(o, k)
            let stub = function () {
                fired[k] = true
                throw SENT
            }
            Object.defineProperty(o, k, d.get ? { ...d, get: stub } : { ...d, value: stub })
        }
        return fn()
    })

    it('ctx 之各函數只用擷取之參照:挑選函數執行期間把相關之內建方法換成會拋錯之替身(呼叫完即還原), 各函數照常回傳、替身未被呼叫', () => {
        //R-EV-35 ②: 同一次呼叫之內改而又改回者偵測不到 ⇒ 其間評估器不得經可被改寫之方法處理帳本(否則被換掉之方法之 this 即帳本之欄)
        let L2 = loadLedger(t.dir)
        assert(L2.fac && L2.ser, '先讀入延遲讀取之兩欄(另一案驗未讀入者)')
        let ev2 = makeEvaluator(L2, CFG)
        let targets = stubTargets()
        let fired = Object.create(null)
        let results = []
        let nDec = 0
        ev2.runPick((ctx) => {
            nDec++
            if (ctx.k % 5 !== 0) {
                return []
            }
            let calls = [
                () => ctx.entryBars(3, 30), () => ctx.exitBars(3, 30), () => ctx.entryDays(3, 30), () => ctx.exitDays(3, 30), () => ctx.orders(3),
                () => ctx.stat(30), () => ctx.stat(0), () => ctx.market(10), () => ctx.factor(1, 50), () => ctx.series('a', 20), () => ctx.rand(),
            ]
            let out = new Array(calls.length)
            withStubs(targets, fired, () => {
                for (let i = 0; i < calls.length; i++) {
                    try {
                        out[i] = calls[i]()
                    }
                    catch (err) {
                        out[i] = err
                    }
                }
            })
            //替身已還原: 以一般寫法核對結果
            results.push(out.map((x) => (x instanceof Error ? `ERR ${x.message}` : 'ok')))
            assert(out[0] instanceof Int32Array && Array.from(out[0]).every((v) => v < ctx.bar), 'entryBars 只含決策棒以前')
            assert(out[8] instanceof Float64Array && out[8].length === Math.min(50, ctx.bar))
            assert(out[9] instanceof Float64Array && out[9].length === Math.min(20, ctx.bar))
            return []
        }, 0)
        assert(nDec > 10)
        assert.deepEqual(Object.keys(fired), [], `被呼叫之替身: ${Object.keys(fired).join(', ')}`)
        assert(results.every((r) => r.every((x) => x === 'ok')), JSON.stringify(results[0]))
    })

    it('延遲讀取之帳本欄(L.fac / L.ser)於內建物件被改之期間不讀入(拒讀並拋 EVAL_INTEGRITY);改回後照常讀入', () => {
        //Node 之 fs.readFileSync 會經 %TypedArray%.prototype.byteLength 取得讀入用之緩衝區 ⇒ 延遲讀取前先比對
        let L3 = loadLedger(t.dir)
        let ev3 = makeEvaluator(L3, CFG)
        let fired = Object.create(null)
        let got = null
        let after = null
        //挑選函數攔下拒讀之錯誤並改回: 拒讀照舊(未經替身)、改回後讀得到; 但已偵測到被改 ⇒ 該次 runPick 仍以 EVAL_INTEGRITY 失敗(黏著)
        let errRun = integrityOf(() => ev3.runPick((ctx) => {
            if (ctx.k === 0) {
                let err = null
                withStubs([[TA_PROTO, 'byteLength']], fired, () => {
                    try {
                        ctx.factor(1, 5)
                    }
                    catch (e) {
                        err = e
                    }
                })
                got = err
                after = [ctx.factor(1, 5).length, ctx.series('a', 5).length]
            }
            return []
        }, 0))
        assert.equal(got && got.code, 'EVAL_INTEGRITY')
        assert.equal(got.where, 'ledger-read')
        assert.deepEqual(Object.keys(fired), [], '拒讀: 未經替身')
        assert.deepEqual(after, [5, 5], '改回後照常讀入')
        assert.equal(errRun && errRun.code, 'EVAL_INTEGRITY', '已偵測者該次評估失敗')
        assert.equal(errRun.where, 'ledger-read')
    })

    it('比對本身不經可被改寫之寫法:Array.prototype 之索引被裝上 setter ⇒ 照常拋 EVAL_INTEGRITY, setter 未被呼叫', () => {
        let fired = Object.create(null)
        //Array.prototype 本身是陣列: 定義索引 '0' 會使其 length 變為 1(刪除 '0' 不會變回)⇒ 一併還原 length
        let err = keep([[Array.prototype, '0'], [Array.prototype, 'length']], () => {
            Object.defineProperty(Array.prototype, '0', {
                configurable: true,
                set: function () {
                    fired.set = true
                    throw new Error('setter')
                },
            })
            return integrityOf(() => ev.runPick(ids, 0))
        })
        assert.equal(err && err.code, 'EVAL_INTEGRITY', String(err))
        assert(err.items.includes('Array.prototype.0(新增)'), err.message)
        assert.deepEqual(Object.keys(fired), [])
    })

    it('延遲讀取前之比對涵蓋 Buffer.prototype(Node 之 fs.readSync 經它查 byteLength):於其上新增存取子 ⇒ 拒讀', () => {
        let L4 = loadLedger(t.dir)
        let ev4 = makeEvaluator(L4, CFG)
        let fired = Object.create(null)
        let got = null
        let err = keep([[Buffer.prototype, 'byteLength']], () => integrityOf(() => ev4.runPick((ctx) => {
            if (ctx.k === 0) {
                Object.defineProperty(Buffer.prototype, 'byteLength', {
                    configurable: true,
                    get: function () {
                        fired.byteLength = true
                        return 0
                    },
                })
                try {
                    ctx.factor(1, 5)
                }
                catch (e) {
                    got = e
                }
                delete Buffer.prototype.byteLength
            }
            return []
        }, 0)))
        assert.equal(got && got.code, 'EVAL_INTEGRITY', String(got))
        assert(got.items.includes('Buffer.prototype.byteLength(新增)'), got.message)
        assert.deepEqual(Object.keys(fired), [], '拒讀: 未經該存取子')
        assert.equal(err && err.code, 'EVAL_INTEGRITY', '已偵測者該次評估失敗')
        //完整性錯誤物件凍結: 攔下者改不了其欄位
        assert(Object.isFrozen(got) && Object.isFrozen(got.items))
        assert.throws(() => {
            got.code = 'X'
        }, TypeError)
    })

    it('ctx.orders 與擴充診斷之 simulate 收集陣列時不觸發 Array.prototype 上之索引 setter', () => {
        //pushOwn: 以定義自有元素收集(push 之 [[Set]] 會呼叫原型上同名索引之 setter)
        let fired = Object.create(null)
        let setter = function () {
            fired.set = true
            throw new Error('setter')
        }
        let out = null
        let nOrd = null
        keep([[Array.prototype, '0'], [Array.prototype, 'length']], () => {
            ev.runPick((ctx) => {
                if (ctx.k === 2) {
                    Object.defineProperty(Array.prototype, '0', { configurable: true, set: setter })
                    try {
                        out = ctx.orders(3)
                    }
                    finally {
                        delete Array.prototype[0]
                        Array.prototype.length = 0
                    }
                    nOrd = out.length
                }
                return []
            }, 0)
        })
        assert(nOrd > 0 && Object.prototype.hasOwnProperty.call(out, 0), '訂單為自有元素')
        //simulate 第一段: 內部陣列不經 setter; 其後之比對偵測到被改
        let err = keep([[Array.prototype, '0'], [Array.prototype, 'length']], () => integrityOf(() => ev.evalPolicy(ids, {
            ext: [{
                name: 's',
                fn: (api) => {
                    let sels = [api.phases[0].sels, api.phases[1].sels]
                    Object.defineProperty(Array.prototype, '0', { configurable: true, set: setter })
                    return { r: api.simulate(sels).mean }
                },
            }],
        })))
        assert.deepEqual(Object.keys(fired), [])
        assert.equal(err && err.code, 'EVAL_INTEGRITY', String(err))
    })

    it('pick 返回即使 ctx 失效:回傳物件之存取子再呼叫 ctx 之函數 ⇒ 拋錯', () => {
        let err = integrityOf(() => ev.runPick((ctx) => ({
            get ids() {
                return [ctx.entryBars(3).length % ctx.n]
            },
        }), 0))
        assert(err && /只在該次 pick 呼叫內有效/.test(err.message), String(err))
    })

    it('評估器交給呼叫端之各方法與 loadLedger 之入口比對:呼叫前內建物件已被改 ⇒ 先拋 EVAL_INTEGRITY, 替身未被呼叫', () => {
        //opOf / freshOf / nullOf / … / loadLedger 為呼叫端可直接呼叫之入口(呼叫端可能在 await 之後呼叫)
        let r = ev.runPick(ids, 0, CFG.seed)
        let calls = [
            () => ev.opOf(r.sels, r.bars, r.tags, null),
            () => ev.freshOf(r.sels, r.bars, r.tags, null, 3),
            () => ev.nullOf([{ ...r, k0: 0 }], null, 2, 1),
            () => ev.nullActOf([{ ...r, k0: 0 }], null, 2, 1),
            () => ev.nullSideActOf([{ ...r, k0: 0 }], null, 2, 1),
            () => ev.nullSideGeoOf([{ ...r, k0: 0 }], null, 2, 1),
            () => ev.sideGeoGroups(3, 3),
            () => ev.simWindows([{ b: r.bars[0], e: r.bars[0] + 42, sel: r.sels[0], tag: null, k: 0 }], null),
            () => ev.decisionBars(0),
            () => ev.timeOf(10),
            () => loadLedger(t.dir),
        ]
        let fired = Object.create(null)
        //替身期間本測試自己也不用 map / push(只以索引寫入預先配好之陣列)
        let codes = new Array(calls.length).fill('')
        withStubs([[Array.prototype, 'map'], [Array.prototype, 'push'], [TA_PROTO, 'fill'], [TA_PROTO, 'subarray'], [JSON, 'parse']], fired, () => {
            for (let i = 0; i < calls.length; i++) {
                try {
                    calls[i]()
                    codes[i] = 'ok'
                }
                catch (e) {
                    codes[i] = e === null || typeof e !== 'object' ? 'x' : (e.code || 'other')
                }
            }
        })
        assert.deepEqual(codes, calls.map(() => 'EVAL_INTEGRITY'))
        assert.deepEqual(Object.keys(fired), [])
        //未被改時照常
        assert.equal(typeof ev.opOf(r.sels, r.bars, r.tags, null).eqYr, 'number')
    })

    it('evalPolicy 之入口比對:呼叫前內建物件已被改 ⇒ 先拋 EVAL_INTEGRITY, 不執行其下之一般寫法', () => {
        let fired = Object.create(null)
        let err = keep([[Array.prototype, 'map']], () => {
            Object.defineProperty(Array.prototype, 'map', {
                ...Object.getOwnPropertyDescriptor(Array.prototype, 'map'),
                value: function () {
                    fired.map = true
                    throw new Error('替身被呼叫')
                },
            })
            return integrityOf(() => ev.evalPolicy(ids, {}))
        })
        assert.equal(err && err.code, 'EVAL_INTEGRITY', String(err))
        assert.deepEqual(Object.keys(fired), [])
    })

    it('ctx 之函數只在該次 pick 呼叫內有效:保留舊 ctx 於其後之決策或 accept 內呼叫 ⇒ 拋錯(不以較晚之游標回傳)', () => {
        //R-EV-35 ①: ctx 之閉包共用各策略之游標; 呼叫結束後再呼叫會回傳較晚之單
        let kept = null
        let errs = []
        ev.runPick((ctx) => {
            if (ctx.k === 0) {
                kept = ctx
            }
            else if (ctx.k === 1) {
                for (let f of ['stat', 'orders', 'entryDays', 'entryBars', 'exitDays', 'exitBars', 'market', 'factor', 'series', 'rand']) {
                    try {
                        f === 'series' ? kept.series('a', 5) : f === 'stat' || f === 'market' ? kept[f](5) : f === 'factor' ? kept.factor(0, 5) : f === 'rand' ? kept.rand() : kept[f](3)
                        errs.push(`${f}: 未拋錯`)
                    }
                    catch (e) {
                        if (!/只在該次 pick 呼叫內有效/.test(e.message)) {
                            errs.push(`${f}: ${e.message}`)
                        }
                    }
                }
            }
            return ids(ctx)
        }, 0)
        assert.deepEqual(errs, [])
        //accept 內呼叫保留之 ctx ⇒ 評估失敗
        let last = null
        let err = integrityOf(() => ev.evalPolicy((ctx) => {
            last = ctx
            return ids(ctx)
        }, {
            accept: (sig, book) => last.entryBars(3).length >= 0 && book.open < 3,
        }))
        assert(err && /只在該次 pick 呼叫內有效/.test(err.message), String(err))
    })

    it('tag 不得含共享記憶體(含在 Map / Set / 定型陣列內者)與符號', () => {
        //快照以結構化複製取得, 但共享記憶體之複本仍與原值共用記憶體 ⇒ 拒收
        let mk = [
            () => ({ ids: [1], tag: new Map([['b', new SharedArrayBuffer(8)]]) }),
            () => ({ ids: [1], tag: new Set([new Int32Array(new SharedArrayBuffer(8))]) }),
            () => ({ ids: [1], tag: { a: [new SharedArrayBuffer(8)] } }),
            () => ({ ids: [1], tag: Symbol('x') }),
        ]
        for (let f of mk) {
            assert.throws(() => ev.runPick(f, 0), /可結構化複製/)
        }
    })

    it('擴充診斷之執行規則內再呼叫 simulate(重入)⇒ 該呼叫拋錯, 不改外層模擬', () => {
        let pick = (ctx) => ({ ids: ids(ctx), tag: ctx.k % 2 })
        let accept = (sig, book) => book.open < 3
        let m = ev.evalPolicy(pick, {
            accept,
            ext: [{
                name: 'nest',
                fn: (api) => {
                    let sels = api.phases.map((p) => p.sels)
                    let base = api.simulate(sels, null, { accept: () => true })
                    let i = 0
                    let msg = null
                    let nested = api.simulate(sels, null, {
                        accept: () => {
                            if (++i === 3) {
                                try {
                                    api.simulate(sels, null, { accept: () => true })
                                }
                                catch (e) {
                                    msg = e.message
                                }
                            }
                            return true
                        },
                    })
                    return { same: base.mean === nested.mean && JSON.stringify(base.bySide) === JSON.stringify(nested.bySide), msg }
                },
            }],
        })
        assert.equal(m.ext.nest.same, true, JSON.stringify(m.ext.nest))
        assert(/重入/.test(m.ext.nest.msg), JSON.stringify(m.ext.nest))
    })

    it('擴充診斷呼叫 api 之函數時不經可被改寫之迭代器:裝上「呼叫一次即自我還原」之迭代器後呼叫 api ⇒ 迭代器未被呼叫、評估失敗', () => {
        let calls = 0
        let pick = (ctx) => ids(ctx)
        let err = keep([[Array.prototype, Symbol.iterator]], () => integrityOf(() => ev.evalPolicy(pick, {
            ext: [{
                name: 'it',
                fn: (api) => {
                    let orig = Array.prototype[Symbol.iterator]
                    Array.prototype[Symbol.iterator] = function () {
                        calls++
                        Array.prototype[Symbol.iterator] = orig
                        return orig.call(this)
                    }
                    try {
                        return { g: api.geoGroups(3, 3).nGroups }
                    }
                    finally {
                        Array.prototype[Symbol.iterator] = orig
                    }
                },
            }],
        })))
        assert.equal(calls, 0)
        assert.equal(err && err.code, 'EVAL_INTEGRITY', String(err))
        assert(err.items.includes('Array.prototype.[Symbol(Symbol.iterator)]'), err.message)
    })

    it('擴充診斷之 api.market / api.factor / api.series 於內建物件被改時與既有之 api 函數(geoGroups)一致:入口比對 ⇒ 該次呼叫拋 EVAL_INTEGRITY(where = ext)、替身未被呼叫、bar 之判定(iseint)於比對之後才執行;診斷攔下並改回者該次評估仍失敗', () => {
        //R-EV-36 / R-EV-35 ②: 三個新介面經 apiFn / guardExt 包裝(同既有之 api 函數); 內建物件被改 ⇒ 入口比對即拋, 不執行其下之一般寫法(含 wsemi 之 iseint: bar 以數字字串給, 其判定經 String.prototype.trim 與 RegExp.prototype.test)
        let calls = {
            market: (api) => api.market('12', 5),
            factor: (api) => api.factor(1, '12', 5),
            series: (api) => api.series('a', '12', 5),
            geoGroups: (api) => api.geoGroups(3, 3),
        }
        let targets = [
            [Math, 'round', 'Math.round'], [Math, 'min', 'Math.min'], [Math, 'max', 'Math.max'],
            [Number, 'isInteger', 'Number.isInteger'], [Number, 'isSafeInteger', 'Number.isSafeInteger'],
            [TA_PROTO, 'set', '%TypedArray%.prototype.set'], [Map.prototype, 'get', 'Map.prototype.get'],
            [String.prototype, 'trim', 'String.prototype.trim'], [RegExp.prototype, 'test', 'RegExp.prototype.test'],
        ]
        for (let [nm, call] of Object.entries(calls)) {
            for (let [o, k, label] of targets) {
                let fired = Object.create(null)
                let inner = null
                let err = integrityOf(() => ev.evalPolicy(ids, {
                    phases: [0],
                    nullDraws: 0,
                    ext: [{
                        name: 'x',
                        fn: (api) => {
                            withStubs([[o, k]], fired, () => {
                                try {
                                    call(api)
                                }
                                catch (e) {
                                    inner = e
                                }
                            })
                            return { text: 'x' }
                        },
                    }],
                }))
                let w = `${nm} × ${label}`
                assert.equal(inner && inner.code, 'EVAL_INTEGRITY', `${w}: 入口比對`)
                assert.equal(inner.where, 'ext', w)
                assert(inner.items.includes(label), `${w}: ${inner.items}`)
                assert.deepEqual(Object.keys(fired), [], `${w}: 替身未被呼叫`)
                assert.equal(err && err.code, 'EVAL_INTEGRITY', `${w}: 診斷攔下並改回, 該次評估仍失敗`)
            }
        }
        //未被改時照常
        let m = ev.evalPolicy(ids, { phases: [0], nullDraws: 0, ext: [{ name: 'ok', fn: (api) => ({ m: api.market('12', 5).close.length, f: api.factor(1, '12', 5).length, s: api.series('a', '12', 5).length }) }] })
        assert.deepEqual([m.ext.ok.m, m.ext.ok.f, m.ext.ok.s], [5, 5, 5])
    })

    it('擴充診斷之 api.market 之 nBack 於呼叫中(其 valueOf)改內建物件:該次回傳仍正確(只用擷取之參照,替身未被呼叫)、評估以 EVAL_INTEGRITY 失敗;api.factor / api.series 之物件型 nBack 不被呼叫任何方法(同 ctx 之慣例)', () => {
        //R-EV-36: 共用之取值(marketAt)只用擷取之參照(MathMin / MathMax 等); 改而不改回者於其後之比對偵測到
        let fired = Object.create(null)
        let got = null
        let ref = null
        let err = keep([[Math, 'min'], [Math, 'max']], () => integrityOf(() => ev.evalPolicy(ids, {
            phases: [0],
            nullDraws: 0,
            ext: [{
                name: 'x',
                fn: (api) => {
                    ref = api.market(700, 3)
                    let nb = {
                        valueOf() {
                            let stub = function () {
                                fired.minmax = true
                                throw new Error('替身被呼叫')
                            }
                            Math.min = stub
                            Math.max = stub
                            return 3
                        },
                    }
                    got = api.market(700, nb)
                    return { text: 'x' }
                },
            }],
        })))
        assert.equal(err && err.code, 'EVAL_INTEGRITY', String(err))
        assert.equal(err.where, 'ext')
        assert(err.items.includes('Math.min') && err.items.includes('Math.max'), err.message)
        assert.deepEqual(Object.keys(fired), [], '替身未被呼叫')
        let MKS = ['open', 'high', 'low', 'close', 'volume']
        assert(got && ref && MKS.every((k) => got[k].length === 3 && Buffer.compare(Buffer.from(got[k].buffer), Buffer.from(ref[k].buffer)) === 0), '該次回傳與未被改者相同')
        //api.factor / api.series: 物件型 nBack 非有限數 ⇒ 0 根, 不呼叫其 valueOf / toString(慣例同 ctx.factor / ctx.series)
        let called = 0
        let obj = {
            valueOf() {
                called++
                return 3
            },
            toString() {
                called++
                return '3'
            },
        }
        let m = ev.evalPolicy(ids, { phases: [0], nullDraws: 0, ext: [{ name: 'y', fn: (api) => ({ f: api.factor(0, 700, obj).length, s: api.series('a', 700, obj).length }) }] })
        assert.deepEqual([m.ext.y.f, m.ext.y.s, called], [0, 0, 0])
    })

    it('擴充診斷之函數內改內建物件 ⇒ 評估失敗(where = ext);診斷攔下 api 內之錯誤並改回者亦然', () => {
        let pick = (ctx) => ({ ids: ids(ctx), tag: ctx.k % 2 })
        let accept = (sig, book) => book.open < 3
        let err = keep([[JSON, 'parse']], () => integrityOf(() => ev.evalPolicy(pick, {
            accept,
            ext: [{
                name: 'x',
                fn: () => {
                    JSON.parse = () => ({})
                    return { text: 'x' }
                },
            }],
        })))
        assert.equal(err && err.code, 'EVAL_INTEGRITY')
        assert.equal(err.where, 'ext')
        assert(err.items.includes('JSON.parse'))
        //攔錯並改回: api 之入口偵測到 ⇒ 該次評估仍失敗
        let orig = Array.prototype.map
        let err2 = keep([[Array.prototype, 'map']], () => integrityOf(() => ev.evalPolicy(pick, {
            accept,
            ext: [{
                name: 'y',
                fn: (api) => {
                    let sels = []
                    for (let p of api.phases) {
                        sels.push(p.sels)
                    }
                    Array.prototype.map = function () {
                        return []
                    }
                    try {
                        api.simulate(sels)
                    }
                    catch (e) {}
                    Array.prototype.map = orig
                    return { text: 'y' }
                },
            }],
        })))
        assert.equal(err2 && err2.code, 'EVAL_INTEGRITY')
        assert(err2.items.includes('Array.prototype.map'))
        //simulate 之 opts.accept(診斷自己之執行規則)改內建物件: 逐訊號模擬結束時偵測到; 診斷攔下並改回者該次評估仍失敗
        let err3 = keep([[Math, 'hypot']], () => integrityOf(() => ev.evalPolicy(pick, {
            accept,
            ext: [{
                name: 'z',
                fn: (api) => {
                    let o = Math.hypot
                    try {
                        api.simulate(api.phases.map((p) => p.sels), null, {
                            accept: (sig, book) => {
                                Math.hypot = Math.max
                                return book.open < 3
                            },
                        })
                    }
                    catch (e) {}
                    Math.hypot = o
                    return { text: 'z' }
                },
            }],
        })))
        assert.equal(err3 && err3.code, 'EVAL_INTEGRITY')
        assert.equal(err3.where, 'accept')
        assert(err3.items.includes('Math.hypot'))
        //診斷之一般錯誤: 照舊只記於該列
        let m = ev.evalPolicy(pick, {
            accept,
            ext: [{
                name: 'boom',
                fn: () => {
                    throw new Error('壞了')
                },
            }],
        })
        assert(/壞了/.test(m.ext.boom.error))
    })

    it('模組頂層改內建物件 ⇒ loadPick 拋 EVAL_INTEGRITY(where = pick-load);meta 為快照', async () => {
        let fp = path.join(t.dir, 'top.mjs')
        fs.writeFileSync(fp, 'Math.trunc = Math.floor\nexport const meta = { desc: "d" }\nexport default function pick(ctx) { return [] }\n', 'utf8')
        let err = await keepAsync([[Math, 'trunc']], async () => {
            try {
                await loadPick(fp)
            }
            catch (e) {
                return e
            }
            return null
        })
        assert.equal(err && err.code, 'EVAL_INTEGRITY')
        assert.equal(err.where, 'pick-load')
        assert(err.items.includes('Math.trunc'))
        //合法之模組: meta 為快照(改回傳者不影響再次載入; 與 JSON 往返相同)
        let fp2 = path.join(t.dir, 'ok.mjs')
        fs.writeFileSync(fp2, 'export const meta = { desc: "d", params: { a: 1 } }\nexport default function pick(ctx) { return [] }\n', 'utf8')
        let pk = await loadPick(fp2)
        assert.deepEqual(pk.meta, { desc: 'd', params: { a: 1 } })
    })
})

describe('命令列(src/cli/eval.mjs):挑選模組 / 擴充診斷模組之載入處比對內建物件', function () {
    let t
    let root
    let pickOk
    before(() => {
        t = makeTmp('evalIntegrityCli')
        root = path.join(t.dir, 'proj')
        writeSynthLedger(path.join(root, 'ledger', 'eval'), { n: 60, nBars: 2400, seed: 7, series: ['ser_a'] })
        fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
        //期間: 帳本起點 2022-07-01, 4 小時棒 2400 根(400 日); 回測期自第 200 日起
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
            periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-01-17T00:00:00', end: '2023-08-05T00:00:00' } },
            eval: { ledgerDir: './ledger/eval', warmupDays: 60, cadenceDays: 7, phases: [0], horizons: [7], nullDraws: 4, seed: 1, limits: { monthlyOrders: 400, peakHold: 50 } },
            score: { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] },
            rsi: { root: './rsi' },
            records: {},
            dispatch: {},
        }), 'utf8')
        pickOk = path.join(root, 'pick_ok.mjs')
        fs.writeFileSync(pickOk, 'export default function pick(ctx) { return [1, 4, 7, 10, 13, 16].map((s) => (s + ctx.k) % ctx.n) }\nexport function accept(sig, book) { return book.open < 3 }\n', 'utf8')
    })
    after(() => {
        t.cleanup()
    })
    let run = (args) => {
        let env = { ...process.env, ARSI_ROOT: root }
        delete env.ARSI_HARNESS
        let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'eval.mjs'), ...args], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
        return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
    }

    it('合法之模組照常(對照)', () => {
        let r = run(['--pick', pickOk, '--mode', 'quick'])
        assert.equal(r.status, 0, r.out.slice(0, 800))
        assert(/selHash [0-9a-f]{20}/.test(r.out))
    })

    it('挑選模組頂層改內建物件 ⇒ ERROR EVAL_INTEGRITY、離開碼 3、結果檔 code = EVAL_INTEGRITY', () => {
        let fp = path.join(root, 'pick_top.mjs')
        fs.writeFileSync(fp, 'Math.trunc = Math.floor\nexport default function pick(ctx) { return [1, 2, 3] }\n', 'utf8')
        let fpOut = path.join(root, 'out_top.json')
        let r = run(['--pick', fp, '--mode', 'quick', '--out', fpOut])
        assert.equal(r.status, 3, r.out.slice(0, 800))
        assert(/ERROR EVAL_INTEGRITY/.test(r.out) && /Math\.trunc/.test(r.out))
        let o = JSON.parse(fs.readFileSync(fpOut, 'utf8'))
        assert.equal(o.ok, false)
        assert.equal(o.code, 'EVAL_INTEGRITY')
        assert(o.items.includes('Math.trunc'))
    })

    it('內建物件被改之後寫出之失敗結果檔與評估紀錄不經原型上之 toJSON;console 被換 ⇒ 偵測到', () => {
        //Object.prototype.toJSON 被加上 ⇒ 一般之 JSON.stringify 會改寫輸出; 失敗結果須仍為 { ok: false, code: 'EVAL_INTEGRITY' }
        let fp = path.join(root, 'pick_tojson.mjs')
        fs.writeFileSync(fp, 'Object.defineProperty(Object.prototype, "toJSON", { value: function () { return { ok: true } }, configurable: true })\nexport default function pick(ctx) { return [1, 2, 3] }\n', 'utf8')
        let fpOut = path.join(root, 'out_tojson.json')
        let r = run(['--pick', fp, '--mode', 'quick', '--out', fpOut])
        assert.equal(r.status, 3, r.out.slice(0, 800))
        assert(/ERROR EVAL_INTEGRITY/.test(r.out) && /Object\.prototype\.toJSON/.test(r.out), r.out.slice(0, 800))
        let o = JSON.parse(fs.readFileSync(fpOut, 'utf8'))
        assert.equal(o.ok, false)
        assert.equal(o.code, 'EVAL_INTEGRITY')
        assert(o.items.includes('Object.prototype.toJSON(新增)'))
        //console.log 被換(保留期檢定之旗標經 console.log 輸出)⇒ 偵測到; 錯誤訊息以擷取之 console.log 印出
        let fp2 = path.join(root, 'pick_console.mjs')
        fs.writeFileSync(fp2, 'console.log = function () {}\nexport default function pick(ctx) { return [1, 2, 3] }\n', 'utf8')
        let r2 = run(['--pick', fp2, '--mode', 'quick'])
        assert.equal(r2.status, 3, r2.out.slice(0, 800))
        assert(/ERROR EVAL_INTEGRITY/.test(r2.out) && /console\.log/.test(r2.out), r2.out.slice(0, 800))
    })

    it('挑選模組排入延後執行之程式(微任務)於載入後才改內建物件 ⇒ 讀帳本前或評估時偵測到, 離開碼 3', () => {
        let fp = path.join(root, 'pick_later.mjs')
        fs.writeFileSync(fp, 'Promise.resolve().then(() => 0).then(() => 0).then(() => 0).then(() => { Math.trunc = Math.floor })\nexport default function pick(ctx) { return [1, 2, 3] }\n', 'utf8')
        let r = run(['--pick', fp, '--mode', 'quick'])
        assert.equal(r.status, 3, r.out.slice(0, 800))
        assert(/ERROR EVAL_INTEGRITY/.test(r.out) && /Math\.trunc/.test(r.out))
    })

    it('資源閘之等待期間(載入後之 await)才裝上之「呼叫一次即自我還原」之替身 ⇒ 讀帳本前偵測到(where = before-ledger), 離開碼 3', () => {
        //讀帳本前之比對: 載入後之 await 期間模組之延後程式可改內建物件; 若在讀帳本時才被呼叫並自我還原, 其後之比對皆驗不到
        let root2 = path.join(t.dir, 'proj_gate')
        fs.cpSync(root, root2, { recursive: true })
        let st = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'))
        st.resources = { cpuMax: 100, ramUsedMaxGB: 100000, evalMaxWaitSec: 1 }
        fs.writeFileSync(path.join(root2, 'settings.json'), JSON.stringify(st), 'utf8')
        let fp = path.join(root2, 'pick_gate.mjs')
        let chain = 'Promise.resolve()' + '.then(() => 0)'.repeat(11)
        fs.writeFileSync(fp, `${chain}.then(() => { let o = JSON.parse; JSON.parse = function (s) { JSON.parse = o; return o(s) } })\nexport default function pick(ctx) { return [1, 2, 3] }\n`, 'utf8')
        let fpOut = path.join(root2, 'out_gate.json')
        let env = { ...process.env, ARSI_ROOT: root2 }
        delete env.ARSI_HARNESS
        let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'eval.mjs'), '--pick', fp, '--mode', 'quick', '--out', fpOut], { cwd: root2, env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
        assert.equal(r.status, 3, `${r.stdout}\n${r.stderr}`.slice(0, 800))
        let o = JSON.parse(fs.readFileSync(fpOut, 'utf8'))
        assert.equal(o.code, 'EVAL_INTEGRITY')
        assert.equal(o.where, 'before-ledger')
        assert(o.items.includes('JSON.parse'))
    })

    it('擴充診斷模組頂層改內建物件:--ext-test ⇒ EXT_FAIL、離開碼 4;完整評估自 metrics/ 載入 ⇒ ERROR EVAL_INTEGRITY、離開碼 3', () => {
        let fpExt = path.join(root, 'rsi', 'toolbox', 'metrics', 'bad_top.mjs')
        fs.writeFileSync(fpExt, 'Math.hypot = Math.max\nexport default function (api) { return { text: "ok" } }\n', 'utf8')
        try {
            let r1 = run(['--pick', pickOk, '--ext-test', fpExt])
            assert.equal(r1.status, 4, r1.out.slice(0, 800))
            assert(/EXT_FAIL bad_top\.mjs: EVAL_INTEGRITY/.test(r1.out) && /Math\.hypot/.test(r1.out), r1.out.slice(0, 800))
            let r2 = run(['--pick', pickOk, '--mode', 'full'])
            assert.equal(r2.status, 3, r2.out.slice(0, 800))
            assert(/ERROR EVAL_INTEGRITY/.test(r2.out) && /Math\.hypot/.test(r2.out))
        }
        finally {
            fs.rmSync(fpExt, { force: true })
        }
    })

    it('擴充診斷之函數內改內建物件:--ext-test ⇒ EXT_FAIL(EVAL_INTEGRITY)、離開碼 4;合法之診斷 EXT_OK', () => {
        let fpExt = path.join(root, 'rsi', 'toolbox', 'metrics', 'bad_fn.mjs')
        fs.writeFileSync(fpExt, 'export default function (api) { Math.hypot = Math.max; return { text: "ok" } }\n', 'utf8')
        let fpGood = path.join(root, 'rsi', 'toolbox', 'metrics', 'good.mjs')
        fs.writeFileSync(fpGood, 'export default function (api) { let r = api.simulate(api.phases.map((p) => p.sels)); return { text: "mean " + r.mean.toFixed(2) } }\n', 'utf8')
        try {
            let r1 = run(['--pick', pickOk, '--ext-test', fpExt])
            assert.equal(r1.status, 4, r1.out.slice(0, 800))
            assert(/EXT_FAIL bad_fn: EVAL_INTEGRITY/.test(r1.out), r1.out.slice(0, 800))
            let r2 = run(['--pick', pickOk, '--ext-test', fpGood])
            assert.equal(r2.status, 0, r2.out.slice(0, 800))
            assert(/EXT_OK good/.test(r2.out))
        }
        finally {
            fs.rmSync(fpExt, { force: true })
            fs.rmSync(fpGood, { force: true })
        }
    })

    it('擴充診斷用 api.market / api.factor / api.series(R-EV-36):--ext-test ⇒ EXT_OK;bar 不合者 ⇒ EXT_FAIL、訊息指明介面與範圍而不帶輸入值', () => {
        //命令列之試跑與完整評估同一條路徑(載入診斷、以 api 執行); 範例診斷依各決策之決策棒以前之序列取值
        let fpUse = path.join(root, 'rsi', 'toolbox', 'metrics', 'use_data.mjs')
        fs.writeFileSync(fpUse, 'export default function (api) { let p = api.phases[0]; let bar = p.bars[p.bars.length - 1]; let s = api.series("ser_a", bar, 30); let m = api.market(bar, 30); let f = api.factor(0, bar, 30); return { text: "n " + s.length + "/" + m.close.length + "/" + f.length } }\n', 'utf8')
        let fpBad = path.join(root, 'rsi', 'toolbox', 'metrics', 'bad_bar.mjs')
        fs.writeFileSync(fpBad, 'export default function (api) { return { text: String(api.series("ser_a", 987654321, 5).length) } }\n', 'utf8')
        try {
            let r1 = run(['--pick', pickOk, '--ext-test', fpUse])
            assert.equal(r1.status, 0, r1.out.slice(0, 800))
            assert(/EXT_OK use_data[^\n]*: n 30\/30\/30/.test(r1.out), r1.out.slice(0, 800))
            let r2 = run(['--pick', pickOk, '--ext-test', fpBad])
            assert.equal(r2.status, 4, r2.out.slice(0, 800))
            assert(/EXT_FAIL bad_bar: api\.series: bar 須為 0 ~ 2400 之整數\r?\n/.test(r2.out) && !r2.out.includes('987654321'), r2.out.slice(0, 800))
        }
        finally {
            fs.rmSync(fpUse, { force: true })
            fs.rmSync(fpBad, { force: true })
        }
    })
})
