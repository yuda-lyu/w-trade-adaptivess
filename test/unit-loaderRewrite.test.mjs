import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { loadPick, loadExt } from '../src/eval/pickLoader.mjs'
import { isIntegrityError } from '../src/eval/intrinsics.mjs'
import { makeTmp } from './tools/synthLedger.mjs'


//載入器之匯入快取鍵(Gitea #161; 規則 R-EV-39): loadPick(挑選模組)與 loadExt(擴充診斷模組)皆以「本次所讀原始碼之內容雜湊」為動態匯入之快取鍵, 不用修改時間
//  同一路徑於短時間內被重寫者, 兩次之修改時間可相同(檔案系統之時間解析度): 以修改時間為鍵會取回先前已載入之舊模組 ⇒ 所執行之程式與本次所檢查、所回報之原始碼(src / bytes / meta)不同份
//  本檔不依賴計時: 以 utimes 把每次寫入後之修改時間釘成同一個值, 使「修改時間相同」必然發生(而非等它偶發)
const MTIME = 1700000000.5 //秒(釘住之修改時間)
//put, 寫入並把修改時間釘成 MTIME; 回傳寫入後實際之 mtimeMs(測試前提: 各次寫入之值相同)
let put = (fp, code) => {
    fs.writeFileSync(fp, code, 'utf8')
    fs.utimesSync(fp, MTIME, MTIME)
    return fs.statSync(fp).mtimeMs
}
let pickCode = (i) => `export const meta = { arms: ['A01_nt'], desc: 'v${i}' }\nexport default function pick(ctx) {\n    return [${i}]\n}\n`
let extCode = (i) => `export default function (api) {\n    return { text: 'v${i}' }\n}\n`

describe('載入器之匯入快取鍵 = 本次所讀原始碼之內容雜湊(不用修改時間)', function () {
    let t
    before(() => {
        t = makeTmp('loaderRewrite')
    })
    after(() => {
        t.cleanup()
    })

    it('loadPick:同一路徑連續寫入不同內容(修改時間皆相同)各載入一次 ⇒ 每次執行到的 pick、取得之 meta 與 src 皆為該次寫入之內容', async () => {
        let fp = path.join(t.dir, 'pick.mjs')
        let m0 = null
        for (let i = 0; i < 8; i++) {
            let m = put(fp, pickCode(i))
            m0 = m0 === null ? m : m0
            assert.equal(m, m0, `前提: 第 ${i} 次寫入後之 mtimeMs 與第 0 次相同(否則本案不具鑑別力)`)
            let r = await loadPick(fp)
            //對應 #161: 所執行者(pick)、所檢查與回報者(src / bytes / meta)須為同一份
            assert.deepEqual(r.pick({}), [i], `第 ${i} 次: 執行到舊模組`)
            assert.equal(r.meta.desc, `v${i}`, `第 ${i} 次: meta 為舊模組者`)
            assert.equal(r.src, pickCode(i), `第 ${i} 次: src`)
            assert.equal(r.bytes, Buffer.byteLength(pickCode(i)))
        }
    })

    it('loadExt:同一路徑連續寫入不同內容(修改時間皆相同)各載入一次 ⇒ 每次執行到的預設匯出皆為該次寫入之內容', async () => {
        let fp = path.join(t.dir, 'ext.mjs')
        let m0 = null
        for (let i = 0; i < 8; i++) {
            let m = put(fp, extCode(i))
            m0 = m0 === null ? m : m0
            assert.equal(m, m0, `前提: 第 ${i} 次寫入後之 mtimeMs 與第 0 次相同`)
            let r = await loadExt(fp)
            assert.equal(r.name, 'ext')
            assert.deepEqual(r.fn({}), { text: `v${i}` }, `第 ${i} 次: 執行到舊模組`)
        }
    })

    it('內容相同者共用同一份模組(不論重寫後修改時間是否不同);路徑不同者各有其模組', async () => {
        let fp = path.join(t.dir, 'same.mjs')
        fs.writeFileSync(fp, pickCode(7), 'utf8')
        fs.utimesSync(fp, MTIME, MTIME)
        let a = await loadPick(fp)
        fs.writeFileSync(fp, pickCode(7), 'utf8')
        fs.utimesSync(fp, MTIME + 100, MTIME + 100)
        let b = await loadPick(fp)
        assert.notEqual(fs.statSync(fp).mtimeMs, MTIME * 1000, '前提: 第二次之修改時間與第一次不同')
        assert.equal(b.pick, a.pick, '同一內容 = 同一份模組(原以修改時間為鍵者,修改時間不同即重新載入)')
        let fp2 = path.join(t.dir, 'same2.mjs')
        put(fp2, pickCode(7))
        let c = await loadPick(fp2)
        assert.notEqual(c.pick, a.pick, '路徑不同 ⇒ 不同之模組(模組層之狀態不跨檔案共用)')
        assert.deepEqual(c.pick({}), [7])
        //loadExt 同
        let fe = path.join(t.dir, 'sameExt.mjs')
        put(fe, extCode(3))
        let e1 = await loadExt(fe)
        fs.writeFileSync(fe, extCode(3), 'utf8')
        fs.utimesSync(fe, MTIME + 100, MTIME + 100)
        let e2 = await loadExt(fe)
        assert.equal(e2.fn, e1.fn)
    })

    //withFirstRead, 模擬「讀檔與匯入之間來源檔被改動」: 磁碟上為 B, 載入器第一次以 'utf8' 讀該檔(讀入原始碼)得到 A 之文字;
    //  其後載入器之重讀(同為 'utf8')依 after 而定: 'disk' = 讀磁碟實況(B); 'throw' = 讀不到(ENOENT)。Node 自己匯入模組所用之讀檔不帶 'utf8' 引數, 不受替身影響
    let withFirstRead = async (fp, fake, fn, after = 'disk') => {
        let orig = fs.readFileSync
        let n = 0
        fs.readFileSync = function (p, ...rest) {
            if (rest[0] === 'utf8' && path.resolve(String(p)) === path.resolve(fp)) {
                n++
                if (n === 1) {
                    return fake
                }
                if (after === 'throw') {
                    throw Object.assign(new Error('gone'), { code: 'ENOENT' })
                }
            }
            return orig.call(fs, p, ...rest)
        }
        try {
            return await fn()
        }
        finally {
            fs.readFileSync = orig
        }
    }

    it('讀檔與匯入之間來源檔被改動(讀入 A、磁碟為 B):匯入後重讀發現內容不同 ⇒ 拋 PICK_CHANGED / EXT_CHANGED,且該鍵不再被信任 —— 來源檔改回 A 後再載入執行到的是 A(不是被誤掛在 A 之鍵下之 B)', async () => {
        //loadPick
        let fp = path.join(t.dir, 'race.mjs')
        put(fp, pickCode(2))
        await assert.rejects(() => withFirstRead(fp, pickCode(1), () => loadPick(fp)), (e) => e.code === 'PICK_CHANGED')
        put(fp, pickCode(1))
        let a = await loadPick(fp)
        assert.deepEqual(a.pick({}), [1], '來源檔改回 A 後執行到 A')
        assert.equal(a.src, pickCode(1))
        //再載入一次仍是 A(同內容共用模組不變)
        assert.equal((await loadPick(fp)).pick, a.pick)
        //loadExt
        let fe = path.join(t.dir, 'raceExt.mjs')
        put(fe, extCode(2))
        await assert.rejects(() => withFirstRead(fe, extCode(1), () => loadExt(fe)), (e) => e.code === 'EXT_CHANGED')
        put(fe, extCode(1))
        let b = await loadExt(fe)
        assert.deepEqual(b.fn({}), { text: 'v1' })
    })

    it('匯入後重讀不到來源檔(無從核對):本次不判定(不拋錯), 但該鍵不再被信任 —— 其後來源檔為 A 時執行到 A(loadPick、loadExt 各一)', async () => {
        //磁碟為 B、載入器讀入 A 之文字、匯入 B、重讀讀不到 ⇒ 回傳(所執行者為 B, 與 src 不同份: 讀碼端無從察覺); 之後磁碟為 A ⇒ 重新匯入而得 A
        let fp = path.join(t.dir, 'gone.mjs')
        put(fp, pickCode(2))
        let r1 = await withFirstRead(fp, pickCode(1), () => loadPick(fp), 'throw')
        assert.equal(r1.src, pickCode(1))
        assert.deepEqual(r1.pick({}), [2], '前提: 該次確實執行到磁碟上之 B')
        put(fp, pickCode(1))
        assert.deepEqual((await loadPick(fp)).pick({}), [1], '之後執行到 A(該鍵已登記為不可再信)')
        let fe = path.join(t.dir, 'goneExt.mjs')
        put(fe, extCode(2))
        let e1 = await withFirstRead(fe, extCode(1), () => loadExt(fe), 'throw')
        assert.deepEqual(e1.fn({}), { text: 'v2' })
        put(fe, extCode(1))
        assert.deepEqual((await loadExt(fe)).fn({}), { text: 'v1' })
    })

    it('匯入失敗者亦不使該鍵被快取之失敗佔住:讀入 A、磁碟為匯入時失敗之 B(頂層拋錯或語法錯誤;Node 把頂層拋錯之模組亦以網址快取)⇒ 匯入失敗;來源檔改回 A 後再載入成功(loadPick、loadExt 各一)', async () => {
        for (let [nm, bad] of [['頂層拋錯', 'throw new Error("B boom")\nexport default function pick(ctx) {\n    return []\n}\n'], ['語法錯誤', 'export default function pick(ctx) {\n']]) {
            let fp = path.join(t.dir, `broken_${nm}.mjs`)
            put(fp, bad)
            await assert.rejects(() => withFirstRead(fp, pickCode(1), () => loadPick(fp)), (e) => e instanceof Error && e.code !== 'PICK_CHANGED', `${nm}`)
            put(fp, pickCode(1))
            assert.deepEqual((await loadPick(fp)).pick({}), [1], `${nm}: 改回 A 後`)
            let fe = path.join(t.dir, `brokenExt_${nm}.mjs`)
            put(fe, bad.replace('pick(ctx)', '(api)'))
            await assert.rejects(() => withFirstRead(fe, extCode(1), () => loadExt(fe)), (e) => e instanceof Error && e.code !== 'EXT_CHANGED', `${nm}`)
            put(fe, extCode(1))
            assert.deepEqual((await loadExt(fe)).fn({}), { text: 'v1' }, `${nm}: ext 改回 A 後`)
        }
    })

    it('同一實體檔之不同路徑(目錄連結)共用同一份模組身分:經實體路徑被判為被改動之鍵,經連結路徑再載入亦不放行(登記以實體路徑為準)', async () => {
        let real = path.join(t.dir, 'realdir')
        let link = path.join(t.dir, 'linkdir')
        fs.mkdirSync(real, { recursive: true })
        fs.symlinkSync(real, link, 'junction')
        try {
            let fpReal = path.join(real, 'p.mjs')
            let fpLink = path.join(link, 'p.mjs')
            put(fpReal, pickCode(2))
            await assert.rejects(() => withFirstRead(fpReal, pickCode(1), () => loadPick(fpReal)), (e) => e.code === 'PICK_CHANGED')
            put(fpReal, pickCode(1))
            assert.deepEqual((await loadPick(fpLink)).pick({}), [1], '經連結路徑載入執行到 A')
            assert.equal((await loadPick(fpReal)).pick, (await loadPick(fpLink)).pick, '兩種路徑共用同一份模組')
        }
        finally {
            fs.rmdirSync(link) //只拆連結本身(junction 以 rmdir 移除)
        }
        assert(fs.existsSync(path.join(real, 'p.mjs')), '連結拆除後目標完好')
    })

    it('來源檔含 CRLF 與 BOM 且載入期間未被改動:不誤判為被改動(重讀之內容雜湊與匯入前相同),src 為原字串', async () => {
        let code = `﻿${pickCode(4).replace(/\n/g, '\r\n')}`
        let fp = path.join(t.dir, 'crlf.mjs')
        put(fp, code)
        let r = await loadPick(fp)
        assert.equal(r.src, code)
        assert.deepEqual(r.pick({}), [4])
        let fe = path.join(t.dir, 'crlfExt.mjs')
        put(fe, `﻿${extCode(4).replace(/\n/g, '\r\n')}`)
        assert.deepEqual((await loadExt(fe)).fn({}), { text: 'v4' })
    })

    it('成品因頂層改內建物件而被拒(EVAL_INTEGRITY)者:呼叫端還原內建物件後同內容再載入 ⇒ 重新執行頂層程式而再被拒(不由快取放行);loadPick(where = pick-load)與 loadExt(where = ext-load)各一', async () => {
        let origTrunc = Math.trunc
        try {
            for (let [nm, load, where, code] of [
                ['pick', loadPick, 'pick-load', 'Math.trunc = Math.floor\nexport default function pick(ctx) {\n    return []\n}\n'],
                ['ext', loadExt, 'ext-load', 'Math.trunc = Math.floor\nexport default function (api) {\n    return { text: 1 }\n}\n'],
            ]) {
                let fp = path.join(t.dir, `integ_${nm}.mjs`)
                put(fp, code)
                for (let round = 0; round < 5; round++) {
                    let err = null
                    try {
                        await load(fp)
                    }
                    catch (e) {
                        err = e
                    }
                    Math.trunc = origTrunc //呼叫端還原
                    assert(err && isIntegrityError(err), `${nm} 第 ${round} 次: 應拋完整性錯誤: ${err && err.message}`)
                    assert.equal(err.code, 'EVAL_INTEGRITY')
                    assert.equal(err.where, where, `${nm} 第 ${round} 次`)
                }
                //內容改為不改內建物件之版本 ⇒ 照常載入
                put(fp, code.replace('Math.trunc = Math.floor\n', ''))
                let ok = await load(fp)
                assert(typeof (ok.pick || ok.fn) === 'function')
            }
        }
        finally {
            Math.trunc = origTrunc
        }
    })

    it('內容相同而寫回:A → B → A 各載入一次 ⇒ 第三次取回 A 之模組(內容雜湊相同), 第二次為 B', async () => {
        let fp = path.join(t.dir, 'aba.mjs')
        put(fp, pickCode(1))
        let a1 = await loadPick(fp)
        put(fp, pickCode(2))
        let b = await loadPick(fp)
        put(fp, pickCode(1))
        let a2 = await loadPick(fp)
        assert.deepEqual(a1.pick({}), [1])
        assert.deepEqual(b.pick({}), [2])
        assert.deepEqual(a2.pick({}), [1])
        assert.equal(a2.pick, a1.pick)
        assert.notEqual(b.pick, a1.pick)
    })
})
