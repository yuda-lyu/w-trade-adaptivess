import isenum from 'wsemi/src/isenum.mjs'


//settings.rsi / settings.agents 之數值鍵之取值(排程第 595 項; 跨套件規格〈輸入參數之檢測機制〉K3、K4、K7): 檢測之值即使用之值
//  這些鍵屬「執行面與讀數面之選填設定」(每輪節點數、併行數、額度門檻、文件整理上限、側別讀數門檻、逾時): 不決定評估或回測之數字(那些在 settings.eval / settings.backtest: 給了而無效即拒絕, R-EV-44 ④之二、R-EV-50),
//  依 K3 之分類: 給了而無效 ⇒ 視為未給、改用預設(不拋錯、不當 0); 數字字串(去頭尾空白之十進位寫法, wsemi isenum)轉為數值後才使用(K7; 原: 多數處以 Number.isInteger / typeof number 判定而數字字串被靜默當成未給,
//  或以 `||`、原值比較而字串與 0 被當成不同之值)
//  同一物件內一致: settings.rsi.memberCheck、exposure(R-REC-48、R-REC-51)早已用同一口徑(無效即用預設、數字字串轉數值)
//  只匯入 wsemi 之 isenum

//RSI_NUM_KINDS, 數值之種類: [說明, 值域之判定]
let RSI_NUM_KINDS = {
    posInt: ['a positive integer', (x) => Number.isSafeInteger(x) && x >= 1],
    nonNegInt: ['a non-negative integer', (x) => Number.isSafeInteger(x) && x >= 0],
    //任意正負之整數(maxConsecutiveFailures 之 ≤ 0 = 關閉; reverifyParallel 取值後夾於 1 ~ 8)
    int: ['an integer', (x) => Number.isSafeInteger(x)],
    int2: ['an integer of at least 2', (x) => Number.isSafeInteger(x) && x >= 2],
    posNum: ['a positive number', (x) => x > 0],
    nonNegNum: ['a non-negative number', (x) => x >= 0],
    num: ['a finite number', () => true],
    unit: ['a number from 0 to 1', (x) => x >= 0 && x <= 1],
    //逾時之分鐘數: 正數, 且換成毫秒不超過 2147483647(Node 計時器之上限; 超過者計時器溢位而立即觸發)
    timerMin: ['a positive number of minutes that is at most 35791', (x) => x > 0 && x * 60000 <= 2147483647],
}

//RSI_NUMS, 各鍵之種類(單一定義): 設定之路徑 → 種類; 無效或未給 ⇒ 預設(呼叫端所給); unit-rsiNums 以原始碼之盤點核對「各鍵之讀取皆經 rsiNumOf」
let RSI_NUMS = {
    'rsi.nodesPerRound': 'posInt',
    'rsi.parallelNodes': 'posInt',
    'rsi.roundsPerRun': 'posInt',
    'rsi.maxArmsPerNode': 'posInt',
    'rsi.refDreams': 'posInt',
    'rsi.refTopNodes': 'posInt',
    'rsi.reverifyParallel': 'int',
    'rsi.docLimits.maxBytes': 'posInt',
    'rsi.docLimits.keepBytes': 'nonNegInt',
    'rsi.docLimits.keepRows': 'nonNegInt',
    'rsi.preflight.lockStaleHours': 'posNum',
    'rsi.preflight.quotaMaxPercent': 'num',
    'rsi.preflight.maxConsecutiveFailures': 'int',
    'rsi.sideRead.minNodes': 'int2',
    'rsi.sideRead.top': 'int2',
    'rsi.sideRead.corrAbs': 'unit',
    'rsi.sideRead.lo': 'unit',
    'rsi.sideRead.hi': 'unit',
    'agents.<role>.timeoutMin': 'timerMin',
    'agents.<role>.quotaMaxPercent': 'num',
}

/**
 * 設定之數值之取值(K3): 數字與數字字串(wsemi isenum; 去頭尾空白之十進位寫法之有限數)轉為數值後須合種類(RSI_NUM_KINDS); 其餘(未給、null、布林、陣列、物件、非數字字串、NaN、±Infinity、BigInt)與超出值域者回 null(呼叫端用預設)
 * 數字原樣回傳(逐位不變); 數字字串轉為數值(例: '4' → 4)
 *
 * @param {*} v 輸入設定之值
 * @param {String} kind 輸入種類(RSI_NUM_KINDS 之鍵)
 * @returns {Number|null} 回傳數值, 無效或未給回傳 null
 * @example
 * rsiNumOf('4', 'posInt')
 * // => 4
 * rsiNumOf('abc', 'posInt')
 * // => null
 */
let rsiNumOf = (v, kind) => {
    let k = RSI_NUM_KINDS[kind]
    if (!k) {
        throw new Error(`invalid kind: must be one of ${Object.keys(RSI_NUM_KINDS).join(', ')}`)
    }
    let x = typeof v === 'number' ? v : (typeof v === 'string' && isenum(v) ? Number(v) : NaN)
    return Number.isFinite(x) && k[1](x) ? x : null
}

//orOf, 取值或預設(有效取轉換值, 無效或未給取 def)
let orOf = (v, kind, def) => {
    let x = rsiNumOf(v, kind)
    return x === null ? def : x
}

//objOf, 非物件(含陣列、null)視為空物件
let objOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

/**
 * 每個節點至多幾個臂(settings.rsi.maxArmsPerNode; 正整數, 預設 4): 領域之閘門與任務書之說明共用此函數(檢測之值即使用之值)
 *
 * @param {Object|null} rsiCfg 輸入設定之 rsi 物件
 * @returns {Number} 回傳至多幾個臂
 * @example
 * maxArmsOf({ maxArmsPerNode: '3' }) // => 3
 */
let maxArmsOf = (rsiCfg) => orOf(objOf(rsiCfg).maxArmsPerNode, 'posInt', 4)

/**
 * 做夢任務書之參考(settings.rsi.refDreams: 近幾份做夢文件, 預設 2; refTopNodes: 前幾名之節點, 預設 3; 皆正整數)
 *
 * @param {Object|null} rsiCfg 輸入設定之 rsi 物件
 * @returns {Object} 回傳 { refDreams, refTopNodes }
 * @example
 * refCountsOf({ refDreams: '4' }) // => { refDreams: 4, refTopNodes: 3 }
 */
let refCountsOf = (rsiCfg) => {
    let o = objOf(rsiCfg)
    return { refDreams: orOf(o.refDreams, 'posInt', 2), refTopNodes: orOf(o.refTopNodes, 'posInt', 3) }
}

/**
 * 重算之併行數(settings.rsi.reverifyParallel; 整數取值後夾於 1 ~ 8, 預設 4)
 *
 * @param {Object|null} rsiCfg 輸入設定之 rsi 物件
 * @returns {Number} 回傳併行數
 * @example
 * reverifyParOf({ reverifyParallel: '3' }) // => 3
 */
let reverifyParOf = (rsiCfg) => Math.max(1, Math.min(8, orOf(objOf(rsiCfg).reverifyParallel, 'int', 4)))

/**
 * 專案指引文件之自動整理之上限(settings.rsi.docLimits 之 maxBytes、keepBytes、keepRows; 無效或未給者為 undefined ⇒ archiveExperience / archiveFeedback 用其預設)
 * 領域之輪末與 tools/archiveDocs.mjs 共用(同一鍵單一解讀)
 *
 * @param {Object|null} rsiCfg 輸入設定之 rsi 物件(docLimits 為 false 者由呼叫端另判)
 * @returns {Object} 回傳 { maxBytes, keepBytes, keepRows }
 * @example
 * docLimitsOf({ docLimits: { maxBytes: '20000' } }) // => { maxBytes: 20000, keepBytes: undefined, keepRows: undefined }
 */
let docLimitsOf = (rsiCfg) => {
    let d = objOf(objOf(rsiCfg).docLimits)
    let at = (v, kind) => {
        let x = rsiNumOf(v, kind)
        return x === null ? undefined : x
    }
    return { maxBytes: at(d.maxBytes, 'posInt'), keepBytes: at(d.keepBytes, 'nonNegInt'), keepRows: at(d.keepRows, 'nonNegInt') }
}

/**
 * 起跑前自檢之數值(settings.rsi.preflight 之 lockStaleHours〔正數, 預設 6〕、quotaMaxPercent〔有限數, 預設 95〕、maxConsecutiveFailures〔整數, 預設 2; ≤ 0 = 不以連續失敗擋〕)
 * g_rsi.mjs、tools/quota.mjs 與領域共用
 *
 * @param {Object|null} rsiCfg 輸入設定之 rsi 物件
 * @returns {Object} 回傳 { lockStaleHours, quotaMaxPercent, maxConsecutiveFailures }
 * @example
 * preflightOf({ preflight: { quotaMaxPercent: '90' } }) // => { lockStaleHours: 6, quotaMaxPercent: 90, maxConsecutiveFailures: 2 }
 */
let preflightOf = (rsiCfg) => {
    let p = objOf(objOf(rsiCfg).preflight)
    return { lockStaleHours: orOf(p.lockStaleHours, 'posNum', 6), quotaMaxPercent: orOf(p.quotaMaxPercent, 'num', 95), maxConsecutiveFailures: orOf(p.maxConsecutiveFailures, 'int', 2) }
}

//settings.resources(cpuMax、ramUsedMaxGB、cpuStart、ramStartGB、sampleSec、pollSec、maxWaitMin)不在本檔: 評估器之進入檔(src/cli/eval.mjs)之資源閘另讀同一組鍵(typeof number), 本輪不動評估器 ⇒ 為免同一鍵有兩種解讀, 整組留待下次動評估器時一併

export { RSI_NUM_KINDS, RSI_NUMS, rsiNumOf, maxArmsOf, refCountsOf, reverifyParOf, docLimitsOf, preflightOf }
