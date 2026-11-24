import isenum from 'wsemi/src/isenum.mjs'


//設定之數值之取值(規則 R-EV-44): 評估器(evalCore.mjs)、任務書與合約之參考版(src/domain/factsText.mjs、src/tools/initProject.mjs)與命令列共用 ⇒ 檢測之值即使用之值(輸入參數之檢測機制 K4)
//  影響評估之數字(warmupDays、cadenceDays、nullDraws、actBins、sideActHalf)屬決定資料口徑之設定: 給了而無效即拒絕, 不退回預設(同規格 §11〈決定資料口徑之 opt〉);
//  未給(undefined 或 null)取預設; 數字字串收受並轉為數值(K7); 數字原樣(逐位不變)
//  評估之執行面之數字(EVAL_RUN_NUMS: seed、tieSalt、replicaSeeds、replicaNullDraws、timeoutSec、geoTp、geoSl)、硬上限(EVAL_LIMITS)與相位 / 地平線之清單(cfgListOf)同一口徑(規則 R-EV-50)
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
    //任意正負之整數(亂數種子、同分次序之鹽; K6: 安全整數)
    int: ['an integer', (x) => Number.isSafeInteger(x)],
    //逾時之秒數: 正數, 且換成毫秒不超過 2147483647(Node 計時器之上限; 超過者計時器溢位而立即觸發 ⇒ 每次皆「逾時」; 跨套件規格 §3.7)
    timerSec: ['a positive number of seconds that is at most 2147483', (x) => x > 0 && x * 1000 <= 2147483647],
    //判讀之門檻(settings.score.*)用: 有限數(S、新鮮度、最差相位之等效年化之門檻; 可為負)與機率(0 ~ 1; 虛無之 p 之門檻)
    num: ['a finite number', () => true],
    prob: ['a number from 0 to 1', (x) => x >= 0 && x <= 1],
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

//EVAL_RUN_NUMS, 評估之執行面之數字: 鍵 → [未給之預設, 種類]; 與 EVAL_NUMS 同一口徑(未給 = 預設、數字字串轉為數值後才使用、給了而無效即拒絕: R-EV-44 ④之二、K3、K4、K7);
//  設定之預檢、評估器、命令列(g_eval.mjs、g_backtest.mjs)、迴圈之重放(verify.mjs)與其逾時、成員穩健性之附算共用此單一定義
//  ⇒ 同一個字串之種子於各處是同一個數值(原: `seed * 1000003` 與 `seed + …` 並存, 字串種子於不同處被解讀為不同之數值; 同鍵於兩處各有一套處置)
//  seed 與 tieSalt 為任意之整數(安全整數)、replicaSeeds 與 replicaNullDraws 為非負整數(0 = 不重放 / 重放不算虛無)、timeoutSec 為正數(秒; 換成毫秒不超過 2147483647)、geoTp 與 geoSl 為正整數(止盈、止損之等分數)
let EVAL_RUN_NUMS = {
    seed: [1, 'int'],
    tieSalt: [0, 'int'],
    replicaSeeds: [0, 'nonNegInt'],
    replicaNullDraws: [32, 'nonNegInt'],
    timeoutSec: [900, 'timerSec'],
    geoTp: [3, 'posInt'],
    geoSl: [3, 'posInt'],
}

/**
 * 評估之執行面之數字之取值與檢測(seed、tieSalt、replicaSeeds、replicaNullDraws、timeoutSec、geoTp、geoSl;依 EVAL_RUN_NUMS 逐一以 cfgNumOf 取值):
 * 未給(undefined 或 null)為預設;數字字串轉為數值;給了而無效者拋 invalid <who>.<鍵>: must be …(不帶輸入值);每個鍵只讀一次
 *
 * @param {Object} ev 輸入評估之設定(settings.eval 或 makeEvaluator 之 cfg;可為 null 或 undefined)
 * @param {String} [who='eval'] 輸入錯誤訊息所用之物件名稱,預設'eval'
 * @returns {Object} 回傳 { seed, tieSalt, replicaSeeds, replicaNullDraws, timeoutSec, geoTp, geoSl }(皆為數值)
 * @example
 * evalRunNumsOf({ seed: '20261110' })
 * // => { seed: 20261110, tieSalt: 0, replicaSeeds: 0, replicaNullDraws: 32, timeoutSec: 900, geoTp: 3, geoSl: 3 }
 */
let evalRunNumsOf = (ev, who = 'eval') => {
    let out = {}
    for (let k of Object.keys(EVAL_RUN_NUMS)) {
        out[k] = evalRunNumOf(ev, k, who)
    }
    return out
}

/**
 * 評估之執行面之數字之單一鍵之取值與檢測(同 evalRunNumsOf 之一鍵; 只需某一鍵之呼叫端用, 不因他鍵之無效而拋)
 *
 * @param {Object} ev 輸入評估之設定(settings.eval 或 makeEvaluator 之 cfg;可為 null 或 undefined)
 * @param {String} key 輸入鍵名,EVAL_RUN_NUMS 之鍵之一
 * @param {String} [who='eval'] 輸入錯誤訊息所用之物件名稱,預設'eval'
 * @returns {Number} 回傳數值(未給者為預設)
 * @example
 * evalRunNumOf({ replicaNullDraws: '16' }, 'replicaNullDraws')
 * // => 16
 */
let evalRunNumOf = (ev, key, who = 'eval') => {
    let spec = EVAL_RUN_NUMS[key]
    if (!Array.isArray(spec)) {
        throw new Error(`invalid key: must be one of ${Object.keys(EVAL_RUN_NUMS).join(', ')}`)
    }
    let e = ev && typeof ev === 'object' ? ev : {}
    //每個鍵只讀一次(檢查之值即使用之值)
    return cfgNumOf(e[key], spec[0], `${who}.${key}`, spec[1])
}

//EVAL_LIMITS, 硬上限(eval.limits)未給時之預設: 評估端(scoreOf)與合約、任務書之參考版(initProject.mjs、texts.mjs)共用此單一常數(原: 評估端未給即永不否決, 合約文字端寫 400 / 50)
let EVAL_LIMITS = { monthlyOrders: 400, peakHold: 50 }

/**
 * 硬上限(settings.eval.limits)之取值與檢測:monthlyOrders(月均單;預設 400)、peakHold(最大同時持倉;預設 50)須為非負數(數字或數字字串,轉為數值後才使用);
 * eval.limits 未給(undefined 或 null)為兩者之預設;非物件(含陣列)拋 invalid <who>.limits: must be an object;給了而無效者拋 invalid <who>.limits.<鍵>: must be a non-negative number(不帶輸入值)
 *
 * @param {Object} ev 輸入評估之設定(settings.eval;可為 null 或 undefined)
 * @param {String} [who='eval'] 輸入錯誤訊息所用之物件名稱,預設'eval'
 * @returns {Object} 回傳 { monthlyOrders, peakHold }(皆為數值)
 * @example
 * evalLimitsOf({ limits: { monthlyOrders: '300' } })
 * // => { monthlyOrders: 300, peakHold: 50 }
 */
let evalLimitsOf = (ev, who = 'eval') => {
    let e = ev && typeof ev === 'object' ? ev : {}
    let l = e.limits
    if (l === undefined || l === null) {
        l = {}
    }
    else if (typeof l !== 'object' || Array.isArray(l)) {
        throw new Error(`invalid ${who}.limits: must be an object`)
    }
    let out = {}
    for (let [k, def] of Object.entries(EVAL_LIMITS)) {
        out[k] = cfgNumOf(l[k], def, `${who}.limits.${k}`, 'nonNegNum')
    }
    return out
}

//EVAL_SCORE, 判讀之門檻(settings.score)之各鍵: 路徑 → [未給之預設, 種類](單一定義; 排程第 606 項; R-EV-44 ④之二、R-EV-55): 預設 = 參考設定(settings.json)與合約之參考版所寫之值
//  判讀之門檻決定階梯與否決(評估之結果)⇒ 給了而無效即拒絕(同 eval.limits; 原: scoreOf 以原值比較 —— null、空字串被當 0、true 被當 1、陣列與數字字串以隱式轉型比較、非數字者使比較恆假而階梯恆不過);
//  未給(undefined 或 null)取預設(原: 缺鍵於讀取時為 TypeError); 數字字串收受並轉為數值(K7、K4); scoreOf、設定之預檢(checkEvalSettings)、任務書(texts.mjs)與合約之參考版(initProject.mjs)共用 ⇒ 檢測之值即使用之值
let EVAL_SCORE = {
    ladder1: { S: [15, 'num'], nullP: [0.05, 'prob'] },
    ladder2: { freshMin: [10, 'num'], worstPhaseMin: [5, 'num'] },
    ladder3: { monthlyOrders: [300, 'nonNegNum'], peakHold: [30, 'nonNegNum'] },
}
//freqBands, 月均單之分段界線 [低 | 中 | 高]: 兩個非負數(預設 [100, 250]), 且 b1 ≤ b2(evalScoreOf 檢查; 順序顛倒者之錯誤帶 code = FREQ_BANDS_ORDER_CODE)
let EVAL_FREQ_BANDS = [100, 250]
let FREQ_BANDS_ORDER_CODE = 'SCORE_FREQ_BANDS_ORDER'

/**
 * 判讀之門檻(settings.score)之取值與檢測:ladder1(S、nullP)、ladder2(freshMin、worstPhaseMin)、ladder3(monthlyOrders、peakHold)、freqBands(兩個非負數)依 EVAL_SCORE 逐一以 cfgNumOf 取值;
 * score 或各 ladder 未給(undefined 或 null)為預設;非物件(含陣列)拋 invalid <who>: must be an object / invalid <who>.ladderN: must be an object;給了而無效者拋 invalid <who>.<鍵>: must be …(不帶輸入值);
 * freqBands 之順序顛倒(b1 > b2;以轉換後之數值比較)者拋 invalid <who>.freqBands: must be two non-negative numbers with b1 <= b2(錯誤帶 code = FREQ_BANDS_ORDER_CODE; 規則 R-EV-57 ③);回傳新物件(不改呼叫端之物件)
 *
 * @param {Object} score 輸入判讀之門檻(settings.score;可為 null 或 undefined)
 * @param {String} [who='score'] 輸入錯誤訊息所用之物件名稱,預設'score'
 * @returns {Object} 回傳 { ladder1: { S, nullP }, ladder2: { freshMin, worstPhaseMin }, ladder3: { monthlyOrders, peakHold }, freqBands: [b1, b2] }(皆為數值)
 * @example
 * evalScoreOf({ ladder1: { S: '12' } }).ladder1
 * // => { S: 12, nullP: 0.05 }
 */
let evalScoreOf = (score, who = 'score') => {
    let s = score
    if (s === undefined || s === null) {
        s = {}
    }
    else if (typeof s !== 'object' || Array.isArray(s)) {
        throw new Error(`invalid ${who}: must be an object`)
    }
    let out = {}
    for (let [lad, keys] of Object.entries(EVAL_SCORE)) {
        let l = s[lad]
        if (l === undefined || l === null) {
            l = {}
        }
        else if (typeof l !== 'object' || Array.isArray(l)) {
            throw new Error(`invalid ${who}.${lad}: must be an object`)
        }
        out[lad] = {}
        for (let [k, [def, kind]] of Object.entries(keys)) {
            //每個鍵只讀一次(檢查之值即使用之值)
            out[lad][k] = cfgNumOf(l[k], def, `${who}.${lad}.${k}`, kind)
        }
    }
    let fb = s.freqBands
    if (fb === undefined || fb === null) {
        out.freqBands = EVAL_FREQ_BANDS.slice()
    }
    else {
        if (!Array.isArray(fb) || fb.length !== 2) {
            throw new Error(`invalid ${who}.freqBands: must be an array of two non-negative numbers`)
        }
        out.freqBands = fb.map((x, i) => {
            if (x === undefined || x === null) {
                throw new Error(`invalid ${who}.freqBands[${i}]: must be ${CFG_KINDS.nonNegNum[0]}`)
            }
            return cfgNumOf(x, 0, `${who}.freqBands[${i}]`, 'nonNegNum')
        })
        //順序(規則 R-EV-57 ③; 第 614 項之餘移入評估器〔與 R-EV-59 同批〕: 單一來源 —— scoreOf、設定之預檢、任務書、合約之參考版與 API 直呼 scoreOf / makeProject 者皆經此): 月均單之分段界線 [b1, b2] 須 b1 ≤ b2
        //  順序顛倒者之「中」段恆空、搜尋地圖之格(scoreOf 之 cell)無意義 ⇒ 給了而顛倒即拒絕; 比較取上列之轉換值(數字字串依數值比較: ['9', '10'] 合格); 其餘鍵與型別之無效先於本檢查拋出(本檢查置於末)
        //  固定訊息(不帶輸入值); 錯誤帶 code = FREQ_BANDS_ORDER_CODE, 供讀設定處(getSettings)只攔此一種(其餘之無效留待組裝時之預檢)
        if (out.freqBands[0] > out.freqBands[1]) {
            let e = new Error(`invalid ${who}.freqBands: must be two non-negative numbers with b1 <= b2`)
            e.code = FREQ_BANDS_ORDER_CODE
            throw e
        }
    }
    return out
}

/**
 * 相位數(設定之口徑):settings.eval.phases 為非空陣列者為其長度,否則為評估器之預設 7(0 ~ 6 日各一個起始相位)(只取長度, 不用元素之值; 元素之檢測在評估器與組裝時之預檢);
 * 用於說明**正本評估之設定**者(任務書、合約之參考版、回測期旗標之判讀文字)與 phaseCountOfAll 之後備;說明某一次評估之結果者取 phaseCountOfMetrics
 * (排程第 547 項: 原多處寫死「七相位」; 其接續: 說明結果者取實算, 不取設定之長度 —— --mode quick 實算 2 個相位、--phases 覆寫皆與設定之長度不同)
 *
 * @param {Object} ev 輸入 settings.eval(可為 null)
 * @returns {Integer} 回傳相位數
 * @example
 * phaseCountOf({ phases: [0, 3] })
 * // => 2
 */
let phaseCountOf = (ev) => (ev && Array.isArray(ev.phases) && ev.phases.length > 0 ? ev.phases.length : 7)

/**
 * 相位數之寫法:1 ~ 10 為國字(七)、其餘為阿拉伯數字加空白(12 ),後接 tail(如「相位」「個相位」「個起始相位」)
 *
 * @param {Integer} n 輸入相位數
 * @param {String} tail 輸入接續之字
 * @returns {String} 回傳寫法
 * @example
 * phaseText(7, '相位')
 * // => '七相位'
 */
let phaseText = (n, tail) => (Number.isInteger(n) && n >= 1 && n <= 10 ? '一二三四五六七八九十'[n - 1] : `${n} `) + tail

/**
 * 某一次評估之結果(metrics)實際所算之相位數:metrics.phases(評估器所算之起始相位)為非空陣列者取其長度,否則 op.eqYr.byPhase 為非空陣列者取其長度,皆無則 null
 * (--mode quick 實算 2 個相位、--phases 覆寫、設定之 eval.phases 皆反映於 metrics.phases; 說明該結果之文字取此值, 不取設定之長度)
 *
 * @param {Object} m 輸入評估結果(evalPolicy 之回傳; 可為 null、手寫之物件)
 * @returns {Integer|null} 回傳相位數(正整數); 無法得知者 null
 * @example
 * phaseCountOfMetrics({ phases: [0, 3] })
 * // => 2
 */
let phaseCountOfMetrics = (m) => {
    if (m && Array.isArray(m.phases) && m.phases.length > 0) {
        return m.phases.length
    }
    let bp = m && m.op && m.op.eqYr ? m.op.eqYr.byPhase : null
    return Array.isArray(bp) && bp.length > 0 ? bp.length : null
}

/**
 * 一組結果之相位數(說明看板、搜尋地圖、共同儲存區、摘要之欄標等彙整輸出之文字用):各列之相位數(phaseCountOfMetrics 之值; null 者不計)皆同者取該數;
 * 各列不同、或皆無者取設定之長度(phaseCountOf; 未給 = 7)
 *
 * @param {Array<Integer|null>} counts 輸入各列之相位數(非正整數者不計)
 * @param {Object} ev 輸入 settings.eval(可為 null)
 * @returns {Integer} 回傳相位數
 * @example
 * phaseCountOfAll([2, null, 2], { phases: [0, 1, 3] })
 * // => 2
 * phaseCountOfAll([2, 7], { phases: [0, 1, 3] })
 * // => 3
 */
let phaseCountOfAll = (counts, ev) => {
    let xs = Array.isArray(counts) ? counts.filter((n) => Number.isInteger(n) && n > 0) : []
    return xs.length > 0 && xs.every((n) => n === xs[0]) ? xs[0] : phaseCountOf(ev)
}

//LIST_DESC, 數字清單之元素種類之描述(訊息用)
let LIST_DESC = { nonNegNum: 'non-negative numbers', posNum: 'positive numbers' }

/**
 * 數字清單(相位之起始日數 phases、新鮮度地平線 horizons)之取值與檢測:未給(undefined 或 null)回 def;須為陣列(allowEmpty 為 true 者可為空陣列;否則須非空),各元素依 kind 以 cfgNumOf 取值(數字字串轉為數值;元素不得為 undefined 或 null);
 * 給了而無效者拋 invalid <where>: must be a (non-empty) array of …(元素不合者 invalid <where>[i]: must be …;不帶輸入值);回傳新陣列(不改呼叫端之物件)
 *
 * @param {*} v 輸入設定之值
 * @param {*} def 輸入未給時之預設值
 * @param {String} where 輸入錯誤訊息所用之位置名稱(如 eval.phases、opt.phases、--phases)
 * @param {String} kind 輸入元素之種類,nonNegNum 或 posNum
 * @param {Boolean} [allowEmpty=false] 輸入是否收空陣列(horizons 之空陣列 = 不算新鮮度, 合法),預設false
 * @returns {*} 回傳數值陣列(未給者為 def)
 * @example
 * cfgListOf(['0', 3], null, 'eval.phases', 'nonNegNum')
 * // => [0, 3]
 */
let cfgListOf = (v, def, where, kind, allowEmpty = false) => {
    if (v === undefined || v === null) {
        return def
    }
    if (!Array.isArray(v) || (v.length === 0 && allowEmpty !== true)) {
        throw new Error(`invalid ${where}: must be ${allowEmpty === true ? 'an' : 'a non-empty'} array of ${LIST_DESC[kind]}`)
    }
    let n = v.length
    let out = []
    for (let i = 0; i < n; i++) {
        let x = v[i]
        if (x === undefined || x === null) {
            throw new Error(`invalid ${where}[${i}]: must be ${CFG_KINDS[kind][0]}`)
        }
        out.push(cfgNumOf(x, 0, `${where}[${i}]`, kind))
    }
    return out
}


export { cfgNumOf, CFG_KINDS, EVAL_NUMS, evalCfgNumsOf, EVAL_RUN_NUMS, evalRunNumsOf, evalRunNumOf, EVAL_LIMITS, evalLimitsOf, EVAL_SCORE, evalScoreOf, FREQ_BANDS_ORDER_CODE, phaseCountOf, phaseText, phaseCountOfMetrics, phaseCountOfAll, cfgListOf }
