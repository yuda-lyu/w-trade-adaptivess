import assert from 'assert'
import { scoreOf } from '../src/eval/score.mjs'


//判讀(src/eval/score.mjs 檔頭之規則): S、階梯 1 ~ 4、否決、回測期旗標
const OPT = { limits: { monthlyOrders: 400, peakHold: 50 }, score: { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] } }

let mk = (o = {}) => ({
    op: { eqYr: { mean: o.mean === undefined ? 40 : o.mean, min: o.min === undefined ? 30 : o.min }, monthlyOrders: { mean: o.mo === undefined ? 80 : o.mo }, peakHold: { max: o.pk === undefined ? 25 : o.pk } },
    fresh: { 7: { eqYr: { mean: o.fresh === undefined ? 20 : o.fresh } }, 30: { eqYr: { mean: o.fresh === undefined ? 20 : o.fresh } } },
    sel: { sizeMax: o.sizeMax === undefined ? 40 : o.sizeMax },
    null: o.noNull ? null : { p: o.p === undefined ? 0.0154 : o.p },
})

describe('score:S、階梯與否決', function () {
    it('S = 0.7 × 七相位平均 + 0.3 × 最差相位', () => {
        assert.equal(scoreOf(mk({ mean: 40, min: 30 }), OPT).S, 37)
        assert.equal(scoreOf(mk({ mean: 10.123, min: -5 }), OPT).S, 5.59)
    })

    it('階梯 1:S ≥ 門檻且同劑量虛無 p ≤ 門檻;未算虛無或 p 過大者為 0', () => {
        assert.equal(scoreOf(mk({ fresh: 0 }), OPT).ladder, 1)
        assert.equal(scoreOf(mk({ p: 0.06 }), OPT).ladder, 0)
        assert.equal(scoreOf(mk({ noNull: true }), OPT).ladder, 0)
        assert.equal(scoreOf(mk({ mean: 10, min: 10 }), OPT).ladder, 0)
    })

    it('階梯 1:另算了同訊號量虛無者,其 p 亦須 ≤ 門檻', () => {
        //檔頭: 評估器另算了「同訊號量虛無」者, 其 p 亦須 ≤ ladder1.nullP
        let m = mk()
        m.nullVol = { p: 0.4, excess: -10 }
        let s = scoreOf(m, OPT)
        assert.equal(s.ladder, 0)
        assert(s.flags.why.some((w) => /同訊號量虛無 p 0\.4/.test(w)))
        m.nullVol = { p: 0.03, excess: 5 }
        assert.equal(scoreOf(m, OPT).ladder, 3)
    })

    it('階梯 1:另算了同活躍度虛無者,其 p 亦須 ≤ 門檻(選集只是較安靜 / 較活躍而無其他內容者不算過)', () => {
        //score.mjs: actOk = 未算同活躍度虛無, 或其 p ≤ ladder1.nullP
        let m = mk()
        m.nullVol = { p: 0.02, excess: 28 }
        m.nullAct = { p: 0.6, excess: 1 }
        let s = scoreOf(m, OPT)
        assert.equal(s.ladder, 0)
        assert(s.flags.why.some((w) => /同活躍度虛無 p 0\.6/.test(w)))
        m.nullAct = { p: 0.03, excess: 9 }
        assert.equal(scoreOf(m, OPT).ladder, 3)
    })

    it('階梯 1:另算了同側同活躍度虛無(組成對照)者,其 p 亦須 ≤ 門檻(績效可由「方向 × 活躍度」之組成重現者不算過)', () => {
        //score.mjs: sideOk = 未算同側同活躍度虛無, 或其 p ≤ ladder1.nullP(規則 R-EV-18)
        let m = mk()
        m.nullVol = { p: 0.02, excess: 90 }
        m.nullAct = { p: 0.02, excess: 95 }
        m.nullSideAct = { p: 0.37, excess: 0.9, share: 0.98 }
        let s = scoreOf(m, OPT)
        assert.equal(s.ladder, 0)
        assert.equal(s.flags.vetoed, false, '不過階梯 1 不是否決')
        assert(s.flags.why.some((w) => w.includes('同側同活躍度虛無 p 0.37') && w.includes('組成可重現 98%')))
        m.nullSideAct = { p: 0.03, excess: 20, share: 0.4 }
        assert.equal(scoreOf(m, OPT).ladder, 3)
        m.nullSideAct = null
        assert.equal(scoreOf(m, OPT).ladder, 3, '未算者不受此列影響')
        //一律計算: triggered = false(選集之每隻訊號數與做多比例皆與全體隨機相近)者不列入階梯 1; 無 triggered 欄之舊結果視為 triggered
        m.nullSideAct = { p: 0.6, excess: -1, share: 1.1, triggered: false }
        let s2 = scoreOf(m, OPT)
        assert.equal(s2.ladder, 3)
        m.nullSideAct = { p: 0.6, excess: -1, share: 1.1, triggered: true }
        assert.equal(scoreOf(m, OPT).ladder, 0)
        //幾何對照(nullSideGeo)只供判讀, 不入階梯
        m.nullSideAct = null
        m.nullSideGeo = { p: 0.9, excess: -5 }
        assert.equal(scoreOf(m, OPT).ladder, 3)
    })

    it('階梯 2:各地平線之新鮮度皆 ≥ 門檻且最差相位 ≥ 門檻;階梯 3:月均單與最大持倉在可行範圍內', () => {
        assert.equal(scoreOf(mk({ mo: 350 }), OPT).ladder, 2)
        assert.equal(scoreOf(mk({ pk: 31 }), OPT).ladder, 2)
        assert.equal(scoreOf(mk({ min: 4, mean: 60 }), OPT).ladder, 1)
        assert.equal(scoreOf(mk(), OPT).ladder, 3)
    })

    it('硬上限、選集恆空、審計不可信 ⇒ 否決且階梯歸零', () => {
        for (let m of [mk({ mo: 401 }), mk({ pk: 51 }), mk({ sizeMax: 0 })]) {
            let s = scoreOf(m, OPT)
            assert.equal(s.flags.vetoed, true)
            assert.equal(s.ladder, 0)
        }
        let s = scoreOf(mk(), { ...OPT, evidence: { trust: 'untrusted' } })
        assert.deepEqual([s.flags.vetoed, s.ladder], [true, 0])
        assert.equal(scoreOf(mk(), { ...OPT, evidence: { trust: 'partial' } }).flags.vetoed, false)
    })

    it('回測期旗標:pass ⇒ 階梯 4(不論訓練期階梯);fail ⇒ 否決但訓練期階梯照記;未算 ⇒ 階梯 = 訓練期階梯;flags.trainLadder 恆為訓練期階梯', () => {
        //檔頭: true ⇒ flags.backtest = 'pass', ladder = 4(樣本外通過; 不論訓練期階梯)
        let pass = scoreOf(mk(), { ...OPT, evidence: { backtestOK: true } })
        assert.deepEqual([pass.ladder, pass.flags.vetoed, pass.flags.backtest, pass.flags.trainLadder], [4, false, 'pass', 3])
        let passL0 = scoreOf(mk({ p: 0.7 }), { ...OPT, evidence: { backtestOK: true } })
        assert.deepEqual([passL0.ladder, passL0.flags.vetoed, passL0.flags.trainLadder], [4, false, 0], '訓練期未勝過隨機而樣本外通過者亦為階梯 4')
        //檔頭: 硬上限等否決使階梯歸零(成品本身不可用), 即使回測期 pass
        let passHard = scoreOf(mk({ pk: 51 }), { ...OPT, evidence: { backtestOK: true } })
        assert.deepEqual([passHard.ladder, passHard.flags.vetoed], [0, true])
        //檔頭: false ⇒ 'fail' 且否決(ladder = 訓練期階梯, 照記)
        let fail = scoreOf(mk(), { ...OPT, evidence: { backtestOK: false } })
        assert.deepEqual([fail.ladder, fail.flags.vetoed, fail.flags.backtest, fail.flags.trainLadder], [3, true, 'fail', 3])
        assert(fail.flags.why.some((w) => /回測期旗標 fail/.test(w)))
        //檔頭: 未算 ⇒ flags.backtest = null, ladder = 訓練期階梯
        let none = scoreOf(mk(), { ...OPT, evidence: { trust: 'trusted' } })
        assert.deepEqual([none.ladder, none.flags.vetoed, none.flags.backtest, none.flags.trainLadder], [3, false, null, 3])
    })

    it('回測期旗標之分級(evidence.backtest):階梯改為樣本外等級 pass 4 / above 3 / mixed 2 / level 1 / below 0;level 與 below 否決;above 與 mixed 不否決', () => {
        //檔頭: 有旗標 ⇒ flags.backtest = 該等級, 階梯 ladder 改為樣本外等級(不論訓練期階梯)
        let of = (g, m = mk()) => scoreOf(m, { ...OPT, evidence: { backtest: g } })
        let row = (s) => [s.ladder, s.flags.vetoed, s.flags.backtest, s.flags.trainLadder]
        assert.deepEqual(row(of('pass')), [4, false, 'pass', 3])
        assert.deepEqual(row(of('above')), [3, false, 'above', 3])
        assert.deepEqual(row(of('mixed')), [2, false, 'mixed', 3])
        assert.deepEqual(row(of('level')), [1, true, 'level', 3])
        assert.deepEqual(row(of('below')), [0, true, 'below', 3])
        //訓練期階梯 0 而樣本外 above / mixed 者: 不否決, 階梯為樣本外等級
        assert.deepEqual(row(of('above', mk({ p: 0.7 }))), [3, false, 'above', 0])
        assert.deepEqual(row(of('mixed', mk({ p: 0.7 }))), [2, false, 'mixed', 0])
        //硬上限使階梯歸零且否決, 不論等級
        assert.deepEqual(row(of('above', mk({ pk: 51 }))).slice(0, 2), [0, true])
        //說明列: 每個等級皆有一句(不含數字), 並附訓練期階梯
        for (let g of ['pass', 'above', 'mixed', 'level', 'below']) {
            assert(of(g).flags.why.some((w) => w.includes(`回測期旗標 ${g}`) && w.includes('訓練期階梯 3')), g)
        }
        //分級字串優先於舊制之布林; 不認得之字串視同未算
        assert.equal(scoreOf(mk(), { ...OPT, evidence: { backtest: 'mixed', backtestOK: false } }).flags.backtest, 'mixed')
        assert.equal(scoreOf(mk(), { ...OPT, evidence: { backtest: 'unknown' } }).flags.backtest, null)
    })

    it('無評估結果 ⇒ 否決;格(cell)= 層 | 頻率帶', () => {
        assert.equal(scoreOf(null, OPT).flags.vetoed, true)
        assert.equal(scoreOf(mk({ mo: 50 }), { ...OPT, layer: 'B' }).cell, 'B|low')
        assert.equal(scoreOf(mk({ mo: 150 }), { ...OPT, layer: 'B' }).cell, 'B|mid')
        assert.equal(scoreOf(mk({ mo: 260 }), { ...OPT, layer: 'B' }).cell, 'B|high')
    })
})
