import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { loadLedger } from '../src/eval/ledger.mjs'
import { makeTmp, writeSynthLedger, makeTrainEvaluator as makeEvaluator, FD_ROOT } from './tools/synthLedger.mjs'


//求解窗後段之近期活躍度版之組成對照(規則 R-EV-42): metrics.afterFit.sideActRecent 與 metrics.afterFit.halves[].sideActRecent
//  spec: ①只在 opt.afterFitOnly(命令列 --period postfit)時有; 全段(對所留之席之等效年化 op.eqYr.mean)與前段 / 後段(對該段之成品值)各一組 { draws, half, actDays, mean, sd, p, z, excess }
//        ②算法 = 擴充診斷之 api.replaceNull({ actDays: 90, half })(組 = 方向; 活躍度 = 決策棒以前最近 90 日之進場數; 名次 ± half〔= cfg.sideActHalf, 預設 50〕名內均勻抽一隻; 只換所留之席; 抽數 = nullDraws)
//          亂數種子: 全段 seed + 67867967、各段 seed + 86028121 + g × 16777259(與既有各虛無互不相干)
//        ③有算組成對照時才有(否則 null); 任一相位之決策數 < 2 時 halves 為 null 而全段照算
//        ④只增輸出: afterFit 與各段之既有鍵、其次序與其值不變(既有鍵之值另由 unit-evalPostfit 以公開方法重算比對); 不入 S 與階梯(此段之 score 本為 null)
//        ⑤命令列: 分段之後另印一行「近 90 日活躍度版之組成對照」(全段 / 前段 / 後段之超額 z p); 其餘各行不變; 回測期與訓練期不印
//  合成帳本與求解窗終點同 unit-evalPostfit: 起點 2022-07-01、4 小時一根; 暖機 60 日、7 日一換; 相位 0 之決策棒 360 + 42k、相位 3 之決策棒 378 + 42k;
//    評估期間 [739, 1290): 相位 0 = 780 ~ 1284、相位 3 = 756 ~ 1260(各 13 個決策 ⇒ 前段各 6 個: 相位 0 至 990、相位 3 至 966; 後段起於 1032 / 1008)
//    ⇒ 以單一棒切開兩段: [739, 1000) = 前段、[1000, 1290) = 後段(以 fromBar / toBar 之一般評估重現各段)
//  各欄逐策略相異(進場、出場與損益逐策略獨立抽; 各策略之進場機率不同 ⇒ 累計與近 90 日之活躍度名次不同); 做空 = 序號為 3 之倍數者
const T738 = '2022-11-01T00:00:00'
const T821 = '2022-11-14T20:00:00'
const CFG = { warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7], nullDraws: 16, seed: 11 }
const FIT_A = { long: T738, short: T821 }
const FIT_B = { long: T821, short: T738 }
//擴充診斷之 replaceNull 之種子為 seed + 49979687 ⇒ 以 opt.seed 對齊, 使兩者之各抽取用同一組亂數
const SEED_REPLACE = 49979687
const SEED_WHOLE = 67867967
const SEED_HALF = 86028121
const SEED_HALF_STEP = 16777259
//前段 / 後段之切點(見檔頭)
const CUT = 1000
const KEYS_AF = ['seatsKept', 'seatsDropped', 'orders', 'halves', 'sideActRecent']
const KEYS_HALF = ['from', 'to', 'nDecisions', 'seats', 'eqYr', 'orders', 'sideAct', 'sideActRecent']
const KEYS_RECENT = ['draws', 'half', 'actDays', 'mean', 'sd', 'p', 'z', 'excess']

const FIX = Array.from({ length: 30 }, (_, i) => i * 2)
let pickAll = () => ({ ids: FIX.slice(), group: FIX.map((s) => s % 3) })
let accept = (sig, book) => book.open < 12 && book.openGroup[sig.group] < 6
//selfFilter, 挑選函數自行只回求解窗已結束之席(= opt.afterFitOnly 之等價輸入; 見 unit-evalPostfit)
let selfFilter = (pick) => (ctx) => {
    let r = pick(ctx)
    let ids = []
    let group = []
    r.ids.forEach((s, i) => {
        if (ctx.meta.fitEndBar[s] >= 0 && ctx.meta.fitEndBar[s] < ctx.bar) {
            ids.push(s)
            group.push(r.group[i])
        }
    })
    return { ids, group }
}
let pickOf = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]))

describe('求解窗後段之近期活躍度版之組成對照:metrics.afterFit.sideActRecent(規則 R-EV-42)', function () {
    let t
    let L
    before(() => {
        t = makeTmp('evalPostfitRecent')
        writeSynthLedger(t.dir, { n: 60, nBars: 2400, seed: 5 })
        L = loadLedger(t.dir)
    })
    after(() => {
        t.cleanup()
    })

    //viaReplace, 以一般評估(挑選函數自行只回所留之席)+ 擴充診斷之 api.replaceNull 求同一段之近期活躍度版(種子對齊); 回 { m, r(actDays 90), c(actDays 0) }
    let viaReplace = (ev, { fromBar, toBar, seed, half, draws }) => {
        let ext = [
            { name: 'r', fn: (api) => api.replaceNull({ actDays: 90, half, draws }) },
            { name: 'c', fn: (api) => api.replaceNull({ actDays: 0, half, draws }) },
        ]
        let m = ev.evalPolicy(selfFilter(pickAll), { accept, fromBar, toBar, seed: seed - SEED_REPLACE, ext })
        assert(!m.ext.r.error && !m.ext.c.error, JSON.stringify(m.ext))
        return { m, r: m.ext.r, c: m.ext.c }
    }

    it('全段與前段 / 後段 = 擴充診斷之 api.replaceNull({ actDays: 90 })(同一函數)於同一選集、同一亂數種子之結果(逐值相同;兩種方向 × 兩個種子 × half 預設 50、3 與 0)', () => {
        let nDiffCum = 0
        let nDiffSide = 0
        let nCase = 0
        for (let fit of [FIT_A, FIT_B]) {
            for (let sd of [11, 13]) {
                for (let half of [50, 3, 0]) {
                    let ev = makeEvaluator(L, { ...CFG, seed: sd, ...(half === 50 ? {} : { sideActHalf: half }), fitEnd: fit })
                    let m = ev.evalPolicy(pickAll, { accept, fromBar: 739, toBar: 1290, afterFitOnly: true })
                    let af = m.afterFit
                    assert.deepEqual(Object.keys(af.sideActRecent), KEYS_RECENT)
                    //全段
                    let w = viaReplace(ev, { fromBar: 739, toBar: 1290, seed: sd + SEED_WHOLE, half, draws: 16 })
                    assert.equal(w.m.op.eqYr.mean, m.op.eqYr.mean, '同一選集(所留之席)')
                    assert.equal(w.r.draws, 16)
                    assert.deepEqual(af.sideActRecent, { draws: 16, half, actDays: 90, ...pickOf(w.r, ['mean', 'sd', 'p', 'z', 'excess']) }, `全段 fit ${JSON.stringify(fit)} seed ${sd} half ${half}`)
                    //各段: 以單一棒切開之一般評估 = 該段(決策數與該段之等效年化相同)
                    for (let g = 0; g < 2; g++) {
                        let h = af.halves[g]
                        let s = viaReplace(ev, { fromBar: g === 0 ? 739 : CUT, toBar: g === 0 ? CUT : 1290, seed: sd + SEED_HALF + g * SEED_HALF_STEP, half, draws: 16 })
                        assert.deepEqual(s.m.op.nDecisions, h.nDecisions, '以切點重現之段 = 前段 / 後段')
                        assert.equal(s.m.op.eqYr.mean, h.eqYr.mean)
                        assert.deepEqual(h.sideActRecent, { draws: 16, half, actDays: 90, ...pickOf(s.r, ['mean', 'sd', 'p', 'z', 'excess']) }, `段 ${g} fit ${JSON.stringify(fit)} seed ${sd} half ${half}`)
                        if (half === 0) {
                            continue
                        }
                        if (s.c.mean !== s.r.mean) {
                            nDiffCum++
                        }
                        if (h.sideAct.mean !== h.sideActRecent.mean) {
                            nDiffSide++
                        }
                        nCase++
                    }
                    if (half === 0) {
                        //鑑別前提(p 之計數含等號): half 0 ⇒ 替換者即該席本身, 各抽之值恰等於成品值 ⇒ p = 1(計數若不含等號即為 1 / 17)、sd 至四位為 0
                        //  (z 不驗: 各抽之均以累加求得, 與成品值可差最末位 ⇒ sd 為極小之非 0 時 z 之號與大小無意義)
                        for (let x of [af.sideActRecent, af.halves[0].sideActRecent, af.halves[1].sideActRecent]) {
                            assert.equal(x.p, 1, JSON.stringify(x))
                            assert.equal(x.sd, 0)
                        }
                        continue
                    }
                    if (w.c.mean !== w.r.mean) {
                        nDiffCum++
                    }
                    nCase++
                }
            }
        }
        //鑑別前提: 合成資料下近 90 日與累計之活躍度所得之結果確有不同(否則測不出 actDays 之錯)
        assert(nDiffCum >= nCase / 2, `近 90 日版與累計版相同之情形過多(${nCase - nDiffCum} / ${nCase})`)
        assert(nDiffSide > 0)
    })

    it('替換池(抽查決策;做多與做空各數隻):各抽之替換者皆在以獨立計算所得之池內(同側、依決策棒以前最近 90 日之進場數〔同值依 ctx.meta.tie〕排名、名次 ± half);鑑別前提:累計進場數之池不涵蓋、不分方向之池含他側', () => {
        //單席之成品(一隻 X; 相位 0 只評估一個相位 ⇒ sig.k 唯一對應決策棒); half 2(池 5 隻)
        let half = 2
        let ev = makeEvaluator(L, { ...CFG, phases: [0], nullDraws: 64, sideActHalf: half, fitEnd: FIT_A })
        let all = Array.from({ length: L.n }, (_, s) => s)
        let longs = all.filter((s) => L.mode[s] > 0)
        let shorts = all.filter((s) => L.mode[s] < 0)
        assert(longs.length > 10 && shorts.length > 10)
        let tie = null
        let bars = ev.decisionBars(0)
        //cntOf, 第 s 隻於決策棒 b 以前最近 days 日(0 = 累計)之進場數(獨立計算: 直接數帳本之進場棒)
        let cntOf = (s, b, days) => {
            let c = 0
            for (let e = L.off[s]; e < L.off[s + 1]; e++) {
                let x = L.ent[e]
                if (x < b && (days === 0 || x >= b - days * 6)) {
                    c++
                }
            }
            return c
        }
        //poolOf, 組 grp(陣列)內依活躍度排名(同值依 tie、再依序號)後 x 之名次 ± half 內之全部策略
        let poolOf = (x, b, days, grp) => {
            let ord = grp.slice().sort((a, c) => (cntOf(a, b, days) - cntOf(c, b, days)) || (tie[a] - tie[c]) || (a - c))
            let p = ord.indexOf(x)
            return new Set(ord.slice(Math.max(0, p - half), Math.min(ord.length - 1, p + half) + 1))
        }
        let nOut = 0
        let nMix = 0
        let nChecked = 0
        let nSide = [0, 0]
        for (let X of [...longs.slice(5, 9), ...shorts.slice(3, 7)]) {
            let sameSide = L.mode[X] > 0 ? longs : shorts
            let pick = (ctx) => {
                tie = ctx.meta.tie
                return [X]
            }
            let seen = new Map()
            let on = false
            let acc = (sig) => {
                if (on) {
                    if (!seen.has(sig.k)) {
                        seen.set(sig.k, new Set())
                    }
                    seen.get(sig.k).add(sig.sid)
                }
                return true
            }
            let m = ev.evalPolicy(pick, { accept: acc, fromBar: 739, toBar: 1290, ext: [{ name: 'p', fn: (api) => {
                on = true
                try {
                    return api.replaceNull({ actDays: 90, half, draws: 64 })
                }
                finally {
                    on = false
                }
            } }] })
            assert(!m.ext.p.error, JSON.stringify(m.ext.p))
            assert(seen.size >= 8, `觀察到之決策過少(${seen.size})`)
            for (let [k, ids] of seen) {
                let b = bars[k]
                assert(b >= 739 && b < 1290, `sig.k ${k} 對應之決策棒 ${b} 在評估期間內`)
                let pool = poolOf(X, b, 90, sameSide)
                for (let s of ids) {
                    assert(pool.has(s), `X ${X} 決策棒 ${b}: 替換者 ${s} 不在近 90 日之池 ${[...pool]}`)
                    assert.equal(Math.sign(L.mode[s]), Math.sign(L.mode[X]), `X ${X} 決策棒 ${b}: 替換者 ${s} 與被替換者不同側`)
                }
                //鑑別前提一: 累計進場數所得之池不涵蓋所見之替換者(否則測不出活躍度之定義)
                let poolCum = poolOf(X, b, 0, sameSide)
                if ([...ids].some((s) => !poolCum.has(s))) {
                    nOut++
                }
                //鑑別前提二: 不分方向(全體依近 90 日之進場數排名)之池含他側者(否則測不出「只換同側」)
                let poolMix = poolOf(X, b, 90, all)
                if ([...poolMix].some((s) => Math.sign(L.mode[s]) !== Math.sign(L.mode[X]))) {
                    nMix++
                }
                nSide[L.mode[X] > 0 ? 0 : 1]++
                nChecked++
            }
        }
        assert(nSide[0] >= 8 && nSide[1] >= 8, `兩側皆須有抽查之決策(做多 ${nSide[0]}、做空 ${nSide[1]})`)
        assert(nOut > 0, `鑑別前提: 累計之池皆涵蓋所見之替換者(${nChecked} 個決策)⇒ 測不出活躍度之定義`)
        assert(nMix >= nChecked / 2, `鑑別前提: 不分方向之池含他側者過少(${nMix} / ${nChecked})⇒ 測不出「只換同側」`)
        //postfit 之近期活躍度版即此函數(上一案逐值比對); 此處另驗 postfit 之全段與同種子之 replaceNull 相同(單席、half 2)
        let X = longs[6]
        let pick = () => [X]
        let m1 = ev.evalPolicy(pick, { fromBar: 739, toBar: 1290, afterFitOnly: true })
        let m2 = ev.evalPolicy(pick, { fromBar: 739, toBar: 1290, seed: 11 + SEED_WHOLE - SEED_REPLACE, ext: [{ name: 'r', fn: (api) => api.replaceNull({ actDays: 90, half, draws: 64 }) }] })
        assert.equal(m1.afterFit.seatsDropped, 0)
        assert.deepEqual(m1.afterFit.sideActRecent, { draws: 64, half, actDays: 90, ...pickOf(m2.ext.r, ['mean', 'sd', 'p', 'z', 'excess']) })
    })

    it('只增輸出:afterFit 與各段之鍵只多 sideActRecent(既有鍵之次序不變);全段之 p / z / 超額對所留之席之等效年化、各段對該段之成品值', () => {
        let ev = makeEvaluator(L, { ...CFG, fitEnd: FIT_A })
        let m = ev.evalPolicy(pickAll, { accept, fromBar: 739, toBar: 1290, afterFitOnly: true })
        assert.deepEqual(Object.keys(m.afterFit), KEYS_AF)
        for (let h of m.afterFit.halves) {
            assert.deepEqual(Object.keys(h), KEYS_HALF)
            assert.deepEqual(Object.keys(h.sideActRecent), KEYS_RECENT)
            assert.equal(h.sideActRecent.excess, Math.round((h.eqYr.mean - h.sideActRecent.mean) * 10000) / 10000)
        }
        let w = m.afterFit.sideActRecent
        assert.equal(w.excess, Math.round((m.op.eqYr.mean - w.mean) * 10000) / 10000)
        assert.equal(w.half, 50)
        assert.equal(w.actDays, 90)
        assert.equal(w.draws, 16)
        //各段之成品值與全段不同 ⇒ 超額之基準可分辨(鑑別前提)
        assert(m.afterFit.halves.every((h) => h.eqYr.mean !== m.op.eqYr.mean))
        //抽數取自 opt.nullDraws(同 sideAct 之 draws; 與設定之 16 不同 ⇒ 鑑別)
        let m5 = ev.evalPolicy(pickAll, { accept, fromBar: 739, toBar: 1290, afterFitOnly: true, nullDraws: 5 })
        assert.equal(m5.afterFit.sideActRecent.draws, 5)
        assert.equal(m5.afterFit.sideActRecent.draws, m5.nullSideAct.draws)
        assert(m5.afterFit.halves.every((h) => h.sideActRecent.draws === 5 && h.sideAct.draws === 5))
        //  抽數 5 時之值亦同 api.replaceNull({ draws: 5 })(同一亂數種子): 畫面之抽數標示與實際之抽數一致
        let w5 = viaReplace(ev, { fromBar: 739, toBar: 1290, seed: 11 + SEED_WHOLE, half: 50, draws: 5 })
        assert.deepEqual(m5.afterFit.sideActRecent, { draws: 5, half: 50, actDays: 90, ...pickOf(w5.r, ['mean', 'sd', 'p', 'z', 'excess']) })
        //抽數 > 64: 同 sideAct 取 opt.nullDraws 不設上限(api.replaceNull 之 draws 上限 64 不適用於此欄; 外審所見, 規格 = 抽數取 nullDraws)
        let m70 = ev.evalPolicy(pickAll, { accept, fromBar: 739, toBar: 1290, afterFitOnly: true, nullDraws: 70 })
        assert.equal(m70.afterFit.sideActRecent.draws, 70)
        assert.equal(m70.nullSideAct.draws, 70)
        assert(m70.afterFit.halves.every((h) => h.sideActRecent.draws === 70 && h.sideAct.draws === 70))
        //  實際抽數亦為 70(不只標示): 各抽之亂數種子 = 基底 + (抽序 + 1) × 7919 ⇒ 70 抽 = 以基底起之 64 抽 + 以(基底 + 64 × 7919)起之 6 抽,
        //  其均 = 兩次 api.replaceNull(各 ≤ 64 抽; 同種子對齊)之加權平均(四位小數之捨入內); 鑑別前提: 64 抽之均與 70 抽之均不同
        let w64 = viaReplace(ev, { fromBar: 739, toBar: 1290, seed: 11 + SEED_WHOLE, half: 50, draws: 64 })
        let w6 = viaReplace(ev, { fromBar: 739, toBar: 1290, seed: 11 + SEED_WHOLE + 64 * 7919, half: 50, draws: 6 })
        let mean70 = (64 * w64.r.mean + 6 * w6.r.mean) / 70
        assert(Math.abs(m70.afterFit.sideActRecent.mean - mean70) < 0.001, `${m70.afterFit.sideActRecent.mean} vs ${mean70}`)
        assert(Math.abs(w64.r.mean - mean70) > 0.01, '鑑別前提: 64 抽之均與 70 抽之均須不同')
        //未給 afterFitOnly(或為 undefined / null / false): 無 afterFit 欄(回測期等之輸出形狀不變)
        for (let o of [{}, { afterFitOnly: undefined }, { afterFitOnly: null }, { afterFitOnly: false }]) {
            let m0 = ev.evalPolicy(pickAll, { accept, fromBar: 739, toBar: 1290, ...o })
            assert(!Object.prototype.hasOwnProperty.call(m0, 'afterFit'), JSON.stringify(o))
            assert(!JSON.stringify(m0).includes('sideActRecent'), JSON.stringify(o))
        }
    })

    it('有算組成對照時才有:未算虛無、所留為零 ⇒ 全段與各段皆為 null;任一相位之決策數 < 2 ⇒ halves 為 null、全段照算', () => {
        let ev = makeEvaluator(L, { ...CFG, fitEnd: FIT_A })
        let m0 = ev.evalPolicy(pickAll, { accept, fromBar: 739, toBar: 1290, afterFitOnly: true, nullDraws: 0 })
        assert.equal(m0.afterFit.sideActRecent, null)
        assert(m0.afterFit.halves.every((h) => h.sideActRecent === null && h.sideAct === null))
        assert.deepEqual(Object.keys(m0.afterFit), KEYS_AF)
        let ev2 = makeEvaluator(L, { ...CFG, fitEnd: { long: T738, short: '2023-02-01T00:00:00' } })
        let shorts = FIX.filter((s) => L.mode[s] < 0)
        let m1 = ev2.evalPolicy(() => shorts, { accept, fromBar: 739, toBar: 1290, afterFitOnly: true })
        assert.equal(m1.afterFit.seatsKept, 0)
        assert.equal(m1.afterFit.sideActRecent, null)
        assert(m1.afterFit.halves.every((h) => h.sideActRecent === null))
        //相位 0: 780、822;相位 3: 798 ⇒ 不分段; 全段照算且 = 同種子之 replaceNull
        let m2 = ev.evalPolicy(pickAll, { accept, fromBar: 779, toBar: 830, afterFitOnly: true })
        assert.deepEqual(m2.op.nDecisions, [2, 1])
        assert.equal(m2.afterFit.halves, null)
        let w = viaReplace(ev, { fromBar: 779, toBar: 830, seed: 11 + SEED_WHOLE, half: 50, draws: 16 })
        assert.deepEqual(m2.afterFit.sideActRecent, { draws: 16, half: 50, actDays: 90, ...pickOf(w.r, ['mean', 'sd', 'p', 'z', 'excess']) })
    })
})

describe('命令列之 --period postfit:近 90 日活躍度版之組成對照之一行(規則 R-EV-42)', function () {
    let t
    before(() => {
        t = makeTmp('evalPostfitRecentCli')
    })
    after(() => {
        t.cleanup()
    })
    //mkProject: 同 unit-evalPostfit(帳本 2400 棒; 回測期起點第 1290 棒; 做多之求解窗終點第 738 棒、做空 = 回測期起點 ⇒ 只留做多之席); pickSrc 可換挑選模組
    let mkProject = (name, { nullDraws = 8, pickSrc = null, sideActHalf = null } = {}) => {
        let root = path.join(t.dir, name)
        writeSynthLedger(path.join(root, 'ledger', 'eval'), { n: 60, nBars: 2400, seed: 7 })
        fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
        fs.mkdirSync(path.join(root, 'rsi', 'work', 'n1'), { recursive: true })
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
            periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } },
            eval: { ledgerDir: './ledger/eval', warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7], nullDraws, ...(sideActHalf === null ? {} : { sideActHalf }), seed: 1, fitEnd: { long: T738, short: '2023-02-01T00:00:00' }, limits: { monthlyOrders: 400, peakHold: 50 } },
            score: { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] },
            rsi: { root: './rsi' },
            records: { workDir: './rsi/work' },
            dispatch: {},
        }), 'utf8')
        fs.writeFileSync(path.join(root, 'rsi', 'work', 'n1', 'pick.mjs'), pickSrc || 'export default function pick(ctx) {\n    let ids = []\n    for (let s = 0; s < ctx.n; s += 2) {\n        ids.push(s)\n    }\n    return ids\n}\n', 'utf8')
        return root
    }
    let run = (root, args) => {
        let env = { ...process.env, ARSI_ROOT: root }
        for (let k of ['ARSI_HARNESS', 'ARSI_LEDGER_DIR', 'ARSI_EVAL_FROM']) {
            delete env[k]
        }
        let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'eval.mjs'), '--pick', path.join(root, 'rsi', 'work', 'n1', 'pick.mjs'), ...args], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
        return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
    }
    let f1 = (x) => x.toFixed(1)
    let rct = (x) => (x ? `超額 ${f1(x.excess)} z ${x.z} p ${x.p}` : '未算(所留之席無訊號)')
    let lineOf = (af) => {
        let ra = af.sideActRecent
        return `近 90 日活躍度版之組成對照(把所留之每一席換成同方向、決策日以前近 90 日進場數之名次相鄰之隨機一隻;只換所留之席${ra ? `;名次 ±${ra.half} 名內、${ra.draws} 抽` : ''}): 全段 ${rct(af.sideActRecent)}${af.halves ? ` | 前段 ${rct(af.halves[0].sideActRecent)} | 後段 ${rct(af.halves[1].sideActRecent)}` : ''}(所留之席近期比其累計之同儕更活躍或更安靜時, 與上列之累計活躍度版同向才算穩)`
    }

    it('分段之後另印一行:全段 / 前段 / 後段之超額 z p 與結果檔之 metrics.afterFit 相同(名次之寬取自設定之 eval.sideActHalf、抽數取自 eval.nullDraws);位於分段一行之後、效度限制之前;score 照舊為 null', () => {
        //名次之寬與抽數皆非預設(20、8): 印出之值須取自結果(鑑別前提)
        let root = mkProject('main', { sideActHalf: 20 })
        let fo = path.join(root, 'out.json')
        let r = run(root, ['--mode', 'full', '--period', 'postfit', '--out', fo])
        assert.equal(r.status, 0, r.out.slice(0, 1500))
        let o = JSON.parse(fs.readFileSync(fo, 'utf8'))
        let af = o.metrics.afterFit
        assert(af.sideActRecent && af.halves.every((h) => h.sideActRecent), JSON.stringify(af).slice(0, 800))
        assert.equal(af.sideActRecent.draws, 8)
        assert.equal(af.sideActRecent.half, 20)
        assert.equal(af.halves[0].sideAct.half, 20)
        let lines = r.out.split(/\r?\n/)
        let i = lines.indexOf(lineOf(af))
        assert(i > 0, r.out.slice(0, 4000))
        assert(lines[i - 1].startsWith('求解窗後段之分段'), lines[i - 1])
        assert(lines[i + 1].startsWith('效度限制: '), lines[i + 1])
        assert.equal(lines.filter((l) => l.startsWith('近 90 日活躍度版之組成對照')).length, 1)
        assert.equal(o.score, null)
        //各段之值互不相同(前段 / 後段 / 全段未錯置之鑑別前提)
        let vs = [af.sideActRecent, af.halves[0].sideActRecent, af.halves[1].sideActRecent].map((x) => x.excess)
        assert.equal(new Set(vs).size, 3, JSON.stringify(vs))
    })

    it('所留之席皆無(只挑求解窗未結束之側)⇒ 照印此行,三者皆為「未算」;回測期與訓練期不印此行', () => {
        let root = mkProject('shorts', { pickSrc: 'export default function pick(ctx) {\n    let ids = []\n    for (let s = 0; s < ctx.n; s += 3) {\n        ids.push(s)\n    }\n    return ids\n}\n' })
        let fo = path.join(root, 'out.json')
        let r = run(root, ['--mode', 'full', '--period', 'postfit', '--out', fo])
        assert.equal(r.status, 0, r.out.slice(0, 1500))
        let af = JSON.parse(fs.readFileSync(fo, 'utf8')).metrics.afterFit
        assert.equal(af.seatsKept, 0)
        assert.equal(af.sideActRecent, null)
        let ln = lineOf(af)
        assert(ln.includes('全段 未算(所留之席無訊號) | 前段 未算(所留之席無訊號) | 後段 未算(所留之席無訊號)'), ln)
        assert(r.out.split(/\r?\n/).includes(ln), r.out.slice(0, 4000))
        let root2 = mkProject('bt')
        for (let pd of ['backtest', 'train']) {
            let r2 = run(root2, ['--mode', 'full', '--period', pd])
            assert.equal(r2.status, 0, r2.out.slice(0, 1500))
            assert(!r2.out.includes('近 90 日活躍度版'), `${pd}\n${r2.out.slice(0, 2000)}`)
        }
    })
})
