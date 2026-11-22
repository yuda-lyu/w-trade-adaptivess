import { phaseText } from '../eval/cfgNum.mjs'


//全樹之側別讀數(規則 R-REC-50; 純函數): 樹上之高分是否與選集之側別(做多比例)同進退 —— 搜尋地圖 §4 之讀數與警示、輪末摘要之警示一列
//  只列讀數與警示, 不改任何選取、S、階梯、否決、可信度、排序鍵
/**
 * 側別讀數之預設設定(settings.rsi.sideRead 未給或不合之鍵所用):minNodes = 相異成品之下限(不足不列),top = 排序鍵前幾名,corrAbs = 相關之絕對值之警示門檻,lo / hi = 前幾名之做多比例皆 ≤ lo 或皆 ≥ hi 之警示門檻
 *
 * @type {Object}
 */
let SIDE_READ_DEFAULT = Object.freeze({ minNodes: 10, top: 10, corrAbs: 0.6, lo: 0.2, hi: 0.8 })

/**
 * 側別讀數之設定(settings.rsi.sideRead 之解讀;無效即用預設、不拋錯)
 *
 * false 回 null(關閉);物件之各鍵:minNodes、top 須為 ≥ 2 之整數,corrAbs、lo、hi 須為 [0, 1] 之數值(另須 lo < hi),不合之鍵用預設;其餘(未給、非物件)回預設。
 *
 * @param {*} v 輸入 settings.rsi.sideRead 之值
 * @returns {Object|null} 回傳 { minNodes, top, corrAbs, lo, hi } 或 null(關閉)
 * @example
 * let c = sideReadCfgOf({ minNodes: 20 })
 * // => { minNodes: 20, top: 10, corrAbs: 0.6, lo: 0.2, hi: 0.8 }
 */
let sideReadCfgOf = (v) => {
    if (v === false) {
        return null
    }
    let o = v && typeof v === 'object' && !Array.isArray(v) ? v : {}
    let int2 = (x, d) => (Number.isInteger(x) && x >= 2 ? x : d)
    let unit = (x, d) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1 ? x : d)
    let c = { minNodes: int2(o.minNodes, SIDE_READ_DEFAULT.minNodes), top: int2(o.top, SIDE_READ_DEFAULT.top), corrAbs: unit(o.corrAbs, SIDE_READ_DEFAULT.corrAbs), lo: unit(o.lo, SIDE_READ_DEFAULT.lo), hi: unit(o.hi, SIDE_READ_DEFAULT.hi) }
    if (!(c.lo < c.hi)) {
        c.lo = SIDE_READ_DEFAULT.lo
        c.hi = SIDE_READ_DEFAULT.hi
    }
    return c
}

/**
 * 全樹之側別讀數(純函數;規則 R-REC-50)
 *
 * rows 之每列 { id, sel, longRatio, mean, key }:sel = 選集指紋(相同者只取先出現之一列 = 相異之成品),longRatio = 回測期之選集之做多比例,mean = 七相位平均,key = 排序鍵(非有限數值者排在最後);longRatio 與 mean 皆為有限數值之列才計。
 * 相異之列少於 cfg.minNodes 或 cfg 為 null 回 null。r = Pearson 相關(任一變異數為 0 ⇒ null,不據以警示);前 cfg.top 名依 key 由高至低(同值依 id)。
 *
 * @param {Array<Object>} rows 輸入候選之列(呼叫端已去掉未執行、被否決與別名者)
 * @param {Object|null} cfg 輸入 sideReadCfgOf 之結果
 * @returns {Object|null} 回傳 { n, r, nTop, topLo, topHi, warn: { corr, short, long } } 或 null
 * @example
 * let sr = sideReadOf(rows, sideReadCfgOf())
 */
let sideReadOf = (rows, cfg) => {
    if (!cfg) {
        return null
    }
    let seen = new Set()
    let xs = []
    for (let x of Array.isArray(rows) ? rows : []) {
        if (!x || !Number.isFinite(x.longRatio) || !Number.isFinite(x.mean)) {
            continue
        }
        let k = typeof x.sel === 'string' && x.sel ? x.sel : `\u0000${x.id}`
        if (seen.has(k)) {
            continue
        }
        seen.add(k)
        xs.push(x)
    }
    if (xs.length < cfg.minNodes) {
        return null
    }
    let n = xs.length
    let mx = xs.reduce((s, x) => s + x.longRatio, 0) / n
    let my = xs.reduce((s, x) => s + x.mean, 0) / n
    let sxy = 0
    let sxx = 0
    let syy = 0
    for (let x of xs) {
        sxy += (x.longRatio - mx) * (x.mean - my)
        sxx += (x.longRatio - mx) ** 2
        syy += (x.mean - my) ** 2
    }
    let r = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null
    let kv = (x) => (Number.isFinite(x.key) ? x.key : -Infinity)
    let top = xs.slice().sort((a, b) => (kv(b) - kv(a)) || (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0))).slice(0, cfg.top)
    let lrs = top.map((x) => x.longRatio)
    let topLo = Math.min(...lrs)
    let topHi = Math.max(...lrs)
    let warn = { corr: r !== null && Math.abs(r) >= cfg.corrAbs, short: topHi <= cfg.lo, long: topLo >= cfg.hi }
    return { n, r, nTop: top.length, topLo, topHi, warn }
}

let SIDE_READ_WARN_HEAD = '側別讀數之警示'
/**
 * 側別讀數之兩列之文字(純函數):line = 搜尋地圖 §4 之讀數一列(以「- 」起首),warn = 警示之句(以「側別讀數之警示」起首;未命中為空字串)
 *
 * @param {Object|null} sr 輸入 sideReadOf 之結果
 * @param {Integer} [nPh=7] 輸入相位數(settings.eval.phases 之長度),只用於「七相位平均」之寫法(排程第 547 項; 預設 7 者逐字不變),預設7
 * @returns {Object} 回傳 { line, warn };sr 為 null 回 { line: '', warn: '' }
 * @example
 * let t = sideReadTextOf(sr)
 */
let sideReadTextOf = (sr, nPh = 7) => {
    if (!sr) {
        return { line: '', warn: '' }
    }
    let f2 = (v) => v.toFixed(2)
    let line = `- 側別讀數(回測期;相異成品 ${sr.n} 個):做多比例與${phaseText(nPh, '相位')}平均之相關 ${sr.r === null ? '—' : f2(sr.r)};排序鍵前 ${sr.nTop} 名之做多比例 ${f2(sr.topLo)} ~ ${f2(sr.topHi)}。`
    let what = [sr.warn.corr ? '績效與做多比例高度相關' : null, sr.warn.short ? `排序鍵前 ${sr.nTop} 名皆偏做空` : null, sr.warn.long ? `排序鍵前 ${sr.nTop} 名皆偏做多` : null].filter(Boolean)
    let warn = what.length ? `${SIDE_READ_WARN_HEAD}:${what.join(';')}(相異成品 ${sr.n} 個)⇒ 樹上之高分可能來自側別之曝險,宜以兩側席次固定之版本與成員穩健性核對` : ''
    return { line, warn }
}


export { SIDE_READ_DEFAULT, sideReadCfgOf, sideReadOf, SIDE_READ_WARN_HEAD, sideReadTextOf }
