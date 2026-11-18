import isenum from 'wsemi/src/isenum.mjs'


//設定之數值之取值(規則 R-EV-44): 評估器(evalCore.mjs)、任務書與合約之參考版(src/domain/factsText.mjs、src/tools/initProject.mjs)與命令列共用 ⇒ 檢測之值即使用之值(輸入參數之檢測機制 K4)
//  影響評估之數字(warmupDays、cadenceDays、nullDraws、actBins、sideActHalf)屬決定資料口徑之設定: 給了而無效即拒絕, 不退回預設(同規格 §11〈決定資料口徑之 opt〉);
//  未給(undefined 或 null)取預設; 數字字串收受並轉為數值(K7); 數字原樣(逐位不變)
//  只匯入 wsemi 之 isenum

//CFG_KINDS, 數值之種類: [訊息所用之種類描述, 值域之判定]
//  訊息依 V19(invalid <名稱>: must be <種類描述>), 不帶輸入值(V20)
let CFG_KINDS = {
    nonNegNum: ['a non-negative number', (x) => x >= 0],
    posNum: ['a positive number', (x) => x > 0],
    nonNegInt: ['a non-negative integer', (x) => Number.isSafeInteger(x) && x >= 0],
    posInt: ['a positive integer', (x) => Number.isSafeInteger(x) && x >= 1],
    //分層數: 評估器以 Uint8Array 存各項所屬之層號(0 ~ 層數 − 1) ⇒ 至多 256 層(超過者層號溢位而靜默算錯)
    binCount: ['an integer from 1 to 256', (x) => Number.isSafeInteger(x) && x >= 1 && x <= 256],
}

/**
 * 設定之數值之取值:未給(undefined 或 null)為預設值;數字與數字字串(wsemi isenum;十進位寫法之有限數)轉為數值後須合種類(CFG_KINDS);其餘(布林、陣列、物件、非數字字串、NaN、±Infinity、BigInt)與超出值域者拋 invalid <where>: must be <種類描述>
 * 數字之輸入原樣回傳(逐位不變);數字字串轉為數值(例:'32' → 32),免得以字串參與運算(`1 + '32'` 為字串相接)
 *
 * @param {*} v 輸入設定之值
 * @param {*} def 輸入未給時之預設值
 * @param {String} where 輸入錯誤訊息所用之位置名稱(如 eval.nullDraws、cfg.nullDraws、opt.nullDraws)
 * @param {String} kind 輸入種類,nonNegNum、posNum、nonNegInt、posInt、binCount(1 ~ 256 之整數)其一
 * @returns {*} 回傳所用之值(未給者為 def,不再檢測)
 * @example
 * cfgNumOf('32', 64, 'eval.nullDraws', 'nonNegInt')
 * // => 32
 * cfgNumOf(undefined, 64, 'eval.nullDraws', 'nonNegInt')
 * // => 64
 */
let cfgNumOf = (v, def, where, kind) => {
    let k = CFG_KINDS[kind]
    if (!k) {
        throw new Error(`invalid kind: must be one of ${Object.keys(CFG_KINDS).join(', ')}`)
    }
    if (v === undefined || v === null) {
        return def
    }
    let x = typeof v === 'number' ? v : (typeof v === 'string' && isenum(v) ? Number(v) : NaN)
    if (!(Number.isFinite(x) && k[1](x))) {
        throw new Error(`invalid ${where}: must be ${k[0]}`)
    }
    return x
}


/**
 * 寬鬆之數值取值(只供合約之參考版寫出硬上限與判讀之門檻之數字;不屬影響評估之數字,評估器不經它):有限數字、數字字串取其數值,其餘回 null(呼叫端用參考版所寫之值)
 *
 * @param {*} v 輸入設定之值
 * @returns {Number|null} 回傳數值或 null
 * @example
 * cfgNumLoose('12')
 * // => 12
 */
let cfgNumLoose = (v) => {
    let x = typeof v === 'number' ? v : (typeof v === 'string' && isenum(v) ? Number(v) : NaN)
    return Number.isFinite(x) ? x : null
}

//EVAL_NUMS, 影響評估之數字: 鍵 → [未給之預設, 種類]; 評估器、設定之預檢、命令列、任務書與合約之參考版共用(單一定義)
let EVAL_NUMS = {
    warmupDays: [180, 'nonNegNum'],
    cadenceDays: [7, 'posNum'],
    nullDraws: [64, 'nonNegInt'],
    actBins: [10, 'binCount'],
    sideActHalf: [50, 'nonNegInt'],
}

/**
 * 影響評估之數字之取值與檢測(不含「日數 × 每日棒數須為整數」之檢查, 該檢查需帳本之每日棒數, 見 barGrid.mjs 之 evalNumsOf):
 * warmupDays、cadenceDays、nullDraws、actBins、sideActHalf 依 EVAL_NUMS 逐一以 cfgNumOf 取值;給了而無效者拋 invalid <who>.<鍵>: must be …(不帶輸入值)
 *
 * @param {Object} ev 輸入評估之設定(settings.eval 或 makeEvaluator 之 cfg;可為 null 或 undefined)
 * @param {String} [who='eval'] 輸入錯誤訊息所用之物件名稱,預設'eval'
 * @returns {Object} 回傳 { warmupDays, cadenceDays, nullDraws, actBins, sideActHalf }(皆為數值)
 * @example
 * evalCfgNumsOf({ nullDraws: '32' })
 * // => { warmupDays: 180, cadenceDays: 7, nullDraws: 32, actBins: 10, sideActHalf: 50 }
 */
let evalCfgNumsOf = (ev, who = 'eval') => {
    let e = ev && typeof ev === 'object' ? ev : {}
    let out = {}
    for (let [k, [def, kind]] of Object.entries(EVAL_NUMS)) {
        //每個鍵只讀一次(檢查之值即使用之值)
        out[k] = cfgNumOf(e[k], def, `${who}.${k}`, kind)
    }
    return out
}


export { cfgNumOf, cfgNumLoose, CFG_KINDS, EVAL_NUMS, evalCfgNumsOf }
