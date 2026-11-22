import iseint from 'wsemi/src/iseint.mjs'
import isenum from 'wsemi/src/isenum.mjs'
import { recentDiagOf } from './diagRead.mjs'


//成員穩健性之判定(規則 R-REC-51; 純函數): 合格之成品以隨機半庫(數種切法 × 兩半; 評估器之 --member <鹽>:<0|1>)重跑完整評估, 量其內容是否依賴特定成員
//  ⇒ 命中者於迴圈檢查列「提示(成員依賴)」; 只提示、不否決: 不改 S、階梯、否決、可信度、排序鍵、選集指紋
//  獨立成檔(檔名以 verify 起首): 節點之禁區字樣涵蓋 src/domain/verify*(同 verifyExposure.mjs), 判定之組合與門檻不被節點讀到而刻意規避
//  量(皆由評估之結果檔取值, 不剖析字串):
//    內容之種類 = 正本之選集之每隻訊號數為全體隨機之 2 倍以上、且正本有近期活躍度版之組成對照之值者 ⇒ recent(nullRecentAct.side.excess), 其餘 ⇒ builtin(nullSideAct.excess)
//      (與搜尋地圖之挑選內容 contentOf 同一規則; 各半庫取同一種)
//    全庫之內容 = 正本之該值(單抽); ≤ 0、非有限或缺者 ⇒ 保持率不適用(applicable: false), 整條「成員依賴」不判(列仍寫入, 含相位平均為負之半庫數)
//    各半之保持率 = 半庫之內容 ÷ 全庫之內容(半庫缺該值者 null); 中位(偶數個取中間兩數之均)與最小只計非 null 者
//    相位平均為負之半庫數 nNeg = metrics.op.eqYr.mean(各相位之等效年化之平均)< 0 之半庫數(恰為 0 不計)
//  提示 = 保持率之中位 < minRetention, 或 nNeg > maxNegHalves(恰為門檻者不命中); 提示之字樣不列門檻之值(看板、節點文件為節點讀得到之檔)
/**
 * 隨機半庫之預設之鹽(三種切法;K = 2 × 鹽數 = 6 個半庫)
 *
 * @type {Array<Integer>}
 */
let MEMBER_SALTS = Object.freeze([0x5bd1e995, 0x2545f491, 0x9e3779b9])

/**
 * 成員穩健性之附算之預設設定(settings.rsi.memberCheck 未給或其鍵不合時所用;nullDraws 未給者取 settings.eval.replicaNullDraws,再無則 32)
 *
 * @type {Object}
 */
let MEMBER_DEFAULT = Object.freeze({ salts: MEMBER_SALTS, minLadder: 1, minRetention: 0.5, maxNegHalves: 0 })

let isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
let fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
//設定之數值(跨套件規格〈輸入參數之檢測機制〉K1、K4、K7; 設定檔來自 JSON、環境變數或網頁表單, 數字類一律收數字字串): 通過者轉為數值, 其後只用轉換值
//  整數鍵 intOf 依 wsemi iseint(安全整數之數字或其數字字串)、實數鍵 numOf 依 wsemi isenum(十進位寫法之有限數之數字或其數字字串; 去頭尾空白後 Number);
//  布林、NaN、±Infinity、空字串、非數字字串(含 0x10)、BigInt、物件、陣列皆無效 ⇒ 該鍵用預設(不拋錯, 不當 0 或 1)
let intOf = (v, lo, hi) => (iseint(v) && Number(v) >= lo && Number(v) <= hi ? Number(v) : null)
let numOf = (v) => (isenum(v) ? Number(v) : null)

/**
 * 成員穩健性之附算之設定(settings.rsi.memberCheck 之解讀;無效即用預設、不拋錯)
 *
 * false 或 salts 為空陣列者回 null(關閉);salts 須為 0 ~ 4294967295 之整數(或其數字字串)之陣列(重複者只取一次),不合者用預設;
 * nullDraws 須為正整數,未給或不合者取 evalCfg.replicaNullDraws(正整數者),再無則 32;minLadder、maxNegHalves 須為非負整數、minRetention 須為有限數值(數字或其數字字串,轉為數值後使用),不合者用預設。
 *
 * @param {*} v 輸入 settings.rsi.memberCheck 之值
 * @param {Object|null} [evalCfg=null] 輸入 settings.eval(讀取 replicaNullDraws)
 * @returns {Object|null} 回傳 { salts, nullDraws, minLadder, minRetention, maxNegHalves } 或 null(關閉)
 * @example
 * let c = memberCheckOf({ minRetention: 0.6 }, { replicaNullDraws: 32 })
 * // => { salts: [0x5bd1e995, 0x2545f491, 0x9e3779b9], nullDraws: 32, minLadder: 1, minRetention: 0.6, maxNegHalves: 0 }
 */
let memberCheckOf = (v, evalCfg = null) => {
    if (v === false) {
        return null
    }
    let o = isObj(v) ? v : {}
    let salts = MEMBER_DEFAULT.salts.slice()
    if (Array.isArray(o.salts)) {
        if (o.salts.length === 0) {
            return null
        }
        let xs = o.salts.map((x) => intOf(x, 0, 0xFFFFFFFF))
        if (xs.every((x) => x !== null)) {
            salts = [...new Set(xs)]
        }
    }
    let rd = isObj(evalCfg) ? intOf(evalCfg.replicaNullDraws, 1, Number.MAX_SAFE_INTEGER) : null
    let nd = intOf(o.nullDraws, 1, Number.MAX_SAFE_INTEGER)
    let ml = intOf(o.minLadder, 0, Number.MAX_SAFE_INTEGER)
    let mn = intOf(o.maxNegHalves, 0, Number.MAX_SAFE_INTEGER)
    let mr = numOf(o.minRetention)
    return {
        salts,
        nullDraws: nd !== null ? nd : (rd !== null ? rd : 32),
        minLadder: ml !== null ? ml : MEMBER_DEFAULT.minLadder,
        minRetention: mr !== null ? mr : MEMBER_DEFAULT.minRetention,
        maxNegHalves: mn !== null ? mn : MEMBER_DEFAULT.maxNegHalves,
    }
}

/**
 * 由整份設定求成員穩健性之附算之設定(領域層與做夢任務書共用之單一來源;settings.rsi.memberCheck 與 settings.eval.replicaNullDraws)
 *
 * @param {Object|null} st 輸入整份設定(讀取 rsi.memberCheck、eval)
 * @returns {Object|null} 回傳 memberCheckOf 之結果(關閉者 null)
 * @example
 * memberCfgOfSt({ rsi: { memberCheck: false } }) // => null
 */
let memberCfgOfSt = (st) => memberCheckOf(isObj(st) && isObj(st.rsi) ? st.rsi.memberCheck : undefined, isObj(st) ? st.eval : null)

//hex, 鹽之標記(評估器之 --member 之標記同一寫法: 0x<十六進位>)
let hex = (s) => `0x${s.toString(16)}`

/**
 * 成員穩健性之快取之鍵之成分(各鹽之標記依序以逗號相接 + 「|n」+ 虛無抽數;鹽或抽數改變 ⇒ 鍵不同 ⇒ 重算)
 *
 * @param {Object} cfg 輸入 memberCheckOf 之結果
 * @returns {String} 回傳鍵之成分字串
 * @example
 * memberSigOf({ salts: [1, 255], nullDraws: 32 }) // => '0x1,0xff|n32'
 */
let memberSigOf = (cfg) => `${cfg.salts.map(hex).join(',')}|n${cfg.nullDraws}`

/**
 * 各半庫之評估之標記(與評估器之 --member 之寫法相同:0x<鹽>:<半>;依鹽之次序、每鹽先甲半後乙半)
 *
 * @param {Object} cfg 輸入 memberCheckOf 之結果
 * @returns {Array<String>} 回傳標記之陣列(長度 = 2 × 鹽數)
 * @example
 * memberTagsOf({ salts: [1], nullDraws: 32 }) // => ['0x1:0', '0x1:1']
 */
let memberTagsOf = (cfg) => cfg.salts.flatMap((s) => [`${hex(s)}:0`, `${hex(s)}:1`])

/**
 * 成品是否合格(成員穩健性之附算之對象):未被否決、評估期之階梯(score.flags.trainLadder,無則 score.ladder)≥ cfg.minLadder
 *
 * 工作夾有無成品檔由呼叫端判定(附算之節點之列只含有成品檔者)。
 *
 * @param {Object} n 輸入樹上之節點(讀 score)
 * @param {Object|null} cfg 輸入 memberCheckOf 之結果;null(關閉)者回 false
 * @returns {Boolean} 回傳是否合格
 * @example
 * memberEligibleOf({ score: { S: 20, ladder: 1, flags: { vetoed: false } } }, memberCheckOf()) // => true
 */
let memberEligibleOf = (n, cfg) => {
    let sc = n && n.score
    if (!cfg || !sc || (sc.flags && sc.flags.vetoed)) {
        return false
    }
    let ld = sc.flags && typeof sc.flags.trainLadder === 'number' ? sc.flags.trainLadder : sc.ladder
    return typeof ld === 'number' && ld >= cfg.minLadder
}

//activeOf, 正本之選集之每隻訊號數為全體隨機之 2 倍以上(內容可取近期活躍度版; 搜尋地圖之 contentOf 同一判準)
let activeOf = (m) => !!(m && m.sel && m.null && typeof m.sel.sigPerPick === 'number' && typeof m.null.sigPerPick === 'number' && m.null.sigPerPick > 0 && m.sel.sigPerPick >= 2 * m.null.sigPerPick)

/**
 * 成品之讀數是否依近期活躍度版之診斷(nullRecentAct;快取之鍵須併該診斷之內容雜湊之判準)
 *
 * 讀數所依之值:內容之種類為 recent 者,全庫與各半之內容取診斷之輸出(ext.nullRecentAct.side.excess),診斷被改寫 ⇒ 既有之讀數過時;
 * 種類為 builtin 者,內容取評估器內建之組成對照(nullSideAct.excess;其變動由評估器之指紋涵蓋)與各半之相位平均,不依該診斷。
 * 而種類本身隨「正本有無該診斷之值」而定,故選集之每隻訊號數為全體隨機之 2 倍以上者(種類可為 recent)一律視為依該診斷(診斷改寫後由無值變有值、或反之,種類即改變);
 * 未達 2 倍者種類恆為 builtin ⇒ 不依該診斷(診斷被改寫不使其重算)。
 *
 * @param {Object|null} n 輸入樹上之節點(讀 raw.metrics.sel、raw.metrics.null)
 * @returns {Boolean} 回傳是否依該診斷
 * @example
 * memberRecentCapableOf({ raw: { metrics: { sel: { sigPerPick: 9 }, null: { sigPerPick: 3 } } } }) // => true
 */
let memberRecentCapableOf = (n) => activeOf(n && isObj(n.raw) && isObj(n.raw.metrics) ? n.raw.metrics : null)

//kindOf, 內容之種類(與搜尋地圖之 contentOf 同一規則): 正本之選集之每隻訊號數為全體隨機之 2 倍以上且正本有近期活躍度版之值 ⇒ recent; 其餘 ⇒ builtin
let kindOf = (m) => (activeOf(m) && recentDiagOf(m) ? 'recent' : 'builtin')
let builtinOf = (m) => (m && isObj(m.nullSideAct) ? fin(m.nullSideAct.excess) : null)
let recentOf = (m) => {
    let s = recentDiagOf(m); return s ? s.excess : null
}
let medianOf = (xs) => {
    let s = xs.slice().sort((a, b) => a - b)
    let k = s.length
    return k === 0 ? null : (k % 2 === 1 ? s[(k - 1) / 2] : (s[k / 2 - 1] + s[k / 2]) / 2)
}

/**
 * 成員穩健性之讀數(純函數;各半庫之完整評估之結果 → 一列)
 *
 * @param {Object} canon 輸入正本之 metrics(讀 sel、null、nullSideAct、ext.nullRecentAct)
 * @param {Array<Object>} halves 輸入各半庫 [{ tag, n, metrics }](tag = 評估器之 member.tag;n = 半庫之策略數;metrics = 該次評估之 metrics)
 * @param {Object} cfg 輸入 memberCheckOf 之結果(讀 salts、nullDraws)
 * @returns {Object} 回傳 { K, salts, nullDraws, kind, full, applicable, halves: [{ tag, n, eqYrMean, excess, recent, retention }], retention: { median, min, n }, nNeg }
 * @example
 * let row = memberRowOf(canonMetrics, [{ tag: '0x1:0', n: 50, metrics: m0 }, { tag: '0x1:1', n: 50, metrics: m1 }], cfg)
 */
let memberRowOf = (canon, halves, cfg) => {
    let kind = kindOf(canon)
    let valOf = kind === 'recent' ? recentOf : builtinOf
    let full = valOf(canon)
    let applicable = full !== null && full > 0
    let hs = (Array.isArray(halves) ? halves : []).map((h) => {
        let m = isObj(h) && isObj(h.metrics) ? h.metrics : null
        let v = valOf(m)
        let eq = m && isObj(m.op) && isObj(m.op.eqYr) ? fin(m.op.eqYr.mean) : null
        return { tag: isObj(h) && typeof h.tag === 'string' ? h.tag : null, n: isObj(h) ? fin(h.n) : null, eqYrMean: eq, excess: builtinOf(m), recent: recentOf(m), retention: applicable && v !== null ? v / full : null }
    })
    let rs = hs.map((h) => h.retention).filter((v) => v !== null)
    return {
        K: hs.length,
        salts: cfg.salts.map(hex),
        nullDraws: cfg.nullDraws,
        kind,
        full,
        applicable,
        halves: hs,
        retention: { median: medianOf(rs), min: rs.length ? Math.min(...rs) : null, n: rs.length },
        nNeg: hs.filter((h) => h.eqYrMean !== null && h.eqYrMean < 0).length,
    }
}

let MEMBER_HINT_HEAD = '提示(成員依賴): '
let isMemberHint = (s) => String(s).startsWith(MEMBER_HINT_HEAD)
let f2 = (v) => (v === null || v === undefined ? '—' : v.toFixed(2))

/**
 * 迴圈檢查之「提示(成員依賴)」一條(純函數):命中者回字串,其餘(含保持率不適用、cfg 為 null)回 null
 *
 * @param {Object|null} row 輸入 memberRowOf 之結果
 * @param {Object|null} cfg 輸入 memberCheckOf 之結果(讀 minRetention、maxNegHalves)
 * @returns {String|null} 回傳提示字串或 null
 * @example
 * let s = memberHintOf(row, memberCheckOf())
 */
let memberHintOf = (row, cfg) => {
    if (!cfg || !isObj(row) || row.applicable !== true || !isObj(row.retention)) {
        return null
    }
    let md = row.retention.median
    let hit = (md !== null && md < cfg.minRetention) || row.nNeg > cfg.maxNegHalves
    return hit ? `${MEMBER_HINT_HEAD}隨機半庫 ${row.K} 個(${row.K / 2} 種切法 × 兩半)之內容保持率 中位 ${f2(md)}、最小 ${f2(row.retention.min)};相位平均為負之半庫 ${row.nNeg} 個 ⇒ 內容可能依賴特定成員;以子庫(--subset)核對其成立之範圍(不否決,由審計判定)` : null
}

/**
 * 樹上之節點之現行之成員穩健性之讀數(raw.member 為物件、帶 row,且其所記之選集指紋 = 正本之選集指紋者;其餘回 null)
 *
 * @param {Object} n 輸入樹上之節點(讀 raw.member、raw.metrics.selHash)
 * @returns {Object|null} 回傳 memberRowOf 之結果或 null
 * @example
 * let row = memberRowOfTree(node)
 */
let memberRowOfTree = (n) => {
    let raw = n && isObj(n.raw) ? n.raw : null
    let mb = raw && isObj(raw.member) ? raw.member : null
    let sel = raw && isObj(raw.metrics) && typeof raw.metrics.selHash === 'string' ? raw.metrics.selHash : null
    return mb && isObj(mb.row) && typeof mb.selHash === 'string' && mb.selHash === sel ? mb.row : null
}


export { MEMBER_SALTS, MEMBER_DEFAULT, memberCheckOf, memberCfgOfSt, memberRecentCapableOf, memberSigOf, memberTagsOf, memberEligibleOf, memberRowOf, MEMBER_HINT_HEAD, isMemberHint, memberHintOf, memberRowOfTree }
