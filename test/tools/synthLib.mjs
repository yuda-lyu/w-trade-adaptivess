import fs from 'fs'
import path from 'path'
import crypto from 'crypto'


//測試用: 合成之策略庫(ohlc / param / strategies; 格式同 w-trade-strategy 之策略庫)與獨立之進場重算
//  合成資料之各欄逐筆相異(開高低收量、因子、各策略之方向 / 條件 / 門檻 / 止盈 / 止損 / 手續費皆不同); K 線自 time0 起每根 barHours 小時; 因子之前幾根為缺值(暖機)
//  策略檔帶 summary.timeOhlcStart / timeOhlcEnd 與 numTrade(= 求解窗內之進場數, 由本檔之 entryBarsOf 獨立重算, 不經 buildLedger); 求解窗之起訖可逐策略指定(windowOf)
export let DAY = 86400000
export let tms = (s) => Date.parse(`${s}Z`)
export let iso = (ms) => new Date(ms).toISOString().slice(0, 19)

let lcg = (seed) => {
    let a = seed >>> 0
    return () => {
        a = (Math.imul(a, 1664525) + 1013904223) >>> 0
        return a / 4294967296
    }
}

//synthBars, 合成 K 線(每根 barHours 小時; 逐根相異)
export let synthBars = ({ barHours = 24, nBars = 760, time0 = '2020-01-01T00:00:00', seed = 20261120 } = {}) => {
    let r = lcg(seed)
    let step = barHours * 3600000
    let out = []
    let c = 1000
    for (let i = 0; i < nBars; i++) {
        let o = c * (1 + (r() - 0.5) * 0.002) + i * 1e-7
        c = Math.max(1, o * (1 + (r() - 0.5) * 0.04 + 0.0002))
        out.push({ time: iso(tms(time0) + i * step), Open: o, High: Math.max(o, c) * (1 + r() * 0.012) + i * 1e-7, Low: Math.min(o, c) * (1 - r() * 0.012) - i * 1e-7, Close: c, Volumn: 1000 + r() * 500 + i * 1e-3 })
    }
    return out
}

//synthFactors, 三個因子之序列 [{ time, param }]: f_ret3(自第 3 根起)、f_rng1(全部)、index_f_z5(自第 5 根起); 缺者為暖機之缺值
//  withVbs = true 者另加第四個因子 f_vbs_vol(成交量類; 因子名含 _vbs_; 自第 2 根起); 未給者與只有三個因子者逐位相同(既有之釘死值不受影響)
export let synthFactors = (bars, withVbs = false) => {
    let F = { f_ret3: [], f_rng1: [], index_f_z5: [] }
    if (withVbs) {
        F.f_vbs_vol = []
    }
    bars.forEach((b, i) => {
        if (i >= 3) {
            F.f_ret3.push({ time: b.time, param: (b.Close - bars[i - 3].Close) / bars[i - 3].Close })
        }
        F.f_rng1.push({ time: b.time, param: (b.High - b.Low) / b.Close })
        if (i >= 5) {
            F.index_f_z5.push({ time: b.time, param: Math.sin(i * 0.37) + i * 1e-6 })
        }
        if (withVbs && i >= 2) {
            F.f_vbs_vol.push({ time: b.time, param: (b.Volumn - bars[i - 2].Volumn) / 1000 + Math.cos(i * 0.11) * 0.1 })
        }
    })
    return F
}

//entryBarsOf, 獨立之進場重算(合約 §3: 各條件於該棒皆有值〔非缺值〕、and 條件全成立、且〔無 or 條件或至少一個 or 條件成立〕): 回傳進場棒序(升冪)
export let entryBarsOf = (s, bars, F) => {
    let maps = {}
    for (let c of s.conds) {
        if (!maps[c.key]) {
            maps[c.key] = new Map(F[c.key].map((x) => [x.time, x.param]))
        }
    }
    let out = []
    bars.forEach((b, i) => {
        let missing = false
        let andOk = true
        let hasOr = false
        let orOk = false
        for (let c of s.conds) {
            let v = maps[c.key].get(b.time)
            if (v === undefined || Number.isNaN(v)) {
                missing = true
                break
            }
            let ok = c.sym === '<' ? v < c.th : v > c.th
            if (c.opr === 'or') {
                hasOr = true
                orOk = orOk || ok
            }
            else {
                andOk = andOk && ok
            }
        }
        if (!missing && andOk && (!hasOr || orOk)) {
            out.push(i)
        }
    })
    return out
}

//writeSynthLib, 於 dir 寫出合成策略庫(ohlc/<key>.json、param/<因子>.json、strategies/sNN.json)並回傳 { bars, F, strategies: [{ file, s, entries }] }
//  opt: { key, barHours, nBars, time0, seed, n(策略數), window: { start, end }(棒序; 預設 25% ~ 60% 處), windowOf(i)(逐策略之求解窗 { start, end } 時間字串; start 可省略或為 null = 不帶起點欄; 回 null = 不帶 summary), edit(i, s)(寫出前改策略物件), intervalSec(true = 帶每根秒數之宣告), vbs(true = 另加成交量類因子 f_vbs_vol, 第 i % 6 === 5 隻加一個以它為條件之 and 條件) }
export let writeSynthLib = (dir, { key = 'SYN_1day', barHours = 24, nBars = 760, time0 = '2020-01-01T00:00:00', seed = 20261120, n = 12, window = null, windowOf = null, edit = null, intervalSec = false, vbs = false } = {}) => {
    for (let d of ['ohlc', 'param', 'strategies']) {
        fs.mkdirSync(path.join(dir, d), { recursive: true })
    }
    let bars = synthBars({ barHours, nBars, time0, seed })
    let F = synthFactors(bars, vbs)
    fs.writeFileSync(path.join(dir, 'ohlc', `${key}.json`), JSON.stringify(bars))
    for (let [k, arr] of Object.entries(F)) {
        fs.writeFileSync(path.join(dir, 'param', `${k}.json`), JSON.stringify(arr))
    }
    let q = (arr, p) => arr.map((x) => x.param).sort((a, b) => a - b)[Math.floor(p * (arr.length - 1))]
    let w = window || { start: Math.floor(nBars * 0.25), end: Math.floor(nBars * 0.6) }
    let strategies = []
    for (let i = 0; i < n; i++) {
        let long = i % 2 === 0
        //條件: 每隻皆有 f_ret3(門檻逐隻相異); i % 3 === 0 加 f_rng1(and); i % 4 === 1 加 index_f_z5(and); i % 5 === 2 另加一個 f_rng1 之 or 條件(門檻與 and 條件相異)
        let conds = [{ key: 'f_ret3', sym: long ? '>' : '<', th: q(F.f_ret3, long ? 0.8 - i * 0.017 : 0.2 + i * 0.017), opr: 'and' }]
        if (i % 3 === 0) {
            conds.push({ key: 'f_rng1', sym: '>', th: q(F.f_rng1, 0.3 + i * 0.011), opr: 'and' })
        }
        if (i % 4 === 1) {
            conds.push({ key: 'index_f_z5', sym: '<', th: 0.5 + i * 0.013, opr: 'and' })
        }
        if (i % 5 === 2) {
            conds.push({ key: 'f_rng1', sym: '>', th: q(F.f_rng1, 0.55 + i * 0.007), opr: 'or' })
        }
        if (vbs && i % 6 === 5) {
            conds.push({ key: 'f_vbs_vol', sym: '<', th: q(F.f_vbs_vol, 0.6 + i * 0.01), opr: 'and' })
        }
        let s = {
            mode: long ? 'long' : 'short',
            conds,
            settings: { rTakeProfit: 0.02 + i * 0.003, rStopLoss: 0.015 + i * 0.0025, rFee: 0.0005 + i * 0.00001, ...(intervalSec ? { intervalSec: Math.round(barHours * 3600) } : {}) },
            levelNumTrade: i + 1,
        }
        let entries = entryBarsOf(s, bars, F)
        let wi = windowOf ? windowOf(i, bars) : { start: bars[w.start].time, end: bars[w.end].time }
        if (wi) {
            let iS = wi.start === undefined || wi.start === null ? 0 : bars.findIndex((b) => b.time === wi.start)
            let iE = bars.findIndex((b) => b.time === wi.end)
            //求解窗內之進場數(起點不在 K 線上者無從獨立重算 ⇒ 以第 0 根起算; 該情形之策略不納入核對, 數值不被使用)
            let nt = entries.filter((e) => e >= Math.max(iS, 0) && e <= iE).length
            s.numTrade = nt
            s.summary = { ...(wi.start === undefined ? {} : { timeOhlcStart: wi.start }), timeOhlcEnd: wi.end, numTrade: nt }
        }
        if (edit) {
            edit(i, s)
        }
        let file = `s${String(i).padStart(2, '0')}.json`
        fs.writeFileSync(path.join(dir, 'strategies', file), JSON.stringify(s))
        strategies.push({ file, s, entries })
    }
    return { bars, F, strategies, key, window: w }
}

//readCol, 讀帳本資料夾內之一個二進位欄為定型陣列(複製為自有之緩衝, 免位元組位移未對齊)
export let readCol = (dir, name, Ctor) => {
    let b = fs.readFileSync(path.join(dir, name))
    return new Ctor(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}

//ledgerDigestOf, 帳本資料夾之指紋(sha1 前 16 字): 除 meta.json 外每個檔之名稱與位元組, 另加 meta 去除 builtAt、buildSec、libraryRoot 後之 JSON 全文(含鍵之次序)
//  用於「未給新選項者之輸出與發布版逐位相同」之釘死值(該值以發布版之 buildLedger 於同一份合成資料取得)
//  editMeta(選配; 函數): 於雜湊前改 meta 之副本(去除 builtAt 等之後; 例: 把 check.compared 改回改前之值, 以證明「只有該欄不同」)
export let ledgerDigestOf = (dir, editMeta = null) => {
    let h = crypto.createHash('sha1')
    for (let f of fs.readdirSync(dir).sort()) {
        if (f === 'meta.json') {
            continue
        }
        h.update(`|${f}|`)
        h.update(fs.readFileSync(path.join(dir, f)))
    }
    let m = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
    delete m.builtAt
    delete m.buildSec
    delete m.libraryRoot
    if (typeof editMeta === 'function') {
        editMeta(m)
    }
    h.update(`|meta|${JSON.stringify(m)}`)
    return h.digest('hex').slice(0, 16)
}

//writeSynthSeries, 合成之外部序列夾: fund(每根皆有值, 逐根相異)、lag(棒序 % 7 === 3 之棒不列; 值逐根相異); 時間 = 棒之開盤時間
export let writeSynthSeries = (dir, bars) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'fund.json'), JSON.stringify(bars.map((b, i) => ({ time: b.time, value: 0.0001 * i + Math.cos(i) * 1e-3 }))))
    fs.writeFileSync(path.join(dir, 'lag.json'), JSON.stringify(bars.filter((b, i) => i % 7 !== 3).map((b) => ({ time: b.time, value: 50 + Math.sin(tms(b.time) / DAY) * 7 + tms(b.time) / DAY * 1e-4 }))))
}
