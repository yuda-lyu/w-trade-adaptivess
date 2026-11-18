import fs from 'fs'
import os from 'os'
import path from 'path'


//專案根(唯一之路徑錨點)與設定載入; 設定內之相對路徑一律以專案根解析
//  專案根 = 環境變數 ARSI_ROOT(專案之進入檔於載入本套件之前, 設為進入檔自身所在之資料夾; 由其起跑之子行程繼承);
//    未設時取行程之工作目錄(於專案根執行測試或工具時)
//  不以本檔之位置推導: 套件安裝後本檔位於 node_modules/<套件>/src, 以其推導會把設定與輸出指到套件夾內
/**
 * 專案根之絕對路徑(取環境變數 ARSI_ROOT, 未設時取行程工作目錄), 為設定與輸出路徑之唯一錨點
 *
 * @type {String}
 */
let FD_ROOT = path.resolve(process.env.ARSI_ROOT || process.cwd())

//P, 專案根下之絕對路徑(已為絕對路徑者原樣)
/**
 * 組出專案根下之絕對路徑(已為絕對路徑之片段則原樣採用)
 *
 * @param {...String} a 輸入路徑片段
 * @returns {String} 回傳絕對路徑字串
 * @example
 * let fp = P('settings.json')
 */
let P = (...a) => path.resolve(FD_ROOT, ...a)

//tms, 無時區之本地時間字串(如 2022-07-01T00:00:00)轉毫秒: 兩端皆以同一假想時區解析, 只用於相減求 K 棒位移(所用之時區須無日光節約)
/**
 * 無時區之本地時間字串轉毫秒(以同一假想時區 Z 解析)
 *
 * @param {String} s 輸入無時區時間字串, 如 2022-07-01T00:00:00
 * @returns {Number} 回傳毫秒數
 * @example
 * let ms = tms('2022-07-01T00:00:00')
 */
let tms = (s) => Date.parse(`${s}Z`)

//isoOf, 毫秒轉回無時區之本地時間字串
/**
 * 毫秒轉回無時區之本地時間字串(與 tms 互逆)
 *
 * @param {Number} ms 輸入毫秒數
 * @returns {String} 回傳無時區時間字串, 如 2022-07-01T00:00:00
 * @example
 * let s = isoOf(tms('2022-07-01T00:00:00'))
 */
let isoOf = (ms) => new Date(ms).toISOString().slice(0, 19)

//getSettings, 讀專案根之 settings.json; 路徑欄(eval.ledgerDir、rsi.root、records.*)轉為絕對路徑
//  dispatch.skillsRoot 未給時取使用者家目錄下之 .claude/skills(派工套件 w-dispatch-ai 之所在; 見 arsi/dispatchers.mjs)
/**
 * 讀取專案根之 settings.json, 並把路徑欄(eval.ledgerDir、rsi.root、records.*)轉為絕對路徑
 * dispatch.skillsRoot 未給時取使用者家目錄下之 .claude/skills; 回傳物件另帶 FD_ROOT 欄
 *
 * @returns {Object} 回傳設定物件
 * @example
 * let st = getSettings()
 */
let getSettings = () => {
    let st = JSON.parse(fs.readFileSync(P('settings.json'), 'utf8'))
    let rel = (p) => P(p)
    st.eval.ledgerDir = rel(st.eval.ledgerDir)
    st.rsi.root = rel(st.rsi.root)
    for (let k of Object.keys(st.records)) {
        st.records[k] = rel(st.records[k])
    }
    if (!st.dispatch.skillsRoot) {
        st.dispatch.skillsRoot = path.join(os.homedir(), '.claude', 'skills')
    }
    st.FD_ROOT = FD_ROOT
    return st
}

//argOf, 命令列 --key value(數值自動轉型; 只有旗標無值時回 true)
/**
 * 讀取命令列 --key value 參數; 值符合數字格式者自動轉為數值, 只有旗標無值時回傳 true
 *
 * @param {String} key 輸入參數名稱(不含 --)
 * @param {*} [def=undefined] 輸入未給該參數時之預設回傳值,預設undefined
 * @returns {*} 回傳參數值(Number、String 或 true), 未給則回傳 def
 * @example
 * let root = argOf('root', null)
 */
let argOf = (key, def = undefined) => {
    let i = process.argv.indexOf(`--${key}`)
    if (i < 0) {
        return def
    }
    let v = process.argv[i + 1]
    if (v === undefined || v.startsWith('--')) {
        return true
    }
    return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v
}

//argStrOf, 命令列 --key value 之原字串(不轉型; id 類參數用 —— 全數字之 id 前綴經 argOf 會被轉成數值)
/**
 * 讀取命令列 --key value 參數之原字串(不做數值轉型);只有旗標無值時回傳 true
 *
 * @param {String} key 輸入參數名稱(不含 --)
 * @param {*} [def=undefined] 輸入未給該參數時之預設回傳值,預設undefined
 * @returns {*} 回傳參數之原字串或 true,未給則回傳 def
 * @example
 * let only = argStrOf('only', null)
 */
let argStrOf = (key, def = undefined) => {
    let i = process.argv.indexOf(`--${key}`)
    if (i < 0) {
        return def
    }
    let v = process.argv[i + 1]
    if (v === undefined || v.startsWith('--')) {
        return true
    }
    return v
}

/**
 * 讀取 JSON 檔; 檔案不存在或解析失敗時回傳預設值
 *
 * @param {String} fp 輸入 JSON 檔路徑
 * @param {*} [def=null] 輸入讀取失敗時之回傳值,預設null
 * @returns {*} 回傳解析後之內容, 失敗則回傳 def
 * @example
 * let o = readJson('./data/state.json', {})
 */
let readJson = (fp, def = null) => {
    try {
        return JSON.parse(fs.readFileSync(fp, 'utf8'))
    }
    catch (err) {
        return def
    }
}

/**
 * 寫出 JSON 檔(縮排 2 空白, UTF-8), 上層資料夾不存在時自動建立
 *
 * @param {String} fp 輸入輸出檔路徑
 * @param {*} obj 輸入要寫出之可序列化內容
 * @returns {undefined} 無回傳值
 * @example
 * writeJson('./data/state.json', { a: 1 })
 */
let writeJson = (fp, obj) => {
    fs.mkdirSync(path.dirname(fp), { recursive: true })
    fs.writeFileSync(fp, JSON.stringify(obj, null, 2), 'utf8')
}


export { FD_ROOT, P, tms, isoOf, getSettings, argOf, argStrOf, readJson, writeJson }
