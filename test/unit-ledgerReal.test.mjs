import assert from 'assert'
import fs from 'fs'
import path from 'path'
import runStrategy from 'w-trade-backtest/src/runStrategy.mjs'
import ott from 'w-trade-backtest/src/ott.mjs'
import { getSettings } from '../src/cfg.mjs'
import { loadLedger, loadIds } from '../src/eval/ledger.mjs'
import { makeEvaluator } from '../src/eval/evalCore.mjs'


//評估帳本(真實資料; 訓練期 + 回測期)與官方回測之一致性(R-EV-1、R-EV-4); 帳本或策略庫不在本機時略過(兩者皆不入版控)
describe('ledger(真實帳本):與官方 runStrategy 逐張一致', function () {
    let st = getSettings()
    let lib = st.source.libraryRoot
    let has = fs.existsSync(path.join(st.eval.ledgerDir, 'meta.json')) && fs.existsSync(path.join(lib, 'strategies'))

    it('帳本之終點 = 回測期終點(不含保留期);建置時之求解窗成交數核對全數一致', function () {
        if (!has) {
            this.skip()
        }
        let meta = JSON.parse(fs.readFileSync(path.join(st.eval.ledgerDir, 'meta.json'), 'utf8'))
        //R-EV-4: 評估帳本止於回測期終點, 不含保留期(holdoutFrom 起)之 K 線
        assert.equal(meta.endTime, st.periods.backtest.end)
        assert(Date.parse(`${meta.endTime}Z`) < Date.parse(`${st.periods.holdoutFrom}Z`), '帳本不得進入保留期')
        //R-EV-1: 帳本於各策略求解窗內之進場數 = 策略檔所存之成交數(可核對者全數一致)
        assert(meta.check.compared > 1000, `可核對之策略數 ${meta.check.compared}`)
        assert.equal(meta.check.same, meta.check.compared)
    })

    it('抽樣 12 隻:帳本之每張單(進場棒、出場棒、每單位損益)= 官方 runStrategy 之結果', async function () {
        if (!has) {
            this.skip()
        }
        this.timeout(170000)
        let L = loadLedger(st.eval.ledgerDir)
        let ids = loadIds(st.eval.ledgerDir)
        let end = L.meta.endTime //帳本自己之終點(回測期終點): 官方回測之資料於同一時點截斷
        let arrOhlc = JSON.parse(fs.readFileSync(path.join(lib, 'ohlc', `${st.source.keyOhlc}.json`), 'utf8')).filter((r) => r.time < end)
        let indOf = new Map(arrOhlc.map((r, i) => [r.time, i]))
        let cache = new Map()
        let funGetSeries = async (key) => {
            if (key === st.source.keyOhlc) {
                return arrOhlc
            }
            if (!cache.has(key)) {
                cache.set(key, JSON.parse(fs.readFileSync(path.join(lib, 'param', `${key}.json`), 'utf8')).filter((r) => r.time < end))
            }
            return cache.get(key)
        }
        let seed = 20261110
        let rnd = () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
            return seed / 4294967296
        }
        let nOrd = 0
        for (let k = 0; k < 12; k++) {
            let si = Math.floor(rnd() * L.n)
            let s = JSON.parse(fs.readFileSync(path.join(lib, 'strategies', ids[si]), 'utf8'))
            let r = await runStrategy(ott, s, funGetSeries, { withSummary: false })
            let os = r.orders
            //R-EV-1: 單數相同, 且逐張之進場棒、出場棒(未結為 -1)、每單位損益相同
            assert.equal(os.length, L.off[si + 1] - L.off[si], `${ids[si]} 之單數`)
            for (let q = 0; q < os.length; q++) {
                let j = L.off[si] + q
                let o = os[q]
                assert.equal(indOf.get(o.timeStart), L.ent[j], `${ids[si]} 第 ${q} 單之進場棒`)
                assert.equal(o.timeEnd ? indOf.get(o.timeEnd) : -1, L.ext[j], `${ids[si]} 第 ${q} 單之出場棒`)
                assert(Math.abs((o.timeEnd ? o.uProfitOrLoss / o.uTrade : 0) - L.pnl[j]) < 1e-6, `${ids[si]} 第 ${q} 單之損益`)
            }
            nOrd += os.length
        }
        assert(nOrd > 100, `抽樣之總單數 ${nOrd} 應足夠`)
    })

    it('進場規則之條件欄與因子序列(R-EV-29):抽樣 12 隻,以 ctx.factor 與 keySym / keyTh / keyOr 重算決策棒以前 30 日之進場 = ctx.entryDays;條件欄 = 策略檔之 conds', function () {
        if (!has || !fs.existsSync(path.join(st.eval.ledgerDir, 'fac.f64'))) {
            this.skip()
        }
        this.timeout(170000)
        let L = loadLedger(st.eval.ledgerDir)
        let ids = loadIds(st.eval.ledgerDir)
        let ev = makeEvaluator(L, { warmupDays: st.eval.warmupDays, cadenceDays: st.eval.cadenceDays })
        let seed = 20261114
        let rnd = () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
            return seed / 4294967296
        }
        let pickS = Array.from({ length: 12 }, () => Math.floor(rnd() * L.n))
        let m = ev.meta
        //條件欄 = 策略檔之 conds(逐格: 因子名、比較方向、門檻、and / or)
        for (let s of pickS) {
            let conds = JSON.parse(fs.readFileSync(path.join(lib, 'strategies', ids[s]), 'utf8')).conds
            assert.equal(m.keyOff[s + 1] - m.keyOff[s], conds.length, `${ids[s]} 之條件數`)
            conds.forEach((c, q) => {
                let i = m.keyOff[s] + q
                assert.equal(m.keyNames[m.keyIdx[i]], c.key)
                assert.equal(m.keySym[i], (c.sym === undefined ? '>' : c.sym) === '>' ? 1 : -1)
                assert.equal(m.keyTh[i], c.th === undefined ? 0 : c.th)
                assert.equal(m.keyOr[i], c.opr === 'or' ? 1 : 0)
            })
        }
        //合約 §3: 策略於某棒進場 ⇔ 各條件於該棒皆有值、and 條件全成立、且(無 or 條件或至少一個 or 條件成立)
        let nDec = 0
        let nEnt = 0
        let bpd = m.barsPerDay
        ev.runPick((ctx) => {
            if (ctx.k % 8 !== 0) {
                return []
            }
            let W = 30 * bpd
            for (let s of pickS) {
                let cs = []
                for (let i = m.keyOff[s]; i < m.keyOff[s + 1]; i++) {
                    cs.push({ v: ctx.factor(m.keyIdx[i], W), gt: m.keySym[i] > 0, th: m.keyTh[i], isOr: m.keyOr[i] === 1 })
                }
                let days = []
                for (let i = 0; i < W; i++) {
                    let skip = false
                    let okAnd = true
                    let hasOr = false
                    let okOr = false
                    for (let c of cs) {
                        let y = c.v[i]
                        if (Number.isNaN(y)) {
                            skip = true
                            break
                        }
                        let ok = c.gt ? y > c.th : y < c.th
                        if (c.isOr) {
                            hasOr = true
                            okOr = okOr || ok
                        }
                        else {
                            okAnd = okAnd && ok
                        }
                    }
                    if (!skip && okAnd && (!hasOr || okOr)) {
                        days.push(Math.floor((ctx.bar - W + i) / bpd))
                    }
                }
                assert.deepEqual(days, Array.from(ctx.entryDays(s, 30)), `${ids[s]} 決策棒 ${ctx.bar} 之前 30 日之進場`)
                nEnt += days.length
            }
            //factor(ki, 1)[0] = 該因子於決策棒前一根之值(帳本之因子序列欄)
            let ki = m.keyIdx[m.keyOff[pickS[0]]]
            assert(Object.is(ctx.factor(ki, 1)[0], L.fac[ki * L.nBars + ctx.bar - 1]))
            nDec++
            return []
        }, 0)
        assert(nDec >= 20, `核對之決策數 ${nDec}`)
        assert(nEnt > 100, `重算之進場數 ${nEnt} 應足夠`)
    })
})
