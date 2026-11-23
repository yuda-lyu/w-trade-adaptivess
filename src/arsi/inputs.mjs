import { rsiNumOf, RSI_NUM_KINDS } from './rsiNums.mjs'


//入口之輸入檢測之共用小函數(跨套件規格〈輸入參數之檢測機制〉K3、K5、V4、V11、§5.1; R-EV-54)
//  分類(逐入口之歸類見規則帳本 R-EV-54 之表):
//    ① 安全閘或會使操作與意圖相反者 ⇒ 給了而無效即拒絕(boolOpt、fnOpt、strReq 等拋 invalid <名稱>: must be …); 固定訊息、不帶輸入值
//    ② 決定結果之數字或布林 ⇒ 同上(布林依 K5: 字串 'false' / 'true'、數字皆非布林)
//    ③ 計時值 ⇒ §3.7(無效用預設)
//    ④ 其餘選填 opt ⇒ K3(無效視為未給、用預設)
//    ⑤ 必給件(opt 本身、必給之鍵、函數)⇒ §5.1 固定訊息(不拋原生 TypeError)
//  失敗通道依入口類別(§5.1): 同步且有副作用者與工廠 ⇒ 同步拋 Error(先於任何副作用); 回傳 Promise 者 ⇒ reject; 回傳結果物件者 ⇒ 回失敗之結果物件
//  只匯入同層之 rsiNums.mjs(wsemi isenum)

/**
 * 一般物件(跨套件規格 O1): 原型為 Object.prototype 或 null; 陣列、Date、Map、類別實例、函數、null 皆非; 讀取拋錯之值(已撤銷之 Proxy)視為否
 *
 * @param {*} v 輸入任意值
 * @returns {Boolean} 回傳是否為一般物件
 * @example
 * isPlain({}) // => true
 * isPlain([]) // => false
 */
let isPlain = (v) => {
    try {
        if (v === null || typeof v !== 'object') {
            return false
        }
        let p = Object.getPrototypeOf(v)
        return p === Object.prototype || p === null
    }
    catch (err) {
        return false
    }
}

/**
 * 注入之元件(records、texts、hooks、toolbox 等; 可為類別實例): 非 null 之物件(非陣列、非函數)為真
 *
 * @param {*} v 輸入任意值
 * @returns {Boolean} 回傳是否為非 null 之非陣列物件
 * @example
 * isObj(new Map()) // => true
 */
let isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 組出無效輸入之錯誤(跨套件規格 V19: `invalid <名稱>: must be <種類描述>`; 不帶輸入值)
 *
 * @param {String} where 輸入名稱(如 opt.dir)
 * @param {String} desc 輸入種類描述(如 a non-empty string)
 * @returns {Error} 回傳 Error
 * @example
 * throw badInput('opt.dir', 'a non-empty string')
 */
let badInput = (where, desc) => new Error(`invalid ${where}: must be ${desc}`)

/**
 * opt 本身(V4): undefined、null 視為未給(回 {}); 一般物件原樣; 其餘拋 invalid <where>: must be an object
 *
 * @param {*} v 輸入 opt
 * @param {String} [where='opt'] 輸入名稱,預設'opt'
 * @returns {Object} 回傳 opt 或 {}
 * @example
 * optOf(null) // => {}
 */
let optOf = (v, where = 'opt') => {
    if (v === undefined || v === null) {
        return {}
    }
    if (!isPlain(v)) {
        throw badInput(where, 'an object')
    }
    return v
}

/**
 * 必給之一般物件(§5.1): 非一般物件(含 undefined、null)拋 invalid <where>: must be an object
 *
 * @param {*} v 輸入值
 * @param {String} where 輸入名稱
 * @returns {Object} 回傳原物件
 * @example
 * objReq({}, 'opt.records')
 */
let objReq = (v, where) => {
    if (!isPlain(v)) {
        throw badInput(where, 'an object')
    }
    return v
}

/**
 * 布林(B1; K5: 字串 'true' / 'false'、數字皆非布林): undefined、null 取 def; true / false 原樣; 其餘拋 invalid <where>: must be a boolean
 *
 * @param {*} v 輸入值
 * @param {Boolean} def 輸入未給時之預設
 * @param {String} where 輸入名稱
 * @returns {Boolean} 回傳布林
 * @example
 * boolOpt('false', false, 'opt.dry') // 拋 invalid opt.dry: must be a boolean
 */
let boolOpt = (v, def, where) => {
    if (v === undefined || v === null) {
        return def
    }
    if (v === true || v === false) {
        return v
    }
    throw badInput(where, 'a boolean')
}

/**
 * 函數(F1)之選配項(安全閘之回調): undefined、null 回 null; 函數原樣; 其餘拋 invalid <where>: must be a function
 *
 * @param {*} v 輸入值
 * @param {String} where 輸入名稱
 * @returns {Function|null} 回傳函數或 null
 * @example
 * fnOpt(null, 'opt.gate') // => null
 */
let fnOpt = (v, where) => {
    if (v === undefined || v === null) {
        return null
    }
    if (typeof v === 'function') {
        return v
    }
    throw badInput(where, 'a function')
}

/**
 * 必給之注入元件(可為類別實例; 非 null 之非陣列物件): 其餘(含 undefined、null、陣列、函數、原始值)拋 invalid <where>: must be an object
 *
 * @param {*} v 輸入值
 * @param {String} where 輸入名稱
 * @returns {Object} 回傳原物件
 * @example
 * objAnyReq(new Map(), 'opt.records')
 */
let objAnyReq = (v, where) => {
    if (!isObj(v)) {
        throw badInput(where, 'an object')
    }
    return v
}

/**
 * 各角色之設定(settings.agents)之檢測(getSettings、makeDispatch、checkQuota 共用; R-EV-54): agents 須為一般物件; 其各角色(有給者〔真值〕; 未設 = 未設定)須為一般物件, kind 給了須為 opencode 或 claude(未給 = opencode),
 * fallback 給了(undefined、null、false 以外)須為一般物件之陣列、其各項之 kind 同; 不合者拋 invalid <where>.<role>…: must be …(角色名只在其為 \w{1,20} 時寫出, 否則寫 <role>; 不帶輸入值)
 *
 * @param {*} agents 輸入 agents 物件
 * @param {String} [where='opt.agents'] 輸入名稱前綴,預設'opt.agents'(設定檔來者為 settings.agents)
 * @returns {Object} 回傳原物件
 * @example
 * agentsCheck({ node: { kind: 'claude', model: 'm' } }, 'settings.agents')
 */
let agentsCheck = (agents, where = 'opt.agents') => {
    objReq(agents, where)
    let kindOk = (k) => k === undefined || k === null || k === 'opencode' || k === 'claude'
    for (let [role, cfg] of Object.entries(agents)) {
        if (!cfg) {
            continue
        }
        let w = `${where}.${/^\w{1,20}$/.test(role) ? role : '<role>'}`
        if (!isPlain(cfg)) {
            throw badInput(w, 'an object')
        }
        if (!kindOk(cfg.kind)) {
            throw badInput(`${w}.kind`, 'one of opencode, claude')
        }
        if (cfg.fallback !== undefined && cfg.fallback !== null && cfg.fallback !== false) {
            if (!Array.isArray(cfg.fallback) || !cfg.fallback.every((x) => isPlain(x))) {
                throw badInput(`${w}.fallback`, 'an array of objects')
            }
            if (!cfg.fallback.every((x) => kindOk(x.kind))) {
                throw badInput(`${w}.fallback[].kind`, 'one of opencode, claude')
            }
        }
    }
    return agents
}

/**
 * 必給之函數(§5.1): 非函數拋 invalid <where>: must be a function
 *
 * @param {*} v 輸入值
 * @param {String} where 輸入名稱
 * @returns {Function} 回傳原函數
 * @example
 * fnReq(() => 1, 'opt.runRound')
 */
let fnReq = (v, where) => {
    if (typeof v !== 'function') {
        throw badInput(where, 'a function')
    }
    return v
}

/**
 * 必給之非空字串(S1; 只收原始字串、不收包裝物件): 其餘拋 invalid <where>: must be a non-empty string
 *
 * @param {*} v 輸入值
 * @param {String} where 輸入名稱
 * @returns {String} 回傳原字串
 * @example
 * strReq('a', 'opt.dir')
 */
let strReq = (v, where) => {
    if (typeof v !== 'string' || v === '') {
        throw badInput(where, 'a non-empty string')
    }
    return v
}

/**
 * 選配之非空字串(S1): undefined、null 回 def; 非空字串原樣; 其餘拋 invalid <where>: must be a non-empty string
 *
 * @param {*} v 輸入值
 * @param {String|null} def 輸入未給時之預設
 * @param {String} where 輸入名稱
 * @returns {String|null} 回傳字串或 def
 * @example
 * strOpt(undefined, 'README.md', 'opt.indexFile') // => 'README.md'
 */
let strOpt = (v, def, where) => {
    if (v === undefined || v === null) {
        return def
    }
    return strReq(v, where)
}

/**
 * 數值(安全閘、決定結果之數字或規模; 給了而無效即拒絕): undefined、null 取 def; 數字或數字字串(去頭尾空白之十進位寫法)轉為數值後須合種類(rsiNumOf); 其餘拋 invalid <where>: must be <種類描述>
 * 回傳轉換值(檢測之值即使用之值; K4)
 *
 * @param {*} v 輸入值
 * @param {*} def 輸入未給時之預設
 * @param {String} where 輸入名稱
 * @param {String} kind 輸入種類(RSI_NUM_KINDS 之鍵)
 * @returns {Number|*} 回傳轉換值或 def
 * @example
 * numReq('3', 1, 'opt.rounds', 'posInt') // => 3
 */
let numReq = (v, def, where, kind) => {
    if (v === undefined || v === null) {
        return def
    }
    let x = rsiNumOf(v, kind)
    if (x === null) {
        throw badInput(where, RSI_NUM_KINDS[kind][0])
    }
    return x
}

/**
 * 數值(其餘選填之 opt; K3): 數字或數字字串轉為數值後須合種類, 其餘(含未給)取 def(不拋錯、不當 0)
 *
 * @param {*} v 輸入值
 * @param {String} kind 輸入種類(RSI_NUM_KINDS 之鍵)
 * @param {*} def 輸入無效或未給時之預設
 * @returns {Number|*} 回傳轉換值或 def
 * @example
 * numOrDef('abc', 'posInt', 5) // => 5
 */
let numOrDef = (v, kind, def) => {
    let x = rsiNumOf(v, kind)
    return x === null ? def : x
}


export { isPlain, isObj, badInput, optOf, objReq, objAnyReq, agentsCheck, boolOpt, fnOpt, fnReq, strReq, strOpt, numReq, numOrDef }
