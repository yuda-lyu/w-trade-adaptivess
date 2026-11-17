/* eslint-disable no-extend-native -- 違約樣本: 本檔刻意暫時改寫內建原型(測後一律還原), 驗半庫帳本之入口比對 */
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { spawnSync } from 'child_process'
import { loadLedger, memberLedger, tieBaseOf } from '../src/eval/ledger.mjs'
import WTradeAdaptivess from '../src/WTradeAdaptivess.mjs'
import { makeEvaluator as makeEvaluatorRaw, ntStaticOf } from '../src/eval/evalCore.mjs'
import { isIntegrityError } from '../src/eval/intrinsics.mjs'
import { makeTmp, writeSynthLedger, makeTrainEvaluator as makeEvaluator, FD_ROOT } from './tools/synthLedger.mjs'


//成員重抽之半庫帳本(規則 R-EV-40): memberLedger(L, salt, half) 與命令列之 --member <鹽>:<0|1>(Gitea #162)
//  半庫帳本只含該半之策略、序號為半庫內之 0 ~ n-1(保持原先後), 各逐策略欄之內容與其於全庫時相同; 另帶 srcIdx(各策略於全庫之序號)——
//  評估器以之產生同分次鍵, 使半庫內各策略之 ctx.meta.tie 與其於全庫時相同; 未帶 srcIdx 之帳本行為不變
//  等價性: 同一個「只依策略之身分與靜態欄挑選」之模組, 於全庫上只取該半 與 於半庫帳本上執行, 其操作績效與新鮮度逐值相同
//  合成帳本之靜態欄與進場規則欄於本檔改寫為「逐策略相異、段長不一(含 0 條)」之內容(writeSynthLedger 之 cls 全 0、每隻一個條件, 無從分辨取值錯位)
const CFG = { warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [3, 7], nullDraws: 8, seed: 11 }
const SALT = 0x5bd1e995
const SALT2 = 0x27d4eb2f
//inHalf, 獨立寫一份之切半(以策略之同分次鍵之基底與鹽之雜湊; 與 memberLedger 之寫法無共用程式)
let inHalf = (tieBase, salt, half) => (((Math.imul(tieBase ^ salt, 2654435761) >>> 0) / 4294967296) < 0.5) === (half === 0)
//legacyTie, HEAD 之評估器內之原寫法(三行雜湊): tieBaseOf 須與之逐值相同(此值一變, 既有成品之同分次序與選集皆變)
let legacyTie = (s) => {
    let x = Math.imul(s + 0x9E3779B9, 0x85EBCA6B)
    x = Math.imul(x ^ (x >>> 13), 0xC2B2AE35)
    return (x ^ (x >>> 16)) >>> 0
}
//legacyTieSalted, HEAD 之評估器內 cfg.tieSalt ≠ 0 時之原寫法(對基底再做一次雙射雜湊)
let legacyTieSalted = (s, salt) => {
    let x = legacyTie(s)
    if (salt !== 0) {
        x = Math.imul(x ^ Math.imul(salt, 0x9E3779B1), 0x85EBCA6B)
        x = Math.imul(x ^ (x >>> 13), 0xC2B2AE35)
        x = (x ^ (x >>> 16)) >>> 0
    }
    return x
}
let accept = (sig, book) => book.open < 3
let bytesOf = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)
let sameArr = (a, b) => a.constructor === b.constructor && a.length === b.length && Buffer.compare(bytesOf(a), bytesOf(b)) === 0
let hashOfLedger = (L) => {
    let h = crypto.createHash('sha1')
    for (let k of ['off', 'ent', 'ext', 'pnl', 'mode', 'tp', 'sl', 'nKeys', 'lv', 'fitNt', 'cls', 'keyOff', 'keyIdx', 'keySym', 'keyTh', 'keyOr', 'xoff', 'xExt', 'xPnlCum', 'xWinCum', 'px']) {
        h.update(k)
        if (L[k]) {
            h.update(bytesOf(L[k]))
        }
    }
    return h.digest('hex')
}
let errOf = (fn) => {
    try {
        fn()
    }
    catch (err) {
        return err
    }
    return null
}
let msgOf = (fn) => {
    let err = errOf(fn)
    return err === null ? null : (err instanceof Error ? err.message : `非 Error: ${String(err)}`)
}
//patchStatic, 把合成帳本之靜態欄與進場規則欄改寫為逐策略相異者(於 loadLedger 之前; 欄之型別與長度同 ledgerBuild 之輸出: cls 為每策略 3 值、條件欄之段長 = s % 4)
let patchStatic = (dir, n) => {
    let w = (name, arr) => fs.writeFileSync(path.join(dir, name), Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength))
    w('cls.u8', Uint8Array.from({ length: 3 * n }, (_, i) => (i * 7 + 3) % 251))
    w('lv.i32', Int32Array.from({ length: n }, (_, s) => s * 5 + 1))
    w('fitNt.i32', Int32Array.from({ length: n }, (_, s) => 1000 - s * 11))
    w('nKeys.u8', Uint8Array.from({ length: n }, (_, s) => s % 4))
    w('tp.f32', Float32Array.from({ length: n }, (_, s) => 0.01 + s * 0.001))
    w('sl.f32', Float32Array.from({ length: n }, (_, s) => 0.2 - s * 0.001))
    let keyOff = new Uint32Array(n + 1)
    let tot = 0
    for (let s = 0; s < n; s++) {
        keyOff[s] = tot
        tot += s % 4
    }
    keyOff[n] = tot
    w('keyOff.u32', keyOff)
    w('keyIdx.u16', Uint16Array.from({ length: tot }, (_, j) => j % 2))
    w('keySym.i8', Int8Array.from({ length: tot }, (_, j) => (j % 3 === 0 ? -1 : 1)))
    w('keyTh.f64', Float64Array.from({ length: tot }, (_, j) => j * 0.125 - 3))
    w('keyOr.u8', Uint8Array.from({ length: tot }, (_, j) => j % 2))
}
//ctxOf, 於相位 0 之第一個決策取 ctx 之靜態資訊(評估器交給挑選函數者)
let firstCtx = (ev) => {
    let got = null
    ev.runPick((ctx) => {
        if (!got) {
            got = { n: ctx.n, tie: Array.from(ctx.meta.tie), nt: Array.from(ctx.meta.ntAll), mode: Array.from(ctx.meta.mode), cls: Array.from(ctx.meta.cls), nKeys: Array.from(ctx.meta.nKeys), keyOff: Array.from(ctx.meta.keyOff), keyIdx: Array.from(ctx.meta.keyIdx), keyTh: Array.from(ctx.meta.keyTh) }
        }
        return []
    }, 0)
    return got
}

describe('成員重抽之半庫帳本(memberLedger)與命令列之 --member', function () {
    let t
    let L
    const N = 60
    before(() => {
        t = makeTmp('memberLedger')
        writeSynthLedger(path.join(t.dir, 's'), { n: N, nBars: 2400, seed: 5, series: ['ser_a'] })
        patchStatic(path.join(t.dir, 's'), N)
        L = loadLedger(path.join(t.dir, 's'))
    })
    after(() => {
        t.cleanup()
    })

    it('tieBaseOf(序號) = HEAD 之原寫法(逐值相同)= 評估器於一般帳本之 ctx.meta.tie(同分次序為正本時);未帶 srcIdx 之帳本行為不變', () => {
        //對應規格:「tie 之雜湊式由 evalCore 改為呼叫 tieBaseOf(單一來源; 值不變)」
        for (let i = 0; i < 5000; i++) {
            assert.strictEqual(tieBaseOf(i), legacyTie(i), `序號 ${i}`)
        }
        assert.deepEqual([0, 1, 2, 12345, 65535].map((i) => tieBaseOf(i)), [493009611, 1007616808, 100097173, 3971849368, 2991463478], '固定值(由原寫法算得)')
        let ev = makeEvaluator(L, CFG)
        let seen = firstCtx(ev).tie
        assert.equal(seen.length, L.n)
        assert.deepEqual(seen, Array.from({ length: L.n }, (_, s) => tieBaseOf(s)))
        assert.equal(new Set(seen).size, L.n, '各策略之值兩兩相異')
        assert.equal(L.srcIdx, undefined)
    })

    it('兩半互不重疊且合為全庫;半庫帳本之各逐策略欄(含 cls 每策略 3 值)與其於全庫時逐位相同;逐棒之欄與延遲讀取之欄共用;不改動原帳本', () => {
        let h0 = hashOfLedger(L)
        let A = memberLedger(L, SALT, 0)
        let B = memberLedger(L, SALT, 1)
        assert.equal(hashOfLedger(L), h0, '原帳本不被改動')
        assert(A.n > 0 && B.n > 0 && A.n + B.n === L.n)
        let ia = Array.from(A.srcIdx)
        let ib = Array.from(B.srcIdx)
        assert.deepEqual([...ia, ...ib].sort((x, y) => x - y), Array.from({ length: L.n }, (_, s) => s))
        for (let [M, half] of [[A, 0], [B, 1]]) {
            assert(Object.prototype.toString.call(M.srcIdx) === '[object Int32Array]' && M.srcIdx.length === M.n)
            assert(Array.from(M.srcIdx).every((s, i, a) => i === 0 || s > a[i - 1]), '保持原先後')
            assert(Array.from(M.srcIdx).every((s) => inHalf(tieBaseOf(s), SALT, half)), '成員 = 切半之該半')
            assert.deepEqual({ ...M.member }, { salt: SALT, half, nFull: L.n })
            assert(Object.isFrozen(M.member), 'member 為凍結之物件')
            assert.equal(M.nBars, L.nBars)
            assert.equal(M.barsPerDay, L.barsPerDay)
            assert.equal(M.meta, L.meta)
            assert.equal(M.dir, L.dir)
            assert.equal(M.px, L.px, 'K 線欄共用')
            assert.notEqual(L.fac, null, '前提: 合成帳本有因子欄')
            assert.notEqual(L.ser, null, '前提: 合成帳本有外部序列欄')
            assert.equal(M.fac, L.fac, '因子序列欄共用(延遲讀取)')
            assert.equal(M.ser, L.ser, '外部序列欄共用(延遲讀取)')
            assert(!Object.keys(M).includes('fac') && !Object.keys(M).includes('ser'), 'fac / ser 同 loadLedger: 不可列舉')
            assert.deepEqual(M.seriesNames, L.seriesNames)
            assert.deepEqual(M.keyNames, L.keyNames)
            assert.equal(M.off.length, M.n + 1)
            assert.equal(M.keyOff.length, M.n + 1)
            assert.equal(M.xoff.length, M.n + 1)
            assert.equal(M.cls.length, 3 * M.n, 'cls 為每策略 3 值')
            for (let i = 0; i < M.n; i++) {
                let s = M.srcIdx[i]
                for (let k of ['mode', 'tp', 'sl', 'nKeys', 'lv', 'fitNt']) {
                    assert.strictEqual(M[k][i], L[k][s], `${k}[${i}]`)
                }
                for (let j = 0; j < 3; j++) {
                    assert.strictEqual(M.cls[3 * i + j], L.cls[3 * s + j], `cls[${3 * i + j}]`)
                }
                for (let k of ['ent', 'ext', 'pnl']) {
                    assert(sameArr(M[k].subarray(M.off[i], M.off[i + 1]), L[k].subarray(L.off[s], L.off[s + 1])), `${k} 之第 ${i} 隻`)
                }
                for (let k of ['keyIdx', 'keySym', 'keyTh', 'keyOr']) {
                    assert(sameArr(M[k].subarray(M.keyOff[i], M.keyOff[i + 1]), L[k].subarray(L.keyOff[s], L.keyOff[s + 1])), `${k} 之第 ${i} 隻`)
                }
                for (let k of ['xExt', 'xPnlCum', 'xWinCum']) {
                    assert(sameArr(M[k].subarray(M.xoff[i], M.xoff[i + 1]), L[k].subarray(L.xoff[s], L.xoff[s + 1])), `${k} 之第 ${i} 隻`)
                }
            }
            assert.equal(M.off[M.n], M.ent.length)
            assert.equal(M.keyOff[M.n], M.keyIdx.length)
            assert.equal(M.xoff[M.n], M.xExt.length)
            //段長不一(含 0 條件之策略): 前提
            assert(Array.from({ length: M.n }, (_, i) => M.keyOff[i + 1] - M.keyOff[i]).some((x) => x === 0) && Array.from({ length: M.n }, (_, i) => M.keyOff[i + 1] - M.keyOff[i]).some((x) => x === 3))
            //帳本之各欄為新建之複本(不與原帳本共用記憶體): 改半庫帳本不影響原帳本
            for (let k of ['off', 'ent', 'ext', 'pnl', 'mode', 'tp', 'sl', 'nKeys', 'lv', 'fitNt', 'cls', 'keyOff', 'keyIdx', 'keySym', 'keyTh', 'keyOr', 'xoff', 'xExt', 'xPnlCum', 'xWinCum']) {
                assert.notEqual(M[k].buffer, L[k].buffer, `${k} 與原帳本不共用記憶體`)
            }
        }
        //換鹽 = 換一種切法
        let A2 = memberLedger(L, SALT2, 0)
        assert.notDeepEqual(Array.from(A2.srcIdx), ia)
        assert.equal(hashOfLedger(L), h0, '原帳本不被改動(其後)')
    })

    it('依出場棒排序之已結單欄與獨立之重算相同(全庫與半庫皆然):逐策略之已結單依(出場棒, 單序)升冪、損益與勝場為策略內前綴和 —— 不借用 setExitCols 自己對照(共同之錯不會互相抵銷)', () => {
        let oracle = (M, s) => {
            let js = []
            for (let j = M.off[s]; j < M.off[s + 1]; j++) {
                if (M.ext[j] >= 0) {
                    js.push(j)
                }
            }
            js.sort((a, b) => M.ext[a] - M.ext[b] || a - b)
            let cp = 0
            let cw = 0
            return { ext: js.map((j) => M.ext[j]), pnl: js.map((j) => (cp += M.pnl[j])), win: js.map((j) => (cw += M.pnl[j] > 0 ? 1 : 0)) }
        }
        let dupExit = 0
        //損益恰為 0 之已結單不計為勝場(合成帳本之損益皆非 0, 另造一份把每第 7 張單之損益設為 0 之帳本)
        let pnlZero = Float32Array.from(L.pnl, (v, j) => (j % 7 === 0 ? 0 : v))
        let Lz = { ...L, pnl: pnlZero }
        for (let M of [L, memberLedger(L, SALT, 0), memberLedger(L, SALT, 1), memberLedger(memberLedger(L, SALT, 0), SALT2, 1), memberLedger(Lz, SALT, 0)]) {
            for (let s = 0; s < M.n; s++) {
                let o = oracle(M, s)
                let a = M.xoff[s]
                let z = M.xoff[s + 1]
                assert.deepEqual(Array.from(M.xExt.subarray(a, z)), o.ext, `第 ${s} 隻 xExt`)
                assert.deepEqual(Array.from(M.xPnlCum.subarray(a, z)), o.pnl, `第 ${s} 隻 xPnlCum`)
                assert.deepEqual(Array.from(M.xWinCum.subarray(a, z)), o.win, `第 ${s} 隻 xWinCum`)
                dupExit += o.ext.filter((x, i, arr) => i > 0 && x === arr[i - 1]).length
            }
        }
        assert(dupExit > 0, '前提: 合成帳本內有同一出場棒之多單(單序之次鍵才有作用)')
    })

    it('評估器於半庫帳本:ctx.n 為半庫之隻數;各策略之 ctx.meta.tie 與其於全庫時相同;ntAll 為該半之訓練期進場數;靜態欄(含 cls)與進場規則欄為該半者', () => {
        let A = memberLedger(L, SALT, 0)
        A.ntStatic = ntStaticOf(A, 1200)
        let got = firstCtx(makeEvaluatorRaw(A, CFG))
        assert.equal(got.n, A.n)
        assert.deepEqual(got.tie, Array.from(A.srcIdx, (s) => tieBaseOf(s)))
        let ntFull = ntStaticOf(L, 1200)
        assert.deepEqual(got.nt, Array.from(A.srcIdx, (s) => ntFull[s]))
        assert.deepEqual(got.mode, Array.from(A.srcIdx, (s) => L.mode[s]))
        assert.deepEqual(got.nKeys, Array.from(A.srcIdx, (s) => L.nKeys[s]))
        //cls 每策略 3 值: 以全庫之值逐隻核對
        assert.deepEqual(got.cls, Array.from(A.srcIdx).flatMap((s) => [L.cls[3 * s], L.cls[3 * s + 1], L.cls[3 * s + 2]]))
        //進場規則之條件欄(段長不一)
        assert.deepEqual(got.keyOff.length, A.n + 1)
        let wantTh = Array.from(A.srcIdx).flatMap((s) => Array.from(L.keyTh.subarray(L.keyOff[s], L.keyOff[s + 1])))
        assert.deepEqual(got.keyTh, wantTh)
        //cfg.tieSalt(迴圈之重放)與半庫並用: 半庫內各策略之 tie = 全庫評估器於同一 tieSalt 下該策略之 tie
        for (let tieSalt of [5, -5, 2 ** 53 + 2]) {
            let fullSalt = firstCtx(makeEvaluator(L, { ...CFG, tieSalt })).tie
            //獨立預期(HEAD 之原寫法: 同分次鍵之基底再依鹽雙射雜湊一次):
            assert.deepEqual(fullSalt, Array.from({ length: L.n }, (_, s) => legacyTieSalted(s, tieSalt)), `tieSalt ${tieSalt}: 全庫之 tie = 原寫法`)
            let halfSalt = firstCtx(makeEvaluatorRaw(A, { ...CFG, tieSalt })).tie
            assert.deepEqual(halfSalt, Array.from(A.srcIdx, (s) => fullSalt[s]), `tieSalt ${tieSalt}`)
            assert.notDeepEqual(fullSalt, firstCtx(makeEvaluator(L, CFG)).tie, `tieSalt ${tieSalt} 確實改了同分次鍵`)
        }
    })

    it('等價性:只依策略之身分(同分次鍵)與靜態欄(含 cls、進場規則)與已結單之統計挑選之模組,於全庫上只取該半 與 於半庫帳本上執行,操作績效、新鮮度與下單數逐值相同(含持倉上限下之同棒次序)', () => {
        //pickOf: mask 為 null ⇒ 取全部之合格者(半庫帳本上用); 否則只取 mask 為真者(全庫上用)
        let pickOf = (mask) => (ctx) => {
            let m = ctx.meta
            let S = ctx.stat(60)
            let ids = []
            for (let s = 0; s < ctx.n; s++) {
                if (mask && !mask(m.tie[s])) {
                    continue
                }
                let key = 0
                for (let j = m.keyOff[s]; j < m.keyOff[s + 1]; j++) {
                    key += m.keyTh[j] > -2 ? 1 : 0
                }
                let v = m.cls[3 * s] + m.cls[3 * s + 1] + m.cls[3 * s + 2] + m.nKeys[s] + key + (m.tie[s] >>> 3) + ctx.k
                if (v % 3 === 0 || S.pnl[s] > 1) {
                    ids.push(s)
                }
            }
            return ids
        }
        let evFull = makeEvaluator(L, CFG)
        for (let [salt, half] of [[SALT, 0], [SALT, 1], [SALT2, 0]]) {
            let M = memberLedger(L, salt, half)
            let evM = makeEvaluator(M, CFG)
            let a = evFull.evalPolicy(pickOf((tb) => inHalf(tb, salt, half)), { accept })
            let b = evM.evalPolicy(pickOf(null), { accept })
            assert(a.op.nDecisions.every((x) => x > 6) && a.sel.sizeMean > 2 && a.op.monthlyOrders.mean > 0, '測試之選集與下單不得為空')
            assert(a.op.acceptRate < 1, '持倉上限須實際擋單(同棒次序才有作用)')
            assert.deepStrictEqual(b.op.eqYr, a.op.eqYr, `鹽 ${salt} 半 ${half}: 等效年化`)
            assert.deepStrictEqual(b.op.monthlyOrders, a.op.monthlyOrders)
            assert.deepStrictEqual(b.op.peakHold, a.op.peakHold)
            assert.strictEqual(b.op.pnl, a.op.pnl)
            assert.strictEqual(b.op.winRate, a.op.winRate)
            assert.strictEqual(b.op.acceptRate, a.op.acceptRate)
            //三等分: 成品之各段逐值相同(各段之隨機對照 nullMean 依策略庫而定, 半庫與全庫本來不同, 不比)
            let noNull = (ths) => ths.map(({ nullMean, ...rest }) => rest)
            assert.deepStrictEqual(noNull(b.op.thirds), noNull(a.op.thirds))
            assert.deepStrictEqual(b.fresh, a.fresh)
            assert.strictEqual(b.sel.sizeMean, a.sel.sizeMean)
            assert.strictEqual(b.sel.turnoverJaccard, a.sel.turnoverJaccard)
            assert.notStrictEqual(b.selHash, a.selHash, '選集指紋依序號而定, 半庫與全庫不同')
            //虛無與擴充診斷於半庫上可執行
            assert(b.null && typeof b.null.p === 'number' && b.nullSideAct && typeof b.nullSideAct.excess === 'number')
        }
    })

    it('可於半庫內再切:srcIdx 仍為全庫之序號、member.nFull 為全庫之隻數;再切之結果 = 以兩個鹽之條件自全庫直接取', () => {
        let A = memberLedger(L, SALT, 0)
        let AA = memberLedger(A, SALT2, 1)
        assert(AA.n > 0 && AA.n < A.n)
        let want = Array.from({ length: L.n }, (_, s) => s).filter((s) => inHalf(tieBaseOf(s), SALT, 0) && inHalf(tieBaseOf(s), SALT2, 1))
        assert.deepEqual(Array.from(AA.srcIdx), want)
        assert.deepEqual({ ...AA.member }, { salt: SALT2, half: 1, nFull: L.n })
        //各欄 = 自全庫逐隻取之值
        for (let i = 0; i < AA.n; i++) {
            let s = AA.srcIdx[i]
            assert.strictEqual(AA.mode[i], L.mode[s])
            assert.deepEqual(Array.from(AA.cls.subarray(3 * i, 3 * i + 3)), Array.from(L.cls.subarray(3 * s, 3 * s + 3)))
            assert(sameArr(AA.ent.subarray(AA.off[i], AA.off[i + 1]), L.ent.subarray(L.off[s], L.off[s + 1])))
            assert(sameArr(AA.keyTh.subarray(AA.keyOff[i], AA.keyOff[i + 1]), L.keyTh.subarray(L.keyOff[s], L.keyOff[s + 1])))
        }
        assert.equal(AA.fac, L.fac, '延遲讀取之欄經兩層仍共用')
        assert.equal(AA.ser, L.ser)
        let tie = firstCtx(makeEvaluator(AA, CFG)).tie
        assert.deepEqual(tie, Array.from(AA.srcIdx, (s) => tieBaseOf(s)))
    })

    it('參數不合者拋錯(訊息固定、不帶輸入值;依 iseint:安全整數之數字或其數字字串;十六進位字串不收);L 不合者拋錯;L.srcIdx 給而不合者拒絕建評估器', () => {
        //參數之位置先後: L、salt、half
        let invalidSalts = [-1, 1.5, 4294967296, 4294967297, null, undefined, NaN, Infinity, true, '0x10', 'abc', {}, [], [1], 2 ** 53, -0.5, '4294967297', 'zz-secret-salt']
        for (let salt of invalidSalts) {
            let msg = msgOf(() => memberLedger(L, salt, 0))
            assert(msg === 'invalid salt: must be an integer from 0 to 4294967295', `salt ${String(salt)}: ${msg}`)
        }
        let invalidHalves = [2, -1, true, false, null, undefined, 0.5, '2', 'a', {}, [0], NaN, 'zz-secret-half']
        for (let half of invalidHalves) {
            let msg = msgOf(() => memberLedger(L, 123456, half))
            assert(msg === 'invalid half: must be 0 or 1', `half ${String(half)}: ${msg}`)
        }
        //鹽之邊界與數字字串(通過 iseint 者轉為數字)
        assert.equal(memberLedger(L, 0, 0).n + memberLedger(L, 0, 1).n, L.n, '鹽 0')
        assert.equal(memberLedger(L, 4294967295, 0).n + memberLedger(L, 4294967295, 1).n, L.n, '鹽之上界')
        assert.equal(Object.is(memberLedger(L, -0, 0).member.salt, 0), true, '-0 正規化為 0')
        let viaStr = memberLedger(L, '1527', '1')
        let viaNum = memberLedger(L, 1527, 1)
        assert.deepEqual(Array.from(viaStr.srcIdx), Array.from(viaNum.srcIdx))
        assert.deepEqual({ ...viaStr.member }, { salt: 1527, half: 1, nFull: L.n })
        //L 不合
        let A0 = memberLedger(L, SALT, 0)
        let badLs = [null, undefined, 'x', 5, {}, { ...L, n: -1 }, { ...L, n: 1.5 }, { ...L, off: new Uint32Array(3) }, { ...L, mode: new Int8Array(3) }, { ...L, mode: Array.from(L.mode) }, { ...L, cls: new Uint8Array(L.n) }, { ...L, ent: new Int32Array(2) }, { ...L, keyIdx: new Uint16Array(2) }, { ...L, keyTh: new Float32Array(L.keyTh.length) }, { ...L, srcIdx: new Uint32Array(L.n) }, { ...L, srcIdx: new Int32Array(L.n + 1) }, { ...L, member: { nFull: 3 } }, { ...L, member: 'x' }]
        for (let [i, bad] of badLs.entries()) {
            let msg = msgOf(() => memberLedger(bad, SALT, 0))
            assert.equal(msg, 'invalid L: must be a ledger object (see loadLedger and memberLedger)', `badL ${i}: ${msg}`)
        }
        //逐欄: 型別不合(換成另一種定型陣列)與長度短一者皆拒絕(keySym / keyTh / keyOr 於舊帳本為 null 則可)
        for (let k of ['off', 'keyOff', 'mode', 'tp', 'sl', 'nKeys', 'lv', 'fitNt', 'cls', 'ent', 'ext', 'pnl', 'keyIdx', 'keySym', 'keyTh', 'keyOr']) {
            let Ctor = L[k].constructor
            let other = Ctor === Int16Array ? Int32Array : Int16Array
            for (let [what, v] of [['型別', new other(L[k].length)], ['短一', new Ctor(L[k].length - 1)]]) {
                let msg = msgOf(() => memberLedger({ ...L, [k]: v }, SALT, 0))
                assert.equal(msg, 'invalid L: must be a ledger object (see loadLedger and memberLedger)', `${k} ${what}: ${msg}`)
            }
        }
        //起訖欄須自 0 起且不遞減(損毀之帳本不得靜默產生假資料)
        for (let k of ['off', 'keyOff']) {
            let first = Uint32Array.from(L[k])
            first[0] = 1
            let down = Uint32Array.from(L[k])
            down[2] = down[3] + 1
            let lastDown = Uint32Array.from(L[k]) //最後一對(第 n - 1 與第 n 個)遞減
            lastDown[L.n - 1] = lastDown[L.n] + 1
            for (let [what, v] of [['非自 0 起', first], ['遞減', down], ['最後一對遞減', lastDown]]) {
                let msg = msgOf(() => memberLedger({ ...L, [k]: v }, SALT, 0))
                assert.equal(msg, 'invalid L: must be a ledger object (see loadLedger and memberLedger)', `${k} ${what}: ${msg}`)
            }
        }
        for (let k of ['keySym', 'keyTh', 'keyOr']) {
            let M = memberLedger({ ...L, [k]: null }, SALT, 0)
            assert.equal(M[k], null, `舊帳本無 ${k} 者為 null`)
        }
        assert.equal(memberLedger({ ...L, keySym: null, keyTh: null, keyOr: null }, SALT, 0).keySym, null, '舊帳本無三個條件欄者各為 null')
        assert.equal(A0.n > 0, true)
        //L.srcIdx 給而不合者拒絕建評估器(型別以內部槽判定: 偽造原型者亦拒; null / undefined 視同未給)
        let nt = new Int32Array(A0.n)
        let spoof = Object.setPrototypeOf(new Uint32Array(A0.n), Int32Array.prototype)
        let neg = Int32Array.from({ length: A0.n }, (_, i) => (i === 3 ? -1 : i))
        //只有 null / undefined 視同未給(其餘給了而不合者一律拒絕, 含 0、空字串、false 等假值)
        let bad = [new Uint32Array(A0.n), new Int32Array(A0.n + 1), new Int32Array(A0.n - 1), neg, Array.from(A0.srcIdx), 'x', 5, 0, '', false, {}, spoof]
        for (let [i, v] of bad.entries()) {
            let msg = msgOf(() => makeEvaluatorRaw({ ...A0, ntStatic: nt, srcIdx: v }, CFG))
            assert.equal(msg, 'invalid L.srcIdx: must be an Int32Array of length L.n with non-negative values (index of each strategy in the full library; see memberLedger)', `srcIdx ${i}: ${msg}`)
        }
        //只有 1 隻策略之帳本:srcIdx 同樣檢查(負值拒、0 收)
        writeSynthLedger(path.join(t.dir, 'one'), { n: 1, nBars: 1800, seed: 3 })
        let O = loadLedger(path.join(t.dir, 'one'))
        let nt1 = new Int32Array(1)
        assert(/^invalid L\.srcIdx: must be /.test(msgOf(() => makeEvaluatorRaw({ ...O, ntStatic: nt1, srcIdx: Int32Array.of(-1) }, CFG))), '1 隻:負值拒')
        assert.doesNotThrow(() => makeEvaluatorRaw({ ...O, ntStatic: nt1, srcIdx: Int32Array.of(0) }, CFG), '1 隻:0 收')
        //檢查之值即使用之值: cfg.tieSalt 之存取子(可執行呼叫端之程式)於檢查 srcIdx 之前被讀取 ⇒ 其於存取子內把 srcIdx 改成負值者,於檢查時即被拒(不是檢查後才被改而仍被使用)
        let sneaky = Int32Array.from(A0.srcIdx)
        let cfgSneaky = { ...CFG }
        Object.defineProperty(cfgSneaky, 'tieSalt', { get: () => { sneaky[0] = -1; return 0 } })
        let msgS = msgOf(() => makeEvaluatorRaw({ ...A0, ntStatic: nt, srcIdx: sneaky }, cfgSneaky))
        assert(/^invalid L\.srcIdx: must be /.test(msgS), `存取子改動 srcIdx: ${msgS}`)
        //cfg.tieSalt 只讀一次: 存取子第一次回 0、其後回帶 valueOf 之物件(valueOf 內改動已檢查之 srcIdx)⇒ 只讀一次者不會呼叫 valueOf, srcIdx 不被改動
        let calls = { get: 0, valueOf: 0 }
        let intact = Int32Array.from(A0.srcIdx)
        let cfgTwice = { ...CFG }
        Object.defineProperty(cfgTwice, 'tieSalt', { get: () => (++calls.get === 1 ? 0 : { valueOf: () => { calls.valueOf++; intact[0] = -1; return 3 } }) })
        let evTwice = makeEvaluatorRaw({ ...A0, ntStatic: nt, srcIdx: intact }, cfgTwice)
        assert.deepEqual(calls, { get: 1, valueOf: 0 }, 'cfg.tieSalt 只讀一次')
        assert.equal(intact[0], A0.srcIdx[0])
        let tieTwice = null
        evTwice.runPick((ctx) => {
            tieTwice = tieTwice || Array.from(ctx.meta.tie)
            return []
        }, 0)
        assert.deepEqual(tieTwice, Array.from(A0.srcIdx, (s) => tieBaseOf(s)))
        assert.doesNotThrow(() => makeEvaluatorRaw({ ...A0, ntStatic: nt, srcIdx: null }, CFG), 'null 視同未給')
        assert.doesNotThrow(() => makeEvaluatorRaw({ ...A0, ntStatic: nt, srcIdx: undefined }, CFG), 'undefined 視同未給')
        assert.doesNotThrow(() => makeEvaluatorRaw({ ...A0, ntStatic: nt }, CFG), '未給')
        assert.doesNotThrow(() => makeEvaluatorRaw({ ...A0, ntStatic: nt, srcIdx: new Int32Array(A0.n) }, CFG), '合格之 Int32Array(含 0)')
    })

    it('入口先比對受保護之內建物件:內建方法被改 ⇒ 拋 EVAL_INTEGRITY(where = ledger-load)、替身未被呼叫;還原後照常', () => {
        //memberLedger 之其後之寫法(setExitCols 之 push / sort)為一般寫法, 須在入口比對之後才執行
        let origPush = Array.prototype.push
        let called = 0
        let err
        try {
            Array.prototype.push = function (...a) {
                called++
                return origPush.apply(this, a)
            }
            err = errOf(() => memberLedger(L, SALT, 0))
        }
        finally {
            Array.prototype.push = origPush
        }
        assert(err && isIntegrityError(err), `應拋完整性錯誤: ${err && err.message}`)
        assert.equal(err.code, 'EVAL_INTEGRITY')
        assert.equal(err.where, 'ledger-load')
        assert.equal(called, 0, '替身未被呼叫(入口先比對, 其後之一般寫法不執行)')
        assert(memberLedger(L, SALT, 0).n > 0, '還原後照常')
    })

    it('空半庫(策略極少而某一半無成員):memberLedger 照常回 n = 0 之帳本(各欄長度合),評估器可建且執行,選集恆空;兩半互補仍成立', () => {
        writeSynthLedger(path.join(t.dir, 'tiny'), { n: 2, nBars: 1800, seed: 3 })
        let T = loadLedger(path.join(t.dir, 'tiny'))
        let empty = null
        for (let salt = 0; salt < 16 && empty === null; salt++) {
            for (let half of [0, 1]) {
                let M = memberLedger(T, salt, half)
                let other = memberLedger(T, salt, 1 - half)
                assert.equal(M.n + other.n, T.n, `鹽 ${salt}: 兩半互補`)
                if (M.n === 0 && empty === null) {
                    empty = M
                }
            }
        }
        assert(empty !== null, '前提: 2 隻策略於 16 個鹽內必有空半庫')
        assert.equal(empty.srcIdx.length, 0)
        assert.equal(empty.off.length, 1)
        assert.equal(empty.keyOff.length, 1)
        assert.equal(empty.xoff.length, 1)
        assert.equal(empty.ent.length, 0)
        assert.equal(empty.cls.length, 0)
        //空帳本之檢查仍有效: 起訖欄須自 0 起;給定之 srcIdx 型別不合者拒
        assert.equal(msgOf(() => memberLedger({ ...empty, off: Uint32Array.of(1), ent: new Int32Array(1), ext: new Int32Array(1), pnl: new Float32Array(1) }, SALT, 0)), 'invalid L: must be a ledger object (see loadLedger and memberLedger)', '起訖欄之起點非 0(逐單欄夠長, 只有起點檢查能擋)')
        assert(/^invalid L\.srcIdx: must be /.test(msgOf(() => makeEvaluatorRaw({ ...empty, ntStatic: new Int32Array(0), srcIdx: new Uint32Array(0) }, CFG))))
        empty.ntStatic = ntStaticOf(empty, 900)
        let ev = makeEvaluatorRaw(empty, { ...CFG, phases: [0], horizons: [7], nullDraws: 2 })
        let m = ev.evalPolicy(() => [], {})
        assert.equal(m.sel.sizeMean, 0)
        assert.equal(m.op.eqYr.mean, 0)
    })

    describe('命令列 g_eval.mjs --member', function () {
        //合成專案根(同 unit-evalCli 之作法): 帳本 2400 棒、訓練期終點第 1200 棒、回測期自第 1290 棒; 挑選模組於 rsi/work/w1(評估紀錄 .evals.log 落該夾)
        let mkProject = (name) => {
            let root = path.join(t.dir, name)
            writeSynthLedger(path.join(root, 'ledger', 'eval'), { n: N, nBars: 2400, seed: 7 })
            patchStatic(path.join(root, 'ledger', 'eval'), N)
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
            //挑選: 依身分取約三分之一(只依 ctx.meta.tie, 兩半之選集大小之和 = 全庫之選集大小)
            fs.writeFileSync(path.join(root, 'rsi', 'work', 'w1', 'pick.mjs'), 'export default function pick(ctx) {\n    let ids = []\n    for (let s = 0; s < ctx.n; s++) {\n        if ((ctx.meta.tie[s] >>> 3) % 3 === 0) ids.push(s)\n    }\n    return ids\n}\n', 'utf8')
            //傾印: 把挑選函數所見之 ctx 以錯誤訊息帶出(命令列印 ERROR PICK_RUN 與錯誤之前幾列)
            fs.writeFileSync(path.join(root, 'rsi', 'work', 'w1', 'pick_dump.mjs'), 'export default function pick(ctx) {\n    throw new Error("DUMP " + JSON.stringify({ n: ctx.n, tie: Array.from(ctx.meta.tie), cls: Array.from(ctx.meta.cls), nt: Array.from(ctx.meta.ntAll) }))\n}\n', 'utf8')
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
        let logOf = (root) => fs.readFileSync(path.join(root, 'rsi', 'work', 'w1', '.evals.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

        it('未給 --member:結果檔無 member 欄、評估紀錄無 member;給 --member <鹽>:<0|1>:以該半評估,結果檔與評估紀錄皆標記,畫面首列註明不是正本,兩半之選集大小之和 = 全庫', () => {
            let root = mkProject('cli')
            let full = run(root, [])
            assert.equal(full.status, 0, full.out.slice(0, 600))
            assert(full.o && full.o.ok === true && !('member' in full.o))
            assert(!/成員重抽/.test(full.out))
            let a = run(root, ['--member', '0x5bd1e995:0'])
            let b = run(root, ['--member', `${SALT}:1`])
            assert.equal(a.status, 0, a.out.slice(0, 600))
            assert.equal(b.status, 0, b.out.slice(0, 600))
            let Lc = loadLedger(path.join(root, 'ledger', 'eval'))
            let nA = memberLedger(Lc, SALT, 0).n
            assert.deepEqual(a.o.member, { tag: '0x5bd1e995:0', salt: SALT, half: 0, n: nA, nFull: Lc.n })
            assert.deepEqual(b.o.member, { tag: '0x5bd1e995:1', salt: SALT, half: 1, n: Lc.n - nA, nFull: Lc.n }, '鹽可用十進位')
            assert(/成員重抽 0x5bd1e995:0/.test(a.out) && /不是正本/.test(a.out))
            assert(a.out.indexOf('成員重抽') < a.out.indexOf('[full|'), '註明在結果之前')
            //身分式之挑選: 兩半之選集大小之和 = 全庫之選集大小(每次決策皆同)
            assert(Math.abs(a.o.metrics.sel.sizeMean + b.o.metrics.sel.sizeMean - full.o.metrics.sel.sizeMean) < 1e-9)
            assert(a.o.metrics.null && a.o.metrics.nullSideAct, '虛無於半庫上照算')
            assert.notEqual(a.o.metrics.selHash, full.o.metrics.selHash)
            let log = logOf(root)
            assert.equal(log.length, 3)
            assert.deepEqual(log.map((x) => x.member), [undefined, '0x5bd1e995:0', '0x5bd1e995:1'])
            assert(!('member' in log[0]))
            assert(log.every((x) => x.ok === true && typeof x.selHash === 'string'))
        })

        it('命令列之挑選函數所見 = memberLedger 之半庫:ctx.n、ctx.meta.tie(= 全庫之值)、ctx.meta.cls(每策略 3 值)、ctx.meta.ntAll;失敗之評估(挑選函數拋錯)之評估紀錄亦帶 member;未給時所見 = 全庫', () => {
            let root = mkProject('cliDump')
            let Lc = loadLedger(path.join(root, 'ledger', 'eval'))
            let lastOut = null
            let dumpOf = (args) => {
                let r = run(root, args, 'pick_dump.mjs')
                let m = /Error: DUMP (\{.*\})/.exec(r.out)
                assert.equal(r.status, 3, r.out.slice(0, 600))
                assert(m, r.out.slice(0, 600))
                lastOut = r.o
                return JSON.parse(m[1])
            }
            let nt = ntStaticOf(Lc, 1200)
            let d0 = dumpOf([])
            assert(lastOut && lastOut.ok === false && !('member' in lastOut), '未給 --member:失敗之結果檔無 member')
            assert.equal(d0.n, Lc.n)
            assert.deepEqual(d0.tie, Array.from({ length: Lc.n }, (_, s) => tieBaseOf(s)))
            assert.deepEqual(d0.cls, Array.from(Lc.cls))
            assert.deepEqual(d0.nt, Array.from(nt))
            for (let [salt, half] of [[SALT, 0], [SALT, 1]]) {
                let A = memberLedger(Lc, salt, half)
                let d = dumpOf(['--member', `0x${salt.toString(16)}:${half}`])
                assert.equal(d.n, A.n)
                assert.deepEqual(d.tie, Array.from(A.srcIdx, (s) => tieBaseOf(s)))
                assert.deepEqual(d.cls, Array.from(A.srcIdx).flatMap((s) => [Lc.cls[3 * s], Lc.cls[3 * s + 1], Lc.cls[3 * s + 2]]))
                assert.deepEqual(d.nt, Array.from(A.srcIdx, (s) => nt[s]), 'ntAll 為該半於訓練期之進場數')
                //失敗之結果檔亦帶 member(帳本尚未載入時之標記: tag、salt、half)
                assert(lastOut && lastOut.ok === false && lastOut.code === 'PICK_RUN', '失敗之結果檔')
                assert.deepEqual(lastOut.member, { tag: `0x${salt.toString(16)}:${half}`, salt, half })
            }
            let log = logOf(root)
            assert.deepEqual(log.map((x) => x.member), [undefined, '0x5bd1e995:0', '0x5bd1e995:1'])
            assert(log.every((x) => x.ok === false && x.code === 'PICK_RUN'), '失敗之列亦記(帶 member)')
        })

        it('--ext-test 與 --ref 亦於半庫上執行:擴充診斷所見之 api.n、參考模組所見之 ctx.n(以其選集大小量)皆為半庫之隻數;未給 --member 時為全庫', () => {
            let root = mkProject('cliExtRef')
            let wd = path.join(root, 'rsi', 'work', 'w1')
            fs.writeFileSync(path.join(wd, 'ext_n.mjs'), 'export default function (api) {\n    return { text: "n=" + api.n }\n}\n', 'utf8')
            fs.writeFileSync(path.join(wd, 'ref_all.mjs'), 'export default function pick(ctx) {\n    let ids = []\n    for (let s = 0; s < ctx.n; s++) ids.push(s)\n    return ids\n}\n', 'utf8')
            let Lc = loadLedger(path.join(root, 'ledger', 'eval'))
            let nHalf = memberLedger(Lc, SALT, 1).n
            let extN = (args) => {
                let r = run(root, ['--ext-test', path.join(wd, 'ext_n.mjs'), ...args])
                let m = /EXT_OK ext_n\([^)]*\): n=(\d+)/.exec(r.out)
                assert.equal(r.status, 0, r.out.slice(0, 400))
                assert(m, r.out.slice(0, 400))
                return Number(m[1])
            }
            assert.equal(extN([]), Lc.n)
            assert.equal(extN(['--member', `${SALT}:1`]), nHalf)
            let refN = (args) => {
                let r = run(root, ['--ref', path.join(wd, 'ref_all.mjs'), ...args])
                assert.equal(r.status, 0, r.out.slice(0, 400))
                return r.o.refOverlap.refSizeMean
            }
            assert.equal(refN([]), Lc.n)
            assert.equal(refN(['--member', `${SALT}:1`]), nHalf)
        })

        it('挑選模組載入失敗(靜態檢查未過)之評估:評估紀錄之列與失敗之結果檔皆帶 member(載入失敗者亦然);未給 --member 者皆無', () => {
            let root = mkProject('cliScan')
            fs.writeFileSync(path.join(root, 'rsi', 'work', 'w1', 'pick_bad.mjs'), "import fs from 'fs'\nexport default function pick(ctx) { return [] }\n", 'utf8')
            let a = run(root, [], 'pick_bad.mjs')
            let b = run(root, ['--member', '0x5bd1e995:1'], 'pick_bad.mjs')
            let z = run(root, ['--member', '0:0'], 'pick_bad.mjs') //鹽 0 / 甲半亦帶標記(不因假值而漏)
            assert.equal(a.status, 2, a.out.slice(0, 400))
            assert.equal(b.status, 2, b.out.slice(0, 400))
            assert.equal(z.status, 2, z.out.slice(0, 400))
            assert(a.o && a.o.ok === false && a.o.code === 'PICK_SCAN' && !('member' in a.o))
            assert.deepEqual(b.o.member, { tag: '0x5bd1e995:1', salt: SALT, half: 1 })
            assert.deepEqual(z.o.member, { tag: '0x0:0', salt: 0, half: 0 })
            let log = logOf(root)
            assert.deepEqual(log.map((x) => [x.ok, x.code, x.member]), [[false, 'PICK_SCAN', undefined], [false, 'PICK_SCAN', '0x5bd1e995:1'], [false, 'PICK_SCAN', '0x0:0']])
        })

        it('挑選模組頂層改內建物件(完整性錯誤、離開碼 3):評估紀錄之列與失敗之結果檔亦帶 member;未給 --member 者無', () => {
            let root = mkProject('cliInteg')
            fs.writeFileSync(path.join(root, 'rsi', 'work', 'w1', 'pick_integ.mjs'), 'Math.trunc = Math.floor\nexport default function pick(ctx) { return [] }\n', 'utf8')
            let a = run(root, [], 'pick_integ.mjs')
            let b = run(root, ['--member', '7:0'], 'pick_integ.mjs')
            assert.equal(a.status, 3, a.out.slice(0, 400))
            assert.equal(b.status, 3, b.out.slice(0, 400))
            assert(a.o && a.o.code === 'EVAL_INTEGRITY' && !('member' in a.o))
            assert.deepEqual(b.o.member, { tag: '0x7:0', salt: 7, half: 0 })
            assert.deepEqual(logOf(root).map((x) => [x.code, x.member]), [['EVAL_INTEGRITY', undefined], ['EVAL_INTEGRITY', '0x7:0']])
        })

        it('--member 之格式不合:不評估、離開碼 2、不寫結果檔、不記評估紀錄(不靜默改用全庫);訊息固定、不帶輸入值;旗標重複給者亦拒(argOf 只取第一個,其餘會被靜默忽略)', () => {
            let root = mkProject('cliBad')
            for (let [what, args] of [['重複(後者合格)', ['--member', '0:0', '--member', '0:1']], ['重複(前者為乙半)', ['--member', '0:1', '--member', '0:0']], ['重複(後者不合)', ['--member', '0:0', '--member', 'secret-token-xyz']]]) {
                let r = run(root, args)
                assert.equal(r.status, 2, `${what}: ${r.out.slice(0, 300)}`)
                assert(/invalid --member: must be <salt>:<half>/.test(r.out) && !r.out.includes('secret-token-xyz'), what)
                assert.equal(r.o, null, `${what}: 不寫結果檔`)
            }
            for (let v of ['5', '0x5bd1e995', '0x5bd1e995:2', 'abc:0', '4294967296:0', '0x1ffffffff:0', '0x100000000:0', `0x${'f'.repeat(400)}:0`, `${'9'.repeat(400)}:0`, '+5:0', '0x5bd1e995g:0', '-1:0', '1:0:1', '0x:0', '0xzz:1', '1.5:0', ':0', '12345:', ' 12:0', '9999999999999999999999:0', 'secret-token-xyz:0']) {
                let r = run(root, ['--member', v])
                assert.equal(r.status, 2, `${v}: ${r.out.slice(0, 300)}`)
                assert(/invalid --member: must be <salt>:<half>/.test(r.out), v)
                assert(!r.out.includes('secret-token-xyz'), '不回顯輸入值')
                assert.equal(r.o, null, `${v}: 不寫結果檔`)
            }
            //只給旗標而無值
            let r = run(root, ['--member'])
            assert.equal(r.status, 2, r.out.slice(0, 300))
            assert.equal(r.o, null)
            assert(!fs.existsSync(path.join(root, 'rsi', 'work', 'w1', '.evals.log')), '未評估者不記評估紀錄')
        })

        it('鹽之邊界:0、4294967295(十進位與十六進位)皆可;十六進位大小寫之位數皆收', () => {
            let root = mkProject('cliEdge')
            //位數不另限(前導零無妨; 以數值 ≤ 4294967295 為界)
            for (let v of ['0:0', '0x0:1', '4294967295:0', '0xffffffff:1', '0xFFFFFFFF:0', '0x00000001:1', '00000000000:0', '0x000000000:1', `${'0'.repeat(30)}7:1`, `${'0'.repeat(60)}7:1`, `0x${'0'.repeat(60)}7:1`]) {
                let r = run(root, ['--member', v], 'pick.mjs')
                assert.equal(r.status, 0, `${v}: ${r.out.slice(0, 300)}`)
                let [saltS, halfS] = v.split(':')
                let salt = saltS.startsWith('0x') ? parseInt(saltS.slice(2), 16) : Number(saltS)
                assert.equal(r.o.member.salt, salt, v)
                assert.equal(r.o.member.half, Number(halfS), v)
                assert.equal(r.o.member.tag, `0x${salt.toString(16)}:${halfS}`, v)
            }
        })
    })
})

describe('memberLedger 之 JSDoc @example 可實跑(R-PKG-7;排程第 500 項)', function () {
    let t
    before(() => {
        t = makeTmp('memberLedgerDoc')
        writeSynthLedger(path.join(t.dir, 'eval'), { n: 60, nBars: 2400, seed: 7 })
    })
    after(() => {
        t.cleanup()
    })

    it('取出 src/eval/ledger.mjs 內 memberLedger 之 @example 之程式碼, 於合成之設定與帳本上執行:不拋錯, 印出之半庫策略數 + 另一半 = 全庫、所取之半 = 0', () => {
        let src = fs.readFileSync(path.join(FD_ROOT, 'src', 'eval', 'ledger.mjs'), 'utf8')
        let m = /\/\*\*((?:(?!\*\/)[\s\S])*?)\*\/\s*let memberLedger = /.exec(src)
        assert(m, '找得到 memberLedger 之 JSDoc')
        let parts = m[1].split(/@example[ \t]*\r?\n/)
        assert.equal(parts.length, 2, 'JSDoc 恰有一個 @example')
        let code = parts[1].split(/\r?\n/).map((l) => l.replace(/^\s*\*[ ]?/, '')).join('\n')
        assert(/memberLedger\(L, /.test(code) && /ntStaticOf\(La, trainEndBar\)/.test(code) && /makeEvaluator\(La, /.test(code), `範例含完整流程: ${code}`)
        let logs = []
        let st = { eval: { ledgerDir: path.join(t.dir, 'eval') }, periods: { train: { end: '2023-01-17T00:00:00' } } }
        //範例以 getSettings、loadLedger、memberLedger、ntStaticOf、makeEvaluator 為自由變數(聚合入口或各模組之匯出); 其中 makeEvaluator 為評估器之原函數(範例之 La 已由 ntStaticOf 給 ntStatic)
        // eslint-disable-next-line no-new-func
        let run = new Function('getSettings', 'loadLedger', 'memberLedger', 'ntStaticOf', 'makeEvaluator', 'console', code)
        run(() => st, loadLedger, memberLedger, ntStaticOf, makeEvaluatorRaw, { log: (...a) => logs.push(a) })
        assert.equal(logs.length, 1, JSON.stringify(logs))
        let L = loadLedger(path.join(t.dir, 'eval'))
        let other = memberLedger(L, 0x5bd1e995, 1)
        assert.equal(logs[0][1], 0)
        assert.equal(logs[0][0] + other.n, L.n, '範例印出之半庫策略數與另一半互補')
        assert(logs[0][0] > 0 && logs[0][0] < L.n)
    })

    it('聚合入口 src/WTradeAdaptivess.mjs 之 JSDoc @example(評估器單獨使用 + 成員重抽)可實跑:取出範例程式碼(去掉說明行與 import)於合成之設定與帳本上執行, 印出兩列(評估結果之均與選集指紋、半庫之策略數與所取之半)', () => {
        let src = fs.readFileSync(path.join(FD_ROOT, 'src', 'WTradeAdaptivess.mjs'), 'utf8')
        let m = /\/\*\*((?:(?!\*\/)[\s\S])*?)\*\/\s*let WTradeAdaptivess = /.exec(src)
        assert(m, '找得到聚合入口之 JSDoc')
        let parts = m[1].split(/@example[ \t]*\r?\n/)
        assert.equal(parts.length, 2, 'JSDoc 恰有一個 @example')
        let code = parts[1].split(/\r?\n/).map((l) => l.replace(/^\s*\*[ ]?/, '')).filter((l) => l !== 'need test in nodejs.' && !/^import /.test(l)).join('\n')
        assert(/WTradeAdaptivess\.memberLedger\(L, /.test(code) && /WTradeAdaptivess\.ntStaticOf\(La, trainEndBar\)/.test(code), `範例含成員重抽之流程: ${code}`)
        let logs = []
        let st = { eval: { ledgerDir: path.join(t.dir, 'eval') }, periods: { train: { end: '2023-01-17T00:00:00' } } }
        //範例之 WTradeAdaptivess 為聚合物件; getSettings 換成回合成之設定(真實者讀專案根之 settings.json)
        let W = { ...WTradeAdaptivess, getSettings: () => st }
        // eslint-disable-next-line no-new-func
        let run = new Function('WTradeAdaptivess', 'console', code)
        run(W, { log: (...a) => logs.push(a) })
        assert.equal(logs.length, 2, JSON.stringify(logs))
        assert.equal(logs[0].length, 2)
        assert(Number.isFinite(logs[0][0]) && typeof logs[0][1] === 'string', JSON.stringify(logs[0]))
        let L = loadLedger(path.join(t.dir, 'eval'))
        assert.equal(logs[1][1], 0)
        assert.equal(logs[1][0], memberLedger(L, 0x5bd1e995, 0).n)
    })
})
