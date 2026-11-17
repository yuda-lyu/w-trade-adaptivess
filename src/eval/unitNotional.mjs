import calcBaseUnitQuantity from 'w-trade-backtest/src/calcBaseUnitQuantity.mjs'


//每根棒之基礎單位名義(規則 R-EV-43; 選配): calcBaseUnitQuantity(該棒收盤價, rule, { buffer }).notional(回測套件 w-trade-backtest 之單一實作; 回測、評估與線上下單同一份)
//  只由 buildLedger 於給了 unit 時才動態匯入(未給設定之路徑 —— 載入、建帳本、評估、命令列 —— 不依賴回測套件之此函數; 設定之檢查在 ./unit.mjs, 不含任何匯入)
//  進場價 = 進場棒之收盤價 ⇒ 每單之名義只依進場棒與交易規則 ⇒ 帳本只存每根棒一個值(unit.f64)即可重現每單之名義
let isPosNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0

/**
 * 每根棒之基礎單位名義: calcBaseUnitQuantity(close[i], rule, { buffer }).notional(進場價 = 進場棒之收盤價)
 * 收盤價非正或非有限數者拋 invalid close…; 回測套件拋錯者(例: 格數超過安全整數)轉為 invalid unit…(原錯誤保留於 err.cause; 不分種類 —— 回測套件之程式缺陷亦然, 維護者由 cause 查);
 * 回測套件未拋錯而回傳之名義非正或非有限數者亦拋 invalid unit…(不寫入帳本); 訊息皆不帶值, 給了 times 者指出第一個不合之棒之時間
 *
 * @param {Float64Array|Array} close 輸入各棒之收盤價
 * @param {Object} nu 輸入 normUnit 之回傳(非 null)
 * @param {Array} [times=null] 輸入各棒之時間字串(與 close 等長; 錯誤訊息用),預設null(訊息不列棒)
 * @returns {Float64Array} 回傳與 close 等長之名義
 * @example
 * let w = unitNotionalOf([2000, 1999], normUnit({ rule: { stepSize: 0.001, minQty: 0.001, minNotional: 20 }, uIni: 10000 }))
 * // => Float64Array [22, 23.988]
 */
let unitNotionalOf = (close, nu, times = null) => {
    let n = close.length
    let w = new Float64Array(n)
    let rule = { stepSize: nu.rule.stepSize, minQty: nu.rule.minQty, minNotional: nu.rule.minNotional }
    let at = (i) => (times ? `; first at bar ${times[i]}` : '')
    let memo = new Map()
    for (let i = 0; i < n; i++) {
        let p = close[i]
        if (!isPosNum(p)) {
            throw new Error(`invalid close: must be a positive finite number at every bar (required by unit${at(i)})`)
        }
        let v = memo.get(p)
        if (v === undefined) {
            try {
                v = calcBaseUnitQuantity(p, rule, { buffer: nu.buffer }).notional
            }
            catch (err) {
                throw new Error(`invalid unit: must give a base-unit quantity at every bar (calcBaseUnitQuantity failed${at(i)})`, { cause: err })
            }
            if (!isPosNum(v)) {
                throw new Error(`invalid unit: must give a positive finite base-unit notional at every bar (calcBaseUnitQuantity returned a non-positive or non-finite notional${at(i)})`)
            }
            memo.set(p, v)
        }
        w[i] = v
    }
    return w
}


export { unitNotionalOf }
