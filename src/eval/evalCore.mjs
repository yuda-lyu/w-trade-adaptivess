import crypto from 'crypto'
import iseint from 'wsemi/src/iseint.mjs'
import { P, copyRange, copyAll, pushOwn, assertIntrinsics, violationMark, violationSince, isIntegrityError, integrityError, adoptError, snapData, handOut, isMutableSnap, isBrand } from './intrinsics.mjs'

const { ObjectFreeze, ObjectSeal, ObjectHasOwn, ReflectApply, ArrayFrom, ArrayIsArray, ArrayPrototypeJoin, ArrayBufferIsView, NumberCtor, NumberIsInteger, NumberIsFinite, MathFloor, MathRound, MathMax, MathMin, MathImul, StringCtor, JSONStringify, StructuredClone, ErrorCtor, MapPrototypeGet, MapPrototypeSet, MapPrototypeHas, MapPrototypeDelete, MapPrototypeKeys, MapIteratorNext, SetPrototypeGetSize, TypedArrayFrom, TypedArrayPrototypeGetLength, TypedArrayPrototypeGetToStringTag, Int8ArrayCtor, Uint8ArrayCtor, Uint16ArrayCtor, Int32ArrayCtor, Uint32ArrayCtor, Float32ArrayCtor, Float64ArrayCtor } = P


//快速評估核心:「項目之事件帳本 + 於各決策時點只憑過去資訊挑子集(可另給逐訊號之執行規則)+ 往後視窗之結果彙整」
//  通用於任何「項目(此處為策略)各有一串事件(此處為訂單: 進場棒、出場棒、每單位損益)」之領域; 與交易有關者只有名稱
//  決策節奏: 每 cadenceDays 日決策一次; 起始相位 phase(日)各跑一遍取平均, 去除對齊運氣
//  挑選函數 pick(ctx) → 序號陣列, 或 { ids, tag }(tag 為可結構化複製之資料, 於回傳時取快照並凍結, 交給該決策視窗內每個訊號之 accept; 規則 R-EV-35);
//    另可帶 group(與 ids 等長之整數陣列, 0 ~ 3; 分帳: 各席所屬之子帳 ⇒ accept 收到 sig.group 與 book.openGroup[4]; 規則 R-EV-23)
//  執行規則 accept(sig, book) → 布林(選配): 選集內策略之每個進場訊號依時間先後逐一詢問是否下單; 未提供 ⇒ 全收
//    sig  = { sid, bar, day, dow(0 週日 … 6 週六), mode(1 做多 / -1 做空), k(決策序), tag }
//    book = { open, openLong, openShort(現有持倉單數: 已下單而尚未出場), dayCount(當日已下單數), winCount(本決策視窗已下單數), nAccepted, pnlClosed(已出場單之累計損益) }
//    accept 須為 (sig, book) 之純函數(評估器於操作績效、各新鮮度視窗、虛無各自獨立模擬, 各有自己的 book)
//  操作績效 op(視窗 = 決策間隔, 首尾相接, book 連續): 等效年化 eqYr(%) = 已下單之總損益 ÷ 最大同時持倉單數 ÷ 年數 × 100(每單 1 單位)
//    帳本期末仍未出場者: 損益 0、計入持倉至期末
//  新鮮度 fresh[H]: 各決策之選集於其後 H 日內之訊號(每窗獨立之 book); eqYr_H = 各窗損益之平均 ÷ (H/365.25) ÷ 各窗最大同時持倉之最大值 × 100
//  同劑量虛無 null: 同決策時點、同每次選集大小、同 tag 與同 accept, 選集改自全部項目均勻不放回隨機挑, 重複 draws 次 ⇒ op 等效年化(相位平均)之虛無分佈與 p 值
//  無前視: 挑選函數只拿到 ctx, 其統計一律以決策棒 b 為界(出場棒 < b 者才算已結); accept 只拿到訊號當下之資訊; 帳本陣列不外露
//  評估器之狀態不受模組之寫入影響(規則 R-EV-35; 挑選模組、擴充診斷模組與評估器同在一個 realm):
//    ① 資料不共用: 交給模組之物件一律為複本或凍結物件 —— ctx.meta(每次 runPick 另給一份; 評估器排序用之 tie、幾何分組用之 tp / sl 不外露)、
//       ctx.prev(前一選集之複本)、ctx.stat 之回傳物件(凍結; 其陣列為每次決策重寫之暫存)、tag(pick 回傳時以結構化複製取快照並凍結)、
//       accept 之 sig / book(封裝之交出物件, 每次呼叫前以評估器自己之計數重寫; 持倉峰值等只依評估器之計數)、擴充診斷之 api(每個診斷另給一份)
//    ② 內建物件之完整性: ctx 之各函數與逐訊號模擬只用 ./intrinsics.mjs 於載入時擷取之參照(複製帳本之區段用 copyRange);
//       每次呼叫 pick 後、每批 accept 呼叫(一次逐訊號模擬)後、每個擴充診斷呼叫後與其 api 函數之入口比對受保護之內建物件, 不一致即拋 code 為 EVAL_INTEGRITY 之錯誤
//    模組之回傳值與參數先只以擷取之參照讀成評估器自有之資料(此段可能執行模組之存取子), 比對通過後才以一般寫法處理
//  擴充診斷之資料存取(規則 R-EV-36): api.market / factor / series 與 ctx 之同名介面共用同一份取值(marketAt / factorAt / seriesAt), 於同一棒逐位相同; api 之三個函數同其他 api 函數(apiFn、入口比對)
/**
 * 於已升冪排序之陣列 arr 的 [lo, hi) 區間內做二分搜尋, 回傳第一個「值 >= v」之位置
 * 區間內皆 < v 時回傳 hi
 *
 * @param {Array|TypedArray} arr 輸入已升冪排序之陣列或定型陣列
 * @param {Integer} lo 輸入搜尋區間起點(含)
 * @param {Integer} hi 輸入搜尋區間終點(不含)
 * @param {Number} v 輸入要比較之值
 * @returns {Integer} 回傳第一個值不小於 v 之位置, 範圍為 lo ~ hi
 * @example
 * let ind = lowerBound([1, 3, 3, 7], 0, 4, 3)
 */
let lowerBound = (arr, lo, hi, v) => {
    while (lo < hi) {
        let m = (lo + hi) >>> 1
        if (arr[m] < v) {
            lo = m + 1
        }
        else {
            hi = m
        }
    }
    return lo
}

/**
 * 逐策略之訓練期進場數: 進場棒 < trainEndBar 之訂單數(帳本之逐單欄依進場棒升冪, 以二分搜尋取得; 自帳本起點起算, 不另依設定之訓練期起點扣除其前之進場 —— 同命令列原有之算法)
 * makeEvaluator 要求呼叫端以此明給訓練期界線(L.ntStatic = ntStaticOf(L, trainEndBar)): ctx.meta.ntAll 只計訓練期之進場, 不含訓練期以後之資訊
 * 帳本全為訓練期者(無回測期、保留期之資料)給 L.nBars; **帳本涵蓋訓練期以後者(命令列之評估帳本含回測期、回測期重放之全期帳本)須給訓練期之終點棒序, 不可給 L.nBars**(否則訓練期以後之進場數被帶進 ctx.meta.ntAll)
 * 入口先比對受保護之內建物件(規則 R-EV-35 ②; 被改拋 code 為 EVAL_INTEGRITY 之錯誤); trainEndBar 之檢查依 wsemi iseint(安全整數之數字或其數字字串; 錯誤訊息不帶輸入值)
 *
 * @param {Object} L 輸入由 loadLedger 取得之帳本物件
 * @param {Integer} trainEndBar 輸入訓練期之終點棒序(0 以上之整數; 進場棒小於此值者計入; 大於等於 L.nBars 者為全期)
 * @returns {Int32Array} 回傳長度為 L.n 之陣列, 第 s 個為策略 s 於訓練期之進場數
 * @example
 * let st = getSettings()
 * let L = loadLedger(st.eval.ledgerDir)
 * //評估帳本涵蓋訓練期與回測期: 界線為訓練期之終點棒序(依帳本之 time0 與每棒小時數自設定之訓練期終點換算; 同命令列 src/cli/eval.mjs)
 * let trainEndBar = Math.round((Date.parse(`${st.periods.train.end}Z`) - Date.parse(`${L.meta.time0}Z`)) / (L.meta.barHours * 3600000))
 * L.ntStatic = ntStaticOf(L, trainEndBar)
 * let ev = makeEvaluator(L, { warmupDays: 180, cadenceDays: 7 })
 */
let ntStaticOf = (L, trainEndBar) => {
    assertIntrinsics('ledger-load')
    let b = iseint(trainEndBar) ? NumberCtor(trainEndBar) : NaN
    if (!(b >= 0)) {
        throw new ErrorCtor('invalid trainEndBar: must be a non-negative integer')
    }
    let nt = new Int32ArrayCtor(L.n)
    for (let s = 0; s < L.n; s++) {
        nt[s] = lowerBound(L.ent, L.off[s], L.off[s + 1], b) - L.off[s]
    }
    return nt
}

/**
 * 以種子建立可重現之偽亂數產生器(mulberry32)
 * 同一種子產生之序列固定, 供評估器之虛無抽樣等需可重現亂數處使用
 *
 * @param {Integer} seed 輸入亂數種子, 內部以 seed >>> 0 轉為無號 32 位元整數
 * @returns {Function} 回傳無參數函數, 每次呼叫回傳 [0, 1) 之亂數
 * @example
 * let rand = mulberry32(1)
 * let r = rand()
 */
let mulberry32 = (seed) => {
    let a = seed >>> 0
    return () => {
        a = (a + 0x6D2B79F5) >>> 0
        let t = MathImul(a ^ (a >>> 15), 1 | a)
        t = (t + MathImul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

let statOf = (xs) => {
    let n = xs.length
    if (n === 0) {
        return { mean: 0, min: 0, max: 0, sd: 0, byPhase: [] }
    }
    let mean = xs.reduce((s, v) => s + v, 0) / n
    let sd = Math.sqrt(xs.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n)
    return { mean, min: Math.min(...xs), max: Math.max(...xs), sd, byPhase: xs }
}

let r4 = (x) => Math.round(x * 10000) / 10000


/**
 * 以訂單帳本建立快速評估器
 * 評估器於各決策時點只憑決策棒以前之資訊呼叫挑選函數取得選集, 再彙整其後視窗之結果(操作績效、新鮮度、虛無檢定等); 詳細語義見檔頭說明
 *
 * @param {Object} L 輸入由 loadLedger 取得之帳本物件; 須另給 L.ntStatic(Int32Array, 長度 L.n, 逐策略於訓練期之進場數; 以 ntStaticOf(L, 訓練期之終點棒序) 取得, 帳本全為訓練期者為 ntStaticOf(L, L.nBars)); 未給或型態、長度不合者拋 invalid L.ntStatic: must be … 之錯誤(不回退為全期進場數)
 * @param {Object} [cfg={}] 輸入設定物件,預設{}
 * @param {Integer} [cfg.warmupDays=180] 輸入暖機日數,預設180
 * @param {Integer} [cfg.cadenceDays=7] 輸入決策間隔日數,預設7
 * @param {Integer} [cfg.tieSalt=0] 輸入同分次序之重放鹽值(整數),預設0(正本)
 * @param {Object} [cfg.fitEnd] 輸入各策略求解窗終點之時間字串物件{ long, short }(無時區之時間字串),預設未給
 * @param {Array} [cfg.phases=[0,1,2,3,4,5,6]] 輸入起始相位(日)陣列,evalPolicy未於opt指定時採用,預設[0,1,2,3,4,5,6]
 * @param {Array} [cfg.horizons=[1,3,7,14,30]] 輸入新鮮度地平線(日)陣列,evalPolicy未於opt指定時採用,預設[1,3,7,14,30]
 * @param {Integer} [cfg.nullDraws=64] 輸入虛無重複抽樣次數,evalPolicy未於opt指定時採用,預設64
 * @param {Integer} [cfg.seed=1] 輸入亂數種子,evalPolicy未於opt指定時採用,預設1
 * @returns {Object} 回傳評估器物件, 含方法: evalPolicy(評估一個挑選函數, 回傳完整評估結果), runPick(於一個相位依序呼叫挑選函數), opOf(操作績效), freshOf(新鮮度), nullOf(同劑量虛無), nullActOf(同活躍度虛無), nullSideActOf(同側同活躍度虛無), nullSideGeoOf(同側幾何分組虛無), sideGeoGroups(幾何分組), simWindows(視窗模擬), decisionBars(相位之決策棒), 以及屬性 meta(結構靜態欄)、timeOf(K棒序號轉時間字串)
 * @example
 * let st = getSettings()
 * let L = loadLedger(st.eval.ledgerDir)
 * let trainEndBar = Math.round((Date.parse(`${st.periods.train.end}Z`) - Date.parse(`${L.meta.time0}Z`)) / (L.meta.barHours * 3600000))
 * L.ntStatic = ntStaticOf(L, trainEndBar)
 * let ev = makeEvaluator(L, { warmupDays: 60, cadenceDays: 7 })
 * let { pick, accept } = await loadPick('./examples/pick_example.mjs')
 * let m = ev.evalPolicy(pick, { accept, phases: [0, 3], horizons: [3, 7], nullDraws: 16, seed: 11 })
 */
let makeEvaluator = (L, cfg = {}) => {

    let n = L.n
    let nBars = L.nBars
    let nFac = L.keyNames.length
    //外部序列(規則 R-EV-34; 選配): 名稱 → 序號; 帳本未建入者(含舊帳本)為空
    //  名稱為評估器自己之凍結複本(不與帳本物件共用; ctx.series 之錯誤訊息只讀它)
    let serNames = Object.freeze(Array.isArray(L.seriesNames) ? L.seriesNames.slice() : [])
    let serIdx = new Map(serNames.map((k, i) => [k, i]))
    let bpd = L.barsPerDay
    let warmupDays = cfg.warmupDays === undefined ? 180 : cfg.warmupDays
    let cadenceDays = cfg.cadenceDays === undefined ? 7 : cfg.cadenceDays
    let warm = warmupDays * bpd
    let cad = cadenceDays * bpd
    let time0Ms = Date.parse(`${L.meta.time0}Z`)
    let barMs = L.meta.barHours * 3600000
    let dow0 = new Date(time0Ms).getUTCDay()
    let timeOf = (b) => new Date(time0Ms + b * barMs).toISOString().slice(0, 19)

    //marketAt / factorAt / seriesAt, 棒 b 以前(棒序 < b; 不含 b)最近 nBack 根之 K 線 / 因子 / 外部序列之值(皆為複本; 由舊至新; 規則 R-EV-36)
    //  挑選函數之 ctx.market / ctx.factor / ctx.series(b = 決策棒; 規則 R-EV-29、R-EV-34)與擴充診斷之 api.market / api.factor / api.series(b = 呼叫端所給之棒)共用同一份取值
    //  ⇒ 兩邊於同一棒之取值逐位相同(由結構保證, 不靠兩份程式碼同步); who 為錯誤訊息之前綴('ctx.market' 或 'api.market' 等; 訊息其餘之文字相同)
    //  只用擷取之參照(規則 R-EV-35 ②): ctx 之各函數於 pick 執行期間被呼叫(其間不比對內建物件), api 之各函數於入口比對之後才呼叫, 二者皆不得經可被改寫之方法或全域綁定
    //  呼叫端須先驗好 b(0 ~ nBars 之整數)、ki(kiOk)與序列名稱(serIdx): 兩邊對輸入不合者之訊息不同(ctx 之訊息沿用既有字面且帶輸入值; api 之訊息不帶輸入值), 故驗證留在各自之呼叫端
    let marketAt = (b, nBack, who) => {
        if (!L.px) {
            throw new ErrorCtor(`${who}: 帳本無 K 線欄(請重建帳本)`)
        }
        let m = MathMax(0, MathMin(MathRound(nBack), b))
        let o = { open: new Float64ArrayCtor(m), high: new Float64ArrayCtor(m), low: new Float64ArrayCtor(m), close: new Float64ArrayCtor(m), volume: new Float64ArrayCtor(m) }
        for (let i = 0; i < m; i++) {
            let p = (b - m + i) * 5
            o.open[i] = L.px[p]
            o.high[i] = L.px[p + 1]
            o.low[i] = L.px[p + 2]
            o.close[i] = L.px[p + 3]
            o.volume[i] = L.px[p + 4]
        }
        return o
    }
    let kiOk = (ki) => NumberIsInteger(ki) && ki >= 0 && ki < nFac
    let factorAt = (ki, b, nBack, who) => {
        let F = L.fac
        if (!F || TypedArrayPrototypeGetLength(F) !== nFac * nBars) {
            throw new ErrorCtor(`${who}: 帳本無因子序列欄(請重建帳本)`)
        }
        let m = NumberIsFinite(nBack) ? MathMax(0, MathMin(MathRound(nBack), b)) : 0
        return copyRange(Float64ArrayCtor, F, ki * nBars + b - m, ki * nBars + b)
    }
    //serAvail, 訊息用之可用名稱(帳本未建入外部序列者另述)
    let serAvail = () => (serNames.length ? ArrayPrototypeJoin(serNames, '、') : '無;帳本未建入外部序列')
    let seriesAt = (si, b, nBack, who) => {
        let S = L.ser
        if (!S || TypedArrayPrototypeGetLength(S) !== serNames.length * nBars) {
            throw new ErrorCtor(`${who}: 帳本之外部序列欄與名稱不符(請重建帳本)`)
        }
        let m = NumberIsFinite(nBack) ? MathMax(0, MathMin(MathRound(nBack), b)) : 0
        return copyRange(Float64ArrayCtor, S, si * nBars + b - m, si * nBars + b)
    }

    //meta, 交給挑選函數之靜態欄(複本; 帳本自身之陣列不外露)
    //  只含結構屬性; ntAll 為訓練期之進場數, 屬「靜態、含決策日之後」之樣本內計數(要走勢前向之計數請用 ctx.stat)
    //  訓練期之界線由呼叫端明給 L.ntStatic(= ntStaticOf(L, 訓練期之終點棒序); 帳本全為訓練期者為 ntStaticOf(L, L.nBars)), 使此欄不含訓練期以後之資訊;
    //  未給(或型態、長度不合)者拒絕建評估器, 不回退為帳本全期之進場數 —— 帳本涵蓋訓練期以後者(回測期重放)回退即把其後之資訊帶進此欄(評估器無從得知帳本是否涵蓋訓練期以後)
    let ntGiven = L.ntStatic
    //型別以內部槽判定(不看原型鏈: 改了原型之其他定型陣列、偽造原型之物件不算 Int32Array; 跨 realm 之真 Int32Array 算)
    if (TypedArrayPrototypeGetToStringTag(ntGiven) !== 'Int32Array' || TypedArrayPrototypeGetLength(ntGiven) !== n) {
        throw new ErrorCtor('invalid L.ntStatic: must be an Int32Array of length L.n (entries per strategy within the training period; see ntStaticOf)')
    }
    let ntAll = new Int32Array(n)
    for (let s = 0; s < n; s++) {
        ntAll[s] = ntGiven[s]
    }
    //tie, 各策略固定之亂數(Uint32; 由序號經雜湊而得, 與策略之任何屬性無關): 排序同分時作次鍵用 —— 序號是策略檔之排序位置, 帶有資訊, 不宜當次鍵
    //  cfg.tieSalt(選配; 整數; 預設 0 = 正本): 迴圈之重放用 —— 以另一組固定之同分次序重放(規則 R-EV-22)
    //    主鍵大量同分之成品其入選者實際由 tie 決定(= 固定種子之隨機抽取), 只換 ctx.rand 之種子驗不到;
    //    非 0 時對正本之 tie 再做一次雙射雜湊(值仍兩兩相異), ctx.meta.tie、同一進場棒之訊號先後、虛無之同值次序皆隨之; 正本之數字不受影響
    let tieSalt = Number.isInteger(cfg.tieSalt) ? cfg.tieSalt : 0
    let tie = new Uint32Array(n)
    for (let s = 0; s < n; s++) {
        let x = Math.imul(s + 0x9E3779B9, 0x85EBCA6B)
        x = Math.imul(x ^ (x >>> 13), 0xC2B2AE35)
        x = (x ^ (x >>> 16)) >>> 0
        if (tieSalt !== 0) {
            x = Math.imul(x ^ Math.imul(tieSalt, 0x9E3779B1), 0x85EBCA6B)
            x = Math.imul(x ^ (x >>> 13), 0xC2B2AE35)
            x = (x ^ (x >>> 16)) >>> 0
        }
        tie[s] = x
    }
    //ordTieOf, 同一進場棒之訊號先後之另一組固定次序(擴充診斷之 simulate 之 opts.orderSalt 用; 規則 R-EV-32)
    //  對現行之 tie 再做一次與 tieSalt 相同之雙射雜湊(值仍兩兩相異); salt 0 = 現行之 tie(成品本身)
    //  於正本(tieSalt 0)之評估器上, salt k 之次序 = 以 tieSalt k 重放時之同棒訊號次序 —— 差別只在 ctx.meta.tie 不變、選集固定
    //  只供 simWindows 之排序用: 不外露、不入 ctx.meta, 正本之任何數字不受影響
    let ordTieCache = new Map()
    let ordTieOf = (salt) => {
        if (salt === 0) {
            return tie
        }
        let t = ordTieCache.get(salt)
        if (!t) {
            t = new Uint32Array(n)
            for (let s = 0; s < n; s++) {
                let x = Math.imul(tie[s] ^ Math.imul(salt, 0x9E3779B1), 0x85EBCA6B)
                x = Math.imul(x ^ (x >>> 13), 0xC2B2AE35)
                t[s] = (x ^ (x >>> 16)) >>> 0
            }
            if (ordTieCache.size >= 16) {
                ordTieCache.delete(ordTieCache.keys().next().value)
            }
            ordTieCache.set(salt, t)
        }
        return t
    }
    //fitEndBar, 各策略求解窗之終點棒(靜態; 由 cfg.fitEnd = { long, short }(無時區之時間字串)換算; 未給則為 -1): 此棒以後之訂單才是該策略沒見過之期間所產生
    //  終點落在帳本之後者(例如訓練期帳本內之做空策略)其值 ≥ 帳本之 K 棒數, 表示帳本內尚無求解窗後之訂單
    let fitEndBar = new Int32Array(n).fill(-1)
    if (cfg.fitEnd && typeof cfg.fitEnd === 'object') {
        let barOfTime = (t) => (t ? Math.round((Date.parse(`${t}Z`) - time0Ms) / barMs) : -1)
        let bl = barOfTime(cfg.fitEnd.long)
        let bs = barOfTime(cfg.fitEnd.short)
        for (let s = 0; s < n; s++) {
            fitEndBar[s] = L.mode[s] > 0 ? bl : bs
        }
    }
    let meta = Object.freeze({
        n,
        barsPerDay: bpd,
        fitEndBar,
        mode: Int8Array.from(L.mode),
        tp: Float32Array.from(L.tp),
        sl: Float32Array.from(L.sl),
        nKeys: Uint8Array.from(L.nKeys),
        cls: Uint8Array.from(L.cls),
        keyOff: Uint32Array.from(L.keyOff),
        keyIdx: Uint16Array.from(L.keyIdx),
        keyNames: Object.freeze(L.keyNames.slice()),
        //進場規則之各條件(與 keyIdx 逐格對齊; 規則 R-EV-29): keySym(+1 = '>'、-1 = '<')、keyTh(門檻)、keyOr(1 = or 條件); 舊帳本無此欄者為 null
        keySym: L.keySym ? Int8Array.from(L.keySym) : null,
        keyTh: L.keyTh ? Float64Array.from(L.keyTh) : null,
        keyOr: L.keyOr ? Uint8Array.from(L.keyOr) : null,
        //外部序列之名稱(規則 R-EV-34; 以 ctx.series(name, nBack) 取值); 帳本未建入者為空陣列
        seriesNames: Object.freeze(serNames.slice()),
        ntAll,
        tie,
    })
    //metaFor, 交給挑選函數(每次 runPick 一份)與擴充診斷(每個診斷一份)之靜態欄: 各定型陣列之複本(規則 R-EV-35 ①)
    //  定型陣列無法凍結: 共用同一份時, 模組改得到評估器排序用之 tie(同一進場棒之訊號先後、虛無之同值次序), 並可經由它把資料帶到其他相位、參考模組與擴充診斷
    //  評估器自身只用 tie(內部)與帳本之欄, 不讀交出之複本; 鍵與順序同 meta(ev.meta 為給呼叫端之正本, 不交給模組)
    let metaFor = () => ObjectFreeze({
        n,
        barsPerDay: bpd,
        fitEndBar: copyAll(Int32ArrayCtor, fitEndBar),
        mode: copyAll(Int8ArrayCtor, meta.mode),
        tp: copyAll(Float32ArrayCtor, meta.tp),
        sl: copyAll(Float32ArrayCtor, meta.sl),
        nKeys: copyAll(Uint8ArrayCtor, meta.nKeys),
        cls: copyAll(Uint8ArrayCtor, meta.cls),
        keyOff: copyAll(Uint32ArrayCtor, meta.keyOff),
        keyIdx: copyAll(Uint16ArrayCtor, meta.keyIdx),
        keyNames: meta.keyNames,
        keySym: copyAll(Int8ArrayCtor, meta.keySym),
        keyTh: copyAll(Float64ArrayCtor, meta.keyTh),
        keyOr: copyAll(Uint8ArrayCtor, meta.keyOr),
        seriesNames: meta.seriesNames,
        ntAll: copyAll(Int32ArrayCtor, ntAll),
        tie: copyAll(Uint32ArrayCtor, tie),
    })

    //decisionBars, 相位 phase 之決策棒(其後 W 根之視窗須完整落在帳本內)
    let decisionBars = (phase, W = cad) => {
        let bs = []
        for (let b = warm + phase * bpd; b + W <= nBars; b += cad) {
            bs.push(b)
        }
        return bs
    }

    //分帳(規則 R-EV-23): pick 可回傳 { ids, tag, group }, group 為與 ids 等長之整數陣列(0 ~ N_GROUP-1; 缺省全 0)——
    //  各席所屬之子帳; accept 收到 sig.group(該訊號之策略所屬之子帳)與 book.openGroup(長度 N_GROUP 之陣列: 各子帳現有持倉單數), 可為各子帳各設持倉上限
    //  group 不入 selHash、不影響未回傳 group 之成品; 虛無與組成對照之替換沿用被替換之席之 group(同劑量 / 同活躍度虛無依席次序對應)
    //  grpOf: 選集陣列(物件)→ 其各席之 group(Uint8Array; 與選集同序); 只在有回傳非 0 之 group 時才登記
    let N_GROUP = 4
    let grpOf = new WeakMap()
    //inheritGroups, 把成品該次選集 src 之分帳依席次序帶到替換後之選集 out(長度不同時循環取用); 無分帳則不動; 回 out
    let inheritGroups = (src, out) => {
        let g0 = src ? grpOf.get(src) : null
        if (g0 && g0.length && out.length) {
            let g = new Uint8Array(out.length)
            for (let i = 0; i < out.length; i++) {
                g[i] = g0[i % g0.length]
            }
            grpOf.set(out, g)
        }
        return out
    }
    //snapTag, tag 之快照(規則 R-EV-35 ①; 合約 §1: tag 只收可結構化複製之資料, 於 pick 回傳時取快照): 結構化複製並深度凍結
    //  挑選函數回傳後再改它所保留之物件, 不影響已記錄之 tag(否則可於較晚之決策把較晚之資訊寫進較早之決策之 tag, 交給較早之視窗之 accept)
    let snapTag = (t) => {
        try {
            if (typeof t === 'symbol') {
                throw new ErrorCtor('符號')
            }
            return snapData(t)
        }
        catch (err) {
            throw new ErrorCtor(`pick 回傳之 tag 須為可結構化複製之資料(數值、字串、物件、陣列等; 不得含函數、符號、共享記憶體): ${StringCtor((err && typeof err.message === 'string' && err.message) || '無法複製').slice(0, 120)}`)
        }
    }
    //pickOutOf, 收下 pick(或擴充診斷 simulate 之元素)之回傳值 —— 第一段: 只讀取並複製成評估器自有之資料(只用擷取之參照; 此段可能執行模組之存取子與迭代器)
    //  回 { arr(序號之陣列), garr(group 之陣列或 null), tag(快照), explicitGroup(物件形式且明給 group) }; 第二段 normSel 於比對內建物件之後才執行
    //  Set 以內部欄位辨識(不經 instanceof); ids / group 經 Array.from(與原寫法之 [...Set] 相同之迭代次序)
    let pickOutOf = (out) => {
        if (out === null || out === undefined) {
            throw new ErrorCtor('pick 回傳 null / undefined(須回傳序號陣列或 { ids, tag })')
        }
        let tag = null
        let ids = out
        let group = null
        if (!ArrayIsArray(out) && !ArrayBufferIsView(out) && !isBrand(SetPrototypeGetSize, out) && typeof out === 'object') {
            ids = out.ids
            let t = out.tag
            tag = t === undefined ? null : t
            let g = out.group
            group = g === undefined || g === null ? null : g
            if (ids === null || ids === undefined) {
                throw new ErrorCtor('pick 回傳之物件缺 ids')
            }
        }
        let arr = ArrayFrom(ids)
        let garr = group === null ? null : ArrayFrom(group)
        return { arr, garr, tag: snapTag(tag), explicitGroup: group !== null }
    }
    //normSel, 第二段: 驗證並正規化(已比對內建物件之後; 輸入為 pickOutOf 之回傳)
    let normSel = (px) => {
        let arr = px.arr
        let garr = px.garr
        let tag = px.tag
        if (garr !== null) {
            if (garr.length !== arr.length) {
                throw new Error(`pick 回傳之 group 須與 ids 等長(ids ${arr.length} 個、group ${garr.length} 個)`)
            }
        }
        //descOf, 錯誤訊息用之值之描述: 物件不轉字串(不執行模組之 toString; 此段已在比對內建物件之後)
        let descOf = (v) => (v !== null && (typeof v === 'object' || typeof v === 'function') ? '(物件)' : String(v).slice(0, 40))
        let seen = new Map()
        for (let i = 0; i < arr.length; i++) {
            let v = arr[i]
            if (!Number.isInteger(v) || v < 0 || v >= n) {
                throw new Error(`pick 回傳含不合法之序號: ${descOf(v)}(須為 0 ~ ${n - 1} 之整數)`)
            }
            let g = 0
            if (garr) {
                g = garr[i]
                if (!Number.isInteger(g) || g < 0 || g >= N_GROUP) {
                    throw new Error(`pick 回傳之 group 含不合法之值: ${descOf(g)}(須為 0 ~ ${N_GROUP - 1} 之整數)`)
                }
            }
            if (!seen.has(v)) {
                seen.set(v, g)
            }
        }
        let sel = Int32Array.from([...seen.keys()].sort((a, b) => a - b))
        let grp = null
        if (garr) {
            grp = Uint8Array.from(sel, (s) => seen.get(s))
            if (!grp.some((g) => g !== 0)) {
                grp = null
            }
        }
        if (grp) {
            grpOf.set(sel, grp)
        }
        return { sel, tag, grp }
    }

    //runPick, 於一個相位依序呼叫挑選函數; 回各決策之選集與 tag(tag 為快照)
    //  內建物件之完整性(規則 R-EV-35 ②): 入口與每次呼叫 pick 之後比對(呼叫前可能已有模組之頂層程式或延後執行之程式改過); ctx 之各函數於 pick 執行期間被呼叫, 只用擷取之參照
    //  pick 拋出之值以 adoptError 收下(改以評估器自建之錯誤轉拋, 訊息與堆疊之文字不變), 比對通過才轉拋
    //  ctx 之各函數只在該次 pick 呼叫內有效(alive): 其閉包共用各策略之游標(ce / cx), 呼叫結束後再呼叫(保留於模組層變數, 於其後之相位或 accept 內呼叫)
    //    會以較晚之游標回傳較晚之單 ⇒ 呼叫結束即失效、再呼叫拋錯
    //  偵測之黏著: 模組攔下評估器於其執行期間拋出之完整性錯誤(例: 延遲讀取帳本欄前之比對)並改回者, 以 violationSince 判該次評估仍失敗
    let runPick = (pickFn, phase, seed = 1) => {
        assertIntrinsics('pick')
        let mk = violationMark()
        let bars = decisionBars(phase)
        let ce = copyRange(Uint32ArrayCtor, L.off, 0, n) //各項目「進場棒 >= b 之第一單」之位置
        let cx = copyRange(Uint32ArrayCtor, L.xoff, 0, n) //各項目「出場棒 >= b 之第一筆已結單」之位置
        let state = {}
        let prev = new Int32Array(0)
        let ctxMeta = metaFor()
        let bufs = new Map()
        let sels = []
        let tags = []
        for (let k = 0; k < bars.length; k++) {
            let b = bars[k]
            for (let s = 0; s < n; s++) {
                let eh = L.off[s + 1]
                let e = ce[s]
                while (e < eh && L.ent[e] < b) {
                    e++
                }
                ce[s] = e
                let xh = L.xoff[s + 1]
                let x = cx[s]
                while (x < xh && L.xExt[x] < b) {
                    x++
                }
                cx[s] = x
            }
            //ctx 之各函數(stat、orders、entryDays、entryBars、exitDays、exitBars、market、factor、series、rand): 於 pick 執行期間被呼叫 ⇒ 只用擷取之參照(規則 R-EV-35 ②)
            //  (Map 之讀寫、陣列之 push / join、定型陣列之建構與長度、複製帳本之區段皆經 ./intrinsics.mjs; 不經可被改寫之原型或全域綁定)
            let done = new Map() //本決策已算過之 lookback
            let alive = true
            let deadErr = () => new ErrorCtor('ctx 之函數只在該次 pick 呼叫內有效(不得保留 ctx 於其後呼叫)')
            let stat = (days = 0) => {
                if (!alive) {
                    throw deadErr()
                }
                let key = days > 0 && NumberIsFinite(days) ? MathRound(days) : 0
                let B = MapPrototypeGet(bufs, key)
                if (!B) {
                    //緩衝重用: 回看日數逐次不同時(例如「自某固定日起」), 不為每個日數各留一組緩衝 —— 取用本次決策尚未用到之舊緩衝(其內容依合約只在當次 pick 內有效)
                    let it = MapPrototypeKeys(bufs)
                    for (let x = MapIteratorNext(it); !x.done; x = MapIteratorNext(it)) {
                        if (!MapPrototypeHas(done, x.value)) {
                            B = MapPrototypeGet(bufs, x.value)
                            MapPrototypeDelete(bufs, x.value)
                            break
                        }
                    }
                    if (!B) {
                        //回傳物件凍結(各欄不可換成他物; 陣列內容為每次決策重寫之暫存)
                        B = ObjectFreeze({ closed: new Int32ArrayCtor(n), wins: new Int32ArrayCtor(n), pnl: new Float64ArrayCtor(n), entries: new Int32ArrayCtor(n), open: new Int32ArrayCtor(n), lastEntryAgo: new Int32ArrayCtor(n) })
                    }
                    MapPrototypeSet(bufs, key, B)
                }
                if (MapPrototypeHas(done, key)) {
                    return B
                }
                //重用前核對: 模組可轉移(structuredClone 之 transfer)交出之陣列之緩衝使其分離(長度歸 0, 其後寫入無效)⇒ 有任一欄長度不符即另建一組
                if (TypedArrayPrototypeGetLength(B.closed) !== n || TypedArrayPrototypeGetLength(B.wins) !== n || TypedArrayPrototypeGetLength(B.pnl) !== n || TypedArrayPrototypeGetLength(B.entries) !== n || TypedArrayPrototypeGetLength(B.open) !== n || TypedArrayPrototypeGetLength(B.lastEntryAgo) !== n) {
                    B = ObjectFreeze({ closed: new Int32ArrayCtor(n), wins: new Int32ArrayCtor(n), pnl: new Float64ArrayCtor(n), entries: new Int32ArrayCtor(n), open: new Int32ArrayCtor(n), lastEntryAgo: new Int32ArrayCtor(n) })
                    MapPrototypeSet(bufs, key, B)
                }
                MapPrototypeSet(done, key, true)
                let from = key > 0 ? b - key * bpd : -1
                for (let s = 0; s < n; s++) {
                    let xlo = L.xoff[s]
                    let x1 = cx[s]
                    let x0 = from <= 0 ? xlo : lowerBound(L.xExt, xlo, x1, from)
                    B.closed[s] = x1 - x0
                    B.pnl[s] = (x1 > xlo ? L.xPnlCum[x1 - 1] : 0) - (x0 > xlo ? L.xPnlCum[x0 - 1] : 0)
                    B.wins[s] = (x1 > xlo ? L.xWinCum[x1 - 1] : 0) - (x0 > xlo ? L.xWinCum[x0 - 1] : 0)
                    let elo = L.off[s]
                    let e1 = ce[s]
                    let e0 = from <= 0 ? elo : lowerBound(L.ent, elo, e1, from)
                    B.entries[s] = e1 - e0
                    B.open[s] = (e1 - elo) - (x1 - xlo)
                    B.lastEntryAgo[s] = e1 > elo ? b - 1 - L.ent[e1 - 1] : 1000000000
                }
                return B
            }
            let orders = (s) => {
                if (!alive) {
                    throw deadErr()
                }
                if (!NumberIsInteger(s) || s < 0 || s >= n) {
                    throw new ErrorCtor(`ctx.orders: 序號不合法 ${s}`)
                }
                let rs = []
                for (let j = L.off[s]; j < ce[s]; j++) {
                    let x = L.ext[j]
                    let closed = x >= 0 && x < b
                    pushOwn(rs, { ent: L.ent[j], ext: closed ? x : null, pnl: closed ? L.pnl[j] : null })
                }
                return rs
            }
            let entryDays = (s, days = 0) => {
                if (!alive) {
                    throw deadErr()
                }
                if (!NumberIsInteger(s) || s < 0 || s >= n) {
                    throw new ErrorCtor(`ctx.entryDays: 序號不合法 ${s}`)
                }
                let from = days > 0 && NumberIsFinite(days) ? b - MathRound(days) * bpd : -1
                let e0 = from <= 0 ? L.off[s] : lowerBound(L.ent, L.off[s], ce[s], from)
                let out = new Int32ArrayCtor(ce[s] - e0)
                for (let j = e0; j < ce[s]; j++) {
                    out[j - e0] = MathFloor(L.ent[j] / bpd)
                }
                return out
            }
            //entryBars, 策略 s 於決策棒以前、最近 days 日內各進場單之進場棒序號(Int32Array 之複本; 由舊至新; 與 entryDays 同序、同長; 規則 R-EV-30)
            //  Math.floor(entryBars ÷ 每日棒數) = entryDays; 只含進場棒 < 決策棒者(ce 為各策略於決策棒以前之進場數之游標)⇒ 無前視; days 省略或 0 = 全部歷史; 成本與 entryDays 同級
            //  複本以 copyRange(擷取之建構子與 set; 不經 slice: 被換掉之 slice 之 this 即帳本之欄)
            let entryBars = (s, days = 0) => {
                if (!alive) {
                    throw deadErr()
                }
                if (!NumberIsInteger(s) || s < 0 || s >= n) {
                    throw new ErrorCtor(`ctx.entryBars: 序號不合法 ${s}`)
                }
                let from = days > 0 && NumberIsFinite(days) ? b - MathRound(days) * bpd : -1
                let e0 = from <= 0 ? L.off[s] : lowerBound(L.ent, L.off[s], ce[s], from)
                return copyRange(Int32ArrayCtor, L.ent, e0, ce[s])
            }
            //exitDays, 策略 s 於決策棒以前、最近 days 日內「已出場」之各單之出場日序號(Int32Array; 依出場時間由舊至新; 與 entryDays 對稱; 規則 R-EV-26)
            //  只含出場棒 < 決策棒者 ⇒ 無前視; days 省略或 0 = 全部歷史; 取自帳本內已依出場時間排序之每策略出場序列(成本與 entryDays 同級)
            let exitDays = (s, days = 0) => {
                if (!alive) {
                    throw deadErr()
                }
                if (!NumberIsInteger(s) || s < 0 || s >= n) {
                    throw new ErrorCtor(`ctx.exitDays: 序號不合法 ${s}`)
                }
                let from = days > 0 && NumberIsFinite(days) ? b - MathRound(days) * bpd : -1
                let x0 = from <= 0 ? L.xoff[s] : lowerBound(L.xExt, L.xoff[s], cx[s], from)
                let out = new Int32ArrayCtor(cx[s] - x0)
                for (let j = x0; j < cx[s]; j++) {
                    out[j - x0] = MathFloor(L.xExt[j] / bpd)
                }
                return out
            }
            //exitBars, 策略 s 於決策棒以前、最近 days 日內「已出場」之各單之出場棒序號(Int32Array 之複本; 依出場時間由舊至新; 與 exitDays 同序、同長; 規則 R-EV-31)
            //  Math.floor(exitBars ÷ 每日棒數) = exitDays; 只含出場棒 < 決策棒者 ⇒ 無前視; days 省略或 0 = 全部歷史; 成本與 exitDays 同級; 與 entryBars 對稱
            let exitBars = (s, days = 0) => {
                if (!alive) {
                    throw deadErr()
                }
                if (!NumberIsInteger(s) || s < 0 || s >= n) {
                    throw new ErrorCtor(`ctx.exitBars: 序號不合法 ${s}`)
                }
                let from = days > 0 && NumberIsFinite(days) ? b - MathRound(days) * bpd : -1
                let x0 = from <= 0 ? L.xoff[s] : lowerBound(L.xExt, L.xoff[s], cx[s], from)
                return copyRange(Int32ArrayCtor, L.xExt, x0, cx[s])
            }
            //market, 標的於決策棒以前最近 nBack 根 K 線(不含決策棒; 各陣列為複本, 由舊至新)
            //  取值為評估器之共用實作 marketAt(與擴充診斷之 api.market 同一份; 規則 R-EV-36)
            let market = (nBack = 180) => {
                if (!alive) {
                    throw deadErr()
                }
                return marketAt(b, nBack, 'ctx.market')
            }
            //factor, 因子 ki(序同 ctx.meta.keyNames)於決策棒以前最近 nBack 根 K 棒之值(Float64Array 複本, 由舊至新; 不含決策棒; 缺值 NaN; 規則 R-EV-29)
            //  慣例同 market: 只含棒序 < 決策棒者 ⇒ 無前視; 即觸發進場所用之同一份序列(原值)
            //  ⇒ 策略於某棒進場 ⇔ 其各條件(ctx.meta.keySym / keyTh / keyOr)於該棒皆有值, and 條件全成立, 且(無 or 條件, 或 or 條件至少一個成立)
            //  取值為共用實作 factorAt(與 api.factor 同一份; 規則 R-EV-36); 序號不合之訊息沿用既有字面(帶輸入值)
            let factor = (ki, nBack = 180) => {
                if (!alive) {
                    throw deadErr()
                }
                if (!kiOk(ki)) {
                    throw new ErrorCtor(`ctx.factor: 因子序號不合法 ${ki}`)
                }
                return factorAt(ki, b, nBack, 'ctx.factor')
            }
            //series, 外部序列 name(ctx.meta.seriesNames 之一)於決策棒以前最近 nBack 根 K 棒之值(Float64Array 複本, 由舊至新; 不含決策棒; 缺值 NaN; 規則 R-EV-34)
            //  慣例同 factor: 只含棒序 < 決策棒者(slice 之終點 = 決策棒之起點, 不含) ⇒ 無前視; 序列於建帳本時以棒之開盤時間對位並於帳本終點截斷(src/eval/ledgerBuild.mjs),
            //  其值視為「於該棒收盤時已得知」(與因子、K 線同一約定)——量在該棒收盤後才得知者, 使用端須自行把它標在其後之棒(合約 §3)
            //  帳本未建入任何外部序列、或名稱不在其內 ⇒ 拋錯(訊息列出可用之名稱; 沿用既有字面, 帶輸入值)
            //  取值為共用實作 seriesAt(與 api.series 同一份; 規則 R-EV-36)
            let series = (name, nBack = 180) => {
                if (!alive) {
                    throw deadErr()
                }
                let si = MapPrototypeGet(serIdx, name)
                if (si === undefined) {
                    throw new ErrorCtor(`ctx.series: 無此序列 ${typeof name === 'string' ? JSONStringify(name) : StringCtor(name)}(可用: ${serAvail()})`)
                }
                return seriesAt(si, b, nBack, 'ctx.series')
            }
            let day = MathFloor(b / bpd)
            //ctx.prev: 前一選集之複本(規則 R-EV-35 ①; 原為評估器所記錄之選集本身, 改它即改了已記錄之選集)
            let rng = mulberry32(seed * 1000003 + phase * 9973 + k)
            let rand = () => {
                if (!alive) {
                    throw deadErr()
                }
                return rng()
            }
            let ctx = { n, meta: ctxMeta, bar: b, day, dow: (dow0 + day) % 7, time: timeOf(b), k, phase, nDecisions: bars.length, cadenceDays, state, prev: copyAll(Int32ArrayCtor, prev), rand, stat, orders, entryDays, entryBars, exitDays, exitBars, market, factor, series }
            let px
            try {
                let raw = pickFn(ctx)
                //pick 返回即失效(其後讀回傳值之存取子 / 迭代器時, ctx 之函數已不可用)
                alive = false
                px = pickOutOf(raw)
            }
            catch (err) {
                alive = false
                let e2 = adoptError(err)
                assertIntrinsics('pick')
                throw violationSince(mk) || e2
            }
            assertIntrinsics('pick')
            let vio = violationSince(mk)
            if (vio) {
                throw vio
            }
            let r = normSel(px)
            sels.push(r.sel)
            tags.push(r.tag)
            prev = r.sel
        }
        return { bars, sels, tags }
    }

    //simWindows, 逐訊號模擬: wins = [{ b, e, sel, tag, k }](依 b 升冪, 互不重疊); accept 為 null ⇒ 全收
    //  回 { totalPnl, nSignals, nOrders, nClosed, nWin, nUnsettled, peak, hash }
    let closeL = new Int32Array(nBars + 2)
    let closeS = new Int32Array(nBars + 2)
    let closeP = new Float64Array(nBars + 2)
    let closeG = [0, 1, 2, 3].map(() => new Int32Array(nBars + 2)) //分帳: 各子帳於各棒出場之單數(只在選集有登記 group 時使用)
    //  col(選配)= { strat: Int32Array(n), bar: Int32Array(nBars + 2) }: 給定時把每張已下單之單計入其策略與進場棒(下單集中度用; 不影響任何數字)
    //    col 另帶 side(Float64Array(8): 做多之 [單數, 損益, 已結單數, 獲利單數] + 做空之同四項)與 tags(Map: tag 字串 → { orders, pnl })時, 另把每張單歸到其策略之方向與其決策視窗之 tag(損益歸因用)
    //    col 再帶 grp(Float64Array(N_GROUP * 4): 各子帳之 [單數, 損益, 已結單數, 獲利單數])時, 另把每張單歸到其策略所屬之子帳(未分帳者皆歸子帳 0; 規則 R-EV-33)
    //  ordKey(選配)= 同一進場棒之訊號先後所依之各策略次序(Uint32Array(n); 預設 = tie; 見 ordTieOf); 只影響逐訊號模擬之排序
    let tagKeyOf = (t) => (t === null || t === undefined ? null : (typeof t === 'string' ? t : JSON.stringify(t)).slice(0, 40))
    //inSim, 逐訊號模擬(有 accept 者)進行中: 不得重入 —— 模擬共用 closeL / closeS / closeP 等暫存, 擴充診斷之執行規則內再呼叫 simulate / replaceNull 會改到外層模擬之計數
    let inSim = false
    const REENTRY_MSG = '逐訊號模擬不得於執行規則(accept)之內再呼叫(simulate / replaceNull 之重入)'
    let simWindows = (wins, accept, col = null, ordKey = null) => {
        if (inSim) {
            throw new ErrorCtor(REENTRY_MSG)
        }
        if (wins.length === 0) {
            return { totalPnl: 0, nSignals: 0, nOrders: 0, nClosed: 0, nWin: 0, nUnsettled: 0, peak: 0, hash: 0 }
        }
        //tag 之歸因(col.tags): 各視窗之 tag 字串先於迴圈外對到槽位, 迴圈內只累加定型陣列(逐訊號之迴圈內不呼叫 Map / JSON 等可被改寫之方法; 規則 R-EV-35 ②)
        //  槽位之初值 = col.tags 內既有之累計, 迴圈後寫回 ⇒ 加總之先後與原寫法(逐單 a.pnl += p)相同, 數字逐位不變
        let tagSlot = null
        let tagKeys = null
        let tagO = null
        let tagP = null
        if (col && col.side && col.tags) {
            tagSlot = new Int32Array(wins.length).fill(-1)
            tagKeys = []
            let slotOf = new Map()
            for (let w = 0; w < wins.length; w++) {
                let tk = tagKeyOf(wins[w].tag)
                if (tk !== null) {
                    let q = slotOf.get(tk)
                    if (q === undefined) {
                        q = tagKeys.length
                        slotOf.set(tk, q)
                        tagKeys.push(tk)
                    }
                    tagSlot[w] = q
                }
            }
            tagO = new Float64Array(tagKeys.length)
            tagP = new Float64Array(tagKeys.length)
            for (let q = 0; q < tagKeys.length; q++) {
                let a = col.tags.get(tagKeys[q])
                if (a) {
                    tagO[q] = a.orders
                    tagP[q] = a.pnl
                }
            }
        }
        let tagFlush = () => {
            if (tagKeys) {
                for (let q = 0; q < tagKeys.length; q++) {
                    let a = col.tags.get(tagKeys[q])
                    if (a) {
                        a.orders = tagO[q]
                        a.pnl = tagP[q]
                    }
                    else if (tagO[q] > 0) {
                        col.tags.set(tagKeys[q], { orders: tagO[q], pnl: tagP[q] })
                    }
                }
            }
        }
        let attr = col && col.side && col.tags
            ? (s, w, j, g) => {
                let o = L.mode[s] > 0 ? 0 : 4
                let closed = L.ext[j] >= 0
                let p = closed ? L.pnl[j] : 0
                col.side[o]++
                if (closed) {
                    col.side[o + 1] += p
                    col.side[o + 2]++
                    if (p > 0) {
                        col.side[o + 3]++
                    }
                }
                if (col.grp) {
                    let og = g * 4
                    col.grp[og]++
                    if (closed) {
                        col.grp[og + 1] += p
                        col.grp[og + 2]++
                        if (p > 0) {
                            col.grp[og + 3]++
                        }
                    }
                }
                let q = tagSlot[w]
                if (q >= 0) {
                    tagO[q]++
                    tagP[q] += p
                }
            }
            : null
        //候選訊號(進場棒, 序號, 單之位置, 視窗序)
        let cj = []
        let cw = []
        let cs = col ? [] : null
        //cg, 各候選訊號之子帳(只在全收而須依子帳歸因時收集; 逐訊號之路徑另有 gOf)
        let cg = !accept && attr && col.grp ? [] : null
        for (let w = 0; w < wins.length; w++) {
            let { b, e, sel } = wins[w]
            let gsel = cg ? grpOf.get(sel) : null
            for (let q = 0; q < sel.length; q++) {
                let s = sel[q]
                let hi = L.off[s + 1]
                for (let j = lowerBound(L.ent, L.off[s], hi, b); j < hi && L.ent[j] < e; j++) {
                    cj.push(j)
                    cw.push(w)
                    if (cs) {
                        cs.push(s)
                    }
                    if (cg) {
                        cg.push(gsel ? gsel[q] : 0)
                    }
                }
            }
        }
        let nSig = cj.length
        let totalPnl = 0
        let nOrders = 0
        let nClosed = 0
        let nWin = 0
        let nUnsettled = 0
        let peak = 0
        let hash = 2166136261
        if (!accept) {
            //全收: 以差分陣列求最大同時持倉(不必排序)
            let lo = wins[0].b
            let hiBar = nBars
            closeL.fill(0, lo, hiBar + 1)
            for (let i = 0; i < nSig; i++) {
                let j = cj[i]
                nOrders++
                closeL[L.ent[j]]++
                if (col) {
                    col.strat[cs[i]]++
                    col.bar[L.ent[j]]++
                    if (attr) {
                        attr(cs[i], cw[i], j, cg ? cg[i] : 0)
                    }
                }
                let x = L.ext[j]
                if (x >= 0) {
                    totalPnl += L.pnl[j]
                    nClosed++
                    if (L.pnl[j] > 0) {
                        nWin++
                    }
                    closeL[x]--
                }
                else {
                    nUnsettled++
                }
            }
            let cur = 0
            for (let i = lo; i < hiBar; i++) {
                cur += closeL[i]
                if (cur > peak) {
                    peak = cur
                }
            }
            closeL.fill(0, lo, hiBar + 1)
            tagFlush()
            return { totalPnl, nSignals: nSig, nOrders, nClosed, nWin, nUnsettled, peak, hash: nSig }
        }
        //逐訊號: 依(進場棒, 策略之固定亂數 tie)排序
        let sidOf = new Int32Array(nSig)
        let ord = new Uint32Array(nSig)
        for (let i = 0; i < nSig; i++) {
            ord[i] = i
        }
        //分帳: 任一視窗之選集有登記 group 才啟用(未啟用時 book.openGroup[0] 恆等於 book.open, 其餘為 0; 既有成品之行為不變)
        let hasGrp = false
        for (let w = 0; w < wins.length; w++) {
            if (grpOf.has(wins[w].sel)) {
                hasGrp = true
                break
            }
        }
        let gOf = hasGrp ? new Uint8Array(nSig) : null
        //策略序號: 由單之位置反查(同一策略之單連續, cj 內同策略同視窗者相鄰)
        {
            let i = 0
            for (let w = 0; w < wins.length; w++) {
                let { b, e, sel } = wins[w]
                let gs = hasGrp ? grpOf.get(sel) : null
                for (let q = 0; q < sel.length; q++) {
                    let s = sel[q]
                    let hi = L.off[s + 1]
                    for (let j = lowerBound(L.ent, L.off[s], hi, b); j < hi && L.ent[j] < e; j++) {
                        if (gs) {
                            gOf[i] = gs[q]
                        }
                        sidOf[i++] = s
                    }
                }
            }
        }
        //同一進場棒之多個訊號: 依各策略固定之亂數 tie 定先後(不用策略序號 —— 序號是策略檔之排序位置, 做多者恆在做空者之前, 持倉上限擋單時會使做多恆先得席位)
        let arr = Array.from(ord)
        let tk = ordKey || tie
        arr.sort((a, b) => (L.ent[cj[a]] - L.ent[cj[b]]) || (tk[sidOf[a]] - tk[sidOf[b]]) || (a - b))
        let lo = wins[0].b
        closeL.fill(0, lo, nBars + 2)
        closeS.fill(0, lo, nBars + 2)
        closeP.fill(0, lo, nBars + 2)
        if (hasGrp) {
            for (let g = 0; g < N_GROUP; g++) {
                closeG[g].fill(0, lo, nBars + 2)
            }
        }
        //持倉簿與訊號(規則 R-EV-35 ①): 評估器以自己之計數(open … pnlClosed、og)模擬, 持倉峰值只依它;
        //  交給 accept 之 book / sig 為封裝(seal)之交出物件, 每次呼叫前以計數重寫 —— accept 改它們不影響模擬(原寫法 book 即計數本身, 改 book.open 即改了峰值)
        //  逐訊號之迴圈內只用擷取之參照與定型陣列(accept 為模組之程式, 兩次呼叫之間評估器不呼叫可被改寫之方法); 迴圈結束(或 accept 拋錯)時比對內建物件
        let open = 0
        let openLong = 0
        let openShort = 0
        let dayCount = 0
        let winCount = 0
        let nAccepted = 0
        let pnlClosed = 0
        let og = new Int32ArrayCtor(N_GROUP)
        let bookG = ObjectSeal([0, 0, 0, 0])
        let book = ObjectSeal({ open: 0, openLong: 0, openShort: 0, openGroup: bookG, dayCount: 0, winCount: 0, nAccepted: 0, pnlClosed: 0 })
        let sig = ObjectSeal({ sid: 0, bar: 0, day: 0, dow: 0, mode: 0, k: 0, tag: null, group: 0 })
        let curTag = null
        let curMut = false
        let cur = lo - 1
        let curDay = -1
        let curWin = -1
        let mk = violationMark()
        inSim = true
        try {
            for (let ii = 0; ii < nSig; ii++) {
                let i = arr[ii]
                let j = cj[i]
                let t = L.ent[j]
                while (cur < t) {
                    cur++
                    let a = closeL[cur]
                    let c = closeS[cur]
                    if (a || c) {
                        openLong -= a
                        openShort -= c
                        open -= a + c
                        pnlClosed += closeP[cur]
                        if (hasGrp) {
                            for (let g = 0; g < N_GROUP; g++) {
                                og[g] -= closeG[g][cur]
                            }
                        }
                        else {
                            og[0] = open
                        }
                    }
                }
                let day = MathFloor(t / bpd)
                if (day !== curDay) {
                    curDay = day
                    dayCount = 0
                }
                let w = cw[i]
                if (w !== curWin) {
                    curWin = w
                    winCount = 0
                    curTag = wins[w].tag
                    curMut = isMutableSnap(curTag)
                }
                let s = sidOf[i]
                let md = L.mode[s]
                let gq = hasGrp ? gOf[i] : 0
                //交出之 sig / book: 以評估器之計數重寫; 寫不進(accept 把它們凍結或設為不可寫)⇒ 判違約, 該次評估失敗(EVAL_INTEGRITY)
                //  tag: 凍結之快照照交; 可變者(Map、Set、Date、RegExp、定型陣列等)每次呼叫另給複本(同一視窗之各訊號互不相通)
                try {
                    sig.sid = s
                    sig.bar = t
                    sig.day = day
                    sig.dow = (dow0 + day) % 7
                    sig.mode = md
                    sig.k = wins[w].k
                    sig.tag = curMut ? StructuredClone(curTag) : curTag
                    sig.group = gq
                    book.open = open
                    book.openLong = openLong
                    book.openShort = openShort
                    bookG[0] = og[0]
                    bookG[1] = og[1]
                    bookG[2] = og[2]
                    bookG[3] = og[3]
                    book.openGroup = bookG
                    book.dayCount = dayCount
                    book.winCount = winCount
                    book.nAccepted = nAccepted
                    book.pnlClosed = pnlClosed
                }
                catch (err) {
                    throw integrityError('accept', ['accept 收到之 sig / book 被設為不可寫(合約 §4:不得改寫交出之物件)'])
                }
                if (accept(sig, book) !== true) {
                    continue
                }
                nOrders++
                nAccepted++
                dayCount++
                winCount++
                open++
                og[gq]++
                if (md > 0) {
                    openLong++
                }
                else {
                    openShort++
                }
                if (open > peak) {
                    peak = open
                }
                if (col) {
                    col.strat[s]++
                    col.bar[t]++
                    if (attr) {
                        attr(s, w, j, gq)
                    }
                }
                hash = MathImul(hash ^ (j + 1), 16777619) >>> 0
                let x = L.ext[j]
                if (x >= 0) {
                    totalPnl += L.pnl[j]
                    nClosed++
                    if (L.pnl[j] > 0) {
                        nWin++
                    }
                    if (md > 0) {
                        closeL[x]++
                    }
                    else {
                        closeS[x]++
                    }
                    if (hasGrp) {
                        closeG[gq][x]++
                    }
                    closeP[x] += L.pnl[j]
                }
                else {
                    nUnsettled++
                }
            }
        }
        catch (err) {
            inSim = false
            let e2 = adoptError(err)
            assertIntrinsics('accept')
            throw violationSince(mk) || e2
        }
        inSim = false
        if (nSig > 0) {
            assertIntrinsics('accept')
            let vio = violationSince(mk)
            if (vio) {
                throw vio
            }
        }
        tagFlush()
        closeL.fill(0, lo, nBars + 2)
        closeS.fill(0, lo, nBars + 2)
        closeP.fill(0, lo, nBars + 2)
        return { totalPnl, nSignals: nSig, nOrders, nClosed, nWin, nUnsettled, peak, hash }
    }

    //opOf, 操作績效(視窗 = 決策間隔, 首尾相接, book 連續)
    //  opt(選配)= { k0, col, ordKey }: k0 為 bars[0] 之決策序(切片重放時使 accept 收到之 sig.k 與挑選函數之 ctx.k 一致; 預設 0); col、ordKey 見 simWindows
    let opOf = (sels, bars, tags, accept, opt = null) => {
        let k0 = opt && Number.isInteger(opt.k0) ? opt.k0 : 0
        let wins = bars.map((b, k) => ({ b, e: b + cad, sel: sels[k], tag: tags ? tags[k] : null, k: k + k0 }))
        let r = simWindows(wins, accept, opt && opt.col ? opt.col : null, opt && opt.ordKey ? opt.ordKey : null)
        let days = bars.length * cadenceDays
        let years = days / 365.25
        return {
            eqYr: r.peak > 0 && years > 0 ? r.totalPnl / r.peak / years * 100 : 0,
            totalPnl: r.totalPnl,
            nSignals: r.nSignals,
            nOrders: r.nOrders,
            nClosed: r.nClosed,
            nUnsettled: r.nUnsettled,
            winRate: r.nClosed > 0 ? r.nWin / r.nClosed : 0,
            peakHold: r.peak,
            monthlyOrders: days > 0 ? r.nOrders / (days / 30.4375) : 0,
            nDecisions: bars.length,
            hash: r.hash,
        }
    }

    //groupRowsOf, 依子帳之損益歸因(規則 R-EV-33): acc = simWindows 之 col.grp(各相位累加), selsList = 各相位之逐決策選集, nP = 相位數
    //  回 [{ group, seats, orders, pnl, winRate }]: seats = 該子帳每次決策之平均席數; orders / pnl / winRate 之定義同 bySide(各相位平均; 損益只計已結之單)
    //  只列有席或有單之子帳; 未分帳者只有子帳 0 一列(= 全體)。各列之 orders 和 = 各相位平均之下單數、pnl 和 = op.pnl
    let groupRowsOf = (acc, selsList, nP) => {
        let seats = new Float64Array(N_GROUP)
        let nd = 0
        for (let sels of selsList) {
            for (let sel of sels) {
                nd++
                let gs = grpOf.get(sel)
                if (gs) {
                    for (let q = 0; q < sel.length; q++) {
                        seats[gs[q]]++
                    }
                }
                else {
                    seats[0] += sel.length
                }
            }
        }
        let row = (g) => ({ group: g, seats: r4(nd > 0 ? seats[g] / nd : 0), orders: r4(acc[g * 4] / nP), pnl: r4(acc[g * 4 + 1] / nP), winRate: acc[g * 4 + 2] > 0 ? r4(acc[g * 4 + 3] / acc[g * 4 + 2]) : 0 })
        let rows = []
        for (let g = 0; g < N_GROUP; g++) {
            if (seats[g] > 0 || acc[g * 4] > 0) {
                rows.push(row(g))
            }
        }
        return rows.length ? rows : [row(0)]
    }

    //freshOf, 新鮮度(選集於其後 H 日內之訊號; 每窗獨立之 book)
    //  k0(選配; 預設 0)= bars[0] 之決策序(切片評估時使 accept 收到之 sig.k 與挑選函數之 ctx.k 一致)
    let freshOf = (sels, bars, tags, accept, H, k0 = 0) => {
        let W = H * bpd
        let sum = 0
        let nw = 0
        let nPos = 0
        let maxPeak = 0
        for (let k = 0; k < bars.length; k++) {
            let b = bars[k]
            if (b + W > nBars) {
                break
            }
            let r = simWindows([{ b, e: b + W, sel: sels[k], tag: tags ? tags[k] : null, k: k + k0 }], accept)
            if (r.peak > maxPeak) {
                maxPeak = r.peak
            }
            sum += r.totalPnl
            nw++
            if (r.totalPnl > 0) {
                nPos++
            }
        }
        return { eqYr: nw > 0 && maxPeak > 0 ? (sum / nw) / (H / 365.25) / maxPeak * 100 : 0, posRate: nw > 0 ? nPos / nw : 0, nWindows: nw, peakHold: maxPeak }
    }

    let jaccard = (a, b) => {
        if (a.length === 0 && b.length === 0) {
            return 1
        }
        let i = 0
        let j = 0
        let c = 0
        while (i < a.length && j < b.length) {
            if (a[i] === b[j]) {
                c++
                i++
                j++
            }
            else if (a[i] < b[j]) {
                i++
            }
            else {
                j++
            }
        }
        return c / (a.length + b.length - c)
    }

    //nullOf, 同劑量虛無: 同決策時點、同每次選集大小、同 tag 與 accept, 選集改均勻不放回隨機挑
    //  回傳各抽之等效年化(相位平均)陣列; 陣列另帶 comp = { sigPerPick, longRatio }(各抽平均之選集組成, 供與成品之選集組成對照)
    let nullOf = (runs, accept, draws, seed) => {
        let stamp = new Int32Array(n)
        let tick = 0
        let vals = []
        let nSig = 0
        let nSlot = 0
        let nLong = 0
        for (let d = 0; d < draws; d++) {
            let rng = mulberry32(seed + (d + 1) * 7919)
            let acc = 0
            for (let r of runs) {
                let rs = r.sels.map((sel) => {
                    let k = sel.length
                    let out = new Int32Array(k)
                    tick++
                    let m = 0
                    while (m < k) {
                        let v = Math.floor(rng() * n)
                        if (stamp[v] !== tick) {
                            stamp[v] = tick
                            out[m++] = v
                            if (L.mode[v] > 0) {
                                nLong++
                            }
                        }
                    }
                    nSlot += k
                    return inheritGroups(sel.src || sel, out.sort())
                })
                let o = opOf(rs, r.bars, r.tags, accept, r.k0 ? { k0: r.k0 } : null)
                acc += o.eqYr
                nSig += o.nSignals
            }
            vals.push(acc / runs.length)
        }
        vals.comp = { sigPerPick: nSlot > 0 ? nSig / nSlot : 0, longRatio: nSlot > 0 ? nLong / nSlot : 0 }
        return vals
    }

    //nullActOf, 同活躍度虛無: 同決策時點、同每次選集大小、同 tag 與 accept, 且**活躍度分層相同**之隨機挑
    //  活躍度 = 該決策棒以前之累計進場數(走勢前向); 每次決策把全部項目依此值分為 nBins 層(分位; 同值者同層),
    //  成品該次之選集在各層各有幾隻, 隨機選集即自各層各抽同樣隻數(不放回)
    //  —— 「同訊號量虛無」以較少(或較多)隻之一般項目匹配總訊號量, 不匹配每隻之活躍度; 項目之活躍度本身與其樣本內績效相關時
    //     (例如進場少者須獲利才會被保留), 只是挑得較安靜 / 較活躍就會有超額, 本虛無把這一層扣掉
    //  回傳各抽之等效年化(相位平均)陣列, 另帶 comp = { sigPerPick }
    let nullActOf = (runs, accept, draws, seed, nBins = 10) => {
        let maxCnt = 0
        for (let s = 0; s < n; s++) {
            let c = L.off[s + 1] - L.off[s]
            if (c > maxCnt) {
                maxCnt = c
            }
        }
        let hist = new Int32Array(maxCnt + 2)
        let binOfCnt = new Uint8Array(maxCnt + 2)
        let acc = new Float64Array(draws)
        let nSig = 0
        let nSlot = 0
        for (let ri = 0; ri < runs.length; ri++) {
            let r = runs[ri]
            let nd = r.bars.length
            //各決策之分層: ord(依層排列之序號)、bs(各層於 ord 內之起點)、cd(成品於各層之隻數)
            let ce = Uint32Array.from(L.off.subarray(0, n))
            let ords = new Array(nd)
            let bss = new Array(nd)
            let cds = new Array(nd)
            let binOf = new Uint8Array(n)
            for (let k = 0; k < nd; k++) {
                let b = r.bars[k]
                hist.fill(0)
                for (let s = 0; s < n; s++) {
                    let eh = L.off[s + 1]
                    let e = ce[s]
                    while (e < eh && L.ent[e] < b) {
                        e++
                    }
                    ce[s] = e
                    hist[e - L.off[s]]++
                }
                let cum = 0
                for (let c = 0; c <= maxCnt; c++) {
                    binOfCnt[c] = Math.min(nBins - 1, Math.floor(cum / n * nBins))
                    cum += hist[c]
                }
                let bs = new Int32Array(nBins + 1)
                for (let s = 0; s < n; s++) {
                    let bi = binOfCnt[ce[s] - L.off[s]]
                    binOf[s] = bi
                    bs[bi + 1]++
                }
                for (let i = 0; i < nBins; i++) {
                    bs[i + 1] += bs[i]
                }
                let pos = Int32Array.from(bs.subarray(0, nBins))
                let ord = new Int32Array(n)
                for (let s = 0; s < n; s++) {
                    ord[pos[binOf[s]]++] = s
                }
                let cd = new Int32Array(nBins)
                let sel = r.sels[k]
                for (let i = 0; i < sel.length; i++) {
                    cd[binOf[sel[i]]]++
                }
                ords[k] = ord
                bss[k] = bs
                cds[k] = cd
            }
            for (let d = 0; d < draws; d++) {
                let rng = mulberry32(seed + (d + 1) * 7919 + ri * 104723)
                let rs = new Array(nd)
                for (let k = 0; k < nd; k++) {
                    let ord = ords[k]
                    let bs = bss[k]
                    let cd = cds[k]
                    let out = new Int32Array(r.sels[k].length)
                    let m = 0
                    for (let bi = 0; bi < nBins; bi++) {
                        let lo = bs[bi]
                        let len = bs[bi + 1] - lo
                        //層內部分洗牌(就地; 洗後仍是同一層之全部成員, 下一抽照用)
                        for (let i = 0; i < cd[bi]; i++) {
                            let j = i + Math.floor(rng() * (len - i))
                            let v = ord[lo + j]
                            ord[lo + j] = ord[lo + i]
                            ord[lo + i] = v
                            out[m++] = v
                        }
                    }
                    nSlot += m
                    rs[k] = inheritGroups(r.sels[k], out.sort())
                }
                let o = opOf(rs, r.bars, r.tags, accept, r.k0 ? { k0: r.k0 } : null)
                acc[d] += o.eqYr
                nSig += o.nSignals
            }
        }
        let vals = Array.from(acc, (v) => v / runs.length)
        vals.comp = { sigPerPick: nSlot > 0 ? nSig / nSlot : 0 }
        return vals
    }

    //nullSideActOf, 同側同活躍度虛無(組成對照): 同決策時點、同 tag 與 accept, 把成品該次選集之**每一隻**換成「同方向、活躍度名次相鄰」之隨機一隻
    //  活躍度 = 該決策棒以前之累計進場數(走勢前向); 各側(做多 / 做空)內依此值排名(同值依各策略固定之亂數 tie), 自該隻名次 ± half 名內均勻抽一隻(同一選集內不重複)
    //  —— 同活躍度虛無不分方向且只分 nBins 層(最高層很寬): 選集之方向或活躍度偏離全體隨機時, 「組成」(方向 × 活躍度)本身之績效會被算成內容;
    //     本虛無之隨機選集與成品同方向比例、活躍度逐隻相近, 成品超出它之部分才是「同組成內挑得比隨機好」
    //  回傳各抽之等效年化(相位平均)陣列, 另帶 comp = { sigPerPick }
    let tieRank = null
    let tieInv = null
    //nullGroupActOf, 配對隨機替換之通用版: 把選集之每一隻換成「同組、組內活躍度名次 ± half 名內」之隨機一隻
    //  grp(Int32Array(n); 靜態之組別 0 ~ nGrp-1); 活躍度 = 決策棒以前之累計進場數(同值依 tie)
    //  回傳各抽之等效年化(相位平均)陣列, 另帶 comp = { sigPerPick } 與 thirds = 各三等分段之各抽平均(各相位之決策數皆 ≥ 6 時才有; 分段同 evalPolicy 之 op.thirds)
    //  actDays(選配; 預設 0): > 0 時活躍度改為「決策棒以前最近 actDays 日之進場數」(0 = 累計)
    //  more(選配; 規則 R-EV-38; 預設 null = 行為與回傳之既有欄皆不變)= { subMask, decMask }: 只替換一部分之席, 供擴充診斷之 api.replaceNull 使用
    //    subMask(Uint8Array(N_GROUP); 1 = 替換該子帳之席): 未列之子帳之席**原樣保留**(未分帳之決策其席皆屬子帳 0); 保留之席先標記為已用 ⇒ 替換者不與之重複
    //      —— 「只換合成內某一條線」之配對隨機替換(該線之挑選內容 = 成品 − 只換該線之均; 持倉上限等執行規則照成品, 不受「只留一帳」之擠占影響)
    //    decMask(各相位一個 Uint8Array, 與該相位之決策數等長; 1 = 替換該決策之席): 遮罩外之決策給**空選集**(不計席數; 實作上亦不耗亂數 —— 非合約: 部分遮罩時各抽之選集僅於同選項重跑時可重現)
    //      —— 與成品之「只留遮罩內決策」之重放成對(依市況或任何狀態分組之組成對照: 活躍度為決策當下之值, 不必以靜態量近似)
    //    某一個為「全部」時(subMask 涵蓋成品之全部子帳、或 decMask 全為 1), 等同不給該項、只給另一項; 兩者皆為「全部」(或另一項未給)時, 亂數之取用與選集與未給 more 時逐位相同
    //  給 more 者回傳另帶 pnl(Float64Array(draws); 各抽之損益和(已結之單; 每單 1 單位)之相位平均; 定義同 opOf 之 totalPnl); 未給者回傳之形狀(含可列舉之鍵)不變
    //  鄰域內無未用之策略時該席從缺(同既有寫法; 保留之席先占位, 故部分替換時較易發生)
    let nullGroupActOf = (runs, accept, draws, seed, half, grp, nGrp, actDays = 0, more = null) => {
        let subMask = more && more.subMask ? more.subMask : null
        let decMask = more && more.decMask ? more.decMask : null
        let actBars = Number.isFinite(actDays) && actDays > 0 ? Math.round(actDays) * bpd : 0
        if (!tieRank) {
            let idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => (tie[a] - tie[b]) || (a - b))
            tieInv = Int32Array.from(idx)
            tieRank = new Int32Array(n)
            for (let i = 0; i < n; i++) {
                tieRank[idx[i]] = i
            }
        }
        //各組於排序後陣列內之起點(組別為排序鍵之最高位 ⇒ 同組者相連; 組之隻數為靜態)
        let gStart = new Int32Array(nGrp + 1)
        let maxCnt = 0
        for (let s = 0; s < n; s++) {
            gStart[grp[s] + 1]++
            let c = L.off[s + 1] - L.off[s]
            if (c > maxCnt) {
                maxCnt = c
            }
        }
        for (let g = 0; g < nGrp; g++) {
            gStart[g + 1] += gStart[g]
        }
        let span = maxCnt + 1
        let keys = new Float64Array(n)
        let pos = new Int32Array(n)
        let stamp = new Int32Array(n)
        let tick = 0
        let acc = new Float64Array(draws)
        let accP = more ? new Float64Array(draws) : null
        let wantThirds = runs.every((r) => r.bars.length >= 6)
        let accT = [new Float64Array(draws), new Float64Array(draws), new Float64Array(draws)]
        let nSig = 0
        let nSlot = 0
        let EMPTY_SEL = new Int32Array(0)
        for (let ri = 0; ri < runs.length; ri++) {
            let r = runs[ri]
            let nd = r.bars.length
            let ce = Uint32Array.from(L.off.subarray(0, n))
            let ords = new Array(nd)
            let selPos = new Array(nd)
            for (let k = 0; k < nd; k++) {
                let b = r.bars[k]
                //遮罩外之決策: 只推進進場游標(ce 為跨決策之累計), 不排名(其後不取用 ords / selPos)
                let skip = decMask !== null && !decMask[ri][k]
                for (let s = 0; s < n; s++) {
                    let eh = L.off[s + 1]
                    let e = ce[s]
                    while (e < eh && L.ent[e] < b) {
                        e++
                    }
                    ce[s] = e
                    if (skip) {
                        continue
                    }
                    let cnt = actBars > 0 ? e - lowerBound(L.ent, L.off[s], e, b - actBars) : e - L.off[s]
                    keys[s] = (grp[s] * span + cnt) * n + tieRank[s]
                }
                if (skip) {
                    continue
                }
                keys.sort()
                let ord = new Int32Array(n)
                for (let i = 0; i < n; i++) {
                    let s = tieInv[keys[i] - Math.floor(keys[i] / n) * n]
                    ord[i] = s
                    pos[s] = i
                }
                ords[k] = ord
                selPos[k] = Int32Array.from(r.sels[k], (s) => pos[s])
            }
            for (let d = 0; d < draws; d++) {
                let rng = mulberry32(seed + (d + 1) * 7919 + ri * 104723)
                let rs = new Array(nd)
                for (let k = 0; k < nd; k++) {
                    let sel = r.sels[k]
                    if (decMask && !decMask[ri][k]) {
                        //遮罩外之決策: 空選集(不計席數; 不耗亂數屬實作性質, 非合約)
                        rs[k] = EMPTY_SEL
                        continue
                    }
                    let out = new Int32Array(sel.length)
                    let bk0 = grpOf.get(sel) || null //分帳: 成品該次各席之子帳(替換者沿用被替換之席之子帳)
                    let bk = bk0 ? new Uint8Array(sel.length) : null
                    let m = 0
                    tick++
                    let ord = ords[k]
                    if (subMask) {
                        //未列之子帳之席原樣保留: 先標記為已用, 替換者即不會與之重複
                        for (let i = 0; i < sel.length; i++) {
                            if (!subMask[bk0 ? bk0[i] : 0]) {
                                stamp[sel[i]] = tick
                            }
                        }
                    }
                    for (let i = 0; i < sel.length; i++) {
                        if (subMask && !subMask[bk0 ? bk0[i] : 0]) {
                            if (bk) {
                                bk[m] = bk0[i]
                            }
                            out[m++] = sel[i]
                            continue
                        }
                        let g = grp[sel[i]]
                        let p = selPos[k][i]
                        let lo = Math.max(gStart[g], p - half)
                        let hi = Math.min(gStart[g + 1] - 1, p + half)
                        let v = ord[lo + Math.floor(rng() * (hi - lo + 1))]
                        for (let t = 0; t < 16 && stamp[v] === tick; t++) {
                            v = ord[lo + Math.floor(rng() * (hi - lo + 1))]
                        }
                        if (stamp[v] === tick) {
                            //鄰域內多數已被取用: 依序找第一個未用者; 全部用盡則此席從缺
                            v = -1
                            for (let q = lo; q <= hi; q++) {
                                if (stamp[ord[q]] !== tick) {
                                    v = ord[q]
                                    break
                                }
                            }
                            if (v < 0) {
                                continue
                            }
                        }
                        stamp[v] = tick
                        if (bk) {
                            bk[m] = bk0[i]
                        }
                        out[m++] = v
                    }
                    nSlot += m
                    if (bk) {
                        //連同子帳一起依序號排序
                        let idx = Array.from({ length: m }, (_, i) => i).sort((a, b) => out[a] - out[b])
                        let s2 = Int32Array.from(idx, (i) => out[i])
                        grpOf.set(s2, Uint8Array.from(idx, (i) => bk[i]))
                        rs[k] = s2
                    }
                    else {
                        rs[k] = out.slice(0, m).sort()
                    }
                }
                let o = opOf(rs, r.bars, r.tags, accept, r.k0 ? { k0: r.k0 } : null)
                acc[d] += o.eqYr
                if (accP) {
                    accP[d] += o.totalPnl
                }
                nSig += o.nSignals
                if (wantThirds) {
                    for (let g3 = 0; g3 < 3; g3++) {
                        let a = Math.floor(nd * g3 / 3)
                        let z = Math.floor(nd * (g3 + 1) / 3)
                        accT[g3][d] += opOf(rs.slice(a, z), r.bars.slice(a, z), r.tags.slice(a, z), accept, { k0: (r.k0 || 0) + a }).eqYr
                    }
                }
            }
        }
        let vals = Array.from(acc, (v) => v / runs.length)
        vals.comp = { sigPerPick: nSlot > 0 ? nSig / nSlot : 0 }
        vals.thirds = wantThirds ? accT.map((x) => x.reduce((s, v) => s + v, 0) / Math.max(1, draws) / runs.length) : null
        if (accP) {
            vals.pnl = Float64Array.from(accP, (v) => v / runs.length)
        }
        return vals
    }

    //nullSideActOf, 組 = 方向(做多 0 / 做空 1)
    let sideGrp = null
    let nullSideActOf = (runs, accept, draws, seed, half = 50) => {
        if (!sideGrp) {
            sideGrp = new Int32Array(n)
            for (let s = 0; s < n; s++) {
                sideGrp[s] = L.mode[s] > 0 ? 0 : 1
            }
        }
        return nullGroupActOf(runs, accept, draws, seed, half, sideGrp, 2)
    }

    //sideGeoGroups, 組 = 方向 × 該側內依止盈升冪之 nTp 等分 × 該側內依止損升冪之 nSl 等分(同值依 tie; 兩個等分各自獨立劃分); 回 { grp, nGroups }
    //nullSideGeoOf, 同側同幾何同活躍度虛無(幾何對照): 選集之止盈 / 止損比全體寬或窄時, 只匹配方向 × 活躍度之替換排除不了「只是挑到某種幾何」
    let geoCache = new Map()
    let sideGeoGroups = (nTp = 3, nSl = 3) => {
        let ck = `${nTp}x${nSl}`
        if (geoCache.has(ck)) {
            return geoCache.get(ck)
        }
        let tq = new Int32Array(n)
        let sq = new Int32Array(n)
        let sides = [[], []]
        for (let s = 0; s < n; s++) {
            sides[L.mode[s] > 0 ? 0 : 1].push(s)
        }
        for (let side of sides) {
            let m = side.length
            //止盈 / 止損取帳本之欄(與 meta.tp / meta.sl 同值; 評估器內部不讀交出或給呼叫端之 meta)
            side.sort((a, b) => (L.tp[a] - L.tp[b]) || (tie[a] - tie[b]))
            for (let i = 0; i < m; i++) {
                tq[side[i]] = Math.min(nTp - 1, Math.floor((i * nTp) / m))
            }
            side.sort((a, b) => (L.sl[a] - L.sl[b]) || (tie[a] - tie[b]))
            for (let i = 0; i < m; i++) {
                sq[side[i]] = Math.min(nSl - 1, Math.floor((i * nSl) / m))
            }
        }
        let grp = new Int32Array(n)
        for (let s = 0; s < n; s++) {
            grp[s] = ((L.mode[s] > 0 ? 0 : 1) * nTp + tq[s]) * nSl + sq[s]
        }
        let out = { grp, nGroups: 2 * nTp * nSl }
        geoCache.set(ck, out)
        return out
    }
    let nullSideGeoOf = (runs, accept, draws, seed, half = 50, nTp = 3, nSl = 3) => {
        let g = sideGeoGroups(nTp, nSl)
        return nullGroupActOf(runs, accept, draws, seed, half, g.grp, g.nGroups)
    }

    //ordersOf, 下單集中度(一個相位): 由 col(見 simWindows)彙整後歸零
    //  strats 實際下單之不同策略數、combos 其不同因子組合數、barTop1Share 下單最多之前 1% 進場棒(以該相位之全部 K 棒數計)占全部下單之比例、perBarMax 單一進場棒之最多下單數
    let comboOf = null
    let nCombo = 0
    let ordersOf = (col, bars) => {
        if (!comboOf) {
            comboOf = new Int32Array(n)
            let ids = new Map()
            for (let s = 0; s < n; s++) {
                let key = Array.from(L.keyIdx.subarray(L.keyOff[s], L.keyOff[s + 1])).sort((a, b) => a - b).join(',')
                let id = ids.get(key)
                if (id === undefined) {
                    id = ids.size
                    ids.set(key, id)
                }
                comboOf[s] = id
            }
            nCombo = ids.size
        }
        let seen = new Uint8Array(nCombo)
        let strats = 0
        let combos = 0
        let nOrd = 0
        for (let s = 0; s < n; s++) {
            if (col.strat[s] > 0) {
                strats++
                nOrd += col.strat[s]
                if (!seen[comboOf[s]]) {
                    seen[comboOf[s]] = 1
                    combos++
                }
            }
        }
        col.strat.fill(0)
        let cnts = []
        let lo = bars.length ? bars[0] : 0
        let hi = bars.length ? Math.min(nBars + 1, bars[bars.length - 1] + cad) : 0
        for (let b = lo; b < hi; b++) {
            if (col.bar[b] > 0) {
                cnts.push(col.bar[b])
            }
        }
        col.bar.fill(0, lo, hi + 1)
        cnts.sort((a, b) => b - a)
        let top = Math.max(1, Math.ceil((hi - lo) * 0.01))
        let sTop = 0
        for (let i = 0; i < Math.min(top, cnts.length); i++) {
            sTop += cnts[i]
        }
        return { strats, combos, barTop1Share: nOrd > 0 ? sTop / nOrd : 0, perBarMax: cnts.length ? cnts[0] : 0 }
    }

    //compOf, 選集組成(各決策之選集合計): 每隻被選策略每個決策視窗之訊號數、做多比例、平均因子數、平均止盈 / 止損
    let compOf = (runs, ops) => {
        let nSlot = 0
        let nLong = 0
        let sKeys = 0
        let sTp = 0
        let sSl = 0
        for (let r of runs) {
            for (let sel of r.sels) {
                nSlot += sel.length
                for (let i = 0; i < sel.length; i++) {
                    let s = sel[i]
                    if (L.mode[s] > 0) {
                        nLong++
                    }
                    sKeys += L.nKeys[s]
                    sTp += L.tp[s]
                    sSl += L.sl[s]
                }
            }
        }
        let nSig = ops.reduce((a, o) => a + o.nSignals, 0)
        let d = (x) => (nSlot > 0 ? r4(x / nSlot) : 0)
        return { sigPerPick: d(nSig), longRatio: d(nLong), nKeysMean: d(sKeys), tpMean: d(sTp), slMean: d(sSl) }
    }

    //sizeDistOf, 各決策之選集大小之分佈與 tag 之決策比例(席次型 / 關側型機制之作用頻率可直接核對, 不必由平均值反推)
    //  sizeDist { p10, p50, p90 }、emptyRate(空選集之決策比例)、
    //  tags [{ tag(字串化, 至多 40 字), share }](依比例由高至低, **全部列出**; 逾 TAG_MAX(64)種者其餘併為末筆 { tag: '(其餘 N 種)', share, rest: true }; 全無 tag 則為空陣列)、
    //  tagKinds(相異 tag 之種數; 有 tag 才給)、
    //  tagStats { n, mean, p10, p50, p90 }(只在**全部** tag 皆為有限數值(數字, 或可解析為數字之字串)時給; 以決策為單位: n = 帶 tag 之決策數; 數值 tag 作診斷量時不必由所列之比例反推)
    //  只增輸出: 不影響選集、selHash 與任何績效數字
    let TAG_MAX = 64
    let sizeDistOf = (runs, sizes) => {
        let s = sizes.slice().sort((a, b) => a - b)
        let q = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0)
        let cnt = new Map()
        let nTag = 0
        let nums = []
        let allNum = true
        for (let r of runs) {
            for (let t of r.tags || []) {
                if (t === null || t === undefined) {
                    continue
                }
                let k = (typeof t === 'string' ? t : JSON.stringify(t)).slice(0, 40)
                cnt.set(k, (cnt.get(k) || 0) + 1)
                nTag++
                if (allNum) {
                    let v = typeof t === 'number' ? t : (typeof t === 'string' && t.trim() !== '' ? Number(t) : NaN)
                    if (Number.isFinite(v)) {
                        nums.push(v)
                    }
                    else {
                        allNum = false
                    }
                }
            }
        }
        let nDec = Math.max(1, sizes.length)
        let sorted = [...cnt.entries()].sort((a, b) => b[1] - a[1])
        let tags = sorted.slice(0, TAG_MAX).map(([tag, c]) => ({ tag, share: r4(c / nDec) }))
        if (sorted.length > TAG_MAX) {
            let rest = sorted.slice(TAG_MAX)
            tags.push({ tag: `(其餘 ${rest.length} 種)`, share: r4(rest.reduce((a, [, c]) => a + c, 0) / nDec), rest: true })
        }
        let out = { sizeDist: { p10: q(0.1), p50: q(0.5), p90: q(0.9) }, emptyRate: r4(sizes.filter((v) => v === 0).length / nDec), tags: nTag ? tags : [] }
        if (nTag) {
            out.tagKinds = sorted.length
            if (allNum && nums.length) {
                let a = nums.slice().sort((x, y) => x - y)
                let qa = (p) => r4(a[Math.min(a.length - 1, Math.floor(p * a.length))])
                out.tagStats = { n: a.length, mean: r4(a.reduce((x, y) => x + y, 0) / a.length), p10: qa(0.1), p50: qa(0.5), p90: qa(0.9) }
            }
        }
        return out
    }

    //evalPolicy, 評估一個挑選函數(與選配之 accept); opt: { accept, phases, horizons, nullDraws, seed, onRuns, fromBar, toBar }
    //  onRuns(runs)(選配): 取得各相位之逐決策選集 [{ phase, bars, sels, tags, k0 }](唯讀; 供呼叫端另算診斷, 例如與參考模組之重疊率; 不影響任何數字)
    //  fromBar / toBar(選配; **評估期間**): 挑選函數仍自帳本起點(暖機後之第一個決策)連續執行到帳本終點(ctx.state / ctx.prev 延續),
    //    但只有決策棒落在 [fromBar, toBar) 者計入績效、新鮮度、虛無與選集統計(持倉簿自 fromBar 起為空); 未給 = 全部決策
    //    切片帶 k0(其第一個決策於整段之決策序): accept 收到之 sig.k 與挑選函數之 ctx.k 一致
    let PRE_N = 26
    //  onRuns 為呼叫端(可信之程式, 例: 命令列之 --ref)之回調, 收到評估器所用之 runs 本身; 不得把它交給挑選模組或擴充診斷模組(其內不比對內建物件)
    let evalPolicy = (pickFn, opt = {}) => {
        //入口比對(規則 R-EV-35 ②): 其下之一般寫法(phases.map 等)須在比對之後才執行 —— 呼叫前之 await 期間模組之延後程式可能已改內建物件
        assertIntrinsics('pick')
        let t0 = Date.now()
        let accept = typeof opt.accept === 'function' ? opt.accept : null
        let phases = opt.phases || cfg.phases || [0, 1, 2, 3, 4, 5, 6]
        let horizons = opt.horizons || cfg.horizons || [1, 3, 7, 14, 30]
        let nullDraws = opt.nullDraws === undefined ? (cfg.nullDraws === undefined ? 64 : cfg.nullDraws) : opt.nullDraws
        let seed = opt.seed === undefined ? (cfg.seed === undefined ? 1 : cfg.seed) : opt.seed
        let fromBar = Number.isInteger(opt.fromBar) ? opt.fromBar : null
        let toBar = Number.isInteger(opt.toBar) ? opt.toBar : null
        let runs = phases.map((ph) => ({ phase: ph, ...runPick(pickFn, ph, seed), k0: 0 }))
        if (fromBar !== null || toBar !== null) {
            runs = runs.map((r) => {
                let a = fromBar === null ? 0 : r.bars.findIndex((b) => b >= fromBar)
                if (a < 0) {
                    a = r.bars.length
                }
                let z = toBar === null ? r.bars.length : r.bars.findIndex((b) => b >= toBar)
                if (z < 0) {
                    z = r.bars.length
                }
                z = Math.max(a, z)
                //pre: 評估期間以前最近 PRE_N 次決策之選集(只供擴充診斷之「較早之選集挪到較晚用」之延後型對照; 規則 R-EV-25); 不入任何既有數字
                let p0 = Math.max(0, a - PRE_N)
                return { phase: r.phase, bars: r.bars.slice(a, z), sels: r.sels.slice(a, z), tags: r.tags.slice(a, z), k0: a, pre: { bars: r.bars.slice(p0, a), sels: r.sels.slice(p0, a), tags: r.tags.slice(p0, a) } }
            })
            if (runs.every((r) => r.bars.length === 0)) {
                throw new Error('評估期間內沒有任何決策(帳本未涵蓋該期間?)')
            }
        }
        let tPick = Date.now()
        if (typeof opt.onRuns === 'function') {
            opt.onRuns(runs)
        }
        //操作績效; 同時收集下單集中度(各相位分別彙整後取平均; 不影響任何既有數字)
        let col = { strat: new Int32Array(n), bar: new Int32Array(nBars + 2), side: new Float64Array(8), tags: new Map(), grp: new Float64Array(N_GROUP * 4) }
        let ords = []
        let ops = runs.map((r) => {
            let o = opOf(r.sels, r.bars, r.tags, accept, { col, k0: r.k0 })
            ords.push(ordersOf(col, r.bars))
            return o
        })
        let fresh = {}
        for (let H of horizons) {
            let fs2 = runs.map((r) => freshOf(r.sels, r.bars, r.tags, accept, H, r.k0))
            fresh[H] = { eqYr: statOf(fs2.map((f) => f.eqYr)), posRate: r4(fs2.reduce((s, f) => s + f.posRate, 0) / fs2.length), nWindows: fs2.map((f) => f.nWindows), peakHold: Math.max(...fs2.map((f) => f.peakHold)) }
        }
        let sizes = runs.flatMap((r) => r.sels.map((s) => s.length))
        let jac = []
        for (let r of runs) {
            for (let k = 1; k < r.sels.length; k++) {
                jac.push(jaccard(r.sels[k - 1], r.sels[k]))
            }
        }
        let h = crypto.createHash('sha1')
        for (let i = 0; i < runs.length; i++) {
            let r = runs[i]
            h.update(`|p${r.phase}|o${ops[i].hash}|`)
            for (let sel of r.sels) {
                h.update(`${sel.length}:`)
                h.update(Buffer.from(sel.buffer, sel.byteOffset, sel.byteLength))
            }
        }
        let obs = ops.reduce((s, o) => s + o.eqYr, 0) / ops.length
        let nul = null
        let tNull0 = Date.now()
        if (nullDraws > 0) {
            let vals = nullOf(runs, accept, nullDraws, seed)
            let ge = vals.filter((v) => v >= obs).length
            let st = statOf(vals)
            let sorted = vals.slice().sort((a, b) => a - b)
            nul = { draws: nullDraws, mean: r4(st.mean), sd: r4(st.sd), p95: r4(sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))]), max: r4(st.max), p: r4((1 + ge) / (1 + nullDraws)), z: st.sd > 0 ? r4((obs - st.mean) / st.sd) : 0, excess: r4(obs - st.mean), sigPerPick: r4(vals.comp.sigPerPick), longRatio: r4(vals.comp.longRatio) }
        }
        //同訊號量虛無: 同劑量虛無只匹配選集之隻數; 選集之「每隻訊號數」偏離全體隨機逾 10% 時, 另以「隻數 × 訊號數之比」之隨機選集(訊號量相當)再算一組
        //  —— 訓練期之等效年化隨訊號量急升(席位未滿時多單即多損益), 不匹配訊號量會把「較活躍」誤當成挑選之內容
        let nulVol = null
        //同活躍度虛無(與同訊號量虛無同一觸發條件): 隨機選集之活躍度分層與成品相同(見 nullActOf)
        //  —— 同訊號量虛無之隨機選集是「隻數不同之一般項目」; 成品若只是挑得較安靜 / 較活躍, 其超額會留在同訊號量之比較內, 由本列扣除
        let nulAct = null
        if (nul && nul.sigPerPick > 0) {
            let selSig = ops.reduce((a, o) => a + o.nSignals, 0) / Math.max(1, sizes.reduce((a, v) => a + v, 0))
            let ratio = selSig / nul.sigPerPick
            if (Math.abs(ratio - 1) > 0.1) {
                let runs2 = runs.map((r) => ({ ...r, sels: r.sels.map((sel) => ({ length: Math.min(n, Math.max(sel.length > 0 ? 1 : 0, Math.round(sel.length * ratio))), src: sel })) }))
                let v2 = nullOf(runs2, accept, nullDraws, seed + 104729)
                let s2 = statOf(v2)
                let ge2 = v2.filter((v) => v >= obs).length
                nulVol = { draws: nullDraws, ratio: r4(ratio), sizeMean: r4(runs2.reduce((a, r) => a + r.sels.reduce((b, x) => b + x.length, 0), 0) / Math.max(1, sizes.length)), mean: r4(s2.mean), sd: r4(s2.sd), p: r4((1 + ge2) / (1 + nullDraws)), z: s2.sd > 0 ? r4((obs - s2.mean) / s2.sd) : 0, excess: r4(obs - s2.mean), sigPerPick: r4(v2.comp.sigPerPick) }
                let nBins = cfg.actBins === undefined ? 10 : cfg.actBins
                let v3 = nullActOf(runs, accept, nullDraws, seed + 1299709, nBins)
                let s3 = statOf(v3)
                let ge3 = v3.filter((v) => v >= obs).length
                nulAct = { draws: nullDraws, bins: nBins, mean: r4(s3.mean), sd: r4(s3.sd), p: r4((1 + ge3) / (1 + nullDraws)), z: s3.sd > 0 ? r4((obs - s3.mean) / s3.sd) : 0, excess: r4(obs - s3.mean), sigPerPick: r4(v3.comp.sigPerPick) }
            }
        }
        //同側同活躍度虛無(組成對照; 見 nullSideActOf)與同側同幾何同活躍度虛無(幾何對照; 見 nullSideGeoOf): 有算虛無時一律計算
        //  triggered: 選集之每隻訊號數或做多比例偏離全體隨機逾 10%(階梯 1 只在 triggered 時要求組成對照之 p; 幾何對照只增輸出、不入階梯)
        //  —— 方向、活躍度或幾何偏離時, 「組成」本身之績效會留在同劑量 / 同活躍度之超額內; 成品超出這兩列之部分才是同組成內之挑選內容
        //  —— 全體之每隻訊號數相近不等於逐隻之活躍度相近(例: 選集之均值與全體隨機相近, 其逐隻配對之替換版卻可明顯更活躍), 故不再只在偏離時才算
        //  thirdsMean: 各三等分段(同 op.thirds)內該虛無之均 —— 成品之超額是否只集中於某一段
        let nulSide = null
        let nulGeo = null
        if (nul && nul.sigPerPick > 0) {
            let nSlotSel = Math.max(1, sizes.reduce((a, v) => a + v, 0))
            let selSig = ops.reduce((a, o) => a + o.nSignals, 0) / nSlotSel
            let selLong = runs.reduce((a, r) => a + r.sels.reduce((b, sel) => {
                let c = 0; for (let i = 0; i < sel.length; i++) {
                    if (L.mode[sel[i]] > 0) {
                        c++
                    }
                } return b + c
            }, 0), 0) / nSlotSel
            let devSig = Math.abs(selSig / nul.sigPerPick - 1) > 0.1
            let devLong = nul.longRatio > 0 && Math.abs(selLong / nul.longRatio - 1) > 0.1
            let half = cfg.sideActHalf === undefined ? 50 : cfg.sideActHalf
            //share: 組成可重現之比例 = 該虛無之均 ÷ 成品之等效年化(成品為正時才有意義, 否則為 null; 虛無之均為負 = 組成是逆風, 記 0)
            let pack = (v) => {
                let s = statOf(v)
                let ge = v.filter((x) => x >= obs).length
                return { draws: nullDraws, half, mean: r4(s.mean), sd: r4(s.sd), p: r4((1 + ge) / (1 + nullDraws)), z: s.sd > 0 ? r4((obs - s.mean) / s.sd) : 0, excess: r4(obs - s.mean), sigPerPick: r4(v.comp.sigPerPick), share: obs > 0 ? r4(Math.max(0, s.mean) / obs) : null, ...(v.thirds ? { thirdsMean: v.thirds.map(r4) } : {}) }
            }
            nulSide = { ...pack(nullSideActOf(runs, accept, nullDraws, seed + 2750159, half)), triggered: devSig || devLong }
            let nTp = cfg.geoTp === undefined ? 3 : cfg.geoTp
            let nSl = cfg.geoSl === undefined ? 3 : cfg.geoSl
            nulGeo = { ...pack(nullSideGeoOf(runs, accept, nullDraws, seed + 6700417, half, nTp, nSl)), nTp, nSl }
        }
        //評估期間三等分(依決策序; 各段自空倉起算、各自計等效年化): 績效是否集中於某一段; 有算虛無時另給各段之隨機挑(至多 16 抽)之均
        let thirds = []
        if (runs.every((r) => r.bars.length >= 6)) {
            for (let g = 0; g < 3; g++) {
                let parts = runs.map((r) => {
                    let nd = r.bars.length
                    let a = Math.floor(nd * g / 3)
                    let z = Math.floor(nd * (g + 1) / 3)
                    return { phase: r.phase, bars: r.bars.slice(a, z), sels: r.sels.slice(a, z), tags: r.tags.slice(a, z), k0: r.k0 + a }
                })
                let sg = statOf(parts.map((r) => opOf(r.sels, r.bars, r.tags, accept, { k0: r.k0 }).eqYr))
                let seg = { from: timeOf(Math.min(...parts.map((r) => r.bars[0]))), to: timeOf(Math.max(...parts.map((r) => r.bars[r.bars.length - 1] + cad))), eqYr: { mean: r4(sg.mean), min: r4(sg.min), max: r4(sg.max) } }
                if (nullDraws > 0) {
                    seg.nullMean = r4(statOf(nullOf(parts, accept, Math.min(16, nullDraws), seed + 15485863 + g)).mean)
                }
                thirds.push(seg)
            }
        }
        //擴充診斷(opt.ext = [{ name, fn }]; 由呼叫端自共用工具區之 metrics/ 載入; 規則 R-EV-21): 每個 fn(api) 回一個可序列化之物件(建議含 text: 一行說明)
        //  api 全為唯讀之複本與函數 —— 擴充診斷拿不到帳本、也改不了 S、階梯、selHash 與任何既有欄; 單一診斷拋錯或輸出過大只記 error, 不影響評估
        //    n、meta、nullDraws、phases[{ phase, bars, sels, tags }](成品之逐決策選集之複本)、obs{ mean, byPhase, thirds }
        //    simulate(selsByPhase, tagsByPhase?, opts?) → { mean, byPhase, thirds, bySide, byGroup }: 以成品之執行規則重放另一組選集(各相位之決策數須與成品相同)
        //      opts.orderSalt(選配; 整數; 規則 R-EV-32): 只換「同一進場棒之多個訊號之先後」之次序(見 ordTieOf); 0 或未給 = 成品本身之次序
        //        選集、ctx.meta.tie 與執行規則皆不變 —— 量「持倉上限擋單時誰先得席位」對績效之影響(下單率低之成品其 S 之雜訊帶寬); 無執行規則(全收)者不受影響
        //      byGroup[{ group, seats, orders, pnl, winRate }]: 該次重放依子帳之席數、下單數與損益(定義同 metrics.op.byGroup; 規則 R-EV-33)
        //      opts.accept(選配; 規則 R-EV-28): 以傳入之 (sig, book) => 布林 取代成品之執行規則重放 —— 依持倉簿狀態之執行規則(E 層)
        //        其「同選集、換執行規則」之配對(中性、同比例隨機放行之安慰劑)可寫成擴充診斷; 未給 = 成品之執行規則(行為不變)
        //      bySide{ long, short }{ orders, pnl, winRate }: 該次重放之兩側下單數與損益(各相位平均; 同 metrics.op.bySide 之定義)
        //    replaceNull({ grp?, nGroups?, actDays?, half?, draws?, onlyGroups?, onlyDecisions? }) → { draws, mean, sd, p, z, excess, thirdsMean }: 配對隨機替換(組預設 = 方向; 活躍度預設 = 累計進場數, actDays > 0 改為近期)
        //      只替換一部分之席(選配; 規則 R-EV-38; 兩者可並用; null / undefined 視同未給; 皆未給時行為與回傳逐位不變):
        //        onlyGroups: [g…](子帳 0 ~ 3; 見 phases[].groups; 元素依 iseint): 只把所列子帳之席做配對隨機替換, 其餘席原樣(未分帳之決策其席皆屬子帳 0)
        //          —— 合成內每條線之挑選內容 = 成品 − 只換該線之均; 成品未分帳者回 { applicable: false, reason }(不重放、不拋錯)
        //        onlyDecisions: [各相位一個布林陣列](相位數與各相位之決策數同成品; 元素為布林或 0 / 1): 只換遮罩內之決策之席, 遮罩外之決策給空選集
        //          —— 配對之成品值改為「成品只留遮罩內決策」之重放(依市況或任何狀態分組之組成對照; 活躍度為決策當下之值)
        //        給任一者時回傳另帶 applicable: true、obs(配對之成品值; 等效年化之相位平均; p / z / excess 皆對它算)、
        //          obsPnl / pnlMean / pnlSd(成品與各抽之損益和; 每單 1 單位、已結之單、各相位平均; 不受峰值持倉之正規化, 但各遮罩為獨立重放〔持倉簿各自起算、抽樣各自獨立〕, 跨遮罩相加不保證等於全體, 執行規則依持倉簿狀態時尤然)
        //          某一個為全部(所列子帳涵蓋成品之全部子帳、或遮罩全為真)時等同只給另一個; 兩者皆為全部(或另一個未給)時, 各抽之選集與既有欄與未給時逐位相同
        //          成品未分帳而給 onlyGroups 者只回 { applicable: false, reason }(不帶其餘新欄); 鄰域內無未用之策略時該席從缺(同既有寫法)
        //        參數不合者拋錯, 訊息依跨套件規格 V19、V20: invalid opt.onlyGroups(或 onlyDecisions, 帶索引時 [i] / [i][k]): must be …(不帶輸入值)
        //    sideGroups()、geoGroups(nTp, nSl) → { grp, nGroups }; summarize(vals) → 同上之統計; rand(k) → 亂數產生器(與成品、既有虛無之亂數互不相干)
        //    market(bar, nBack?)、factor(ki, bar, nBack?)、series(name, bar, nBack?)(規則 R-EV-36): 棒序 < bar 之最近 nBack 根之 K 線 / 因子 / 外部序列之值(複本; 由舊至新; nBack 預設 180)
        //      取值與 ctx.market / ctx.factor / ctx.series 於決策棒 bar 之呼叫逐位相同(同一份實作); bar 須為 0 ~ K 棒數之整數(否則拋錯; 訊息不帶輸入值), 名稱見 meta.keyNames / meta.seriesNames
        //      用途: 依「各決策之決策棒以前之行情 / 因子 / 外部序列狀態」把成品之選集分組後以 simulate 重放(各狀態之獨立重放: 持倉簿各自起算, 不保證相加為成品之損益, 執行規則依持倉簿狀態時尤然)
        //      擴充診斷於評估完成後才執行, 介面無從得知呼叫端拿某棒之值去為哪一次決策分組 —— 為某次決策分組時, bar 須用該決策自己之決策棒(phases[].bars)或更早者;
        //        用較晚之棒 = 把較晚之資訊挪到較早之決策(前視), 與「不得把較晚做出之選集挪到較早之決策使用」同一條(只寫於合約, 不以程式強制; 同 pre)
        let ext = null
        if (Array.isArray(opt.ext) && opt.ext.length) {
            ext = {}
            let obsThirds = thirds.map((g) => g.eqYr.mean)
            //內建物件之完整性(規則 R-EV-35 ②): 擴充診斷之程式於 fn(api) 期間執行, 並可呼叫 api 之函數
            //  ⇒ api 之各函數先只以擷取之參照把參數讀成評估器自有之資料, 再比對(guardExt), 通過才以一般寫法計算; 每個診斷呼叫後亦比對
            //  一經偵測即記於 tripped: 診斷攔下錯誤而回傳者, 該次評估仍失敗(不因其攔錯或改回而放行)
            let tripped = null
            let guardExt = (where) => {
                if (tripped) {
                    throw tripped
                }
                try {
                    assertIntrinsics(where)
                }
                catch (err) {
                    tripped = err
                    throw err
                }
            }
            //apiFn, 包裝 api 之函數: 其內(含以 accept 重放之逐訊號模擬)偵測到之完整性錯誤一律記於 tripped
            //  apiOf 對每個診斷各包一次並凍結(函數物件不共用: 一個診斷於函數物件上掛屬性、改 call 等, 不影響其他診斷); 其下之實作(下列各函數)為各診斷共用之內部函數, 不外露
            let apiFn = (fn) => (...args) => {
                try {
                    return ReflectApply(fn, undefined, args)
                }
                catch (err) {
                    if (isIntegrityError(err) && !tripped) {
                        tripped = err
                    }
                    throw err
                }
            }
            //prim, 參數之原始值(物件以 Number() 取值; 此段可能執行模組之 valueOf, 故只在讀取參數之段使用)
            let prim = (v) => (v !== null && (typeof v === 'object' || typeof v === 'function') ? NumberCtor(v) : v)
            //summarizeOf, 各抽之統計; ob(選配)= 配對之成品值(預設 = 成品之相位平均 obs; replaceNull 給 onlyDecisions 時為成品於同一遮罩下之重放)
            let summarizeOf = (v, th, ob = obs) => {
                let s = statOf(v)
                let ge = v.filter((x) => x >= ob).length
                return { draws: v.length, mean: r4(s.mean), sd: r4(s.sd), p: r4((1 + ge) / (1 + v.length)), z: s.sd > 0 ? r4((ob - s.mean) / s.sd) : 0, excess: r4(ob - s.mean), ...(th ? { thirdsMean: th.map(r4) } : {}) }
            }
            let summarize = (v) => {
                let a = ArrayFrom(v, prim)
                let th0 = v.thirds
                let th = th0 ? ArrayFrom(th0, prim) : null
                guardExt('ext')
                return summarizeOf(a, th)
            }
            let simScratch = null
            let simulate = (selsByPhase, tagsByPhase = null, sOpt = null) => {
                //第一段: 讀參數(只用擷取之參照); 檢查之先後與錯誤訊息同原寫法
                if (!ArrayIsArray(selsByPhase) || selsByPhase.length !== runs.length) {
                    throw new ErrorCtor('simulate: 須給與成品相同相位數之選集陣列')
                }
                let acc = accept
                let oAccept = sOpt !== null && sOpt !== undefined ? sOpt.accept : undefined
                if (oAccept !== undefined && oAccept !== null) {
                    if (typeof oAccept !== 'function') {
                        throw new ErrorCtor('simulate: opts.accept 須為函數 (sig, book) => 布林')
                    }
                    acc = oAccept
                }
                let oSalt = sOpt !== null && sOpt !== undefined ? sOpt.orderSalt : undefined
                let salt = null
                if (oSalt !== undefined && oSalt !== null) {
                    if (!NumberIsInteger(oSalt)) {
                        throw new ErrorCtor('simulate: opts.orderSalt 須為整數(0 = 成品本身之次序)')
                    }
                    salt = oSalt
                }
                let pxsAll = []
                let tgsAll = []
                for (let i = 0; i < runs.length; i++) {
                    let ph = selsByPhase[i]
                    if (!ArrayIsArray(ph) || ph.length !== runs[i].bars.length) {
                        throw new ErrorCtor('simulate: 各相位之決策數須與成品相同')
                    }
                    //內部陣列以 pushOwn 定義自有元素(push 之 [[Set]] 會觸發原型上同名索引之 setter)
                    pushOwn(pxsAll, ArrayFrom(ph, (x) => pickOutOf(x)))
                    let tp = tagsByPhase ? tagsByPhase[i] : undefined
                    pushOwn(tgsAll, tagsByPhase && ArrayIsArray(tp) ? ArrayFrom(tp, (t) => snapTag(t)) : null)
                }
                guardExt('ext')
                //第二段: 已比對內建物件
                let ordKey = salt === null || salt === 0 ? null : ordTieOf(salt)
                //兩側與子帳歸因: strat / bar 為 simWindows 計數用之暫存(內容不取用), side / grp 於本次重放之各相位累加
                if (!simScratch) {
                    simScratch = { strat: new Int32Array(n), bar: new Int32Array(nBars + 2) }
                }
                let sc = { strat: simScratch.strat, bar: simScratch.bar, side: new Float64Array(8), tags: new Map(), grp: new Float64Array(N_GROUP * 4) }
                let ssAll = []
                let os = runs.map((r, i) => {
                    //分帳: 元素為 { ids, group } 者**一律照用其 group(含全為 0 = 全部歸子帳 0)**; 未給 group 者才依席次序沿用成品同一決策之分帳(成品未分帳則無)
                    //  (規則 R-EV-27: 原以「group 全為 0 ⇒ 視為未給」而改套成品之分帳 ⇒ 只留子帳 0 之席單獨重放時, 各席被依席次序套上成品之分帳、上限錯用, 寫不成逐帳歸因之擴充診斷)
                    let ss = pxsAll[i].map((px, k) => {
                        let o = normSel(px); return o.grp || px.explicitGroup ? o.sel : inheritGroups(r.sels[k], o.sel)
                    })
                    let tg = tgsAll[i] || r.tags
                    let nd = r.bars.length
                    let t3 = nd >= 6
                        ? [0, 1, 2].map((g) => {
                            let a = Math.floor(nd * g / 3); let z = Math.floor(nd * (g + 1) / 3); return opOf(ss.slice(a, z), r.bars.slice(a, z), tg.slice(a, z), acc, { k0: r.k0 + a, ordKey }).eqYr
                        })
                        : null
                    ssAll.push(ss)
                    return { eqYr: opOf(ss, r.bars, tg, acc, { k0: r.k0, col: sc, ordKey }).eqYr, t3 }
                })
                let byPhase = os.map((o) => o.eqYr)
                let nP = Math.max(1, os.length)
                let sideOf = (o) => ({ orders: r4(sc.side[o] / nP), pnl: r4(sc.side[o + 1] / nP), winRate: sc.side[o + 2] > 0 ? r4(sc.side[o + 3] / sc.side[o + 2]) : 0 })
                return { mean: byPhase.reduce((a, v) => a + v, 0) / byPhase.length, byPhase, thirds: os.every((o) => o.t3) ? [0, 1, 2].map((g) => os.reduce((a, o) => a + o.t3[g], 0) / os.length) : null, bySide: { long: sideOf(0), short: sideOf(4) }, byGroup: groupRowsOf(sc.grp, ssAll, nP) }
            }
            //listOf, 把模組傳入之陣列複製成評估器自有之陣列(規則 R-EV-38): 只用擷取之參照、不經迭代器(Array.from 會動態查找 Array.prototype[Symbol.iterator] 等可被改寫之方法)
            //  Array 讀其 length 與各自有之索引(元素不取值; 洞不沿原型鏈取值 —— Array.prototype / Object.prototype 上之索引存取子不被觸發; 自有存取子與代理之攔截函式於此段執行, 同選項之 getter);
            //  定型陣列以內部槽判定(排除 DataView 與偽造之類陣列物件; 已分離者長度為 0); maxLen(≥ 0 時)為長度上限 —— 超過者不複製(形狀錯誤之超長輸入不逐索引讀取)
            //  非陣列、length 非非負整數、超過上限、或讀取拋錯(已撤銷之代理、拋錯之存取子; 跨套件規格 V11: 讀取拋錯即無效)⇒ null
            let listOf = (v, maxLen = -1, arrayOnly = false) => {
                try {
                    let isTa = TypedArrayPrototypeGetToStringTag(v) !== undefined
                    if ((isTa && arrayOnly) || (!isTa && !ArrayIsArray(v))) {
                        return null
                    }
                    let len = isTa ? TypedArrayPrototypeGetLength(v) : v.length
                    if (!NumberIsInteger(len) || len < 0 || (maxLen >= 0 && len > maxLen)) {
                        return null
                    }
                    let out = []
                    for (let i = 0; i < len; i++) {
                        pushOwn(out, isTa || ObjectHasOwn(v, i) ? v[i] : undefined)
                    }
                    return out
                }
                catch (err) {
                    return null
                }
            }
            //readOpt, 讀選項之鍵; 讀取拋錯(存取子)⇒ 回一個非陣列之哨兵(其後之 listOf 視為形狀不合 ⇒ 比對之後拋 invalid, 不直接透傳)
            let READ_ERR = ObjectFreeze({})
            let readOpt = (o, key) => {
                try {
                    return o[key]
                }
                catch (err) {
                    return READ_ERR
                }
            }
            let replaceNull = (o = {}) => {
                //第一段: 讀參數(各欄只讀一次; 其後之判斷皆先以 Number.isInteger / isFinite 篩選, 不對物件取值)
                let oGrp = o.grp
                let grp = oGrp ? TypedArrayFrom(Int32ArrayCtor, oGrp) : null
                let nGroups = oGrp ? o.nGroups : 2
                let oDraws = o.draws
                let oHalf = o.half
                let oAct = o.actDays
                //onlyGroups / onlyDecisions(規則 R-EV-38): 此段只以擷取之參照(listOf: 不經迭代器)複製成評估器自有之陣列(元素不取值; 形狀不合者記為 false / null, 於比對之後才拋錯)
                let oOnlyG = readOpt(o, 'onlyGroups')
                let onlyG = oOnlyG === undefined || oOnlyG === null ? null : (listOf(oOnlyG) || false)
                let oOnlyD = readOpt(o, 'onlyDecisions')
                let onlyD = null
                if (oOnlyD !== undefined && oOnlyD !== null) {
                    onlyD = false
                    //外層只收 Array(各相位一個陣列); 各相位之陣列可為 Array 或定型陣列(長度超過該相位之決策數者不複製)
                    let outer = listOf(oOnlyD, runs.length, true)
                    if (outer !== null && outer.length === runs.length) {
                        onlyD = []
                        for (let i = 0; i < runs.length; i++) {
                            pushOwn(onlyD, listOf(outer[i], runs[i].bars.length))
                        }
                    }
                }
                guardExt('ext')
                let g = grp ? { grp, nGroups } : { grp: (nullSideActOf([], null, 0, 0), sideGrp), nGroups: 2 }
                if (g.grp.length !== n || !Number.isInteger(g.nGroups) || g.nGroups < 1 || g.grp.some((x) => x < 0 || x >= g.nGroups)) {
                    throw new Error('replaceNull: grp 須為長度 n、值在 0 ~ nGroups-1 之陣列')
                }
                //只替換一部分之席: 形狀之檢查先於「未分帳」之判定; 訊息依跨套件規格〈輸入參數之檢測機制〉§6 V19(invalid <名稱>: must be <描述>)、V20(不帶輸入值; 只帶位置與期望)
                //  onlyGroups: 非空之陣列或定型陣列, 元素為 0 ~ N_GROUP-1 之整數(wsemi iseint: 安全整數之數字或其數字字串; 通過者以 Number 轉為數字); 未列之子帳之席原樣
                //  onlyDecisions: 各相位一個陣列或定型陣列(與該相位之決策數等長), 元素為布林或 0 / 1(只此四值; 不互轉他種真假值); 遮罩外之決策給空選集
                let subMask = null
                if (onlyG !== null) {
                    if (onlyG === false || onlyG.length === 0) {
                        throw new Error(`invalid opt.onlyGroups: must be a non-empty array or typed array of integers from 0 to ${N_GROUP - 1}`)
                    }
                    subMask = new Uint8Array(N_GROUP)
                    for (let j = 0; j < onlyG.length; j++) {
                        let sg = iseint(onlyG[j]) ? NumberCtor(onlyG[j]) : NaN
                        if (!(sg >= 0 && sg < N_GROUP)) {
                            throw new Error(`invalid opt.onlyGroups[${j}]: must be an integer from 0 to ${N_GROUP - 1}`)
                        }
                        subMask[sg] = 1
                    }
                }
                let decMask = null
                if (onlyD !== null) {
                    if (onlyD === false) {
                        throw new Error('invalid opt.onlyDecisions: must be an array with one array or typed array per phase of phases[]')
                    }
                    decMask = []
                    for (let i = 0; i < runs.length; i++) {
                        let ph = onlyD[i]
                        let nd = runs[i].bars.length
                        if (ph === null || ph.length !== nd) {
                            throw new Error(`invalid opt.onlyDecisions[${i}]: must be an array or typed array with one entry per decision of phases[${i}]`)
                        }
                        let mk = new Uint8Array(nd)
                        for (let k = 0; k < nd; k++) {
                            let x = ph[k]
                            if (x === true || x === 1) {
                                mk[k] = 1
                            }
                            else if (x !== false && x !== 0) {
                                throw new Error(`invalid opt.onlyDecisions[${i}][${k}]: must be a boolean or 0 or 1`)
                            }
                        }
                        pushOwn(decMask, mk)
                    }
                }
                if (subMask !== null && !runs.some((r) => r.sels.some((s) => grpOf.has(s)))) {
                    //成品未分帳(pick 未回傳非 0 之 group): 無子帳可指定 ⇒ 不適用(不拋錯: 同一個診斷可套於全部成品; 不重放)
                    //  於執行規則(accept)之內呼叫者仍依合約拋重入之錯誤(不因短路而放行)
                    if (inSim) {
                        throw new Error(REENTRY_MSG)
                    }
                    return { applicable: false, reason: '成品未分帳(pick 未回傳 group): onlyGroups 不適用' }
                }
                let more = subMask !== null || decMask !== null ? { subMask, decMask } : null
                let d = Number.isInteger(oDraws) && oDraws > 0 ? Math.min(oDraws, 64) : Math.max(1, Math.min(64, nullDraws || 16))
                let v = nullGroupActOf(runs, accept, d, seed + 49979687, Number.isInteger(oHalf) && oHalf >= 0 ? oHalf : 50, g.grp, g.nGroups, oAct || 0, more)
                if (!more) {
                    return summarizeOf(Array.from(v), v.thirds)
                }
                //給任一者: 另帶配對之成品值 obs(未給 onlyDecisions = 成品本身之 obs, 逐位相同; 給者 = 成品只留遮罩內決策之重放)與損益(每單 1 單位; 已結之單; 各相位平均)
                //  obsPnl = 成品, pnlMean / pnlSd = 各抽之均與標準差 —— 各遮罩為獨立重放(持倉簿各自起算、抽樣各自獨立), 損益與等效年化(以各自之峰值持倉正規化)皆不保證可跨遮罩相加
                let ob = obs
                let obP = 0
                if (decMask === null) {
                    for (let i = 0; i < runs.length; i++) {
                        obP += ops[i].totalPnl
                    }
                }
                else {
                    ob = 0
                    let EMPTY = new Int32Array(0)
                    for (let i = 0; i < runs.length; i++) {
                        let r = runs[i]
                        let ss = r.sels.map((s, k) => (decMask[i][k] ? s : EMPTY))
                        let oo = opOf(ss, r.bars, r.tags, accept, r.k0 ? { k0: r.k0 } : null)
                        ob += oo.eqYr
                        obP += oo.totalPnl
                    }
                    ob /= runs.length
                }
                obP /= runs.length
                let sp = statOf(Array.from(v.pnl))
                return { ...summarizeOf(Array.from(v), v.thirds, ob), applicable: true, obs: ob, obsPnl: r4(obP), pnlMean: r4(sp.mean), pnlSd: r4(sp.sd) }
            }
            let sideGroups = () => {
                guardExt('ext')
                nullSideActOf([], null, 0, 0)
                return { grp: Int32Array.from(sideGrp), nGroups: 2 }
            }
            let geoGroups = (nTp = 3, nSl = 3) => {
                let a = prim(nTp)
                let z = prim(nSl)
                guardExt('ext')
                let g = sideGeoGroups(a, z)
                return { grp: Int32Array.from(g.grp), nGroups: g.nGroups }
            }
            //資料存取(規則 R-EV-36): market(bar, nBack)、factor(ki, bar, nBack)、series(name, bar, nBack) —— 棒序 < bar 之最近 nBack 根之值(複本), 取值與 ctx 之同名介面共用同一份實作(marketAt / factorAt / seriesAt)
            //  同 simulate 等需比對之 api 函數: 以 apiFn 包裝, 入口先比對內建物件(guardExt), 其下之一般寫法(含 wsemi 之 iseint)於比對之後才執行; 參數不經物件取值(iseint 對物件不呼叫任何方法; ki 以 Number.isInteger、name 以 Map 之查找、nBack 同 ctx 之慣例)
            //  檢查依參數位置之先後(ki / name, 再 bar); 錯誤訊息不帶輸入值(跨套件規格〈輸入參數之檢測機制〉§6 V20): 指明介面、參數名與期望(bar 之上限 = 帳本之 K 棒數, 即可取到帳本之末棒)
            //  bar 之判定為 iseint(安全整數之數字或其數字字串; 通過者以 Number 轉為數字): 0 ~ nBars(-0 與 0 之取值相同)
            //  擴充診斷於評估完成後才執行, 此處無從得知呼叫端拿某棒之值去為哪一次決策分組 ⇒ 「為某次決策分組須用該決策自己之決策棒或更早者」只寫於合約(§7), 不以程式強制(同 pre 之不得反向使用)
            let barOf = (fnName, bar) => {
                let v = iseint(bar) ? NumberCtor(bar) : NaN
                if (!(v >= 0 && v <= nBars)) {
                    throw new ErrorCtor(`api.${fnName}: bar 須為 0 ~ ${nBars} 之整數`)
                }
                return v
            }
            //  api 之九個函數(simulate、summarize、replaceNull、sideGroups、geoGroups、rand 與此三個)皆於 apiOf 內以 apiFn 另包並凍結(每個診斷各一份函數物件: 一個診斷於函數物件上掛屬性、改 call 等, 不影響其他診斷)
            let dataMarket = (bar, nBack = 180) => {
                guardExt('ext')
                return marketAt(barOf('market', bar), nBack, 'api.market')
            }
            let dataFactor = (ki, bar, nBack = 180) => {
                guardExt('ext')
                if (!kiOk(ki)) {
                    throw new ErrorCtor(nFac > 0 ? `api.factor: ki 須為 0 ~ ${nFac - 1} 之整數(meta.keyNames 之序號)` : 'api.factor: 帳本無因子(meta.keyNames 為空)')
                }
                return factorAt(ki, barOf('factor', bar), nBack, 'api.factor')
            }
            let dataSeries = (name, bar, nBack = 180) => {
                guardExt('ext')
                let si = MapPrototypeGet(serIdx, name)
                if (si === undefined) {
                    throw new ErrorCtor(`api.series: name 須為 meta.seriesNames 之一(可用: ${serAvail()})`)
                }
                return seriesAt(si, barOf('series', bar), nBack, 'api.series')
            }
            let rand = (k = 0) => mulberry32(seed + 32452843 + (NumberIsInteger(k) ? k : 0) * 7919)
            //apiOf, 每個擴充診斷各給一份 api(規則 R-EV-35 ①: meta 與各相位之選集 / tag 皆為該診斷自己之複本; 一個診斷改它, 不影響其他診斷)
            let apiOf = () => Object.freeze({
                n,
                meta: metaFor(),
                nullDraws,
                phases: Object.freeze(runs.map((r) => Object.freeze({
                    phase: r.phase,
                    bars: Array.from(r.bars),
                    sels: r.sels.map((s) => Int32Array.from(s)),
                    tags: r.tags.map(handOut),
                    groups: r.sels.map((s) => {
                        let g = grpOf.get(s); return g ? Uint8Array.from(g) : null
                    }),
                    //pre: 同一相位於評估期間以前最近 26 次決策之選集(由舊至新; 唯讀複本); 只可用於「較早之選集挪到較晚用」之延後型對照(不得反向使用: 那是前視)
                    pre: Object.freeze(r.pre
                        ? {
                            bars: Array.from(r.pre.bars),
                            sels: r.pre.sels.map((s) => Int32Array.from(s)),
                            tags: r.pre.tags.map(handOut),
                            groups: r.pre.sels.map((s) => {
                                let g = grpOf.get(s); return g ? Uint8Array.from(g) : null
                            })
                        }
                        : { bars: [], sels: [], tags: [], groups: [] })
                }))),
                obs: Object.freeze({ mean: obs, byPhase: ops.map((o) => o.eqYr), thirds: obsThirds.slice() }),
                simulate: ObjectFreeze(apiFn(simulate)),
                summarize: ObjectFreeze(apiFn(summarize)),
                replaceNull: ObjectFreeze(apiFn(replaceNull)),
                sideGroups: ObjectFreeze(apiFn(sideGroups)),
                geoGroups: ObjectFreeze(apiFn(geoGroups)),
                market: ObjectFreeze(apiFn(dataMarket)),
                factor: ObjectFreeze(apiFn(dataFactor)),
                series: ObjectFreeze(apiFn(dataSeries)),
                rand: ObjectFreeze(apiFn(rand)),
            })
            for (let x of opt.ext) {
                let te = Date.now()
                let api = apiOf()
                let mkE = violationMark()
                //第一段: 呼叫診斷並序列化其輸出(序列化可能執行模組之 toJSON / 存取子; 只用擷取之參照)
                let js
                let errText = null
                try {
                    let out = x.fn(api)
                    js = JSONStringify(out === undefined ? null : out)
                }
                catch (err) {
                    try {
                        errText = StringCtor((err && err.message) || err)
                    }
                    catch (err2) {
                        errText = '(無法讀取之錯誤)'
                    }
                }
                guardExt('ext')
                let vioE = violationSince(mkE)
                if (vioE) {
                    tripped = vioE
                    throw vioE
                }
                //第二段: 已比對內建物件
                if (errText !== null) {
                    ext[x.name] = { error: errText.split('\n')[0].slice(0, 300), ms: Date.now() - te }
                    continue
                }
                try {
                    if (js.length > 20000) {
                        throw new Error(`輸出 ${js.length} 字元,超過上限 20000`)
                    }
                    let o2 = JSON.parse(js)
                    ext[x.name] = o2 && typeof o2 === 'object' && !Array.isArray(o2) ? { ...o2, ms: Date.now() - te } : { value: o2, ms: Date.now() - te }
                }
                catch (err) {
                    ext[x.name] = { error: String((err && err.message) || err).split('\n')[0].slice(0, 300), ms: Date.now() - te }
                }
            }
        }
        let tEnd = Date.now()
        let rr = (o) => ({ mean: r4(o.mean), min: r4(o.min), max: r4(o.max), sd: r4(o.sd), byPhase: o.byPhase.map(r4) })
        let freshOut = {}
        for (let H of horizons) {
            freshOut[H] = { eqYr: rr(fresh[H].eqYr), posRate: fresh[H].posRate, peakHold: fresh[H].peakHold, nWindows: fresh[H].nWindows }
        }
        let nSig = ops.reduce((s, o) => s + o.nSignals, 0)
        let nOrd = ops.reduce((s, o) => s + o.nOrders, 0)
        //損益歸因(各相位平均; 只增輸出): 依策略之方向(bySide)、所屬之子帳(byGroup)與其決策視窗之 tag(tagPerf); 兩側之 pnl 和 = 各子帳之 pnl 和 = 各 tag 之 pnl 和(每個決策皆有 tag 時)= op.pnl
        let nPh = Math.max(1, ops.length)
        let sideOut = (o) => ({ orders: r4(col.side[o] / nPh), pnl: r4(col.side[o + 1] / nPh), winRate: col.side[o + 2] > 0 ? r4(col.side[o + 3] / col.side[o + 2]) : 0 })
        let tagDec = new Map()
        for (let r of runs) {
            for (let t of r.tags || []) {
                let tk = tagKeyOf(t)
                if (tk !== null) {
                    tagDec.set(tk, (tagDec.get(tk) || 0) + 1)
                }
            }
        }
        let tagPerf = [...tagDec].sort((a, b) => b[1] - a[1]).map(([tag, c]) => {
            let a = col.tags.get(tag) || { orders: 0, pnl: 0 }
            return { tag, decisions: r4(c / nPh), orders: r4(a.orders / nPh), pnl: r4(a.pnl / nPh), pnlPerOrder: a.orders > 0 ? r4(a.pnl / a.orders) : 0 }
        })
        if (tagPerf.length > TAG_MAX) {
            let rest = tagPerf.slice(TAG_MAX)
            let ro = rest.reduce((s, x) => s + x.orders, 0)
            let rp = rest.reduce((s, x) => s + x.pnl, 0)
            tagPerf = [...tagPerf.slice(0, TAG_MAX), { tag: `(其餘 ${rest.length} 種)`, decisions: r4(rest.reduce((s, x) => s + x.decisions, 0)), orders: r4(ro), pnl: r4(rp), pnlPerOrder: ro > 0 ? r4(rp / ro) : 0, rest: true }]
        }
        return {
            version: 2,
            ledgerKey: L.meta.key,
            period: { time0: L.meta.time0, endTime: L.meta.endTime, firstDecision: timeOf(warm), warmupDays, cadenceDays, evalFrom: fromBar === null ? null : timeOf(fromBar), evalTo: toBar === null ? null : timeOf(toBar), firstEvalDecision: runs.length && runs[0].bars.length ? timeOf(runs[0].bars[0]) : null },
            phases,
            horizons,
            hasAccept: !!accept,
            op: {
                eqYr: rr(statOf(ops.map((o) => o.eqYr))),
                monthlyOrders: rr(statOf(ops.map((o) => o.monthlyOrders))),
                peakHold: rr(statOf(ops.map((o) => o.peakHold))),
                winRate: r4(ops.reduce((s, o) => s + o.winRate, 0) / ops.length),
                acceptRate: nSig > 0 ? r4(nOrd / nSig) : 0,
                nSignals: ops.map((o) => o.nSignals),
                nOrders: ops.map((o) => o.nOrders),
                nUnsettled: ops.map((o) => o.nUnsettled),
                nDecisions: ops.map((o) => o.nDecisions),
                pnl: r4(ops.reduce((s, o) => s + o.totalPnl, 0) / nPh),
                bySide: { long: sideOut(0), short: sideOut(4) },
                byGroup: groupRowsOf(col.grp, runs.map((r) => r.sels), nPh),
                thirds,
            },
            fresh: freshOut,
            sel: {
                sizeMean: r4(sizes.reduce((s, v) => s + v, 0) / Math.max(1, sizes.length)),
                sizeMin: sizes.length ? Math.min(...sizes) : 0,
                sizeMax: sizes.length ? Math.max(...sizes) : 0,
                nEmpty: sizes.filter((v) => v === 0).length,
                turnoverJaccard: jac.length ? r4(jac.reduce((s, v) => s + v, 0) / jac.length) : 1,
                ...sizeDistOf(runs, sizes),
                ...compOf(runs, ops),
                orders: {
                    strats: r4(ords.reduce((s, o) => s + o.strats, 0) / Math.max(1, ords.length)),
                    combos: r4(ords.reduce((s, o) => s + o.combos, 0) / Math.max(1, ords.length)),
                    barTop1Share: r4(ords.reduce((s, o) => s + o.barTop1Share, 0) / Math.max(1, ords.length)),
                    perBarMax: ords.length ? Math.max(...ords.map((o) => o.perBarMax)) : 0,
                },
                ...(tagPerf.length ? { tagPerf } : {}),
            },
            null: nul,
            nullVol: nulVol,
            nullAct: nulAct,
            nullSideAct: nulSide,
            nullSideGeo: nulGeo,
            ...(ext ? { ext } : {}),
            selHash: h.digest('hex').slice(0, 20),
            ms: { pick: tPick - t0, metrics: tNull0 - tPick, null: tEnd - tNull0, total: tEnd - t0 },
        }
    }

    //交給呼叫端之各方法: 入口先比對內建物件(呼叫端可能在 await 之後直接呼叫, 其間模組之延後程式可能已改); 評估器內部之呼叫不經此包裝(不重複比對)
    let entry = (fn) => (...args) => {
        assertIntrinsics('api')
        return ReflectApply(fn, undefined, args)
    }
    return { evalPolicy, runPick, opOf: entry(opOf), freshOf: entry(freshOf), nullOf: entry(nullOf), nullActOf: entry(nullActOf), nullSideActOf: entry(nullSideActOf), nullSideGeoOf: entry(nullSideGeoOf), sideGeoGroups: entry(sideGeoGroups), simWindows: entry(simWindows), decisionBars: entry(decisionBars), meta, timeOf: entry(timeOf) }
}


export { makeEvaluator, lowerBound, mulberry32, ntStaticOf }
export default makeEvaluator
