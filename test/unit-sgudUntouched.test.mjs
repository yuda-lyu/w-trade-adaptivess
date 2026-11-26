import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { FD_ROOT, FD_TEST, makeTmp } from './tools/synthLedger.mjs'
import { needsDocLimitsOff, hasDocLimitsOff, offendersOf, snapshotOf, diffSnap, CHILD_ISOLATED } from './tools/sgudGuard.mjs'


//測試不得改寫入版控之文件(規則 R-PKG-10; 排程第 580 項之③)
//  成因: 輪末鉤子末段之專案文件自動整理(R-REC-17)以模組常數 FD_ROOT 之 sgud 為對象, 測試把專案之各夾改到暫存夾並不改變此路徑 ⇒ 未關閉(settings.rsi.docLimits = false)之測試,
//    於本庫之經驗檔 / 回饋檔逾上限(預設 30000 位元組)時改寫版控中之文件、多出 <名>_<年月日>.md
//  守門: ①靜態: 建專案(makeProject)且走到輪末鉤子(afterRound、redream)之測試檔須關閉自動整理(子行程以 ARSI_ROOT 指向暫存夾者除外)
//        ②動態(本檔載入之同一次執行): 每個測試前後比對本庫 sgud 各檔之大小與修改時間, 有變動者列出該測試與檔名(於全部測試之後一併失敗, 不中斷其餘測試)
//  守門之判定函數於 test/tools/sgudGuard.mjs(變異 TI 系列)

//②動態: 檔案頂層之 hook 套用於同一次執行之全部測試(mocha 之 root hook); 單獨跑本檔時只涵蓋本檔之測試
let sgudDir = path.join(FD_ROOT, 'sgud')
let lastSnap = snapshotOf(sgudDir)
let culprits = []
afterEach(function () {
    let now = snapshotOf(sgudDir)
    let ch = diffSnap(lastSnap, now)
    lastSnap = now
    if (ch.length && this.currentTest) {
        culprits.push(`${this.currentTest.file ? path.basename(this.currentTest.file) : '?'} 「${this.currentTest.fullTitle().slice(0, 100)}」改動了 sgud: ${ch.join('、')}`)
    }
})
after(function () {
    assert.deepEqual(culprits, [], '測試不得改寫入版控之文件(R-PKG-10): 見上列(各測試之專案須設 st.rsi.docLimits = false)')
})

describe('測試不得改寫入版控之文件(規則 R-PKG-10)', function () {
    this.timeout(120000)

    let t
    beforeEach(() => {
        t = makeTmp('sgudUntouched')
    })
    afterEach(() => {
        t.cleanup()
    })

    let put = (dir, name, text) => fs.writeFileSync(path.join(dir, name), text, 'utf8')

    it('①判定函數: 建專案且走到輪末鉤子(afterRound、redream)者須關閉自動整理;只建專案或只有鉤子之字樣者不在此類', () => {
        assert.equal(needsDocLimitsOff('let P = makeProject(st, {})\nawait P.domain.hooks.afterRound({})'), true)
        assert.equal(needsDocLimitsOff('let P = makeProject(st, {})\nawait P.redream(3)'), true)
        assert.equal(needsDocLimitsOff('let P = makeProject(st, {})'), false)
        assert.equal(needsDocLimitsOff('hooks.afterRound({})'), false)
        assert.equal(hasDocLimitsOff('st.rsi.docLimits = false'), true)
        assert.equal(hasDocLimitsOff('st.rsi = { ...st.rsi, autoFill: false, docLimits: false }'), true)
        assert.equal(hasDocLimitsOff('st.rsi.docLimits = true'), false)
        assert.equal(hasDocLimitsOff('docLimits: { maxBytes: 1 }'), false)
        assert.equal(hasDocLimitsOff('let x = 1'), false)
    })

    it('①掃描(合成之測試夾): 未關閉者列為違規;已關閉、設為其他值、子行程隔離者、守門自身、非建專案者之分類', () => {
        let dir = path.join(t.dir, 'tests')
        fs.mkdirSync(dir, { recursive: true })
        let body = (extra) => `let P = makeProject(st, {})\nawait P.domain.hooks.afterRound({})\n${extra}\n`
        put(dir, 'a-open.test.mjs', body('//未關閉'))
        put(dir, 'b-off.test.mjs', body('st.rsi.docLimits = false'))
        put(dir, 'c-true.test.mjs', body('st.rsi.docLimits = true'))
        put(dir, 'd-noHook.test.mjs', 'let P = makeProject(st, {})\n')
        put(dir, 'e-redream.test.mjs', 'let P = makeProject(st, {})\nawait P.redream(2)\n')
        put(dir, 'f-hookOnly.test.mjs', 'await x.afterRound({})\n')
        put(dir, CHILD_ISOLATED[0], body('//子行程隔離'))
        put(dir, 'unit-sgudUntouched.test.mjs', body('//守門自身'))
        put(dir, 'g-notTest.mjs', body('//非測試檔'))
        let r = offendersOf(dir)
        assert.deepEqual(r.scanned, ['a-open.test.mjs', 'b-off.test.mjs', 'c-true.test.mjs', 'e-redream.test.mjs', CHILD_ISOLATED[0]])
        assert.deepEqual(r.offenders, ['a-open.test.mjs', 'c-true.test.mjs', 'e-redream.test.mjs'])
        //allow 可指定(空 ⇒ 子行程隔離者亦列為違規)
        assert.deepEqual(offendersOf(dir, { allow: [] }).offenders, ['a-open.test.mjs', 'c-true.test.mjs', 'e-redream.test.mjs', CHILD_ISOLATED[0]])
    })

    it('①本庫之測試夾: 建專案且走到輪末鉤子之測試檔皆已關閉自動整理(違規 0);已知之 10 檔皆被判為須關閉且已關閉', () => {
        let r = offendersOf(FD_TEST)
        assert.deepEqual(r.offenders, [], `未關閉專案文件自動整理(st.rsi.docLimits = false)之測試: ${r.offenders.join('、')}`)
        //已知須關閉之檔(掃描範圍壞掉而掃不到時不會靜默通過): 存在者必在掃描結果內且已關閉
        for (let n of ['aliasBase', 'dreamOnly', 'envChangedHint', 'evalHints', 'fillBacklog', 'fillRevise', 'fillRun', 'guardInline', 'outwardSaturated', 'signsClause']) {
            let f = `unit-${n}.test.mjs`
            let fp = path.join(FD_TEST, f)
            if (fs.existsSync(fp)) {
                let text = fs.readFileSync(fp, 'utf8')
                assert(r.scanned.includes(f) && needsDocLimitsOff(text) && hasDocLimitsOff(text), `${f}: 須被判為建專案且走到輪末鉤子、且已關閉自動整理`)
            }
        }
    })

    it('②快照與差異: 新增、刪除、變動(大小)各一列;無變動 ⇒ [];目錄不存在 ⇒ 空表', () => {
        let dir = path.join(t.dir, 'sg')
        fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
        put(dir, 'x.md', 'aaaa')
        put(dir, 'y.md', 'bbbbbb')
        put(path.join(dir, 'sub'), 'z.md', 'cc')
        let s0 = snapshotOf(dir)
        assert.deepEqual(Object.keys(s0).sort(), ['sub/z.md', 'x.md', 'y.md'])
        assert.deepEqual(diffSnap(s0, snapshotOf(dir)), [])
        //同大小之改寫(只有修改時間不同)亦須偵測
        fs.utimesSync(path.join(dir, 'sub', 'z.md'), 1, 2)
        assert.deepEqual(diffSnap(s0, snapshotOf(dir)), ['變動 sub/z.md'])
        let s1 = snapshotOf(dir)
        put(dir, 'x.md', 'aaaaaaaaaaaa')
        fs.rmSync(path.join(dir, 'y.md'))
        put(path.join(dir, 'sub'), 'w.md', 'dddd')
        assert.deepEqual(diffSnap(s1, snapshotOf(dir)), ['新增 sub/w.md', '變動 x.md', '刪除 y.md'])
        assert.deepEqual(snapshotOf(path.join(t.dir, 'none')), {})
    })
})
