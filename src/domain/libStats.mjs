import { holdMedianOf } from '../eval/subsetRule.mjs'


//庫況體檢之計算與呈現(規則 R-EV-48; tools/libCheck.mjs 用; 唯讀之純計算: 只讀帳本物件, 不讀寫檔)
//  期間以棒序給定: 訓練期 = [trainFrom, trainEnd)、評估期 = [evFrom, evTo)、評估期三等分 = 依棒序三等分(各段 [起, 迄))
//  逐單之量皆依進場棒歸期; 已結 = 出場棒 ≥ 0; 勝率 = 每單位損益 > 0 之單 ÷ 已結之單; 獲利因子 = 正損益之和 ÷ 負損益之和之絕對值(無負者 null)
//  分佈之分位 = 排序後之第 ⌊p × n⌋ 個(同評估器之重疊率之分位); 數值四捨五入至小數 4 位
/**
 * 方向性之庫之判定之門檻之預設:評估期一側之勝率 ≥ LIB_DIR_HI 而另一側 ≤ LIB_DIR_LO
 *
 * @type {Number}
 */
let LIB_DIR_HI = 0.75
/**
 * 方向性之庫之判定之門檻之預設(另一側之勝率之上限)
 *
 * @type {Number}
 */
let LIB_DIR_LO = 0.3

/**
 * 方向性之庫之判定(純函數):一側之勝率 ≥ hi 而另一側 ≤ lo(兩端皆含);任一側無值(null)者為 false
 *
 * @param {Number|null} wl 輸入做多之勝率
 * @param {Number|null} ws 輸入做空之勝率
 * @param {Number} [hi=LIB_DIR_HI] 輸入高側之門檻
 * @param {Number} [lo=LIB_DIR_LO] 輸入低側之門檻
 * @returns {Boolean} 回傳是否為方向性之庫
 * @example
 * directionalOf(0.8, 0.2) // => true
 */
let directionalOf = (wl, ws, hi = LIB_DIR_HI, lo = LIB_DIR_LO) => typeof wl === 'number' && typeof ws === 'number' && ((wl >= hi && ws <= lo) || (ws >= hi && wl <= lo))

let r4 = (x) => (x === null ? null : Math.round(x * 10000) / 10000)
let SIDES = [['long', '做多'], ['short', '做空']]
//dist, 數值陣列之分佈
let dist = (xs) => {
    if (!xs.length) {
        return { n: 0, min: null, p10: null, p50: null, p90: null, max: null }
    }
    let s = xs.slice().sort((a, b) => a - b)
    let q = (p) => r4(s[Math.min(s.length - 1, Math.floor(p * s.length))])
    return { n: s.length, min: r4(s[0]), p10: q(0.1), p50: q(0.5), p90: q(0.9), max: r4(s[s.length - 1]) }
}

/**
 * 由帳本物件求庫況(純計算;兩側之策略與訂單之比例、止盈止損之候選值之占比、持倉天數之分佈、勝率與獲利因子〔訓練期 / 評估期 / 評估期三等分〕、進場頻率、方向性之庫)
 *
 * @param {Object} L 輸入帳本物件(loadLedger 之回傳)
 * @param {Object} opt 輸入設定物件
 * @param {Integer} opt.trainFrom 輸入訓練期之下界棒序(含)
 * @param {Integer} opt.trainEnd 輸入訓練期之終點棒序(不含)
 * @param {Integer} opt.evFrom 輸入評估期之起點棒序(含)
 * @param {Integer} opt.evTo 輸入評估期之終點棒序(不含)
 * @param {Function|null} [opt.isoOf=null] 輸入棒序轉時刻字串之函數(只用於呈現;未給者期間不帶時刻字串)
 * @param {Number} [opt.dirHi=LIB_DIR_HI] 輸入方向性之庫之高側之門檻
 * @param {Number} [opt.dirLo=LIB_DIR_LO] 輸入方向性之庫之低側之門檻
 * @returns {Object} 回傳庫況物件(ledger、periods、sides、candidates、holdDays、winRate、entryFreq30d、directional)
 * @example
 * let rep = libReportOf(L, { trainFrom: 0, trainEnd: 1200, evFrom: 1290, evTo: L.nBars })
 */
let libReportOf = (L, { trainFrom, trainEnd, evFrom, evTo, isoOf = null, dirHi = LIB_DIR_HI, dirLo = LIB_DIR_LO }) => {
    let n = L.n
    let isLong = (s) => L.mode[s] > 0
    let win = (name, from, to) => ({ name, fromBar: from, toBar: Math.max(from, to), ...(typeof isoOf === 'function' ? { from: isoOf(from), to: isoOf(Math.max(from, to)) } : {}) })
    let wTrain = win('train', trainFrom, trainEnd)
    let wEval = win('eval', evFrom, evTo)
    let len = wEval.toBar - wEval.fromBar
    let cuts = [evFrom, evFrom + Math.floor(len / 3), evFrom + Math.floor((2 * len) / 3), evFrom + len]
    let wThirds = [0, 1, 2].map((i) => win(`eval${i + 1}`, cuts[i], cuts[i + 1]))
    //ordStat, 一期之逐單之量(依進場棒): 訂單數、已結之單之勝場 / 正負損益之和 / 持倉天數
    let ordStat = (w) => {
        let o = {}
        for (let [k] of SIDES) {
            o[k] = { orders: 0, closed: 0, wins: 0, pos: 0, neg: 0, pnl: 0, days: [] }
        }
        for (let s = 0; s < n; s++) {
            let x = isLong(s) ? o.long : o.short
            for (let j = L.off[s]; j < L.off[s + 1]; j++) {
                if (L.ent[j] < w.fromBar || L.ent[j] >= w.toBar) {
                    continue
                }
                x.orders++
                if (L.ext[j] >= 0) {
                    let p = L.pnl[j]
                    x.closed++
                    x.wins += p > 0 ? 1 : 0
                    x.pos += p > 0 ? p : 0
                    x.neg += p < 0 ? -p : 0
                    x.pnl += p
                    x.days.push((L.ext[j] - L.ent[j]) / L.barsPerDay)
                }
            }
        }
        return o
    }
    let all = ordStat(win('all', 0, L.nBars))
    let tr = ordStat(wTrain)
    let ev = ordStat(wEval)
    let th = wThirds.map(ordStat)
    let shareOf = (a, b) => (a + b > 0 ? r4(a / (a + b)) : null)
    let nLong = 0
    for (let s = 0; s < n; s++) {
        nLong += isLong(s) ? 1 : 0
    }
    //candOf, 一欄之相異之值(依值由小到大)與其隻數、占比、兩側各幾隻
    let candOf = (col) => {
        let m = new Map()
        for (let s = 0; s < n; s++) {
            let c = m.get(col[s]) || { value: col[s], n: 0, long: 0, short: 0 }
            c.n++
            c[isLong(s) ? 'long' : 'short']++
            m.set(col[s], c)
        }
        let xs = [...m.values()].sort((a, b) => a.value - b.value).map((c) => ({ value: Number(c.value.toPrecision(6)), n: c.n, share: r4(c.n / n), long: c.long, short: c.short }))
        return { kinds: xs.length, values: xs }
    }
    //各策略之進場與出場皆在訓練期內之已結單之持倉天數之中位(子庫之 hold 規則之值)
    let med = { long: [], short: [] }
    let noClosed = { long: 0, short: 0 }
    for (let s = 0; s < n; s++) {
        let d = holdMedianOf(L, s, trainFrom, trainEnd)
        if (d === null) {
            noClosed[isLong(s) ? 'long' : 'short']++
        }
        else {
            med[isLong(s) ? 'long' : 'short'].push(d)
        }
    }
    let wpOf = (o) => Object.fromEntries(SIDES.map(([k]) => [k, { closed: o[k].closed, winRate: o[k].closed ? r4(o[k].wins / o[k].closed) : null, profitFactor: o[k].neg > 0 ? r4(o[k].pos / o[k].neg) : null, meanPnl: o[k].closed ? r4(o[k].pnl / o[k].closed) : null }]))
    //freqOf, 各策略於該期每 30 日之進場數之分佈
    let freqOf = (w) => {
        let days = (w.toBar - w.fromBar) / L.barsPerDay
        let out = { long: [], short: [] }
        if (days > 0) {
            for (let s = 0; s < n; s++) {
                let c = 0
                for (let j = L.off[s]; j < L.off[s + 1]; j++) {
                    c += L.ent[j] >= w.fromBar && L.ent[j] < w.toBar ? 1 : 0
                }
                out[isLong(s) ? 'long' : 'short'].push((c / days) * 30)
            }
        }
        return { long: dist(out.long), short: dist(out.short) }
    }
    let wpEval = wpOf(ev)
    return {
        ledger: { key: L.meta && L.meta.key !== undefined ? L.meta.key : null, nStrategies: n, nOrders: L.off[n], barHours: L.meta ? L.meta.barHours : null, nBars: L.nBars },
        periods: { train: wTrain, eval: wEval, evalThirds: wThirds },
        sides: {
            strategies: { long: nLong, short: n - nLong, longShare: n ? r4(nLong / n) : null },
            orders: Object.fromEntries([['all', all], ['train', tr], ['eval', ev]].map(([k, o]) => [k, { long: o.long.orders, short: o.short.orders, longShare: shareOf(o.long.orders, o.short.orders) }])),
        },
        candidates: { tp: candOf(L.tp), sl: candOf(L.sl) },
        holdDays: { train: { long: dist(tr.long.days), short: dist(tr.short.days) }, eval: { long: dist(ev.long.days), short: dist(ev.short.days) }, strategyMedianTrain: { long: dist(med.long), short: dist(med.short), noClosed } },
        winRate: { train: wpOf(tr), eval: wpEval, evalThirds: th.map(wpOf) },
        entryFreq30d: { train: freqOf(wTrain), eval: freqOf(wEval) },
        directional: { hit: directionalOf(wpEval.long.winRate, wpEval.short.winRate, dirHi, dirLo), evalWinRate: { long: wpEval.long.winRate, short: wpEval.short.winRate }, hi: dirHi, lo: dirLo },
    }
}

/**
 * 庫況物件之文字(tools/libCheck.mjs 之輸出;每項一列或兩列)
 *
 * @param {Object} rep 輸入 libReportOf 之回傳
 * @returns {String} 回傳多列之文字
 * @example
 * console.log(libTextOf(rep))
 */
let libTextOf = (rep) => {
    let pc = (x) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`)
    let nm = (x) => (x === null ? '—' : String(x))
    let dl = (d) => (d.n ? `${d.n} 筆:最小 ${nm(d.min)} / p10 ${nm(d.p10)} / 中位 ${nm(d.p50)} / p90 ${nm(d.p90)} / 最大 ${nm(d.max)}` : '0 筆')
    let byS = (o, f) => SIDES.map(([k, lab]) => `${lab} ${f(o[k])}`).join(' | ')
    let n = rep.ledger.nStrategies
    let candLine = (c, lab) => {
        let many = c.values.length > 20
        let xs = many ? c.values.slice().sort((a, b) => (b.n - a.n) || (a.value - b.value)).slice(0, 20).sort((a, b) => a.value - b.value) : c.values
        let rest = c.values.length - xs.length
        let restShare = rest ? r4(1 - xs.reduce((a, x) => a + x.n, 0) / n) : 0
        return `- ${lab}之候選值(${c.kinds} 種${many ? ';列占比最高之 20 種' : ''}):${xs.map((x) => `${x.value} ${pc(x.share)}(做多 ${x.long} / 做空 ${x.short})`).join('、') || '—'}${rest ? `;其餘 ${rest} 種共 ${pc(restShare)}` : ''}`
    }
    let wpLine = (w) => byS(w, (x) => `勝率 ${pc(x.winRate)}、獲利因子 ${nm(x.profitFactor)}(${x.closed} 單)`)
    let wd = (w) => `${w.from ? `${w.from} ~ ${w.to}` : ''}(棒 ${w.fromBar} ~ ${w.toBar},不含終點)`
    let pr = rep.periods
    let so = rep.sides.orders
    let P = []
    P.push(`# 庫況體檢(唯讀;評估帳本 ${nm(rep.ledger.key)}:策略 ${n} 隻、訂單 ${rep.ledger.nOrders} 筆、每根 ${nm(rep.ledger.barHours)} 小時)`)
    P.push(`期間:訓練期 ${wd(pr.train)};評估期 ${wd(pr.eval)};評估期三等分(依棒序):${pr.evalThirds.map(wd).join(' / ')}`)
    P.push(`1. 兩側:策略 做多 ${rep.sides.strategies.long}(${pc(rep.sides.strategies.longShare)})/ 做空 ${rep.sides.strategies.short};訂單之做多比例(依進場棒)全帳本 ${pc(so.all.longShare)}、訓練期 ${pc(so.train.longShare)}、評估期 ${pc(so.eval.longShare)}(訂單數 做多 / 做空:全帳本 ${so.all.long} / ${so.all.short}、訓練期 ${so.train.long} / ${so.train.short}、評估期 ${so.eval.long} / ${so.eval.short})`)
    P.push('2. 止盈、止損之候選值之占比(占全部策略;看求解批次是否混合 —— 帳本無批次之欄,只列分佈、不判定):')
    P.push(candLine(rep.candidates.tp, '止盈'))
    P.push(candLine(rep.candidates.sl, '止損'))
    P.push(`3. 持倉天數(已結之單,依進場棒;天):訓練期 ${byS(rep.holdDays.train, dl)};評估期 ${byS(rep.holdDays.eval, dl)}`)
    P.push(`   各策略之進場與出場皆在訓練期內之已結單之持倉天數之中位(子庫之 hold 規則之值):${byS(rep.holdDays.strategyMedianTrain, dl)};無此類單者 做多 ${rep.holdDays.strategyMedianTrain.noClosed.long} 隻、做空 ${rep.holdDays.strategyMedianTrain.noClosed.short} 隻(不屬任何 hold 之帶)`)
    P.push(`4. 勝率與獲利因子(已結之單,依進場棒;每單位損益):訓練期 ${wpLine(rep.winRate.train)};評估期 ${wpLine(rep.winRate.eval)}`)
    P.push(`   評估期三等分:${rep.winRate.evalThirds.map((w, i) => `第 ${i + 1} 段 ${wpLine(w)}`).join(';')}`)
    P.push(`5. 進場頻率(各策略於該期每 30 日之進場數):訓練期 ${byS(rep.entryFreq30d.train, dl)};評估期 ${byS(rep.entryFreq30d.eval, dl)}`)
    let dr = rep.directional
    P.push(`6. 方向性之庫:${dr.hit ? '**是**' : '否'}(評估期之勝率 做多 ${pc(dr.evalWinRate.long)}、做空 ${pc(dr.evalWinRate.short)};判準:一側 ≥ ${pc(dr.hi)} 而另一側 ≤ ${pc(dr.lo)})${dr.hit ? ' —— 評估期之高分可能只來自偏向勝率高之一側;以兩側席次固定之版本與子庫(g_eval.mjs --subset)核對' : ''}`)
    return P.join('\n')
}


export { LIB_DIR_HI, LIB_DIR_LO, directionalOf, libReportOf, libTextOf }
