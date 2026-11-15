import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { scanPick, loadPick, stripComments } from '../src/eval/pickLoader.mjs'
import { makeTmp, FD_ROOT } from './tools/synthLedger.mjs'


//挑選模組之靜態檢查與載入(R-EV-5; docs/pick-contract.md §1)
const OK = `export const meta = { arms: ['X'], params: {}, desc: 'ok' }
export default function pick(ctx) { return [0] }
export function accept(sig, book) { return book.open < 3 }
`

describe('pickLoader:靜態檢查與載入', function () {
    let t
    before(() => {
        t = makeTmp('pickLoader')
    })
    after(() => {
        t.cleanup()
    })
    let put = (name, src) => {
        let fp = path.join(t.dir, name)
        fs.writeFileSync(fp, src, 'utf8')
        return fp
    }

    it('合格之模組通過;範例模組通過', () => {
        assert.deepEqual(scanPick(OK), [])
        assert.deepEqual(scanPick(fs.readFileSync(path.join(FD_ROOT, 'examples', 'pick_example.mjs'), 'utf8')), [])
    })

    it('匯入模組、檔案與行程介面、時鐘、內建亂數、計時器、動態執行 ⇒ 各自被指出', () => {
        //合約 §1: 不得 import / require; 不得用 process、globalThis、eval、Function、fetch、檔案與行程介面、計時器; 不得用 Date.now()、無參數之 new Date()、Math.random()
        let bad = [
            [`import fs from 'fs'\n${OK}`, /import/],
            [`${OK}\nlet m = await import('fs')`, /動態 import/],
            [`${OK}\nlet f = require('fs')`, /require/],
            [`${OK}\nlet e = process.env`, /process/],
            [`${OK}\nlet g = globalThis`, /globalThis/],
            [`${OK}\neval('1')`, /eval/],
            [`${OK}\nlet f = new Function('return 1')`, /Function/],
            [`${OK}\nfetch('x')`, /fetch/],
            [`${OK}\nlet t = Date.now()`, /時鐘/],
            [`${OK}\nlet t = new Date()`, /時鐘/],
            [`${OK}\nlet r = Math.random()`, /Math\.random/],
            [`${OK}\nsetTimeout(() => {}, 1)`, /計時器/],
        ]
        for (let [src, re] of bad) {
            let is = scanPick(src)
            assert(is.some((x) => re.test(x)), `應指出 ${re}: ${src.split('\n').slice(-1)[0]} → ${JSON.stringify(is)}`)
        }
        assert(scanPick('export function pick() {}').some((x) => /export default/.test(x)), '缺預設匯出')
    })

    it('註解內之字樣不誤判;帶參數之 new Date(x) 可用', () => {
        assert.deepEqual(scanPick(`// 不要用 Math.random() 與 process\n/* import fs from 'fs' */\n${OK}\nlet d = new Date(0)`), [])
        assert(!/Math\.random/.test(stripComments('let a = 1 // Math.random()')))
    })

    it('loadPick:回傳 pick / accept / meta;不存在或未過檢查者拋帶代碼之錯', async () => {
        let ok = await loadPick(put('ok.mjs', OK))
        assert.equal(typeof ok.pick, 'function')
        assert.equal(typeof ok.accept, 'function')
        assert.deepEqual(ok.meta.arms, ['X'])
        let noAcc = await loadPick(put('noacc.mjs', 'export default function pick(ctx) { return [] }\n'))
        assert.equal(noAcc.accept, null)
        await assert.rejects(() => loadPick(path.join(t.dir, 'none.mjs')), (e) => e.code === 'PICK_MISSING')
        await assert.rejects(() => loadPick(put('bad.mjs', `${OK}\nlet r = Math.random()`)), (e) => e.code === 'PICK_SCAN' && e.issues.length === 1)
        await assert.rejects(() => loadPick(put('badacc.mjs', 'export default function pick(ctx) { return [] }\nexport const accept = 1\n')), (e) => e.code === 'PICK_SCAN')
    })
})
