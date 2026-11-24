import assert from 'assert'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { spawnSync } from 'child_process'
import { loadLedger, memberLedger, subsetLedger, tieBaseOf, memberUOf } from '../src/eval/ledger.mjs'
import { parseSubsetRule, subsetMaskOf, holdMedianOf, familyOf, SUBSET_MSG, SUBSET_MEMBER_MSG } from '../src/eval/subsetRule.mjs'
import { fullRowsOf } from '../src/domain/verifyEvalHints.mjs'
import { makeTmp, writeSynthLedger, makeTrainEvaluator as makeEvaluator, FD_ROOT } from './tools/synthLedger.mjs'


//子庫之規則(規則 R-EV-47): parseSubsetRule / subsetMaskOf / subsetLedger 與命令列之 --subset(--member 之一般化)
//  合成帳本之靜態欄、進場規則欄與因子名於本檔改寫為逐策略相異、段長不一(含 0 條)之內容(writeSynthLedger 之止盈止損與條件數全同, 無從分辨取值錯位);
//  因子名為底線分段之多段名(含同家族而前段不同者、段數不足者), 以驗家族之切段
const CFG = { warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [3, 7], nullDraws: 8, seed: 11 }
const SALT = 0x5bd1e995
const SALTS = [SALT, 0x27d4eb2f, 7]
const N = 61
const NAMES = ['a_b_c_rsi_14_d', 'a_b_c_rsi_14_w', 'x_y_z_rsi_14_d', 'a_b_c_ma_5_d', 'a_b_c_ma_20_d', 'q_r_s_vol_3_d', 'short_name']
//inHalf / uIndep, 獨立寫一份之切半之值(與 memberUOf 無共用程式)
let uIndep = (tieBase, salt) => (Math.imul(tieBase ^ salt, 2654435761) >>> 0) / 4294967296
let bytesOf = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)
let COLS = ['off', 'ent', 'ext', 'pnl', 'mode', 'tp', 'sl', 'nKeys', 'lv', 'fitNt', 'cls', 'keyOff', 'keyIdx', 'keySym', 'keyTh', 'keyOr', 'xoff', 'xExt', 'xPnlCum', 'xWinCum', 'srcIdx']
let hashOfLedger = (L) => {
    let h = crypto.createHash('sha1')
    for (let k of COLS) {
        h.update(k)
        if (L[k]) {
            h.update(bytesOf(L[k]))
        }
    }
    return h.digest('hex')
}
let msgOf = (fn) => {
    try {
        fn()
    }
    catch (err) {
        return err instanceof Error ? err.message : `非 Error: ${String(err)}`
    }
    return null
}
//patchLib, 把合成帳本之靜態欄、進場規則欄、因子序列欄與因子名改寫為逐策略相異者(於 loadLedger 之前; 型別與長度同 ledgerBuild 之輸出: cls 每策略 3 值、條件欄之段長 = s % 5)
let patchLib = (dir, n, nBars) => {
    let w = (name, arr) => fs.writeFileSync(path.join(dir, name), Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength))
    w('cls.u8', Uint8Array.from({ length: 3 * n }, (_, i) => (i * 7 + 3) % 251))
    w('lv.i32', Int32Array.from({ length: n }, (_, s) => s * 5 + 1))
    w('fitNt.i32', Int32Array.from({ length: n }, (_, s) => 1000 - s * 11))
    w('nKeys.u8', Uint8Array.from({ length: n }, (_, s) => s % 5))
    w('tp.f32', Float32Array.from({ length: n }, (_, s) => (10 + s) / 1000))
    w('sl.f32', Float32Array.from({ length: n }, (_, s) => (200 - 3 * s) / 1000))
    let keyOff = new Uint32Array(n + 1)
    let tot = 0
    for (let s = 0; s < n; s++) {
        keyOff[s] = tot
        tot += s % 5
    }
    keyOff[n] = tot
    w('keyOff.u32', keyOff)
    w('keyIdx.u16', Uint16Array.from({ length: tot }, (_, j) => (j * 3 + 1) % NAMES.length))
    w('keySym.i8', Int8Array.from({ length: tot }, (_, j) => (j % 3 === 0 ? -1 : 1)))
    w('keyTh.f64', Float64Array.from({ length: tot }, (_, j) => j * 0.125 - 3))
    w('keyOr.u8', Uint8Array.from({ length: tot }, (_, j) => j % 2))
    w('fac.f64', Float64Array.from({ length: NAMES.length * nBars }, (_, i) => ((i * 37) % 1000) / 500 - 1))
    let fpMeta = path.join(dir, 'meta.json')
    let meta = JSON.parse(fs.readFileSync(fpMeta, 'utf8'))
    fs.writeFileSync(fpMeta, JSON.stringify({ ...meta, keyNames: NAMES }), 'utf8')
}
//famIndep, 獨立寫一份之家族(以底線切段、去掉前 N 段; 段數 ≤ N 者無家族)與各策略所用之家族
let famIndep = (name, k) => {
    let a = name.split('_')
    return a.length > k ? a.slice(k).join('_') : ''
}
let famsOfStrat = (L, s, k) => {
    let out = new Set()
    for (let j = L.keyOff[s]; j < L.keyOff[s + 1]; j++) {
        let f = famIndep(L.keyNames[L.keyIdx[j]], k)
        if (f) {
            out.add(f)
        }
    }
    return out
}
//holdIndep, 獨立寫一份之持倉天數之中位: 進場棒與出場棒皆在 [from, to) 內之已結之單(主控之裁定: 訓練期結束時即已知之量)
let holdIndep = (L, s, from, to) => {
    let ds = []
    for (let j = L.off[s]; j < L.off[s + 1]; j++) {
        if (L.ext[j] !== -1 && L.ent[j] >= from && L.ent[j] < to && L.ext[j] >= from && L.ext[j] < to) {
            ds.push((L.ext[j] - L.ent[j]) / 6)
        }
    }
    ds.sort((a, b) => a - b)
    if (!ds.length) {
        return null
    }
    let m = Math.floor(ds.length / 2)
    return ds.length % 2 === 1 ? ds[m] : (ds[m - 1] + ds[m]) / 2
}
let maskOf = (L, str, opt) => Array.from(subsetMaskOf(L, parseSubsetRule(str).rules, opt).sel)
let keepOf = (L, fn) => Array.from({ length: L.n }, (_, s) => (fn(s) ? 1 : 0))

describe('子庫之規則(parseSubsetRule、subsetMaskOf、subsetLedger)', function () {
    let t
    let L
    before(() => {
        t = makeTmp('subsetLedger')
        writeSynthLedger(path.join(t.dir, 's'), { n: N, nBars: 2400, seed: 5 })
        patchLib(path.join(t.dir, 's'), N, 2400)
        L = loadLedger(path.join(t.dir, 's'))
    })
    after(() => {
        t.cleanup()
    })

    it('解析:各規則之正規化之字串之字面值(數值以 String(Number(x))、鹽 0x 十六進位、選配之段補預設、空界留空、依原序以逗號相連)', () => {
        //對應規格:「tag = 各條依序重寫」
        let cases = [
            ['rand:.5:1', 'rand:0.5:0x1:0'],
            ['rand:0.50:0x5BD1E995:1', 'rand:0.5:0x5bd1e995:1'],
            ['rand:1:4294967295', 'rand:1:0xffffffff:0'],
            ['tp:0.010:', 'tp:0.01:'],
            ['sl::0.15', 'sl::0.15'],
            ['tp:-1:2', 'tp:-1:2'],
            ['hold:1.5:10', 'hold:1.5:10'],
            ['keys:01:3', 'keys:1:3'],
            ['side:short', 'side:short'],
            ['siderand:long:12', 'siderand:long:0xc:0.5'],
            ['siderand:short:0x10:0.25', 'siderand:short:0x10:0.25'],
            ['nofam:3:rsi_14_d', 'nofam:3:rsi_14_d'],
            ['nofam:0:ma_5_d', 'nofam:0:ma_5_d'],
            ['nofam:1:14', 'nofam:1:14'],
            ['nofam:03:top:0.30', 'nofam:3:top:0.3'],
            ['nofam:2:top:1', 'nofam:2:top:1'],
            ['side:long,tp::0.03,rand:0.5:7:0', 'side:long,tp::0.03,rand:0.5:0x7:0'],
        ]
        for (let [s, tag] of cases) {
            assert.equal(parseSubsetRule(s).tag, tag, s)
        }
        assert.deepEqual(parseSubsetRule('tp:0.01:0.02').rules, [{ kind: 'tp', lo: 0.01, hi: 0.02 }])
        //nofam 之 N 必給且置前(主控之裁定: 套件不假定因子名之分段; 無預設)
        assert.deepEqual(parseSubsetRule('nofam:3:rsi_14_d').rules, [{ kind: 'nofam', family: 'rsi_14_d', N: 3 }])
        assert.deepEqual(parseSubsetRule('nofam:2:top:0.25').rules, [{ kind: 'nofamTop', ratio: 0.25, N: 2 }])
    })

    it('解析:格式不合者一律拋同一句固定之訊息(不帶輸入值)', () => {
        //對應規格:「不合 ⇒ 拋 SUBSET_MSG(不帶輸入值)」
        let bad = ['', 'rand', 'rand:0.5', 'rand:0:1', 'rand:1.5:1', 'rand:abc:1', 'rand:0.5:4294967296', 'rand:0.5:0x100000000', 'rand:0.5:-1', 'rand:0.5:1:2', 'rand:0.5:1:0:9',
            'tp', 'tp::', 'tp:0.2:0.1', 'tp:a:', 'tp:1e3:', `tp:${'9'.repeat(400)}:`, 'hold:-1:', 'keys:1.5:', 'keys:-1:2', 'side', 'side:up', 'side:long:1',
            'siderand:long', 'siderand:up:1', 'siderand:long:1:0', 'siderand:long:1:2', 'nofam', 'nofam:3', 'nofam:rsi_14_d', 'nofam:rsi_14_d:3', 'nofam:top:0.3', 'nofam:top:0.3:3', 'nofam:3:top', 'nofam:3:top:0', 'nofam:3:top:2', 'nofam:3:top:0.3:1',
            'nofam:3:a b', 'nofam:3:x:y', 'nofam:33:x', 'nofam:-1:x', 'nofam:1.5:x', 'nofam::x',
            'unknown:1', 'side:long,', ',side:long', 'side:long,,tp::1', 'secret-token-xyz']
        for (let s of bad) {
            let m = msgOf(() => parseSubsetRule(s))
            assert.equal(m, SUBSET_MSG, s)
            assert(!m.includes('secret-token-xyz'))
        }
        for (let v of [null, undefined, 5, true, ['side:long']]) {
            assert.equal(msgOf(() => parseSubsetRule(v)), SUBSET_MSG, String(v))
        }
    })

    it('rand:0.5:<鹽>:<h> 所留之策略與 memberLedger(L, 鹽, h) 逐隻相同,兩者之帳本各欄逐位相同(三組鹽 × 兩半);rand 之其他比例與獨立之算式相同', () => {
        //對應規格:「rand:0.5:<鹽>:<h> 之子庫 = --member <鹽>:<h> 之半庫」與「u < p(0)或 u ≥ 1 − p(1)」
        for (let salt of SALTS) {
            for (let h of [0, 1]) {
                let sel = subsetMaskOf(L, parseSubsetRule(`rand:0.5:${salt}:${h}`).rules).sel
                let S = subsetLedger(L, sel, `rand:0.5:${salt}:${h}`)
                let M = memberLedger(L, salt, h)
                assert.deepEqual(Array.from(S.srcIdx), Array.from(M.srcIdx), `${salt}:${h} 之成員`)
                assert.equal(hashOfLedger(S), hashOfLedger(M), `${salt}:${h} 之各欄`)
                assert.equal(S.n, M.n)
                assert(S.n > 0 && S.n < N)
            }
        }
        for (let [p, h] of [[0.3, 0], [0.3, 1], [0.85, 0], [1, 1]]) {
            let want = keepOf(L, (s) => (h === 0 ? uIndep(tieBaseOf(s), SALT) < p : uIndep(tieBaseOf(s), SALT) >= 1 - p))
            assert.deepEqual(maskOf(L, `rand:${p}:${SALT}:${h}`), want, `p ${p} h ${h}`)
        }
        assert.deepEqual(maskOf(L, `rand:1:${SALT}`), new Array(N).fill(1), 'p = 1 ⇒ 全留')
        //memberUOf 即切半之式(與獨立之算式逐值相同)
        for (let s = 0; s < 200; s++) {
            assert.equal(memberUOf(tieBaseOf(s), SALT), uIndep(tieBaseOf(s), SALT))
        }
    })

    it('tp / sl / keys 之帶:兩端含、空界不限、以帳本之 float32 值比(界取 fround);與逐策略之暴力判定相同', () => {
        //對應規格:「止盈 / 止損(帳本之 float32 值)在 [fround(lo), fround(hi)] 內; 任一端可空」「keys 在 [lo, hi] 內」
        assert.deepEqual(maskOf(L, 'tp:0.025:0.025'), keepOf(L, (s) => s === 15), '恰為某一隻之值(十進位 0.025 存成 float32)⇒ 兩端皆含,只留該隻')
        let fr = Math.fround
        for (let [str, fn] of [
            ['tp:0.02:0.04', (s) => L.tp[s] >= fr(0.02) && L.tp[s] <= fr(0.04)],
            ['tp:0.05:', (s) => L.tp[s] >= fr(0.05)],
            ['tp::0.013', (s) => L.tp[s] <= fr(0.013)],
            ['sl:0.1:0.15', (s) => L.sl[s] >= fr(0.1) && L.sl[s] <= fr(0.15)],
            ['sl::0.05', (s) => L.sl[s] <= fr(0.05)],
            ['keys:1:2', (s) => L.nKeys[s] >= 1 && L.nKeys[s] <= 2],
            ['keys::0', (s) => L.nKeys[s] === 0],
            ['keys:4:', (s) => L.nKeys[s] >= 4],
        ]) {
            let got = maskOf(L, str)
            assert.deepEqual(got, keepOf(L, fn), str)
            assert(got.some((x) => x === 1) && got.some((x) => x === 0), `${str}: 鑑別之前提(有留有去)`)
        }
        //fround 之鑑別: 不取 fround 而以 double 比者, 0.03 之下界會漏掉存成 float32 之 0.03(fround(0.03) < 0.03)
        assert(Math.fround(0.03) < 0.03 && L.tp[20] === Math.fround(0.03))
        assert.equal(maskOf(L, 'tp:0.03:')[20], 1)
    })

    it('side 與 siderand:siderand 之另一側全留、所指之側留 u < p;與獨立之算式相同(改變全庫之做多比例)', () => {
        //對應規格:「side 只留該側」「siderand 另一側全留; 所指之側留 u < p(預設 0.5)」
        let isLong = (s) => L.mode[s] > 0
        assert.deepEqual(maskOf(L, 'side:long'), keepOf(L, isLong))
        assert.deepEqual(maskOf(L, 'side:short'), keepOf(L, (s) => !isLong(s)))
        for (let [side, p] of [['long', 0.5], ['short', 0.5], ['long', 0.2]]) {
            let want = keepOf(L, (s) => (isLong(s) !== (side === 'long') ? true : uIndep(tieBaseOf(s), SALT) < p))
            let got = maskOf(L, `siderand:${side}:${SALT}:${p}`)
            assert.deepEqual(got, want, `${side} ${p}`)
            assert(keepOf(L, (s) => isLong(s) === (side === 'long')).some((x, s) => x === 1 && got[s] === 0), '所指之側確有被去除者')
        }
    })

    it('hold:各策略之進場與出場皆在訓練期內之已結單之持倉天數之中位(出場在訓練期終點之後者不計;進場在下界之前者不計;無此類單者被去除)', () => {
        //對應規格(主控之裁定):「hold = 進場與出場皆在訓練期內之已結單(訓練期結束時即已知之量)之持倉天數之中位; 無此類單者不屬任何帶」
        let from = 300
        let end = 1200
        //鑑別之前提: 有「進場在訓練期內、出場在終點之後」之單(不計); 有偶數筆之策略; 有下界之前之單(不計); 且「含出場在終點之後之單」之中位與正確之中位至少一隻不同
        let after = 0
        let even = 0
        let before = 0
        for (let s = 0; s < N; s++) {
            let k = 0
            for (let j = L.off[s]; j < L.off[s + 1]; j++) {
                if (L.ent[j] >= from && L.ent[j] < end && L.ext[j] >= end) {
                    after++
                }
                if (L.ent[j] < from && L.ext[j] >= 0) {
                    before++
                }
                k += L.ent[j] >= from && L.ext[j] >= 0 && L.ext[j] < end ? 1 : 0
            }
            even += k > 0 && k % 2 === 0 ? 1 : 0
        }
        assert(after > 0 && even > 0 && before > 0, `前提 ${after} / ${even} / ${before}`)
        let medWithAfter = (s) => {
            let ds = []
            for (let j = L.off[s]; j < L.off[s + 1]; j++) {
                if (L.ent[j] >= from && L.ent[j] < end && L.ext[j] >= 0) {
                    ds.push((L.ext[j] - L.ent[j]) / 6)
                }
            }
            ds.sort((a, b) => a - b)
            return ds.length ? (ds.length % 2 ? ds[(ds.length - 1) / 2] : (ds[ds.length / 2 - 1] + ds[ds.length / 2]) / 2) : null
        }
        assert([...Array(N).keys()].some((s) => medWithAfter(s) !== holdIndep(L, s, from, end)), '前提:出場在終點之後之單計與不計,至少一隻之中位不同')
        for (let s = 0; s < N; s++) {
            assert.equal(holdMedianOf(L, s, from, end), holdIndep(L, s, from, end), `策略 ${s}`)
        }
        let meds = Array.from({ length: N }, (_, s) => holdIndep(L, s, from, end)).filter((x) => x !== null).sort((a, b) => a - b)
        let mid = meds[Math.floor(meds.length / 2)]
        for (let str of [`hold::${mid}`, `hold:${mid}:`, `hold:${meds[3]}:${meds[meds.length - 4]}`]) {
            let r = parseSubsetRule(str).rules[0]
            let want = keepOf(L, (s) => {
                let d = holdIndep(L, s, from, end); return d !== null && (r.lo === null || d >= r.lo) && (r.hi === null || d <= r.hi)
            })
            assert.deepEqual(maskOf(L, str, { trainEndBar: end, trainFromBar: from }), want, str)
        }
        //極窄之訓練期: 多數策略無此類單 ⇒ 不屬任何帶(連「hold:0:」亦去除)
        let narrow = maskOf(L, 'hold:0:', { trainEndBar: 1200, trainFromBar: 1160 })
        assert.deepStrictEqual(narrow, keepOf(L, (s) => holdIndep(L, s, 1160, 1200) !== null))
        assert(narrow.some((x) => x === 0) && narrow.some((x) => x === 1), '前提:有無單者、有有單者')
        //未給訓練期之終點 ⇒ 拋錯
        assert.equal(msgOf(() => subsetMaskOf(L, parseSubsetRule('hold:1:').rules)), 'invalid opt.trainEndBar: must be a non-negative integer (required by the hold rule)')
        assert.equal(msgOf(() => subsetMaskOf(L, parseSubsetRule('hold:1:').rules, { trainEndBar: 10, trainFromBar: -1 })), 'invalid opt.trainFromBar: must be a non-negative integer')
    })

    it('nofam:<N>:<家族>:家族 = 因子名以底線切段、去掉前 N 段(N 必給);去除用到該家族之策略;無條件之策略留下', () => {
        //對應規格(主控之裁定):「家族 = 因子名以底線切段後去掉前 N 段; N 不給預設、必須明給, 規則為 nofam:<N>:<家族>」
        assert.equal(familyOf('a_b_c_rsi_14_d', 3), 'rsi_14_d')
        assert.equal(familyOf('x_y_z_rsi_14_d', 3), 'rsi_14_d', '前段不同而同家族')
        assert.equal(familyOf('short_name', 3), '', '段數不足者無家族')
        assert.equal(familyOf('short_name', 1), 'name')
        assert.equal(familyOf('short_name', 0), 'short_name')
        for (let [str, k, fam] of [['nofam:3:rsi_14_d', 3, 'rsi_14_d'], ['nofam:3:ma_5_d', 3, 'ma_5_d'], ['nofam:0:a_b_c_rsi_14_d', 0, 'a_b_c_rsi_14_d'], ['nofam:1:name', 1, 'name'], ['nofam:2:c_rsi_14_d', 2, 'c_rsi_14_d']]) {
            let got = maskOf(L, str)
            assert.deepEqual(got, keepOf(L, (s) => !famsOfStrat(L, s, k).has(fam)), str)
            assert(got.some((x) => x === 0), `${str}: 確有被去除者`)
        }
        //N = 3 時 short_name 無家族: 只用到它之策略不受任何家族之規則影響
        assert.deepEqual(maskOf(L, 'nofam:3:name'), new Array(N).fill(1))
        assert.equal(maskOf(L, 'nofam:3:rsi_14_d')[0], 1, '無條件之策略(第 0 隻)留下')
    })

    it('nofam:<N>:top:<比例>:依用到該家族之策略數由多到少(同數依家族名)逐一去除,至去除之比例 ≥ 所給之比例;結果帶所去除之家族', () => {
        //對應規格(主控之裁定):「依使用該家族之策略數由多到少逐一拿掉用到該家族之策略,至拿掉之比例 ≥ 該值」
        let indep = (ratio, k) => {
            let cnt = new Map()
            for (let s = 0; s < N; s++) {
                for (let f of famsOfStrat(L, s, k)) {
                    cnt.set(f, (cnt.get(f) || 0) + 1)
                }
            }
            let order = [...cnt.keys()].sort((a, b) => (cnt.get(b) - cnt.get(a)) || (a < b ? -1 : (a > b ? 1 : 0)))
            let gone = new Set()
            let fams = []
            for (let f of order) {
                if (gone.size / N >= ratio) {
                    break
                }
                fams.push(f)
                for (let s = 0; s < N; s++) {
                    if (famsOfStrat(L, s, k).has(f)) {
                        gone.add(s)
                    }
                }
            }
            return { keep: keepOf(L, (s) => !gone.has(s)), fams, cnt }
        }
        for (let [ratio, k] of [[0.1, 3], [0.3, 3], [0.45, 3], [1, 3], [0.2, 0]]) {
            let w = indep(ratio, k)
            let r = subsetMaskOf(L, parseSubsetRule(`nofam:${k}:top:${ratio}`).rules)
            assert.deepEqual(Array.from(r.sel), w.keep, `${ratio} / ${k}`)
            assert.deepEqual(r.topFamilies, [w.fams], `${ratio} / ${k}: 所去除之家族`)
        }
        //鑑別之前提: 各家族之策略數不全相同(次序有意義)
        let cnt3 = indep(1, 3).cnt
        assert(new Set(cnt3.values()).size > 1)
        assert.equal(indep(1, 3).fams.length, cnt3.size, '比例 1 ⇒ 全部家族皆去除')
        assert.strictEqual(subsetMaskOf(L, parseSubsetRule('side:long').rules).topFamilies, null, '無 nofam:top 者為 null')
    })

    it('多條規則 = 交集(各條各自於全庫上判定,與逐條遮罩之 AND 相同)', () => {
        //對應規格:「只把符合全部規則(交集)之策略…; 各規則皆於所給之帳本上各自判定」
        let a = maskOf(L, 'side:long')
        let b = maskOf(L, 'tp::0.05')
        let c = maskOf(L, `rand:0.5:${SALT}:1`)
        let d = subsetMaskOf(L, parseSubsetRule('nofam:3:top:0.3').rules)
        let got = subsetMaskOf(L, parseSubsetRule(`side:long,tp::0.05,rand:0.5:${SALT}:1,nofam:3:top:0.3`).rules)
        assert.deepEqual(Array.from(got.sel), a.map((x, s) => x & b[s] & c[s] & d.sel[s]))
        assert.deepEqual(got.topFamilies, d.topFamilies, 'nofam:top 之排名取全庫(不受前幾條之影響)')
        assert(got.sel.some((x) => x === 1))
    })

    it('subsetLedger:只含遮罩所留之策略、重新編號(保持原先後)、各欄與其於全庫時逐位相同(含 cls 每策略 3 值、段長不一之條件欄、已結單欄);帶 subset{ rule, nFull };不改動原帳本', () => {
        //對應規格:「各逐策略欄、逐棒之欄、srcIdx 之作法同 memberLedger; 另帶凍結之 subset{ rule, nFull }」
        let h0 = hashOfLedger(L)
        let sel = subsetMaskOf(L, parseSubsetRule('tp:0.02:0.06,side:long').rules).sel
        let S = subsetLedger(L, sel, 'tp:0.02:0.06,side:long')
        assert.equal(hashOfLedger(L), h0, '原帳本不被改動')
        let keep = Array.from(sel).map((x, s) => (x ? s : -1)).filter((s) => s >= 0)
        assert.deepEqual(Array.from(S.srcIdx), keep)
        assert.equal(S.n, keep.length)
        assert.deepEqual(S.subset, { rule: 'tp:0.02:0.06,side:long', nFull: N })
        assert(Object.isFrozen(S.subset))
        assert.strictEqual(S.member, undefined)
        keep.forEach((s, i) => {
            for (let k of ['mode', 'tp', 'sl', 'nKeys', 'lv', 'fitNt']) {
                assert.equal(S[k][i], L[k][s], `${k} ${s}`)
            }
            assert.deepEqual(Array.from(S.cls.subarray(3 * i, 3 * i + 3)), Array.from(L.cls.subarray(3 * s, 3 * s + 3)), `cls ${s}`)
            for (let [off, cols] of [['off', ['ent', 'ext', 'pnl']], ['keyOff', ['keyIdx', 'keySym', 'keyTh', 'keyOr']], ['xoff', ['xExt', 'xPnlCum', 'xWinCum']]]) {
                for (let c of cols) {
                    assert.deepEqual(Array.from(S[c].subarray(S[off][i], S[off][i + 1])), Array.from(L[c].subarray(L[off][s], L[off][s + 1])), `${c} ${s}`)
                }
            }
        })
        assert(keep.some((s) => L.nKeys[s] === 0) && keep.some((s) => L.nKeys[s] > 1), '前提:段長含 0 與多條')
        assert.strictEqual(S.px, L.px, '逐棒之欄共用')
        assert.strictEqual(S.fac, L.fac)
        //於半庫內再取: srcIdx 與 nFull 仍指全庫
        let M = memberLedger(L, SALT, 0)
        let sm = subsetMaskOf(M, parseSubsetRule('side:short').rules).sel
        let SM = subsetLedger(M, sm, 'side:short')
        assert.deepEqual(Array.from(SM.srcIdx), Array.from(M.srcIdx).filter((s) => L.mode[s] < 0))
        assert.equal(SM.subset.nFull, N)
        //於子庫內再取子庫、於子庫內切半: nFull 仍為全庫之隻數(子庫帳本之 subset.nFull)
        let SS = subsetLedger(S, subsetMaskOf(S, parseSubsetRule('keys:1:').rules).sel, 'keys:1:')
        assert.deepEqual(Array.from(SS.srcIdx), keep.filter((s) => L.nKeys[s] >= 1))
        assert.equal(SS.subset.nFull, N)
        assert(S.n < N, '前提:子庫之隻數小於全庫')
        let MS = memberLedger(S, SALT, 1)
        assert.equal(MS.member.nFull, N)
        assert.deepEqual(Array.from(MS.srcIdx), keep.filter((s) => uIndep(tieBaseOf(s), SALT) >= 0.5))
        //於子庫上取 rand:以全庫序號求值(子庫內之 rand:0.5 = 全庫之 rand:0.5 再限於子庫)
        let sr = subsetMaskOf(S, parseSubsetRule(`rand:0.5:${SALT}:0`).rules).sel
        assert.deepEqual(Array.from(sr), Array.from(S.srcIdx, (s) => (uIndep(tieBaseOf(s), SALT) < 0.5 ? 1 : 0)))
    })

    it('subsetLedger 之參數檢查(訊息不帶輸入值);空子庫照常建出、評估器可建且選集恆空', () => {
        let ok = new Uint8Array(N).fill(1)
        assert.equal(msgOf(() => subsetLedger(L, new Uint8Array(N - 1), 'x')), 'invalid sel: must be a Uint8Array of length L.n with values 0 or 1')
        assert.equal(msgOf(() => subsetLedger(L, new Int8Array(N), 'x')), 'invalid sel: must be a Uint8Array of length L.n with values 0 or 1')
        assert.equal(msgOf(() => subsetLedger(L, Array.from(ok), 'x')), 'invalid sel: must be a Uint8Array of length L.n with values 0 or 1')
        let two = new Uint8Array(N)
        two[3] = 2
        assert.equal(msgOf(() => subsetLedger(L, two, 'x')), 'invalid sel: must be a Uint8Array of length L.n with values 0 or 1')
        for (let r of ['', null, 3]) {
            assert.equal(msgOf(() => subsetLedger(L, ok, r)), 'invalid rule: must be a non-empty string')
        }
        assert.equal(msgOf(() => subsetLedger({ n: 2 }, new Uint8Array(2), 'x')), 'invalid L: must be a ledger object (see loadLedger and memberLedger)')
        assert.equal(msgOf(() => subsetMaskOf(L, [])), 'invalid rules: must be a non-empty array (see parseSubsetRule)')
        let E = subsetLedger(L, new Uint8Array(N), 'side:long')
        assert.equal(E.n, 0)
        assert.equal(E.off.length, 1)
        E.ntStatic = new Int32Array(0)
        let m = makeEvaluator(E, { ...CFG, phases: [0], horizons: [7], nullDraws: 2 }).evalPolicy(() => [], {})
        assert.equal(m.sel.sizeMean, 0)
    })

    it('子庫上之評估器:各策略之 ctx.meta.tie 與其於全庫時相同(以 srcIdx 產生)', () => {
        //對應規格:「保留各策略於全庫之同分次鍵」
        let sel = subsetMaskOf(L, parseSubsetRule('keys:1:3').rules).sel
        let S = subsetLedger(L, sel, 'keys:1:3')
        let got = null
        makeEvaluator(S, CFG).runPick((ctx) => {
            if (!got) {
                got = { n: ctx.n, tie: Array.from(ctx.meta.tie), nKeys: Array.from(ctx.meta.nKeys) }
            }
            return []
        }, 0)
        assert.equal(got.n, S.n)
        assert.deepEqual(got.tie, Array.from(S.srcIdx, (s) => tieBaseOf(s)))
        assert.deepEqual(got.nKeys, Array.from(S.srcIdx, (s) => L.nKeys[s]))
    })

    it('兩條機械提示之所計之列(fullRowsOf)不計帶 subset 之列(同成員抽樣);同一列不帶 subset 者照計', () => {
        //對應規格(R-REC-43 ①):「所計之列另排除帶 subset 之列」
        let row = { ok: true, mode: 'full', pick: 'try_a.mjs', selHash: 'aaaa1111', S: 12.5 }
        let lines = [JSON.stringify(row), JSON.stringify({ ...row, selHash: 'bbbb2222', subset: 'side:long' }), JSON.stringify({ ...row, selHash: 'cccc3333', subset: null }), JSON.stringify({ ...row, selHash: 'dddd4444', member: '0x1:0' })]
        assert.deepEqual(fullRowsOf(lines), [{ pick: 'try_a.mjs', selHash: 'aaaa1111', S: 12.5 }, { pick: 'try_a.mjs', selHash: 'cccc3333', S: 12.5 }])
    })

    describe('命令列 g_eval.mjs --subset', function () {
        this.timeout(300000)
        //合成專案根(同 unit-memberLedger 之作法): 帳本 2400 棒、訓練期終點第 1200 棒、回測期自第 1290 棒; 挑選模組於 rsi/work/w1(評估紀錄 .evals.log 落該夾)
        let mkProject = (name) => {
            let root = path.join(t.dir, name)
            writeSynthLedger(path.join(root, 'ledger', 'eval'), { n: N, nBars: 2400, seed: 7 })
            patchLib(path.join(root, 'ledger', 'eval'), N, 2400)
            fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
            fs.mkdirSync(path.join(root, 'rsi', 'work', 'w1'), { recursive: true })
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
                periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } },
                eval: { ledgerDir: './ledger/eval', warmupDays: 60, cadenceDays: 7, phases: [0], horizons: [7], nullDraws: 4, seed: 1, limits: { monthlyOrders: 400, peakHold: 50 } },
                score: { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] },
                rsi: { root: './rsi' },
                records: { workDir: './rsi/work' },
                dispatch: {},
            }), 'utf8')
            //挑選: 依身分取約三分之一(只依 ctx.meta.tie)
            fs.writeFileSync(path.join(root, 'rsi', 'work', 'w1', 'pick.mjs'), 'export default function pick(ctx) {\n    let ids = []\n    for (let s = 0; s < ctx.n; s++) {\n        if ((ctx.meta.tie[s] >>> 3) % 3 === 0) ids.push(s)\n    }\n    return ids\n}\n', 'utf8')
            fs.writeFileSync(path.join(root, 'rsi', 'work', 'w1', 'pick_throw.mjs'), 'export default function pick(ctx) {\n    throw new Error("n=" + ctx.n)\n}\n', 'utf8')
            return root
        }
        let run = (root, args, pick = 'pick.mjs') => {
            let env = { ...process.env, ARSI_ROOT: root }
            delete env.ARSI_HARNESS
            let fpOut = path.join(root, `out_${Math.random().toString(36).slice(2, 8)}.json`)
            let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'eval.mjs'), '--pick', path.join(root, 'rsi', 'work', 'w1', pick), '--mode', 'full', '--out', fpOut, ...args], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            let o = null
            try {
                o = JSON.parse(fs.readFileSync(fpOut, 'utf8'))
            }
            catch (err) {}
            return { status: r.status, out: `${r.stdout}\n${r.stderr}`, o }
        }
        let logOf = (root) => {
            let fp = path.join(root, 'rsi', 'work', 'w1', '.evals.log')
            return fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
        }
        //strip, 去掉時刻與耗時之欄(每次評估皆不同)與所比對之標記欄
        let strip = (o) => {
            let x = JSON.parse(JSON.stringify(o))
            delete x.at
            delete x.loadMs
            delete x.member
            delete x.subset
            delete x.metrics.ms
            return x
        }

        it('rand:0.5:<鹽>:<h> 與 --member <鹽>:<h>:所留之策略逐隻相同,結果檔除新增之規則欄(subset / member)外逐位相同(兩半);未給 --subset 者結果檔與評估紀錄無 subset', () => {
            //對應規格(主控之裁定):「rand:0.5:<鹽>:<h> 與 --member <鹽>:<h> 所留之策略須逐隻相同,且兩者之結果檔除新增之規則欄外逐位相同」
            let root = mkProject('cliEq')
            let full = run(root, [])
            assert.equal(full.status, 0, full.out.slice(0, 600))
            assert(full.o && full.o.ok === true && !('subset' in full.o))
            assert(!/子庫/.test(full.out))
            let Lc = loadLedger(path.join(root, 'ledger', 'eval'))
            for (let h of [0, 1]) {
                let a = run(root, ['--subset', `rand:0.5:0x5bd1e995:${h}`])
                let b = run(root, ['--member', `0x5bd1e995:${h}`])
                assert.equal(a.status, 0, a.out.slice(0, 600))
                assert.equal(b.status, 0, b.out.slice(0, 600))
                let M = memberLedger(Lc, SALT, h)
                let nLong = Array.from(M.srcIdx).filter((s) => Lc.mode[s] > 0).length
                assert.deepEqual(a.o.subset, { rule: `rand:0.5:0x5bd1e995:${h}`, n: M.n, nFull: N, nLong, nShort: M.n - nLong })
                assert.equal(b.o.member.n, M.n)
                assert.equal(JSON.stringify(strip(a.o)), JSON.stringify(strip(b.o)), `h ${h}: 結果檔除規則欄與時刻 / 耗時外逐位相同`)
                assert.notEqual(a.o.metrics.selHash, full.o.metrics.selHash)
                assert(/子庫 rand:0\.5:0x5bd1e995:\d: 留 \d+ 隻 \/ 全庫 61 隻/.test(a.out) && /不是正本/.test(a.out))
                assert(a.out.indexOf('子庫') < a.out.indexOf('[full|'), '註明在結果之前')
            }
            let log = logOf(root)
            assert.deepStrictEqual(log.map((x) => [x.subset, x.member]), [[undefined, undefined], ['rand:0.5:0x5bd1e995:0', undefined], [undefined, '0x5bd1e995:0'], ['rand:0.5:0x5bd1e995:1', undefined], [undefined, '0x5bd1e995:1']])
            assert(!('subset' in log[0]))
            assert.equal(log[1].selHash, log[2].selHash)
            assert.equal(log[3].selHash, log[4].selHash)
        })

        it('hold 以設定之訓練期為界、nofam:top 記所去除之家族;--ref 與 --ext-test 亦於子庫上執行', () => {
            //對應規格:「hold 以訓練期(設定之訓練期終點、下界)判定」「結果檔記規則字串與留下之隻數」「與 --ref、--ext-test 之併用同 --member」
            let root = mkProject('cliRules')
            let Lc = loadLedger(path.join(root, 'ledger', 'eval'))
            let a = run(root, ['--subset', 'hold:2:,nofam:3:top:0.3'])
            assert.equal(a.status, 0, a.out.slice(0, 600))
            let want = subsetMaskOf(Lc, parseSubsetRule('hold:2:,nofam:3:top:0.3').rules, { trainEndBar: 1200, trainFromBar: 0 })
            let n = Array.from(want.sel).filter((x) => x === 1).length
            assert.equal(a.o.subset.rule, 'hold:2:,nofam:3:top:0.3')
            assert.equal(a.o.subset.n, n)
            assert.deepEqual(a.o.subset.topFamilies, want.topFamilies)
            assert(n > 0 && n < N)
            let wd = path.join(root, 'rsi', 'work', 'w1')
            fs.writeFileSync(path.join(wd, 'ext_n.mjs'), 'export default function (api) {\n    return { text: "n=" + api.n }\n}\n', 'utf8')
            fs.writeFileSync(path.join(wd, 'ref_all.mjs'), 'export default function pick(ctx) {\n    let ids = []\n    for (let s = 0; s < ctx.n; s++) ids.push(s)\n    return ids\n}\n', 'utf8')
            let nSide = Array.from(Lc.mode).filter((m) => m < 0).length
            let e = run(root, ['--ext-test', path.join(wd, 'ext_n.mjs'), '--subset', 'side:short'])
            assert.equal(e.status, 0, e.out.slice(0, 400))
            assert(new RegExp(`EXT_OK ext_n\\([^)]*\\): n=${nSide}\\b`).test(e.out), e.out.slice(0, 400))
            let r = run(root, ['--ref', path.join(wd, 'ref_all.mjs'), '--subset', 'side:short'])
            assert.equal(r.status, 0, r.out.slice(0, 400))
            assert.equal(r.o.refOverlap.refSizeMean, nSide)
        })

        it('挑選函數拋錯(離開碼 3)之失敗之結果檔帶 subset{ rule }、評估紀錄之列帶 subset;挑選函數所見之 ctx.n 為子庫之隻數', () => {
            let root = mkProject('cliFail')
            let r = run(root, ['--subset', 'side:long'], 'pick_throw.mjs')
            assert.equal(r.status, 3, r.out.slice(0, 400))
            let nLong = Array.from(loadLedger(path.join(root, 'ledger', 'eval')).mode).filter((m) => m > 0).length
            assert(new RegExp(`n=${nLong}\\b`).test(r.out), r.out.slice(0, 400))
            assert.deepEqual(r.o.subset, { rule: 'side:long' })
            assert.equal(r.o.code, 'PICK_RUN')
            assert.deepEqual(logOf(root).map((x) => [x.ok, x.code, x.subset]), [[false, 'PICK_RUN', 'side:long']])
        })

        it('格式不合、旗標重複、只給旗標、與 --member 併用:不評估、離開碼 2、不寫結果檔、不記評估紀錄;訊息固定、不帶輸入值', () => {
            //對應規格:「格式不合、旗標重複給者不評估(離開碼 2); 不與 --member 併用」
            let root = mkProject('cliBad')
            for (let [what, args, msg] of [
                ['格式不合', ['--subset', 'secret-token-xyz'], SUBSET_MSG],
                ['未知之規則', ['--subset', 'side:up'], SUBSET_MSG],
                ['重複(皆合格)', ['--subset', 'side:long', '--subset', 'side:short'], SUBSET_MSG],
                ['只給旗標', ['--subset'], SUBSET_MSG],
                ['只給旗標(其後為他旗標)', ['--subset', '--null', '4'], SUBSET_MSG],
                ['與 --member 併用', ['--subset', 'side:long', '--member', '1:0'], SUBSET_MEMBER_MSG],
                ['與 --member 併用(--member 在前)', ['--member', '1:0', '--subset', 'side:long'], SUBSET_MEMBER_MSG],
            ]) {
                let r = run(root, args)
                assert.equal(r.status, 2, `${what}: ${r.out.slice(0, 300)}`)
                assert.equal(r.out.split('\n').filter(Boolean)[0], msg, what)
                assert(!r.out.includes('secret-token-xyz'), `${what}: 不回顯輸入值`)
                assert.strictEqual(r.o, null, `${what}: 不寫結果檔`)
            }
            assert.deepEqual(logOf(root), [], '不記評估紀錄')
        })

        it('帶等號之 --subset=<規則>、--member=<鹽>:<半>:不評估、離開碼 2、不寫結果檔、不記評估紀錄;訊息固定、指明須寫成 --subset <規則> / --member <鹽>:<半>、不帶輸入值;未帶等號之寫法不受影響', () => {
            //對應規格(主控之裁定,排程第 589 項之接續輪):「拒收帶等號之 --subset=…、--member=…(原靜默忽略 ⇒ 以全庫評估且評估紀錄記為正本列); 與既有不合者同一處置: 離開碼 2、於載入模組與資源閘之前、不寫結果檔、不記評估紀錄、訊息不帶輸入值」
            let root = mkProject('cliEq2')
            let MSG_S = 'invalid --subset: must be written as --subset <rule> (a space, not =)'
            let MSG_M = 'invalid --member: must be written as --member <salt>:<half> (a space, not =)'
            for (let [what, args, msg] of [
                ['--subset= 帶合格之規則(原會被靜默忽略而以全庫評估)', ['--subset=side:long'], MSG_S],
                ['--subset= 帶不合格之值', ['--subset=secret-token-xyz'], MSG_S],
                ['--subset= 空值', ['--subset='], MSG_S],
                ['--subset 合格在先、--subset= 在後(不得靜默採用第一個)', ['--subset', 'side:long', '--subset=side:short'], MSG_S],
                ['--subset= 與合格之 --member', ['--subset=side:long', '--member', '1:0'], MSG_S],
                ['--member= 帶合格之值(原會被靜默忽略)', ['--member=0x1:0'], MSG_M],
                ['--member= 帶不合格之值', ['--member=secret-token-xyz'], MSG_M],
                ['--member 合格在先、--member= 在後', ['--member', '1:0', '--member=1:1'], MSG_M],
                ['--member= 與合格之 --subset', ['--member=1:0', '--subset', 'side:long'], MSG_M],
                ['--member= 與 --subset=(依次序,--member 先檢查)', ['--member=1:0', '--subset=side:long'], MSG_M],
            ]) {
                let r = run(root, args)
                assert.equal(r.status, 2, `${what}: ${r.out.slice(0, 300)}`)
                assert.equal(r.out.split('\n').filter(Boolean)[0], msg, what)
                assert.equal(r.out.split('\n').filter(Boolean).length, 1, `${what}: 訊息只一行`)
                assert(!r.out.includes('secret-token-xyz'), `${what}: 不回顯輸入值`)
                assert.strictEqual(r.o, null, `${what}: 不寫結果檔`)
            }
            assert.deepEqual(logOf(root), [], '不記評估紀錄')
            //不帶等號之合格寫法照常評估(對照: 上列被拒者若被靜默忽略,離開碼會是 0)
            let ok = run(root, ['--subset', 'side:long'])
            assert.equal(ok.status, 0, ok.out.slice(0, 300))
            assert.equal(ok.o.subset.rule, 'side:long')
            let okM = run(root, ['--member', '1:0'])
            assert.equal(okM.status, 0, okM.out.slice(0, 300))
            assert.equal(okM.o.member.tag, '0x1:0')
            assert.deepStrictEqual(logOf(root).map((x) => [x.subset, x.member]), [['side:long', undefined], [undefined, '0x1:0']])
        })

        it('空子庫(規則使留下 0 隻):畫面於「子庫 …」一列之後另加一句警示,評估照常(離開碼 0、ok、選集恆空);留下 ≥ 1 隻者與未給 --subset 者畫面無此句', () => {
            //對應規格(主控之裁定,排程第 589 項之接續輪):「--subset 之規則使所留為 0 隻時,畫面於『子庫 …』一列之後加一句警示(照常評估、結果不變)」
            let root = mkProject('cliEmpty')
            let WARN = '警告: 子庫為空(規則使留下 0 隻): 選集恆空、結果無判讀價值; 請檢查 --subset 之規則'
            let e = run(root, ['--subset', 'tp:9:'])
            assert.equal(e.status, 0, e.out.slice(0, 300))
            assert.equal(e.o.ok, true)
            assert.deepEqual(e.o.subset, { rule: 'tp:9:', n: 0, nFull: N, nLong: 0, nShort: 0 })
            assert(e.o.metrics.sel.sizeMax === 0 && e.o.metrics.sel.nEmpty === e.o.metrics.op.nDecisions[0], '評估照常: 每個決策之選集皆空')
            let lines = e.out.split('\n')
            let i = lines.findIndex((l) => l.startsWith('子庫 tp:9:'))
            assert(i >= 0 && /留 0 隻 \/ 全庫 61 隻/.test(lines[i]), e.out.slice(0, 400))
            assert.equal(lines[i + 1], WARN, '警示緊接於「子庫」一列之後')
            assert(lines.findIndex((l) => l.startsWith('[full|')) > i + 1, '警示在結果之前')
            assert.equal(lines.filter((l) => l.startsWith('警告: 子庫為空')).length, 1, '只一句')
            //quick 模式亦同; 與其他規則併用而使交集為空者亦同
            let q = run(root, ['--subset', 'side:long,side:short'])
            assert.equal(q.status, 0, q.out.slice(0, 300))
            assert.equal(q.o.subset.n, 0)
            assert(q.out.split('\n').includes(WARN), q.out.slice(0, 400))
            //留 1 隻(tp:0.01:0.01 只有第 0 隻)、留多隻、未給 --subset: 無警示
            let one = run(root, ['--subset', 'tp:0.01:0.01'])
            assert.equal(one.status, 0, one.out.slice(0, 300))
            assert.equal(one.o.subset.n, 1)
            assert(!one.out.includes('警告: 子庫為空'), '留 1 隻不警示')
            let many = run(root, ['--subset', 'side:long'])
            assert(many.o.subset.n > 1 && !many.out.includes('警告: 子庫為空'))
            let full = run(root, [])
            assert(!full.out.includes('警告: 子庫為空'))
            //--member 之半庫不受此警示影響(本規則只及 --subset)
            let mem = run(root, ['--member', '1:0'])
            assert(!mem.out.includes('警告: 子庫為空'))
        })
    })
})
