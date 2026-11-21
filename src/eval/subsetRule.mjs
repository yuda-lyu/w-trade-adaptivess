import { assertIntrinsics } from './intrinsics.mjs'
import { tieBaseOf, memberUOf } from './ledger.mjs'


//子庫之規則(規則 R-EV-47; 命令列 g_eval.mjs --subset <規則>[,<規則>…]; --member 之一般化)
//  只把符合全部規則(交集)之策略交給挑選函數與虛無抽樣(子庫帳本 subsetLedger: 重新編號、保留各策略於全庫之同分次鍵); 各規則皆於所給之帳本(全庫)上各自判定, 不依前一條之結果
//  rand:<p>:<鹽>[:<0|1>]        u < p(0, 預設)或 u ≥ 1 − p(1); u = memberUOf(tieBaseOf(全庫序號), 鹽)(同 --member 之切半之式: rand:0.5:<鹽>:<h> 之子庫 = --member <鹽>:<h> 之半庫)
//  tp:<lo>:<hi>、sl:<lo>:<hi>  止盈 / 止損(帳本之 float32 值)在 [fround(lo), fround(hi)] 內; 任一端可空(不限)
//  hold:<lo>:<hi>              進場與出場皆在訓練期內之已結單(訓練期結束時即已知之量)之持倉天數之中位(holdMedianOf)在 [lo, hi] 內; 無此類單者不屬任何帶(被去除)
//  keys:<lo>:<hi>              進場條件數(nKeys)在 [lo, hi] 內(整數)
//  side:long|short             只留該側
//  siderand:<long|short>:<鹽>[:<p>]  另一側全留; 所指之側留 u < p(預設 0.5)
//  nofam:<N>:<家族>            去除「任一條件之因子名之家族 = 所給之家族」之策略; 家族 = 因子名以底線切段、去掉前 N 段後以底線接回(段數 ≤ N 者無家族); N 必給(0 ~ 32; 無預設)
//  nofam:<N>:top:<比例>        依「用到該家族之策略數」由多到少(同數依家族名)逐一去除用到該家族之策略, 至去除之比例 ≥ 所給之比例(家族之名不得為 top)
//  數值: 十進位(tp / sl 可為負; hold 為非負; keys 為非負整數; 比例 0 < p ≤ 1); 鹽: 0 ~ 4294967295 之整數, 十進位或 0x 十六進位
//  不合 ⇒ 拋 SUBSET_MSG(不帶輸入值); 正規化之字串(tag)= 各條依序重寫(數值 String(Number(x))、鹽 0x<十六進位>、選配之段補上預設、空界留空)

/**
 * 命令列 --subset 之格式不合時之訊息(固定;不帶輸入值)
 *
 * @type {String}
 */
let SUBSET_MSG = 'invalid --subset: must be <rule>[,<rule>...] where each rule is rand, tp, sl, hold, keys, side, siderand or nofam (see README §3)'
/**
 * 命令列 --subset 與 --member 併用時之訊息(固定)
 *
 * @type {String}
 */
let SUBSET_MEMBER_MSG = 'invalid --subset: cannot be combined with --member'
//NOFAM_N_MAX, nofam 之 N 之上限(N 必給, 無預設: 套件不假定因子名之分段)
let NOFAM_N_MAX = 32

let RE_NUM = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/
let RE_NONNEG = /^(?:\d+(?:\.\d+)?|\.\d+)$/
let RE_INT = /^\d+$/
let RE_SALT = /^(0x[0-9a-fA-F]+|[0-9]+)$/
let RE_FAM = /^[^\s:,]+$/
let SIDES = ['long', 'short']

let bad = () => {
    throw new Error(SUBSET_MSG)
}
//saltOf, 鹽之字串 → 數值(同 --member: 位數不另限、以數值 ≤ 4294967295 為界; -0 正規化)
let saltOf = (s) => {
    if (!RE_SALT.test(s)) {
        bad()
    }
    let v = s.startsWith('0x') ? parseInt(s.slice(2), 16) : Number(s)
    if (!(v <= 0xFFFFFFFF)) {
        bad()
    }
    return v === 0 ? 0 : v
}
//ratioOf, 比例(0 < p ≤ 1)
let ratioOf = (s) => {
    let v = RE_NONNEG.test(s) ? Number(s) : NaN
    if (!(v > 0 && v <= 1)) {
        bad()
    }
    return v
}
//boundOf, 界(空字串 = 不限 ⇒ null); 須為有限數值
let boundOf = (s, re) => {
    if (s === '') {
        return null
    }
    let v = re.test(s) ? Number(s) : NaN
    if (!Number.isFinite(v)) {
        bad()
    }
    return v === 0 ? 0 : v
}
//nOf, nofam 之 N(0 ~ NOFAM_N_MAX 之整數)
let nOf = (s) => {
    let v = RE_INT.test(s) ? Number(s) : NaN
    if (!(v >= 0 && v <= NOFAM_N_MAX)) {
        bad()
    }
    return v
}
let parseOne = (tok) => {
    let a = tok.split(':')
    let k = a[0]
    if (k === 'rand') {
        if (a.length < 3 || a.length > 4) {
            bad()
        }
        let half = 0
        if (a.length === 4) {
            if (a[3] !== '0' && a[3] !== '1') {
                bad()
            }
            half = Number(a[3])
        }
        return { kind: 'rand', p: ratioOf(a[1]), salt: saltOf(a[2]), half }
    }
    if (k === 'tp' || k === 'sl' || k === 'hold' || k === 'keys') {
        if (a.length !== 3) {
            bad()
        }
        let re = k === 'keys' ? RE_INT : (k === 'hold' ? RE_NONNEG : RE_NUM)
        let lo = boundOf(a[1], re)
        let hi = boundOf(a[2], re)
        if ((lo === null && hi === null) || (lo !== null && hi !== null && lo > hi)) {
            bad()
        }
        return { kind: k, lo, hi }
    }
    if (k === 'side') {
        if (a.length !== 2 || !SIDES.includes(a[1])) {
            bad()
        }
        return { kind: 'side', side: a[1] }
    }
    if (k === 'siderand') {
        if (a.length < 3 || a.length > 4 || !SIDES.includes(a[1])) {
            bad()
        }
        return { kind: 'siderand', side: a[1], salt: saltOf(a[2]), p: a.length === 4 ? ratioOf(a[3]) : 0.5 }
    }
    if (k === 'nofam') {
        //N 必給且置前(nofam:<N>:<家族> / nofam:<N>:top:<比例>): 套件不假定因子名之分段
        if (a.length < 3) {
            bad()
        }
        let N = nOf(a[1])
        if (a[2] === 'top') {
            if (a.length !== 4) {
                bad()
            }
            return { kind: 'nofamTop', ratio: ratioOf(a[3]), N }
        }
        if (a.length !== 3 || !RE_FAM.test(a[2])) {
            bad()
        }
        return { kind: 'nofam', family: a[2], N }
    }
    return bad()
}
let numTxt = (v) => (v === null ? '' : String(v))
let tagOf = (r) => {
    if (r.kind === 'rand') {
        return `rand:${String(r.p)}:0x${r.salt.toString(16)}:${r.half}`
    }
    if (r.kind === 'side') {
        return `side:${r.side}`
    }
    if (r.kind === 'siderand') {
        return `siderand:${r.side}:0x${r.salt.toString(16)}:${String(r.p)}`
    }
    if (r.kind === 'nofam') {
        return `nofam:${r.N}:${r.family}`
    }
    if (r.kind === 'nofamTop') {
        return `nofam:${r.N}:top:${String(r.ratio)}`
    }
    return `${r.kind}:${numTxt(r.lo)}:${numTxt(r.hi)}`
}

/**
 * 解析子庫之規則(命令列 --subset 之值;多條以逗號相連 = 交集)
 *
 * @param {String} str 輸入規則之字串(例 'rand:0.5:0x5bd1e995:0,tp::0.05')
 * @returns {Object} 回傳 { rules, tag }:rules 為各條之解析結果之陣列,tag 為正規化之字串
 * @example
 * let r = parseSubsetRule('rand:.5:1,side:long')
 * // r.tag => 'rand:0.5:0x1:0,side:long'
 */
let parseSubsetRule = (str) => {
    if (typeof str !== 'string' || str.length === 0) {
        bad()
    }
    let toks = str.split(',')
    if (toks.some((t) => t.length === 0)) {
        bad()
    }
    let rules = toks.map(parseOne)
    return { rules, tag: rules.map(tagOf).join(',') }
}

/**
 * 一隻策略之進場與出場皆在訓練期內之已結單之持倉天數之中位(子庫之 hold 規則與庫況體檢共用;訓練期結束時即已知之量)
 * 單 = 進場棒 ≥ fromBar、已結(出場棒 ≥ 0)且出場棒 < toBar(進場棒必早於出場棒);天數 = (出場棒 − 進場棒)÷ 每日棒數;偶數筆取中間兩數之均;無此類單者回 null
 *
 * @param {Object} L 輸入帳本物件(loadLedger 或子庫 / 半庫帳本)
 * @param {Integer} s 輸入策略之序號(帳本內)
 * @param {Integer} fromBar 輸入進場棒之下界(含)
 * @param {Integer} toBar 輸入出場棒之上界(不含;訓練期之終點棒序)
 * @returns {Number|null} 回傳持倉天數之中位,無單者為 null
 * @example
 * let d = holdMedianOf(L, 0, 0, 1200)
 */
let holdMedianOf = (L, s, fromBar, toBar) => {
    let ds = []
    for (let j = L.off[s]; j < L.off[s + 1]; j++) {
        if (L.ent[j] >= fromBar && L.ext[j] >= 0 && L.ext[j] < toBar) {
            ds.push((L.ext[j] - L.ent[j]) / L.barsPerDay)
        }
    }
    if (ds.length === 0) {
        return null
    }
    ds.sort((a, b) => a - b)
    let k = ds.length
    return k % 2 ? ds[(k - 1) / 2] : (ds[k / 2 - 1] + ds[k / 2]) / 2
}

//familyOf, 因子名之家族: 以底線切段、去掉前 N 段後以底線接回; 段數 ≤ N 者為空字串(無家族)
let familyOf = (name, N) => {
    let segs = String(name).split('_')
    return segs.length > N ? segs.slice(N).join('_') : ''
}

/**
 * 依子庫之規則求遮罩(各規則各自於所給之帳本上判定,遮罩 = 交集)
 * 入口先比對受保護之內建物件(命令列於載入挑選模組之後呼叫),其後同步執行
 *
 * @param {Object} L 輸入帳本物件(loadLedger 之回傳)
 * @param {Array<Object>} rules 輸入 parseSubsetRule 之 rules
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Integer} [opt.trainEndBar] 輸入訓練期之終點棒序(hold 規則須給;出場棒 < 此值)
 * @param {Integer} [opt.trainFromBar=0] 輸入訓練期之下界棒序(hold 規則之進場棒 ≥ 此值)
 * @returns {Object} 回傳 { sel, topFamilies }:sel 為 Uint8Array(L.n;1 = 留),topFamilies 為各條 nofam:top 所去除之家族(依序;無此規則者為 null)
 * @example
 * let { sel } = subsetMaskOf(L, parseSubsetRule('side:long').rules)
 */
let subsetMaskOf = (L, rules, { trainEndBar = null, trainFromBar = 0 } = {}) => {
    assertIntrinsics('ledger-load')
    if (!Array.isArray(rules) || rules.length === 0) {
        throw new Error('invalid rules: must be a non-empty array (see parseSubsetRule)')
    }
    if (rules.some((r) => r && r.kind === 'hold')) {
        if (!(Number.isInteger(trainEndBar) && trainEndBar >= 0)) {
            throw new Error('invalid opt.trainEndBar: must be a non-negative integer (required by the hold rule)')
        }
        if (!(Number.isInteger(trainFromBar) && trainFromBar >= 0)) {
            throw new Error('invalid opt.trainFromBar: must be a non-negative integer')
        }
    }
    let n = L.n
    let src = L.srcIdx === undefined || L.srcIdx === null ? null : L.srcIdx
    let uOf = (s, salt) => memberUOf(tieBaseOf(src === null ? s : src[s]), salt)
    let isLong = (s) => L.mode[s] > 0
    let sel = new Uint8Array(n)
    for (let s = 0; s < n; s++) {
        sel[s] = 1
    }
    let and = (keep) => {
        for (let s = 0; s < n; s++) {
            if (sel[s] === 1 && !keep(s)) {
                sel[s] = 0
            }
        }
    }
    let inBand = (v, lo, hi) => (lo === null || v >= lo) && (hi === null || v <= hi)
    //famsOf(N), 各策略所用之家族之集合(不含空字串; 依 N 快取)
    let famCache = new Map()
    let famsOf = (N) => {
        if (!famCache.has(N)) {
            let byKey = (L.keyNames || []).map((nm) => familyOf(nm, N))
            let out = []
            for (let s = 0; s < n; s++) {
                let fs = new Set()
                for (let j = L.keyOff[s]; j < L.keyOff[s + 1]; j++) {
                    let f = byKey[L.keyIdx[j]]
                    if (typeof f === 'string' && f.length > 0) {
                        fs.add(f)
                    }
                }
                out.push(fs)
            }
            famCache.set(N, out)
        }
        return famCache.get(N)
    }
    let topFamilies = []
    for (let r of rules) {
        if (r.kind === 'rand') {
            and((s) => (r.half === 0 ? uOf(s, r.salt) < r.p : uOf(s, r.salt) >= 1 - r.p))
        }
        else if (r.kind === 'tp' || r.kind === 'sl') {
            let col = r.kind === 'tp' ? L.tp : L.sl
            and((s) => inBand(col[s], r.lo === null ? null : Math.fround(r.lo), r.hi === null ? null : Math.fround(r.hi)))
        }
        else if (r.kind === 'hold') {
            and((s) => {
                let d = holdMedianOf(L, s, trainFromBar, trainEndBar)
                return d !== null && inBand(d, r.lo, r.hi)
            })
        }
        else if (r.kind === 'keys') {
            and((s) => inBand(L.nKeys[s], r.lo, r.hi))
        }
        else if (r.kind === 'side') {
            and((s) => isLong(s) === (r.side === 'long'))
        }
        else if (r.kind === 'siderand') {
            and((s) => (isLong(s) !== (r.side === 'long') ? true : uOf(s, r.salt) < r.p))
        }
        else if (r.kind === 'nofam') {
            let fams = famsOf(r.N)
            and((s) => !fams[s].has(r.family))
        }
        else if (r.kind === 'nofamTop') {
            let fams = famsOf(r.N)
            let cnt = new Map()
            for (let s = 0; s < n; s++) {
                for (let f of fams[s]) {
                    cnt.set(f, (cnt.get(f) || 0) + 1)
                }
            }
            let order = [...cnt.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0)))
            let removed = new Uint8Array(n)
            let nRem = 0
            let dropped = []
            for (let [f] of order) {
                if (n === 0 || nRem / n >= r.ratio) {
                    break
                }
                dropped.push(f)
                for (let s = 0; s < n; s++) {
                    if (removed[s] === 0 && fams[s].has(f)) {
                        removed[s] = 1
                        nRem++
                    }
                }
            }
            topFamilies.push(dropped)
            and((s) => removed[s] === 0)
        }
        else {
            throw new Error('invalid rules: must be a non-empty array (see parseSubsetRule)')
        }
    }
    return { sel, topFamilies: topFamilies.length ? topFamilies : null }
}


export { SUBSET_MSG, SUBSET_MEMBER_MSG, parseSubsetRule, subsetMaskOf, holdMedianOf, familyOf }
