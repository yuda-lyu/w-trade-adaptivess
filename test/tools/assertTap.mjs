import assert from 'node:assert'
import strictAssert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'


//非嚴格斷言之動態盤點(規則 R-PKG-12; 排程第 614 項④; 補 test/tools/auditAssert.mjs 之靜態盤點: 期望值為變數者靜態無從得知其內容):
//  以 node 之預載(--import)包裝非嚴格之 assert.deepEqual / notDeepEqual / equal / notEqual: 每次呼叫先呼叫原函數(行為不變), 通過者另以對應之嚴格函數再試一次(不影響結果),
//  依呼叫處(file:line; 相對於工作目錄)彙整: 呼叫次數、寬鬆過而嚴格不過之次數(strictFail ⇒ 改為嚴格即轉紅)、期望值(第 2 個引數; 實際之值)含「陣列內之 null」(nullInArray)、null(hasNull)、undefined(hasUndef)之次數
//  另記每次呼叫之兩個運算元之型別組(types: { 'string|string': 次數 }; null 記為 'null'、陣列記為 'array'、型別化陣列記為 'typed'): 負向之斷言(notEqual、notDeepEqual)改嚴格時,
//    只有「兩運算元之型別不同(尤其 null / undefined 對他型)」者嚴格版才較寬鬆版弱; 同為字串或同為數字者等價(排程第 622 項 ①: 負向逐案改寫之依據);
//    負向之呼叫另記 nullishArgs(任一運算元於任何深度含 null / undefined 之次數; 物件與陣列之比較以此判定嚴格版是否較弱)
//  結束(process exit)時寫 ASSERT_TAP_OUT 指定之 JSON: { node, sites: { 'test/x.test.mjs:12': { method, calls, strictFail, nullInArray, hasNull, hasUndef, types, nullishArgs(負向者), weakNeg(嚴格版之負向者) } } }; 未設 ASSERT_TAP_OUT 者不寫、行為不變
//  用法(全套; 以 quiet-run --lock 執行): ASSERT_TAP_OUT=tmp/tap.json node --import ./test/tools/assertTap.mjs node_modules/mocha/bin/mocha.js --no-parallel "test/*.test.mjs" --timeout 180000
//  註: 只包裝本行程(--no-parallel 時測試皆在其內)之 assert 模組; 測試所起之子行程不包裝; 全套之執行時間約增 5%(每次呼叫多一次比較);
//    嚴格版(assert/strict 之預設匯入)只包裝負向之函數(notStrictEqual、notDeepStrictEqual 與其別名 notEqual、notDeepEqual; 見下): 通過後另以寬鬆版再核一次, 寬鬆版會拋者記 weakNeg(此為動態之網,
//    補 auditAssert 之靜態 weakNegOf 之漏: 運算元為變數者); 具名匯入(`import { notEqual } from 'node:assert/strict'`)取到原函數、不包裝 —— 該寫法於靜態盤點被判為匯入不被辨識而擋下;
//    寬鬆版之再核會重複取運算元之 getter(只讀、不改結果)
let out = process.env.ASSERT_TAP_OUT
let root = process.cwd().replace(/\\/g, '/')
let SELF = path.basename(fileURLToPath(import.meta.url))
let sites = {}
let orig = {}
for (let nm of ['deepEqual', 'notDeepEqual', 'equal', 'notEqual']) {
    orig[nm] = assert[nm]
}
let strictOf = { deepEqual: assert.deepStrictEqual, notDeepEqual: assert.notDeepStrictEqual, equal: assert.strictEqual, notEqual: assert.notStrictEqual }

//flagsOf, 期望值內之 null / undefined(含陣列內之 null; 遞迴陣列、物件、Map、Set; 循環參照只走一次)
let flagsOf = (v) => {
    let f = { nullInArray: false, hasNull: false, hasUndef: false }
    let seen = new Set()
    let walk = (x, inArr) => {
        if (x === null) {
            f.hasNull = true
            if (inArr) {
                f.nullInArray = true
            }
            return
        }
        if (x === undefined) {
            f.hasUndef = true
            return
        }
        if (typeof x !== 'object' || seen.has(x)) {
            return
        }
        seen.add(x)
        if (Array.isArray(x)) {
            for (let e of x) {
                walk(e, true)
            }
        }
        else if (x instanceof Map) {
            for (let [k, e] of x) {
                walk(k, false)
                walk(e, false)
            }
        }
        else if (x instanceof Set) {
            for (let e of x) {
                walk(e, false)
            }
        }
        else {
            for (let k of Object.keys(x)) {
                walk(x[k], false)
            }
        }
    }
    try {
        walk(v, false)
    }
    catch (err) {}
    return f
}

//typeOf, 運算元之型別名(記入 types): null 與陣列、型別化陣列分開記(typeof 皆為 object)
let typeOf = (v) => {
    if (v === null) {
        return 'null'
    }
    if (Array.isArray(v)) {
        return 'array'
    }
    if (ArrayBuffer.isView(v)) {
        return 'typed'
    }
    return typeof v
}

//siteOf, 呼叫處: 呼叫堆疊中第一個不在本檔與 node_modules 內之 .mjs 框
let siteOf = () => {
    for (let l of String(new Error().stack).split('\n')) {
        //框之位置: file:// 網址或平台路徑(Windows 之磁碟機代號、POSIX 之絕對路徑皆可), 以 .mjs:行:欄 結尾
        //  (路徑可含括號: 取到列尾之 .mjs:行:欄; file:// 網址不含空白〔已編碼〕; 前導之 `(` 去除)
        let m = /((?:file:\/\/)?\S+?\.mjs):(\d+):\d+\)?\s*$/.exec(l)
        if (m) {
            let raw = m[1].replace(/^\(/, '')
            let p = (raw.startsWith('file:') ? fileURLToPath(raw) : raw).replace(/\\/g, '/')
            if (p.endsWith(`/${SELF}`) || p.includes('/node_modules/')) {
                continue
            }
            //相對於工作目錄(Windows 之磁碟機代號大小寫不同者亦縮)
            let under = p.toLowerCase().startsWith(`${root.toLowerCase()}/`)
            return `${under ? p.slice(root.length + 1) : p}:${m[2]}`
        }
    }
    return 'unknown'
}

for (let nm of Object.keys(orig)) {
    assert[nm] = function (...args) {
        let r = orig[nm].apply(this, args)
        let site = siteOf()
        let s = sites[site] || (sites[site] = { method: nm, calls: 0, strictFail: 0, nullInArray: 0, hasNull: 0, hasUndef: 0, types: {} })
        s.calls++
        let tk = `${typeOf(args[0])}|${typeOf(args[1])}`
        s.types[tk] = (s.types[tk] || 0) + 1
        let fl = flagsOf(args[1])
        //負向之斷言: 任一運算元(任何深度)含 null / undefined 者另計(nullishArgs; 此時 null 與 undefined、陣列內之 null 於寬鬆比較下互通, 嚴格版較弱 ⇒ 須逐案判定)
        if (nm === 'notDeepEqual' || nm === 'notEqual') {
            let f0 = flagsOf(args[0])
            let nul = f0.hasNull || f0.hasUndef || fl.hasNull || fl.hasUndef
            s.nullishArgs = (s.nullishArgs || 0) + (nul ? 1 : 0)
        }
        s.nullInArray += fl.nullInArray ? 1 : 0
        s.hasNull += fl.hasNull ? 1 : 0
        s.hasUndef += fl.hasUndef ? 1 : 0
        try {
            strictOf[nm].apply(assert, args)
        }
        catch (err) {
            s.strictFail++
        }
        return r
    }
}

//嚴格版之負向函數(排程第 622 項 ①; assert/strict 之 notEqual、notDeepEqual 為 notStrictEqual、notDeepStrictEqual 之別名): 整庫改嚴格後 assertTap 之上列包裝不再作用於測試,
//  故另包裝嚴格版之負向函數 —— 通過時以對應之**寬鬆**負向函數再核一次(只讀、不影響結果): 寬鬆版會拋(兩運算元於寬鬆比較下相等: null 與 undefined、'1' 與 1、寬鬆 deepEqual 之盲區〔陣列內之 null〕)
//  而嚴格版通過者記 weakNeg(此站之負向斷言較其寬鬆原形弱; 須改寫為明示之等價式); 動態之網補靜態 weakNegOf 之漏(運算元為變數者)
for (let [nm, looseNm] of [['notStrictEqual', 'notEqual'], ['notDeepStrictEqual', 'notDeepEqual']]) {
    let o = strictAssert[nm]
    let wrapped = function (...args) {
        let r = o.apply(this, args)
        let site = siteOf()
        let s = sites[site] || (sites[site] = { method: nm, calls: 0, strictFail: 0, nullInArray: 0, hasNull: 0, hasUndef: 0, types: {} })
        s.calls++
        let tk = `${typeOf(args[0])}|${typeOf(args[1])}`
        s.types[tk] = (s.types[tk] || 0) + 1
        try {
            orig[looseNm].apply(assert, args)
        }
        catch (err) {
            s.weakNeg = (s.weakNeg || 0) + 1
        }
        return r
    }
    strictAssert[nm] = wrapped
    strictAssert[looseNm] = wrapped
}

process.on('exit', () => {
    if (out) {
        fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
        fs.writeFileSync(out, JSON.stringify({ node: process.version, sites }, null, 1), 'utf8')
    }
})
