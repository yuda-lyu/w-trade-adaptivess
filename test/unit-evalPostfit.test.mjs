import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { getSettings } from '../src/cfg.mjs'
import { makeTexts } from '../src/domain/texts.mjs'
import { loadLedger, memberLedger } from '../src/eval/ledger.mjs'
import { makeEvaluator as makeEvaluatorRaw, ntStaticOf } from '../src/eval/evalCore.mjs'
import { makeTmp, writeSynthLedger, makeTrainEvaluator as makeEvaluator, FD_ROOT } from './tools/synthLedger.mjs'


//只留求解窗已結束之席(規則 R-EV-41): 評估器之 opt.afterFitOnly 與命令列之 --period postfit(求解窗後段; 此結果不是正本)
//  spec: ①評估器: opt.afterFitOnly(布林; null / undefined 視同 false; 其餘拋 invalid opt.afterFitOnly: must be a boolean, 於執行挑選函數之前)⇒ 評估期間內每個決策(決策棒 b)只留選集中 0 ≤ fitEndBar[s] < b 之席;
//          須有 cfg.fitEnd; 不與 opt.ext 併用; 等同「挑選函數自行只回所留之席」(逐位); ctx.prev 為完整之選集; 另回 afterFit(所留 / 所捨、下單數、前段 / 後段之分段與其組成對照)
//        ②命令列: --period postfit ⇒ 段 = fitEndBar 之最小者(0 以上)之次一根 ~ 回測期起點(不含); period.canonical: false; **score 為 null、不印判讀列**(佐證, 不入 S 與階梯);
//          須有虛無; 不與 --ref、--ext-test、迴圈之重放之 ARSI_LEDGER_DIR / ARSI_EVAL_FROM 併用(離開碼 2、不寫結果檔、不記評估紀錄); 擴充診斷不載入; --member、--phases 可併用
//        ③未給選項、未帶 --period postfit 時, 評估器與命令列之輸出形狀不變; 任務書不提此選項
//  合成帳本: 起點 2022-07-01、4 小時一根(每日 6 根); 暖機 60 日(第 360 棒起)、7 日一換(42 根); 相位 0 之決策棒 360 + 42k、相位 3 之決策棒 378 + 42k
//  求解窗終點: 2022-11-01T00:00:00 = 第 738 棒(= 相位 0 之一個決策棒)、2022-11-14T20:00:00 = 第 821 棒(其次一根第 822 棒 = 相位 0 之一個決策棒) ⇒ 兩個邊界皆落在決策棒上
//  兩種方向: A = 做多之終點較早、B = 做空之終點較早(各欄逐策略相異之合成帳本: 進場、出場與損益逐策略獨立抽; 做空 = 序號為 3 之倍數者)
const T738 = '2022-11-01T00:00:00'
const T821 = '2022-11-14T20:00:00'
const CFG = { warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7], nullDraws: 16, seed: 11 }
const FIT_A = { long: T738, short: T821 }
const FIT_B = { long: T821, short: T738 }
//命令列之「段內無決策棒」訊息(每一個所評估之相位皆須有)
const MSG_NODEC = 'invalid --period postfit: must have at least one decision bar in every evaluated phase after the earliest end of the fitting windows and before the start of the backtest period'

//barOfIso, 由時間字串獨立換算棒序(不經評估器)
let barOfIso = (t) => Math.round((Date.parse(`${t}Z`) - Date.parse('2022-07-01T00:00:00Z')) / (4 * 3600000))
let r4 = (x) => Math.round(x * 10000) / 10000
let statOf = (xs) => {
    let mean = xs.reduce((s, v) => s + v, 0) / xs.length
    return { mean, min: Math.min(...xs), max: Math.max(...xs), sd: Math.sqrt(xs.reduce((s, v) => s + (v - mean) * (v - mean), 0) / xs.length) }
}
//noMs, 結果去掉耗時欄(其餘逐位比對)
let noMs = (m) => JSON.parse(JSON.stringify({ ...m, ms: null }))
//FIX: 固定之選集(兩側皆有; 偶數序號)與其子帳(序號 % 3)
const FIX = Array.from({ length: 30 }, (_, i) => i * 2)
let pickAll = () => ({ ids: FIX.slice(), group: FIX.map((s) => s % 3) })
//accept 依持倉簿與子帳(分帳隨席帶過才會一致)
let accept = (sig, book) => book.open < 12 && book.openGroup[sig.group] < 6

describe('只留求解窗已結束之席:評估器之 opt.afterFitOnly(規則 R-EV-41)', function () {
    let t
    let L
    before(() => {
        t = makeTmp('evalPostfit')
        writeSynthLedger(t.dir, { n: 60, nBars: 2400, seed: 5 })
        L = loadLedger(t.dir)
    })
    after(() => {
        t.cleanup()
    })

    it('合成之設定:兩個終點棒依方向換算為第 738 / 821 棒(邊界皆落在相位 0 之決策棒上);同一側之 fitEndBar 相同(組成對照之替換池 = 同側之前提)', () => {
        assert.equal(barOfIso(T738), 738)
        assert.equal(barOfIso(T821), 821)
        let ev = makeEvaluator(L, { ...CFG, fitEnd: FIT_A })
        for (let s = 0; s < L.n; s++) {
            assert.equal(ev.meta.fitEndBar[s], L.mode[s] > 0 ? 738 : 821)
        }
        for (let side of [1, -1]) {
            let vs = new Set(Array.from({ length: L.n }, (_, s) => s).filter((s) => Math.sign(L.mode[s]) === side).map((s) => ev.meta.fitEndBar[s]))
            assert.equal(vs.size, 1, `同側之求解窗終點相同(方向 ${side})`)
        }
        let b0 = ev.decisionBars(0)
        assert(b0.includes(738) && b0.includes(822) && b0.includes(780))
        assert(L.mode.some((v) => v > 0) && L.mode.some((v) => v < 0))
    })

    it('未給、null、false ⇒ 結果與未給逐位相同(無 afterFit 欄)', () => {
        let ev = makeEvaluator(L, { ...CFG, fitEnd: FIT_A })
        let o = { accept, fromBar: 739, toBar: 1290 }
        let m0 = ev.evalPolicy(pickAll, o)
        assert.equal(m0.afterFit, undefined)
        for (let v of [undefined, null, false]) {
            let m1 = ev.evalPolicy(pickAll, { ...o, afterFitOnly: v })
            assert.deepEqual(noMs(m1), noMs(m0), String(v))
            assert(!Object.prototype.hasOwnProperty.call(m1, 'afterFit'))
        }
    })

    it('參數不合 ⇒ invalid opt.afterFitOnly: must be a boolean(不帶輸入值;挑選函數未被執行)', () => {
        let ev = makeEvaluator(L, { ...CFG, fitEnd: FIT_A })
        let nCall = 0
        let pk = () => {
            nCall++
            return FIX
        }
        for (let v of [1, 0, 'true', {}, [true]]) {
            assert.throws(() => ev.evalPolicy(pk, { afterFitOnly: v }), (err) => err.message === 'invalid opt.afterFitOnly: must be a boolean', String(v))
        }
        assert.equal(nCall, 0)
    })

    it('未設 cfg.fitEnd ⇒ 拒絕(挑選函數未被執行);只設一側 ⇒ 未設之側(fitEndBar -1)一律不留;與 opt.ext 併用 ⇒ 拒絕(挑選函數未被執行)', () => {
        let ev0 = makeEvaluator(L, CFG)
        let nCall = 0
        let pk = () => {
            nCall++
            return FIX
        }
        assert.throws(() => ev0.evalPolicy(pk, { afterFitOnly: true }), (err) => err.message === 'invalid opt.afterFitOnly: requires cfg.fitEnd (the end of the fitting window of each side)')
        let ev1 = makeEvaluator(L, { ...CFG, fitEnd: { long: T738, short: null } })
        assert.equal(ev1.meta.fitEndBar[0], -1)
        let runs = null
        let onRuns = (r) => {
            runs = r
        }
        let m = ev1.evalPolicy(pickAll, { accept, fromBar: 739, afterFitOnly: true, nullDraws: 0, onRuns })
        let nLong = 0
        for (let r of runs) {
            for (let sel of r.sels) {
                for (let s of sel) {
                    assert(L.mode[s] > 0, `做空之席 ${s} 被留下`)
                    nLong++
                }
            }
        }
        assert(nLong > 0)
        assert(m.afterFit.seatsDropped > 0)
        let ext = [{ name: 'x', fn: () => ({ text: 'x' }) }]
        let ev2 = makeEvaluator(L, { ...CFG, fitEnd: FIT_A })
        assert.throws(() => ev2.evalPolicy(pk, { afterFitOnly: true, ext }), (err) => err.message === 'invalid opt.afterFitOnly: cannot be combined with opt.ext')
        assert.equal(nCall, 0, '上列拒絕皆於執行挑選函數之前')
    })

    for (let [nm, fit, early, late] of [['A(做多之終點較早)', FIT_A, 1, -1], ['B(做空之終點較早)', FIT_B, -1, 1]]) {
        it(`逐席判定 ${nm}:所留 = 0 ≤ 終點棒 < 決策棒者;決策棒 = 終點棒 ⇒ 不留、= 終點棒之次一根 ⇒ 留`, () => {
            let ev = makeEvaluator(L, { ...CFG, fitEnd: fit })
            //各側之終點棒以時間字串獨立換算(不讀評估器)
            let feOf = (s) => barOfIso(L.mode[s] > 0 ? fit.long : fit.short)
            let runs = null
            let onRuns = (r) => {
                runs = r
            }
            ev.evalPolicy(pickAll, { accept, fromBar: 700, toBar: 1290, afterFitOnly: true, nullDraws: 0, onRuns })
            let seen = { atEnd: 0, afterEnd: 0 }
            for (let r of runs) {
                r.bars.forEach((b, k) => {
                    let want = FIX.filter((s) => feOf(s) < b)
                    assert.deepEqual(Array.from(r.sels[k]), want, `相位 ${r.phase} 決策棒 ${b}`)
                    if (b === 738) {
                        //較早之一側之終點棒 = 此決策棒 ⇒ 不留; 較晚之一側亦不留
                        assert.equal(r.sels[k].length, 0)
                        seen.atEnd++
                    }
                    if (b === 822) {
                        //較晚之一側之終點棒(821)之次一根 = 此決策棒 ⇒ 兩側皆留
                        assert(Array.from(r.sels[k]).some((s) => L.mode[s] === late))
                        assert(Array.from(r.sels[k]).some((s) => L.mode[s] === early))
                        seen.afterEnd++
                    }
                    if (b === 780) {
                        //只留較早之一側
                        assert(r.sels[k].length > 0 && Array.from(r.sels[k]).every((s) => L.mode[s] === early))
                    }
                })
            }
            assert.deepEqual(seen, { atEnd: 1, afterEnd: 1 })
        })
    }

    it('等同挑選函數自行只回所留之席:各項數字、選集指紋與子帳之歸因皆相同(分帳隨席帶過)', () => {
        let ev = makeEvaluator(L, { ...CFG, fitEnd: FIT_A })
        let pickF = (ctx) => {
            let fe = ctx.meta.fitEndBar
            let ids = FIX.filter((s) => fe[s] >= 0 && fe[s] < ctx.bar)
            return { ids, group: ids.map((s) => s % 3) }
        }
        let o = { accept, fromBar: 739, toBar: 1290 }
        let m1 = ev.evalPolicy(pickAll, { ...o, afterFitOnly: true })
        let m2 = ev.evalPolicy(pickF, o)
        let { afterFit, ...rest1 } = m1
        assert(afterFit && m2.afterFit === undefined)
        assert.deepEqual(noMs(rest1), noMs(m2))
        assert(m1.op.byGroup.length === 3, '三個子帳皆有席')
        assert(m1.nullSideAct && m1.nullSideAct.draws === 16)
    })

    it('分帳:所留之席皆屬子帳 0(所捨者在其他子帳)⇒ 與挑選函數自行只回所留之席逐位相同(全 0 之分帳不登記,同挑選函數之回傳)', () => {
        let ev = makeEvaluator(L, { ...CFG, fitEnd: FIT_A })
        //做空之席(所捨)在子帳 1、做多之席(所留)在子帳 0
        let grpOfSeat = (s) => (L.mode[s] < 0 ? 1 : 0)
        let pickG = () => ({ ids: FIX.slice(), group: FIX.map(grpOfSeat) })
        let pickF = (ctx) => {
            let ids = FIX.filter((s) => ctx.meta.fitEndBar[s] >= 0 && ctx.meta.fitEndBar[s] < ctx.bar)
            return { ids, group: ids.map(grpOfSeat) }
        }
        //子帳 0 與 1 各設持倉上限: 分帳隨席帶過才會一致
        let accG = (sig, book) => book.open < 12 && book.openGroup[sig.group] < 5
        let o = { accept: accG, fromBar: 739, toBar: 1290 }
        let m1 = ev.evalPolicy(pickG, { ...o, afterFitOnly: true })
        let m2 = ev.evalPolicy(pickF, o)
        let { afterFit, ...rest1 } = m1
        assert(afterFit.seatsDropped > 0 && afterFit.seatsKept > 0)
        assert.deepEqual(noMs(rest1), noMs(m2))
        //所留之席只有子帳 0(與「只回所留之席」者之歸因相同)
        assert.deepEqual(m1.op.byGroup.map((g) => g.group), m2.op.byGroup.map((g) => g.group))
    })

    it('選項只讀一次:opt.afterFitOnly 與 opt.ext 以存取子給之,各只被讀一次(檢查之值即使用之值)', () => {
        let ev = makeEvaluator(L, { ...CFG, fitEnd: FIT_A })
        let c1 = 0
        let o1 = {
            accept,
            fromBar: 739,
            toBar: 1290,
            nullDraws: 0,
            get afterFitOnly() {
                c1++
                return c1 === 1
            },
        }
        let m1 = ev.evalPolicy(pickAll, o1)
        assert.equal(c1, 1)
        assert(m1.afterFit && m1.afterFit.seatsDropped > 0, '第一次讀得之 true 即為所用之值')
        //opt.ext 第一次讀得空陣列、其後讀得診斷 ⇒ 只讀一次者以空陣列為準: 通過併用檢查且不執行診斷
        let c2 = 0
        let o2 = {
            accept,
            fromBar: 739,
            toBar: 1290,
            nullDraws: 0,
            afterFitOnly: true,
            get ext() {
                c2++
                return c2 === 1 ? [] : [{ name: 'x', fn: () => ({ text: 'x' }) }]
            },
        }
        let m2 = ev.evalPolicy(pickAll, o2)
        assert.equal(c2, 1)
        assert.equal(m2.ext, undefined, '檢查所見者(空)即其後所用者, 診斷未被執行')
        //第一次即讀得診斷 ⇒ 拒絕
        let c3 = 0
        let o3 = {
            afterFitOnly: true,
            get ext() {
                c3++
                return [{ name: 'x', fn: () => ({ text: 'x' }) }]
            },
        }
        assert.throws(() => ev.evalPolicy(pickAll, o3), (err) => err.message === 'invalid opt.afterFitOnly: cannot be combined with opt.ext')
        assert.equal(c3, 1)
    })

    it('求解窗終點之位置:終點 = 帳本起點(fitEndBar 0)為有效(決策棒皆晚於它 ⇒ 全留);早於帳本起點者(fitEndBar < -1)與未設定同樣不留(規格為 0 ≤ fitEndBar)', () => {
        //fitEndBar 0: 全留 ⇒ 與未濾者逐位相同(除 afterFit)
        let ev0 = makeEvaluator(L, { ...CFG, fitEnd: { long: '2022-07-01T00:00:00', short: '2022-07-01T00:00:00' } })
        assert(Array.from(ev0.meta.fitEndBar).every((v) => v === 0))
        let o = { accept, fromBar: 739, toBar: 1290 }
        let m0 = ev0.evalPolicy(pickAll, { ...o, afterFitOnly: true })
        assert.equal(m0.afterFit.seatsDropped, 0)
        assert.equal(m0.afterFit.seatsKept, FIX.length)
        let { afterFit, ...rest } = m0
        assert(afterFit)
        assert.deepEqual(noMs(rest), noMs(ev0.evalPolicy(pickAll, o)))
        //做多之終點早於帳本起點(負棒序): 做多之席不留(只留已設且 ≥ 0 之做空之席)
        let evNeg = makeEvaluator(L, { ...CFG, fitEnd: { long: '2022-06-01T00:00:00', short: T738 } })
        assert(Array.from(evNeg.meta.fitEndBar).some((v) => v < -1))
        let runs = null
        let onRuns = (r) => {
            runs = r
        }
        evNeg.evalPolicy(pickAll, { accept, fromBar: 739, toBar: 1290, afterFitOnly: true, nullDraws: 0, onRuns })
        let nShort = 0
        for (let r of runs) {
            for (let sel of r.sels) {
                for (let s of sel) {
                    assert(L.mode[s] < 0, `做多之席 ${s}(終點早於帳本起點)被留下`)
                    nShort++
                }
            }
        }
        assert(nShort > 0)
    })

    it('挑選函數照常執行:ctx.prev 為其完整之選集(與未給此選項時之呼叫序列逐位相同)', () => {
        let ev = makeEvaluator(L, { ...CFG, fitEnd: FIT_A })
        let mk = (log) => (ctx) => {
            log.push(`${ctx.phase}:${ctx.k}:${Array.from(ctx.prev).join(',')}`)
            return FIX
        }
        let la = []
        let lb = []
        ev.evalPolicy(mk(la), { fromBar: 739, toBar: 1290, nullDraws: 0, afterFitOnly: true })
        ev.evalPolicy(mk(lb), { fromBar: 739, toBar: 1290, nullDraws: 0 })
        assert.deepEqual(la, lb)
        assert(la.filter((x) => x.endsWith(FIX.join(','))).length > 10, 'ctx.prev 為完整之選集(含求解窗未結束之席)')
    })

    it('彙總與分段:所留 / 所捨之席數、下單數;前段 / 後段依決策序各半、各段自空倉起算,其等效年化、下單數與組成對照與以公開方法重算者相同', () => {
        //兩個亂數種子各驗一次; 鑑別之前提: 至少一段之各抽中「≥ 該段之成品值」與「≥ 全段之成品值」之個數不同(p 須對該段之成品值算, 不是全段)
        let nDisc = 0
        for (let sd of [11, 13]) {
            nDisc += checkHalves({ sd })
        }
        assert(nDisc > 0, '合成資料無法分辨 p 之基準(請換種子)')
    })

    it('分段沿用設定之 sideActHalf(非預設 50)與 accept 所讀之 sig.k、sig.tag(各段之 k0 與 tags 依整段之決策序切片)', () => {
        //sideActHalf = 20: 全段與各段之組成對照皆用 20
        checkHalves({ sd: 11, half: 20 })
        //accept 依 sig.k 與 sig.tag 決定放行: 分段之 k0(該段第一個決策於整段之決策序)與 tags 若錯, 各段之下單數與等效年化即與公開方法之重算不同
        let pickTag = (ctx) => ({ ids: FIX.slice(), group: FIX.map((s) => s % 3), tag: ctx.k % 3 })
        let acceptKT = (sig, book) => book.open < 12 && book.openGroup[sig.group] < 6 && (sig.k + sig.tag) % 4 !== 0
        checkHalves({ sd: 11, pick: pickTag, acc: acceptKT })
    })
    //checkHalves, 以公開方法(opOf、nullSideActOf)獨立重算前段 / 後段並與評估器之 afterFit 比對; 回「p 之基準可鑑別」之段數
    let checkHalves = ({ sd, half = 50, pick = pickAll, acc = accept }) => {
        let ev = makeEvaluator(L, { ...CFG, seed: sd, ...(half === 50 ? {} : { sideActHalf: half }), fitEnd: FIT_A })
        let nDisc = 0
        let runs = null
        let onRuns = (r) => {
            runs = r
        }
        let m = ev.evalPolicy(pick, { accept: acc, fromBar: 739, toBar: 1290, afterFitOnly: true, onRuns })
        let af = m.afterFit
        let nDec = runs.reduce((a, r) => a + r.bars.length, 0)
        let nKept = runs.reduce((a, r) => a + r.sels.reduce((b, s) => b + s.length, 0), 0)
        assert.equal(af.seatsKept, r4(nKept / nDec))
        assert.equal(af.seatsDropped, r4((FIX.length * nDec - nKept) / nDec))
        assert.equal(af.orders, r4(m.op.nOrders.reduce((a, v) => a + v, 0) / m.op.nOrders.length))
        assert.equal(af.halves.length, 2)
        for (let g = 0; g < 2; g++) {
            let parts = runs.map((r) => {
                let nd = r.bars.length
                let a = g === 0 ? 0 : Math.floor(nd / 2)
                let z = g === 0 ? Math.floor(nd / 2) : nd
                return { phase: r.phase, bars: r.bars.slice(a, z), sels: r.sels.slice(a, z), tags: r.tags.slice(a, z), k0: r.k0 + a }
            })
            let os = parts.map((r) => ev.opOf(r.sels, r.bars, r.tags, acc, { k0: r.k0 }))
            let sg = statOf(os.map((o) => o.eqYr))
            let h = af.halves[g]
            assert.deepEqual(h.nDecisions, parts.map((r) => r.bars.length))
            assert.equal(h.from, ev.timeOf(Math.min(...parts.map((r) => r.bars[0]))))
            //最後一個決策之視窗可跨過評估期間之終點(至多一個決策間隔): 段之終點 = 最後一個決策棒 + 一個決策間隔(42 根)
            assert.equal(h.to, ev.timeOf(Math.max(...parts.map((r) => r.bars[r.bars.length - 1] + 42))))
            assert.deepEqual(h.eqYr, { mean: r4(sg.mean), min: r4(sg.min), max: r4(sg.max) })
            assert.equal(h.orders, r4(os.reduce((a, o) => a + o.nOrders, 0) / os.length))
            let nS = parts.reduce((a, r) => a + r.sels.reduce((b, s) => b + s.length, 0), 0)
            assert.equal(h.seats, r4(nS / parts.reduce((a, r) => a + r.bars.length, 0)))
            //各段之組成對照用獨立之亂數種子(seed + 33554393 + g × 16777259)
            let v = Array.from(ev.nullSideActOf(parts, acc, 16, sd + 33554393 + g * 16777259, half))
            let sv = statOf(v)
            assert.deepEqual(h.sideAct, { draws: 16, half, mean: r4(sv.mean), sd: r4(sv.sd), p: r4((1 + v.filter((x) => x >= sg.mean).length) / 17), z: sv.sd > 0 ? r4((sg.mean - sv.mean) / sv.sd) : 0, excess: r4(sg.mean - sv.mean) })
            if (v.filter((x) => x >= sg.mean).length !== v.filter((x) => x >= m.op.eqYr.mean).length) {
                nDisc++
            }
        }
        //兩段各自之重放與全段不同(各段自空倉起算; 不是全段之複本)
        assert.notDeepEqual(af.halves[0].eqYr, af.halves[1].eqYr)
        assert.notEqual(af.halves[0].sideAct.mean, m.nullSideAct.mean)
        assert.equal(m.nullSideAct.half, half)
        //不動既有之亂數取用: 全段之組成對照與未算分段之等價輸入(挑選函數自行只回所留之席)逐位相同
        let pickF = (ctx) => {
            let r = pick(ctx)
            let ids = []
            let group = []
            r.ids.forEach((s, i) => {
                if (ctx.meta.fitEndBar[s] >= 0 && ctx.meta.fitEndBar[s] < ctx.bar) {
                    ids.push(s)
                    group.push(r.group[i])
                }
            })
            return { ids, group, ...(r.tag === undefined ? {} : { tag: r.tag }) }
        }
        let m2 = ev.evalPolicy(pickF, { accept: acc, fromBar: 739, toBar: 1290 })
        assert.deepEqual(noMs(m.nullSideAct), noMs(m2.nullSideAct))
        assert.deepEqual(noMs(m.null), noMs(m2.null))
        return nDisc
    }

    it('未算虛無 ⇒ 組成對照皆為 null;每相位之決策數 < 2 ⇒ 不分段(halves 為 null)', () => {
        let ev = makeEvaluator(L, { ...CFG, fitEnd: FIT_A })
        let m0 = ev.evalPolicy(pickAll, { accept, fromBar: 739, toBar: 1290, afterFitOnly: true, nullDraws: 0 })
        assert.equal(m0.nullSideAct, null)
        assert(m0.afterFit.halves.every((h) => h.sideAct === null))
        //各相位只有 1 個決策(相位 0: 780;相位 3: 798)
        let m1 = ev.evalPolicy(pickAll, { accept, fromBar: 779, toBar: 800, afterFitOnly: true })
        assert.deepEqual(m1.op.nDecisions, [1, 1])
        assert.equal(m1.afterFit.halves, null)
        //一個相位有 2 個決策、另一個只有 1 個(相位 0: 780、822;相位 3: 798)⇒ 任一相位 < 2 即不分段
        let m2 = ev.evalPolicy(pickAll, { accept, fromBar: 779, toBar: 830, afterFitOnly: true })
        assert.deepEqual(m2.op.nDecisions, [2, 1])
        assert.equal(m2.afterFit.halves, null)
    })

    it('所留之席皆無(只挑求解窗未結束之側)⇒ 不拋錯:所留 0、等效年化 0、組成對照 null', () => {
        let ev = makeEvaluator(L, { ...CFG, fitEnd: { long: T738, short: '2023-02-01T00:00:00' } })
        let shorts = FIX.filter((s) => L.mode[s] < 0)
        let m = ev.evalPolicy(() => shorts, { accept, fromBar: 739, toBar: 1290, afterFitOnly: true })
        assert.equal(m.afterFit.seatsKept, 0)
        assert.equal(m.afterFit.seatsDropped, shorts.length)
        assert.equal(m.op.eqYr.mean, 0)
        assert.equal(m.nullSideAct, null)
        assert(m.afterFit.halves.every((h) => h.eqYr.mean === 0 && h.sideAct === null && h.orders === 0))
    })
})

describe('命令列之 --period postfit(求解窗後段;規則 R-EV-41)', function () {
    let t
    before(() => {
        t = makeTmp('evalPostfitCli')
    })
    after(() => {
        t.cleanup()
    })
    //mkProject: 帳本 2400 棒(起點 2022-07-01), 訓練期終點 2023-01-17(第 1200 棒)、回測期起點 2023-02-01(第 1290 棒);
    //  求解窗終點: 做多 2022-11-01(第 738 棒)、做空 = 回測期起點 ⇒ 段 = 第 739 ~ 1289 棒之決策棒, 只留做多之席
    //  nullDraws / phases 為 null 者不寫入設定(驗預設值: 抽數 64、相位 0 ~ 6)
    let mkProject = (name, { fitEnd = { long: T738, short: '2023-02-01T00:00:00' }, nBars = 2400, nullDraws = 8, phases = [0, 3] } = {}) => {
        let root = path.join(t.dir, name)
        writeSynthLedger(path.join(root, 'ledger', 'eval'), { n: 60, nBars, seed: 7 })
        fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
        fs.mkdirSync(path.join(root, 'rsi', 'work', 'n1'), { recursive: true })
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
            periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } },
            eval: { ledgerDir: './ledger/eval', warmupDays: 60, cadenceDays: 7, ...(phases === null ? {} : { phases }), horizons: [7], ...(nullDraws === null ? {} : { nullDraws }), seed: 1, ...(fitEnd ? { fitEnd } : {}), limits: { monthlyOrders: 400, peakHold: 50 } },
            score: { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] },
            rsi: { root: './rsi' },
            records: { workDir: './rsi/work' },
            dispatch: {},
        }), 'utf8')
        fs.writeFileSync(path.join(root, 'rsi', 'work', 'n1', 'pick.mjs'), 'export default function pick(ctx) {\n    let ids = []\n    for (let s = 0; s < ctx.n; s += 2) {\n        ids.push(s)\n    }\n    return ids\n}\n', 'utf8')
        return root
    }
    let run = (root, args, envMore = {}) => {
        let env = { ...process.env, ARSI_ROOT: root, ...envMore }
        for (let k of ['ARSI_HARNESS', 'ARSI_LEDGER_DIR', 'ARSI_EVAL_FROM']) {
            if (!(k in envMore)) {
                delete env[k]
            }
        }
        let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'eval.mjs'), '--pick', path.join(root, 'rsi', 'work', 'n1', 'pick.mjs'), ...args], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
        return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
    }
    let logOf = (root) => {
        let fp = path.join(root, 'rsi', 'work', 'n1', '.evals.log')
        return fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8').split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l)) : []
    }
    //direct, 以評估器直接計算同一段(同設定、同亂數種子)
    let direct = (root, more = {}) => {
        let st = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'))
        let L = loadLedger(path.join(root, 'ledger', 'eval'))
        if (more.member) {
            L = memberLedger(L, more.member.salt, more.member.half)
        }
        L.ntStatic = ntStaticOf(L, 1200)
        let ev = makeEvaluatorRaw(L, st.eval)
        let pick = (ctx) => {
            let ids = []
            for (let s = 0; s < ctx.n; s += 2) {
                ids.push(s)
            }
            return ids
        }
        return { ev, m: ev.evalPolicy(pick, { phases: more.phases || st.eval.phases, horizons: more.horizons || st.eval.horizons, nullDraws: more.nullDraws || st.eval.nullDraws, seed: 1, fromBar: more.fromBar === undefined ? 739 : more.fromBar, toBar: 1290, afterFitOnly: true }) }
    }

    it('段 = 最早之求解窗終點棒之次一根 ~ 回測期起點(不含);數字與以評估器直接計算者相同;非正本之標示、效度限制;score 為 null、不印判讀列;評估紀錄記 period', () => {
        let root = mkProject('main')
        let fo = path.join(root, 'out.json')
        let r = run(root, ['--mode', 'full', '--period', 'postfit', '--out', fo])
        assert.equal(r.status, 0, r.out.slice(0, 1500))
        let o = JSON.parse(fs.readFileSync(fo, 'utf8'))
        assert.deepEqual(o.period, { name: 'postfit', label: '求解窗後段(診斷;只留求解窗已結束之席;非正本)', start: '2022-11-01T04:00:00', end: '2023-02-01T00:00:00', canonical: false })
        assert.equal(o.metrics.period.evalFrom, '2022-11-01T04:00:00')
        assert.equal(o.metrics.period.evalTo, '2023-02-01T00:00:00')
        //相位 0 之第一個計入之決策棒 = 780(738 為終點棒本身, 不計)
        assert.equal(o.metrics.period.firstEvalDecision, '2022-11-08T00:00:00')
        let { ev, m } = direct(root)
        //決策棒皆早於回測期起點(第 1290 棒): 各相位之決策數 = 決策棒落在 [739, 1290) 者
        assert.deepEqual(o.metrics.op.nDecisions, [0, 3].map((ph) => ev.decisionBars(ph).filter((b) => b >= 739 && b < 1290).length))
        assert.equal(o.metrics.selHash, m.selHash)
        assert.deepEqual(o.metrics.op.eqYr, m.op.eqYr)
        assert.deepEqual(o.metrics.nullSideAct, m.nullSideAct)
        assert.deepEqual(o.metrics.afterFit, m.afterFit)
        assert(o.metrics.afterFit.seatsDropped > 0 && o.metrics.op.bySide.short.orders === 0, '只留做多之席')
        //主控已定: 此段為佐證 ⇒ 結果檔之 score 為 null(不計 S)、不印判讀列
        assert.equal(o.score, null)
        assert('score' in o)
        assert(/此結果不是正本/.test(r.out) && /效度限制: /.test(r.out) && /求解窗後段之分段/.test(r.out) && /求解窗後段之席/.test(r.out), r.out.slice(0, 1500))
        assert(/至多一個決策間隔/.test(r.out), '效度限制含最後一個決策之視窗跨過回測期起點')
        //畫面印出之數字 = 結果檔之數字(所留 / 所捨之席數;前段 / 後段之期間、等效年化、組成對照之超額 z p、下單數;依序)
        let f1 = (x) => x.toFixed(1)
        let af = o.metrics.afterFit
        assert(r.out.includes(`所留 均 ${f1(af.seatsKept)} 隻、所捨 均 ${f1(af.seatsDropped)} 隻 | 所留之席之等效年化 均 ${f1(o.metrics.op.eqYr.mean)}% 最差相位 ${f1(o.metrics.op.eqYr.min)}%`), r.out.slice(0, 3000))
        let ctl = (x) => `組成對照(同側同活躍度;只換所留之席) 超額 ${f1(x.excess)} z ${x.z} p ${x.p}`
        assert(r.out.includes(`${ctl(o.metrics.nullSideAct)} | 下單 ${f1(af.orders)} 單(各相位平均)`), r.out.slice(0, 3000))
        let halves = af.halves.map((g, i) => `${i === 0 ? '前段' : '後段'} ${g.from.slice(0, 10)} ~ ${g.to.slice(0, 10)} 等效年化 均 ${f1(g.eqYr.mean)}%(最差相位 ${f1(g.eqYr.min)}), ${ctl(g.sideAct)}, 下單 ${f1(g.orders)} 單`).join(' | ')
        assert(r.out.includes(`求解窗後段之分段(依決策序各半;各段自空倉起算): ${halves}`), r.out.slice(0, 3000))
        assert(!/^判讀/m.test(r.out) && !/階梯 -?\d/.test(r.out) && !/ S -?\d/.test(r.out), `不印判讀列(S 與階梯之值)\n${r.out.slice(0, 3000)}`)
        let lg = logOf(root)
        assert.equal(lg.length, 1)
        assert.equal(lg[0].period, 'postfit')
        assert.equal(lg[0].S, null)
        assert.equal(lg[0].selHash, m.selHash)
    })

    it('只設一側之求解窗終點(另一側未設 ⇒ fitEndBar -1):段起點取已設者之最小值之次一根;未設之側一律不留(做空 0 單、所捨 > 0)', () => {
        //兩個方向各驗一次(未設之側為策略序號較前者或較後者; 合成帳本之序號 3 之倍數為做空)
        for (let [nm, fitEnd, noOrders] of [['做空未設', { long: T738, short: null }, 'short'], ['做多未設', { long: null, short: T738 }, 'long']]) {
            let root = mkProject(`oneside_${noOrders}`, { fitEnd })
            let fo = path.join(root, 'one.json')
            let r = run(root, ['--mode', 'full', '--period', 'postfit', '--out', fo])
            assert.equal(r.status, 0, `${nm}\n${r.out.slice(0, 1200)}`)
            let o = JSON.parse(fs.readFileSync(fo, 'utf8'))
            assert.equal(o.period.start, '2022-11-01T04:00:00', `${nm}: 未設之側(-1)不入「最小者」`)
            assert.equal(o.period.end, '2023-02-01T00:00:00')
            assert.equal(o.metrics.op.bySide[noOrders].orders, 0, `${nm}: 未設之側一律不留`)
            assert(o.metrics.afterFit.seatsDropped > 0 && o.metrics.afterFit.seatsKept > 0, nm)
            let { m } = direct(root)
            assert.deepEqual(o.metrics.afterFit, m.afterFit, nm)
            assert.equal(o.metrics.selHash, m.selHash, nm)
        }
    })

    it('求解窗終點 = 帳本起點(fitEndBar 0 為有效):最早之終點為 0 ⇒ 段自第 1 棒起(不與「未設定」混淆)', () => {
        let root = mkProject('fitzero', { fitEnd: { long: '2022-07-01T00:00:00', short: T738 } })
        let fo = path.join(root, 'zero.json')
        let r = run(root, ['--mode', 'full', '--period', 'postfit', '--out', fo])
        assert.equal(r.status, 0, r.out.slice(0, 1200))
        let o = JSON.parse(fs.readFileSync(fo, 'utf8'))
        assert.equal(o.period.start, '2022-07-01T04:00:00')
        let { m } = direct(root, { fromBar: 1 })
        assert.deepEqual(o.metrics.afterFit, m.afterFit)
        assert.equal(o.metrics.selHash, m.selHash)
    })

    it('帳本恰止於回測期起點(第 1290 棒)⇒ 照常評估(段內之決策視窗皆完整落在帳本內,不誤報未涵蓋)', () => {
        let root = mkProject('exact', { nBars: 1290 })
        let fo = path.join(root, 'exact.json')
        let r = run(root, ['--mode', 'full', '--period', 'postfit', '--out', fo])
        assert.equal(r.status, 0, r.out.slice(0, 1200))
        let o = JSON.parse(fs.readFileSync(fo, 'utf8'))
        assert.equal(o.period.end, '2023-02-01T00:00:00')
        assert(o.metrics.op.nDecisions.every((n) => n > 0))
    })

    it('設定未給 eval.nullDraws 之預設(64 抽)與 eval.phases 之預設(相位 0 ~ 6):前者照常評估、抽數為 64;後者之每個相位皆須於段內有決策棒', () => {
        let root = mkProject('defaults', { nullDraws: null })
        let fo = path.join(root, 'def.json')
        let r = run(root, ['--mode', 'full', '--period', 'postfit', '--out', fo])
        assert.equal(r.status, 0, r.out.slice(0, 1200))
        let o = JSON.parse(fs.readFileSync(fo, 'utf8'))
        assert.equal(o.metrics.nullSideAct.draws, 64)
        assert.equal(o.metrics.afterFit.halves[0].sideAct.draws, 64)
        //未給 eval.phases、未帶 --phases ⇒ 相位 0 ~ 6; 段 = 第 1249 ~ 1289 棒(終點棒 1248 = 2023-01-25T00:00:00): 相位 1 之決策棒為 1248、1290 ⇒ 段內無 ⇒ 拒絕
        let fit = '2023-01-25T00:00:00'
        let rootP = mkProject('defphases', { fitEnd: { long: fit, short: fit }, phases: null, nullDraws: null })
        let r2 = run(rootP, ['--mode', 'full', '--period', 'postfit', '--out', fo])
        assert.equal(r2.status, 2, r2.out.slice(0, 800))
        assert(r2.out.split(/\r?\n/).includes('invalid --period postfit: must have at least one decision bar in every evaluated phase after the earliest end of the fitting windows and before the start of the backtest period'), r2.out.slice(0, 800))
    })

    it('可併用:--member(半庫)、--phases、--mode quick 另給 --null N(N ≥ 1)', () => {
        let root = mkProject('combo')
        let fo = path.join(root, 'o1.json')
        let r1 = run(root, ['--mode', 'full', '--period', 'postfit', '--member', '0x5bd1e995:1', '--out', fo])
        assert.equal(r1.status, 0, r1.out.slice(0, 1200))
        let o1 = JSON.parse(fs.readFileSync(fo, 'utf8'))
        assert.equal(o1.member.tag, '0x5bd1e995:1')
        assert.equal(o1.period.name, 'postfit')
        assert.equal(o1.score, null)
        assert.deepEqual(o1.metrics.afterFit, direct(root, { member: { salt: 0x5bd1e995, half: 1 } }).m.afterFit)
        let fo2 = path.join(root, 'o2.json')
        let r2 = run(root, ['--mode', 'full', '--period', 'postfit', '--phases', '3', '--out', fo2])
        assert.equal(r2.status, 0, r2.out.slice(0, 1200))
        assert.deepEqual(JSON.parse(fs.readFileSync(fo2, 'utf8')).metrics.afterFit, direct(root, { phases: [3] }).m.afterFit)
        let fo3 = path.join(root, 'o3.json')
        let r3 = run(root, ['--mode', 'quick', '--null', '4', '--period', 'postfit', '--out', fo3])
        assert.equal(r3.status, 0, r3.out.slice(0, 1200))
        assert.deepEqual(JSON.parse(fs.readFileSync(fo3, 'utf8')).metrics.afterFit, direct(root, { phases: [0, 3], horizons: [7], nullDraws: 4 }).m.afterFit)
    })

    it('擴充診斷不載入:同一專案之回測期載入共用工具區之診斷、求解窗後段不載入(結果檔無 ext)', () => {
        let root = mkProject('ext')
        fs.writeFileSync(path.join(root, 'rsi', 'toolbox', 'metrics', 'probe.mjs'), 'export default function (api) { return { text: "n " + api.n } }\n', 'utf8')
        let fo = path.join(root, 'e1.json')
        let r1 = run(root, ['--mode', 'full', '--out', fo])
        assert.equal(r1.status, 0, r1.out.slice(0, 1200))
        let o1 = JSON.parse(fs.readFileSync(fo, 'utf8'))
        assert(o1.metrics.ext && o1.metrics.ext.probe && o1.metrics.ext.probe.text === 'n 60', '回測期:診斷已載入(對照)')
        let fo2 = path.join(root, 'e2.json')
        let r2 = run(root, ['--mode', 'full', '--period', 'postfit', '--out', fo2])
        assert.equal(r2.status, 0, r2.out.slice(0, 1200))
        let o2 = JSON.parse(fs.readFileSync(fo2, 'utf8'))
        assert(!('ext' in o2.metrics), '求解窗後段:擴充診斷不載入')
        assert(!/擴充診斷 probe/.test(r2.out))
    })

    it('明確拒絕(離開碼 2;不寫結果檔、不記評估紀錄;訊息依 V19、V20 不帶值):--ref、--ext-test、無虛無(quick 未給 --null、--null 0)、迴圈之重放改帳本 / 評估起點、不合之 --period、設定無 eval.fitEnd、段內無決策棒、帳本未涵蓋至回測期起點', () => {
        let root = mkProject('reject')
        let fo = path.join(root, 'x.json')
        let pk = path.join(root, 'rsi', 'work', 'n1', 'pick.mjs')
        let cases = [
            [['--mode', 'full', '--period', 'postfit', '--ref', pk], {}, 'invalid --period postfit: cannot be combined with --ref'],
            [['--mode', 'full', '--period', 'postfit', '--ext-test', pk], {}, 'invalid --period postfit: cannot be combined with --ext-test'],
            [['--mode', 'quick', '--period', 'postfit'], {}, 'invalid --period postfit: must have null draws (--mode full, or --null N with N >= 1)'],
            [['--mode', 'full', '--null', '0', '--period', 'postfit'], {}, 'invalid --period postfit: must have null draws (--mode full, or --null N with N >= 1)'],
            [['--mode', 'full', '--period', 'postfit', '--no-log'], { ARSI_HARNESS: '1', ARSI_LEDGER_DIR: path.join(root, 'ledger', 'eval') }, 'invalid --period postfit: cannot be combined with ARSI_LEDGER_DIR or ARSI_EVAL_FROM'],
            [['--mode', 'full', '--period', 'postfit', '--no-log'], { ARSI_HARNESS: '1', ARSI_EVAL_FROM: '2023-04-01T00:00:00' }, 'invalid --period postfit: cannot be combined with ARSI_LEDGER_DIR or ARSI_EVAL_FROM'],
            [['--mode', 'full', '--period', 'other'], {}, 'invalid --period: must be one of backtest, train, postfit'],
        ]
        for (let [args, envMore, msg] of cases) {
            let r = run(root, [...args, '--out', fo], envMore)
            assert.equal(r.status, 2, `${args.join(' ')}\n${r.out.slice(0, 800)}`)
            assert(r.out.split(/\r?\n/).includes(msg), `${args.join(' ')}\n${r.out.slice(0, 800)}`)
            assert(!fs.existsSync(fo), args.join(' '))
        }
        //不帶 ARSI_HARNESS 時兩個環境變數本就不生效 ⇒ 照常評估
        let rOk = run(root, ['--mode', 'full', '--period', 'postfit', '--out', fo], { ARSI_EVAL_FROM: '2023-04-01T00:00:00' })
        assert.equal(rOk.status, 0, rOk.out.slice(0, 800))
        fs.rmSync(fo)
        assert.equal(logOf(root).length, 1, '拒絕者不記評估紀錄')
        let rootNo = mkProject('nofit', { fitEnd: null })
        let r1 = run(rootNo, ['--mode', 'full', '--period', 'postfit', '--out', fo])
        assert.equal(r1.status, 2, r1.out.slice(0, 800))
        assert(r1.out.split(/\r?\n/).includes('invalid --period postfit: must have eval.fitEnd in settings (the end of the fitting window of each side)'), r1.out.slice(0, 800))
        let rootLate = mkProject('late', { fitEnd: { long: '2023-02-01T00:00:00', short: '2023-02-01T00:00:00' } })
        let r2 = run(rootLate, ['--mode', 'full', '--period', 'postfit', '--out', fo])
        assert.equal(r2.status, 2, r2.out.slice(0, 800))
        assert(r2.out.split(/\r?\n/).includes(MSG_NODEC), r2.out.slice(0, 800))
        //帳本只到訓練期終點(第 1200 棒 < 回測期起點第 1290 棒)⇒ 未涵蓋至回測期起點(段不得被帳本之終點悄悄截短)
        let rootShort = mkProject('short', { nBars: 1200 })
        let r3 = run(rootShort, ['--mode', 'full', '--period', 'postfit', '--out', fo])
        assert.equal(r3.status, 2, r3.out.slice(0, 800))
        assert(r3.out.split(/\r?\n/).includes('invalid --period postfit: must have a ledger that covers the start of the backtest period (rebuild it: node g_build.mjs)'), r3.out.slice(0, 800))
        assert(!fs.existsSync(fo))
        assert.equal(logOf(rootNo).length + logOf(rootLate).length + logOf(rootShort).length, 0)
    })

    it('所評估之每一個相位皆須於段內有決策棒(只評估之相位判定;某相位無決策者其等效年化為 0 會稀釋各相位之平均 ⇒ 拒絕);段內決策棒之邊界:含起點(終點棒之次一根)、不含回測期起點', () => {
        //終點 2023-01-30T08:00:00 = 第 1280 棒 ⇒ 段 = 第 1281 ~ 1289 棒: 相位 0 之決策棒 360 + 42k 有 1284; 相位 3 之決策棒 378 + 42k 為 1260、1302 ⇒ 段內無
        let fit = '2023-01-30T08:00:00'
        let root = mkProject('phasesel', { fitEnd: { long: fit, short: fit } })
        let fo = path.join(root, 'ph.json')
        let Lc = loadLedger(path.join(root, 'ledger', 'eval'))
        Lc.ntStatic = ntStaticOf(Lc, 1200)
        let evc = makeEvaluatorRaw(Lc, { warmupDays: 60, cadenceDays: 7, phases: [0, 3] })
        assert.equal(barOfIso(fit), 1280)
        assert.deepEqual(evc.decisionBars(0).filter((b) => b >= 1281 && b < 1290), [1284])
        assert.deepEqual(evc.decisionBars(3).filter((b) => b >= 1281 && b < 1290), [])
        //評估相位 0 與 3(設定之 phases)、只評估相位 3 ⇒ 皆拒絕(相位 3 於段內無決策棒; 不以相位 0 之決策棒放行)
        for (let args of [[], ['--phases', '3']]) {
            let r1 = run(root, ['--mode', 'full', '--period', 'postfit', ...args, '--out', fo])
            assert.equal(r1.status, 2, `${args.join(' ')}\n${r1.out.slice(0, 800)}`)
            assert(r1.out.split(/\r?\n/).includes(MSG_NODEC), r1.out.slice(0, 800))
            assert(!fs.existsSync(fo))
        }
        assert.equal(logOf(root).length, 0, '拒絕者不記評估紀錄')
        //只評估相位 0(段內有 1 個決策)⇒ 照常評估(決策數 < 2 ⇒ 不分段)
        let r2 = run(root, ['--mode', 'full', '--period', 'postfit', '--phases', '0', '--out', fo])
        assert.equal(r2.status, 0, r2.out.slice(0, 800))
        let o2 = JSON.parse(fs.readFileSync(fo, 'utf8'))
        assert.deepEqual(o2.metrics.op.nDecisions, [1])
        assert.equal(o2.metrics.afterFit.halves, null)
        //邊界: 終點 = 第 1283 棒(2023-01-30T20:00:00)⇒ 段 = 第 1284 ~ 1289 棒, 相位 0 之決策棒 1284 恰為段之起點 ⇒ 含
        let fit2 = '2023-01-30T20:00:00'
        assert.equal(barOfIso(fit2), 1283)
        let rootLo = mkProject('phaselo', { fitEnd: { long: fit2, short: fit2 } })
        let r3 = run(rootLo, ['--mode', 'full', '--period', 'postfit', '--phases', '0', '--out', fo])
        assert.equal(r3.status, 0, r3.out.slice(0, 800))
        assert.deepEqual(JSON.parse(fs.readFileSync(fo, 'utf8')).metrics.op.nDecisions, [1])
        //邊界: 終點 = 第 1248 棒(2023-01-25T00:00:00)⇒ 段 = 第 1249 ~ 1289 棒; 相位 1 之決策棒為 1248、1290(= 回測期起點, 不含)⇒ 段內無 ⇒ 拒絕
        let fit3 = '2023-01-25T00:00:00'
        assert.equal(barOfIso(fit3), 1248)
        assert.deepEqual(evc.decisionBars(1).filter((b) => b >= 1248 && b <= 1290), [1248, 1290])
        let rootHi = mkProject('phasehi', { fitEnd: { long: fit3, short: fit3 } })
        let r4 = run(rootHi, ['--mode', 'full', '--period', 'postfit', '--phases', '1', '--out', fo])
        assert.equal(r4.status, 2, r4.out.slice(0, 800))
        assert(r4.out.split(/\r?\n/).includes(MSG_NODEC), r4.out.slice(0, 800))
        //設定之 phases 為空陣列(無相位可評估)⇒ 拒絕(不放行至評估器)
        let rootNone = mkProject('phasenone', { phases: [] })
        let foNone = path.join(rootNone, 'none.json')
        let r5 = run(rootNone, ['--mode', 'full', '--period', 'postfit', '--out', foNone])
        assert.equal(r5.status, 2, r5.out.slice(0, 800))
        assert(r5.out.split(/\r?\n/).includes(MSG_NODEC), r5.out.slice(0, 800))
        assert(!fs.existsSync(foNone))
    })

    it('--ext-test 與其他期間之併用維持現狀(只拒絕其與 postfit 之併用):--ext-test 搭 --period train 照常試跑', () => {
        let root = mkProject('exttrain')
        let fpExt = path.join(root, 'rsi', 'toolbox', 'metrics', 'good.mjs')
        fs.writeFileSync(fpExt, 'export default function (api) { return { text: "ok " + api.n } }\n', 'utf8')
        let r = run(root, ['--mode', 'full', '--period', 'train', '--ext-test', fpExt])
        assert.equal(r.status, 0, r.out.slice(0, 800))
        assert(/EXT_OK good/.test(r.out), r.out.slice(0, 800))
    })

    it('未帶 --period postfit:回測期與訓練期之結果無 afterFit 欄、period 無 canonical 欄、score 照算、照印判讀列(既有之輸出形狀不變)', () => {
        let root = mkProject('plain')
        for (let [args, nm, tag] of [[[], 'backtest', '(回測期)'], [['--period', 'train'], 'train', '(訓練期之診斷;不是成績)']]) {
            let fo = path.join(root, `p_${nm}.json`)
            let r = run(root, ['--mode', 'full', ...args, '--out', fo])
            assert.equal(r.status, 0, r.out.slice(0, 800))
            let o = JSON.parse(fs.readFileSync(fo, 'utf8'))
            assert.equal(o.period.name, nm)
            assert.deepEqual(Object.keys(o.period), ['name', 'label', 'start', 'end'])
            assert(!('afterFit' in o.metrics))
            assert(o.score && typeof o.score.S === 'number')
            assert(r.out.includes(`判讀${tag}: S ${o.score.S}`), r.out.slice(0, 1200))
            assert(!/求解窗後段/.test(r.out))
        }
        for (let l of logOf(root)) {
            assert.equal(typeof l.S, 'number', '非 postfit 之評估紀錄仍記 S')
        }
    })
})

describe('任務書不提求解窗後段(規則 R-EV-41:任務書不列此選項)', function () {
    it('節點與做夢之任務書皆不含 postfit / afterFit 字樣', () => {
        let st0 = getSettings()
        let st = { ...st0, rsi: { ...st0.rsi, guides: false } }
        let texts = makeTexts({ st, FD_ROOT: st.FD_ROOT })
        let arm = { id: 'A04_act', layer: 'A', layerName: 'A 資格', title: '活躍度', desc: '近期有進場者', grid: null }
        let toolbox = { dir: 'rsi/toolbox', index: 'rsi/toolbox/README.md', indexName: 'README.md', nTools: 3 }
        let nb = texts.nodeBrief({ workDir: path.join(st.records.workDir, 'nodeX'), task: { goal: 'g', type: 'explore', claim: null, arms: [arm], base: null, refs: [], direction: null, toolbox }, round: 7, nodeId: 'nodeX', attempt: 1 })
        let db = texts.dreamBrief({ round: 1, nodeIds: ['n1'], reworkedIds: [], workDir: path.join(st.records.workDir, 'dream_r001'), context: { nodes: [{ nodeId: 'n1', arms: ['A04_act'], base: null, S: -12.3, worst: -30.1, excess: 8.2, ladder: 0, vetoed: false, claimedS: -12.3, nEvals: 6, nFull: 4, nFullSel: 4, issues: [], from: null, type: 'explore', docMd: 'd.md', workDir: 'rsi/work/n1' }], failed: [], refs: [], prevDirections: [], maxDirections: 7, extra: '2. 更新文件', toolbox } })
        for (let s of [nb, db]) {
            assert(s.length > 1000)
            assert(!/postfit|afterFit|求解窗後段/.test(s))
        }
    })
})
