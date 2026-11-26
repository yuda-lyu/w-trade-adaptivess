import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import looseAssert from 'assert'
import { spawnSync } from 'child_process'
import { pathToFileURL } from 'url'
import { FD_ROOT, makeTmp } from './tools/synthLedger.mjs'
import { scanSource, auditDir, isSane, looseImportsOf, weakNegOf, LOOSE_IMPORT_ALLOW, METHODS, STRICT_OF } from './tools/auditAssert.mjs'


//【排程第 622 項 ① 起】整庫改嚴格: 全部測試檔皆 `import assert from 'assert/strict'`(寬鬆之檔 0)⇒ 守門 = 新增一個寬鬆之檔、一個對寬鬆 assert 模組之匯入(守門本身之前提案除外)、
//  一個含 null / undefined 之負向斷言(嚴格版對 undefined 亦通過, 較寬鬆版弱)即紅(末案「全庫之盤點」); 其餘各案驗掃描器本身之鑑別力(含新增之 looseImportsOf、weakNegOf 與三種變異)
//  負向之斷言(notEqual、notDeepEqual 共 82 處)之逐案改寫與其依據(動態盤點之型別組)見 sgud 之 R-PKG-12 與 state_TEST
//非嚴格斷言之守門(規則 R-PKG-12; 排程第 614 項④): 測試檔內「期望值含 null / undefined 之非嚴格 assert.deepEqual / notDeepEqual / equal / notEqual」須為 0
//  規格之句 ⇒ 案:
//    「Node 24 之非嚴格 deepEqual 對陣列之 null 元素不比, 形同虛設」= 前提之核對(Node 若改了行為, 本案失敗, 須重新評估本守門是否仍必要)
//    「含 null / undefined 期望值者改嚴格」= 全庫之盤點為 0(盤點式 test/tools/auditAssert.mjs; 可重跑); 盤點之範圍不得為空(防空集合)與掃描器之鑑別力(各類、略過之寫法、多一個 / 少一個 / 改一個)
//  新測試一律 assert/strict(本檔即是); 既有之寬鬆斷言中期望值為變數者靜態無從判定, 由動態盤點補(見 sgud/exp 之該條), 此處只守字面值
describe('非嚴格斷言之守門: 期望值含 null / undefined 者須用嚴格函數(排程第 614 項④)', function () {
    this.timeout(60000)
    let t
    before(() => {
        t = makeTmp('assertStrict')
    })
    after(() => {
        t.cleanup()
    })

    it('前提(本守門之理由): 此 Node 之非嚴格 deepEqual 不比陣列內(任何深度)之 null 期望元素; null 與 undefined 於寬鬆比較下互通; 嚴格版皆拋; 物件之屬性、純量與實際為 null 者非盲區', () => {
        //盲區(寬鬆版不拋)
        for (let [a, b] of [[['m'], [null]], [[1], [null]], [[0], [null]], [[[1]], [[null]]], [{ a: ['x'] }, { a: [null] }], [[undefined], [null]], [[null], [undefined]], [['a', 'b'], ['a', null]]]) {
            assert.doesNotThrow(() => looseAssert.deepEqual(a, b), JSON.stringify([a, b]))
            assert.throws(() => assert.deepStrictEqual(a, b), JSON.stringify([a, b]))
        }
        assert.doesNotThrow(() => looseAssert.equal(undefined, null))
        assert.throws(() => assert.strictEqual(undefined, null))
        //非盲區(寬鬆版亦拋): 本守門只為盲區而設, 不放大
        for (let [a, b] of [[{ a: 'x' }, { a: null }], [{ a: null }, { a: 'x' }], [['m'], [undefined]], [[null], ['m']], ['x', null], [0, null]]) {
            assert.throws(() => looseAssert.deepEqual(a, b), JSON.stringify([a, b]))
        }
    })

    let FLAGS = (c) => [c.nullInArray, c.hasNull, c.hasUndef, c.opaque]
    let HEAD = 'import assert from \'assert\'\n'
    let scan = (body) => scanSource(`${HEAD}${body}`)
    it('掃描器: 各類之判定(陣列內之 null、物件屬性之 null、undefined、equal 之 null / undefined、變數、純字面值)與方法', () => {
        let cases = [
            ['assert.deepEqual(x, [1, null])', 'deepEqual', [true, true, false, false]],
            ['assert.deepEqual(x, [[1, [null]], 2])', 'deepEqual', [true, true, false, false]],
            ['assert.deepEqual(x, { a: [null] })', 'deepEqual', [true, true, false, false]],
            ['assert.deepEqual(x, { a: null })', 'deepEqual', [false, true, false, false]],
            ['assert.deepEqual(x, [1, undefined])', 'deepEqual', [false, false, true, false]],
            ['assert.equal(x, null)', 'equal', [false, true, false, false]],
            ['assert.equal(x, undefined)', 'equal', [false, false, true, false]],
            ['assert.notEqual(x, null)', 'notEqual', [false, true, false, false]],
            ['assert.notDeepEqual(x, [null])', 'notDeepEqual', [true, true, false, false]],
            ['assert.deepEqual(x, [1, \'a\', true, 2.5])', 'deepEqual', [false, false, false, false]],
            ['assert.deepEqual(x, expected)', 'deepEqual', [false, false, false, true]],
            ['assert.deepEqual(x, [a, null])', 'deepEqual', [true, true, false, true]],
            ['assert.deepEqual(x, y.map((z) => z.id))', 'deepEqual', [false, false, false, true]],
        ]
        for (let [body, method, flags] of cases) {
            let r = scan(body)
            assert.equal(r.kind, 'loose')
            assert.equal(r.calls.length, 1, body)
            assert.equal(r.calls[0].method, method, body)
            assert.deepEqual(FLAGS(r.calls[0]), flags, body)
        }
        //物件之鍵與屬性名不是值: { null: 1 }、x.null、{ undefined: 2 }
        for (let body of ['assert.deepEqual(x, { null: 1 })', 'assert.deepEqual(x, o.null)', 'assert.deepEqual(x, { undefined: 2 })']) {
            let c = scan(body).calls[0]
            assert.deepEqual([c.hasNull, c.hasUndef], [false, false], body)
        }
    })

    it('掃描器: 略過之寫法(字串、樣板、註解、正規式內之字樣; 嚴格函數; 他物件之同名方法; assert/strict 之檔)與多行、同行多個', () => {
        let none = [
            'assert.deepEqual(x, \'null\')',
            `assert.deepEqual(x, \`a \${y} null\`)`,
            'assert.deepEqual(x, /null/)',
            '// assert.deepEqual(x, [null])',
            '/* assert.equal(x, null) */',
            'let s = "assert.equal(x, null)"',
            'let s = `assert.equal(x, null)`',
            'let r = /assert\\.equal\\(x, null\\)/',
            'assert.deepStrictEqual(x, [null])',
            'assert.strictEqual(x, null)',
            'foo.assert.equal(x, null)',
            'myassert.equal(x, null)',
        ]
        for (let body of none) {
            let r = scan(body)
            assert.deepEqual(r.calls.filter((c) => c.hasNull || c.hasUndef), [], body)
        }
        //含字樣之字串 / 註解不影響其後之真呼叫之判定與計數
        let r = scan('let a = \'assert.equal(1, null)\' // assert.equal(2, null)\nassert.equal(x, null)\nassert.deepEqual(y, [1])')
        assert.deepEqual(r.calls.map((c) => [c.method, c.line, c.hasNull]), [['equal', 3, true], ['deepEqual', 4, false]], '字串與註解內之 assert.equal( 不計; 行號為含匯入列起算')
        //多行與同行多個
        let m = scan('assert.deepEqual(\n    x,\n    [\n        1,\n        null,\n    ],\n    \'訊息\'\n)\nassert.equal(a, 1); assert.equal(b, null)')
        assert.deepEqual(m.calls.map((c) => [c.method, c.argc, c.nullInArray, c.hasNull]), [['deepEqual', 3, true, true], ['equal', 2, false, false], ['equal', 2, false, true]])
        //第 3 個引數(訊息)之 null 不計: 只看期望值(第 2 個)
        assert.equal(scan('assert.equal(x, 1, \'訊息含 null\')').calls[0].hasNull, false)
        //嚴格之檔 ⇒ 不掃
        for (let imp of ['import assert from \'assert/strict\'\n', 'import { strict as assert } from \'assert\'\n']) {
            let s = scanSource(`${imp}assert.deepEqual(x, [null])`)
            assert.deepEqual([s.kind, s.calls.length], ['strict', 0], imp)
        }
        assert.deepEqual([scanSource('let x = 1').kind, scanSource('let x = 1').calls.length], ['none', 0])
    })

    it('負向之斷言(notEqual、notDeepEqual)不列入「含 null / undefined 期望值」: 寬鬆版較強(x 非 null 且非 undefined; 寬鬆之 deepEqual 之盲區使 notDeepEqual 於期望含 null 時拋), 不得機械改嚴格(複審 G-2)', () => {
        //前提: 寬鬆之 notEqual(undefined, null) 拋、嚴格之 notStrictEqual(undefined, null) 不拋 ⇒ 改嚴格使斷言變弱
        assert.throws(() => looseAssert.notEqual(undefined, null))
        assert.doesNotThrow(() => assert.notStrictEqual(undefined, null))
        assert.throws(() => looseAssert.notDeepEqual(['m'], [null]))
        let dir = path.join(t.dir, 'neg')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'n.test.mjs'), `${HEAD}assert.notEqual(x, null)\nassert.notDeepEqual(x, [null])\nassert.notEqual(y, undefined)\nassert.equal(z, null)\n`, 'utf8')
        let r = auditDir(dir)
        assert.deepEqual([r.calls.length, r.flagged.length], [4, 1], '四個呼叫皆計於 calls、只有正向之 equal 為 flagged')
        assert.deepEqual(r.flagged.map((c) => c.method), ['equal'])
    })

    it('呼叫辨識不涵蓋之寫法(裸引用〔別名、傳遞、call / apply / bind、可選呼叫〕、轉指〔解構、`let a = assert`〕、括號呼叫、點前後之空白或換行、可選鏈)被列出; 具名匯入使整檔判為 none; 字串與註解內者不計(複審 L-2、L2-4)', () => {
        let forms = [
            ['let eq = assert.equal', '裸引用'],
            ['eq = assert.deepEqual', '裸引用'],
            ['run(assert.equal, a, b)', '裸引用'],
            ['[1].forEach(assert.equal)', '裸引用'],
            ['let o = { eq: assert.equal }', '裸引用'],
            ['let f = c ? assert.equal : assert.strictEqual', '裸引用'],
            ['(0, assert.equal)(x, null)', '裸引用'],
            ['assert.equal.call(null, x, null)', '裸引用'],
            ['assert.equal?.(x, null)', '裸引用'],
            ['assert.equal(x, assert.equal)', '裸引用'],
            ['let { equal } = assert', '轉指'],
            ['let { deepEqual, notEqual } = assert', '轉指'],
            ['let a2 = assert', '轉指'],
            ['helper(assert)', '轉指'],
            ['assert[\'equal\'](x, null)', '括號呼叫'],
            ['assert\n    .equal(x, null)', '點之前後有空白或換行'],
            ['assert. equal(x, null)', '點之前後有空白或換行'],
            ['assert?.equal(x, null)', '可選鏈'],
        ]
        for (let [body, form] of forms) {
            let r = scan(body)
            assert.deepEqual(r.unsupported.map((u) => u.form), [form], body)
        }
        //不計: 一般之呼叫、字串、註解、assert.strict 之引用、他識別字
        for (let body of ['assert.equal(x, 1)', 'let s = \'let eq = assert.equal\'', '// let { equal } = assert', 'let { equal } = assert.strict', 'let assertion = 1', 'x.assert.equal(1, 1)', 'assert(x)']) {
            assert.deepEqual(scan(body).unsupported, [], body)
        }
        //具名匯入 / 匯入別名: 整檔判為 none(守門要求全庫為 0)
        for (let imp of ['import { equal } from \'assert\'\n', 'import a from \'assert\'\n', 'import assert, { strict } from \'assert\'\n']) {
            assert.equal(scanSource(`${imp}equal(x, null)`).kind, 'none', imp)
        }
    })

    it('盤點之鑑別力(三種變異): 多寫一個含 null 之斷言 ⇒ 多 1、少寫 ⇒ 少 1、把 null 改成數字 ⇒ 少 1; 防空集合檢查在空目錄、全嚴格之目錄皆不過', () => {
        let dir = path.join(t.dir, 'audit')
        fs.mkdirSync(dir, { recursive: true })
        let w = (name, src) => fs.writeFileSync(path.join(dir, name), src, 'utf8')
        let base = `${HEAD}assert.deepEqual(a, [1, null])\nassert.equal(b, 2)\n`
        w('x.test.mjs', base)
        let r0 = auditDir(dir)
        assert.deepEqual([r0.calls.length, r0.flagged.length, r0.nLoose], [2, 1, 1])
        w('x.test.mjs', `${base}assert.equal(c, undefined)\n`)
        assert.equal(auditDir(dir).flagged.length, 2, '多寫一個')
        w('x.test.mjs', `${HEAD}assert.equal(b, 2)\n`)
        assert.equal(auditDir(dir).flagged.length, 0, '少寫一個')
        w('x.test.mjs', `${HEAD}assert.deepEqual(a, [1, 0])\nassert.equal(b, 2)\n`)
        assert.equal(auditDir(dir).flagged.length, 0, '改一個數字')
        //防空集合: 空目錄與全嚴格之目錄之結果不算數(isSane 為 false)
        let empty = path.join(t.dir, 'empty')
        fs.mkdirSync(empty, { recursive: true })
        assert.equal(isSane(auditDir(empty)), false, '空目錄')
        assert.equal(isSane(auditDir(dir)), false, '檔數過少(<50)')
        let allStrict = path.join(t.dir, 'allStrict')
        fs.mkdirSync(allStrict, { recursive: true })
        for (let i = 0; i < 60; i++) {
            fs.writeFileSync(path.join(allStrict, `s${i}.test.mjs`), 'import assert from \'assert/strict\'\nassert.equal(1, 1)\n', 'utf8')
        }
        assert.equal(isSane(auditDir(allStrict)), false, '全嚴格而斷言呼叫過少(60 < 1000 ⇒ 掃描落空之徵)')
        //全嚴格(整庫改嚴格後之常態)而呼叫數夠 ⇒ 合理(寬鬆之檔為 0 不再是落空之徵; 排程第 622 項 ①)
        let allStrictBig = path.join(t.dir, 'allStrictBig')
        fs.mkdirSync(allStrictBig, { recursive: true })
        for (let i = 0; i < 60; i++) {
            fs.writeFileSync(path.join(allStrictBig, `s${i}.test.mjs`), `import assert from 'assert/strict'\n${'assert.equal(1, 1)\n'.repeat(20)}`, 'utf8')
        }
        assert.equal(isSane(auditDir(allStrictBig)), true, '全嚴格而呼叫數足(1200 ≥ 1000)')
        assert.equal(auditDir(allStrictBig).nLoose, 0)
        assert.deepEqual(METHODS, ['deepEqual', 'notDeepEqual', 'equal', 'notEqual'])
        assert.deepEqual(Object.keys(STRICT_OF), METHODS)
    })

    it('動態盤點 assertTap(補靜態之不足: 期望值為變數): 預載後記呼叫處之次數、期望值含陣列內 null / null / undefined 之次數、寬鬆過而嚴格不過者; 不改斷言之結果(通過者照過、不符者照拋); 未設輸出時不寫檔', () => {
        let dir = path.join(t.dir, 'tap')
        fs.mkdirSync(dir, { recursive: true })
        let lines = [
            'import assert from \'assert\'',
            'let exp = [\'m\', null]',
            'assert.deepEqual([\'m\', \'z\'], exp)',
            'assert.deepEqual({ a: 1 }, { a: 1 })',
            'assert.equal(\'1\', 1)',
            'assert.equal(undefined, null)',
            'for (let i = 0; i < 3; i++) assert.deepEqual([i], [i])',
            'try { assert.deepEqual([1], [2]) } catch (err) { console.log(\'thrown\') }',
            //嚴格版之負向(排程第 622 項 ①): 兩運算元於寬鬆比較下相等而嚴格版通過者記 weakNeg
            'import strictA from \'assert/strict\'',
            'strictA.notEqual(undefined, null)',
            'strictA.notEqual(\'a\', \'b\')',
            'strictA.notDeepEqual([null], [undefined])',
            'strictA.notStrictEqual(1, 2)',
            '',
        ]
        fs.writeFileSync(path.join(dir, 'sample.mjs'), lines.join('\n'), 'utf8')
        let outFp = path.join(dir, 'tap.json')
        let run = (env) => spawnSync(process.execPath, ['--import', pathToFileURL(path.join(FD_ROOT, 'test', 'tools', 'assertTap.mjs')).href, 'sample.mjs'], { cwd: dir, env: { ...process.env, ...env }, windowsHide: true, encoding: 'utf8' })
        let r0 = run({ ASSERT_TAP_OUT: '' })
        assert.equal(r0.status, 0, r0.stderr)
        assert.equal(r0.stdout.trim(), 'thrown', '不符者照拋(被 try 攔下)、通過者照過')
        assert.equal(fs.existsSync(outFp), false, '未設輸出 ⇒ 不寫檔')
        let r = run({ ASSERT_TAP_OUT: outFp })
        assert.equal(r.status, 0, r.stderr)
        assert.equal(r.stdout.trim(), 'thrown')
        let s = JSON.parse(fs.readFileSync(outFp, 'utf8')).sites
        let pick = (k) => [s[k].method, s[k].calls, s[k].strictFail, s[k].nullInArray, s[k].hasNull, s[k].hasUndef]
        assert.deepEqual(pick('sample.mjs:3'), ['deepEqual', 1, 1, 1, 1, 0], '期望值為變數而含陣列內 null; 實際 [m, z] 於寬鬆下通過、嚴格不過')
        assert.deepEqual(pick('sample.mjs:4'), ['deepEqual', 1, 0, 0, 0, 0], '無 null / undefined、嚴格亦過')
        assert.deepEqual(pick('sample.mjs:5'), ['equal', 1, 1, 0, 0, 0], '\'1\' 與 1: 寬鬆過、嚴格不過(非 null 之類)')
        assert.deepEqual(pick('sample.mjs:6'), ['equal', 1, 1, 0, 1, 0], 'undefined 與 null 互通: 寬鬆過、嚴格不過')
        assert.deepEqual(pick('sample.mjs:7'), ['deepEqual', 3, 0, 0, 0, 0], '同一呼叫處之多次呼叫合計')
        assert.equal('sample.mjs:8' in s, false, '拋錯者(不符)不記')
        //嚴格版之負向: undefined 與 null(寬鬆下相等)⇒ weakNeg 1; 'a' 與 'b' ⇒ 0; [null] 與 [undefined](寬鬆 deepEqual 相等)⇒ 1; 1 與 2 ⇒ 0; 型別組亦記
        let weakOf = (k) => [s[k].method, s[k].calls, s[k].weakNeg || 0, JSON.stringify(s[k].types)]
        assert.deepEqual(weakOf('sample.mjs:10'), ['notStrictEqual', 1, 1, '{"undefined|null":1}'])
        assert.deepEqual(weakOf('sample.mjs:11'), ['notStrictEqual', 1, 0, '{"string|string":1}'])
        assert.deepEqual(weakOf('sample.mjs:12'), ['notDeepStrictEqual', 1, 1, '{"array|array":1}'])
        assert.deepEqual(weakOf('sample.mjs:13'), ['notStrictEqual', 1, 0, '{"number|number":1}'])
        //目錄名含括號與空白: 站點鍵仍相對於工作目錄(複審 L2-5)
        let dir2 = path.join(dir, 'par (x) y')
        fs.mkdirSync(dir2, { recursive: true })
        fs.writeFileSync(path.join(dir2, 'sample.mjs'), lines.join('\n'), 'utf8')
        let out2 = path.join(dir, 'tap2.json')
        let r2 = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(FD_ROOT, 'test', 'tools', 'assertTap.mjs')).href, 'sample.mjs'], { cwd: dir2, env: { ...process.env, ASSERT_TAP_OUT: out2 }, windowsHide: true, encoding: 'utf8' })
        assert.equal(r2.status, 0, r2.stderr)
        assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(out2, 'utf8')).sites).sort(), ['sample.mjs:10', 'sample.mjs:11', 'sample.mjs:12', 'sample.mjs:13', 'sample.mjs:3', 'sample.mjs:4', 'sample.mjs:5', 'sample.mjs:6', 'sample.mjs:7'])
    })

    it('掃描器(排程第 622 項 ①): looseImportsOf 辨識對寬鬆 assert 模組之各種匯入(預設、命名空間、具名、副作用、require、動態 import、node: 前綴、多行),不計 assert/strict 與字串、註解內者; weakNegOf 辨識前兩個引數含 null / undefined 之負向斷言(寬鬆與嚴格之名)', () => {
        let loose = [
            'import assert from \'assert\'',
            'import assert from "assert"',
            'import assert from \'node:assert\'',
            'import * as assert from \'assert\'',
            'import { equal } from \'assert\'',
            'import assert, { strict } from \'assert\'',
            'import \'assert\'',
            'import {\n    equal,\n    deepEqual,\n} from \'assert\'',
            'let a = require(\'assert\')',
            'let a = require("node:assert")',
            'let a = await import(\'assert\')',
            //空白可省、重新匯出、經 createRequire / getBuiltinModule 載入(複審所見之漏報)
            'import{equal}from\'assert\'',
            'import a from\'assert\'',
            'let r = createRequire(import.meta.url)(\'assert\')',
            'let m = process.getBuiltinModule(\'node:assert\')',
            'export { equal } from \'assert\'',
        ]
        for (let src of loose) {
            assert.equal(looseImportsOf(src).length, 1, src)
        }
        let strict = [
            'import assert from \'assert/strict\'',
            'import assert from \'node:assert/strict\'',
            'import { strict as assert } from \'assert/strict\'',
            'let s = "import assert from \'assert\'"',
            '// import assert from \'assert\'',
            '/* let a = require(\'assert\') */',
            'let s = `import x from \'assert\'`',
            'import fs from \'fs\'',
            'import assertion from \'assertion\'',
            'let myimport = 1',
            'let r = createRequire(import.meta.url)(\'assert/strict\')',
            'let s = foo(\'assertion\')',
            'export { equal } from \'assert/strict\'',
            //import.meta、物件之鍵 import、一般函數之呼叫(字串引數恰為 assert)不是匯入(複審所見之誤報)
            'let u = import.meta.url\nlet k = \'assert\'',
            'let o = { url: import.meta.url, kind: \'assert\' }',
            'let o = { import: 1, name: \'assert\' }',
            'it(\'assert\', () => {})',
            'let b = src.includes(\'assert\')',
            'let p = path.join(import.meta.dirname, \'assert\')',
        ]
        for (let src of strict) {
            assert.deepEqual(looseImportsOf(src), [], src)
        }
        assert.deepEqual(looseImportsOf('import fs from \'fs\'\nimport a from \'assert\'\nlet x = 1').map((i) => i.line), [2], '行號')
        //weakNegOf: 前兩個引數含 null / undefined 記號者
        let weak = [
            'assert.notEqual(x, null)',
            'assert.notEqual(x, undefined)',
            'assert.notStrictEqual(x, null)',
            'assert.notStrictEqual(null, x)',
            'assert.notDeepEqual(x, [null])',
            'assert.notDeepStrictEqual(x, { a: undefined })',
            'assert.notEqual(f(a, b), null, \'訊息\')',
            'assert.notEqual(\n    x,\n    null,\n)',
            //`void 0`(= undefined)、assert.strict. 前綴、可選呼叫(複審所見之漏報)
            'assert.notEqual(x, void 0)',
            'assert.strict.notEqual(x, null)',
            'assert.notStrictEqual?.(x, null)',
        ]
        for (let src of weak) {
            assert.equal(weakNegOf(src).length, 1, src)
        }
        let fine = [
            'assert.notEqual(x, y)',
            'assert.notStrictEqual(x, 0)',
            'assert.notEqual(x, \'null\')',
            'assert.notEqual(x, y, \'訊息含 null\')',
            'assert.notEqual(x, o.null)',
            'assert.notEqual(x, { null: 1 })',
            'assert.notEqual(x, 0)',
            'assert.notEqual(f(x), g(y))',
            'assert.ok(x !== null && x !== undefined)',
            'assert.equal(x, null)',
            '// assert.notEqual(x, null)',
            'let s = \'assert.notEqual(x, null)\'',
            'foo.assert.notEqual(x, null)',
        ]
        for (let src of fine) {
            assert.deepEqual(weakNegOf(src), [], src)
        }
        assert.deepEqual(weakNegOf('let a = 1\nassert.notEqual(y, 2)\nassert.notEqual(x, null)').map((w) => [w.method, w.line]), [['notEqual', 3]], '行號')
    })

    it('盤點之守門(三種變異): 於全嚴格之樣本目錄新增一個寬鬆之檔 ⇒ nLoose 1 且列入 looseFiles; 新增對寬鬆模組之匯入(非允許之檔)⇒ looseImportsBad; 新增含 null 之負向斷言 ⇒ weakNegBad; 允許之檔(守門本身)之匯入與負向斷言不計為違規', () => {
        let dir = path.join(t.dir, 'guard')
        fs.mkdirSync(dir, { recursive: true })
        let w = (name, src) => fs.writeFileSync(path.join(dir, name), src, 'utf8')
        let clean = 'import assert from \'assert/strict\'\nassert.equal(1, 1)\nassert.notEqual(2, 3)\n'
        w('a.test.mjs', clean)
        let r0 = auditDir(dir)
        assert.deepEqual([r0.nLoose, r0.looseImportsBad.length, r0.weakNegBad.length], [0, 0, 0], '乾淨')
        w('b.test.mjs', 'import assert from \'assert\'\nassert.equal(1, 1)\n')
        let r1 = auditDir(dir)
        assert.deepEqual([r1.nLoose, r1.looseFiles, r1.looseImportsBad.map((i) => i.file)], [1, ['test/b.test.mjs'], ['test/b.test.mjs']], '新增寬鬆之檔')
        fs.rmSync(path.join(dir, 'b.test.mjs'))
        w('c.test.mjs', `${clean}import looseAssert from 'assert'\n`)
        let r2 = auditDir(dir)
        assert.deepEqual([r2.nLoose, r2.looseImportsBad.map((i) => i.file)], [0, ['test/c.test.mjs']], '嚴格之檔另匯入寬鬆模組')
        fs.rmSync(path.join(dir, 'c.test.mjs'))
        w('d.test.mjs', `${clean}assert.notEqual(x, null)\n`)
        let r3 = auditDir(dir)
        assert.deepEqual(r3.weakNegBad.map((x) => [x.file, x.method]), [['test/d.test.mjs', 'notEqual']], '含 null 之負向斷言')
        fs.rmSync(path.join(dir, 'd.test.mjs'))
        assert.deepEqual(auditDir(dir).weakNegBad, [], '還原後為 0')
        //允許之檔: 其寬鬆匯入與 weakNeg 計入 looseImports / weakNeg 但不計入 *Bad
        w('unit-assertStrict.test.mjs', `import assert from 'assert/strict'\nimport looseAssert from 'assert'\nassert.notStrictEqual(undefined, null)\n`)
        let r4 = auditDir(dir)
        assert.deepEqual([r4.looseImports.length, r4.looseImportsBad.length, r4.weakNeg.length, r4.weakNegBad.length], [1, 0, 1, 0])
        //允許之檔以其 test/<名> 為鍵(本庫之 test 目錄內之該檔)
        assert.deepEqual(LOOSE_IMPORT_ALLOW, ['test/unit-assertStrict.test.mjs'])
    })

    it('全庫之盤點: 範圍不為空(防空集合)、寬鬆之檔 0、對寬鬆模組之匯入(守門本身之前提案除外)0、含 null / undefined 之負向斷言 0、含 null / undefined 期望值之非嚴格斷言為 0(列 file:line)', () => {
        let r = auditDir(path.join(FD_ROOT, 'test'))
        let nTest = fs.readdirSync(path.join(FD_ROOT, 'test')).filter((f) => f.endsWith('.test.mjs')).length
        assert.equal(r.nFiles, nTest, '掃描之檔數 = 測試檔數')
        assert.ok(isSane(r), `防空集合: 檔 ${r.nFiles}、寬鬆 ${r.nLoose}、斷言呼叫 ${r.nAssertCalls}、呼叫(寬鬆)${r.calls.length}、粗算 ${r.nNaive}`)
        assert.ok(r.nStrict >= 100 && r.nAssertCalls >= 6000, `盤點之範圍(本庫 114 檔 / 約 9,500 呼叫): ${r.nStrict} / ${r.nAssertCalls}`)
        assert.deepEqual(r.looseFiles, [], '寬鬆之檔(import assert from \'assert\')須為 0: 一律 assert/strict')
        assert.equal(r.nLoose, 0)
        assert.deepEqual(r.looseImportsBad.map((i) => `${i.file}:${i.line} ${i.text}`), [], '對寬鬆 assert 模組之匯入(守門本身之前提案除外)')
        assert.deepEqual(r.looseImports.map((i) => i.file), LOOSE_IMPORT_ALLOW, '允許之檔確有該匯入(清單不過時)')
        assert.deepEqual(r.weakNegBad.map((w) => `${w.file}:${w.line} ${w.method}`), [], '含 null / undefined 之負向斷言(嚴格版對 undefined 亦通過): 改寫為 assert.ok(x !== null && x !== undefined)')
        assert.deepEqual(r.flagged.map((c) => `${c.file}:${c.line} ${c.method}(…, ${c.expected.slice(0, 60)})`), [])
        //盤點之涵蓋: 每個測試檔之匯入皆被辨識(none 為 0)、無不涵蓋之寫法(否則該寫法之斷言被靜默放行)
        assert.deepEqual(r.noneFiles, [], '匯入不被辨識之檔')
        assert.deepEqual(r.unsupported.map((u) => `${u.file}:${u.line} ${u.form}`), [], '不涵蓋之寫法')
    })
})
