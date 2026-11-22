import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { FILL_DIR } from './fillPlan.mjs'
import { EVAL_VERSION } from './evalVersion.mjs'

//附算與補算之快取之鍵之來源(規則 R-REC-34; 讀檔者集中於此, 計畫本身在 fillPlan.mjs 為純函數)
//  pickHashOf     成品檔之內容雜湊(位元組之 sha256 前 20 字)
//  evaluatorFpOf  評估器之指紋 = 本套件之評估器原始碼(src/eval/*.mjs〔不含只用於建帳本之 ledgerBuild.mjs〕與 src/cli/eval.mjs; 檔名與內容)、評估帳本之鍵(<eval.ledgerDir>/meta.json 之 key)、
//                 研究用本金(帳本之 meta.unit 之 uIni 之原值; 基礎單位開啟者才併入, 規則 R-EV-43: 不入帳本鍵而改變評估之成敗)、
//                 影響數字之設定(periods 與 eval 中 timeoutSec、ledgerDir 以外之各鍵)、評估器版本(EVAL_VERSION; 單一定義在 evalVersion.mjs)之 sha256 前 20 字 —— 任一改變 ⇒ 附算與補算之值過時
//                 (只改迴圈、任務書或其他非評估器之檔之升版不使之過時; 評估器所匯入之其他套件之改版不在指紋內 —— 該情形調高 EVAL_VERSION;
//                  共同儲存區之重產〔pickStore.mjs〕亦呼叫本函數取得同一個指紋, 標示 current 與附算同一判準)
//  diagsOf        共用工具區 metrics/ 之各擴充診斷之名與內容雜湊
//  fillFileOf / postfitFileOf  補算檔 / 求解窗後段之完整結果檔之路徑(狀態根之 fill/<節點 id>.json / .postfit.json; agent 不可寫之處)
//  readFill       補算檔(無、讀不到、節點 id 不合或檔內之 nodeId 不符者為 null; 節點工作夾內之同名檔一律不讀)

//SRC, 套件之 src 夾: 本檔以 ESM 深層路徑載入時位於 src/domain(上一層即 src); 打包進主入口(dist/*.umd.js)時上一層為套件根 ⇒ 先找上一層之 eval/, 無則找上一層之 src/eval/
let SRC = ((up) => [up, path.join(up, 'src')].find((d) => fs.existsSync(path.join(d, 'eval'))) || up)(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))

let h20 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 20)

/**
 * 成品檔之內容雜湊(位元組之 sha256 前 20 字)
 *
 * @param {Buffer|String} buf 輸入成品檔之內容
 * @returns {String} 回傳雜湊字串
 * @example
 * pickHashOf(fs.readFileSync('pick.mjs'))
 */
let pickHashOf = (buf) => h20(buf)

//EVAL_FP_SKIP, src/eval/ 內不屬評估器之檔(不入指紋; 規則 R-REC-34、R-EV-44、R-EV-52): 建帳本專用之 ledgerBuild.mjs 與只由它於給了 unit 時動態匯入之 unitNotional.mjs ——
//  評估器(src/cli/eval.mjs 與其匯入之 src/eval/ 各檔)皆不匯入(測試以匯入鏈核對: 評估器之匯入鏈不含、建帳本之入口之匯入鏈含; 且 src/eval/ 內不在評估器之匯入鏈上之檔 = 本表,新增而不在鏈上之檔須列入或接入鏈);
//  只改建帳本之升版不使附算與補算之值過時(帳本之內容改變者經帳本鍵 meta.key〔含帳本格式版本、交易規則與緩衝〕併入指紋; 評估器讀帳本之 unit 欄〔unit.mjs、ledger.mjs〕仍在指紋內)
let EVAL_FP_SKIP = ['ledgerBuild.mjs', 'unitNotional.mjs']

//evalSrcFiles, 評估器原始碼之檔(相對於套件之 src; 依名排序); 讀不到即拋錯(指紋不得因讀檔失敗而靜默變寬)
let FP_ERR = (what) => new Error(`invalid evaluator fingerprint: must read ${what}`)
let evalSrcFiles = () => {
    let out
    try {
        out = fs.readdirSync(path.join(SRC, 'eval')).filter((f) => /\.mjs$/i.test(f) && !EVAL_FP_SKIP.includes(f)).sort().map((f) => `eval/${f}`)
    }
    catch (err) {
        throw FP_ERR('the evaluator source (eval/)')
    }
    return [...out, 'cli/eval.mjs']
}

/**
 * 評估器之指紋(評估器原始碼、評估器版本 EVAL_VERSION、評估帳本之鍵、研究用本金、影響數字之設定;任一改變則不同;附算與共同儲存區之重產共用此函數)
 * 原始碼以整檔之位元組計(註解之改動亦使之改變 —— 寧可多算);評估器原始碼或評估帳本之 meta.json 讀不到者拋 invalid evaluator fingerprint: must read …(不靜默略過)
 *
 * @param {Object} st 輸入設定物件(讀取 st.eval、st.periods;缺者視同 null)
 * @returns {String} 回傳 'ev-' 起首之指紋字串
 * @example
 * evaluatorFpOf(getSettings()) // => 'ev-…'
 */
let evaluatorFpOf = (st) => {
    let src = evalSrcFiles().map((rel) => {
        try {
            return [rel, h20(fs.readFileSync(path.join(SRC, rel)))]
        }
        catch (err) {
            throw FP_ERR(`the evaluator source (${rel})`)
        }
    })
    let ev = st && st.eval && typeof st.eval === 'object' ? st.eval : null
    let ledgerKey = null
    let uIni
    if (ev && typeof ev.ledgerDir === 'string') {
        let m
        try {
            m = JSON.parse(fs.readFileSync(path.join(ev.ledgerDir, 'meta.json'), 'utf8'))
        }
        catch (err) {
            throw FP_ERR('the key of the evaluation ledger (meta.json)')
        }
        ledgerKey = m && typeof m.key === 'string' ? m.key : null
        //研究用本金: 取原值(帳本建置時已正規化為數值; 本模組不檢查其合法性 —— 不合者由評估器於載入帳本時拒絕; 寫法不同之同值至多多算一次)
        uIni = m && m.unit && typeof m.unit === 'object' && !Array.isArray(m.unit) ? m.unit.uIni : undefined
    }
    let evNum = ev ? Object.fromEntries(Object.keys(ev).filter((k) => k !== 'timeoutSec' && k !== 'ledgerDir').sort().map((k) => [k, ev[k]])) : null
    let periods = st && st.periods ? st.periods : null
    return `ev-${h20(JSON.stringify({ src, evalVersion: EVAL_VERSION, ledgerKey, eval: evNum, periods, ...(uIni === undefined ? {} : { uIni }) }))}`
}

/**
 * 共用工具區 metrics/ 之各擴充診斷之名與內容雜湊
 *
 * @param {String} toolboxDir 輸入共用工具區之路徑
 * @returns {Array<Object>} 回傳 [{ name, hash }](依名排序;無此夾為空陣列)
 * @example
 * diagsOf('rsi/toolbox') // => [{ name: 'lineContent', hash: '…' }, …]
 */
let diagsOf = (toolboxDir) => {
    let dir = path.join(toolboxDir, 'metrics')
    let files = []
    try {
        files = fs.readdirSync(dir).filter((f) => /\.mjs$/i.test(f)).sort()
    }
    catch (err) {}
    return files.map((f) => ({ name: f.replace(/\.mjs$/i, ''), hash: h20(fs.readFileSync(path.join(dir, f))) }))
}

//ID_OK, 可作為檔名之節點 id(防路徑穿越)
let ID_OK = /^[A-Za-z0-9_-]{1,128}$/

/**
 * 補算檔之路徑(狀態根之 fill/<節點 id>.json)
 *
 * @param {String} stateRoot 輸入狀態根(settings.rsi.root)
 * @param {String} nodeId 輸入節點 id
 * @returns {String} 回傳路徑
 * @example
 * fillFileOf('rsi', 'n1')
 */
let fillFileOf = (stateRoot, nodeId) => path.join(stateRoot, FILL_DIR, `${nodeId}.json`)

/**
 * 求解窗後段之完整結果檔之路徑(狀態根之 fill/<節點 id>.postfit.json)
 *
 * @param {String} stateRoot 輸入狀態根(settings.rsi.root)
 * @param {String} nodeId 輸入節點 id
 * @returns {String} 回傳路徑
 * @example
 * postfitFileOf('rsi', 'n1')
 */
let postfitFileOf = (stateRoot, nodeId) => path.join(stateRoot, FILL_DIR, `${nodeId}.postfit.json`)

/**
 * 讀補算檔(狀態根之 fill/<節點 id>.json;節點工作夾內之同名檔一律不讀)
 *
 * @param {String} stateRoot 輸入狀態根(settings.rsi.root)
 * @param {String} nodeId 輸入節點 id
 * @returns {Object|null} 回傳補算檔之內容;無、讀不到、節點 id 不合或檔內之 nodeId 與之不符者為 null
 * @example
 * readFill('rsi', 'n1')
 */
let readFill = (stateRoot, nodeId) => {
    if (typeof nodeId !== 'string' || !ID_OK.test(nodeId)) {
        return null
    }
    try {
        let o = JSON.parse(fs.readFileSync(fillFileOf(stateRoot, nodeId), 'utf8'))
        return o && typeof o === 'object' && !Array.isArray(o) && o.nodeId === nodeId ? o : null
    }
    catch (err) {
        return null
    }
}

export { pickHashOf, evaluatorFpOf, diagsOf, readFill, fillFileOf, postfitFileOf }
