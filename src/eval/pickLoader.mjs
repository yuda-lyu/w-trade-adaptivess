import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { P, assertIntrinsics, adoptError } from './intrinsics.mjs'

const { JSONStringify, JSONParse } = P


//挑選模組之靜態檢查與載入
//  挑選模組須為自足之純 JavaScript ES module: `export default function pick(ctx) { … }`(可另 `export const meta = { … }`)
//  不得匯入任何模組、不得存取檔案 / 行程 / 網路 / 時鐘 / 內建亂數(亂數用 ctx.rand)⇒ 結果只由 ctx 決定, 可重現、無從偷看帳本外之資料
//  三層(規則 R-EV-35; 合約 §1):
//    ① 靜態檢查(本檔 RULES): 字樣層級(先去註解), 屬防呆與防誤用, 不是安全沙箱 —— 以字串組出名稱、間接取用全域物件等寫法擋不住; 審計仍須讀碼
//    ② 執行期之資料不共用(src/eval/evalCore.mjs): 交給模組之物件一律為複本或凍結物件, 模組改不到評估器之狀態; tag、meta 取快照
//    ③ 執行期之內建物件完整性(src/eval/intrinsics.mjs): 評估器只用載入時擷取之參照; 載入模組後(本檔 loadPick)、每次呼叫 pick / 每批 accept 後比對受保護之內建物件, 被改即判違約、評估失敗(code 為 EVAL_INTEGRITY)
//    保證在 ②③; 仍未於執行期強制者: 模組層變數跨相位 / 跨模擬保存(合約 §4、§1)、檔案 / 行程介面之取用(只靠 ① 與審計)、受保護清單以外之內建物件(含 Error 之靜態屬性)、
//    同一次呼叫之內改而又改回者(偵測不到; 其間評估器只用擷取之參照, 不受影響)
let RULES = [
    [/^\s*import\s/m, 'import 敘述(挑選模組不得匯入任何模組)'],
    [/\bimport\s*\(/, '動態 import()'],
    [/\brequire\s*\(/, 'require()'],
    [/\bprocess\b/, 'process'],
    [/\bglobalThis\b/, 'globalThis'],
    [/\beval\s*\(/, 'eval()'],
    [/\bnew\s+Function\b|\bFunction\s*\(/, 'Function 建構'],
    [/\bfetch\s*\(/, 'fetch()'],
    [/child_process|\bfs\s*\.|\bWebAssembly\b|\bSharedArrayBuffer\b|\bAtomics\b|\bWorker\b/, '系統 / 執行緒介面'],
    [/__proto__|\bconstructor\s*\.\s*constructor\b/, '原型鏈操作'],
    [/\bDate\s*\.\s*now\b|\bnew\s+Date\s*\(\s*\)|\bperformance\s*\./, '時鐘(請用 ctx.time / ctx.bar)'],
    [/\bMath\s*\.\s*random\b/, 'Math.random(請用 ctx.rand)'],
    [/\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b/, '計時器'],
]

/**
 * 去除原始碼中之區塊註解與行註解(以空白取代), 供字樣層級之靜態檢查用
 * 屬字樣層級處理, 非完整之語法剖析
 *
 * @param {String} src 輸入原始碼字串
 * @returns {String} 回傳去註解後之字串
 * @example
 * let s = stripComments('let a = 1 //說明')
 */
let stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ')

/**
 * 對挑選模組原始碼做靜態檢查(先去註解, 再比對禁用字樣, 並要求有 export default)
 * 屬防呆與防誤用, 不是安全沙箱
 *
 * @param {String} src 輸入挑選模組原始碼字串
 * @returns {Array} 回傳問題說明字串陣列, 空陣列代表通過檢查
 * @example
 * let issues = scanPick('export default function pick(ctx) { return [] }')
 */
let scanPick = (src) => {
    let s = stripComments(src)
    let issues = []
    for (let [re, what] of RULES) {
        if (re.test(s)) {
            issues.push(what)
        }
    }
    if (!/export\s+default\b/.test(s)) {
        issues.push('缺 export default(須預設匯出挑選函數)')
    }
    return issues
}

//scanSnippet, 可貼入挑選模組之函式片段之檢查: 與挑選模組同一組限制(RULES), 但不要求 export default(片段不是完整模組)
/**
 * 對可貼入挑選模組之函式片段做靜態檢查(與 scanPick 同一組禁用字樣, 但不要求 export default)
 *
 * @param {String} src 輸入函式片段原始碼字串
 * @returns {Array} 回傳問題說明字串陣列, 空陣列代表通過檢查
 * @example
 * let issues = scanSnippet('let f = (ctx) => ctx.rand()')
 */
let scanSnippet = (src) => {
    let s = stripComments(src)
    return RULES.filter(([re]) => re.test(s)).map(([, what]) => what)
}

/**
 * 載入挑選模組: 先以 scanPick 靜態檢查, 通過後動態匯入, 並驗證預設匯出為函數
 * 檔案不存在拋出 code 為 PICK_MISSING 之錯誤; 未通過檢查或匯出不合者拋出 code 為 PICK_SCAN 之錯誤(含 issues)
 * 匯入(模組之頂層程式已執行)後比對受保護之內建物件: 被改拋出 code 為 EVAL_INTEGRITY 之錯誤(items 列出被改之項目); 匯入失敗者其錯誤改以評估器自建之錯誤轉拋(訊息相同)
 * meta 為快照(JSON 往返之複本; 與寫入結果檔之內容相同; 無法序列化者為 null): 之後讀它或把它寫入結果檔不再執行模組之程式
 *
 * @param {String} fp 輸入挑選模組檔案路徑
 * @returns {Promise<Object>} 回傳Promise,resolve為 { pick(預設匯出函數), accept(具名匯出 accept 函數, 無則 null), meta(具名匯出 meta 物件之快照, 無則 null), src(原始碼字串), bytes(原始碼位元組數) }
 * @example
 * let { pick, accept } = await loadPick('./examples/pick_example.mjs')
 */
let loadPick = async (fp) => {
    let abs = path.resolve(fp)
    if (!fs.existsSync(abs)) {
        throw Object.assign(new Error(`挑選模組不存在: ${abs}`), { code: 'PICK_MISSING' })
    }
    let src = fs.readFileSync(abs, 'utf8')
    let issues = scanPick(src)
    if (issues.length) {
        throw Object.assign(new Error(`挑選模組未通過靜態檢查: ${issues.join('; ')}`), { code: 'PICK_SCAN', issues })
    }
    let mod
    try {
        mod = await import(`${pathToFileURL(abs).href}?v=${fs.statSync(abs).mtimeMs}`)
    }
    catch (err) {
        let e2 = adoptError(err)
        assertIntrinsics('pick-load')
        throw e2
    }
    //第一段(可能執行模組之程式: meta 之 toJSON / 存取子): 取 meta 之快照; 之後比對內建物件(模組之頂層程式與此段皆已執行)
    let fnPick = mod.default
    let fnAccept = mod.accept
    let meta0 = mod.meta
    let meta = null
    if (meta0 && typeof meta0 === 'object') {
        try {
            meta = JSONParse(JSONStringify(meta0))
        }
        catch (err) {
            meta = null
        }
    }
    assertIntrinsics('pick-load')
    if (typeof fnPick !== 'function') {
        throw Object.assign(new Error('挑選模組之預設匯出不是函數'), { code: 'PICK_SCAN', issues: ['預設匯出不是函數'] })
    }
    if (fnAccept !== undefined && typeof fnAccept !== 'function') {
        throw Object.assign(new Error('挑選模組之具名匯出 accept 不是函數'), { code: 'PICK_SCAN', issues: ['accept 不是函數'] })
    }
    return { pick: fnPick, accept: typeof fnAccept === 'function' ? fnAccept : null, meta: meta && typeof meta === 'object' ? meta : null, src, bytes: Buffer.byteLength(src) }
}


export { scanPick, scanSnippet, loadPick, stripComments }
export default loadPick
