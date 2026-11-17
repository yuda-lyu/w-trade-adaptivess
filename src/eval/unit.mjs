import isenum from 'wsemi/src/isenum.mjs'


//下單之基礎單位(規則 R-EV-43; 選配): 每張單 = 交易所之最小可下單數量(基礎單位)之整數倍, 單一策略之一張單 = 1 單位
//  設定 unit = { rule: { stepSize, minQty, minNotional, asOf?, source? }, buffer = 0.1, uIni }(交易規則、名義門檻之緩衝、研究用本金)
//  本檔只含設定之檢查與比對(只匯入 wsemi 之判斷函數, 不匯入回測套件; 評估器、載入器、命令列只用本檔);
//    每根棒之名義(回測套件之 calcBaseUnitQuantity)在 ./unitNotional.mjs, 只由 buildLedger 於給了 unit 時才動態匯入 ⇒ 未給設定之路徑不依賴回測套件之該函數
//  未給(undefined / null)⇒ 不啟用: 帳本、評估器與命令列之輸出與未加入本功能時逐位相同(每單 1 單位)
//  不寫死任何標的之數值: 交易規則一律由使用端之設定(或其他標的之帳本自帶之 meta.unit)給
//  數值收數字與數字字串(跨套件規格之數字類; wsemi isenum 判定: 十進位寫法、有限數): 通過即轉為數值, 其後(meta.unit、帳本鍵、比對)一律用轉換後之數值 ⇒ '0.001' 與 0.001 得同一帳本鍵、比對相同

//numOf, 數字或數字字串 ⇒ 轉換後之數值(未通過 ⇒ null); opt 同 wsemi isenum(gt: 大於、min: 不小於); '-0' 與 -0 一律為 0(存檔與比對不分正負零)
let numOf = (v, opt) => (isenum(v, opt) ? Number(v) + 0 : null)

let isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 檢查並正規化基礎單位之設定: 未給(undefined / null)回 null(不啟用); 給了而不合即拋錯(不靜默當成未給)
 * 數值收數字與數字字串(通過即轉為數值, 回傳與其後之使用皆為轉換後之數值; 非數字、非有限、不合範圍者拋錯); rule 之 asOf、source 為選配之字串(記錄用, 不入計算與帳本鍵)
 * 每個欄位只讀取一次(檢查之值即使用之值); 錯誤訊息依 invalid <位置>: must be …(不帶輸入值)
 *
 * @param {*} u 輸入設定物件 { rule: { stepSize, minQty, minNotional, asOf?, source? }, buffer?, uIni }
 * @param {String} [where='unit'] 輸入錯誤訊息所用之位置名稱,預設'unit'
 * @returns {Object|null} 回傳凍結之 { rule: { stepSize, minQty, minNotional[, asOf][, source] }, buffer, uIni }(數值欄皆為 Number), 未給則回 null
 * @example
 * let nu = normUnit({ rule: { stepSize: '0.001', minQty: 0.001, minNotional: 20 }, uIni: 10000 })
 * // => { rule: { stepSize: 0.001, minQty: 0.001, minNotional: 20 }, buffer: 0.1, uIni: 10000 }
 */
let normUnit = (u, where = 'unit') => {
    if (u === undefined || u === null) {
        return null
    }
    if (!isPlainObj(u)) {
        throw new Error(`invalid ${where}: must be an object { rule, buffer, uIni } or null`)
    }
    let rule = u.rule
    if (!isPlainObj(rule)) {
        throw new Error(`invalid ${where}.rule: must be an object { stepSize, minQty, minNotional }`)
    }
    let r = {}
    for (let k of ['stepSize', 'minQty', 'minNotional']) {
        let v = numOf(rule[k], { gt: 0 })
        if (v === null) {
            throw new Error(`invalid ${where}.rule.${k}: must be a positive finite number`)
        }
        r[k] = v
    }
    for (let k of ['asOf', 'source']) {
        let v = rule[k]
        if (v !== undefined && v !== null && typeof v !== 'string') {
            throw new Error(`invalid ${where}.rule.${k}: must be a string`)
        }
        if (typeof v === 'string') {
            r[k] = v
        }
    }
    let b0 = u.buffer
    let buffer = b0 === undefined || b0 === null ? 0.1 : numOf(b0, { min: 0 })
    if (buffer === null) {
        throw new Error(`invalid ${where}.buffer: must be a non-negative finite number`)
    }
    let uIni = numOf(u.uIni, { gt: 0 })
    if (uIni === null) {
        throw new Error(`invalid ${where}.uIni: must be a positive finite number`)
    }
    return Object.freeze({ rule: Object.freeze(r), buffer, uIni })
}

/**
 * 基礎單位之識別字串(入帳本鍵): 交易規則之三個數值與緩衝(研究用本金與 asOf / source 不改每單之名義, 不入)
 *
 * @param {Object} nu 輸入 normUnit 之回傳(非 null)
 * @returns {String} 回傳識別字串
 * @example
 * let k = unitKeyOf(normUnit({ rule: { stepSize: 0.001, minQty: 0.001, minNotional: 20 }, uIni: 10000 }))
 * // => '0.001|0.001|20|0.1'
 */
let unitKeyOf = (nu) => `${nu.rule.stepSize}|${nu.rule.minQty}|${nu.rule.minNotional}|${nu.buffer}`

/**
 * 兩份基礎單位之設定是否相同(皆未給, 或交易規則之三個數值、緩衝與研究用本金皆相同; asOf / source 不比)
 *
 * @param {Object|null} a 輸入 normUnit 之回傳
 * @param {Object|null} b 輸入 normUnit 之回傳
 * @returns {Boolean} 回傳是否相同
 * @example
 * let same = sameUnit(null, null)
 * // => true
 */
let sameUnit = (a, b) => (a === null && b === null) || (a !== null && b !== null && unitKeyOf(a) === unitKeyOf(b) && a.uIni === b.uIni)


export { normUnit, unitKeyOf, sameUnit }
