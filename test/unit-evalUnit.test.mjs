import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { pathToFileURL } from 'url'
import { normUnit, unitKeyOf, sameUnit } from '../src/eval/unit.mjs'
import { unitNotionalOf } from '../src/eval/unitNotional.mjs'
import { buildLedger } from '../src/eval/ledgerBuild.mjs'
import { loadLedger, memberLedger } from '../src/eval/ledger.mjs'
import { isCapitalError } from '../src/eval/evalCore.mjs'
import { FD_ROOT, makeTmp, writeSynthLedger, makeTrainEvaluator as makeEvaluator } from './tools/synthLedger.mjs'
import { getSettings } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { makeVerify } from '../src/domain/verify.mjs'
import WTA from '../src/WTradeAdaptivess.mjs'


//下單之基礎單位(規則 R-EV-43): 交易規則之正規化、每根棒之名義、帳本之建置與載入、評估器之實際名義口徑、研究用本金之檢查、命令列
//  合成資料各欄逐筆相異: 合成策略庫之收盤價逐棒相異(含名義恰等於門檻之邊界價格), 合成帳本之每根棒之名義逐棒相異 ⇒ 各單之名義相異
//  獨立之定義: 每根棒之名義以基礎單位之格數算式(R-EV-43 ②; 價格以分為單位之整數)自算; 等效年化 / 峰值名義以「逐單之名義 × 每單位損益」與「各進場棒之持倉名義和」自算(不經評估器之差分)
//  交易規則之數值為中性之合成值, 不代表任何標的

let RULE_A = { stepSize: 0.001, minQty: 0.001, minNotional: 20 } //門檻 22(緩衝 0.1)
let UNIT_A = { rule: { ...RULE_A, asOf: '2026-01-01T00:00:00Z', source: 'synthetic' }, buffer: 0.1, uIni: 10000 }

let T0 = Date.UTC(2022, 6, 1)
let timeOf = (i) => new Date(T0 + i * 4 * 3600000).toISOString().slice(0, 19)

//decNum, 整數 v × 10^-s 之十進位字串轉 Number(與回測套件之定點轉換同一約定: 由十進位字串解析)
let decNum = (v, s) => {
    let str = BigInt(v).toString().padStart(s + 1, '0')
    return Number(`${str.slice(0, str.length - s)}.${str.slice(str.length - s)}`)
}
//n0OfCents, 交易規則 RULE_A(步長 0.001、最小數量 0.001、最小名義價值 20、緩衝 0.1)於價格 pc / 100 之基礎單位名義(格數之整數算式; 獨立於回測套件之實作)
//  k = max(⌈0.001 / 0.001⌉, ⌈22 / (p × 0.001)⌉) = max(1, ⌈2200000 / pc⌉); n0 = k × 0.001 × p = k × pc / 10^5
let n0OfCents = (pc) => {
    let k = (2200000n + BigInt(pc) - 1n) / BigInt(pc)
    if (k < 1n) {
        k = 1n
    }
    return { k: Number(k), n0: decNum(k * BigInt(pc), 5) }
}

//closesOf, 合成收盤價(分為單位之整數, 逐棒相異): 第 10 ~ 13 棒為名義恰等於門檻(2000、4400)與其下一分(1999、4399)之邊界價格
let N_LIB = 600
let closesOf = () => {
    let pcs = []
    let seen = new Set()
    let fixed = { 10: 200000, 11: 199900, 12: 440000, 13: 439900 }
    for (let v of Object.values(fixed)) {
        seen.add(v)
    }
    for (let i = 0; i < N_LIB; i++) {
        if (fixed[i] !== undefined) {
            pcs.push(fixed[i])
            continue
        }
        let v = Math.round((2000 + 1500 * (0.5 + 0.5 * Math.sin(i / 41)) + 200 * Math.sin(i / 3.7)) * 100)
        while (seen.has(v)) {
            v++
        }
        seen.add(v)
        pcs.push(v)
    }
    return pcs
}

//writeLibrary, 合成策略庫(ohlc 600 根、3 個因子、7 隻策略; 止盈止損各異 ⇒ 持有期各異、同一策略之單互相重疊); extra 給者另加策略(接在 s6 之後編號)
let writeLibrary = (root, extra = []) => {
    fs.mkdirSync(path.join(root, 'ohlc'), { recursive: true })
    fs.mkdirSync(path.join(root, 'param'), { recursive: true })
    fs.mkdirSync(path.join(root, 'strategies'), { recursive: true })
    let pcs = closesOf()
    let ohlc = []
    for (let i = 0; i < N_LIB; i++) {
        let c = pcs[i] / 100
        let o = i > 0 ? pcs[i - 1] / 100 : c
        ohlc.push({ time: timeOf(i), Open: o, High: Math.max(o, c) * 1.012, Low: Math.min(o, c) * 0.988, Close: c, Volumn: 1000 + i })
    }
    fs.writeFileSync(path.join(root, 'ohlc', 'SYM_4hr.json'), JSON.stringify(ohlc), 'utf8')
    let px = []
    let py = []
    let pz = []
    for (let i = 0; i < N_LIB; i++) {
        px.push({ time: timeOf(i), param: Math.sin(i / 5) })
        py.push({ time: timeOf(i), param: Math.cos(i / 9) })
        pz.push({ time: timeOf(i), param: i >= N_LIB - 40 ? 1 : 0 })
    }
    fs.writeFileSync(path.join(root, 'param', 'price_x.json'), JSON.stringify(px), 'utf8')
    fs.writeFileSync(path.join(root, 'param', 'price_y.json'), JSON.stringify(py), 'utf8')
    fs.writeFileSync(path.join(root, 'param', 'price_z.json'), JSON.stringify(pz), 'utf8')
    let st = (mode, key, sym, th, tp, sl) => ({ mode, settings: { rTakeProfit: tp, rStopLoss: sl, rFee: 0.0005 }, conds: [{ key, sym, th }], levelNumTrade: 1, numTrade: 0 })
    //s6: 末 40 根逐棒進場、止盈止損皆 50%(不觸)⇒ 全部未結、持倉逐棒增加 ⇒ 其峰值恰在其最後一個進場棒(= 帳本之最後一根; 掃描之終點之鑑別前提), 且為各策略之最大者
    let defs = [['long', 'price_x', '>', 0, 0.03, 0.02], ['short', 'price_x', '<', 0, 0.02, 0.04], ['long', 'price_y', '>', 0.2, 0.05, 0.05], ['short', 'price_y', '<', -0.2, 0.04, 0.03], ['long', 'price_x', '<', -0.5, 0.06, 0.03], ['short', 'price_y', '>', 0.6, 0.03, 0.06], ['long', 'price_z', '>', 0.5, 0.5, 0.5], ...extra]
    defs.forEach((d, i) => fs.writeFileSync(path.join(root, 'strategies', `s${i}.json`), JSON.stringify(st(...d)), 'utf8'))
    return pcs
}
let END = timeOf(N_LIB) //帳本含全部 600 根
let quiet = () => {}
let filesOf = (dir) => fs.readdirSync(dir).sort()
let bytesOf = (dir, f) => fs.readFileSync(path.join(dir, f))
//peakOfStrategy, 單一策略於帳本全期之最大同時持倉名義(獨立之定義: 於每個進場棒, 加總 ent ≤ t < ext(未結者 ext = ∞)之各單之名義)
let peakOfStrategy = (L, s) => {
    let a = L.off[s]
    let z = L.off[s + 1]
    let pk = 0
    for (let j = a; j < z; j++) {
        let t = L.ent[j]
        let sum = 0
        for (let q = a; q < z; q++) {
            let x = L.ext[q] >= 0 ? L.ext[q] : Infinity
            if (L.ent[q] <= t && t < x) {
                sum += L.unitN[L.ent[q]]
            }
        }
        pk = Math.max(pk, sum)
    }
    return pk
}
let relClose = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b))
let errOf = (fn) => {
    try {
        fn()
    }
    catch (err) {
        return err
    }
    return null
}
let errOfAsync = async (fn) => {
    try {
        await fn()
    }
    catch (err) {
        return err
    }
    return null
}


describe('基礎單位之設定與每根棒之名義(src/eval/unit.mjs)', function () {

    it('normUnit:未給 ⇒ null;給者正規化(緩衝預設 0.1、asOf / source 照存、其他欄不收)且凍結', () => {
        assert.strictEqual(normUnit(undefined), null)
        assert.strictEqual(normUnit(null), null)
        let nu = normUnit({ rule: { ...RULE_A, asOf: 'x', source: 'y', extra: 1 }, uIni: 10000, other: 2 })
        assert.deepStrictEqual(JSON.parse(JSON.stringify(nu)), { rule: { stepSize: 0.001, minQty: 0.001, minNotional: 20, asOf: 'x', source: 'y' }, buffer: 0.1, uIni: 10000 })
        assert(Object.isFrozen(nu) && Object.isFrozen(nu.rule))
        assert.equal(normUnit({ rule: RULE_A, buffer: 0, uIni: 5 }).buffer, 0)
    })

    //非數字或不合範圍之值(含非數字之字串、非十進位之寫法、超出雙精度、包裝物件與其他型別): 一律拋錯、訊息不帶值(跨套件規格:影響下單數量或金額之設定給了而無效即拒絕)
    let BAD_STR = ['abc', '', ' ', '0x10', '0b11', 'Infinity', 'NaN', '1e400', '1,5', '1_0', '１２']
    //eslint-disable-next-line no-new-wrappers
    let BAD_OTHER = [null, true, false, {}, [], [5], new Number(5), 5n, Symbol('x'), () => 5]
    it('normUnit 之負向:各欄缺、非正、非有限數、非數字之字串與其他型別皆拋錯,訊息指明欄位且不帶輸入值', () => {
        let base = () => ({ rule: { ...RULE_A }, buffer: 0.1, uIni: 10000 })
        let cases = []
        for (let k of ['stepSize', 'minQty', 'minNotional']) {
            for (let v of [undefined, 0, -1, NaN, Infinity, -Infinity, ...BAD_STR, '0', '-1', '0.0', '-0', ...BAD_OTHER]) {
                let u = base()
                u.rule[k] = v
                cases.push([u, `invalid unit.rule.${k}: must be a positive finite number`])
            }
        }
        for (let v of [-0.1, NaN, Infinity, '-0.1', ...BAD_STR, true, ...BAD_OTHER.filter((x) => x !== null)]) {
            let u = base()
            u.buffer = v
            cases.push([u, 'invalid unit.buffer: must be a non-negative finite number'])
        }
        for (let v of [undefined, 0, -10000, NaN, '0', '-10000', ...BAD_STR, ...BAD_OTHER]) {
            let u = base()
            u.uIni = v
            cases.push([u, 'invalid unit.uIni: must be a positive finite number'])
        }
        cases.push([{ ...base(), rule: null }, 'invalid unit.rule: must be an object { stepSize, minQty, minNotional }'])
        cases.push([{ ...base(), rule: [1, 2, 3] }, 'invalid unit.rule: must be an object { stepSize, minQty, minNotional }'])
        cases.push([5, 'invalid unit: must be an object { rule, buffer, uIni } or null'])
        cases.push([[], 'invalid unit: must be an object { rule, buffer, uIni } or null'])
        cases.push([{ ...base(), rule: { ...RULE_A, asOf: 3 } }, 'invalid unit.rule.asOf: must be a string'])
        for (let [i, [u, msg]] of cases.entries()) {
            let err = errOf(() => normUnit(u))
            assert(err instanceof Error, `應拋錯(案 ${i}: ${msg})`)
            assert.equal(err.message, msg, `案 ${i}`)
        }
        assert(cases.length > 100, '欄位 × 無效值之格數(鑑別前提)')
        //位置名稱
        assert.equal(errOf(() => normUnit({ rule: RULE_A }, 'source.unit')).message, 'invalid source.unit.uIni: must be a positive finite number')
        //訊息不帶輸入值(非數字之字串、負數之字串)
        for (let secret of ['SECRET-123', '-777.5']) {
            for (let u of [{ rule: { ...RULE_A, stepSize: secret }, uIni: 1 }, { rule: { ...RULE_A, minQty: secret }, uIni: 1 }, { rule: { ...RULE_A, minNotional: secret }, uIni: 1 }, { rule: RULE_A, buffer: secret, uIni: 1 }, { rule: RULE_A, uIni: secret }]) {
                let err = errOf(() => normUnit(u))
                assert(err instanceof Error && !err.message.includes(secret), err && err.message)
            }
        }
    })

    //數字字串(跨套件規格 K7:數字類一律收數字字串;K4:檢測之值即使用之值 —— 通過即轉為數值, 其後 meta.unit、帳本鍵、比對皆用數值)
    it('normUnit 收數字字串:通過即轉為數值(回傳之各欄皆為 Number);\'0.001\' 與 0.001 之設定得同一鍵、sameUnit 為真;各種十進位寫法;\'-0\' 轉為 0', () => {
        let ref = normUnit(UNIT_A)
        let FORMS = ['0.001', ' 0.001 ', '1e-3', '1E-3', '+0.001', '.001', '0.0010', '0.001e0']
        for (let f of FORMS) {
            let nu = normUnit({ rule: { stepSize: f, minQty: f, minNotional: '20', asOf: 'x' }, buffer: '0.1', uIni: ' 1e4 ' })
            for (let k of ['stepSize', 'minQty', 'minNotional']) {
                assert.equal(typeof nu.rule[k], 'number', `${f}: ${k}`)
            }
            assert.equal(typeof nu.buffer, 'number')
            assert.equal(typeof nu.uIni, 'number')
            assert.deepStrictEqual(JSON.parse(JSON.stringify(nu)), { rule: { stepSize: 0.001, minQty: 0.001, minNotional: 20, asOf: 'x' }, buffer: 0.1, uIni: 10000 }, f)
            assert.equal(unitKeyOf(nu), unitKeyOf(ref), f)
            assert(sameUnit(nu, ref) && sameUnit(ref, nu), f)
            assert(Object.isFrozen(nu) && Object.isFrozen(nu.rule))
        }
        //數字與數字字串逐欄混用: 結果相同
        let mixed = normUnit({ rule: { stepSize: '0.001', minQty: 0.001, minNotional: '20' }, buffer: 0.1, uIni: '10000' })
        assert.deepStrictEqual(JSON.parse(JSON.stringify(mixed)), { rule: { stepSize: 0.001, minQty: 0.001, minNotional: 20 }, buffer: 0.1, uIni: 10000 })
        assert(sameUnit(mixed, normUnit({ rule: RULE_A, uIni: 10000 })))
        //緩衝為數字字串 '0' / '-0' / 0 / -0 ⇒ 皆為 0(正零)
        for (let b of ['0', '-0', ' 0 ', 0, -0]) {
            let nu = normUnit({ rule: RULE_A, buffer: b, uIni: 1 })
            assert(Object.is(nu.buffer, 0), String(b))
        }
        //緩衝之字串與未給: '0.1' = 預設
        assert(sameUnit(normUnit({ rule: RULE_A, buffer: '0.1', uIni: 1 }), normUnit({ rule: RULE_A, uIni: 1 })))
        //數字字串之值不同 ⇒ 鍵不同、比對不同(不因轉換而混淆)
        assert(!sameUnit(normUnit({ rule: { ...RULE_A, stepSize: '0.002' }, uIni: 10000 }), ref))
        assert(!sameUnit(normUnit({ rule: RULE_A, uIni: '9999' }), normUnit({ rule: RULE_A, uIni: 10000 })))
    })

    it('normUnit:每個欄位只讀取一次(檢查之值即使用之值;讀取之值逐次不同之存取子不得使檢查與使用錯開)', () => {
        let reads = {}
        let seq = (name, first, later) => ({
            get: () => {
                reads[name] = (reads[name] || 0) + 1
                return reads[name] === 1 ? first : later
            },
            enumerable: true,
        })
        let rule = {}
        Object.defineProperties(rule, { stepSize: seq('stepSize', '0.001', -5), minQty: seq('minQty', 0.001, 'abc'), minNotional: seq('minNotional', '20', 0), asOf: seq('asOf', 'a', 7), source: seq('source', 's', 8) })
        let u = {}
        Object.defineProperties(u, { rule: { value: rule, enumerable: true }, buffer: seq('buffer', '0.2', -1), uIni: seq('uIni', '5000', NaN) })
        let nu = normUnit(u)
        assert.deepStrictEqual(JSON.parse(JSON.stringify(nu)), { rule: { stepSize: 0.001, minQty: 0.001, minNotional: 20, asOf: 'a', source: 's' }, buffer: 0.2, uIni: 5000 })
        for (let k of ['stepSize', 'minQty', 'minNotional', 'asOf', 'source', 'buffer', 'uIni']) {
            assert.equal(reads[k], 1, `${k} 讀取次數`)
        }
    })

    it('unitKeyOf / sameUnit:鍵 = 交易規則之三個數值與緩衝;sameUnit 另比研究用本金、不比 asOf / source', () => {
        let a = normUnit(UNIT_A)
        assert.equal(unitKeyOf(a), '0.001|0.001|20|0.1')
        assert(sameUnit(null, null) && !sameUnit(a, null) && !sameUnit(null, a))
        assert(sameUnit(a, normUnit({ rule: RULE_A, uIni: 10000 })), 'asOf / source 不比')
        assert(!sameUnit(a, normUnit({ ...UNIT_A, uIni: 9999 })))
        assert(!sameUnit(a, normUnit({ ...UNIT_A, buffer: 0.2 })))
        for (let k of ['stepSize', 'minQty', 'minNotional']) {
            assert(!sameUnit(a, normUnit({ ...UNIT_A, rule: { ...RULE_A, [k]: RULE_A[k] * 2 } })), k)
        }
    })

    it('unitNotionalOf:可斷言之觀察值(含名義恰等於門檻之邊界、受最小數量限制者)與格數之整數算式逐棒相同', () => {
        let nuA = normUnit({ rule: RULE_A, uIni: 1 })
        let w = unitNotionalOf([2000, 2001, 1999, 4400, 4399], nuA)
        assert.deepStrictEqual(Array.from(w), [22, 22.011, 23.988, 22, 26.394])
        let nuB = normUnit({ rule: { stepSize: 0.001, minQty: 0.001, minNotional: 50 }, uIni: 1 })
        assert.deepStrictEqual(Array.from(unitNotionalOf([100000, 55000, 54999, 16000], nuB)), [100, 55, 109.998, 64])
        let nuC = normUnit({ rule: { stepSize: 0.1, minQty: 1, minNotional: 5 }, uIni: 1 })
        assert.deepStrictEqual(Array.from(unitNotionalOf([10], nuC)), [10])
        //合成收盤價(逐棒相異)與獨立之整數算式
        let pcs = closesOf()
        let w2 = unitNotionalOf(pcs.map((v) => v / 100), nuA)
        for (let i = 0; i < pcs.length; i++) {
            assert.equal(w2[i], n0OfCents(pcs[i]).n0, `棒 ${i}`)
        }
        assert(new Set(pcs.map((v) => n0OfCents(v).k)).size >= 5, '合成價格須涵蓋多個格數(鑑別前提)')
    })

    it('unitNotionalOf 之負向:收盤價非正或非有限數 ⇒ 拋錯(不回 0);給了各棒之時間者訊息指出該棒之時間(不帶值);回測套件之其他錯誤轉為 invalid unit(不帶值)', () => {
        let nu = normUnit({ rule: RULE_A, uIni: 1 })
        for (let p of [0, -1, NaN, Infinity]) {
            assert.equal(errOf(() => unitNotionalOf([2000, p], nu)).message, 'invalid close: must be a positive finite number at every bar (required by unit)')
            assert.equal(errOf(() => unitNotionalOf([2000, 2001, p], nu, ['t0', 't1', 't2'])).message, 'invalid close: must be a positive finite number at every bar (required by unit; first at bar t2)')
        }
        //回測套件拋錯(格數超過安全整數)⇒ 轉為 invalid unit、指出該棒之時間、不帶回測套件之訊息(其訊息帶輸入值)
        let tiny = normUnit({ rule: { stepSize: 1e-300, minQty: 1e-300, minNotional: 1e10 }, uIni: 1 })
        let err = errOf(() => unitNotionalOf([2000, 2001], tiny, ['t0', 't1']))
        assert(err instanceof Error)
        assert.equal(err.message, 'invalid unit: must give a base-unit quantity at every bar (calcBaseUnitQuantity failed; first at bar t0)')
        assert(!/2000|1e-300|1e\+?10|10000000000/.test(err.message))
    })
})


describe('帳本之建置與載入(buildLedger 之 unit、loadLedger 之 unitN / unit)', function () {
    let t
    let lib
    let pcs
    before(() => {
        t = makeTmp('evalUnitLedger')
        lib = path.join(t.dir, 'lib')
        pcs = writeLibrary(lib)
    })
    after(() => {
        t.cleanup()
    })
    let build = (name, unit = undefined) => buildLedger({ libraryRoot: lib, keyOhlc: 'SYM_4hr', endTime: END, outDir: path.join(t.dir, name), log: quiet, ...(unit === undefined ? {} : { unit }) })

    it('未給 unit 與 unit: null ⇒ 各檔逐位相同、無 unit.f64、meta 無 unit / unitStat、帳本鍵相同;載入之帳本無 unitN / unit', async () => {
        let m0 = await build('off0')
        let m1 = await build('off1', null)
        assert.equal(m0.key, m1.key)
        assert.deepStrictEqual(filesOf(path.join(t.dir, 'off0')), filesOf(path.join(t.dir, 'off1')))
        assert(!filesOf(path.join(t.dir, 'off0')).includes('unit.f64'))
        for (let f of filesOf(path.join(t.dir, 'off0')).filter((f) => f !== 'meta.json')) {
            assert(bytesOf(path.join(t.dir, 'off0'), f).equals(bytesOf(path.join(t.dir, 'off1'), f)), f)
        }
        assert(!('unit' in m0) && !('unitStat' in m0))
        let L = loadLedger(path.join(t.dir, 'off0'))
        assert(!('unitN' in L) && !('unit' in L))
    })

    it('給 unit ⇒ 既有各檔(含每單位損益 pnl)與未給者逐位相同, 另有 unit.f64(= 格數之整數算式逐棒)、meta.unit 與 meta.unitStat, 帳本鍵改變', async () => {
        let m0 = await build('off2')
        let m1 = await build('on1', UNIT_A)
        let d0 = path.join(t.dir, 'off2')
        let d1 = path.join(t.dir, 'on1')
        assert.deepStrictEqual(filesOf(d1), [...filesOf(d0), 'unit.f64'].sort())
        for (let f of filesOf(d0).filter((f) => f !== 'meta.json')) {
            assert(bytesOf(d0, f).equals(bytesOf(d1, f)), f)
        }
        assert.notEqual(m0.key, m1.key)
        assert.deepStrictEqual(m1.unit, { rule: { ...UNIT_A.rule }, buffer: 0.1, uIni: 10000 })
        let L = loadLedger(d1)
        assert.equal(L.unitN.length, L.nBars)
        for (let i = 0; i < L.nBars; i++) {
            assert.equal(L.unitN[i], n0OfCents(pcs[i]).n0, `棒 ${i}`)
        }
        assert.equal(L.unitN[10], 22)
        assert.equal(L.unitN[11], 23.988)
        assert.equal(L.unitN[12], 22)
        assert.equal(L.unitN[13], 26.394)
        assert.deepStrictEqual(JSON.parse(JSON.stringify(L.unit)), m1.unit)
        //meta 之其餘欄(時刻與耗時除外)與未給者相同
        let strip = (m) => {
            let o = { ...m }
            for (let k of ['key', 'builtAt', 'buildSec', 'libraryRoot', 'unit', 'unitStat']) {
                delete o[k]
            }
            return o
        }
        assert.deepStrictEqual(strip(m1), strip(m0))
        //unitStat: 名義之範圍與單一策略之全期最大同時持倉名義(獨立之定義)
        assert.equal(m1.unitStat.notionalMin, Math.min(...L.unitN))
        assert.equal(m1.unitStat.notionalMax, Math.max(...L.unitN))
        let pks = Array.from({ length: L.n }, (_, s) => peakOfStrategy(L, s))
        let pkMax = Math.max(...pks)
        assert(relClose(m1.unitStat.strategyPeakNotional, pkMax, 1e-12), `${m1.unitStat.strategyPeakNotional} vs ${pkMax}`)
        assert.equal(m1.unitStat.strategyPeakFile, `s${pks.indexOf(pkMax)}.json`)
        //s6(末 40 根逐棒進場、皆未結): 峰值 = 末 40 根之名義和(以整數算式獨立計算), 且為各策略之最大者
        let exp6 = pcs.slice(N_LIB - 40).reduce((a, v) => a + n0OfCents(v).n0, 0)
        assert(relClose(pks[6], exp6, 1e-12) && relClose(m1.unitStat.strategyPeakNotional, exp6, 1e-12), `${pks[6]} / ${m1.unitStat.strategyPeakNotional} vs ${exp6}`)
        assert.equal(m1.unitStat.strategyPeakFile, 's6.json')
        assert(pks.filter((v) => v > 0).length >= 4 && new Set(pks.map((v) => v.toFixed(6))).size >= 4, '各策略之峰值相異(鑑別前提)')
        assert(pkMax > 2 * Math.max(...L.unitN), '同一策略之單互相重疊(鑑別前提)')
    })

    it('帳本鍵:交易規則之任一數值或緩衝改變 ⇒ 鍵改變;asOf / source 與研究用本金不改鍵(其不改每單之名義)', async () => {
        let k0 = (await build('k0', UNIT_A)).key
        let keys = new Set([k0])
        let i = 0
        for (let u of [{ ...UNIT_A, buffer: 0.2 }, { ...UNIT_A, rule: { ...RULE_A, minNotional: 21 } }, { ...UNIT_A, rule: { ...RULE_A, stepSize: 0.002 } }, { ...UNIT_A, rule: { ...RULE_A, minQty: 0.01 } }]) {
            let k = (await build(`k${++i}`, u)).key
            assert(!keys.has(k), JSON.stringify(u))
            keys.add(k)
        }
        assert.equal((await build('k9', { rule: RULE_A, uIni: 20000 })).key, k0)
    })

    it('數字字串之設定(跨套件規格 K7、K4):與數字之設定得同一帳本(各檔逐位相同、帳本鍵相同、meta.unit 為數值);數值不同者鍵不同;載入 meta.unit 為數字字串之帳本 ⇒ L.unit 為數值', async () => {
        let mNum = await build('str_num', UNIT_A)
        let mStr = await build('str_str', { rule: { stepSize: '0.001', minQty: '1e-3', minNotional: ' 20 ', asOf: UNIT_A.rule.asOf, source: UNIT_A.rule.source }, buffer: '0.1', uIni: '1e4' })
        let dNum = path.join(t.dir, 'str_num')
        let dStr = path.join(t.dir, 'str_str')
        assert.equal(mStr.key, mNum.key)
        assert.deepStrictEqual(mStr.unit, mNum.unit)
        assert.deepStrictEqual(mStr.unit, { rule: { ...UNIT_A.rule }, buffer: 0.1, uIni: 10000 })
        assert.deepStrictEqual(filesOf(dStr), filesOf(dNum))
        for (let f of filesOf(dNum).filter((f) => f !== 'meta.json')) {
            assert(bytesOf(dNum, f).equals(bytesOf(dStr, f)), f)
        }
        //meta.json 內為轉換後之數值(不存字串)
        let mj = JSON.parse(fs.readFileSync(path.join(dStr, 'meta.json'), 'utf8'))
        assert.deepStrictEqual(mj.unit, mNum.unit)
        for (let v of [mj.unit.rule.stepSize, mj.unit.rule.minQty, mj.unit.rule.minNotional, mj.unit.buffer, mj.unit.uIni]) {
            assert.equal(typeof v, 'number')
        }
        //數值不同(字串寫法)⇒ 鍵不同
        let mDiff = await build('str_diff', { rule: { ...UNIT_A.rule, minNotional: '21' }, uIni: '10000' })
        assert.notEqual(mDiff.key, mNum.key)
        //手寫之帳本: meta.unit 為數字字串 ⇒ 載入後 L.unit 為數值(與 unit.f64 並存);同一帳本之 meta.unit 為數值者載入結果相同
        let dHand = path.join(t.dir, 'str_hand')
        fs.cpSync(dNum, dHand, { recursive: true })
        let meta = JSON.parse(fs.readFileSync(path.join(dHand, 'meta.json'), 'utf8'))
        meta.unit = { rule: { stepSize: '0.001', minQty: '0.001', minNotional: '20' }, buffer: '0.1', uIni: '10000' }
        fs.writeFileSync(path.join(dHand, 'meta.json'), JSON.stringify(meta), 'utf8')
        let L = loadLedger(dHand)
        assert.deepStrictEqual(JSON.parse(JSON.stringify(L.unit)), { rule: { stepSize: 0.001, minQty: 0.001, minNotional: 20 }, buffer: 0.1, uIni: 10000 })
        assert.deepStrictEqual(Array.from(L.unitN), Array.from(loadLedger(dNum).unitN))
        //非數字之字串之 meta.unit ⇒ 載入拋錯(訊息不帶值)
        meta.unit.uIni = 'SECRET-xyz'
        fs.writeFileSync(path.join(dHand, 'meta.json'), JSON.stringify(meta), 'utf8')
        let err = errOf(() => loadLedger(dHand))
        assert(err instanceof Error && err.message === 'invalid meta.unit.uIni: must be a positive finite number', err && err.message)
    })

    it('單一策略之峰值名義只記錄:超過 uIni 者不拋錯、各檔照寫;nStrategyOverUIni = 峰值 > uIni 之隻數(獨立之定義;恰等於者不算);記錄列最大者與隻數', async () => {
        let m = await build('cap0', UNIT_A)
        let d0 = path.join(t.dir, 'cap0')
        let L = loadLedger(d0)
        let pks = Array.from({ length: L.n }, (_, s) => peakOfStrategy(L, s))
        let pkMax = m.unitStat.strategyPeakNotional
        //各峰值相異(取中點作門檻, 不落在浮點之邊界)—— 鑑別前提
        let ds = [...new Set(pks.filter((v) => v > 0).map((v) => v.toFixed(9)))].map(Number).sort((a, b) => b - a)
        assert(ds.length >= 4, '相異之峰值 ≥ 4(鑑別前提)')
        assert(ds[1] < pkMax * (1 - 1e-6) && pks.filter((v) => v > pkMax * (1 - 1e-6)).length === 1, '最大者唯一(鑑別前提)')
        assert.equal(m.unitStat.nStrategyOverUIni, pks.filter((v) => v > 10000).length)
        assert.equal(m.unitStat.nStrategyOverUIni, 0)
        //門檻: 恰等於最大者(不算)、略低於最大者(1 隻)、相鄰兩峰值之中點(獨立之定義;≥ 2、≥ 3 隻)、極小(有單之策略皆算)
        let byDef = (u) => pks.filter((v) => v > u).length
        let cases = [
            ['eq', pkMax, 0],
            ['justBelow', pkMax * (1 - 1e-9), 1],
            ['mid12', (ds[1] + ds[2]) / 2, byDef((ds[1] + ds[2]) / 2)],
            ['mid23', (ds[2] + ds[3]) / 2, byDef((ds[2] + ds[3]) / 2)],
            ['tiny', 1e-6, byDef(1e-6)],
        ]
        assert(cases[2][2] >= 2 && cases[3][2] > cases[2][2] && cases[4][2] > cases[3][2], '各門檻之隻數相異(鑑別前提)')
        for (let [nm, u, expN] of cases) {
            let logs = []
            let dir = path.join(t.dir, `cap_${nm}`)
            let mm = await buildLedger({ libraryRoot: lib, keyOhlc: 'SYM_4hr', endTime: END, outDir: dir, unit: { ...UNIT_A, uIni: u }, log: (s) => logs.push(s) })
            //隻數 = 獨立之定義(峰值 > uIni; 恰等於者不算)
            assert.equal(mm.unitStat.nStrategyOverUIni, expN, nm)
            //照寫出: 各檔(含 unit.f64)與 uIni 10000 者逐位相同、帳本鍵相同(研究用本金不入鍵); meta 只差 uIni 與隻數
            assert.deepStrictEqual(filesOf(dir), filesOf(d0), nm)
            for (let f of filesOf(d0).filter((f) => f !== 'meta.json')) {
                assert(bytesOf(d0, f).equals(bytesOf(dir, f)), `${nm}: ${f}`)
            }
            assert.equal(mm.key, m.key, nm)
            assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).unitStat.nStrategyOverUIni, expN, nm)
            assert.equal(mm.unitStat.strategyPeakNotional, pkMax)
            assert.equal(mm.unitStat.strategyPeakFile, m.unitStat.strategyPeakFile)
            //超過者之峰值最高之至多 10 隻之檔名(獨立之定義: 峰值降冪、同值依策略序)
            let expFiles = pks.map((v, s) => [v, s]).filter(([v]) => v > u).sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, 10).map(([, s]) => `s${s}.json`)
            if (nm !== 'eq' && nm !== 'justBelow') {
                assert.deepStrictEqual(mm.unitStat.strategyOverFiles, expFiles, nm)
            }
            assert.equal(mm.unitStat.strategyOverFiles.length, Math.min(10, expN), nm)
            if (nm === 'justBelow') {
                assert.deepStrictEqual(mm.unitStat.strategyOverFiles, [m.unitStat.strategyPeakFile])
            }
            assert.deepStrictEqual(mm.unit, { ...m.unit, uIni: u })
            //記錄: 最大者之策略與隻數(只記錄、不中止)
            let line = logs.find((s) => s.startsWith('單一策略之全期最大同時持倉名義'))
            assert(line && line.includes(m.unitStat.strategyPeakFile) && line.includes(`者 ${expN} 隻`) && line.includes('只記錄、不中止'), `${nm}: ${line}`)
            //載入照常
            assert.equal(loadLedger(dir).unitN.length, L.nBars)
        }
        //重建於既有之帳本夾(超過者 > 0)⇒ 照常重寫
        let mr = await buildLedger({ libraryRoot: lib, keyOhlc: 'SYM_4hr', endTime: END, outDir: path.join(t.dir, 'cap_tiny'), unit: { ...UNIT_A, uIni: 2e-6 }, log: quiet })
        assert.equal(JSON.parse(fs.readFileSync(path.join(t.dir, 'cap_tiny', 'meta.json'), 'utf8')).unit.uIni, 2e-6)
        assert.equal(mr.unitStat.nStrategyOverUIni, pks.filter((v) => v > 2e-6).length)
    })

    it('超過者之檔名至多 10 隻:超過者 ≥ 12 隻時取峰值最高之 10 隻(峰值降冪、同值依策略序;檔名之序 = 策略庫之檔名排序)', async () => {
        //另加 7 隻(其一與 s6 同定義 ⇒ 與最大者同峰值, 同值之序之鑑別前提); 檔名 s0 ~ s13 之排序 s0, s1, s10, …, s13, s2, …(與策略序號之數字序不同)
        let lib14 = path.join(t.dir, 'lib14')
        writeLibrary(lib14, [['long', 'price_x', '>', 0.3, 0.04, 0.03], ['short', 'price_x', '<', -0.3, 0.05, 0.02], ['long', 'price_y', '<', -0.4, 0.03, 0.05], ['short', 'price_y', '>', 0.4, 0.06, 0.04], ['long', 'price_x', '>', 0.7, 0.02, 0.02], ['short', 'price_x', '<', -0.7, 0.03, 0.03], ['long', 'price_z', '>', 0.5, 0.5, 0.5]])
        let files = fs.readdirSync(path.join(lib14, 'strategies')).filter((f) => f.endsWith('.json')).sort()
        let dir = path.join(t.dir, 'top14')
        let m = await buildLedger({ libraryRoot: lib14, keyOhlc: 'SYM_4hr', endTime: END, outDir: dir, unit: { ...UNIT_A, uIni: 1e-6 }, log: quiet })
        let L = loadLedger(dir)
        let pks = Array.from({ length: L.n }, (_, s) => peakOfStrategy(L, s))
        let over = pks.map((v, s) => [v, s]).filter(([v]) => v > 1e-6)
        assert.equal(files.length, 14)
        assert(over.length >= 12, `超過者 ≥ 12 隻(鑑別前提): ${over.length}`)
        assert.equal(m.unitStat.nStrategyOverUIni, over.length)
        //獨立之定義: 峰值降冪、同值依策略序, 取前 10 隻 → 檔名
        let exp = over.sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, 10).map(([, s]) => files[s])
        assert.deepStrictEqual(m.unitStat.strategyOverFiles, exp)
        //鑑別前提: 最大者之兩隻同峰值且皆在前 10 隻(同值之序決定其先後)、處理之序(策略序)與峰值之序不同、第 11 隻起確有被截去者
        let i6 = files.indexOf('s6.json')
        let i13 = files.indexOf('s13.json')
        assert.equal(pks[i6], pks[i13])
        assert.deepStrictEqual(exp.slice(0, 2), [files[Math.min(i6, i13)], files[Math.max(i6, i13)]])
        assert.notDeepStrictEqual(exp, over.map(([, s]) => s).sort((a, b) => a - b).slice(0, 10).map((s) => files[s]))
        assert(pks.filter((v) => v > 1e-6 && v < pks[files.indexOf(exp[9])]).length >= 2)
    })

    it('設定不合 ⇒ 讀任何檔之前拋錯(不寫出)', async () => {
        let dir = path.join(t.dir, 'bad')
        let err = await errOfAsync(() => buildLedger({ libraryRoot: path.join(t.dir, 'nope'), keyOhlc: 'SYM_4hr', endTime: END, outDir: dir, unit: { rule: RULE_A }, log: quiet }))
        assert.equal(err.message, 'invalid unit.uIni: must be a positive finite number')
        assert(!fs.existsSync(dir))
    })

    it('重建於同一資料夾而未給 unit ⇒ 移除舊之 unit.f64;載入:只有 unit.f64 或只有 meta.unit、長度不合、含非正之值 ⇒ 拋錯', async () => {
        let dir = path.join(t.dir, 'rebuild')
        await build('rebuild', UNIT_A)
        assert(fs.existsSync(path.join(dir, 'unit.f64')))
        await build('rebuild')
        assert(!fs.existsSync(path.join(dir, 'unit.f64')))
        assert(!('unitN' in loadLedger(dir)))
        //只有 unit.f64
        await build('lone', UNIT_A)
        let d2 = path.join(t.dir, 'lone')
        let meta = JSON.parse(fs.readFileSync(path.join(d2, 'meta.json'), 'utf8'))
        let mNo = { ...meta }
        delete mNo.unit
        fs.writeFileSync(path.join(d2, 'meta.json'), JSON.stringify(mNo), 'utf8')
        assert.equal(errOf(() => loadLedger(d2)).message, 'invalid unit.f64: must exist together with meta.unit (請重建帳本)')
        //只有 meta.unit
        fs.writeFileSync(path.join(d2, 'meta.json'), JSON.stringify(meta), 'utf8')
        let buf = fs.readFileSync(path.join(d2, 'unit.f64'))
        fs.rmSync(path.join(d2, 'unit.f64'))
        assert.equal(errOf(() => loadLedger(d2)).message, 'invalid unit.f64: must exist together with meta.unit (請重建帳本)')
        //長度不合
        fs.writeFileSync(path.join(d2, 'unit.f64'), buf.subarray(0, buf.length - 8))
        assert.equal(errOf(() => loadLedger(d2)).message, 'invalid unit.f64: must be meta.nBars positive finite float64 values (請重建帳本)')
        //含非正之值、NaN
        for (let v of [0, -1, NaN, Infinity]) {
            let w = new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length))
            w[5] = v
            fs.writeFileSync(path.join(d2, 'unit.f64'), Buffer.from(w.buffer))
            assert.equal(errOf(() => loadLedger(d2)).message, 'invalid unit.f64: must be meta.nBars positive finite float64 values (請重建帳本)', String(v))
        }
        //meta.unit 不合
        fs.writeFileSync(path.join(d2, 'unit.f64'), buf)
        fs.writeFileSync(path.join(d2, 'meta.json'), JSON.stringify({ ...meta, unit: { ...meta.unit, uIni: -1 } }), 'utf8')
        assert.equal(errOf(() => loadLedger(d2)).message, 'invalid meta.unit.uIni: must be a positive finite number')
    })

    it('半庫帳本(memberLedger)共用每根棒之名義與設定', async () => {
        await build('mem', UNIT_A)
        let L = loadLedger(path.join(t.dir, 'mem'))
        assert(L.unitN instanceof Float64Array && L.unitN.length === L.nBars, '帳本帶名義(鑑別前提)')
        let M = memberLedger(L, 0x5bd1e995, 0)
        assert.strictEqual(M.unitN, L.unitN)
        assert.strictEqual(M.unit, L.unit)
        let L0 = loadLedger(path.join(t.dir, 'off0'))
        let M0 = memberLedger(L0, 0x5bd1e995, 0)
        assert(!('unitN' in M0) && !('unit' in M0))
        //只有其一(手組之帳本)⇒ 半庫拒絕(不靜默以每單 1 單位評估)
        for (let [nm, un, uc] of [['unit 無 unitN', null, L.unit], ['unitN 無 unit', L.unitN, null]]) {
            let Lx = loadLedger(path.join(t.dir, 'mem'))
            Lx.unitN = un
            Lx.unit = uc
            assert.equal(errOf(() => memberLedger(Lx, 0x5bd1e995, 0)).message, 'invalid L: must be a ledger object (see loadLedger and memberLedger)', nm)
        }
    })
})


//評估器: 合成帳本(60 隻策略、2400 棒)+ 逐棒相異之名義 w[i] = 20 + ((i × 7919) mod 2400) × 0.01(7919 為質數 ⇒ 2400 棒逐棒相異; 20 ~ 43.99u)
describe('評估器之實際名義口徑(makeEvaluator 之 L.unitN / L.unit)', function () {
    this.timeout(180000)
    const CFG = { warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7, 30], nullDraws: 8, seed: 3 }
    let t
    let dir
    let dirI
    let wOf = (nBars) => Float64Array.from({ length: nBars }, (_, i) => 20 + ((i * 7919) % 2400) * 0.01)
    let UNIT_E = { rule: { ...RULE_A }, buffer: 0.1, uIni: 1e9 }
    let withUnit = (L, w, unit = UNIT_E) => {
        L.unitN = w
        L.unit = unit
        return L
    }
    let IDS = [1, 4, 7, 10, 13, 16, 19, 22, 25, 28]
    let pick = (ctx) => ({ ids: IDS.map((s) => (s + ctx.k) % ctx.n), tag: ctx.k % 3 ? 'a' : 'b' })
    let pickG = (ctx) => ({ ids: IDS.map((s) => (s + 2 * ctx.k) % ctx.n), group: [0, 0, 0, 1, 1, 1, 2, 2, 3, 3], tag: ctx.k % 2 ? 'x' : 'y' })
    let acc = (sig, book) => book.open < 6 && book.dayCount < 4
    before(() => {
        t = makeTmp('evalUnitEval')
        dir = path.join(t.dir, 'L')
        writeSynthLedger(dir, { n: 60, nBars: 2400, seed: 5 })
        dirI = path.join(t.dir, 'LI')
        writeSynthLedger(dirI, { n: 60, nBars: 2400, seed: 9, identical: true })
    })
    after(() => {
        t.cleanup()
    })
    let strip = (m) => {
        let o = JSON.parse(JSON.stringify(m))
        delete o.ms
        delete o.unit
        let walk = (x) => {
            if (x && typeof x === 'object') {
                delete x.peakNotional
                for (let v of Object.values(x)) {
                    walk(v)
                }
            }
        }
        walk(o)
        return o
    }
    //indepOp, 獨立之定義: 已下單之單 js(帳本之位置)之損益(u)= Σ 每單位損益 × 名義(已結者), 峰值名義 = 各進場棒之持倉名義和之最大值(持倉於 [進場棒, 出場棒); 未結者至期末), 等效年化 = 損益 ÷ 峰值名義 ÷ 年數 × 100
    let indepOp = (L, w, js, years) => {
        let pnl = 0
        let os = js.map((j) => {
            if (L.ext[j] >= 0) {
                pnl += L.pnl[j] * w[L.ent[j]]
            }
            return [L.ent[j], L.ext[j] >= 0 ? L.ext[j] : Infinity, w[L.ent[j]]]
        })
        let peakN = 0
        for (let [tt] of os) {
            let s = 0
            for (let [a, b, x] of os) {
                if (a <= tt && tt < b) {
                    s += x
                }
            }
            peakN = Math.max(peakN, s)
        }
        return { pnl, peakN, eqYr: peakN > 0 && years > 0 ? pnl / peakN / years * 100 : 0 }
    }
    //ordersIn, 全收: 各決策視窗 [b, b + 每窗棒數) 內選集之各策略之單之位置
    let ordersIn = (L, sels, bars, Wb) => {
        let js = []
        bars.forEach((b, k) => {
            for (let s of sels[k]) {
                for (let j = L.off[s]; j < L.off[s + 1]; j++) {
                    if (L.ent[j] >= b && L.ent[j] < b + Wb) {
                        js.push(j)
                    }
                }
            }
        })
        return js
    }

    it('名義皆為 1 ⇒ 完整評估之 metrics(去掉耗時與新增之名義欄)與未給者逐位相同(全收、執行規則、分帳)', () => {
        for (let [pk, ac] of [[pick, null], [pick, acc], [pickG, acc]]) {
            let m0 = makeEvaluator(loadLedger(dir), CFG).evalPolicy(pk, { accept: ac })
            let L1 = withUnit(loadLedger(dir), new Float64Array(2400).fill(1))
            let m1 = makeEvaluator(L1, CFG).evalPolicy(pk, { accept: ac })
            assert.deepStrictEqual(strip(m1), strip(m0))
            assert.deepStrictEqual(m1.op.peakNotional.byPhase, m0.op.peakHold.byPhase)
            assert(!('unit' in m0) && !('peakNotional' in m0.op) && !('peakNotional' in m0.fresh[7]))
        }
    })

    it('名義為同一常數(22)⇒ 等效年化、新鮮度與各虛無相等至浮點誤差、損益放大 22 倍、峰值名義 = 22 × 峰值單數', () => {
        let m0 = makeEvaluator(loadLedger(dir), CFG).evalPolicy(pick, { accept: acc })
        let m1 = makeEvaluator(withUnit(loadLedger(dir), new Float64Array(2400).fill(22)), CFG).evalPolicy(pick, { accept: acc })
        assert.equal(m1.selHash, m0.selHash)
        m0.op.eqYr.byPhase.forEach((v, i) => assert(Math.abs(v - m1.op.eqYr.byPhase[i]) <= 2e-4, `${v} vs ${m1.op.eqYr.byPhase[i]}`))
        assert(Math.abs(m1.op.pnl - 22 * m0.op.pnl) <= 2e-3 * Math.max(1, Math.abs(m0.op.pnl) * 22))
        m0.op.peakHold.byPhase.forEach((v, i) => assert.equal(m1.op.peakNotional.byPhase[i], 22 * v))
        for (let H of [7, 30]) {
            assert(Math.abs(m1.fresh[H].eqYr.mean - m0.fresh[H].eqYr.mean) <= 2e-4)
        }
        for (let k of ['null', 'nullAct', 'nullSideAct']) {
            if (m0[k]) {
                assert(Math.abs(m1[k].mean - m0[k].mean) <= 2e-3, `${k} ${m1[k].mean} vs ${m0[k].mean}`)
            }
        }
    })

    it('逐棒相異之名義:各相位之等效年化、峰值名義與損益 = 獨立之定義(全收);選集指紋與未給者相同', () => {
        let L0 = loadLedger(dir)
        let w = wOf(2400)
        let L1 = withUnit(loadLedger(dir), w)
        let ev0 = makeEvaluator(L0, CFG)
        let ev1 = makeEvaluator(L1, CFG)
        let m0 = ev0.evalPolicy(pick)
        let m1 = ev1.evalPolicy(pick)
        assert.equal(m1.selHash, m0.selHash)
        assert.deepStrictEqual(m1.op.nOrders, m0.op.nOrders)
        assert.deepStrictEqual(m1.op.peakHold, m0.op.peakHold)
        assert.deepStrictEqual(m1.op.monthlyOrders, m0.op.monthlyOrders)
        let pnlSum = 0
        let r4 = (x) => Math.round(x * 10000) / 10000
        CFG.phases.forEach((ph, i) => {
            let r = ev1.runPick(pick, ph, CFG.seed)
            let years = r.bars.length * 7 / 365.25
            let d = indepOp(L1, w, ordersIn(L1, r.sels, r.bars, 42), years)
            //未捨入之值(opOf)與獨立之定義相等至浮點誤差; 完整評估之各相位 = 其捨入
            let o = ev1.opOf(r.sels, r.bars, r.tags, null)
            assert(relClose(o.eqYr, d.eqYr), `相位 ${ph}: ${o.eqYr} vs ${d.eqYr}`)
            assert(relClose(o.peakNotional, d.peakN), `相位 ${ph} 峰值名義 ${o.peakNotional} vs ${d.peakN}`)
            assert(relClose(o.totalPnl, d.pnl))
            assert.equal(m1.op.eqYr.byPhase[i], r4(o.eqYr))
            assert.equal(m1.op.peakNotional.byPhase[i], r4(o.peakNotional))
            assert.notEqual(m1.op.eqYr.byPhase[i], m0.op.eqYr.byPhase[i], '名義相異時與每單 1 單位不同(鑑別前提)')
            pnlSum += d.pnl
        })
        assert(relClose(m1.op.pnl, Math.round(pnlSum / CFG.phases.length * 10000) / 10000, 1e-6))
        //損益歸因: 兩側之和 = 各子帳之和 = 合計(u)
        let side = m1.op.bySide.long.pnl + m1.op.bySide.short.pnl
        assert(Math.abs(side - m1.op.pnl) <= 2e-4, `${side} vs ${m1.op.pnl}`)
        assert(Math.abs(m1.op.byGroup.reduce((s, g) => s + g.pnl, 0) - m1.op.pnl) <= 2e-4)
        assert(Math.abs(m1.sel.tagPerf.reduce((s, g) => s + g.pnl, 0) - m1.op.pnl) <= 2e-4)
        //結果帶設定
        assert.deepStrictEqual(m1.unit, { rule: { ...RULE_A }, buffer: 0.1, uIni: 1e9 })
    })

    it('逐棒相異之名義:執行規則之下單 = 獨立之定義;執行規則所見之 sig / book(單數、每單位損益之和)與未給者逐次相同', () => {
        let L0 = loadLedger(dir)
        let w = wOf(2400)
        let L1 = withUnit(loadLedger(dir), w)
        let ev0 = makeEvaluator(L0, CFG)
        let ev1 = makeEvaluator(L1, CFG)
        for (let ph of CFG.phases) {
            let r = ev1.runPick(pick, ph, CFG.seed)
            let seen0 = []
            let seen1 = []
            let js = []
            let rec = (seen, take) => (sig, book) => {
                let ok = acc(sig, book)
                seen.push(`${sig.sid}|${sig.bar}|${sig.mode}|${book.open}|${book.openLong}|${book.openShort}|${book.dayCount}|${book.winCount}|${book.nAccepted}|${book.pnlClosed}|${ok}`)
                if (ok && take) {
                    for (let j = L1.off[sig.sid]; j < L1.off[sig.sid + 1]; j++) {
                        if (L1.ent[j] === sig.bar) {
                            js.push(j)
                        }
                    }
                }
                return ok
            }
            let o0 = ev0.opOf(r.sels, r.bars, r.tags, rec(seen0, false))
            let o1 = ev1.opOf(r.sels, r.bars, r.tags, rec(seen1, true))
            assert.deepStrictEqual(seen1, seen0)
            assert.equal(o1.hash, o0.hash)
            assert.equal(o1.peakHold, o0.peakHold)
            assert.equal(js.length, o1.nOrders)
            let d = indepOp(L1, w, js, r.bars.length * 7 / 365.25)
            assert(relClose(o1.eqYr, d.eqYr), `${o1.eqYr} vs ${d.eqYr}`)
            assert(relClose(o1.peakNotional, d.peakN))
            assert(relClose(o1.totalPnl, d.pnl))
            assert(!('peakNotional' in o0))
        }
    })

    it('逐棒相異之名義:挑選函數所見之 ctx.stat / ctx.orders / ctx.meta 與未給者逐次相同', () => {
        let w = wOf(2400)
        let rec = (out) => (ctx) => {
            let B = ctx.stat(30)
            let B0 = ctx.stat()
            out.push(JSON.stringify([Array.from(B.pnl), Array.from(B0.pnl), Array.from(B.closed), Array.from(B0.open), ctx.orders(ctx.k % ctx.n), Object.keys(ctx.meta)]))
            return pick(ctx)
        }
        let a = []
        let b = []
        makeEvaluator(loadLedger(dir), CFG).runPick(rec(a), 0, 3)
        makeEvaluator(withUnit(loadLedger(dir), w), CFG).runPick(rec(b), 0, 3)
        assert(a.length > 30)
        assert(a.some((x) => /[1-9]/.test(x)), '統計非全 0(鑑別前提)')
        assert.deepStrictEqual(b, a)
    })

    it('新鮮度:等效年化之分母 = 各窗峰值名義之最大值(獨立之定義;全收)', () => {
        let w = wOf(2400)
        let L1 = withUnit(loadLedger(dir), w)
        let ev1 = makeEvaluator(L1, CFG)
        let H = 7
        let r = ev1.runPick(pick, 0, CFG.seed)
        let f = ev1.freshOf(r.sels, r.bars, r.tags, null, H)
        let sum = 0
        let nw = 0
        let mx = 0
        r.bars.forEach((b0, k) => {
            if (b0 + H * 6 > 2400) {
                return
            }
            let d = indepOp(L1, w, ordersIn(L1, [r.sels[k]], [b0], H * 6), 1)
            sum += d.pnl
            nw++
            mx = Math.max(mx, d.peakN)
        })
        assert(relClose(f.peakNotional, mx))
        assert(relClose(f.eqYr, (sum / nw) / (H / 365.25) / mx * 100))
    })

    it('各虛無與對照:策略皆相同之帳本 ⇒ 任一替換之選集與成品同單 ⇒ 各虛無之均 = 成品之等效年化(獨立之定義;名義逐棒相異)', () => {
        let w = wOf(2400)
        let L1 = withUnit(loadLedger(dirI), w)
        let ev1 = makeEvaluator(L1, { ...CFG, phases: [0] })
        let m = ev1.evalPolicy(pick)
        let r = ev1.runPick(pick, 0, CFG.seed)
        let d = indepOp(L1, w, ordersIn(L1, r.sels, r.bars, 42), r.bars.length * 7 / 365.25)
        assert(Math.abs(m.op.eqYr.mean - d.eqYr) <= 1e-4)
        let nNull = 0
        for (let k of ['null', 'nullVol', 'nullAct', 'nullSideAct', 'nullSideGeo']) {
            if (m[k] && typeof m[k].mean === 'number') {
                nNull++
                assert(Math.abs(m[k].mean - d.eqYr) <= 1e-3, `${k}: ${m[k].mean} vs ${d.eqYr}`)
            }
        }
        assert(nNull >= 2, '至少兩種虛無有算')
        let m0 = makeEvaluator(loadLedger(dirI), { ...CFG, phases: [0] }).evalPolicy(pick)
        assert(Math.abs(m0.null.mean - m.null.mean) > 1e-3, '與每單 1 單位不同(鑑別前提)')
    })

    it('擴充診斷之 api.simulate 重放成品之選集 = 成品之操作績效(實際名義口徑)', () => {
        let w = wOf(2400)
        let ev1 = makeEvaluator(withUnit(loadLedger(dir), w), CFG)
        let m = ev1.evalPolicy(pick, { accept: acc, ext: [{ name: 'd', fn: (api) => ({ sim: api.simulate(api.phases.map((p) => p.sels)), obs: api.obs.byPhase }) }] })
        assert.strictEqual(m.ext.d.error, undefined, m.ext.d.error)
        m.op.eqYr.byPhase.forEach((v, i) => assert(Math.abs(m.ext.d.sim.byPhase[i] - v) <= 1e-4, `${m.ext.d.sim.byPhase[i]} vs ${v}`))
        //鑑別前提: 與每單 1 單位之重放不同
        let m0 = makeEvaluator(loadLedger(dir), CFG).evalPolicy(pick, { accept: acc, ext: [{ name: 'd', fn: (api) => ({ sim: api.simulate(api.phases.map((p) => p.sels)) }) }] })
        assert.notDeepStrictEqual(m0.ext.d.sim.byPhase, m.ext.d.sim.byPhase)
        assert(Math.abs(m.ext.d.sim.bySide.long.pnl + m.ext.d.sim.bySide.short.pnl - m.op.pnl) <= 2e-4)
    })

    it('求解窗後段(afterFitOnly):名義皆為 1 ⇒ 與未給者逐位相同;逐棒相異 ⇒ 選集統計不變、等效年化依名義', () => {
        let cfg = { ...CFG, fitEnd: { long: timeOf(900), short: timeOf(1100) } }
        let m0 = makeEvaluator(loadLedger(dir), cfg).evalPolicy(pick, { accept: acc, afterFitOnly: true, fromBar: 950, nullDraws: 4 })
        assert(m0.afterFit.seatsDropped > 0, '有捨去之席(鑑別前提)')
        let m1 = makeEvaluator(withUnit(loadLedger(dir), new Float64Array(2400).fill(1)), cfg).evalPolicy(pick, { accept: acc, afterFitOnly: true, fromBar: 950, nullDraws: 4 })
        assert.deepStrictEqual(strip(m1), strip(m0))
        let m2 = makeEvaluator(withUnit(loadLedger(dir), wOf(2400)), cfg).evalPolicy(pick, { accept: acc, afterFitOnly: true, fromBar: 950, nullDraws: 4 })
        assert.equal(m2.selHash, m0.selHash)
        assert.deepStrictEqual(m2.afterFit.seatsKept, m0.afterFit.seatsKept)
        assert.deepStrictEqual(m2.afterFit.orders, m0.afterFit.orders)
        assert.notDeepStrictEqual(m2.op.eqYr.byPhase, m0.op.eqYr.byPhase)
    })

    it('研究用本金:操作績效之峰值持倉名義超過 uIni ⇒ 拋 isCapitalError(code EVAL_UNIT_CAPITAL);恰等於者通過(邊界);未給基礎單位者不檢', () => {
        let w = wOf(2400)
        //未捨入之峰值名義(各相位之最大者; 與完整評估之操作績效同一模擬)
        let ev = makeEvaluator(withUnit(loadLedger(dir), w), CFG)
        let pk = Math.max(...CFG.phases.map((ph) => {
            let r = ev.runPick(pick, ph, CFG.seed)
            return ev.opOf(r.sels, r.bars, r.tags, acc).peakNotional
        }))
        let mOk = makeEvaluator(withUnit(loadLedger(dir), w, { ...UNIT_E, uIni: pk }), CFG).evalPolicy(pick, { accept: acc })
        assert.equal(mOk.op.peakNotional.max, Math.round(pk * 10000) / 10000)
        let err = errOf(() => makeEvaluator(withUnit(loadLedger(dir), w, { ...UNIT_E, uIni: pk * (1 - 1e-12) }), CFG).evalPolicy(pick, { accept: acc }))
        assert(isCapitalError(err), String(err && err.message))
        assert.equal(err.code, 'EVAL_UNIT_CAPITAL')
        assert.equal(err.message, 'invalid peak notional of open orders: must not exceed the research capital (unit.uIni)')
        //模組拋出之同名錯誤不算
        let fake = new Error(err.message)
        fake.code = 'EVAL_UNIT_CAPITAL'
        assert(!isCapitalError(fake) && !isCapitalError(null) && !isCapitalError('x'))
        //未給基礎單位者: 峰值單數再大也不檢
        assert.doesNotThrow(() => makeEvaluator(loadLedger(dir), CFG).evalPolicy(pick, { accept: acc }))
    })

    it('makeEvaluator 之負向:unitN 與 unit 只給其一、unitN 型別 / 長度不合或含非正之值、unit 不合 ⇒ 拒絕建評估器', () => {
        let w = wOf(2400)
        let mk = (un, uc) => errOf(() => {
            let L = loadLedger(dir)
            L.unitN = un
            L.unit = uc
            makeEvaluator(L, CFG)
        })
        let MSG = 'invalid L.unitN: must be a Float64Array of length L.nBars with positive finite values (base-unit notional of each bar)'
        assert.equal(mk(w, null).message, 'invalid L.unitN: must be given together with L.unit (see loadLedger)')
        assert.equal(mk(null, UNIT_E).message, 'invalid L.unitN: must be given together with L.unit (see loadLedger)')
        assert.equal(mk(Array.from(w), UNIT_E).message, MSG)
        assert.equal(mk(Float32Array.from(w), UNIT_E).message, MSG)
        assert.equal(mk(w.subarray(1), UNIT_E).message, MSG)
        for (let v of [0, -1, NaN, Infinity]) {
            let w2 = Float64Array.from(w)
            w2[77] = v
            assert.equal(mk(w2, UNIT_E).message, MSG, String(v))
        }
        assert.equal(mk(w, { rule: RULE_A }).message, 'invalid L.unit.uIni: must be a positive finite number')
        assert.strictEqual(mk(undefined, undefined), null)
    })

    it('L.unit 之數值為數字字串 ⇒ 轉為數值後使用(跨套件規格 K4;結果與數值之設定逐位相同、metrics.unit 為數值);非數字之字串 ⇒ 拒絕建評估器(訊息不帶值)', () => {
        let w = wOf(2400)
        let cut = (m) => {
            let o = JSON.parse(JSON.stringify(m))
            delete o.ms
            return o
        }
        let ev = (u) => makeEvaluator(withUnit(loadLedger(dir), w, u), CFG).evalPolicy(pick, { accept: acc })
        let a = ev({ rule: { ...RULE_A }, buffer: 0.1, uIni: 1e9 })
        let b = ev({ rule: { stepSize: '0.001', minQty: '1e-3', minNotional: ' 20 ' }, buffer: '0.1', uIni: '1e9' })
        assert.deepStrictEqual(b.unit, { rule: { stepSize: 0.001, minQty: 0.001, minNotional: 20 }, buffer: 0.1, uIni: 1e9 })
        assert.deepStrictEqual(cut(b), cut(a))
        let err = errOf(() => makeEvaluator(withUnit(loadLedger(dir), w, { rule: { ...RULE_A }, buffer: 0.1, uIni: 'SECRET-xyz' }), CFG))
        assert(err instanceof Error && err.message === 'invalid L.unit.uIni: must be a positive finite number', err && err.message)
    })

    //鍵之次序(deepStrictEqual 不比鍵之次序, 故以 Object.keys 逐物件比): 路徑(m = metrics;陣列元素以 [] 表之)→ 該路徑全部物件之鍵之次序(逗號連接)
    //  KEYS_1021 = 以 1.0.21 之評估器於合成帳本(60 隻策略、2400 棒、seed 5;CFG 同本 describe)對 pickG + accept 實跑所得(另對 pick + accept、pick 無 accept 各跑一次,三者逐路徑相同)
    let KEYS_1021 = {
        'm': ['version,ledgerKey,period,phases,horizons,hasAccept,op,fresh,sel,null,nullVol,nullAct,nullSideAct,nullSideGeo,selHash,ms'],
        'm.period': ['time0,endTime,firstDecision,warmupDays,cadenceDays,evalFrom,evalTo,firstEvalDecision'],
        'm.op': ['eqYr,monthlyOrders,peakHold,winRate,acceptRate,nSignals,nOrders,nUnsettled,nDecisions,pnl,bySide,byGroup,thirds'],
        'm.op.eqYr': ['mean,min,max,sd,byPhase'],
        'm.op.monthlyOrders': ['mean,min,max,sd,byPhase'],
        'm.op.peakHold': ['mean,min,max,sd,byPhase'],
        'm.op.bySide': ['long,short'],
        'm.op.bySide.long': ['orders,pnl,winRate'],
        'm.op.bySide.short': ['orders,pnl,winRate'],
        'm.op.byGroup[]': ['group,seats,orders,pnl,winRate'],
        'm.op.thirds[]': ['from,to,eqYr,nullMean'],
        'm.op.thirds[].eqYr': ['mean,min,max'],
        'm.fresh': ['7,30'],
        'm.fresh.7': ['eqYr,posRate,peakHold,nWindows'],
        'm.fresh.7.eqYr': ['mean,min,max,sd,byPhase'],
        'm.fresh.30': ['eqYr,posRate,peakHold,nWindows'],
        'm.fresh.30.eqYr': ['mean,min,max,sd,byPhase'],
        'm.sel': ['sizeMean,sizeMin,sizeMax,nEmpty,turnoverJaccard,sizeDist,emptyRate,tags,tagKinds,sigPerPick,longRatio,nKeysMean,tpMean,slMean,orders,tagPerf'],
        'm.sel.sizeDist': ['p10,p50,p90'],
        'm.sel.tags[]': ['tag,share'],
        'm.sel.orders': ['strats,combos,barTop1Share,perBarMax'],
        'm.sel.tagPerf[]': ['tag,decisions,orders,pnl,pnlPerOrder'],
        'm.null': ['draws,mean,sd,p95,max,p,z,excess,sigPerPick,longRatio'],
        'm.nullSideAct': ['draws,half,mean,sd,p,z,excess,sigPerPick,share,thirdsMean,triggered'],
        'm.nullSideGeo': ['draws,half,mean,sd,p,z,excess,sigPerPick,share,thirdsMean,nTp,nSl'],
        'm.ms': ['pick,metrics,null,total'],
    }
    let keyOrdersOf = (m) => {
        let acc2 = {}
        let walk = (x, p) => {
            if (Array.isArray(x)) {
                for (let v of x) {
                    walk(v, `${p}[]`)
                }
            }
            else if (x && typeof x === 'object' && !ArrayBuffer.isView(x)) {
                ;(acc2[p] = acc2[p] || new Set()).add(Object.keys(x).join(','))
                for (let [k, v] of Object.entries(x)) {
                    walk(v, `${p}.${k}`)
                }
            }
        }
        walk(m, 'm')
        return Object.fromEntries(Object.entries(acc2).map(([p, s]) => [p, [...s].sort()]))
    }
    it('未給基礎單位時,評估結果內全部物件之鍵與其次序與 1.0.21 逐一相同(26 個物件路徑,含 metrics、op、fresh[H]);開啟者只於約定之位置多鍵(unit 接在 hasAccept 之後、op.peakNotional 接在 peakHold 之後、fresh[H].peakNotional 在末),其餘物件之鍵與次序不變', () => {
        let off = keyOrdersOf(makeEvaluator(loadLedger(dir), CFG).evalPolicy(pickG, { accept: acc }))
        assert.deepStrictEqual(Object.keys(off).sort(), Object.keys(KEYS_1021).sort())
        for (let [p, v] of Object.entries(KEYS_1021)) {
            assert.deepStrictEqual(off[p], v, p)
        }
        //無執行規則、另一種挑選函數(無分帳)者:同一組路徑之鍵之次序同(未出現之路徑除外)
        for (let m of [makeEvaluator(loadLedger(dir), CFG).evalPolicy(pick, { accept: acc }), makeEvaluator(loadLedger(dir), CFG).evalPolicy(pick)]) {
            let o = keyOrdersOf(m)
            for (let [p, v] of Object.entries(o)) {
                assert.deepStrictEqual(v, KEYS_1021[p], p)
            }
        }
        //開啟者: 其餘路徑不變,三處多鍵之位置與新增之路徑
        let on = keyOrdersOf(makeEvaluator(withUnit(loadLedger(dir), wOf(2400)), CFG).evalPolicy(pickG, { accept: acc }))
        let exp = { ...KEYS_1021 }
        exp['m'] = [KEYS_1021['m'][0].replace(',hasAccept,op,', ',hasAccept,unit,op,')]
        exp['m.op'] = [KEYS_1021['m.op'][0].replace(',peakHold,winRate,', ',peakHold,peakNotional,winRate,')]
        exp['m.fresh.7'] = [`${KEYS_1021['m.fresh.7'][0]},peakNotional`]
        exp['m.fresh.30'] = [`${KEYS_1021['m.fresh.30'][0]},peakNotional`]
        exp['m.unit'] = ['rule,buffer,uIni']
        exp['m.unit.rule'] = ['stepSize,minQty,minNotional']
        exp['m.op.peakNotional'] = ['mean,min,max,sd,byPhase']
        assert.notDeepStrictEqual(exp['m'], KEYS_1021['m'])
        assert.notDeepStrictEqual(exp['m.op'], KEYS_1021['m.op'])
        assert.deepStrictEqual(Object.keys(on).sort(), Object.keys(exp).sort())
        for (let [p, v] of Object.entries(exp)) {
            assert.deepStrictEqual(on[p], v, p)
        }
    })

    it('評估器之名義為自己之複本:建評估器後改 L.unitN 不影響結果', () => {
        let w = wOf(2400)
        let L = withUnit(loadLedger(dir), w)
        let ev = makeEvaluator(L, CFG)
        let a = ev.evalPolicy(pick).op.eqYr
        w.fill(1)
        let b = ev.evalPolicy(pick).op.eqYr
        assert.deepStrictEqual(b, a)
        //鑑別前提: 名義全為 1 者(= 改後之 w)之結果與 a 不同
        let c = makeEvaluator(withUnit(loadLedger(dir), new Float64Array(2400).fill(1)), CFG).evalPolicy(pick).op.eqYr
        assert.notDeepStrictEqual(c, a)
    })

    it('兩條模擬路徑之一致:全收(差分)與「accept 恆真」(逐訊號)之損益、峰值名義、等效年化相等(至浮點誤差;操作績效與新鮮度)', () => {
        let w = wOf(2400)
        let ev = makeEvaluator(withUnit(loadLedger(dir), w), CFG)
        let all = () => true
        for (let ph of CFG.phases) {
            let r = ev.runPick(pick, ph, CFG.seed)
            let a = ev.opOf(r.sels, r.bars, r.tags, null)
            let b = ev.opOf(r.sels, r.bars, r.tags, all)
            //鑑別前提: 兩路下同一組單(單數之峰值與下單數逐位相同)、名義逐棒相異(峰值名義 ≠ 峰值單數 × 任一棒之名義)
            assert.equal(b.peakHold, a.peakHold)
            assert.equal(b.nOrders, a.nOrders)
            assert(a.nOrders > 50 && a.peakHold > 3, '下單與持倉足以鑑別')
            assert(relClose(b.totalPnl, a.totalPnl, 1e-12), `${b.totalPnl} vs ${a.totalPnl}`)
            assert(relClose(b.peakNotional, a.peakNotional, 1e-12), `${b.peakNotional} vs ${a.peakNotional}`)
            assert(relClose(b.eqYr, a.eqYr, 1e-12), `${b.eqYr} vs ${a.eqYr}`)
            for (let H of CFG.horizons) {
                let fa = ev.freshOf(r.sels, r.bars, r.tags, null, H)
                let fb = ev.freshOf(r.sels, r.bars, r.tags, all, H)
                assert(relClose(fb.peakNotional, fa.peakNotional, 1e-12) && relClose(fb.eqYr, fa.eqYr, 1e-12), `H ${H}: ${fb.eqYr} vs ${fa.eqYr}`)
            }
        }
    })

    it('研究用本金只檢成品之操作績效:新鮮度之峰值名義 > uIni ≥ 成品之峰值名義 ⇒ 不中止(新鮮度、各虛無與對照、擴充診斷之重放不檢)', () => {
        let w = wOf(2400)
        //脈衝式之選集(每 4 個決策有一次 40 隻): 新鮮度 30 日窗之峰值名義高於成品之操作績效(決策間隔 7 日)
        let pulse = (ctx) => (ctx.k % 4 === 0 ? Array.from({ length: 40 }, (_, i) => (i + ctx.k) % ctx.n) : [ctx.k % ctx.n])
        let ev = makeEvaluator(withUnit(loadLedger(dir), w), CFG)
        let opPk = Math.max(...CFG.phases.map((ph) => {
            let r = ev.runPick(pulse, ph, CFG.seed)
            return ev.opOf(r.sels, r.bars, r.tags, null).peakNotional
        }))
        //擴充診斷之重放: 選集各加 6 隻(其峰值名義高於 uIni; 鑑別前提以評估器之 opOf 核)
        let aug = (sels) => sels.map((s) => Array.from(new Set(Array.from(s).concat([0, 1, 2, 3, 4, 5]))))
        let r0 = ev.runPick(pulse, CFG.phases[0], CFG.seed)
        let augPk = ev.opOf(aug(r0.sels), r0.bars, r0.tags, null).peakNotional
        assert(augPk > opPk * 1.02, `擴充診斷之重放之峰值名義 ${augPk} > uIni ${opPk}(鑑別前提)`)
        let m = makeEvaluator(withUnit(loadLedger(dir), w, { ...UNIT_E, uIni: opPk }), CFG).evalPolicy(pulse, { ext: [{ name: 'd', fn: (api) => ({ sim: api.simulate(api.phases.map((p) => aug(p.sels))) }) }] })
        assert(m.fresh[30].peakNotional > opPk * 1.05, `新鮮度之峰值名義 ${m.fresh[30].peakNotional} > uIni ${opPk}(鑑別前提)`)
        assert.strictEqual(m.ext.d.error, undefined, m.ext.d.error)
        assert(Array.isArray(m.ext.d.sim.byPhase) && m.ext.d.sim.byPhase.every((v) => Number.isFinite(v)))
        assert(Number.isFinite(m.op.eqYr.mean))
        //對照: uIni 略低於成品之峰值 ⇒ 中止
        let err = errOf(() => makeEvaluator(withUnit(loadLedger(dir), w, { ...UNIT_E, uIni: opPk * (1 - 1e-9) }), CFG).evalPolicy(pulse))
        assert(isCapitalError(err))
        //錯誤另帶計算值(相位、峰值持倉名義、研究用本金)
        assert(CFG.phases.includes(err.phase) && err.peakNotional > err.uIni && err.uIni === opPk * (1 - 1e-9), JSON.stringify({ phase: err.phase, pk: err.peakNotional, u: err.uIni }))
    })

    it('以帳本全期算得之統計(meta.unitStat)不交給挑選函數與擴充診斷:ctx.meta / api.meta 不含 unitStat 與 unit', () => {
        let L = withUnit(loadLedger(dir), wOf(2400))
        L.meta = { ...L.meta, unit: UNIT_E, unitStat: { notionalMin: 20, notionalMax: 44, strategyPeakNotional: 99, strategyPeakFile: 's1.json', nStrategyOverUIni: 0, strategyOverFiles: [] } }
        let seen = []
        let m = makeEvaluator(L, CFG).evalPolicy((ctx) => {
            seen.push(Object.keys(ctx.meta).join(','))
            return pick(ctx)
        }, { ext: [{ name: 'd', fn: (api) => ({ keys: Object.keys(api.meta) }) }] })
        assert(seen.length > 0)
        for (let ks of [...seen, m.ext.d.keys.join(',')]) {
            assert(!/unitStat|unit|strategyPeak/.test(ks), ks)
        }
    })
})


describe('命令列(g_eval.mjs 之帳本與設定之比對、研究用本金;g_build.mjs 之 source.unit)', function () {
    this.timeout(180000)
    let t
    before(() => {
        t = makeTmp('evalUnitCli')
    })
    after(() => {
        t.cleanup()
    })
    //mkProject, 合成專案根(帳本 2400 棒; 訓練期終點第 1200 棒、回測期起點第 1290 棒); unitLedger 給者另寫 unit.f64(逐棒相異)與 meta.unit; unitSet 給者寫入 settings.source.unit
    //  records.workDir = <根>/work: 挑選模組另放一份於 work/n1/pick.mjs(pickW; 節點之工作夾內 ⇒ 評估紀錄寫於其旁之 .evals.log); 根之 pick.mjs 不在工作夾內(不記)
    let mkProject = (name, { unitLedger = null, unitSet = null, libraryRoot = null, fitEnd = null } = {}) => {
        let root = path.join(t.dir, name)
        let ld = path.join(root, 'ledger', 'eval')
        writeSynthLedger(ld, { n: 60, nBars: 2400, seed: 7 })
        if (unitLedger) {
            let w = Float64Array.from({ length: 2400 }, (_, i) => 20 + ((i * 7919) % 2400) * 0.01)
            fs.writeFileSync(path.join(ld, 'unit.f64'), Buffer.from(w.buffer))
            let meta = JSON.parse(fs.readFileSync(path.join(ld, 'meta.json'), 'utf8'))
            fs.writeFileSync(path.join(ld, 'meta.json'), JSON.stringify({ ...meta, unit: unitLedger }), 'utf8')
        }
        fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
            periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' }, holdoutFrom: '2099-01-01T00:00:00' },
            source: { libraryRoot: libraryRoot || path.join(root, 'nolib'), keyOhlc: 'SYM_4hr', barHours: 4, ...(unitSet ? { unit: unitSet } : {}) },
            eval: { ledgerDir: './ledger/eval', warmupDays: 60, cadenceDays: 7, phases: [0], horizons: [7], nullDraws: 4, seed: 1, ...(fitEnd ? { fitEnd } : {}), limits: { monthlyOrders: 400, peakHold: 50 } },
            score: { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] },
            rsi: { root: './rsi' },
            records: { workDir: './work' },
            dispatch: {},
        }), 'utf8')
        let src = 'export default function pick(ctx) { return [1, 5, 9, 13, 17, 21, 25].map((s) => (s + ctx.k) % ctx.n) }\nexport function accept(sig, book) { return book.open < 5 }\n'
        fs.writeFileSync(path.join(root, 'pick.mjs'), src, 'utf8')
        fs.mkdirSync(path.join(root, 'work', 'n1'), { recursive: true })
        fs.writeFileSync(pickW(root), src, 'utf8')
        return root
    }
    let pickW = (root) => path.join(root, 'work', 'n1', 'pick.mjs')
    let evalsOf = (root) => (fs.existsSync(path.join(root, 'work', 'n1', '.evals.log')) ? fs.readFileSync(path.join(root, 'work', 'n1', '.evals.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
    let run = (root, script, args, env0 = {}, nodeArgs = []) => {
        let env = { ...process.env, ARSI_ROOT: root, ...env0 }
        for (let k of ['ARSI_HARNESS', 'ARSI_LEDGER_DIR', 'ARSI_EVAL_FROM']) {
            if (!(k in env0)) {
                delete env[k]
            }
        }
        let r = spawnSync(process.execPath, [...nodeArgs, path.join(FD_ROOT, 'src', 'cli', script), ...args], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 150000 })
        return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
    }
    let U = { rule: { ...RULE_A }, buffer: 0.1, uIni: 10000 }

    it('皆未給 ⇒ 照常評估(結果無 unit 欄);設定與帳本之基礎單位相同 ⇒ 評估依名義(結果帶 unit 與峰值名義, 印基礎單位一列);選集指紋兩者相同', () => {
        let r0 = mkProject('off')
        let a = run(r0, 'eval.mjs', ['--pick', path.join(r0, 'pick.mjs'), '--mode', 'full', '--out', path.join(r0, 'o.json')])
        assert.equal(a.status, 0, a.out.slice(0, 1500))
        assert(!/基礎單位/.test(a.out))
        let o0 = JSON.parse(fs.readFileSync(path.join(r0, 'o.json'), 'utf8'))
        assert(!('unit' in o0.metrics))
        let r1 = mkProject('on', { unitLedger: U, unitSet: { ...U, rule: { ...RULE_A, asOf: 'z' } } })
        let b = run(r1, 'eval.mjs', ['--pick', path.join(r1, 'pick.mjs'), '--mode', 'full', '--out', path.join(r1, 'o.json')])
        assert.equal(b.status, 0, b.out.slice(0, 1500))
        assert(/基礎單位\(交易規則 步長 0\.001/.test(b.out) && /名義 [0-9.]+u\)/.test(b.out) && /各單依其基礎單位名義計之損益和\(u\)/.test(b.out), b.out.slice(0, 1500))
        let o1 = JSON.parse(fs.readFileSync(path.join(r1, 'o.json'), 'utf8'))
        assert.deepStrictEqual(o1.metrics.unit, U)
        assert(o1.metrics.op.peakNotional.max > 0)
        assert.equal(o1.metrics.selHash, o0.metrics.selHash)
        assert.notEqual(o1.score.S, o0.score.S)
    })

    it('設定之數值為數字字串 ⇒ 轉為數值後與帳本比對(與數字之設定同一結果:評估相同、比對通過);數值不同者仍為 LEDGER_UNIT_MISMATCH;非數字之字串 ⇒ SOURCE_UNIT_INVALID(不帶值)', () => {
        let STR = { rule: { stepSize: '0.001', minQty: ' 0.001 ', minNotional: '2e1', asOf: 'z' }, buffer: '0.1', uIni: '10000' }
        let rn = mkProject('num_on', { unitLedger: U, unitSet: { ...U, rule: { ...RULE_A, asOf: 'z' } } })
        let rs = mkProject('str_on', { unitLedger: U, unitSet: STR })
        let a = run(rn, 'eval.mjs', ['--pick', path.join(rn, 'pick.mjs'), '--mode', 'full', '--out', path.join(rn, 'o.json')])
        let b = run(rs, 'eval.mjs', ['--pick', path.join(rs, 'pick.mjs'), '--mode', 'full', '--out', path.join(rs, 'o.json')])
        assert.equal(a.status, 0, a.out.slice(0, 1500))
        assert.equal(b.status, 0, b.out.slice(0, 1500))
        let oa = JSON.parse(fs.readFileSync(path.join(rn, 'o.json'), 'utf8'))
        let ob = JSON.parse(fs.readFileSync(path.join(rs, 'o.json'), 'utf8'))
        assert.deepStrictEqual(ob.metrics.unit, U, '結果之基礎單位 = 帳本自帶者(數值)')
        for (let k of ['unit', 'op', 'fresh', 'selHash', 'null']) {
            assert.deepStrictEqual(ob.metrics[k], oa.metrics[k], k)
        }
        assert.equal(ob.score.S, oa.score.S)
        //數值不同(字串寫法) ⇒ 比對不合: 交易規則
        let rd = mkProject('str_diff', { unitLedger: U, unitSet: { ...STR, rule: { ...STR.rule, stepSize: '0.002' } } })
        let d = run(rd, 'eval.mjs', ['--pick', path.join(rd, 'pick.mjs'), '--mode', 'full', '--out', path.join(rd, 'o.json')])
        assert.equal(d.status, 2, d.out.slice(0, 800))
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(rd, 'o.json'), 'utf8')).mismatch, ['rule'])
        //研究用本金之字串寫法不同值 ⇒ 不合: uIni
        let ru = mkProject('str_uini', { unitLedger: U, unitSet: { ...STR, uIni: '9999' } })
        let u = run(ru, 'eval.mjs', ['--pick', path.join(ru, 'pick.mjs'), '--mode', 'full', '--out', path.join(ru, 'o.json')])
        assert.equal(u.status, 2, u.out.slice(0, 800))
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(ru, 'o.json'), 'utf8')).mismatch, ['uIni'])
        //非數字之字串 ⇒ 設定不合(訊息不帶值)
        let rb = mkProject('str_bad', { unitLedger: U, unitSet: { ...STR, buffer: 'SECRET-xyz' } })
        let e = run(rb, 'eval.mjs', ['--pick', path.join(rb, 'pick.mjs'), '--mode', 'full', '--out', path.join(rb, 'o.json')])
        assert.equal(e.status, 2, e.out.slice(0, 800))
        assert(!e.out.includes('SECRET-xyz') && e.out.includes('invalid source.unit.buffer: must be a non-negative finite number'), e.out.slice(0, 800))
        let ob2 = JSON.parse(fs.readFileSync(path.join(rb, 'o.json'), 'utf8'))
        assert.equal(ob2.code, 'SOURCE_UNIT_INVALID')
        assert(!JSON.stringify(ob2).includes('SECRET-xyz'))
    })

    //misOf, 比對不合 ⇒ 離開碼 2、失敗之結果檔(覆寫前次之結果; 帶不合之項, --member 者另帶 member)
    let MSG_MAIN = 'invalid ledger: must be rebuilt with the current source.unit of settings'
    let MSG_OTHER = 'invalid ledger: must have the same presence, buffer and uIni of unit as source.unit of settings (ledger of ARSI_LEDGER_DIR)'
    let misOf = (root, r, nm, mismatch, { other = false, member = null } = {}) => {
        assert.equal(r.status, 2, `${nm}: ${r.out.slice(0, 800)}`)
        assert(r.out.includes(other ? MSG_OTHER : `${MSG_MAIN} (node g_build.mjs)`), r.out.slice(0, 800))
        if (other) {
            assert(!r.out.includes('g_build'), '他份帳本不由 g_build.mjs 建 ⇒ 訊息不指之')
        }
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'o.json'), 'utf8')), { ok: false, ...(member ? { member } : {}), error: other ? MSG_OTHER : MSG_MAIN, code: 'LEDGER_UNIT_MISMATCH', mismatch }, nm)
    }
    let stale = (root) => fs.writeFileSync(path.join(root, 'o.json'), JSON.stringify({ ok: true, stale: 1 }), 'utf8')
    it('設定與帳本之基礎單位不同(一方未給、交易規則 / 緩衝 / 研究用本金不同)⇒ 不評估(離開碼 2;給 --out 者寫失敗之結果檔 LEDGER_UNIT_MISMATCH〔不合之項、--member 者之 member〕、不留前次之結果、不記評估紀錄);設定本身不合 ⇒ 同(SOURCE_UNIT_INVALID)', () => {
        //對照(評估紀錄之機制於此設定下確實會寫 —— 「不記」之斷言之鑑別前提): 相同 ⇒ 成功一列; 研究用本金之中止 ⇒ 失敗一列
        let rok = mkProject('mis_ctl_ok', { unitLedger: U, unitSet: U })
        assert.equal(run(rok, 'eval.mjs', ['--pick', pickW(rok)]).status, 0)
        assert.deepStrictEqual(evalsOf(rok).map((x) => x.ok), [true], '成功者記一列(對照)')
        let u30 = { ...U, uIni: 30 }
        let rcap = mkProject('mis_ctl_cap', { unitLedger: u30, unitSet: u30 })
        assert.equal(run(rcap, 'eval.mjs', ['--pick', pickW(rcap)]).status, 3)
        assert.deepStrictEqual(evalsOf(rcap).map((x) => x.code), ['EVAL_UNIT_CAPITAL'], '失敗者亦記一列(對照)')
        let cases = [
            ['a', { unitLedger: null, unitSet: U }, ['presence']],
            ['b', { unitLedger: U, unitSet: null }, ['presence']],
            ['c', { unitLedger: U, unitSet: { ...U, rule: { ...RULE_A, minNotional: 5 } } }, ['rule']],
            ['d', { unitLedger: U, unitSet: { ...U, buffer: 0 } }, ['buffer']],
            ['e', { unitLedger: U, unitSet: { ...U, uIni: 5000 } }, ['uIni']],
            ['f', { unitLedger: U, unitSet: { rule: { ...RULE_A, minQty: 0.01 }, buffer: 0.2, uIni: 5000 } }, ['rule', 'buffer', 'uIni']],
        ]
        for (let [nm, o, mis] of cases) {
            let root = mkProject(`mis_${nm}`, o)
            //前次之成功結果(應被覆寫)
            stale(root)
            let r = run(root, 'eval.mjs', ['--pick', pickW(root), '--out', path.join(root, 'o.json')])
            misOf(root, r, nm, mis)
            assert.deepStrictEqual(evalsOf(root), [], `${nm}: 不記評估紀錄`)
        }
        //--member 之重放比對不合 ⇒ 失敗之結果檔帶 member(看得出是哪一半)
        let rm = mkProject('mis_m', { unitLedger: U, unitSet: { ...U, buffer: 0.2 } })
        misOf(rm, run(rm, 'eval.mjs', ['--pick', pickW(rm), '--member', '0x5bd1e995:1', '--out', path.join(rm, 'o.json')]), 'member', ['buffer'], { member: { tag: '0x5bd1e995:1', salt: 0x5bd1e995, half: 1 } })
        assert.deepStrictEqual(evalsOf(rm), [])
        //迴圈之重放(ARSI_HARNESS=1)而未給 ARSI_LEDGER_DIR ⇒ 仍比對
        let rh = mkProject('mis_h', { unitLedger: U, unitSet: { ...U, rule: { ...RULE_A, minNotional: 5 } } })
        misOf(rh, run(rh, 'eval.mjs', ['--pick', path.join(rh, 'pick.mjs'), '--no-log', '--out', path.join(rh, 'o.json')], { ARSI_HARNESS: '1' }), 'harness 無他份帳本', ['rule'])
        //設定本身不合 ⇒ 離開碼 2; 給 --out 者寫失敗之結果檔(SOURCE_UNIT_INVALID; 不留前次之結果; --member 者帶 member)、不記評估紀錄
        let root = mkProject('mis_bad', { unitSet: { rule: RULE_A } })
        let r = run(root, 'eval.mjs', ['--pick', pickW(root)])
        assert.equal(r.status, 2)
        assert(/invalid source\.unit\.uIni: must be a positive finite number/.test(r.out))
        stale(root)
        let r2 = run(root, 'eval.mjs', ['--pick', pickW(root), '--member', '0x5bd1e995:0', '--out', path.join(root, 'o.json')])
        assert.equal(r2.status, 2)
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'o.json'), 'utf8')), { ok: false, member: { tag: '0x5bd1e995:0', salt: 0x5bd1e995, half: 0 }, error: 'invalid source.unit.uIni: must be a positive finite number', code: 'SOURCE_UNIT_INVALID' })
        assert.deepStrictEqual(evalsOf(root), [], '不記評估紀錄')
    })

    it('迴圈之重放改用他份帳本(ARSI_HARNESS=1 且 ARSI_LEDGER_DIR)⇒ 只放寬交易規則之三個數值(以該帳本自帶者為準);設定有給 ⇔ 帳本帶基礎單位、緩衝與研究用本金須相同,不合 ⇒ 離開碼 2', () => {
        let H = (dir) => ({ ARSI_HARNESS: '1', ARSI_LEDGER_DIR: path.join(dir, 'ledger', 'eval') })
        let args = (root) => ['--pick', path.join(root, 'pick.mjs'), '--no-log', '--out', path.join(root, 'o.json')]
        //兩者皆有而交易規則不同 ⇒ 通過(以他份帳本之規則評估)
        let other = mkProject('other', { unitLedger: { ...U, rule: { stepSize: 0.001, minQty: 0.001, minNotional: 50 } } })
        let root = mkProject('main', { unitSet: U })
        let r = run(root, 'eval.mjs', args(root), H(other))
        assert.equal(r.status, 0, r.out.slice(0, 800))
        assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'o.json'), 'utf8')).metrics.unit.rule.minNotional, 50)
        //皆未給 ⇒ 通過(每單 1 單位)
        let plain = mkProject('other_plain')
        let r0 = mkProject('main_plain')
        let a0 = run(r0, 'eval.mjs', args(r0), H(plain))
        assert.equal(a0.status, 0, a0.out.slice(0, 800))
        assert(!('unit' in JSON.parse(fs.readFileSync(path.join(r0, 'o.json'), 'utf8')).metrics))
        //設定有給而他份帳本未帶、設定未給而他份帳本帶、緩衝不同、研究用本金不同 ⇒ 離開碼 2 與失敗之結果檔(訊息依分支: 不指 g_build.mjs; 不合之項不含 rule)
        let cases = [
            ['setOnly', { unitSet: U }, plain, ['presence']],
            ['ledgerOnly', {}, other, ['presence']],
            ['buffer', { unitSet: { ...U, buffer: 0.2 } }, other, ['buffer']],
            ['uIni', { unitSet: { ...U, uIni: 20000 } }, other, ['uIni']],
            ['both', { unitSet: { ...U, buffer: 0.2, uIni: 20000 } }, other, ['buffer', 'uIni']],
        ]
        for (let [nm, o, src, mis] of cases) {
            let rr = mkProject(`hm_${nm}`, o)
            misOf(rr, run(rr, 'eval.mjs', args(rr), H(src)), nm, mis, { other: true })
        }
    })

    it('操作績效之峰值持倉名義超過研究用本金 ⇒ ERROR EVAL_UNIT_CAPITAL、離開碼 3、結果檔 { ok: false, code }', () => {
        let u = { ...U, uIni: 30 }
        let root = mkProject('cap', { unitLedger: u, unitSet: u })
        let r = run(root, 'eval.mjs', ['--pick', path.join(root, 'pick.mjs'), '--out', path.join(root, 'o.json')])
        assert.equal(r.status, 3, r.out.slice(0, 800))
        assert(/ERROR EVAL_UNIT_CAPITAL invalid peak notional of open orders/.test(r.out))
        let o = JSON.parse(fs.readFileSync(path.join(root, 'o.json'), 'utf8'))
        assert.equal(o.ok, false)
        assert.equal(o.code, 'EVAL_UNIT_CAPITAL')
        //另帶計算值: 相位(設定之相位之一)、該相位之峰值持倉名義(> uIni)、研究用本金; 畫面同列
        assert.equal(o.phase, 0)
        assert.equal(o.uIni, 30)
        assert(o.peakNotional > 30 && Number.isFinite(o.peakNotional), JSON.stringify(o))
        //畫面之峰值持倉名義至多 4 位小數(結果檔保留原值; 鑑別前提: 原值之小數多於 4 位)
        let m = /相位 0:峰值持倉名義 ([0-9.]+)u > 研究用本金 30u/.exec(r.out)
        assert(m, r.out.slice(0, 800))
        assert(/^\d+(\.\d{1,4})?$/.test(m[1]) && Math.abs(Number(m[1]) - o.peakNotional) <= 5e-5, `${m[1]} vs ${o.peakNotional}`)
        assert(!/^\d+(\.\d{1,4})?$/.test(String(o.peakNotional)), `原值之小數多於 4 位(鑑別前提): ${o.peakNotional}`)
    })

    it('其餘組合:--member(半庫)、--period train、--period postfit 配帶名義之帳本 ⇒ 照常評估且結果帶 metrics.unit;選集指紋與未帶名義者相同', () => {
        let fitEnd = { long: '2022-11-01T00:00:00', short: '2023-02-01T00:00:00' }
        let r1 = mkProject('combo_on', { unitLedger: U, unitSet: U, fitEnd })
        let r0 = mkProject('combo_off', { fitEnd })
        for (let [nm, extra] of [['member', ['--member', '0x5bd1e995:1']], ['train', ['--period', 'train']], ['postfit', ['--period', 'postfit']]]) {
            let outs = []
            for (let root of [r1, r0]) {
                let fo = path.join(root, `${nm}.json`)
                let r = run(root, 'eval.mjs', ['--pick', path.join(root, 'pick.mjs'), '--mode', 'full', '--out', fo, ...extra])
                assert.equal(r.status, 0, `${nm}: ${r.out.slice(0, 1200)}`)
                outs.push(JSON.parse(fs.readFileSync(fo, 'utf8')))
            }
            assert.deepStrictEqual(outs[0].metrics.unit, U, nm)
            assert(!('unit' in outs[1].metrics), nm)
            assert(outs[0].metrics.op.peakNotional.max > 0, nm)
            assert.equal(outs[0].metrics.selHash, outs[1].metrics.selHash, nm)
        }
    })

    it('g_build.mjs:source.unit 有給 ⇒ 帳本帶 unit.f64 與 meta.unit;單一策略之峰值名義超過 uIni ⇒ 照寫出、離開碼 0、列一行 WARN(隻數與最大者);設定不合 ⇒ 離開碼 2、不寫出', () => {
        let lib = path.join(t.dir, 'blib')
        writeLibrary(lib)
        let mk = (name, unitSet) => {
            let root = mkProject(name, { libraryRoot: lib, unitSet })
            fs.rmSync(path.join(root, 'ledger'), { recursive: true, force: true })
            let st = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'))
            st.periods.backtest.end = END
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(st), 'utf8')
            return root
        }
        let ok = mk('b_ok', U)
        let a = run(ok, 'build.mjs', [])
        assert.equal(a.status, 0, a.out.slice(0, 1500))
        let L = loadLedger(path.join(ok, 'ledger', 'eval'))
        assert.deepStrictEqual(JSON.parse(JSON.stringify(L.unit)), U)
        assert.equal(L.unitN[10], 22)
        //輸出之摘要帶 unitStat(超過者 0 ⇒ 無 WARN)
        let sumOf = (out) => JSON.parse(out.split(/\r?\n/).find((l) => l.startsWith('{"key"')))
        let sa = sumOf(a.out)
        assert.equal(sa.unitStat.nStrategyOverUIni, 0)
        assert(sa.unitStat.strategyPeakNotional > 1 && /^s\d+\.json$/.test(sa.unitStat.strategyPeakFile))
        assert(!/^WARN /m.test(a.out), a.out.slice(0, 1500))
        //研究用本金 1 ⇒ 有單之策略皆超過: 照寫出、離開碼 0、WARN 一行(隻數與最大者)
        let cap = mk('b_cap', { ...U, uIni: 1 })
        let b = run(cap, 'build.mjs', [])
        assert.equal(b.status, 0, b.out.slice(0, 1500))
        let sb = sumOf(b.out)
        let Lb = loadLedger(path.join(cap, 'ledger', 'eval'))
        let nHas = Array.from({ length: Lb.n }, (_, s) => peakOfStrategy(Lb, s)).filter((v) => v > 1).length
        assert(nHas >= 4, '鑑別前提')
        assert.equal(sb.unitStat.nStrategyOverUIni, nHas)
        let warn = b.out.split(/\r?\n/).filter((l) => l.startsWith('WARN '))
        assert.equal(warn.length, 1, b.out.slice(0, 1500))
        assert(warn[0].includes(`研究用本金 1u 者 ${nHas} 隻`) && warn[0].includes(sb.unitStat.strategyPeakFile) && warn[0].includes(`${sb.unitStat.strategyPeakNotional}u`) && warn[0].includes('帳本已寫出'), warn[0])
        assert.equal(sb.key, sa.key, '研究用本金不入鍵')
        assert(fs.existsSync(path.join(cap, 'ledger', 'eval', 'meta.json')) && fs.existsSync(path.join(cap, 'ledger', 'eval', 'unit.f64')))
        let bad = mk('b_bad', { ...U, rule: { ...RULE_A, stepSize: 'abc' } })
        let c = run(bad, 'build.mjs', [])
        assert.equal(c.status, 2)
        assert(/ERROR invalid source\.unit\.rule\.stepSize: must be a positive finite number/.test(c.out), c.out.slice(0, 800))
        assert(c.out.split(/\r?\n/).includes('ERROR invalid source.unit.rule.stepSize: must be a positive finite number') && !fs.existsSync(path.join(bad, 'ledger', 'eval', 'meta.json')), '訊息不帶輸入值、不寫出')
        //數字字串(跨套件規格之數字類): 通過即轉為數值 ⇒ 與數字之設定得同一帳本(各檔逐位相同、鍵相同、meta.unit 為數值)
        let strU = mk('b_str', { rule: { stepSize: '0.001', minQty: ' 0.001 ', minNotional: '20' }, buffer: '0.1', uIni: '1e4' })
        let cs = run(strU, 'build.mjs', [])
        assert.equal(cs.status, 0, cs.out.slice(0, 1500))
        let dOk = path.join(ok, 'ledger', 'eval')
        let dStr = path.join(strU, 'ledger', 'eval')
        assert.deepStrictEqual(filesOf(dStr), filesOf(dOk))
        for (let f of filesOf(dOk).filter((f) => f !== 'meta.json')) {
            assert(bytesOf(dOk, f).equals(bytesOf(dStr, f)), f)
        }
        assert.equal(sumOf(cs.out).key, sa.key, '數字字串與數字之設定得同一帳本鍵')
        let mStr = JSON.parse(fs.readFileSync(path.join(dStr, 'meta.json'), 'utf8'))
        assert.deepStrictEqual(mStr.unit, { rule: { stepSize: 0.001, minQty: 0.001, minNotional: 20 }, buffer: 0.1, uIni: 10000 }, 'meta.unit 為轉換後之數值')
        assert.deepStrictEqual(JSON.parse(JSON.stringify(loadLedger(dStr).unit)), { rule: { stepSize: 0.001, minQty: 0.001, minNotional: 20 }, buffer: 0.1, uIni: 10000 })
        let off = mk('b_off', null)
        let d = run(off, 'build.mjs', [])
        assert.equal(d.status, 0, d.out.slice(0, 800))
        assert(!fs.existsSync(path.join(off, 'ledger', 'eval', 'unit.f64')))
        //每根棒之名義求不出(回測套件拋錯; 格數超過安全整數)⇒ 離開碼 2、指出該棒之時間、不帶回測套件之訊息(其帶輸入值)
        let huge = mk('b_huge', { ...U, rule: { stepSize: 1e-300, minQty: 1e-300, minNotional: 1e10 } })
        let e = run(huge, 'build.mjs', [])
        assert.equal(e.status, 2, e.out.slice(0, 800))
        assert(e.out.includes(`ERROR invalid source.unit: must give a base-unit quantity at every bar (calcBaseUnitQuantity failed; first at bar ${timeOf(0)})`), e.out.slice(0, 800))
        assert(!/1e-300|10000000000/.test(e.out))
        assert(!fs.existsSync(path.join(huge, 'ledger', 'eval', 'meta.json')))
    })

    //相依之隔離: 以解析鉤子(node --import)使 w-trade-backtest/src/calcBaseUnitQuantity.mjs 之解析失敗(模擬相依為不含該檔之回測套件版本)
    //  未給設定之路徑(載入、建帳本、評估、兩支命令列)須正常; 給了設定者得到明確之錯誤(invalid unit…; 命令列離開碼 2), 不是載入失敗之堆疊
    let HOOKS = 'export async function resolve(s, c, n) { if (String(s).includes(\'calcBaseUnitQuantity\')) { let e = new Error(\'simulated: module not found\'); e.code = \'ERR_MODULE_NOT_FOUND\'; throw e } return n(s, c) }'
    let hookOf = (src) => 'data:text/javascript,' + encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(src))});`)
    let IMPORT_HOOK = hookOf(HOOKS)
    //HOOKS_DEP: 該檔在、而其所匯入之相依缺漏(只擋由該檔發出之裸名匯入 —— 不依回測套件之該檔匯入哪些套件)
    let HOOKS_DEP = 'export async function resolve(s, c, n) { if (!/^(\\.|node:|file:|data:)/.test(String(s)) && String(c.parentURL || \'\').includes(\'calcBaseUnitQuantity\')) { let e = new Error(\'simulated: dependency not found\'); e.code = \'ERR_MODULE_NOT_FOUND\'; throw e } return n(s, c) }'
    let MSG_DEP = 'invalid unit: must be used with a w-trade-backtest that provides calcBaseUnitQuantity and its dependencies (upgrade or reinstall w-trade-backtest)'
    it('相依之隔離:回測套件不含 calcBaseUnitQuantity(或其相依缺漏)時,未給設定者之載入、建帳本、評估與兩支命令列皆正常;給了設定者得到明確之錯誤(離開碼 2;原錯誤於 cause)', () => {
        let lib = path.join(t.dir, 'dlib')
        writeLibrary(lib)
        let child = path.join(t.dir, 'depChild.mjs')
        let u = (p) => JSON.stringify(pathToFileURL(path.join(FD_ROOT, 'src', 'eval', p)).href)
        fs.writeFileSync(child, [
            `let res = {}`,
            `try { import.meta.resolve('w-trade-backtest/src/calcBaseUnitQuantity.mjs'); res.topResolves = true } catch (e) { res.topResolves = false }`,
            `try { await import('w-trade-backtest/src/calcBaseUnitQuantity.mjs'); res.hookBlocks = false } catch (e) { res.hookBlocks = e.code === 'ERR_MODULE_NOT_FOUND' }`,
            `let { buildLedger } = await import(${u('ledgerBuild.mjs')})`,
            `let { loadLedger } = await import(${u('ledger.mjs')})`,
            `let { makeEvaluator, ntStaticOf } = await import(${u('evalCore.mjs')})`,
            `let lib = process.argv[2]; let out = process.argv[3]; let END = process.argv[4]`,
            `let m = await buildLedger({ libraryRoot: lib, keyOhlc: 'SYM_4hr', endTime: END, outDir: out + '/off', log: () => {} })`,
            `res.offKey = m.key`,
            `let L = loadLedger(out + '/off')`,
            `L.ntStatic = ntStaticOf(L, L.nBars)`,
            `let ev = makeEvaluator(L, { warmupDays: 10, cadenceDays: 7 })`,
            `let r = ev.evalPolicy((ctx) => [0, 1, 2], { phases: [0], horizons: [7], nullDraws: 2, seed: 1 })`,
            `res.evalOk = Number.isFinite(r.op.eqYr.mean) && !('unit' in r)`,
            `try { await buildLedger({ libraryRoot: lib, keyOhlc: 'SYM_4hr', endTime: END, outDir: out + '/on', unit: { rule: { stepSize: 0.001, minQty: 0.001, minNotional: 20 }, uIni: 10000 }, log: () => {} }); res.onErr = null } catch (e) { res.onErr = e.message; res.onCauseCode = e.cause ? e.cause.code : null }`,
            `console.log('RESULT ' + JSON.stringify(res))`,
        ].join('\n'), 'utf8')
        //兩種缺漏(該檔不在 / 該檔之相依不在)皆得同一明確之錯誤, 原錯誤於 cause
        for (let [nm, hook, topResolves] of [['top', IMPORT_HOOK, false], ['dep', hookOf(HOOKS_DEP), true]]) {
            let rc = spawnSync(process.execPath, ['--import', hook, child, lib, path.join(t.dir, `dout_${nm}`), END], { cwd: t.dir, windowsHide: true, encoding: 'utf8', timeout: 150000 })
            let line = `${rc.stdout}`.split(/\r?\n/).find((l) => l.startsWith('RESULT '))
            assert(line, `${nm}: ${rc.stdout}\n${rc.stderr}`.slice(0, 2000))
            let res = JSON.parse(line.slice(7))
            assert.equal(res.hookBlocks, true, `${nm}: 鉤子確實使該檔之載入失敗(鑑別前提)`)
            assert.equal(res.topResolves, topResolves, `${nm}: 缺漏之處(鑑別前提)`)
            assert.equal(typeof res.offKey, 'string', nm)
            assert.equal(res.evalOk, true, nm)
            assert.equal(res.onErr, MSG_DEP, nm)
            assert.equal(res.onCauseCode, 'ERR_MODULE_NOT_FOUND', nm)
            assert(!fs.existsSync(path.join(t.dir, `dout_${nm}`, 'on', 'meta.json')), nm)
        }
        //命令列: 未給設定 ⇒ g_build、g_eval 照常(離開碼 0); 給了設定 ⇒ g_build 離開碼 2 與明確之錯誤
        let mkB = (name, unitSet) => {
            let root = mkProject(name, { libraryRoot: lib, unitSet })
            fs.rmSync(path.join(root, 'ledger'), { recursive: true, force: true })
            let st = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'))
            st.periods.backtest.end = END
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(st), 'utf8')
            return root
        }
        let off = mkB('dep_off', null)
        let a = run(off, 'build.mjs', [], {}, ['--import', IMPORT_HOOK])
        assert.equal(a.status, 0, a.out.slice(0, 1500))
        let ev0 = mkProject('dep_eval')
        let b = run(ev0, 'eval.mjs', ['--pick', path.join(ev0, 'pick.mjs'), '--out', path.join(ev0, 'o.json')], {}, ['--import', IMPORT_HOOK])
        assert.equal(b.status, 0, b.out.slice(0, 1500))
        assert.equal(JSON.parse(fs.readFileSync(path.join(ev0, 'o.json'), 'utf8')).ok, true)
        let on = mkB('dep_on', U)
        let c = run(on, 'build.mjs', [], {}, ['--import', IMPORT_HOOK])
        assert.equal(c.status, 2, c.out.slice(0, 1500))
        assert(c.out.includes(`ERROR ${MSG_DEP.replace(/^invalid unit/, 'invalid source.unit')}`), c.out.slice(0, 1500))
        assert(!/ERR_MODULE_NOT_FOUND|at async|simulated/.test(c.out), '不是載入失敗之堆疊、不印原錯誤')
    })

    //回測套件之函數之錯誤與回傳: 以解析鉤子把 calcBaseUnitQuantity 換成假之模組(依環境變數 FAKE_CBUQ; 只對價格 2001 之棒不合, 其餘回 22)
    //  type = 拋 TypeError(訊息帶輸入值)⇒ 轉為 invalid unit…, 原錯誤於 cause, 訊息不帶值; zero / neg / nan / inf / str / none = 回傳之名義不合 ⇒ 建置時即拒絕(不寫出)
    let FAKE_SRC = 'export default function (p) { let m = process.env.FAKE_CBUQ; if (p !== 2001) { return { notional: 22 } } if (m === \'type\') { throw new TypeError(\'fake failure at price \' + p) } return { notional: { zero: 0, neg: -1, nan: NaN, inf: Infinity, str: \'22\', none: undefined }[m] } }'
    let HOOKS_FAKE = `export async function resolve(s, c, n) { if (String(s).includes('calcBaseUnitQuantity')) { return { url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(FAKE_SRC))}, shortCircuit: true } } return n(s, c) }`
    it('回測套件之函數拋錯 ⇒ invalid unit…(原錯誤於 cause、訊息不帶值;命令列只印訊息);未拋錯而回傳之名義非正或非有限 ⇒ 建置時即拒絕(離開碼 2、不寫出)', () => {
        let child = path.join(t.dir, 'fakeChild.mjs')
        let u = (p) => JSON.stringify(pathToFileURL(path.join(FD_ROOT, 'src', 'eval', p)).href)
        fs.writeFileSync(child, [
            `let { unitNotionalOf } = await import(${u('unitNotional.mjs')})`,
            `let { normUnit } = await import(${u('unit.mjs')})`,
            `let nu = normUnit({ rule: { stepSize: 0.001, minQty: 0.001, minNotional: 20 }, uIni: 10000 })`,
            `let res = {}`,
            `try { res.ok = Array.from(unitNotionalOf([2000, 1999], nu)) } catch (e) { res.ok = e.message }`,
            `try { unitNotionalOf([2000, 2001, 2001], nu, ['t0', 't1', 't2']); res.err = null } catch (e) { res.err = e.message; res.cause = e.cause ? { name: e.cause.name, message: e.cause.message } : null }`,
            `console.log('RESULT ' + JSON.stringify(res))`,
        ].join('\n'), 'utf8')
        let MSG_NP = 'invalid unit: must give a positive finite base-unit notional at every bar (calcBaseUnitQuantity returned a non-positive or non-finite notional; first at bar t1)'
        for (let m of ['type', 'zero', 'neg', 'nan', 'inf', 'str', 'none']) {
            let rc = spawnSync(process.execPath, ['--import', hookOf(HOOKS_FAKE), child], { cwd: t.dir, env: { ...process.env, FAKE_CBUQ: m }, windowsHide: true, encoding: 'utf8', timeout: 150000 })
            let line = `${rc.stdout}`.split(/\r?\n/).find((l) => l.startsWith('RESULT '))
            assert(line, `${m}: ${rc.stdout}\n${rc.stderr}`.slice(0, 2000))
            let res = JSON.parse(line.slice(7))
            assert.deepStrictEqual(res.ok, [22, 22], `${m}: 假之模組確實取代之(鑑別前提)`)
            if (m === 'type') {
                assert.equal(res.err, 'invalid unit: must give a base-unit quantity at every bar (calcBaseUnitQuantity failed; first at bar t1)')
                assert.deepStrictEqual(res.cause, { name: 'TypeError', message: 'fake failure at price 2001' }, '原錯誤於 cause')
                assert(!/2001/.test(res.err), '訊息不帶值')
            }
            else {
                assert.equal(res.err, MSG_NP, m)
                assert.strictEqual(res.cause, null, m)
            }
        }
        //命令列: 拋錯 ⇒ 離開碼 2、只印訊息(不印原錯誤之訊息與堆疊)、不寫出; 回傳之名義不合 ⇒ 同
        let lib = path.join(t.dir, 'flib')
        let pcs = writeLibrary(lib)
        //合成策略庫須含價格 2001 之棒(假之模組只對其不合)⇒ 改第 20 棒之收盤價為 2001(鑑別前提)
        let fo = path.join(lib, 'ohlc', 'SYM_4hr.json')
        let ohlc = JSON.parse(fs.readFileSync(fo, 'utf8'))
        assert(!pcs.includes(200100))
        ohlc[20].Close = 2001
        fs.writeFileSync(fo, JSON.stringify(ohlc), 'utf8')
        for (let [m, msg] of [['type', `ERROR invalid source.unit: must give a base-unit quantity at every bar (calcBaseUnitQuantity failed; first at bar ${timeOf(20)})`], ['zero', `ERROR invalid source.unit: must give a positive finite base-unit notional at every bar (calcBaseUnitQuantity returned a non-positive or non-finite notional; first at bar ${timeOf(20)})`]]) {
            let root = mkProject(`fake_${m}`, { libraryRoot: lib, unitSet: U })
            fs.rmSync(path.join(root, 'ledger'), { recursive: true, force: true })
            let st = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'))
            st.periods.backtest.end = END
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(st), 'utf8')
            let r = run(root, 'build.mjs', [], { FAKE_CBUQ: m }, ['--import', hookOf(HOOKS_FAKE)])
            assert.equal(r.status, 2, `${m}: ${r.out.slice(0, 1500)}`)
            assert(r.out.includes(msg), `${m}: ${r.out.slice(0, 1500)}`)
            assert(!/fake failure|TypeError|at async|\b2001\b/.test(r.out), `${m}: 只印訊息`)
            assert(!fs.existsSync(path.join(root, 'ledger', 'eval', 'meta.json')), m)
        }
    })
})


describe('領域接線與聚合入口(envKey 之研究用本金、聚合入口之匯出)', function () {
    let t
    before(() => {
        t = makeTmp('evalUnitDomain')
    })
    after(() => {
        t.cleanup()
    })
    //envOf, 以給定之帳本 meta 建專案(不派工)取 envKey
    let envOf = (name, meta) => {
        let st = getSettings()
        let d = path.join(t.dir, name)
        st.rsi.root = path.join(d, 'rsi')
        st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(d, 'ledger')
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify(meta), 'utf8')
        let P = makeProject(st, { dispatch: async () => ({ ok: false, error: '測試不派工' }), gate: null, catalogFile: path.join(d, 'catalog.json') })
        return { envKey: P.envKey, id: P.idOf({ arms: [P.selectable[0].id], base: null }) }
    }

    it('envKey:未開啟基礎單位者不變(帳本鍵 | 評估器版本);開啟者另併入研究用本金(研究用本金不入帳本鍵, 改了須重算)', () => {
        let a = envOf('a', { key: 'synth' })
        assert.equal(a.envKey, 'synth|eval2')
        let U1 = { rule: { ...RULE_A }, buffer: 0.1, uIni: 10000 }
        let b = envOf('b', { key: 'synth', unit: U1 })
        let c = envOf('c', { key: 'synth', unit: { ...U1, uIni: 5000 } })
        assert.equal(b.envKey, 'synth|eval2|uIni10000')
        assert.equal(c.envKey, 'synth|eval2|uIni5000')
        //節點識別隨之(同一個 spec 於不同之評估環境為不同之節點)
        assert(a.id !== b.id && b.id !== c.id)
        assert.equal(envOf('a2', { key: 'synth' }).id, a.id)
        //meta.unit 之研究用本金為數字字串 ⇒ 與評估器載入帳本時同一轉換(K4)⇒ 同一個鍵;meta.unit 不合者不併入(載入帳本時評估器拒絕並指明)
        let s1 = envOf('s1', { key: 'synth', unit: { ...U1, uIni: '10000' } })
        assert.deepStrictEqual(s1, b)
        assert.deepStrictEqual(envOf('s2', { key: 'synth', unit: { ...U1, uIni: ' 1e4 ' } }), b)
        assert.equal(envOf('s3', { key: 'synth', unit: { ...U1, uIni: 'abc' } }).envKey, 'synth|eval2')
        assert.equal(envOf('s4', { key: 'synth', unit: { ...U1, uIni: -5 } }).envKey, 'synth|eval2')
        assert.equal(envOf('s5', { key: 'synth', unit: 'x' }).envKey, 'synth|eval2')
        assert.equal(envOf('s6', { key: 'synth', unit: null }).envKey, 'synth|eval2')
    })

    it('迴圈之重跑失敗之訊息與回傳帶結果檔之 code(研究用本金之中止與挑選函數崩潰同為離開碼 3,以 code 分辨)', async () => {
        //假之評估入口: 寫失敗之結果檔(code EVAL_UNIT_CAPITAL)、離開碼 3
        let fd = path.join(t.dir, 'fdv')
        fs.mkdirSync(fd, { recursive: true })
        fs.writeFileSync(path.join(fd, 'g_eval.mjs'), 'import fs from \'fs\'\nlet a = process.argv\nlet o = a[a.indexOf(\'--out\') + 1]\nfs.writeFileSync(o, JSON.stringify({ ok: false, error: \'invalid peak notional of open orders: must not exceed the research capital (unit.uIni)\', code: \'EVAL_UNIT_CAPITAL\', phase: 0, peakNotional: 31, uIni: 30 }))\nprocess.exit(3)\n', 'utf8')
        let wd = path.join(t.dir, 'wdv')
        fs.mkdirSync(wd, { recursive: true })
        fs.writeFileSync(path.join(wd, 'pick.mjs'), 'export default () => [0]\n', 'utf8')
        let verify = makeVerify({ st: getSettings(), FD_ROOT: fd, layerOfSpec: () => 0 })
        let r = await verify({ nodeId: 'n1', spec: { arms: [] }, workDir: wd })
        assert.equal(r.ok, false)
        assert.equal(r.code, 'EVAL_UNIT_CAPITAL')
        assert(r.error.startsWith('重跑失敗(離開碼 3; EVAL_UNIT_CAPITAL): invalid peak notional of open orders'), r.error)
    })

    //接縫不用替身: 真 w-recursi + 本套件真實之領域(makeProject 之 reverifyAll → verify → 子行程之評估入口); 只有「派工」換成假的(本案不派)
    //  評估入口以專案根之進入檔起(其設 ARSI_ROOT = 自身所在) ⇒ 整段於子行程內執行(ARSI_ROOT = 合成專案之根; 其進入檔 g_eval.mjs 指向本套件之 src/cli/eval.mjs)
    it('啟用基礎單位(帳本帶名義並重建、設定給 source.unit)→ reverifyAll ⇒ 樹之節點與其 id 不變、選集指紋不變、結果依新口徑(metrics.unit、S 改變);envKey 改變(同一 spec 於新環境之 id 不同)', function () {
        this.timeout(600000)
        let root = path.join(t.dir, 'rv')
        let ld = path.join(root, 'ledger', 'eval')
        writeSynthLedger(ld, { n: 60, nBars: 2400, seed: 7 })
        let base = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
        let settings = {
            ...base,
            periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' }, holdoutFrom: '2099-01-01T00:00:00' },
            source: { libraryRoot: path.join(root, 'nolib'), keyOhlc: 'SYM_4hr', barHours: 4 },
            eval: { ledgerDir: ld, replicaSeeds: 0, warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7], nullDraws: 4, seed: 1, limits: { monthlyOrders: 400, peakHold: 50 }, timeoutSec: 900 },
            backtest: { ...base.backtest, enabled: false },
            rsi: { ...base.rsi, root: path.join(root, 'rsi') },
            records: { nodeDir: path.join(root, 'rsi/records/nodes'), dreamDir: path.join(root, 'rsi/records/dreams'), trashDir: path.join(root, 'rsi/records/trash'), workDir: path.join(root, 'rsi/work'), toolboxDir: path.join(root, 'rsi/toolbox') },
            //資源閘關閉: 參考設定之門檻依全機負載而定, 測試之成敗不得隨機器之負載而變
            resources: {},
        }
        fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
        fs.mkdirSync(path.join(root, 'arms'), { recursive: true })
        fs.copyFileSync(path.join(FD_ROOT, 'arms', 'base.json'), path.join(root, 'arms', 'base.json'))
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(settings), 'utf8')
        let SRC = pathToFileURL(path.join(FD_ROOT, 'src')).href + '/'
        fs.writeFileSync(path.join(root, 'g_eval.mjs'), `import path from 'path'\nimport { fileURLToPath } from 'url'\nprocess.env.ARSI_ROOT = path.dirname(fileURLToPath(import.meta.url))\nawait import(${JSON.stringify(SRC + 'cli/eval.mjs')})\n`, 'utf8')
        let U2 = { rule: { ...RULE_A }, buffer: 0.1, uIni: 10000 }
        fs.writeFileSync(path.join(root, 'child.mjs'), `import fs from 'fs'
import path from 'path'
let { getSettings } = await import(${JSON.stringify(SRC + 'cfg.mjs')})
let { makeProject } = await import(${JSON.stringify(SRC + 'domain/domain.mjs')})
let { specHash } = await import(${JSON.stringify(SRC + 'engineApi.mjs')})
let root = process.env.ARSI_ROOT
let ld = path.join(root, 'ledger', 'eval')
let mkP = () => makeProject(getSettings(), { dispatch: async () => ({ ok: false, error: 'no dispatch in test' }), gate: null, catalogFile: path.join(root, 'catalog.json') })
let res = {}
let P = mkP()
P.rsi.init()
let arm = P.selectable[0].id
let spec = { arms: [arm], base: null }
let id = P.idOf(spec)
P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round: 1, raw: { attempt: 1 } })
let wd = path.join(root, 'rsi', 'work', id)
fs.mkdirSync(wd, { recursive: true })
fs.writeFileSync(path.join(wd, 'pick.mjs'), "export const meta = { arms: ['" + arm + "'] }\\nexport default function pick(ctx) { return [1, 5, 9, 13, 17, 21, 25].map((s) => (s + ctx.k) % ctx.n) }\\nexport function accept(sig, book) { return book.open < 5 }\\n", 'utf8')
let hf = () => JSON.parse(fs.readFileSync(path.join(wd, 'harness_full.json'), 'utf8'))
res.id = id
res.env0 = P.envKey
res.r0 = await P.reverifyAll({ why: 'before' })
let o0 = hf()
res.unit0 = o0.metrics.unit === undefined ? null : o0.metrics.unit
res.sel0 = o0.metrics.selHash
let U2 = ${JSON.stringify(U2)}
let w = Float64Array.from({ length: 2400 }, (_, i) => 20 + ((i * 7919) % 2400) * 0.01)
fs.writeFileSync(path.join(ld, 'unit.f64'), Buffer.from(w.buffer))
let meta = JSON.parse(fs.readFileSync(path.join(ld, 'meta.json'), 'utf8'))
fs.writeFileSync(path.join(ld, 'meta.json'), JSON.stringify({ ...meta, key: meta.key + 'u', unit: U2 }), 'utf8')
let s = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'))
fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ ...s, source: { ...s.source, unit: U2 } }), 'utf8')
let P2 = mkP()
res.env1 = P2.envKey
res.ids0 = P2.rsi.store.listIndex().map((x) => x.id).sort()
res.r1 = await P2.reverifyAll({ why: 'unit on' })
res.ids1 = P2.rsi.store.listIndex().map((x) => x.id).sort()
let o1 = hf()
res.unit1 = o1.metrics.unit === undefined ? null : o1.metrics.unit
res.sel1 = o1.metrics.selHash
res.idNew = P2.idOf(spec)
console.log('RESULT ' + JSON.stringify(res))
`, 'utf8')
        let env = { ...process.env, ARSI_ROOT: root }
        for (let k of ['ARSI_HARNESS', 'ARSI_LEDGER_DIR', 'ARSI_EVAL_FROM']) {
            delete env[k]
        }
        let rc = spawnSync(process.execPath, [path.join(root, 'child.mjs')], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 540000, maxBuffer: 64 * 1024 * 1024 })
        let line = `${rc.stdout}`.split(/\r?\n/).find((l) => l.startsWith('RESULT '))
        assert(line, `${rc.stdout}\n${rc.stderr}`.slice(-3000))
        let res = JSON.parse(line.slice(7))
        //改前: 每單 1 單位
        assert.equal(res.r0.length, 1)
        assert.equal(res.r0[0].ok, true, JSON.stringify(res.r0))
        assert.strictEqual(res.unit0, null)
        //啟用後: envKey 改變、節點之 id 與樹之節點集合不變、選集指紋不變、結果依新口徑、S 改變
        assert.notEqual(res.env1, res.env0)
        assert(res.env1.endsWith('|uIni10000'), res.env1)
        assert.equal(res.r1.length, 1)
        assert.equal(res.r1[0].ok, true, JSON.stringify(res.r1))
        assert.equal(res.r1[0].nodeId, res.id, '節點之 id 不變')
        assert.deepStrictEqual(res.ids1, res.ids0, '樹之節點集合不變')
        assert.deepStrictEqual(res.ids0, [res.id])
        assert.deepStrictEqual(res.unit1, U2, '結果依新口徑')
        assert.equal(res.sel1, res.sel0, '選集指紋不變')
        assert.notEqual(res.r1[0].S, res.r0[0].S, 'S 改變')
        assert.equal(res.r1[0].before, res.r0[0].S)
        //同一 spec 於新環境之 id 不同(引擎之「已試」以 id 判: 啟用後同一 spec 之新方向不被視為已試 —— 稿之未涵蓋)
        assert.notEqual(res.idNew, res.id)
    })

    it('聚合入口另匯出 isCapitalError、normUnit、sameUnit(使用端之工具不必深層匯入)', () => {
        assert.strictEqual(WTA.isCapitalError, isCapitalError)
        assert.strictEqual(WTA.normUnit, normUnit)
        assert.strictEqual(WTA.sameUnit, sameUnit)
    })
})
