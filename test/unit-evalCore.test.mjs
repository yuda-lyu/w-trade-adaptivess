import assert from 'assert'
import { loadLedger } from '../src/eval/ledger.mjs'
import { makeEvaluator } from '../src/eval/evalCore.mjs'
import { makeTmp, writeSynthLedger } from './tools/synthLedger.mjs'


//評估核心(src/eval/evalCore.mjs)對合成帳本之規則驗證; 規則編號見 sgud/rule/rulebook.md, 介面見 docs/pick-contract.md
const CFG = { warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [3, 7], nullDraws: 16, seed: 11 }

describe('evalCore:無前視、執行規則、虛無與靜態欄', function () {
    let t
    let L
    let ev
    before(() => {
        t = makeTmp('evalCore')
        writeSynthLedger(t.dir, { n: 60, nBars: 2400, seed: 5 })
        L = loadLedger(t.dir)
        ev = makeEvaluator(L, CFG)
    })
    after(() => {
        t.cleanup()
    })

    it('ctx.stat 各欄只含決策棒以前之資訊(與由帳本原始陣列逐單計算者相同)', () => {
        let nChk = 0
        let pickChk = (ctx) => {
            let b = ctx.bar
            for (let days of [0, 30, 90]) {
                let S = ctx.stat(days)
                let from = days > 0 ? b - days * 6 : -Infinity
                for (let s = 0; s < ctx.n; s++) {
                    let closed = 0; let wins = 0; let pnl = 0; let entries = 0; let open = 0; let last = -1
                    for (let j = L.off[s]; j < L.off[s + 1]; j++) {
                        let e = L.ent[j]
                        let x = L.ext[j]
                        if (e < b) {
                            if (e >= from) {
                                entries++
                            }
                            last = e
                            if (!(x >= 0 && x < b)) {
                                open++
                            }
                        }
                        if (x >= 0 && x < b && x >= from) {
                            closed++
                            pnl += L.pnl[j]
                            if (L.pnl[j] > 0) {
                                wins++
                            }
                        }
                    }
                    nChk++
                    //R-EV-2: closed / wins / pnl 只計「出場棒 < 決策棒」者; entries / open / lastEntryAgo 只計「進場棒 < 決策棒」者
                    assert.deepEqual([S.closed[s], S.wins[s], S.entries[s], S.open[s], S.lastEntryAgo[s]], [closed, wins, entries, open, last >= 0 ? b - 1 - last : 1000000000], `stat(${days}) 策略 ${s} 決策棒 ${b}`)
                    assert(Math.abs(S.pnl[s] - pnl) < 1e-6, `stat(${days}).pnl 策略 ${s} 決策棒 ${b}`)
                }
            }
            return []
        }
        ev.runPick(pickChk, 0)
        ev.runPick(pickChk, 3)
        assert(nChk > 10000, `應核對足夠之格數, 實得 ${nChk}`)
    })

    it('ctx.stat 之回看日數逐次不同時結果仍正確(緩衝重用不串值);同一次決策內多個日數互不干擾', () => {
        let nChk = 0
        ev.runPick((ctx) => {
            let b = ctx.bar
            //每次決策用不同之日數(模擬「自某固定日起」之回看), 並同時取兩個日數
            let dA = 20 + ctx.k
            let dB = 200 + ctx.k
            let A = ctx.stat(dA)
            let B = ctx.stat(dB)
            for (let s = 0; s < ctx.n; s += 3) {
                for (let [S, days] of [[A, dA], [B, dB]]) {
                    let from = b - days * 6
                    let entries = 0
                    for (let j = L.off[s]; j < L.off[s + 1]; j++) {
                        if (L.ent[j] < b && L.ent[j] >= from) {
                            entries++
                        }
                    }
                    nChk++
                    //R-EV-2: 各日數之統計各自正確(合約 §3: 陣列只在本次 pick 內有效)
                    assert.equal(S.entries[s], entries, `stat(${days}).entries 策略 ${s} 決策 ${ctx.k}`)
                }
            }
            return []
        }, 0)
        assert(nChk > 1000)
    })

    it('ctx.orders / entryDays / market 不含決策棒以後之資訊', () => {
        let seen = 0
        ev.runPick((ctx) => {
            let b = ctx.bar
            for (let s = 0; s < ctx.n; s += 7) {
                //R-EV-2: orders 只列進場棒 < 決策棒之單; 尚未出場(出場棒 ≥ 決策棒)者 ext / pnl 為 null
                let os = ctx.orders(s)
                assert(os.every((o) => o.ent < b && (o.ext === null ? o.pnl === null : o.ext < b)), `orders 策略 ${s} 決策棒 ${b}`)
                let nBefore = 0
                for (let j = L.off[s]; j < L.off[s + 1]; j++) {
                    if (L.ent[j] < b) {
                        nBefore++
                    }
                }
                assert.equal(os.length, nBefore, 'orders 之筆數 = 決策棒以前之進場數')
                //R-EV-2: entryDays 之日序號皆在決策棒所在日或以前, 且對應之進場棒 < 決策棒
                let ds = ctx.entryDays(s, 90)
                assert(Array.from(ds).every((d) => d * 6 < b), `entryDays 策略 ${s} 決策棒 ${b}`)
                //R-EV-30: entryBars 與 entryDays 同序同長 —— 與 orders 之進場棒篩「近 d 日」逐筆相同(皆 < 決策棒); 除以每日棒數取整 = entryDays; 回傳為複本; days 省略 = 全部
                let ebs = ctx.entryBars(s, 90)
                assert.deepEqual(Array.from(ebs), os.map((o) => o.ent).filter((e) => e >= b - 90 * 6), `entryBars(90) 策略 ${s} 決策棒 ${b}`)
                assert.deepEqual(Array.from(ebs).map((e) => Math.floor(e / 6)), Array.from(ds), 'entryBars ÷ 每日棒數 = entryDays')
                assert.deepEqual(Array.from(ctx.entryBars(s)), os.map((o) => o.ent), 'entryBars() = 決策棒以前之全部進場棒')
                if (ebs.length) {
                    let keep = ebs[0]
                    ebs[0] = -1
                    assert.equal(ctx.entryBars(s, 90)[0], keep, '回傳為複本, 改它不影響帳本')
                }
                //R-EV-26: exitDays 與 entryDays 對稱 —— 只含出場棒 < 決策棒之已出場單, 依出場時間由舊至新; 與 orders 之已出場單逐筆相同(窗 = 最近 90 日; days 省略 = 全部)
                let refX = (from) => os.filter((o) => o.ext !== null && o.ext >= from).map((o) => o.ext).sort((p, q) => p - q).map((x) => Math.floor(x / 6))
                assert.deepEqual(Array.from(ctx.exitDays(s, 90)), refX(b - 90 * 6), `exitDays(90) 策略 ${s} 決策棒 ${b}`)
                assert.deepEqual(Array.from(ctx.exitDays(s)), refX(-1), `exitDays() 策略 ${s} 決策棒 ${b}`)
                //R-EV-31: exitBars 與 exitDays 同序同長 —— 皆 < 決策棒; 除以每日棒數取整 = exitDays; 與 orders 之已出場單之出場棒(依出場時間)逐筆相同; 回傳為複本
                let refXB = (from) => os.filter((o) => o.ext !== null && o.ext >= from).map((o) => o.ext).sort((p, q) => p - q)
                let xbs = ctx.exitBars(s, 90)
                assert.deepEqual(Array.from(xbs), refXB(b - 90 * 6), `exitBars(90) 策略 ${s} 決策棒 ${b}`)
                assert(Array.from(xbs).every((x) => x < b))
                assert.deepEqual(Array.from(xbs).map((x) => Math.floor(x / 6)), Array.from(ctx.exitDays(s, 90)), 'exitBars ÷ 每日棒數 = exitDays')
                assert.deepEqual(Array.from(ctx.exitBars(s)), refXB(-1), 'exitBars() = 決策棒以前之全部出場棒')
                if (xbs.length) {
                    let keep = xbs[0]
                    xbs[0] = -1
                    assert.equal(ctx.exitBars(s, 90)[0], keep, '回傳為複本, 改它不影響帳本')
                }
                seen++
            }
            //R-EV-2: market(nBack) 之最後一根 = 決策棒之前一根
            let mk = ctx.market(12)
            assert.equal(mk.close.length, 12)
            assert.equal(mk.close[11], L.px[(b - 1) * 5 + 3])
            assert.equal(mk.open[0], L.px[(b - 12) * 5])
            return []
        }, 0)
        assert(seen > 100)
    })

    it('無 accept 之快路徑 = accept 恆真之逐訊號模擬;持倉與每日上限由 accept 生效', () => {
        let pick = (ctx) => {
            let S = ctx.stat(90)
            let ids = Array.from({ length: ctx.n }, (_, i) => i).filter((s) => S.entries[s] > 0)
            ids.sort((a, b) => S.entries[b] - S.entries[a] || ctx.meta.tie[a] - ctx.meta.tie[b])
            return ids.slice(0, 25)
        }
        let r = ev.runPick(pick, 3)
        let a = ev.opOf(r.sels, r.bars, r.tags, null)
        let b = ev.opOf(r.sels, r.bars, r.tags, () => true)
        //R-EV-3: 兩種路徑之損益、單數、最大同時持倉、未結數皆相同
        assert(Math.abs(a.totalPnl - b.totalPnl) < 1e-9)
        assert.deepEqual([a.nOrders, a.peakHold, a.nUnsettled, a.nSignals], [b.nOrders, b.peakHold, b.nUnsettled, b.nSignals])
        assert(a.nOrders > 100 && a.peakHold > 7, '合成帳本須有足夠之訊號與重疊, 否則下列上限測試無意義')
        //R-EV-3: accept = book.open < 7 且 book.dayCount < 2 ⇒ 最大同時持倉 ≤ 7、每日下單 ≤ 2
        let c = ev.opOf(r.sels, r.bars, r.tags, (sig, book) => book.open < 7 && book.dayCount < 2)
        assert(c.peakHold <= 7 && c.peakHold > 0)
        assert(c.nOrders < a.nOrders)
        assert(c.monthlyOrders <= 2 * 30.4375 + 1e-9)
        //合約 §2: 新鮮度之每個視窗各有自己的持倉簿 ⇒ 其最大持倉不超過連續操作者
        let f = ev.freshOf(r.sels, r.bars, r.tags, null, 7)
        assert(f.peakHold <= a.peakHold)
    })

    it('同一挑選重跑之 selHash 相同;選集不同則不同', () => {
        let pickA = (ctx) => [1, 2, 3, 4, 5]
        let pickB = (ctx) => [1, 2, 3, 4, 6]
        let a1 = ev.evalPolicy(pickA, {})
        let a2 = ev.evalPolicy(pickA, {})
        let b1 = ev.evalPolicy(pickB, {})
        //合約 §5: selHash 為選集與下單序列之指紋; 同一模組重跑必須相同
        assert.equal(a1.selHash, a2.selHash)
        assert.notEqual(a1.selHash, b1.selHash)
        //合約 §5: 有 accept 時下單序列入指紋(同選集、不同執行規則 ⇒ 不同)
        let a3 = ev.evalPolicy(pickA, { accept: (sig, book) => book.open < 1 })
        assert.notEqual(a1.selHash, a3.selHash)
    })

    it('輸出含各決策之選集大小分佈、空選集比例與 tag 之決策比例;加此欄不改變 selHash', () => {
        //合約 §5「選集大小之分佈」: p10 / 中位 / p90、空選集之決策比例; pick 有回傳 tag 時另列各 tag 之決策比例
        let pick = (ctx) => (ctx.k % 2 === 0 ? { ids: [1, 2, 3, 4], tag: 'on' } : { ids: [], tag: { side: 'off' } })
        let m = ev.evalPolicy(pick, {})
        let nDec = m.op.nDecisions.reduce((s, v) => s + v, 0)
        let nOn = m.op.nDecisions.reduce((s, v) => s + Math.ceil(v / 2), 0)
        assert.deepEqual([m.sel.sizeMin, m.sel.sizeMax], [0, 4])
        assert.deepEqual(Object.keys(m.sel.sizeDist), ['p10', 'p50', 'p90'])
        assert.equal(m.sel.sizeDist.p10, 0)
        assert.equal(m.sel.sizeDist.p90, 4)
        assert.equal(m.sel.emptyRate, Math.round((nDec - nOn) / nDec * 10000) / 10000)
        let byTag = Object.fromEntries(m.sel.tags.map((x) => [x.tag, x.share]))
        assert.deepEqual(Object.keys(byTag).sort(), ['on', '{"side":"off"}'])
        assert.equal(byTag.on, Math.round(nOn / nDec * 10000) / 10000)
        //無 tag 之模組: tags 為空陣列; 分佈為常數
        let m2 = ev.evalPolicy(() => [1, 2, 3], {})
        assert.deepEqual([m2.sel.tags, m2.sel.sizeDist, m2.sel.emptyRate], [[], { p10: 3, p50: 3, p90: 3 }, 0])
        assert.deepEqual([m2.sel.tagKinds, m2.sel.tagStats], [undefined, undefined], '無 tag 者不給 tagKinds / tagStats')
    })

    it('評估期間(fromBar / toBar):挑選函數仍自帳本起點連續執行,只有落在期間內之決策計入;切片之績效 = 直接以該切片計算者;執行規則收到之 sig.k 與 ctx.k 一致', () => {
        //R-EV-15: 評估期 = 回測期 —— g_eval.mjs 以 fromBar = 回測期起點呼叫 evalPolicy
        let r4 = (x) => Math.round(x * 10000) / 10000
        let seen = []
        let pick = (ctx) => {
            seen.push(ctx.k)
            ctx.state.n = (ctx.state.n || 0) + 1
            return { ids: [1, 2, 3, 4 + (ctx.state.n % 5)], tag: ctx.k }
        }
        let all = ev.evalPolicy(pick, { phases: [0], nullDraws: 0 })
        let nAll = all.op.nDecisions[0]
        let r = ev.runPick(pick, 0, CFG.seed)
        let a = Math.floor(nAll / 2)
        let fromBar = r.bars[a]
        seen = []
        let part = ev.evalPolicy(pick, { phases: [0], nullDraws: 0, fromBar })
        assert.deepEqual(seen, Array.from({ length: nAll }, (_, k) => k), '挑選函數自第一個決策連續執行(ctx.state 延續)')
        assert.equal(part.op.nDecisions[0], nAll - a)
        let o = ev.opOf(r.sels.slice(a), r.bars.slice(a), r.tags.slice(a), null, { k0: a })
        assert.equal(part.op.eqYr.byPhase[0], r4(o.eqYr), '切片之操作績效(持倉簿自期間起點為空)')
        assert.deepEqual([part.period.evalFrom, part.period.firstEvalDecision], [ev.timeOf(fromBar), ev.timeOf(fromBar)])
        assert.notEqual(part.selHash, all.selHash)
        //執行規則: 操作績效與新鮮度之各訊號, 其 sig.k 皆等於挑選函數該次之 ctx.k(此處以 tag 帶出)
        let ks = []
        ev.evalPolicy(pick, {
            phases: [0],
            nullDraws: 0,
            fromBar,
            horizons: [7],
            accept: (sig) => {
                ks.push(sig.k === sig.tag); return true
            }
        })
        assert(ks.length > 0 && ks.every(Boolean))
        //toBar: 只計期間終點以前之決策; 兩段之決策數相加 = 全部
        let head = ev.evalPolicy(pick, { phases: [0], nullDraws: 0, toBar: fromBar })
        assert.equal(head.op.nDecisions[0] + part.op.nDecisions[0], nAll)
        assert.equal(head.period.evalTo, ev.timeOf(fromBar))
        //期間內沒有任何決策 ⇒ 拋錯(帳本未涵蓋該期間)
        assert.throws(() => ev.evalPolicy(pick, { phases: [0], nullDraws: 0, fromBar: 10 ** 9 }), /評估期間內沒有任何決策/)
        //虛無亦只在期間內計(同劑量: 隨機挑之平均與切片之績效同量級, 非全段)
        let withNull = ev.evalPolicy(() => [1, 2, 3], { phases: [0, 3], fromBar })
        assert(withNull.null && withNull.null.draws === CFG.nullDraws && withNull.op.nDecisions.every((v) => v <= nAll - a + 1))
    })

    it('tag 全部列出(逾 64 種者其餘併為末筆);全部 tag 皆為數值時另給 tagStats(以決策為單位);只增輸出,selHash 不變', () => {
        //合約 §5「選集大小之分佈」: metrics.sel.tags 列出全部 tag、tagKinds 為種數、全部為數值時給 tagStats { n, mean, p10, p50, p90 }
        let r4 = (x) => Math.round(x * 10000) / 10000
        let base = ev.evalPolicy(() => [1, 2, 3], {})
        let mNum = ev.evalPolicy((ctx) => ({ ids: [1, 2, 3], tag: ctx.k % 10 }), {})
        assert.equal(mNum.selHash, base.selHash)
        assert.deepEqual([mNum.sel.tagKinds, mNum.sel.tags.length], [10, 10], '10 種 tag 全列(舊版只列前 8 種)')
        let vals = mNum.op.nDecisions.flatMap((n) => Array.from({ length: n }, (_, k) => k % 10)).sort((a, b) => a - b)
        let q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))]
        assert.deepEqual(mNum.sel.tagStats, { n: vals.length, mean: r4(vals.reduce((a, b) => a + b, 0) / vals.length), p10: q(0.1), p50: q(0.5), p90: q(0.9) })
        //可解析為數字之字串亦算數值; 有任一非數值之 tag 即不給 tagStats(tags 照列)
        let mStr = ev.evalPolicy((ctx) => ({ ids: [1, 2, 3], tag: String(ctx.k % 3) }), {})
        assert.deepEqual([mStr.sel.tagKinds, mStr.sel.tagStats.n], [3, vals.length])
        let mMix = ev.evalPolicy((ctx) => ({ ids: [1, 2, 3], tag: ctx.k % 2 ? 'on' : 1 }), {})
        assert.deepEqual([mMix.sel.tagKinds, mMix.sel.tagStats], [2, undefined])
        //每次決策皆不同之 tag: 逾 64 種者列前 64 種, 其餘併為末筆(rest: true); 各筆之占比合計為 1
        let c = 0
        let mMany = ev.evalPolicy(() => ({ ids: [1, 2, 3], tag: `t${c++}` }), {})
        let kinds = mMany.op.nDecisions.reduce((s, v) => s + v, 0)
        assert(kinds > 64, `合成帳本之決策數須逾 64 才測得到併筆(現 ${kinds})`)
        assert.deepEqual([mMany.sel.tagKinds, mMany.sel.tags.length, mMany.sel.tags[64].rest], [kinds, 65, true])
        assert(mMany.sel.tags[64].tag.includes(`${kinds - 64}`))
        assert(Math.abs(mMany.sel.tags.reduce((s, x) => s + x.share, 0) - 1) < 0.01)
        assert.equal(mMany.selHash, base.selHash)
    })

    it('onRuns:呼叫端可取得各相位之逐決策選集(供另算與參考模組之重疊率);給不給此回調,數字與 selHash 皆相同', () => {
        //合約 §5「與參考模組之選集重疊率」: g_eval.mjs --ref 以此取本模組之選集, 再以 runPick 跑參考模組(同相位、同種子); 只增輸出
        let pick = (ctx) => [1, 2, 3, 4, ctx.k % 5 + 10]
        let got = null
        let a = ev.evalPolicy(pick, {
            nullDraws: 4,
            onRuns: (rs) => {
                got = rs
            }
        })
        let b = ev.evalPolicy(pick, { nullDraws: 4 })
        assert.equal(a.selHash, b.selHash)
        assert.deepEqual([a.op.eqYr, a.null.mean, a.sel.sizeMean], [b.op.eqYr, b.null.mean, b.sel.sizeMean])
        assert.deepEqual(got.map((r) => r.phase), a.phases)
        assert.deepEqual(got.map((r) => r.sels.length), a.op.nDecisions)
        //選集為已排序之序號陣列(重疊率以合併走訪計交集)
        assert.deepEqual(Array.from(got[0].sels[0]), [1, 2, 3, 4, 10])
        //參考模組以 runPick 於同相位、同種子執行: 決策數與本模組相同
        let ref = ev.runPick(() => [2, 3, 50], got[0].phase, CFG.seed === undefined ? 1 : CFG.seed)
        assert.equal(ref.sels.length, got[0].sels.length)
    })

    it('pick 回傳不合法之序號或空值 ⇒ 拋錯', () => {
        //合約 §1: pick 須回傳序號陣列或 { ids, tag }; 序號須為 0 ~ n-1 之整數
        assert.throws(() => ev.runPick(() => [0, L.n], 0), /不合法之序號/)
        assert.throws(() => ev.runPick(() => [1.5], 0), /不合法之序號/)
        assert.throws(() => ev.runPick(() => null, 0), /null/)
        assert.throws(() => ev.runPick(() => ({ tag: 1 }), 0), /缺 ids/)
        let r = ev.runPick(() => ({ ids: new Set([3, 3, 1]), tag: 'x' }), 0)
        assert.deepEqual(Array.from(r.sels[0]), [1, 3])
        assert.equal(r.tags[0], 'x')
    })

    it('ctx.meta.ntAll:未給 L.ntStatic 時為帳本內之進場數;給定時取其值(回測期重放時只計訓練期)', () => {
        //R-EV-6
        assert.deepEqual(Array.from(ev.meta.ntAll), Array.from({ length: L.n }, (_, s) => L.off[s + 1] - L.off[s]))
        let L2 = loadLedger(t.dir)
        L2.ntStatic = new Int32Array(L2.n).fill(7)
        let ev2 = makeEvaluator(L2, CFG)
        assert(Array.from(ev2.meta.ntAll).every((v) => v === 7))
    })

    it('ctx.meta.fitEndBar:依方向取求解窗終點所對應之棒;未設定時為 -1', () => {
        //合約 §3: fitEndBar 為各策略求解窗之終點棒(做多 / 做空各一個時間), 此棒以後進場之單才是策略沒見過之期間所產生
        assert(Array.from(ev.meta.fitEndBar).every((v) => v === -1), '未給 cfg.fitEnd')
        let ev2 = makeEvaluator(L, { ...CFG, fitEnd: { long: '2022-07-11T00:00:00', short: '2022-08-01T04:00:00' } })
        for (let s = 0; s < L.n; s++) {
            //time0 = 2022-07-01T00:00:00、4 小時一根: 10 日 = 60 根; 31 日又 4 小時 = 187 根
            assert.equal(ev2.meta.fitEndBar[s], L.mode[s] > 0 ? 60 : 187)
        }
    })

    it('ctx.factor 與進場規則之條件欄(R-EV-29):只含決策棒以前之因子值(由舊至新、缺值照給、複本);條件欄與 keyIdx 對齊;舊帳本無此欄者 meta 為 null、factor 拋錯', () => {
        let F = L.fac
        assert.equal(F.length, 2 * L.nBars)
        let seen = 0
        ev.runPick((ctx) => {
            let b = ctx.bar
            for (let ki of [0, 1]) {
                //合約 §3: factor(ki, nBack) = 因子 ki 於決策棒以前最近 nBack 根之值; 最後一格 = 決策棒之前一根, 不含決策棒
                let v = ctx.factor(ki, 12)
                assert.equal(v.length, 12)
                for (let i = 0; i < 12; i++) {
                    assert(Object.is(v[i], F[ki * L.nBars + b - 12 + i]), `factor(${ki}, 12)[${i}] 決策棒 ${b}`)
                }
                assert(Object.is(ctx.factor(ki, 1)[0], F[ki * L.nBars + b - 1]), 'factor(ki, 1)[0] = 決策棒之前一根')
                //nBack 超過已有之棒數 ⇒ 只給到數據起點(長度 = 決策棒序號); 因子 1 之前 5 根為缺值, 照給 NaN
                let all = ctx.factor(ki, 1e9)
                assert.equal(all.length, b)
                assert.equal(Number.isNaN(all[0]), ki === 1)
                assert(!Number.isNaN(all[5]))
                //回傳為複本: 改它不影響帳本
                v[0] = 12345
                assert(!Object.is(F[ki * L.nBars + b - 12], 12345))
            }
            assert.equal(ctx.factor(0, 0).length, 0)
            assert.throws(() => ctx.factor(2, 5), /因子序號不合法/)
            assert.throws(() => ctx.factor(-1, 5), /因子序號不合法/)
            assert.throws(() => ctx.factor(0.5, 5), /因子序號不合法/)
            seen++
            return []
        }, 3)
        assert(seen > 10)
        //合約 §3: keySym / keyTh / keyOr 與 keyIdx 逐格對齊(策略 s 之條件 = keyOff[s] 至 keyOff[s+1]-1), 為帳本之複本
        let m = ev.meta
        assert.equal(m.keySym.length, m.keyIdx.length)
        assert.equal(m.keyTh.length, m.keyIdx.length)
        assert.equal(m.keyOr.length, m.keyIdx.length)
        assert.deepEqual(Array.from(m.keySym), Array.from(L.keySym))
        assert.deepEqual(Array.from(m.keyTh), Array.from(L.keyTh))
        assert.deepEqual(Array.from(m.keyOr), Array.from(L.keyOr))
        assert(Array.from(m.keySym).every((v) => v === 1 || v === -1))
        assert(m.keySym !== L.keySym && m.keyTh !== L.keyTh, '交給挑選函數者為複本')
        //舊帳本(無條件欄與因子序列欄): meta 三欄為 null, factor 拋「請重建帳本」
        let L0 = loadLedger(t.dir)
        L0.keySym = null
        L0.keyTh = null
        L0.keyOr = null
        Object.defineProperty(L0, 'fac', { value: null })
        let ev0 = makeEvaluator(L0, CFG)
        assert.deepEqual([ev0.meta.keySym, ev0.meta.keyTh, ev0.meta.keyOr], [null, null, null])
        assert.throws(() => ev0.runPick((ctx) => {
            ctx.factor(0, 3); return []
        }, 0), /請重建帳本/)
    })

    it('加條件欄與 ctx.factor 不改變既有數字:不呼叫 factor 之挑選,其 selHash 與績效在有 / 無此欄之帳本上相同', () => {
        //R-EV-29: 純新增之欄與存取函式; 成品之評估路徑不變
        let pick = (ctx) => {
            let S = ctx.stat(60)
            return Array.from({ length: ctx.n }, (_, s) => s).sort((a, b) => (S.pnl[b] - S.pnl[a]) || (ctx.meta.tie[a] - ctx.meta.tie[b])).slice(0, 10)
        }
        let a = ev.evalPolicy(pick, {})
        let L0 = loadLedger(t.dir)
        L0.keySym = null
        L0.keyTh = null
        L0.keyOr = null
        Object.defineProperty(L0, 'fac', { value: null })
        let b = makeEvaluator(L0, CFG).evalPolicy(pick, {})
        assert.equal(a.selHash, b.selHash)
        assert.deepEqual(a.op.eqYr, b.op.eqYr)
        assert.deepEqual(a.null, b.null)
    })

    it('同訊號量虛無:選集之每隻訊號數偏離全體隨機逾 10% 時才算,其隨機選集之隻數依訊號數之比放大或縮小', () => {
        //evalCore: 同劑量虛無只匹配隻數; 偏離逾 10% 時另以「隻數 × 訊號數之比」之隨機選集再算一組(nullVol)
        let nt = Array.from({ length: L.n }, (_, s) => L.off[s + 1] - L.off[s])
        let order = Array.from({ length: L.n }, (_, s) => s).sort((a, b) => nt[b] - nt[a])
        let busy = ev.evalPolicy(() => order.slice(0, 8), {})
        assert(busy.nullVol && busy.nullVol.ratio > 1.1, `最活躍之 8 隻: 訊號數之比 ${busy.nullVol && busy.nullVol.ratio}`)
        assert(busy.nullVol.sizeMean > 8 && Math.abs(busy.nullVol.sizeMean - Math.round(8 * busy.nullVol.ratio)) < 1e-9)
        assert.equal(busy.nullVol.draws, 16)
        assert(typeof busy.nullVol.p === 'number' && typeof busy.nullVol.excess === 'number')
        let quiet = ev.evalPolicy(() => order.slice(-8), {})
        assert(quiet.nullVol && quiet.nullVol.ratio < 0.9 && quiet.nullVol.sizeMean < 8)
        //訊號數與全體隨機相當(全體皆選)⇒ 不另算
        let all = ev.evalPolicy(() => order, { accept: (sig, book) => book.open < 5 })
        assert.equal(all.nullVol, null)
    })

    it('同活躍度虛無:與同訊號量虛無同一觸發條件;隨機選集只來自成品所在之活躍度層、各層隻數與成品相同', () => {
        //evalCore nullActOf: 活躍度 = 決策棒以前之累計進場數; 每次決策依其分層(同值者同層), 自各層抽與成品相同之隻數
        let nt = Array.from({ length: L.n }, (_, s) => L.off[s + 1] - L.off[s])
        let order = Array.from({ length: L.n }, (_, s) => s).sort((a, b) => nt[b] - nt[a])
        let quiet = ev.evalPolicy(() => order.slice(-8), {})
        assert(quiet.nullVol && quiet.nullAct && quiet.nullAct.bins === 10 && quiet.nullAct.draws === 16)
        assert(typeof quiet.nullAct.p === 'number' && typeof quiet.nullAct.excess === 'number' && quiet.nullAct.sigPerPick >= 0)
        let all = ev.evalPolicy(() => order, { accept: (sig, book) => book.open < 5 })
        assert.equal(all.nullAct, null)
        //獨立算各決策之分層(nBins 層; 層 = floor(累計進場數小於它之策略數 / n × nBins))
        let nBins = 5
        let bars = ev.decisionBars(0)
        let binAt = bars.map((b) => {
            let cnt = Array.from({ length: L.n }, (_, s) => {
                let c = 0
                for (let j = L.off[s]; j < L.off[s + 1] && L.ent[j] < b; j++) {
                    c++
                }
                return c
            })
            return cnt.map((c) => Math.min(nBins - 1, Math.floor(cnt.filter((x) => x < c).length / L.n * nBins)))
        })
        //成品: 每次決策取最低層之全部策略 + 最高層(該次有成員之最大層)之 2 隻
        let sels = binAt.map((bin) => {
            let top = Math.max(...bin)
            let lo = bin.map((v, s) => (v === 0 ? s : -1)).filter((s) => s >= 0)
            let hi = bin.map((v, s) => (v === top && top > 0 ? s : -1)).filter((s) => s >= 0).slice(0, 2)
            return Int32Array.from([...lo, ...hi].sort((a, b) => a - b))
        })
        let seen = []
        let rec = (sig) => {
            seen.push([sig.k, sig.sid])
            return true
        }
        let runs = [{ phase: 0, bars, sels, tags: bars.map(() => null) }]
        let vals = ev.nullActOf(runs, rec, 6, 123, nBins)
        assert.equal(vals.length, 6)
        assert(seen.length > 0, '須有訊號, 否則本案例無意義')
        for (let [k, sid] of seen) {
            let top = Math.max(...binAt[k])
            assert(binAt[k][sid] === 0 || binAt[k][sid] === top, `第 ${k} 次決策抽到第 ${binAt[k][sid]} 層之策略 ${sid}(成品只在最低與最高層)`)
        }
        //最低層全取 ⇒ 該層之每隻有訊號者每一抽皆出現(逐抽之訊號數不少於只取最低層者)
        let onlyLow = runs.map((r) => ({ ...r, sels: binAt.map((bin) => Int32Array.from(bin.map((v, s) => (v === 0 ? s : -1)).filter((s) => s >= 0))) }))
        let vLow = ev.nullActOf(onlyLow, null, 4, 9, nBins)
        let obsLow = ev.opOf(onlyLow[0].sels, bars, onlyLow[0].tags, null).eqYr
        assert(vLow.every((v) => Math.abs(v - obsLow) < 1e-9), '成品取某層之全部成員 ⇒ 隨機選集即成品本身, 各抽之績效與成品相同')
    })

    it('同側同活躍度虛無(組成對照):選集之每隻訊號數或做多比例偏離全體隨機逾 10% 時才算;每一隻換成同方向、活躍度名次相鄰之隨機一隻', () => {
        //evalCore nullSideActOf: 各側內依決策棒以前之累計進場數排名(同值依 tie), 自該隻名次 ± half 名內均勻抽一隻(同一選集內不重複)
        let nt = Array.from({ length: L.n }, (_, s) => L.off[s + 1] - L.off[s])
        let order = Array.from({ length: L.n }, (_, s) => s).sort((a, b) => nt[b] - nt[a])
        let quiet = ev.evalPolicy(() => order.slice(-8), {})
        assert(quiet.nullSideAct && quiet.nullSideAct.half === 50 && quiet.nullSideAct.draws === 16)
        assert(typeof quiet.nullSideAct.p === 'number' && typeof quiet.nullSideAct.excess === 'number' && ('share' in quiet.nullSideAct))
        assert.equal(quiet.nullSideAct.triggered, true, '每隻訊號數偏離 ⇒ triggered(列入階梯 1)')
        //一律計算; 選集之方向與活躍度未偏離全體隨機 ⇒ triggered = false(不入階梯)
        let all = ev.evalPolicy(() => order, { accept: (sig, book) => book.open < 5 })
        assert(all.nullSideAct && all.nullSideAct.triggered === false)
        //幾何對照(同側 × 止盈三等分 × 止損三等分 × 活躍度)同時輸出; 兩者皆帶各三等分段之均
        assert(quiet.nullSideGeo && quiet.nullSideGeo.nTp === 3 && quiet.nullSideGeo.nSl === 3 && typeof quiet.nullSideGeo.p === 'number')
        assert(quiet.nullSideAct.thirdsMean.length === 3 && quiet.nullSideGeo.thirdsMean.length === 3)
        //不算虛無時兩者皆無
        let q0 = ev.evalPolicy(() => order.slice(-8), { nullDraws: 0 })
        assert.deepEqual([q0.nullSideAct, q0.nullSideGeo], [null, null])
        //幾何分組: 各側內依止盈、止損各自三等分(同值依 tie); 替換只落在同一組
        let G = ev.sideGeoGroups(3, 3)
        assert.equal(G.nGroups, 18)
        for (let side of [1, -1]) {
            let ids = Array.from({ length: L.n }, (_, s) => s).filter((s) => (L.mode[s] > 0 ? 1 : -1) === side)
            let byTp = ids.slice().sort((a, b) => (ev.meta.tp[a] - ev.meta.tp[b]) || (ev.meta.tie[a] - ev.meta.tie[b]))
            byTp.forEach((s, i) => {
                let tq = Math.min(2, Math.floor(i * 3 / ids.length))
                assert.equal(Math.floor(G.grp[s] / 3) % 3, tq, `策略 ${s} 之止盈等分`)
                assert.equal(Math.floor(G.grp[s] / 9), side > 0 ? 0 : 1)
            })
        }
        {
            let bars0 = ev.decisionBars(0)
            let sels0 = bars0.map(() => Int32Array.from([1, 4, 7, 10, 13]))
            let seen0 = []
            ev.nullSideGeoOf([{ phase: 0, bars: bars0, sels: sels0, tags: bars0.map(() => null) }], (sig) => {
                seen0.push(sig.sid); return true
            }, 4, 77, 50)
            let want = new Set([1, 4, 7, 10, 13].map((s) => G.grp[s]))
            assert(seen0.length > 0 && seen0.every((sid) => want.has(G.grp[sid])), '幾何對照之替換者須與被替換者同組')
        }
        //只偏離方向(每隻訊號數相近)亦觸發: 只取做多者
        let longs = Array.from({ length: L.n }, (_, s) => s).filter((s) => L.mode[s] > 0)
        let shorts = Array.from({ length: L.n }, (_, s) => s).filter((s) => L.mode[s] < 0)
        assert(longs.length >= 6 && shorts.length >= 6, '合成帳本須兩側皆有策略')
        //獨立算各決策、各側之名次(累計進場數, 同值依 tie, 再依序號)
        let bars = ev.decisionBars(0)
        let tie = ev.meta.tie
        let rankAt = bars.map((b) => {
            let cnt = Array.from({ length: L.n }, (_, s) => {
                let c = 0
                for (let j = L.off[s]; j < L.off[s + 1] && L.ent[j] < b; j++) {
                    c++
                }
                return c
            })
            let rk = new Array(L.n)
            for (let side of [longs, shorts]) {
                side.slice().sort((x, y) => (cnt[x] - cnt[y]) || (tie[x] - tie[y]) || (x - y)).forEach((s, i) => {
                    rk[s] = i
                })
            }
            return rk
        })
        //成品: 每次決策取做多側名次 0、3、6 與做空側名次 2
        let sels = rankAt.map((rk) => Int32Array.from([...longs.filter((s) => [0, 3, 6].includes(rk[s])), ...shorts.filter((s) => rk[s] === 2)].sort((a, b) => a - b)))
        let runs = [{ phase: 0, bars, sels, tags: bars.map(() => null) }]
        let seen = []
        let rec = (sig) => {
            seen.push([sig.k, sig.sid])
            return true
        }
        let vals = ev.nullSideActOf(runs, rec, 6, 123, 1)
        assert.equal(vals.length, 6)
        assert(seen.length > 0, '須有訊號, 否則本案例無意義')
        for (let [k, sid] of seen) {
            let rk = rankAt[k][sid]
            let ok = L.mode[sid] > 0 ? [0, 3, 6].some((p) => Math.abs(rk - p) <= 1) : Math.abs(rk - 2) <= 1
            assert(ok, `第 ${k} 次決策抽到${L.mode[sid] > 0 ? '做多' : '做空'}側名次 ${rk} 之策略 ${sid}(成品在做多側 0 / 3 / 6、做空側 2;half = 1)`)
        }
        //half = 0 ⇒ 鄰域只有自己: 各抽之績效 = 成品
        let obs = ev.opOf(sels, bars, runs[0].tags, null).eqYr
        assert(ev.nullSideActOf(runs, null, 4, 9, 0).every((v) => Math.abs(v - obs) < 1e-9))
    })

    it('損益歸因(依方向、依 tag)與評估期間三等分:兩側之損益和 = 各 tag 之損益和 = 總損益;三等分 = 直接以各段計算者;只增輸出', () => {
        //evalCore evalPolicy: op.pnl / op.bySide / op.thirds、sel.tagPerf(各相位平均)
        let pick = (ctx) => ({ ids: [1, 4, 7, 10, 13, 16, 19, 22], tag: ctx.k % 2 ? 'odd' : 'even' })
        let accept = (sig, book) => book.open < 3
        let runs = null
        let m = ev.evalPolicy(pick, {
            accept,
            onRuns: (rs) => {
                runs = rs
            }
        })
        let near = (a, b, tol = 2e-3) => Math.abs(a - b) <= tol
        assert(near(m.op.bySide.long.pnl + m.op.bySide.short.pnl, m.op.pnl), `兩側 ${m.op.bySide.long.pnl} + ${m.op.bySide.short.pnl} ≠ 總 ${m.op.pnl}`)
        assert(near(m.op.bySide.long.orders + m.op.bySide.short.orders, m.op.nOrders.reduce((a, v) => a + v, 0) / m.op.nOrders.length))
        assert.deepEqual(m.sel.tagPerf.map((t) => t.tag).sort(), ['even', 'odd'])
        assert(near(m.sel.tagPerf.reduce((a, t) => a + t.pnl, 0), m.op.pnl))
        assert(near(m.sel.tagPerf.reduce((a, t) => a + t.decisions, 0), m.op.nDecisions.reduce((a, v) => a + v, 0) / m.op.nDecisions.length))
        //獨立計總損益: 以記錄用之 accept 重跑各相位
        let tot = 0
        for (let r of runs) {
            tot += ev.opOf(r.sels, r.bars, r.tags, accept).totalPnl
        }
        assert(near(tot / runs.length, m.op.pnl))
        //三等分: 各段自空倉起算
        assert.equal(m.op.thirds.length, 3)
        for (let g = 0; g < 3; g++) {
            let vs = runs.map((r) => {
                let nd = r.bars.length
                let a = Math.floor(nd * g / 3)
                let z = Math.floor(nd * (g + 1) / 3)
                return ev.opOf(r.sels.slice(a, z), r.bars.slice(a, z), r.tags.slice(a, z), accept, { k0: a }).eqYr
            })
            assert(near(m.op.thirds[g].eqYr.mean, vs.reduce((a, v) => a + v, 0) / vs.length, 1e-3))
            assert(typeof m.op.thirds[g].nullMean === 'number' && m.op.thirds[g].from < m.op.thirds[g].to)
        }
        //不算虛無時不給各段之隨機挑; 無 tag 時不給 tagPerf; 既有數字與 selHash 不因 tag 而變
        let m0 = ev.evalPolicy(() => [1, 4, 7, 10, 13, 16, 19, 22], { accept, nullDraws: 0 })
        assert(m0.op.thirds.every((g) => g.nullMean === undefined) && m0.sel.tagPerf === undefined)
        assert.equal(m0.selHash, m.selHash)
        assert.equal(m0.op.eqYr.mean, m.op.eqYr.mean)
    })

    it('擴充診斷(opt.ext):只拿得到唯讀之 api;結果附於 ext.<名稱>;拋錯或輸出過大只記 error;不改任何既有數字與 selHash', () => {
        //evalCore evalPolicy 之 ext(R-EV-21): 共用工具區 metrics/ 之診斷由評估器載入後以此介面執行
        let pick = (ctx) => ({ ids: [1, 4, 7, 10, 13, 16, 19, 22].map((s) => (s + ctx.k) % L.n), tag: ctx.k % 2 ? 'a' : 'b' })
        let accept = (sig, book) => book.open < 3
        let base = ev.evalPolicy(pick, { accept })
        let seen = null
        let m = ev.evalPolicy(pick, {
            accept,
            ext: [
                {
                    name: 'same',
                    fn: (api) => {
                        seen = api; let r = api.simulate(api.phases.map((p) => p.sels), api.phases.map((p) => p.tags)); return { text: 'ok', mean: r.mean, thirds: r.thirds }
                    }
                },
                { name: 'lag', fn: (api) => ({ mean: api.simulate(api.phases.map((p) => p.sels.map((_, k) => p.sels[Math.max(0, k - 2)]))).mean }) },
                {
                    name: 'nul',
                    fn: (api) => {
                        let g = api.geoGroups(3, 3); return { side: api.replaceNull({ draws: 4 }), recent: api.replaceNull({ actDays: 30, draws: 4 }), geo: api.replaceNull({ grp: g.grp, nGroups: g.nGroups, draws: 4 }), sum: api.summarize([1, 2, 3]) }
                    }
                },
                {
                    name: 'boom',
                    fn: () => {
                        throw new Error('壞了')
                    }
                },
                { name: 'big', fn: () => ({ s: 'x'.repeat(30000) }) },
                {
                    name: 'mut',
                    fn: (api) => {
                        try {
                            api.obs.mean = 999
                        }
                        catch (e) {} try {
                            api.phases[0].sels[0][0] = 0
                        }
                        catch (e) {} return { text: 'tried' }
                    }
                },
            ],
        })
        //既有數字與 selHash 不因擴充診斷(含試圖改 api 者)而變
        assert.equal(m.selHash, base.selHash)
        assert.deepEqual(m.op.eqYr, base.op.eqYr)
        assert.deepEqual(m.null, base.null)
        assert.equal(base.ext, undefined, '未給 ext 者無此欄')
        //以原選集重放 = 成品本身
        assert(Math.abs(m.ext.same.mean - m.op.eqYr.mean) < 1e-3 && m.ext.same.text === 'ok' && typeof m.ext.same.ms === 'number')
        assert(m.ext.same.thirds.every((v, g) => Math.abs(v - m.op.thirds[g].eqYr.mean) < 1e-3))
        assert(typeof m.ext.lag.mean === 'number')
        for (let k of ['side', 'recent', 'geo']) {
            assert(m.ext.nul[k].draws === 4 && typeof m.ext.nul[k].p === 'number' && m.ext.nul[k].thirdsMean.length === 3, k)
        }
        assert.equal(m.ext.nul.sum.mean, 2)
        assert(/壞了/.test(m.ext.boom.error) && /超過上限/.test(m.ext.big.error))
        //api: 凍結; 選集為複本; 不含帳本陣列
        assert(Object.isFrozen(seen) && Object.isFrozen(seen.obs) && !('L' in seen) && !('ent' in seen))
        assert.throws(() => seen.simulate([[]]), /相位數|決策數/)
        assert.throws(() => seen.replaceNull({ grp: [0, 1], nGroups: 2 }), /grp/)
    })

    it('擴充診斷之 simulate 與分帳(R-EV-27):元素明給 group 者照用(含全為 0);未給者沿用成品同一決策之分帳', () => {
        //成品: 8 席分兩帳(前 4 席子帳 0、後 4 席子帳 1), 各帳持倉上限 2 —— 子帳 1 之席受其自己之上限約束
        let ids = [1, 4, 7, 10, 13, 16, 19, 22]
        let pick = (ctx) => ({ ids: ids.map((s) => (s + ctx.k) % L.n), group: [0, 0, 0, 0, 1, 1, 1, 1] })
        let accept = (sig, book) => book.openGroup[sig.group] < 2
        let m = ev.evalPolicy(pick, {
            accept,
            ext: [{
                name: 'g',
                fn: (api) => {
                    let same = api.simulate(api.phases.map((p) => p.sels)).mean
                    //明給與成品相同之分帳 = 沿用
                    let given = api.simulate(api.phases.map((p) => p.sels.map((s, k) => ({ ids: Array.from(s), group: Array.from(p.groups[k]) })))).mean
                    //8 席明給 group 全為 0: 全部歸子帳 0(共用一個上限 2)
                    let all0 = api.simulate(api.phases.map((p) => p.sels.map((s) => ({ ids: Array.from(s), group: Array.from(s).map(() => 0) })))).mean
                    //不給 group: 沿用成品同一決策之分帳
                    let inherit = api.simulate(api.phases.map((p) => p.sels.map((s) => Array.from(s)))).mean
                    return { same, given, all0, inherit }
                },
            }],
        })
        let g = m.ext.g
        assert(!g.error, String(g.error))
        assert(Math.abs(g.same - m.op.eqYr.mean) < 1e-3 && Math.abs(g.given - g.same) < 1e-9 && Math.abs(g.inherit - g.same) < 1e-9, '沿用、不給、明給相同之分帳皆 = 成品')
        //獨立對照: 同一份選集而成品不分帳(全部在子帳 0, book.openGroup[0] = book.open)之等效年化
        let flat = ev.evalPolicy((ctx) => ids.map((s) => (s + ctx.k) % L.n), { accept }).op.eqYr.mean
        assert(Math.abs(g.all0 - flat) < 1e-3, `明給全 0 = 不分帳之成品(${g.all0} vs ${flat})`)
        assert(Math.abs(g.all0 - g.same) > 1e-9, '明給全 0 ≠ 沿用成品之分帳 —— 原實作把全 0 當成未給而沿用(= 成品)')
    })

    it('擴充診斷之 simulate 可換執行規則並回兩側歸因(R-EV-28):opts.accept 取代成品之 accept;未給者行為不變;bySide = 該次重放之兩側下單數與損益', () => {
        //成品: 依持倉簿之多空狀態下單(只在不落後多數側時加單); 對照: 同選集、中性之執行規則(book.open < 3)
        let ids = [1, 4, 7, 10, 13, 16, 19, 22]
        let pick = (ctx) => ids.map((s) => (s + ctx.k) % L.n)
        let sided = (sig, book) => book.open < 3 && (sig.mode > 0 ? book.openLong >= book.openShort : book.openShort >= book.openLong)
        let neutral = (sig, book) => book.open < 3
        let base = ev.evalPolicy(pick, { accept: sided })
        let m = ev.evalPolicy(pick, {
            accept: sided,
            ext: [{
                name: 'a',
                fn: (api) => {
                    let sels = api.phases.map((p) => p.sels)
                    let same = api.simulate(sels)
                    let neu = api.simulate(sels, null, { accept: neutral })
                    let none = api.simulate(sels, null, { accept: () => false })
                    let bad = null
                    try {
                        api.simulate(sels, null, { accept: 'x' })
                    }
                    catch (e) {
                        bad = String(e.message)
                    }
                    return { same, neu, none, bad }
                },
            }],
        })
        let a = m.ext.a
        assert(!a.error, String(a.error))
        //既有數字與 selHash 不因新選項而變
        assert.equal(m.selHash, base.selHash)
        assert.deepEqual(m.op.eqYr, base.op.eqYr)
        assert.deepEqual(m.op.bySide, base.op.bySide)
        //未給 opts: = 成品本身, bySide = 成品之兩側歸因
        assert(Math.abs(a.same.mean - m.op.eqYr.mean) < 1e-3)
        assert.deepEqual(a.same.bySide, m.op.bySide)
        //換成中性之執行規則: = 以該規則為 accept 之獨立評估(等效年化、三等分與兩側歸因)
        let ref = ev.evalPolicy(pick, { accept: neutral })
        assert(Math.abs(a.neu.mean - ref.op.eqYr.mean) < 1e-3, `${a.neu.mean} vs ${ref.op.eqYr.mean}`)
        assert(a.neu.thirds.every((v, g) => Math.abs(v - ref.op.thirds[g].eqYr.mean) < 1e-3))
        assert.deepEqual(a.neu.bySide, ref.op.bySide)
        assert(Math.abs(a.neu.mean - a.same.mean) > 1e-9 || a.neu.bySide.long.orders !== a.same.bySide.long.orders, '兩種執行規則須有差別(否則本測試無鑑別力)')
        //全部不下單: 0 單
        assert(a.none.mean === 0 && a.none.bySide.long.orders === 0 && a.none.bySide.short.orders === 0)
        assert(/opts\.accept/.test(a.bad))
    })

    it('擴充診斷之 simulate 可換同一進場棒之訊號次序(R-EV-32):opts.orderSalt 0 = 成品本身;非 0 = 以 tieSalt 重放時之同棒次序(選集不變);全收者不受影響;既有數字與 selHash 不變', () => {
        //合約 §7 之 simulate「opts.orderSalt」: 只換「同一進場棒之多個訊號之先後」—— 持倉上限擋單時誰先得席位
        //成品: 選集不依賴 ctx.meta.tie(固定序號隨決策序平移); 執行規則為持倉上限 2 ⇒ 同棒之多個訊號只有先被問到者下單
        let ids = Array.from({ length: 16 }, (_, i) => i * 2 + 1)
        let pick = (ctx) => ids.map((s) => (s + ctx.k) % L.n)
        let accept = (sig, book) => book.open < 2
        let base = ev.evalPolicy(pick, { accept })
        let m = ev.evalPolicy(pick, {
            accept,
            ext: [{
                name: 'o',
                fn: (api) => {
                    let sels = api.phases.map((p) => p.sels)
                    let pickOf = (r) => ({ mean: r.mean, byPhase: r.byPhase, thirds: r.thirds, bySide: r.bySide })
                    let bad = null
                    try {
                        api.simulate(sels, null, { orderSalt: 1.5 })
                    }
                    catch (e) {
                        bad = String(e.message)
                    }
                    return {
                        s0: pickOf(api.simulate(sels)),
                        z0: pickOf(api.simulate(sels, null, { orderSalt: 0 })),
                        s1: pickOf(api.simulate(sels, null, { orderSalt: 1 })),
                        s1b: pickOf(api.simulate(sels, null, { orderSalt: 1 })),
                        s2: pickOf(api.simulate(sels, null, { orderSalt: 2 })),
                        all0: pickOf(api.simulate(sels, null, { accept: () => true })),
                        all1: pickOf(api.simulate(sels, null, { accept: () => true, orderSalt: 1 })),
                        bad,
                    }
                },
            }],
        })
        let o = m.ext.o
        assert(!o.error, String(o.error))
        //既有數字與 selHash 不因新選項而變
        assert.equal(m.selHash, base.selHash)
        assert.deepEqual(m.op, base.op)
        //0 = 成品本身(逐位); 同一 salt 可重現
        assert.deepEqual(o.z0, o.s0)
        assert.deepEqual(o.s1b, o.s1)
        assert(Math.abs(o.s0.mean - m.op.eqYr.mean) < 1e-3)
        //獨立對照: 選集不依賴 tie ⇒ 以 tieSalt k 另建評估器評估同一成品, 差別只在同棒訊號次序 = orderSalt k
        for (let [k, r] of [[1, o.s1], [2, o.s2]]) {
            let ref = makeEvaluator(loadLedger(t.dir), { ...CFG, tieSalt: k }).evalPolicy(pick, { accept, nullDraws: 0 })
            assert.equal(ref.selHash === base.selHash, false, `salt ${k}: 同棒次序不同 ⇒ 下單序列之指紋應不同(否則本測試無鑑別力)`)
            assert(Math.abs(r.mean - ref.op.eqYr.mean) < 1e-3, `salt ${k}: ${r.mean} vs ${ref.op.eqYr.mean}`)
            assert.deepEqual(r.bySide, ref.op.bySide, `salt ${k}`)
            assert(r.thirds.every((v, g) => Math.abs(v - ref.op.thirds[g].eqYr.mean) < 1e-3), `salt ${k} 三等分`)
        }
        assert(Math.abs(o.s1.mean - o.s0.mean) > 1e-9 || Math.abs(o.s2.mean - o.s0.mean) > 1e-9, '換次序須改變結果(否則本測試無鑑別力)')
        //全部放行: 次序不影響哪些單成交 ⇒ 結果相同(只差浮點加總之次序)
        assert(Math.abs(o.all1.mean - o.all0.mean) < 1e-9)
        assert.deepEqual(o.all1.bySide, o.all0.bySide)
        assert(/orderSalt/.test(o.bad))
    })

    it('依子帳之損益歸因(R-EV-33):op.byGroup 之各列和 = 總單數與 op.pnl;未分帳者只有子帳 0 一列;simulate 之 byGroup 同定義;加此欄不改既有數字', () => {
        //合約 §5「損益歸因」之 metrics.op.byGroup = [{ group, seats, orders, pnl, winRate }](每張單歸到其策略所屬之子帳)
        let ids = [1, 4, 7, 10, 13, 16, 19, 22]
        let grp = [0, 0, 0, 0, 1, 1, 1, 1]
        let near = (a, b, tol = 2e-3) => Math.abs(a - b) <= tol
        let sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0)
        let ordersMean = (m) => m.op.nOrders.reduce((a, v) => a + v, 0) / m.op.nOrders.length
        //未分帳: 只有子帳 0 一列 = 全體
        let acceptFlat = (sig, book) => book.open < 3
        let flat = ev.evalPolicy((ctx) => ids.map((s) => (s + ctx.k) % L.n), { accept: acceptFlat, nullDraws: 0 })
        assert.equal(flat.op.byGroup.length, 1)
        assert.equal(flat.op.byGroup[0].group, 0)
        assert(near(flat.op.byGroup[0].seats, flat.sel.sizeMean) && near(flat.op.byGroup[0].orders, ordersMean(flat)) && near(flat.op.byGroup[0].pnl, flat.op.pnl))
        //勝率 = 全部已結之單合併計(同 bySide)⇒ 介於兩側之勝率之間
        let wl = flat.op.bySide.long.winRate
        let ws = flat.op.bySide.short.winRate
        assert(flat.op.byGroup[0].winRate >= Math.min(wl, ws) - 1e-4 && flat.op.byGroup[0].winRate <= Math.max(wl, ws) + 1e-4)
        //分帳 + 各帳各設上限(逐訊號之路徑): 兩列; 各列和 = 總單數與 op.pnl; 各帳之單數 = 以記錄用之 accept 獨立數得者
        let pick = (ctx) => ({ ids: ids.map((s) => (s + ctx.k) % L.n), group: grp })
        let accept = (sig, book) => book.openGroup[sig.group] < 2
        let runs = null
        let sim = null
        let m = ev.evalPolicy(pick, {
            accept,
            nullDraws: 0,
            onRuns: (rs) => {
                runs = rs
            },
            ext: [{
                name: 'g',
                fn: (api) => {
                    let sels = api.phases.map((p) => p.sels)
                    sim = {
                        same: api.simulate(sels).byGroup,
                        all0: api.simulate(api.phases.map((p) => p.sels.map((s) => ({ ids: Array.from(s), group: Array.from(s).map(() => 0) })))).byGroup,
                        only1: api.simulate(api.phases.map((p) => p.sels.map((s, k) => ({ ids: Array.from(s).filter((_, q) => p.groups[k][q] === 1), group: Array.from(s).filter((_, q) => p.groups[k][q] === 1).map(() => 1) })))).byGroup,
                    }
                    return { text: 'ok' }
                },
            }],
        })
        assert(!m.ext.g.error, String(m.ext.g.error))
        assert.deepEqual(m.op.byGroup.map((r) => r.group), [0, 1])
        assert(m.op.byGroup.every((r) => near(r.seats, 4)))
        assert(near(sum(m.op.byGroup, (r) => r.orders), ordersMean(m)), '各子帳之單數和 = 總單數')
        assert(near(sum(m.op.byGroup, (r) => r.pnl), m.op.pnl), '各子帳之損益和 = op.pnl')
        assert(near(sum(m.op.byGroup, (r) => r.pnl), m.op.bySide.long.pnl + m.op.bySide.short.pnl))
        let cnt = [0, 0]
        let rec = (sig, book) => {
            let ok = accept(sig, book); if (ok) {
                cnt[sig.group]++
            } return ok
        }
        for (let r of runs) {
            ev.opOf(r.sels, r.bars, r.tags, rec, { k0: r.k0 })
        }
        assert(cnt[0] > 0 && cnt[1] > 0, '兩帳皆須有單(否則本測試無鑑別力)')
        assert(near(m.op.byGroup[0].orders, cnt[0] / runs.length) && near(m.op.byGroup[1].orders, cnt[1] / runs.length), `${JSON.stringify(m.op.byGroup)} vs ${cnt}`)
        //simulate: 沿用成品之分帳 = 成品之 byGroup; 明給全 0 ⇒ 只有子帳 0 一列; 只留子帳 1 之席 ⇒ 只有子帳 1 一列, 且 = 成品之該列(各帳之上限互不影響)
        assert.deepEqual(sim.same, m.op.byGroup)
        assert.deepEqual(sim.all0.map((r) => r.group), [0])
        assert(near(sim.all0[0].seats, 8))
        assert.deepEqual(sim.only1, [m.op.byGroup[1]])
        //全收之路徑(無 accept): 子帳 g 之損益 = 只評估該帳之席者之 op.pnl
        let free = ev.evalPolicy(pick, { nullDraws: 0 })
        assert.deepEqual(free.op.byGroup.map((r) => r.group), [0, 1])
        for (let g of [0, 1]) {
            let part = ev.evalPolicy((ctx) => ids.filter((_, q) => grp[q] === g).map((s) => (s + ctx.k) % L.n), { nullDraws: 0 })
            assert(near(free.op.byGroup[g].pnl, part.op.pnl) && near(free.op.byGroup[g].orders, ordersMean(part)), `全收之子帳 ${g}: ${JSON.stringify(free.op.byGroup[g])} vs 損益 ${part.op.pnl}、${ordersMean(part)} 單`)
        }
        //加此欄不改既有數字: 分帳而 accept 不讀子帳者 = 不分帳之成品
        let grouped = ev.evalPolicy(pick, { accept: acceptFlat, nullDraws: 0 })
        assert.equal(grouped.selHash, flat.selHash)
        assert.deepEqual(grouped.op.eqYr, flat.op.eqYr)
        assert.deepEqual(grouped.op.bySide, flat.op.bySide)
    })

    it('下單集中度:實際下單之不同策略數、因子組合數、前 1% 進場棒之占比與單棒最多下單數;加此欄不改變 selHash 與既有數字', () => {
        //evalCore ordersOf: 各相位分別彙整後取平均(perBarMax 取最大)
        let pick = () => [1, 4, 7, 10, 13, 16, 19, 22]
        let accept = (sig, book) => book.open < 3
        let m = ev.evalPolicy(pick, { accept })
        //獨立計: 以記錄用之 accept 重跑各相位之操作績效
        let per = CFG.phases.map((ph) => {
            let r = ev.runPick(pick, ph, CFG.seed)
            let book = new Map()
            let bar = new Map()
            ev.opOf(r.sels, r.bars, r.tags, (sig, bk) => {
                let ok = accept(sig, bk)
                if (ok) {
                    book.set(sig.sid, (book.get(sig.sid) || 0) + 1)
                    bar.set(sig.bar, (bar.get(sig.bar) || 0) + 1)
                }
                return ok
            })
            let combos = new Set([...book.keys()].map((s) => Array.from(L.keyIdx.subarray(L.keyOff[s], L.keyOff[s + 1])).sort((a, b) => a - b).join(',')))
            let cnts = [...bar.values()].sort((a, b) => b - a)
            let nOrd = cnts.reduce((s, v) => s + v, 0)
            let top = Math.max(1, Math.ceil(r.bars.length * 7 * L.barsPerDay * 0.01))
            return { strats: book.size, combos: combos.size, share: nOrd > 0 ? cnts.slice(0, top).reduce((s, v) => s + v, 0) / nOrd : 0, max: cnts[0] || 0 }
        })
        let avg = (k) => per.reduce((s, x) => s + x[k], 0) / per.length
        assert(per.every((x) => x.strats > 0), '須有下單, 否則本案例無意義')
        assert(Math.abs(m.sel.orders.strats - avg('strats')) < 1e-3 && Math.abs(m.sel.orders.combos - avg('combos')) < 1e-3)
        assert(Math.abs(m.sel.orders.barTop1Share - avg('share')) < 1e-3)
        assert.equal(m.sel.orders.perBarMax, Math.max(...per.map((x) => x.max)))
        assert(m.sel.orders.perBarMax <= 3, '持倉上限 3 ⇒ 單一進場棒至多 3 單')
        //無 accept(全收)之路徑亦給此欄
        let m0 = ev.evalPolicy(pick, {})
        assert(m0.sel.orders.strats > 0 && m0.sel.orders.strats <= 8)
        //重跑之 selHash 與等效年化不變(收集不影響數字)
        let m2 = ev.evalPolicy(pick, { accept })
        assert.deepEqual([m2.selHash, m2.op.eqYr.mean], [m.selHash, m.op.eqYr.mean])
    })

    it('opOf 之 k0:切片重放時執行規則收到之 sig.k = 切片內序 + k0(與挑選函數之 ctx.k 一致)', () => {
        //合約 §2: 回測期重放之 ctx.k 自帳本起點之第一個決策起算; accept 之 sig.k 同
        let r = ev.runPick(() => [0, 1, 2, 3, 4, 5], 0, 1)
        let ks = new Set()
        ev.opOf(r.sels.slice(3), r.bars.slice(3), r.tags.slice(3), (sig) => {
            ks.add(sig.k)
            return true
        }, { k0: 3 })
        assert(ks.size > 0 && Math.min(...ks) >= 3 && Math.max(...ks) <= r.bars.length - 1)
        let ks0 = new Set()
        ev.opOf(r.sels.slice(3), r.bars.slice(3), r.tags.slice(3), (sig) => {
            ks0.add(sig.k)
            return true
        })
        assert(Math.min(...ks0) < 3, '未給 k0 時自 0 起算')
    })

    it('ctx.meta.tie:各策略相異、重建後相同、與序號大小無單調關係', () => {
        //合約 §3: tie 為各策略固定之亂數, 供排序同分時作次鍵
        let tie = Array.from(ev.meta.tie)
        assert.equal(new Set(tie).size, L.n)
        assert.deepEqual(tie, Array.from(makeEvaluator(loadLedger(t.dir), CFG).meta.tie))
        let asc = tie.every((v, i) => i === 0 || v > tie[i - 1])
        let desc = tie.every((v, i) => i === 0 || v < tie[i - 1])
        assert(!asc && !desc)
    })

    it('cfg.tieSalt(迴圈之重放用):另一組固定之同分次序 —— 值仍兩兩相異、次序與正本不同、同一 salt 可重現;以 tie 為唯一排序鍵之挑選其選集隨之改變,正本(未給 / 0)不變', () => {
        //規則 R-EV-22: 主鍵大量同分之成品其入選者實際由 tie 決定, 只換亂數種子驗不到 ⇒ 重放時另換同分次序
        let L2 = loadLedger(t.dir)
        let tie0 = Array.from(ev.meta.tie)
        assert.deepEqual(Array.from(makeEvaluator(L2, { ...CFG, tieSalt: 0 }).meta.tie), tie0)
        let ev1 = makeEvaluator(L2, { ...CFG, tieSalt: 1 })
        let ev2 = makeEvaluator(L2, { ...CFG, tieSalt: 2 })
        let tie1 = Array.from(ev1.meta.tie)
        let tie2 = Array.from(ev2.meta.tie)
        assert.equal(new Set(tie1).size, L.n)
        assert.equal(new Set(tie2).size, L.n)
        assert.deepEqual(tie1, Array.from(makeEvaluator(L2, { ...CFG, tieSalt: 1 }).meta.tie))
        let order = (tie) => tie.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(',')
        assert.notEqual(order(tie1), order(tie0))
        assert.notEqual(order(tie2), order(tie1))
        //主鍵全部同分(常數) ⇒ 入選者 = tie 最小之前 5 隻
        let pick = (ctx) => Array.from({ length: ctx.n }, (_, i) => i).sort((a, b) => ctx.meta.tie[a] - ctx.meta.tie[b]).slice(0, 5)
        let opt = { phases: [0], horizons: [7], nullDraws: 0 }
        let m0 = ev.evalPolicy(pick, opt)
        let m1 = ev1.evalPolicy(pick, opt)
        assert.equal(makeEvaluator(L2, CFG).evalPolicy(pick, opt).selHash, m0.selHash)
        assert.notEqual(m1.selHash, m0.selHash)
    })

    it('分帳(pick 回傳 group):未回傳者 book.openGroup[0] 恆等於 book.open;回傳而 accept 不讀者數字與 selHash 不變;各子帳各設上限時各帳之同時持倉不逾其上限;虛無之替換沿用子帳', () => {
        //規則 R-EV-23: 兩條名單於同一持倉上限下互相排擠 ⇒ 讓成品把席次分成子帳、各自設上限
        let top = (ctx, k) => Array.from({ length: ctx.n }, (_, i) => i).sort((a, b) => ctx.meta.tie[a] - ctx.meta.tie[b]).slice(0, k)
        let opt = { phases: [0, 3], horizons: [7], nullDraws: 0 }
        //① 未回傳 group: openGroup[0] = open, 其餘為 0; sig.group = 0
        let bad = 0
        let accPlain = (sig, book) => {
            if (sig.group !== 0 || book.openGroup[0] !== book.open || book.openGroup[1] + book.openGroup[2] + book.openGroup[3] !== 0) {
                bad++
            }
            return book.open < 6
        }
        let m0 = ev.evalPolicy((ctx) => top(ctx, 12), { ...opt, accept: accPlain })
        assert.equal(bad, 0)
        //② 回傳 group 而 accept 不讀它: 與未回傳者逐項相同
        let withG = (ctx) => {
            let ids = top(ctx, 12); return { ids, group: ids.map((_, i) => i % 2) }
        }
        let m1 = ev.evalPolicy(withG, { ...opt, accept: (sig, book) => book.open < 6 })
        assert.equal(m1.selHash, m0.selHash)
        assert.deepEqual(m1.op.eqYr, m0.op.eqYr)
        assert.equal(m1.op.peakHold.max, m0.op.peakHold.max)
        //③ 各子帳各設上限 3: 各帳之同時持倉 ≤ 3、各帳之和 = open; 兩帳皆有下單
        let peak = [0, 0, 0, 0]
        let sumBad = 0
        let accG = (sig, book) => {
            if (book.openGroup.reduce((a, v) => a + v, 0) !== book.open) {
                sumBad++
            }
            let ok = book.openGroup[sig.group] < 3
            if (ok) {
                peak[sig.group] = Math.max(peak[sig.group], book.openGroup[sig.group] + 1)
            }
            return ok
        }
        let m2 = ev.evalPolicy(withG, { ...opt, accept: accG })
        assert.equal(sumBad, 0)
        assert(peak[0] > 0 && peak[1] > 0 && peak[0] <= 3 && peak[1] <= 3 && peak[2] === 0)
        assert(m2.op.peakHold.max <= 6)
        //虛無與組成對照: 替換後之選集沿用子帳(兩帳皆收到訊號)
        let seen = [0, 0, 0, 0]
        ev.evalPolicy(withG, {
            phases: [0],
            horizons: [7],
            nullDraws: 4,
            accept: (sig, book) => {
                seen[sig.group]++; return book.openGroup[sig.group] < 3
            }
        })
        assert(seen[0] > 0 && seen[1] > 0 && seen[2] === 0)
        //不合法之 group
        assert.throws(() => ev.evalPolicy((ctx) => ({ ids: top(ctx, 4), group: [0, 1] }), opt), /group 須與 ids 等長/)
        assert.throws(() => ev.evalPolicy((ctx) => ({ ids: top(ctx, 2), group: [0, 9] }), opt), /group 含不合法之值/)
    })
})

describe('evalCore:同劑量虛無', function () {
    let t
    after(() => {
        t.cleanup()
    })

    it('同一進場棒之多個訊號依 tie 定先後(不依策略序號);輸出含選集組成並與虛無並列', () => {
        let t2 = makeTmp('evalCoreTie')
        try {
            writeSynthLedger(t2.dir, { n: 40, nBars: 2400, seed: 9, identical: true })
            let L = loadLedger(t2.dir)
            let ev = makeEvaluator(L, CFG)
            let tie = ev.meta.tie
            //挑兩隻: a 之序號較小而 tie 較大(若依序號則 a 先, 依 tie 則 b 先)
            let a = -1
            let b = -1
            for (let i = 0; i < L.n && a < 0; i++) {
                for (let j = i + 1; j < L.n; j++) {
                    if (tie[i] > tie[j]) {
                        a = i
                        b = j
                        break
                    }
                }
            }
            assert(a >= 0 && b > a)
            let firstAt = new Map()
            ev.opOf([Int32Array.from([a, b])], [ev.decisionBars(0)[0]], [null], (sig) => {
                if (!firstAt.has(sig.bar)) {
                    firstAt.set(sig.bar, sig.sid)
                }
                return true
            })
            //evalCore: 同一進場棒之多個訊號依各策略固定之亂數 tie 定先後
            assert(firstAt.size > 0, '兩隻策略之訂單相同 ⇒ 每個進場棒都有兩個訊號')
            assert([...firstAt.values()].every((sid) => sid === b), '每個進場棒先問到的都是 tie 較小者')
            //選集組成: 每隻每個決策視窗之訊號數、做多比例等; 虛無亦給同名欄
            let m = ev.evalPolicy(() => [a, b], {})
            let nLong = (L.mode[a] > 0 ? 1 : 0) + (L.mode[b] > 0 ? 1 : 0)
            assert.equal(m.sel.longRatio, nLong / 2)
            assert(m.sel.sigPerPick > 0 && m.sel.nKeysMean === 1 && Math.abs(m.sel.tpMean - 0.05) < 1e-6)
            assert(m.null.sigPerPick > 0 && m.null.longRatio > 0 && m.null.longRatio < 1)
            //全部策略之訂單相同 ⇒ 每隻每視窗之訊號數與虛無相同
            assert(Math.abs(m.sel.sigPerPick - m.null.sigPerPick) < 1e-3)
        }
        finally {
            t2.cleanup()
        }
    })

    it('全部策略之訂單相同時,任何挑法之績效 = 同劑量虛無(超額 0、p = 1)', () => {
        t = makeTmp('evalCoreNull')
        writeSynthLedger(t.dir, { n: 40, nBars: 2400, seed: 9, identical: true })
        let ev = makeEvaluator(loadLedger(t.dir), CFG)
        let m = ev.evalPolicy((ctx) => [0, 5, 9, 12, 20, 33], { accept: (sig, book) => book.open < 4 })
        //合約 §5: 同劑量虛無 = 同決策日、同選集大小、同 accept 之隨機挑; 策略無差別時隨機挑與任何挑法之績效相同
        assert.equal(m.null.draws, 16)
        assert(Math.abs(m.null.excess) < 1e-6, `超額應為 0, 實得 ${m.null.excess}`)
        assert.equal(m.null.p, 1)
        assert(m.op.nOrders.every((v) => v > 0), '須有下單, 否則本案例無意義')
    })
})
