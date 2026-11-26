import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'


//【排程第 622 項 ① 起】全庫之測試檔皆 `import assert from 'assert/strict'`(寬鬆之檔 0): 本工具之守門改為
//    ⓐ 寬鬆之檔(nLoose)須為 0 —— 新增一個 `import assert from 'assert'` 即紅;
//    ⓑ 任何檔對寬鬆 assert 模組之匯入(預設 / 命名空間 / 具名 / require / 動態 import)皆列為 looseImports, 除 LOOSE_IMPORT_ALLOW(守門本身之前提案)外須為 0;
//    ⓒ 負向之斷言(notEqual、notStrictEqual、notDeepEqual、notDeepStrictEqual)之前兩個引數含 null / undefined 者(weakNeg)須為 0 ——
//       嚴格版之 notStrictEqual(x, null) 對 undefined 亦通過(寬鬆版之 notEqual(x, null) 要求 x 非 null 且非 undefined), 須寫成明示之等價式 `assert.ok(x !== null && x !== undefined)`;
//    ⓓ 防空集合: 掃描之呼叫數(nAssertCalls)須達 1000 以上。
//  以下為原(排程第 614 項④)之寬鬆斷言盤點(scanSource / auditDir 之 calls、flagged 等; 對寬鬆之檔仍有效 —— 供守門本身之測試與日後誤入之寬鬆檔):
//非嚴格斷言之盤點工具(規則 R-PKG-12; 排程第 614 項④): 掃測試檔(test/*.test.mjs), 列出「非嚴格之 assert.deepEqual / notDeepEqual / equal / notEqual」之呼叫及其期望值之寫法
//  背景: Node(24.22.1 實測)之非嚴格 assert.deepEqual 對「期望陣列中之 null 元素」不比對(`deepEqual(['m'], [null])` 不拋; 任何深度之陣列內皆然;
//        物件之屬性、純量、實際為 null 而期望非 null 者照拋); null 與 undefined 於寬鬆比較下互通(`equal(undefined, null)`、`deepEqual([null], [undefined])` 不拋)
//        ⇒ 含 null / undefined 期望值之非嚴格斷言可能形同虛設(此前提由 unit-assertStrict 於執行時核對, Node 改了行為即失敗)
//  用法(只讀、不寫任何檔): node test/tools/auditAssert.mjs [--list] [--dir <測試目錄>]
//    預設印各類之數量; --list 另列含 null / undefined 期望值之呼叫(file:line 與期望值之原文);
//    離開碼 0 = 「含 null / undefined 期望值之正向非嚴格斷言」為 0、不涵蓋之寫法為 0、匯入不被辨識之檔為 0; 1 = 有; 2 = 防空集合檢查不過(掃描範圍壞了, 結果不算數)
//  類別(以期望值 = 第 2 個引數之原文判定; 以記號層級掃描: 略過字串、樣板、正規式與註解內之字樣):
//    nullInArray  期望值內有「陣列字面值內之 null」(寬鬆之 deepEqual 之盲區)
//    hasNull      期望值內有 null 記號(含 nullInArray; equal / notEqual 之 `x, null` 亦入此類)
//    hasUndef     期望值內有 undefined 記號
//    opaque       期望值含識別字(變數、呼叫、運算式; 不是純字面值): 靜態無從得知其內容 —— 以動態盤點補(於全套之執行中包裝斷言函數, 記期望值之實際內容; 見 sgud/exp 該條), 本工具只計數
//  assert/strict(`import assert from 'assert/strict'`)之檔為嚴格, 不在盤點內(只計檔數); 呼叫 deepStrictEqual 等嚴格函數者不計
//  「含 null / undefined 期望值」(flagged)只計正向之斷言(deepEqual、equal): 負向之 notEqual / notDeepEqual 於期望值為 null / undefined 時, 寬鬆版(`x` 非 null 且非 undefined;
//    `notDeepEqual(['m'], [null])` 因寬鬆比較視為相等而拋)比嚴格版強, **不得機械改為嚴格版**(複審所見: `notEqual(x, null)` 改 `notStrictEqual` 後 undefined 亦通過)
//  不涵蓋之寫法(以 unsupported 列出; 守門測試要求全庫為 0): 裸引用(`assert.<方法>` 之後不接呼叫: 別名 `let eq = assert.equal`、傳遞 `run(assert.equal, …)`、`.call` / `.apply` / `.bind`、`assert.equal?.(`)、
//    轉指(裸之 `assert` 識別字: 解構 `let { equal } = assert`、`let a2 = assert`、`helper(assert)`)、括號呼叫(`assert['equal'](`)、`assert` 與 `.` 或 `.` 與方法名之間有空白或換行、可選鏈(`assert?.equal(`);
//    具名匯入(`import { equal } from 'assert'`)與匯入別名使整檔判為 none(守門測試要求 none 為 0)

let METHODS = ['deepEqual', 'notDeepEqual', 'equal', 'notEqual']
//各寬鬆函數之嚴格對應(改寫用)
let STRICT_OF = { deepEqual: 'deepStrictEqual', notDeepEqual: 'notDeepStrictEqual', equal: 'strictEqual', notEqual: 'notStrictEqual' }
//CALL_RE, 呼叫之起首(`assert.<方法>(`; 其前不得為識別字元或點 —— `foo.assert.equal(` 與 `myassert.equal(` 不是); 每次回新之正規式物件(全域旗標帶狀態)
let CALL_RE = () => new RegExp(`(?<![\\w$.])assert\\.(${METHODS.join('|')})\\s*\\(`, 'g')
//UNSUPPORTED_FORMS, 呼叫辨識不涵蓋之寫法(全域旗標之正規式; 使用前須重設 lastIndex)
let MS = METHODS.join('|')
//  裸引用 = `assert.<方法>` 之後不接呼叫之括號(別名 `let eq = assert.equal`、傳遞 `run(assert.equal, …)`、逗號運算式 `(0, assert.equal)(…)`、`.call` / `.apply` / `.bind`、`assert.equal?.(`)
//  轉指 = 裸之 `assert` 識別字(其後不接 `.`、`(`、`[`、`?`; 匯入列之 `import assert` 不計): 解構 `let { equal } = assert`、`let a2 = assert`、`helper(assert)`
let UNSUPPORTED_FORMS = [
    ['裸引用', new RegExp(`(?<![\\w$.])assert\\.(?:${MS})\\b(?!\\s*\\()`, 'g')],
    ['轉指', /(?<![\w$.])(?<!import\s+)assert(?![\w$])(?!\s*[.([?])/g],
    ['括號呼叫', /(?<![\w$.])assert\s*\[/g],
    ['點之前後有空白或換行', new RegExp(`(?<![\\w$.])assert(?:\\s+\\.\\s*|\\s*\\.\\s+)(?:${MS})\\b`, 'g')],
    ['可選鏈', /(?<![\w$.])assert\s*\?\./g],
]
let KEYWORDS_BEFORE_REGEX = ['return', 'typeof', 'case', 'void', 'delete', 'in', 'of', 'instanceof', 'new', 'throw', 'else', 'do', 'yield', 'await']

let isIdChar = (c) => /[\w$]/.test(c)

//regexAllowed, 位置 i 之 `/` 是否起一個正規式(而非除號): 其前最近之非空白字元為運算子、左括號、逗號、冒號等, 或為 return 等關鍵字
let regexAllowed = (src, i) => {
    let k = i - 1
    while (k >= 0 && /\s/.test(src[k])) {
        k--
    }
    if (k < 0) {
        return true
    }
    let c = src[k]
    if ('(,=:[!&|?{};<>+-*%~^'.includes(c)) {
        return true
    }
    if (isIdChar(c)) {
        let e = k
        while (k >= 0 && isIdChar(src[k])) {
            k--
        }
        return KEYWORDS_BEFORE_REGEX.includes(src.slice(k + 1, e + 1))
    }
    return false
}

//skip, 自 i 起若為註解、字串、樣板或正規式則回其結束後之位置, 否則回 i
let skip = (src, i) => {
    let c = src[i]
    let d = src[i + 1]
    if (c === '/' && d === '/') {
        let e = src.indexOf('\n', i)
        return e < 0 ? src.length : e
    }
    if (c === '/' && d === '*') {
        let e = src.indexOf('*/', i + 2)
        return e < 0 ? src.length : e + 2
    }
    if (c === '\'' || c === '"') {
        let k = i + 1
        while (k < src.length && src[k] !== c) {
            k += src[k] === '\\' ? 2 : 1
        }
        return k + 1
    }
    if (c === '`') {
        let k = i + 1
        while (k < src.length && src[k] !== '`') {
            if (src[k] === '\\') {
                k += 2
            }
            else if (src[k] === '$' && src[k + 1] === '{') {
                //樣板內之運算式: 以括號配對找其結束(其內可再含字串、樣板)
                let depth = 1
                k += 2
                while (k < src.length && depth > 0) {
                    let n = skip(src, k)
                    if (n !== k) {
                        k = n
                        continue
                    }
                    if (src[k] === '{') {
                        depth++
                    }
                    else if (src[k] === '}') {
                        depth--
                    }
                    k++
                }
            }
            else {
                k++
            }
        }
        return k + 1
    }
    if (c === '/' && regexAllowed(src, i)) {
        let k = i + 1
        let cls = false
        while (k < src.length && src[k] !== '\n') {
            if (src[k] === '\\') {
                k += 2
                continue
            }
            if (src[k] === '[') {
                cls = true
            }
            else if (src[k] === ']') {
                cls = false
            }
            else if (src[k] === '/' && !cls) {
                break
            }
            k++
        }
        if (src[k] === '/') {
            k++
            while (k < src.length && /[a-z]/.test(src[k])) {
                k++
            }
            return k
        }
    }
    return i
}

//codeMask, 原始碼各位置是否為程式碼(不在註解、字串、樣板、正規式內): 一次掃描; 回 Uint8Array(1 = 程式碼)
let codeMask = (src) => {
    let mask = new Uint8Array(src.length).fill(1)
    for (let k = 0; k < src.length;) {
        let n = skip(src, k)
        if (n !== k) {
            mask.fill(0, k, Math.min(n, src.length))
            k = n
        }
        else {
            k++
        }
    }
    return mask
}

//argsOf, 自 open(指向 `(`)起取該呼叫之引數原文(頂層逗號切分; 括號配對)
let argsOf = (src, open) => {
    let args = []
    let depth = 0
    let from = open + 1
    let k = open
    while (k < src.length) {
        let n = skip(src, k)
        if (n !== k) {
            k = n
            continue
        }
        let c = src[k]
        if (c === '(' || c === '[' || c === '{') {
            depth++
        }
        else if (c === ')' || c === ']' || c === '}') {
            depth--
            if (depth === 0) {
                args.push(src.slice(from, k))
                return args
            }
        }
        else if (c === ',' && depth === 1) {
            args.push(src.slice(from, k))
            from = k + 1
        }
        k++
    }
    return args
}

//tokensOf, 運算式原文之記號層級掃描: 回 { nullInArray, hasNull, hasUndef, opaque }(字串、樣板、正規式、註解內之字樣不計; 屬性名與物件之鍵不是值)
let tokensOf = (expr) => {
    let f = { nullInArray: false, hasNull: false, hasUndef: false, opaque: false }
    let stack = []
    let words = 0
    let k = 0
    while (k < expr.length) {
        let n = skip(expr, k)
        if (n !== k) {
            k = n
            continue
        }
        let c = expr[k]
        if (c === '[' || c === '{' || c === '(') {
            stack.push(c)
            k++
            continue
        }
        if (c === ']' || c === '}' || c === ')') {
            stack.pop()
            k++
            continue
        }
        if (isIdChar(c)) {
            let e = k
            while (e < expr.length && isIdChar(expr[e])) {
                e++
            }
            let w = expr.slice(k, e)
            let prev = expr.slice(0, k).trimEnd().slice(-1)
            let next = expr.slice(e).trimStart()[0]
            let isKey = prev === '.' || (next === ':' && stack[stack.length - 1] === '{')
            if (!isKey) {
                if (w === 'null') {
                    f.hasNull = true
                    if (stack.includes('[')) {
                        f.nullInArray = true
                    }
                }
                else if (w === 'undefined' || w === 'void') {
                    //`void 0` 即 undefined(寫法之一; 負向斷言之 weakNeg 與正向之 flagged 同判)
                    f.hasUndef = true
                }
                else if (!/^\d/.test(w) && !['true', 'false', 'NaN', 'Infinity'].includes(w)) {
                    words++
                }
            }
            k = e
            continue
        }
        k++
    }
    //期望值含 null / undefined / true / false / 數字以外之識別字者為 opaque(變數、呼叫、運算式)
    f.opaque = words > 0
    return f
}

//importKind, 檔首之 assert 匯入: 'strict'(assert/strict 或 { strict })/ 'loose'(assert)/ 'none'
let importKind = (src) => {
    if (/import\s+assert\s+from\s+['"](?:node:)?assert\/strict['"]/.test(src) || /import\s*\{[^}]*\bstrict\b[^}]*\}\s*from\s*['"](?:node:)?assert['"]/.test(src)) {
        return 'strict'
    }
    if (/import\s+(?:\*\s+as\s+)?assert\s+from\s+['"](?:node:)?assert['"]/.test(src)) {
        return 'loose'
    }
    return 'none'
}

//LOOSE_IMPORT_ALLOW, 允許匯入寬鬆 assert 模組之測試檔(守門本身之前提案: 驗「寬鬆版對 null 與 undefined 互通」等 Node 之行為, 須以寬鬆版為對照)
let LOOSE_IMPORT_ALLOW = ['test/unit-assertStrict.test.mjs']

//LOOSE_IMPORT_RES, 對寬鬆 assert 模組(來源 'assert' 或 'node:assert'; `assert/strict` 不是)之匯入:
//  ① import(預設 / 命名空間 / 具名 / 副作用; 空白可省: `import{equal}from'assert'`)、② `export … from 'assert'`、
//  ③ 以「唯一之字面值引數」呼叫之載入(被呼叫者為 require、import、getBuiltinModule 或另一次呼叫之結果〔`createRequire(import.meta.url)('assert')`〕: `require('assert')`、`import('assert')`、`process.getBuiltinModule('assert')`)
//  `import` 之後不得緊接 `.`(`import.meta`)或 `:`(物件之鍵 `import: …`)—— 否則其後之 'assert' 字串會被誤判; 一般函數之呼叫(`it('assert')`、`src.includes('assert')`)不算
//  已知之漏報: 反引號之動態 import(`import(\`assert\`)`); 已知之誤報: 無(被呼叫者限定)
let LOOSE_IMPORT_RES = () => [
    /(?<![\w$.])import(?![\w$.:])[^'";()]*?(['"])(?:node:)?assert\1/g,
    /(?<![\w$.])export(?![\w$.:])[^'";()]*?\bfrom\s*(['"])(?:node:)?assert\1/g,
    /(?:(?<![\w$.])require|(?<![\w$.])import|\bgetBuiltinModule|\))\s*\(\s*(['"])(?:node:)?assert\1\s*\)/g,
]

/**
 * 掃描一份測試檔之原始碼,回傳其對寬鬆 assert 模組之匯入(不含 assert/strict;落在字串、註解、樣板內者不計)
 *
 * @param {String} src 輸入原始碼
 * @returns {Array<Object>} 回傳 [{ line, text }]
 * @example
 * looseImportsOf("import a from 'assert'\nimport b from 'assert/strict'").length // => 1
 */
let looseImportsOf = (src) => {
    let mask = codeMask(src)
    let out = []
    for (let re of LOOSE_IMPORT_RES()) {
        let m
        while ((m = re.exec(src))) {
            if (mask[m.index] === 1) {
                out.push({ line: src.slice(0, m.index).split('\n').length, text: m[0].replace(/\s+/g, ' ') })
            }
        }
    }
    return out.sort((a, b) => a.line - b.line)
}

//NEG_CALL_RE, 負向斷言之呼叫起首(寬鬆與嚴格之名皆含; 其前不得為識別字元或點)
let NEG_CALL_RE = () => /(?<![\w$.])assert\.(?:strict\.)?(notEqual|notStrictEqual|notDeepEqual|notDeepStrictEqual)\s*(?:\?\.\s*)?\(/g

/**
 * 掃描一份測試檔之原始碼,回傳「前兩個引數含 null / undefined 記號」之負向斷言(嚴格版對 undefined 亦通過, 較寬鬆版弱;須改寫為明示之等價式)
 *
 * @param {String} src 輸入原始碼
 * @returns {Array<Object>} 回傳 [{ method, line }]
 * @example
 * weakNegOf("assert.notEqual(x, null)").map((w) => w.method) // => ['notEqual']
 */
let weakNegOf = (src) => {
    let mask = codeMask(src)
    let out = []
    let re = NEG_CALL_RE()
    let m
    while ((m = re.exec(src))) {
        if (mask[m.index] === 0) {
            continue
        }
        let args = argsOf(src, m.index + m[0].length - 1)
        let hit = [args[0], args[1]].some((a) => {
            let t = tokensOf(a || '')
            return t.hasNull || t.hasUndef
        })
        if (hit) {
            out.push({ method: m[1], line: src.slice(0, m.index).split('\n').length })
        }
    }
    return out
}

//CALL_ANY_RE, 任何 assert 呼叫(`assert(` 與 `assert.<方法>(`)之起首: 防空集合之計數用
let CALL_ANY_RE = () => /(?<![\w$.])assert(?:\.\w+)?\s*\(/g

/**
 * 掃描一份測試檔之原始碼,回傳其非嚴格斷言之呼叫(deepEqual / notDeepEqual / equal / notEqual)
 *
 * @param {String} src 輸入原始碼
 * @returns {Object} 回傳 { kind: 'strict' | 'loose' | 'none', calls: [{ method, index, line, argc, expected, nullInArray, hasNull, hasUndef, opaque }] };kind 非 loose 者 calls 為空
 * @example
 * scanSource("import assert from 'assert'\nassert.deepEqual(x, [1, null])").calls[0].nullInArray // => true
 */
let scanSource = (src) => {
    let kind = importKind(src)
    let calls = []
    let unsupported = []
    if (kind !== 'loose') {
        return { kind, calls, unsupported }
    }
    let mask = codeMask(src)
    //不涵蓋之寫法(本工具之呼叫辨識只認 `assert.<方法>(`): 逐種以正規式找(落在字串、註解內者略過), 列出供守門測試要求為 0
    for (let [form, re] of UNSUPPORTED_FORMS) {
        re.lastIndex = 0
        let u
        while ((u = re.exec(src))) {
            if (mask[u.index] === 1) {
                unsupported.push({ form, line: src.slice(0, u.index).split('\n').length })
            }
        }
    }
    let re = CALL_RE()
    let m
    while ((m = re.exec(src))) {
        //落在字串、註解、樣板內者略過(例: 文字內提到 assert.deepEqual( )
        if (mask[m.index] === 0) {
            continue
        }
        let args = argsOf(src, m.index + m[0].length - 1)
        let expected = args.length >= 2 ? args[1] : ''
        calls.push({ method: m[1], index: m.index, line: src.slice(0, m.index).split('\n').length, argc: args.length, expected: expected.replace(/\s+/g, ' ').trim(), ...tokensOf(expected) })
    }
    return { kind, calls, unsupported }
}

/**
 * 掃描測試目錄內之 *.test.mjs,彙整非嚴格斷言之盤點
 *
 * @param {String} dir 輸入測試目錄
 * @returns {Object} 回傳 { nFiles, nLoose, nStrict, nNone, calls: [{ file, ... }], byMethod, nullInArray, hasNull, hasUndef, opaque, flagged, nNaive };flagged = 期望值含 null 或 undefined 記號之呼叫;nNaive = 以正規式粗算之同形呼叫數(含註解與字串內者, 故 ≥ calls 之數)
 * @example
 * auditDir('./test').nFiles // => 108
 */
let auditDir = (dir) => {
    let files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort()
    let out = { nFiles: files.length, nLoose: 0, nStrict: 0, nNone: 0, calls: [], nNaive: 0, unsupported: [], noneFiles: [], looseFiles: [], looseImports: [], looseImportsBad: [], weakNeg: [], weakNegBad: [], nAssertCalls: 0 }
    for (let f of files) {
        let src = fs.readFileSync(path.join(dir, f), 'utf8')
        let r = scanSource(src)
        //排程第 622 項 ①: 寬鬆之檔、對寬鬆模組之匯入、含 null / undefined 之負向斷言、呼叫總數(防空集合)
        if (r.kind === 'loose') {
            out.looseFiles.push(`test/${f}`)
        }
        for (let li of looseImportsOf(src)) {
            out.looseImports.push({ file: `test/${f}`, ...li })
            if (!LOOSE_IMPORT_ALLOW.includes(`test/${f}`)) {
                out.looseImportsBad.push({ file: `test/${f}`, ...li })
            }
        }
        for (let w of weakNegOf(src)) {
            out.weakNeg.push({ file: `test/${f}`, ...w })
            //允許之檔(守門本身之前提案: 示範嚴格版對 undefined 亦通過)不計為違規
            if (!LOOSE_IMPORT_ALLOW.includes(`test/${f}`)) {
                out.weakNegBad.push({ file: `test/${f}`, ...w })
            }
        }
        let mk = codeMask(src)
        let cr = CALL_ANY_RE()
        let cm
        while ((cm = cr.exec(src))) {
            out.nAssertCalls += mk[cm.index] === 1 ? 1 : 0
        }
        out[r.kind === 'loose' ? 'nLoose' : r.kind === 'strict' ? 'nStrict' : 'nNone']++
        if (r.kind === 'none') {
            out.noneFiles.push(`test/${f}`)
        }
        if (r.kind === 'loose') {
            out.nNaive += (src.match(CALL_RE()) || []).length
        }
        for (let c of r.calls) {
            out.calls.push({ file: `test/${f}`, ...c })
        }
        for (let u of r.unsupported) {
            out.unsupported.push({ file: `test/${f}`, ...u })
        }
    }
    out.byMethod = Object.fromEntries(METHODS.map((m) => [m, out.calls.filter((c) => c.method === m).length]))
    for (let k of ['nullInArray', 'hasNull', 'hasUndef', 'opaque']) {
        out[k] = out.calls.filter((c) => c[k]).length
    }
    //含 null / undefined 期望值者只計正向之斷言(見檔頭: 負向者寬鬆版較強, 不機械改嚴格)
    out.flagged = out.calls.filter((c) => (c.method === 'deepEqual' || c.method === 'equal') && (c.hasNull || c.hasUndef))
    return out
}

/**
 * 防空集合檢查: 掃描範圍壞了(找不到測試檔、檔數過少、檔數不合、掃到之斷言呼叫過少、寬鬆之檔之呼叫漏數)時為 false(盤點之結果不算數)
 * (排程第 622 項 ① 之前: 要求有寬鬆之檔 —— 全庫改嚴格後寬鬆之檔為 0 才是常態, 改以全部之斷言呼叫數 nAssertCalls ≥ 1000 判掃描未落空)
 *
 * @param {Object} r 輸入 auditDir 之結果
 * @returns {Boolean} 回傳是否合理
 * @example
 * isSane(auditDir('./test')) // => true
 */
let isSane = (r) => r.nFiles >= 50 && r.nLoose + r.nStrict + r.nNone === r.nFiles && r.nAssertCalls >= 1000 && (r.nLoose === 0 || (r.calls.length > 0 && r.calls.length >= Math.floor(r.nNaive * 0.9) && r.calls.length <= r.nNaive))

export { scanSource, auditDir, isSane, looseImportsOf, weakNegOf, LOOSE_IMPORT_ALLOW, METHODS, STRICT_OF }


//命令列
let isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
    let iDir = process.argv.indexOf('--dir')
    let testDir = iDir >= 0 ? path.resolve(process.argv[iDir + 1]) : path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
    let r = auditDir(testDir)
    console.log(`掃描 ${r.nFiles} 檔(非嚴格 ${r.nLoose}、嚴格 ${r.nStrict}、無 assert 匯入 ${r.nNone});斷言呼叫共 ${r.nAssertCalls};非嚴格斷言之呼叫 ${r.calls.length}(粗算 ${r.nNaive})`)
    console.log(`  對寬鬆 assert 模組之匯入 ${r.looseImports.length}(允許之檔以外 ${r.looseImportsBad.length};允許 = ${LOOSE_IMPORT_ALLOW.join('、')});含 null / undefined 之負向斷言(嚴格版較弱,須寫成明示之等價式)${r.weakNeg.length}(允許之檔以外 ${r.weakNegBad.length})`)
    console.log(`  依方法: ${Object.entries(r.byMethod).map(([k, v]) => `${k} ${v}`).join('、')}`)
    console.log(`  含 null / undefined 期望值之正向斷言(deepEqual、equal): ${r.flagged.length};期望值含識別字(靜態無從得知內容)${r.opaque};呼叫辨識不涵蓋之寫法 ${r.unsupported.length};匯入不被辨識之檔 ${r.nNone}`)
    if (process.argv.includes('--list')) {
        for (let c of r.flagged) {
            console.log(`  ${c.file}:${c.line} ${c.method}(…, ${c.expected.slice(0, 120)})`)
        }
        for (let u of r.unsupported) {
            console.log(`  ${u.file}:${u.line} 不涵蓋之寫法: ${u.form}`)
        }
        for (let f of r.noneFiles) {
            console.log(`  ${f} 匯入不被辨識(非 assert 或 assert/strict 之預設匯入)`)
        }
        for (let f of r.looseFiles) {
            console.log(`  ${f} 為寬鬆之檔(import assert from 'assert')`)
        }
        for (let i of r.looseImportsBad) {
            console.log(`  ${i.file}:${i.line} 對寬鬆 assert 模組之匯入: ${i.text}`)
        }
        for (let w of r.weakNegBad) {
            console.log(`  ${w.file}:${w.line} ${w.method} 之前兩個引數含 null / undefined(改寫為 assert.ok(x !== null && x !== undefined))`)
        }
    }
    if (!isSane(r)) {
        console.log('防空集合檢查不過: 掃描範圍或掃描結果不合理(結果不算數)')
        process.exit(2)
    }
    process.exit(r.flagged.length || r.unsupported.length || r.nNone || r.nLoose || r.looseImportsBad.length || r.weakNegBad.length ? 1 : 0)
}
