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

//CLI_FLAGS, 各進入檔(src/cli/*.mjs)認得之全部旗標(單一定義): 進入檔名 → { 旗標名(不含 --): 值之格式說明; 布林旗標為 null }
//  各進入檔以 eqFlagMsgOf(CLI_FLAGS.<名>) 拒收帶等號之寫法; 新增旗標須同時加於此表(unit-cliEqFlags 以原始碼之盤點核對: 進入檔讀取之旗標 = 本表之鍵)
//  帶值之旗標之格式說明只用於訊息(程式常數, 不是輸入值)
let CLI_FLAGS = {
    eval: {
        'pick': '<module.mjs>',
        'mode': '<quick|full>',
        'period': '<backtest|train|postfit>',
        'out': '<result.json>',
        'null': '<N>',
        'phases': '<days,days,…>',
        'ref': '<module.mjs>[,<module.mjs>…]',
        'ext-test': '<file.mjs>',
        'ext-only': '<name>[,<name>…]',
        'seed': '<N>',
        'tie-salt': '<N>',
        'member': '<salt>:<half>',
        'subset': '<rule>',
        'no-log': null,
    },
    backtest: { 'pick': '<module.mjs>', 'name': '<result-name>', 'dir': '<result-dir>', 'seed': '<N>', 'match-sides': '<0|1>', 'show': null },
    build: { limit: '<N>', train: null },
    rsi: {
        'mode': '<status|init|dry|round|board|validate|reverify|extfill|fill|frontier|annotate|dirtype>',
        'nodes': '<N>',
        'arms': '<N>',
        'parallel': '<K>',
        'workers': '<K>',
        'rounds': '<M>',
        'dream-only': null,
        'file': '<file>',
        'force': null,
        'why': '<text>',
        'keep-flags': null,
        'only': '<id-prefix>[,<id-prefix>…]',
        'ext': '<name>[,<name>…]',
        'null': '<N>',
        'par': '<N>',
        'no-postfit': null,
        'no-member': null,
        'dry': null,
        'claim': '<claim-key>',
        'close': '<arm>[+<arm>…]',
        'rearm': '<arm>[+<arm>…]',
        'to': '<arm>[+<arm>…]',
        'base': '<node-id>',
        'round': '<N>',
    },
    toolbox: {},
    launch: {},
}

//eqFlagMsgOf, 命令列只認 --key value(空白分隔): argOf 不識 --key=value(視為旗標未給), 被靜默忽略者會使結果與使用者之意圖不同(例: --period=postfit 退回回測期、被記為正本之評估) ⇒ 各進入檔一律拒收(排程第 590 項)
/**
 * 命令列旗標之等號寫法(--key=value)之檢查: 凡以 -- 起首且含 = 之引數(依 argOf 之解析, 以 -- 起首者必為旗標、不是某旗標之值)皆不合;
 * 回傳固定之訊息(不帶輸入值: 旗標名只在其為 flags 所列者〔程式常數〕才寫出, 其餘寫通稱); 皆合格回傳 null
 *
 * @param {Object} flags 輸入本進入檔認得之旗標: { 旗標名(不含 --): 值之格式說明(如 '<N>'), 布林旗標者為 null }
 * @param {Array<String>} [argv=process.argv.slice(2)] 輸入命令列引數,預設 process.argv.slice(2)
 * @param {Array<String>} [first=[]] 輸入優先檢查之旗標名(多個旗標帶等號時,依此次序先報者;其餘依命令列之次序),預設[]
 * @returns {String|null} 回傳拒收之訊息(單行)或 null
 * @example
 * eqFlagMsgOf({ pick: '<module.mjs>', 'no-log': null }, ['--pick=a.mjs'])
 * // => 'invalid --pick: must be written as --pick <module.mjs> (a space, not =)'
 */
let eqFlagMsgOf = (flags, argv = process.argv.slice(2), first = []) => {
    let eqs = argv.filter((a) => typeof a === 'string' && a.startsWith('--') && a.includes('='))
    if (eqs.length === 0) {
        return null
    }
    let nameOf = (a) => a.slice(2, a.indexOf('='))
    let known = (nm) => Object.prototype.hasOwnProperty.call(flags, nm)
    let pickEq = null
    for (let nm of first) {
        pickEq = eqs.find((a) => nameOf(a) === nm) || null
        if (pickEq !== null) {
            break
        }
    }
    let a = pickEq !== null ? pickEq : eqs[0]
    let nm = nameOf(a)
    if (!known(nm)) {
        return 'invalid option: must be written as --<key> <value> (a space, not =; a flag without a value is written alone)'
    }
    return flags[nm] === null ? `invalid --${nm}: must be written as --${nm} alone (a flag without a value, not =)` : `invalid --${nm}: must be written as --${nm} ${flags[nm]} (a space, not =)`
}

//CLI_ENUMS, 帶值旗標之值為列舉者之集合(單一定義; 進入檔名 → 旗標名 → 允許之值〔字串〕): 值不在集合內(含無值)⇒ 拒收(排程第 547、590 項: 原靜默退回預設或落入他分支)
//  與 CLI_FLAGS 之格式說明相同(unit-cliStrictFlags 核對); rsi 之 mode 與 src/cli/rsi.mjs 之 `mode === '…'` 逐一相同(同測試核對)
let CLI_ENUMS = {
    eval: { mode: ['quick', 'full'], period: ['backtest', 'train', 'postfit'] },
    backtest: { 'match-sides': ['0', '1'] },
    rsi: { mode: ['status', 'init', 'dry', 'round', 'board', 'validate', 'reverify', 'extfill', 'fill', 'frontier', 'annotate', 'dirtype'] },
}

//CLI_OWN, 旗標之無值或重複由進入檔自己之解析處理(其訊息沿用既有之固定訊息, 且於本檢查之後): 進入檔名 → { noValue: [旗標名], dup: [旗標名] }
//  eval: --null 之值(含無值)不合 ⇒ invalid --null: must be a non-negative integer; --member、--subset 之無值、重複與格式不合 ⇒ 各自之固定訊息(1.0.42 起)
//  rsi: --file 於只做夢輪次(--dream-only)之無值 ⇒ invalid --file: must be the path of a readable, non-empty UTF-8 text file
let CLI_OWN = {
    eval: { noValue: ['null', 'member', 'subset'], dup: ['member', 'subset'] },
    rsi: { noValue: ['file'], dup: [] },
}

//cliMsgOf, 命令列之嚴格檢查(排程第 547、590 項): 一律只認 --key value(空白分隔)與列表內之旗標; 其餘 ⇒ 回固定之單行訊息(不帶輸入值; 旗標名只在其為表所列者〔程式常數〕才寫出), 皆合格回 null;
//  檢查之次序: ① 帶等號之 --key=value(eqFlagMsgOf) ② 自左至右掃描: 未列之旗標(含拼錯、--period:postfit 之冒號寫法、單獨之 --)、單值旗標重複、帶值旗標無值、列舉旗標之值不在集合、
//  多餘之值(布林旗標之後接非旗標之值、帶值旗標之值之後再接一個值,如 --phases 0 3)、多餘之位置引數; 帶值旗標之值為空字串或只有空白者視同無值(own 所列者除外)
//  原: argOf 不識以上各種寫法而視為旗標未給或只取第一個 —— 靜默退回預設或誤跑(--perod、--mode ful、--phases 0 3、--ref a.mjs b.mjs、重複之 --pick)
/**
 * 命令列之嚴格檢查: 帶等號之寫法、未列之旗標、單值旗標重複、帶值旗標無值、列舉旗標之值不在集合內、多餘之值或位置引數皆回固定之訊息(不帶輸入值); 全部合格回傳 null
 *
 * @param {String} entry 輸入進入檔名,CLI_FLAGS 之鍵(eval、backtest、build、rsi、toolbox、launch)
 * @param {Array<String>} [argv=process.argv.slice(2)] 輸入命令列引數,預設 process.argv.slice(2)
 * @param {Object} [opt={}] 輸入選項
 * @param {Array<String>} [opt.first=[]] 輸入帶等號時優先報告之旗標名(同 eqFlagMsgOf 之 first),預設[]
 * @param {Integer} [opt.positional=0] 輸入允許之位置引數個數(不屬任何旗標之值者;如 g_launch.mjs 之日誌名為 1),預設0
 * @returns {String|null} 回傳拒收之訊息(單行)或 null
 * @example
 * cliMsgOf('eval', ['--pick', 'a.mjs', '--mode', 'ful'])
 * // => 'invalid --mode: must be one of quick, full'
 */
let cliMsgOf = (entry, argv = process.argv.slice(2), opt = {}) => {
    let flags = CLI_FLAGS[entry]
    let first = opt && Array.isArray(opt.first) ? opt.first : []
    let nPos = opt && Number.isInteger(opt.positional) ? opt.positional : 0
    let eq = eqFlagMsgOf(flags, argv, first)
    if (eq !== null) {
        return eq
    }
    let enums = CLI_ENUMS[entry] || {}
    let own = CLI_OWN[entry] || { noValue: [], dup: [] }
    let names = Object.keys(flags)
    let known = (nm) => Object.prototype.hasOwnProperty.call(flags, nm)
    let seen = new Set()
    let nSeen = 0
    for (let i = 0; i < argv.length; i++) {
        let a = argv[i]
        if (typeof a !== 'string' || !a.startsWith('--')) {
            //位置引數(不屬任何旗標之值): 只在允許之個數內
            if (nSeen < nPos && typeof a === 'string') {
                nSeen++
                continue
            }
            return 'invalid argument: must be the value of the preceding option (--<key> <value>; a flag without a value is written alone)'
        }
        let nm = a.slice(2)
        if (!known(nm)) {
            return names.length > 0 ? `invalid option: must be one of ${names.map((x) => `--${x}`).join(', ')}` : 'invalid option: must be none (this command takes no options)'
        }
        if (seen.has(nm) && !own.dup.includes(nm)) {
            return `invalid --${nm}: must be given at most once`
        }
        seen.add(nm)
        let v = argv[i + 1]
        let hasVal = typeof v === 'string' && !v.startsWith('--')
        if (flags[nm] === null) {
            //布林旗標: 其後不得接值
            if (hasVal) {
                return 'invalid argument: must be the value of the preceding option (--<key> <value>; a flag without a value is written alone)'
            }
            continue
        }
        if (Object.prototype.hasOwnProperty.call(enums, nm)) {
            if (!(hasVal && enums[nm].includes(v))) {
                return `invalid --${nm}: must be one of ${enums[nm].join(', ')}`
            }
            i++
            continue
        }
        //空字串或只有空白之值(`--out ""`)視同無值(原: 被當成值而下游靜默忽略, 如 `--dir ""` 落入正式之結果夾); own 所列者由進入檔自己之解析處理其值, 此處只消耗該值
        if (!hasVal || v.trim() === '') {
            if (own.noValue.includes(nm)) {
                if (hasVal) {
                    i++
                }
                continue
            }
            return `invalid --${nm}: must be written as --${nm} ${flags[nm]} (a value is required)`
        }
        i++
    }
    return null
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


export { FD_ROOT, P, tms, isoOf, getSettings, argOf, argStrOf, CLI_FLAGS, CLI_ENUMS, CLI_OWN, eqFlagMsgOf, cliMsgOf, readJson, writeJson }
