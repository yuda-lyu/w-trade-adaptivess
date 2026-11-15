import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'


//挑選模組之靜態檢查與載入
//  挑選模組須為自足之純 JavaScript ES module: `export default function pick(ctx) { … }`(可另 `export const meta = { … }`)
//  不得匯入任何模組、不得存取檔案 / 行程 / 網路 / 時鐘 / 內建亂數(亂數用 ctx.rand)⇒ 結果只由 ctx 決定, 可重現、無從偷看帳本外之資料
//  檢查為字樣層級(先去註解), 屬防呆與防誤用, 不是安全沙箱; 審計仍須讀碼
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
 *
 * @param {String} fp 輸入挑選模組檔案路徑
 * @returns {Promise<Object>} 回傳Promise,resolve為 { pick(預設匯出函數), accept(具名匯出 accept 函數, 無則 null), meta(具名匯出 meta 物件, 無則 null), src(原始碼字串), bytes(原始碼位元組數) }
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
    let mod = await import(`${pathToFileURL(abs).href}?v=${fs.statSync(abs).mtimeMs}`)
    if (typeof mod.default !== 'function') {
        throw Object.assign(new Error('挑選模組之預設匯出不是函數'), { code: 'PICK_SCAN', issues: ['預設匯出不是函數'] })
    }
    if (mod.accept !== undefined && typeof mod.accept !== 'function') {
        throw Object.assign(new Error('挑選模組之具名匯出 accept 不是函數'), { code: 'PICK_SCAN', issues: ['accept 不是函數'] })
    }
    return { pick: mod.default, accept: typeof mod.accept === 'function' ? mod.accept : null, meta: mod.meta && typeof mod.meta === 'object' ? mod.meta : null, src, bytes: Buffer.byteLength(src) }
}


export { scanPick, scanSnippet, loadPick, stripComments }
export default loadPick
