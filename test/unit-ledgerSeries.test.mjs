import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { buildLedger, alignSeries } from '../src/eval/ledgerBuild.mjs'
import { loadLedger } from '../src/eval/ledger.mjs'
import { FD_ROOT, makeTmp, makeTrainEvaluator as makeEvaluator } from './tools/synthLedger.mjs'
//makeEvaluator: 建出之帳本即訓練期帳本 ⇒ makeTrainEvaluator 補上 L.ntStatic 再建評估器(見 test/tools/synthLedger.mjs)


//外部序列之建置與對位(規則 R-EV-34): alignSeries、buildLedger 之 seriesDir、命令列之 settings.source.seriesDir; 序列之名稱與值皆為合成之中性資料
//  合約 §3: 序列之 time = K 棒之開盤時間(與 K 線之 time 同一字串約定);建帳本時對位到棒並於帳本終點(endTime)截斷

let T0 = Date.UTC(2022, 6, 1) //2022-07-01T00:00:00(無時區之 K 線時間以 UTC 假想時區組字串)
let timeOf = (i) => new Date(T0 + i * 4 * 3600000).toISOString().slice(0, 19)
let same = (a, b) => Object.is(a, b)
let sameArr = (a, b) => a.length === b.length && Array.from(a).every((v, i) => same(v, b[i]))

//writeLibrary, 合成之策略庫(ohlc 400 根、1 個因子、2 隻策略): 供 buildLedger 讀取
let N_BARS_LIB = 400
let writeLibrary = (root) => {
    fs.mkdirSync(path.join(root, 'ohlc'), { recursive: true })
    fs.mkdirSync(path.join(root, 'param'), { recursive: true })
    fs.mkdirSync(path.join(root, 'strategies'), { recursive: true })
    let ohlc = []
    let c = 100
    for (let i = 0; i < N_BARS_LIB; i++) {
        let o = c
        c = 100 + 6 * Math.sin(i / 7) + 2 * Math.sin(i / 2.3)
        ohlc.push({ time: timeOf(i), Open: o, High: Math.max(o, c) + 1.5, Low: Math.min(o, c) - 1.5, Close: c, Volumn: 1000 + i })
    }
    fs.writeFileSync(path.join(root, 'ohlc', 'SYM_4hr.json'), JSON.stringify(ohlc), 'utf8')
    let param = []
    for (let i = 0; i < N_BARS_LIB; i++) {
        param.push({ time: timeOf(i), param: Math.sin(i / 5) })
    }
    fs.writeFileSync(path.join(root, 'param', 'price_x.json'), JSON.stringify(param), 'utf8')
    let st = (mode, sym) => ({ mode, settings: { rTakeProfit: 0.02, rStopLoss: 0.02, rFee: 0.0005 }, conds: [{ key: 'price_x', sym, th: 0 }], levelNumTrade: 1, numTrade: 0 })
    fs.writeFileSync(path.join(root, 'strategies', 'a.json'), JSON.stringify(st('long', '>')), 'utf8')
    fs.writeFileSync(path.join(root, 'strategies', 'b.json'), JSON.stringify(st('short', '<')), 'utf8')
}

//writeSeriesDir, 合成之外部序列夾(格式同因子檔: [{ time, value }]):
//  ser_b: 值 = 1000 + 棒序號, 涵蓋全部 400 棒(含帳本終點以後者), 其中棒序號 % 50 === 7 之棒不列;ser_a: 值 = 棒序號 × 0.5, 終點以後之列值為 7777777;
//  Zed: 只有 3 個值(其一為數字字串);_report.json: 底線起首者略過
let END_BAR = 300
let writeSeriesDir = (dir) => {
    fs.mkdirSync(dir, { recursive: true })
    let b = []
    for (let i = 0; i < N_BARS_LIB; i++) {
        if (i % 50 !== 7) {
            b.push({ time: timeOf(i), value: 1000 + i })
        }
    }
    let a = []
    for (let i = 0; i < N_BARS_LIB; i++) {
        a.push({ time: timeOf(i), value: i < END_BAR ? i * 0.5 : 7777777 })
    }
    let z = [{ time: timeOf(10), value: 5 }, { time: timeOf(11), value: '2.5' }, { time: timeOf(12), value: -1 }]
    fs.writeFileSync(path.join(dir, 'ser_b.json'), JSON.stringify(b), 'utf8')
    fs.writeFileSync(path.join(dir, 'ser_a.json'), JSON.stringify(a), 'utf8')
    fs.writeFileSync(path.join(dir, 'Zed.json'), JSON.stringify(z), 'utf8')
    fs.writeFileSync(path.join(dir, '_report.json'), JSON.stringify({ note: '底線起首者不當序列' }), 'utf8')
}
//期望之對位結果(序 = 檔名之字典序: Zed、ser_a、ser_b)
let expectedSer = (nBars) => {
    let out = []
    let zed = new Float64Array(nBars).fill(NaN)
    zed[10] = 5
    zed[11] = 2.5
    zed[12] = -1
    out.push(zed)
    out.push(Float64Array.from({ length: nBars }, (_, i) => i * 0.5))
    out.push(Float64Array.from({ length: nBars }, (_, i) => (i % 50 === 7 ? NaN : 1000 + i)))
    return out
}


describe('外部序列之對位(alignSeries)', function () {
    let kp = new Map([['2024-01-01T00:00:00', 0], ['2024-01-01T04:00:00', 1], ['2024-01-01T08:00:00', 2], ['2024-01-01T12:00:00', 3]])

    it('依棒之時間對位;對不到棒之列(含終點以後者)與非有限數之值略過;未填入之棒為 NaN', () => {
        //合約 §3: time = 棒之開盤時間; 棒以外(含 endTime 以後)之列不入帳本
        let a = alignSeries([
            { time: '2024-01-01T04:00:00', value: 1.5 },
            { time: '2024-01-01T08:00:00', value: '2.5' },
            { time: '2024-01-01T12:00:00', value: null },
            { time: '2024-01-01T16:00:00', value: 9 }, //終點以後: 對不到棒
            { time: '2024-01-01T00:00:00', value: 'x' },
            null,
        ], kp, 4)
        assert(a instanceof Float64Array && a.length === 4)
        assert(Number.isNaN(a[0]) && a[1] === 1.5 && a[2] === 2.5 && Number.isNaN(a[3]))
    })

    it('非陣列之輸入、非物件之元素、缺值與非數字之值(空字串、空白、布林、陣列、物件、無限大)皆略過,不拋錯', () => {
        assert.deepEqual(Array.from(alignSeries(null, kp, 2)).map((v) => Number.isNaN(v)), [true, true])
        assert.deepEqual(Array.from(alignSeries({ time: '2024-01-01T00:00:00', value: 1 }, kp, 2)).map((v) => Number.isNaN(v)), [true, true])
        let bad = [undefined, 3, 'x', [], [1], true]
        let vals = ['', '   ', true, false, [], [5], {}, Infinity, -Infinity, NaN, undefined, null, 'abc', 10n]
        let a = alignSeries(bad, kp, 2)
        assert(Number.isNaN(a[0]) && Number.isNaN(a[1]), `非物件之元素不得入帳: ${Array.from(a)}`)
        //每個無效值各自單獨對位(不可與其他值同列: 互相矛盾之值會令該棒取缺值而掩蓋誤收)
        for (let value of vals) {
            let one = alignSeries([{ time: '2024-01-01T00:00:00', value }], kp, 2)
            assert(Number.isNaN(one[0]), `不得把無效值當數值: ${typeof value === 'bigint' ? `${value}n` : JSON.stringify(value)} → ${one[0]}`)
        }
        //時間欄非字串(如毫秒數)對不到棒
        assert(Number.isNaN(alignSeries([{ time: 0, value: 1 }, { value: 2 }], kp, 2)[0]))
    })

    it('同一時間有多筆有效值:相同者照收、相異者(互相矛盾)該棒取缺值,與列之順序無關;無效列視為未列;有限數之數字字串照收', () => {
        //收嚴: 遇衝突不靜默擇一(取首筆或末筆), 結果不隨列之順序而變
        let rows = [
            { time: '2024-01-01T00:00:00', value: 1 },
            { time: '2024-01-01T00:00:00', value: 2 }, //與前一筆相異 ⇒ 棒 0 取缺值
            { time: '2024-01-01T00:00:00', value: 1 }, //矛盾既成, 後續同棒之列不得再填入
            { time: '2024-01-01T04:00:00', value: ' 3.25 ' },
            { time: '2024-01-01T04:00:00', value: 3.25 }, //相同 ⇒ 照收
            { time: '2024-01-01T04:00:00', value: null }, //無效列視為未列
            { time: '2024-01-01T08:00:00', value: 0 },
            { time: '2024-01-01T08:00:00', value: -0 }, //0 與 -0 視為相同
            { time: '2024-01-01T12:00:00', value: -0.5 },
        ]
        let stat = {}
        let a = alignSeries(rows, kp, 4, stat)
        assert.deepStrictEqual(Array.from(a).map((v) => (Number.isNaN(v) ? null : v)), [null, 3.25, 0, -0.5])
        assert.equal(stat.conflict, 1)
        assert.equal(stat.conflictSample, '2024-01-01T00:00:00')
        assert.equal(stat.invalid, 1)
        //列之順序任意排列, 結果相同
        let perms = [[...rows].reverse(), [rows[2], rows[0], rows[1], ...rows.slice(3)], [...rows.slice(3), ...rows.slice(0, 3)]]
        for (let p of perms) {
            assert(sameArr(alignSeries(p, kp, 4), a), '結果與列之順序無關')
        }
    })

    it('stat(選配):依序計列數、對到棒之列、無效列、終點以後 / 起點以前 / 其餘對不到棒之列;不給 stat 者回傳不變', () => {
        let rows = [
            { time: '2024-01-01T00:00:00', value: 1 }, //對到, 有效
            { time: '2024-01-01T04:00:00', value: '' }, //對到, 值無效
            { time: '2024-01-01T08:00:00', value: 3 }, //對到, 有效
            { time: '2024-01-01T16:00:00', value: 9 }, //終點以後
            { time: '2023-12-31T20:00:00', value: 9 }, //起點以前
            { time: '2024-01-01T04:30:00', value: 5 }, //不在棒之開盤時間
            { time: '2024-01-01T08:00:00Z', value: 5 }, //格式不同(多一個 Z; 字串比較下 ≥ 終點 '2024-01-01T12:00:00'? 否 ⇒ 其餘對不到棒)
            { time: 123, value: 5 }, //時間非字串
            null, //非物件
        ]
        let stat = { endTime: '2024-01-01T12:00:00', time0: '2024-01-01T00:00:00' }
        let a = alignSeries(rows, kp, 3, stat)
        assert.deepStrictEqual(Array.from(a).map((v) => (Number.isNaN(v) ? null : v)), [1, null, 3])
        assert.equal(stat.conflict, 0)
        assert.equal(stat.rows, 9)
        assert.equal(stat.matched, 3)
        assert.equal(stat.invalid, 2, '值無效 1 + 非物件 1')
        assert.equal(stat.afterEnd, 1)
        assert.equal(stat.beforeStart, 1)
        assert.equal(stat.offGrid, 3, '不在棒之開盤時間 + 格式不同 + 時間非字串')
        assert.equal(stat.offGridSample, '2024-01-01T04:30:00')
        //未給 stat: 回傳與給 stat 者相同
        assert(sameArr(alignSeries(rows, kp, 3), a))
    })

    it('棒序號為索引:對位結果只由「時間 → 棒序號」之對照決定(不依輸入列之順序)', () => {
        let rows = [
            { time: '2024-01-01T12:00:00', value: 4 },
            { time: '2024-01-01T00:00:00', value: 1 },
            { time: '2024-01-01T08:00:00', value: 3 },
            { time: '2024-01-01T04:00:00', value: 2 },
        ]
        assert.deepEqual(Array.from(alignSeries(rows, kp, 4)), [1, 2, 3, 4])
    })
})


describe('建帳本之外部序列(buildLedger 之 seriesDir)', function () {
    let t
    let lib
    let sdir
    let END = timeOf(END_BAR)
    let quiet = []
    let log = (s) => quiet.push(String(s))
    before(() => {
        t = makeTmp('ledgerSeries')
        lib = path.join(t.dir, 'lib')
        sdir = path.join(t.dir, 'series')
        writeLibrary(lib)
        writeSeriesDir(sdir)
    })
    after(() => {
        t.cleanup()
    })

    it('建入:ser.f64 與 meta.seriesNames(依名稱之字典序)、逐棒 = 序列檔之值、終點以後之列不入帳本、底線起首之檔略過', async () => {
        let out = path.join(t.dir, 'with')
        let meta = await buildLedger({ libraryRoot: lib, keyOhlc: 'SYM_4hr', endTime: END, outDir: out, seriesDir: sdir, log })
        assert.equal(meta.nBars, END_BAR)
        assert.deepEqual(meta.seriesNames, ['Zed', 'ser_a', 'ser_b'])
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8')).seriesNames, ['Zed', 'ser_a', 'ser_b'])
        assert.equal(fs.statSync(path.join(out, 'ser.f64')).size, 3 * END_BAR * 8, '長度 = 序列數 × K 棒數(終點以後之列不得延長)')
        let L = loadLedger(out)
        assert.deepEqual(L.seriesNames, ['Zed', 'ser_a', 'ser_b'])
        let exp = expectedSer(END_BAR)
        for (let si = 0; si < 3; si++) {
            assert(sameArr(L.ser.subarray(si * END_BAR, (si + 1) * END_BAR), exp[si]), `序列 ${L.seriesNames[si]} 逐棒對位`)
        }
        //終點以後之值(7777777;1300 以上)一個也不得出現: 帳本不含 endTime 之後之任何資訊
        assert(Array.from(L.ser).every((v) => Number.isNaN(v) || (v < 7777777 && !(v >= 1000 + END_BAR))), '帳本內之序列不含終點以後之值')
        assert(quiet.some((s) => s.includes('外部序列 3 個已對位')), quiet.join('\n'))
    })

    it('帳本鍵與既有各欄不變:有 / 無 seriesDir 之兩份帳本,除 ser.f64 與 meta.json 外逐檔相同、鍵相同', async () => {
        let outA = path.join(t.dir, 'cmpA')
        let outB = path.join(t.dir, 'cmpB')
        let mA = await buildLedger({ libraryRoot: lib, keyOhlc: 'SYM_4hr', endTime: END, outDir: outA, log })
        let mB = await buildLedger({ libraryRoot: lib, keyOhlc: 'SYM_4hr', endTime: END, outDir: outB, seriesDir: sdir, log })
        assert.equal(mA.key, mB.key, '合約: 帳本鍵只由訂單內容決定')
        assert.deepEqual(mA.seriesNames, [])
        let fA = fs.readdirSync(outA).sort()
        let fB = fs.readdirSync(outB).sort()
        assert.deepEqual(fB, [...fA, 'ser.f64'].sort(), '無 seriesDir 者不留 ser.f64')
        for (let f of fA) {
            if (f === 'meta.json') {
                continue
            }
            assert(fs.readFileSync(path.join(outA, f)).equals(fs.readFileSync(path.join(outB, f))), `${f} 逐位相同`)
        }
        let strip = (m) => {
            let { builtAt, buildSec, seriesNames, ...rest } = m
            return rest
        }
        assert.deepEqual(strip(JSON.parse(fs.readFileSync(path.join(outB, 'meta.json'), 'utf8'))), strip(JSON.parse(fs.readFileSync(path.join(outA, 'meta.json'), 'utf8'))))
        //無此欄之帳本(含舊帳本): seriesNames 為空陣列、ser 為 null
        let LA = loadLedger(outA)
        assert.deepEqual(LA.seriesNames, [])
        assert.strictEqual(LA.ser, null)
    })

    it('重建於同一資料夾而不再給 seriesDir ⇒ 移除舊之 ser.f64(名稱與欄不致不符)', async () => {
        let out = path.join(t.dir, 'rebuild')
        await buildLedger({ libraryRoot: lib, keyOhlc: 'SYM_4hr', endTime: END, outDir: out, seriesDir: sdir, log })
        assert(fs.existsSync(path.join(out, 'ser.f64')))
        let meta = await buildLedger({ libraryRoot: lib, keyOhlc: 'SYM_4hr', endTime: END, outDir: out, log })
        assert(!fs.existsSync(path.join(out, 'ser.f64')), '舊之 ser.f64 須移除')
        assert.deepEqual(meta.seriesNames, [])
        let L = loadLedger(out)
        assert.deepEqual(L.seriesNames, [])
        assert.strictEqual(L.ser, null)
    })

    it('seriesDir 不存在 ⇒ 不建入並於記錄註明;空夾 ⇒ 不建入', async () => {
        let lines = []
        let meta = await buildLedger({ libraryRoot: lib, keyOhlc: 'SYM_4hr', endTime: END, outDir: path.join(t.dir, 'noDir'), seriesDir: path.join(t.dir, 'nonexistent'), log: (s) => lines.push(String(s)) })
        assert.deepEqual(meta.seriesNames, [])
        assert(lines.some((s) => s.includes('不存在')), `應註明 seriesDir 不存在: ${lines.join(' | ')}`)
        fs.mkdirSync(path.join(t.dir, 'emptyDir'), { recursive: true })
        let meta2 = await buildLedger({ libraryRoot: lib, keyOhlc: 'SYM_4hr', endTime: END, outDir: path.join(t.dir, 'emptyOut'), seriesDir: path.join(t.dir, 'emptyDir'), log })
        assert.deepEqual(meta2.seriesNames, [])
        assert(!fs.existsSync(path.join(t.dir, 'emptyOut', 'ser.f64')))
    })

    it('名稱不合(英文字母起首、其後英數或底線、至多 32 字)⇒ 拋錯,且不寫出任何檔;檔案內容非 [{ time, value }] 陣列或不是 JSON ⇒ 拋錯並指出檔名', async () => {
        let mk = (name, content) => {
            let d = path.join(t.dir, `bad_${name.replace(/[^A-Za-z0-9]/g, '')}`)
            fs.mkdirSync(d, { recursive: true })
            fs.writeFileSync(path.join(d, name), content, 'utf8')
            return d
        }
        let ok = JSON.stringify([{ time: timeOf(10), value: 1 }])
        for (let name of ['open-interest.json', '1abc.json', `${'a'.repeat(33)}.json`, 'a b.json']) {
            let out = path.join(t.dir, `out_${name.replace(/[^A-Za-z0-9]/g, '')}`)
            await assert.rejects(buildLedger({ libraryRoot: lib, keyOhlc: 'SYM_4hr', endTime: END, outDir: out, seriesDir: mk(name, ok), log }), /外部序列之名稱不合/, name)
            assert(!fs.existsSync(out), `${name}: 名稱不合時不得寫出帳本`)
        }
        //32 字之名稱可
        let d32 = mk(`${'a'.repeat(32)}.json`, ok)
        let m32 = await buildLedger({ libraryRoot: lib, keyOhlc: 'SYM_4hr', endTime: END, outDir: path.join(t.dir, 'out32'), seriesDir: d32, log })
        assert.deepEqual(m32.seriesNames, ['a'.repeat(32)])
        await assert.rejects(buildLedger({ libraryRoot: lib, keyOhlc: 'SYM_4hr', endTime: END, outDir: path.join(t.dir, 'outJ'), seriesDir: mk('sj.json', '{ not json'), log }), /sj\.json/)
        await assert.rejects(buildLedger({ libraryRoot: lib, keyOhlc: 'SYM_4hr', endTime: END, outDir: path.join(t.dir, 'outO'), seriesDir: mk('so.json', '{"time":"x"}'), log }), /so\.json.*陣列/)
    })

    it('時間格式與 K 線不同而一個值也對不到 ⇒ 不拋錯但於記錄提示(全為 NaN)', async () => {
        let d = path.join(t.dir, 'fmtDir')
        fs.mkdirSync(d, { recursive: true })
        fs.writeFileSync(path.join(d, 'ser_fmt.json'), JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ time: `${timeOf(i)}Z`, value: i }))), 'utf8')
        let lines = []
        let out = path.join(t.dir, 'fmtOut')
        let meta = await buildLedger({ libraryRoot: lib, keyOhlc: 'SYM_4hr', endTime: END, outDir: out, seriesDir: d, log: (s) => lines.push(String(s)) })
        assert.deepEqual(meta.seriesNames, ['ser_fmt'])
        assert(Array.from(loadLedger(out).ser).every((v) => Number.isNaN(v)))
        assert(lines.some((s) => s.includes('ser_fmt') && s.includes('無任何值對到棒')), lines.join(' | '))
    })

    it('提示:部分列之時間對不到棒(格式不同、不在棒之開盤時間)或值無效 ⇒ 記錄列出筆數與例;數據起點以前與終點以後之列屬正常,不提示', async () => {
        let d = path.join(t.dir, 'diagDir')
        fs.mkdirSync(d, { recursive: true })
        let mixed = []
        for (let i = 10; i < 20; i++) {
            mixed.push({ time: timeOf(i), value: i })
        }
        mixed.push({ time: `${timeOf(30)}Z`, value: 1 }, { time: `${timeOf(31)}Z`, value: 1 }, { time: '2022-07-01T00:30:00', value: 1 })
        mixed.push({ time: timeOf(40), value: null }, { time: timeOf(41), value: 'abc' })
        mixed.push({ time: timeOf(12), value: 999 }) //與前面棒 12 之值(12)相異 ⇒ 棒 12 取缺值
        fs.writeFileSync(path.join(d, 'ser_m.json'), JSON.stringify(mixed), 'utf8')
        let clean = [{ time: '2022-06-30T00:00:00', value: 5 }, { time: timeOf(5), value: 6 }, { time: timeOf(350), value: 7 }, { time: timeOf(399), value: 8 }]
        fs.writeFileSync(path.join(d, 'ser_ok.json'), JSON.stringify(clean), 'utf8')
        let lines = []
        let out = path.join(t.dir, 'diagOut')
        await buildLedger({ libraryRoot: lib, keyOhlc: 'SYM_4hr', endTime: END, outDir: out, seriesDir: d, log: (s) => lines.push(String(s)) })
        let warn = lines.filter((s) => s.startsWith('注意: 外部序列'))
        assert.equal(warn.length, 1, `只有 ser_m 提示: ${warn.join(' | ')}`)
        assert(warn[0].includes('ser_m') && warn[0].includes('3 列之時間對不到棒') && warn[0].includes('2 列之值無效'), warn[0])
        assert(warn[0].includes(`${timeOf(30)}Z`), '附第一個對不到棒之時間為例')
        assert(warn[0].includes('1 根棒有同一時間之多筆相異值而取缺值') && warn[0].includes(timeOf(12)), warn[0])
        let L = loadLedger(out)
        assert.deepEqual(L.seriesNames, ['ser_m', 'ser_ok'])
        assert.equal(L.ser[0 * END_BAR + 11], 11)
        assert(Number.isNaN(L.ser[0 * END_BAR + 12]), '棒 12 有相異之兩值(12 與 999)⇒ 取缺值')
        assert.equal(L.ser[0 * END_BAR + 13], 13)
        assert.equal(L.ser[1 * END_BAR + 5], 6)
        assert(Number.isNaN(L.ser[0 * END_BAR + 30]))
        assert(lines.some((s) => s.includes('ser_m(列 16、有值 9 / 300)') && s.includes('ser_ok(列 4、有值 1 / 300)')), lines.join(' | '))
    })

    it('重建中途失敗 ⇒ 舊 meta.json 已移除:半份帳本載入即失敗,不致以舊 meta 配新欄(同長度之新舊序列欄無從由長度察覺)', async () => {
        let out = path.join(t.dir, 'interrupted')
        await buildLedger({ libraryRoot: lib, keyOhlc: 'SYM_4hr', endTime: END, outDir: out, seriesDir: sdir, log })
        assert(fs.existsSync(path.join(out, 'meta.json')))
        //使 ser.f64 無法寫出(同名資料夾佔位)⇒ 寫出階段失敗
        fs.rmSync(path.join(out, 'ser.f64'), { force: true })
        fs.mkdirSync(path.join(out, 'ser.f64'))
        await assert.rejects(buildLedger({ libraryRoot: lib, keyOhlc: 'SYM_4hr', endTime: END, outDir: out, seriesDir: sdir, log }))
        assert(!fs.existsSync(path.join(out, 'meta.json')), '失敗後不得留有舊 meta.json')
        assert.throws(() => loadLedger(out), /meta\.json/)
        //修復後重建成功: meta 與欄一致
        fs.rmSync(path.join(out, 'ser.f64'), { recursive: true, force: true })
        let meta = await buildLedger({ libraryRoot: lib, keyOhlc: 'SYM_4hr', endTime: END, outDir: out, seriesDir: sdir, log })
        assert.deepEqual(loadLedger(out).seriesNames, meta.seriesNames)
    })

    it('端到端:建入之序列經 ctx.series 取得 —— 值 = 對位之棒,決策棒 b 只見棒序 < b(含缺值照給 NaN)', async () => {
        let out = path.join(t.dir, 'e2eEval')
        await buildLedger({ libraryRoot: lib, keyOhlc: 'SYM_4hr', endTime: END, outDir: out, seriesDir: sdir, log })
        let ev = makeEvaluator(loadLedger(out), { warmupDays: 10, cadenceDays: 3, phases: [0, 1], horizons: [3], nullDraws: 4, seed: 3 })
        let exp = expectedSer(END_BAR)
        let nChk = 0
        for (let phase of [0, 1]) {
            ev.runPick((ctx) => {
                let b = ctx.bar
                assert.deepEqual(Array.from(ctx.meta.seriesNames), ['Zed', 'ser_a', 'ser_b'])
                for (let [si, nm] of [[0, 'Zed'], [1, 'ser_a'], [2, 'ser_b']]) {
                    for (let nBack of [1, 5, 60]) {
                        let v = ctx.series(nm, nBack)
                        assert.equal(v.length, nBack)
                        assert(sameArr(v, exp[si].subarray(b - nBack, b)), `${nm} nBack ${nBack} 決策棒 ${b}`)
                        nChk++
                    }
                }
                //ser_a 之值 = 棒序號 × 0.5 ⇒ 最後一格 = (b - 1) × 0.5, 且任何格之值皆 < b × 0.5; 終點以後之標記值 7777777 不得出現
                let a = ctx.series('ser_a', 1e9)
                assert.equal(a[a.length - 1], (b - 1) * 0.5)
                assert(Array.from(a).every((x) => x < b * 0.5))
                return []
            }, phase)
        }
        assert(nChk > 30, `核對 ${nChk} 次`)
    })
})


describe('命令列 build:settings.source.seriesDir(相對專案根)', function () {
    let t
    before(() => {
        t = makeTmp('ledgerSeriesCli')
        writeLibrary(path.join(t.dir, 'lib'))
        writeSeriesDir(path.join(t.dir, 'proj', 'series'))
    })
    after(() => {
        t.cleanup()
    })

    //runBuild, 以 root 為專案根(ARSI_ROOT)執行套件之 src/cli/build.mjs; 工作目錄刻意不是專案根(settings 內之相對路徑須以專案根解析, 非工作目錄); 回 { status, last(stdout 末行之 JSON), out }
    let runBuild = (root, args = []) => {
        let env = { ...process.env, ARSI_ROOT: root }
        let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'build.mjs'), ...args], { cwd: t.dir, env, windowsHide: true, encoding: 'utf8' })
        let lines = String(r.stdout).trim().split(/\r?\n/)
        let last = null
        try {
            last = JSON.parse(lines[lines.length - 1])
        }
        catch (err) {}
        return { status: r.status, last, out: `${r.stdout}\n${r.stderr}` }
    }
    let writeSettings = (root, seriesDir) => {
        let source = { libraryRoot: path.join(t.dir, 'lib'), keyOhlc: 'SYM_4hr', barHours: 4 }
        if (seriesDir !== undefined) {
            source.seriesDir = seriesDir
        }
        fs.mkdirSync(root, { recursive: true })
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
            source,
            periods: { train: { start: timeOf(0), end: timeOf(250) }, backtest: { start: timeOf(250), end: timeOf(END_BAR) }, holdoutFrom: timeOf(380) },
            eval: { ledgerDir: './ledger/eval' },
            rsi: { root: './rsi' },
            records: {},
            dispatch: {},
        }), 'utf8')
    }

    it('有 seriesDir:評估帳本與訓練期帳本皆建入序列,各於自己之終點截斷;訓練期帳本之序列 = 評估帳本之前綴;摘要列 seriesNames', () => {
        let root = path.join(t.dir, 'proj')
        writeSettings(root, './series')
        let r = runBuild(root)
        assert.equal(r.status, 0, r.out.slice(0, 600))
        assert.deepEqual(r.last.seriesNames, ['Zed', 'ser_a', 'ser_b'])
        assert.equal(r.last.nBars, END_BAR)
        let Le = loadLedger(path.join(root, 'ledger', 'eval'))
        let exp = expectedSer(END_BAR)
        for (let si = 0; si < 3; si++) {
            assert(sameArr(Le.ser.subarray(si * END_BAR, (si + 1) * END_BAR), exp[si]), `評估帳本 序列 ${Le.seriesNames[si]}`)
        }
        let r2 = runBuild(root, ['--train'])
        assert.equal(r2.status, 0, r2.out.slice(0, 600))
        assert.equal(r2.last.nBars, 250)
        let Lt = loadLedger(path.join(root, 'ledger', 'train'))
        assert.deepEqual(Lt.seriesNames, ['Zed', 'ser_a', 'ser_b'])
        for (let si = 0; si < 3; si++) {
            assert(sameArr(Lt.ser.subarray(si * 250, (si + 1) * 250), Le.ser.subarray(si * END_BAR, si * END_BAR + 250)), `訓練期帳本 序列 ${Lt.seriesNames[si]} = 評估帳本之前綴`)
        }
        assert(Array.from(Lt.ser).every((v) => Number.isNaN(v) || v < 1000 + 250), '訓練期帳本不含 250 棒以後之值(ser_b 之值 = 1000 + 棒序號)')
        assert.equal(r.last.key.length, 16)
    })

    it('seriesDir 為空字串或非字串 ⇒ 不建入;--limit 之試算帳本(落 <ledgerDir>_limitN)亦建入序列', () => {
        for (let [name, v] of [['projEmpty', ''], ['projNum', 123]]) {
            let root = path.join(t.dir, name)
            writeSettings(root, v)
            let r = runBuild(root)
            assert.equal(r.status, 0, r.out.slice(0, 600))
            assert.deepEqual(r.last.seriesNames, [], `seriesDir = ${JSON.stringify(v)}`)
            assert(!fs.existsSync(path.join(root, 'ledger', 'eval', 'ser.f64')))
        }
        let root = path.join(t.dir, 'proj')
        writeSettings(root, './series')
        let r = runBuild(root, ['--limit', '1'])
        assert.equal(r.status, 0, r.out.slice(0, 600))
        assert.equal(r.last.nStrategies, 1)
        assert.deepEqual(r.last.seriesNames, ['Zed', 'ser_a', 'ser_b'])
        let L = loadLedger(path.join(root, 'ledger', 'eval_limit1'))
        let exp = expectedSer(END_BAR)
        for (let si = 0; si < 3; si++) {
            assert(sameArr(L.ser.subarray(si * END_BAR, (si + 1) * END_BAR), exp[si]), `limit 帳本 序列 ${L.seriesNames[si]}`)
        }
    })

    it('設定以絕對路徑指定 seriesDir 亦可;未設定者不建入、帳本鍵與有序列者相同', () => {
        let rootA = path.join(t.dir, 'projAbs')
        writeSettings(rootA, path.join(t.dir, 'proj', 'series'))
        let ra = runBuild(rootA)
        assert.equal(ra.status, 0, ra.out.slice(0, 600))
        assert.deepEqual(ra.last.seriesNames, ['Zed', 'ser_a', 'ser_b'])
        let rootN = path.join(t.dir, 'projNone')
        writeSettings(rootN)
        let rn = runBuild(rootN)
        assert.equal(rn.status, 0, rn.out.slice(0, 600))
        assert.deepEqual(rn.last.seriesNames, [])
        assert(!fs.existsSync(path.join(rootN, 'ledger', 'eval', 'ser.f64')))
        assert.equal(rn.last.key, ra.last.key, '帳本鍵不因外部序列而改變')
    })
})
