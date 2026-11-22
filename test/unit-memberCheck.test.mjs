import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { pathToFileURL } from 'url'
import { getSettings } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { makeTexts, FILL_BACKLOG_ON, FILL_BACKLOG_OFF } from '../src/domain/texts.mjs'
import { specHash } from '../src/engineApi.mjs'
import * as FP from '../src/domain/fillPlan.mjs'
import * as FK from '../src/domain/fillKeys.mjs'
import * as VM from '../src/domain/verifyMember.mjs'
import { makeTmp, writeSynthLedger, FD_ROOT } from './tools/synthLedger.mjs'


//成員穩健性之附算與「成員依賴」之提示(規則 R-REC-51)
//  規格: ①設定 settings.rsi.memberCheck(false 或 salts 為空陣列 = 關閉; 鍵不合者用預設、不拋錯; nullDraws 未給 = settings.eval.replicaNullDraws, 再無 = 32)
//    ②合格 = 未被否決、評估期之階梯(trainLadder, 無則 ladder)≥ minLadder、工作夾有成品檔; 每個合格之成品以 K = 2 × 鹽數之半庫各一次完整評估(--member <鹽>:<半>、--null <抽數>、--ext-only nullRecentAct、--no-log)
//    ③內容之種類同搜尋地圖之挑選內容(正本之選集極活躍且有近期活躍度版之值 ⇒ 近期版, 否則內建); 保持率 = 半庫之值 ÷ 正本(單抽)之值; 正本之值 ≤ 0 或無值 ⇒ 不適用、整條不判
//    ④提示 = 保持率之中位 < minRetention 或相位平均為負之半庫數 > maxNegHalves(恰為門檻者不命中); 字樣不列門檻之值; 只提示、不否決(不改 S、階梯、選集指紋)
//    ⑤時點: 輪末之派做夢之前(本輪之節點 + 待重審者; 求解窗後段一併移到此處); 擴充診斷、重做者、待重試者與一併處理待補算仍在做夢之後; 同一項每輪至多一次
//    ⑥寫入: 補算檔之 member、節點文件之 harness.member 與迴圈判讀之一列、樹之 raw.member、迴圈檢查之提示; 看板一欄、搜尋地圖之註記、共同儲存區之 member —— 皆有值才出現
//  接縫: 真之樹、節點文件、補算檔、共同儲存區與輪末鉤子(含 arsi.runDream); 「評估之執行本身」以替身(runEval)代之, 另有一案不用替身(子行程之評估入口)
describe('成員穩健性之附算與「成員依賴」之提示(規則 R-REC-51)', function () {
    this.timeout(240000)
    let t
    beforeEach(() => {
        t = makeTmp('memberCheck')
    })
    afterEach(() => {
        t.cleanup()
    })
    let argOfA = (args, k) => {
        let i = args.indexOf(k); return i >= 0 ? args[i + 1] : null
    }
    let TAGS = ['0x5bd1e995:0', '0x5bd1e995:1', '0x2545f491:0', '0x2545f491:1', '0x9e3779b9:0', '0x9e3779b9:1']
    let SALTS_HEX = ['0x5bd1e995', '0x2545f491', '0x9e3779b9']

    describe('純函數', function () {
        it('memberCheckOf:false 與 salts 為空陣列 = 關閉;預設之鹽、抽數(replicaNullDraws → 32)與門檻;不合之鍵用預設、不拋錯;鹽去重、數字字串轉型', () => {
            //規格①
            assert.strictEqual(VM.memberCheckOf(false), null)
            assert.strictEqual(VM.memberCheckOf({ salts: [] }), null)
            let def = { salts: [0x5bd1e995, 0x2545f491, 0x9e3779b9], nullDraws: 32, minLadder: 1, minRetention: 0.5, maxNegHalves: 0 }
            for (let v of [undefined, null, true, 0, 'x', [1, 2], {}]) {
                assert.deepEqual(VM.memberCheckOf(v, {}), def, JSON.stringify(v))
            }
            assert.deepEqual(VM.memberCheckOf(undefined, { replicaNullDraws: 16 }).nullDraws, 16, 'nullDraws 未給 ⇒ replicaNullDraws')
            //settings.eval.replicaNullDraws 與迴圈之重放同一個取值函數(排程第 595 項; R-EV-44 ④之二): 未給(含 null)= 32、0(不算虛無)不採用 ⇒ 32、數字字串轉為數值、給了而無效(負數、小數、非數字、布林)拋 invalid eval.replicaNullDraws
            for (let rd of [0, '0', null, undefined]) {
                assert.equal(VM.memberCheckOf(undefined, { replicaNullDraws: rd }).nullDraws, 32, `replicaNullDraws ${rd} ⇒ 32`)
            }
            assert.equal(VM.memberCheckOf(undefined, { replicaNullDraws: '16' }).nullDraws, 16, 'replicaNullDraws 數字字串')
            for (let rd of [-3, 1.5, 'x', '', true, false, NaN, Infinity, [16], {}]) {
                assert.throws(() => VM.memberCheckOf(undefined, { replicaNullDraws: rd }), (err) => err.message === 'invalid eval.replicaNullDraws: must be a non-negative integer', `replicaNullDraws ${String(rd)} 無效 ⇒ 拋`)
            }
            assert.equal(VM.memberCheckOf({ nullDraws: 12 }, { replicaNullDraws: 16 }).nullDraws, 12, 'nullDraws 優先')
            assert.equal(VM.memberCheckOf({ nullDraws: '12' }, {}).nullDraws, 12, '數字字串')
            assert.equal(VM.memberCheckOf({ nullDraws: 0 }, { replicaNullDraws: 16 }).nullDraws, 16, '0 不合 ⇒ 下一順位')
            //鹽: 合格者取之(去重、保序); 任一不合 ⇒ 預設
            assert.deepEqual(VM.memberCheckOf({ salts: [7, '9', 7, 0] }).salts, [7, 9, 0])
            for (let s of [[1, 'x'], [1, -1], [0x100000000], [1.5], 'abc', 5]) {
                assert.deepEqual(VM.memberCheckOf({ salts: s }).salts, def.salts, JSON.stringify(s))
            }
            //門檻
            assert.deepEqual(VM.memberCheckOf({ minLadder: 2, minRetention: 0.37, maxNegHalves: 1 }), { ...def, minLadder: 2, minRetention: 0.37, maxNegHalves: 1 })
            assert.deepEqual(VM.memberCheckOf({ minLadder: -1, minRetention: 'abc', maxNegHalves: 1.5 }), def, '不合之值用預設')
            assert.deepEqual(VM.memberCheckOf({ minRetention: NaN }), def)
            //實數鍵收數字字串(跨套件規格〈輸入參數之檢測機制〉K1、K4、K7): '0.4' 與 0.4、' 0.4 '、'4e-1' 之結果相同且為數值(其後只用轉換值); 負數與 0 為有限數值亦收
            let r4 = VM.memberCheckOf({ minRetention: 0.4 })
            assert.deepEqual(r4, { ...def, minRetention: 0.4 })
            for (let v of ['0.4', ' 0.4 ', '4e-1', '+0.4', '.4']) {
                assert.deepEqual(VM.memberCheckOf({ minRetention: v }), r4, JSON.stringify(v))
                assert.strictEqual(typeof VM.memberCheckOf({ minRetention: v }).minRetention, 'number', `${JSON.stringify(v)} 轉為數值`)
            }
            assert.equal(VM.memberCheckOf({ minRetention: '-0.2' }).minRetention, -0.2)
            assert.equal(VM.memberCheckOf({ minRetention: 0 }).minRetention, 0)
            assert.equal(VM.memberCheckOf({ minRetention: '0' }).minRetention, 0)
            //布林、NaN、±Infinity、空字串與純空白、非數字字串(含十六進位、千分位)、BigInt、null、物件、陣列、包裝物件 ⇒ 預設(不當 0 或 1、不拋錯)
            for (let v of ['abc', true, false, '', '   ', NaN, Infinity, -Infinity, 'Infinity', 'NaN', '0x10', '1,5', 10n, null, undefined, {}, [], [0.4], Object(0.4), '1e400', '1e-400']) {
                assert.equal(VM.memberCheckOf({ minRetention: v }).minRetention, 0.5, `${typeof v}: ${String(v)} ⇒ 預設`)
            }
            //整數鍵之數字字串(原已收): 轉為數值
            assert.deepEqual(VM.memberCheckOf({ minLadder: '2', maxNegHalves: ' 1 ', nullDraws: '8' }, {}), { ...def, minLadder: 2, maxNegHalves: 1, nullDraws: 8 })
            //讀數之使用: 提示之判定用轉換值(中位 0.55: 門檻 '0.6' ⇒ 命中、門檻預設 0.5 ⇒ 不命中)
            let rowOf = (md) => ({ K: 6, kind: 'builtin', applicable: true, retention: { median: md, min: md, n: 6 }, nNeg: 0 })
            assert.notStrictEqual(VM.memberHintOf(rowOf(0.55), VM.memberCheckOf({ minRetention: '0.6' })), null)
            assert.strictEqual(VM.memberHintOf(rowOf(0.55), VM.memberCheckOf({})), null)
            assert.strictEqual(VM.memberHintOf(rowOf(0.6), VM.memberCheckOf({ minRetention: '0.6' })), null, '恰為門檻者不命中')
            assert.equal(VM.memberCheckOf({ minLadder: 0 }).minLadder, 0, '0 合格')
            //鍵之成分與標記
            assert.equal(VM.memberSigOf({ salts: [1, 255], nullDraws: 32 }), '0x1,0xff|n32')
            assert.equal(VM.memberSigOf(def), '0x5bd1e995,0x2545f491,0x9e3779b9|n32')
            assert.deepEqual(VM.memberTagsOf(def), TAGS)
            //合格: 未被否決、trainLadder(無則 ladder)≥ minLadder
            let el = (score, cfg = def) => VM.memberEligibleOf({ score }, cfg)
            assert.equal(el({ S: 1, ladder: 1, flags: { vetoed: false } }), true)
            assert.equal(el({ S: 1, ladder: 0, flags: { vetoed: false } }), false)
            assert.equal(el({ S: 1, ladder: 3, flags: { vetoed: true } }), false, '被否決')
            assert.equal(el({ S: 1, ladder: 0, flags: { vetoed: false, trainLadder: 1 } }), true, 'trainLadder 優先')
            assert.equal(el({ S: 1, ladder: 3, flags: { vetoed: false, trainLadder: 0 } }), false, 'trainLadder 優先(反向)')
            assert.equal(el({ S: 1, ladder: 0, flags: {} }, { ...def, minLadder: 0 }), true)
            assert.equal(el({ S: 1, ladder: 2 }, null), false, '關閉')
            assert.equal(VM.memberEligibleOf({}, def), false, '無分數')
        })

        it('memberRowOf:保持率與獨立之算式相同;內容之種類(近期版 / 內建)、半庫缺值、正本之值 ≤ 0 ⇒ 不適用;中位之奇偶、最小、負之半庫數(恰為 0 不計)', () => {
            //規格③; 合成之各欄逐半相異(超額、近期版、相位平均、策略數)
            let cfg = VM.memberCheckOf(undefined, {})
            let halfOf = (ex, rc, eq) => ex.map((e, j) => ({ tag: TAGS[j], n: 40 + j * 3, metrics: { op: { eqYr: { mean: eq[j] } }, nullSideAct: { excess: e, p: 0.01 + j / 100 }, ...(rc[j] === null ? {} : { ext: { nullRecentAct: { side: { excess: rc[j], p: 0.02 } } } }) } }))
            let med = (xs) => {
                let s = xs.slice().sort((a, b) => a - b); let k = s.length; return k ? (k % 2 ? s[(k - 1) / 2] : (s[k / 2 - 1] + s[k / 2]) / 2) : null
            }
            //內建: 正本不活躍(每隻訊號數 1.1 倍)⇒ 內建之組成對照之超額
            let canonB = { sel: { sigPerPick: 1.1 }, null: { sigPerPick: 1 }, nullSideAct: { excess: 10 }, ext: { nullRecentAct: { side: { excess: 99, p: 0.01 } } } }
            let ex = [4, 3, 6, 2, 7, 5]
            let rc = [11, 12.5, 13, 14.5, 15, 16.5]
            let eq = [2.1, -1.3, 0.4, 0, -1.7, 0.9]
            let r = VM.memberRowOf(canonB, halfOf(ex, rc, eq), cfg)
            let rets = ex.map((v) => v / 10)
            assert.deepEqual(r, {
                K: 6,
                salts: SALTS_HEX,
                nullDraws: 32,
                kind: 'builtin',
                full: 10,
                applicable: true,
                halves: ex.map((v, j) => ({ tag: TAGS[j], n: 40 + j * 3, eqYrMean: eq[j], excess: v, recent: rc[j], retention: v / 10 })),
                retention: { median: med(rets), min: Math.min(...rets), n: 6 },
                nNeg: 2,
            })
            //鑑別之前提: 兩種種類之保持率不同(誤用近期版者可被看出)
            assert.notEqual(med(rc.map((v) => v / 99)), r.retention.median)
            //近期版: 正本極活躍(每隻訊號數 ≥ 2 倍)且有近期版之值 ⇒ 近期版; 半庫缺近期版者其保持率為 null、不入中位與最小; 奇數個
            let canonR = { sel: { sigPerPick: 2.5 }, null: { sigPerPick: 1 }, nullSideAct: { excess: 9 }, ext: { nullRecentAct: { side: { excess: 7.5, p: 0.01 } } } }
            let rc2 = [7, 6.9, null, 7.7, 6.6, 7.2]
            let r2 = VM.memberRowOf(canonR, halfOf([1, 2, 3, 4, 5, 6], rc2, [5.1, 4.2, 3.3, 6.4, 2.5, 4.6]), cfg)
            let rets2 = rc2.filter((v) => v !== null).map((v) => v / 7.5)
            assert.equal(r2.kind, 'recent')
            assert.equal(r2.full, 7.5)
            assert.deepEqual(r2.halves.map((h) => h.retention), rc2.map((v) => (v === null ? null : v / 7.5)))
            assert.deepEqual(r2.retention, { median: med(rets2), min: Math.min(...rets2), n: 5 })
            assert.equal(r2.retention.median, rets2.slice().sort((a, b) => a - b)[2], '奇數個 ⇒ 中間一個')
            assert.deepEqual(r2.halves.map((h) => h.excess), [1, 2, 3, 4, 5, 6], '內建之超額照列')
            assert.equal(r2.nNeg, 0)
            //極活躍而正本無近期版之值 ⇒ 內建
            assert.equal(VM.memberRowOf({ ...canonR, ext: {} }, halfOf(ex, rc, eq), cfg).kind, 'builtin')
            //正本之值 ≤ 0、非有限或缺 ⇒ 不適用(保持率皆 null), 負之半庫數照算
            for (let full of [0, -2, null]) {
                let c = { ...canonB, nullSideAct: full === null ? undefined : { excess: full } }
                let rz = VM.memberRowOf(c, halfOf(ex, rc, eq), cfg)
                assert.equal(rz.applicable, false, String(full))
                assert.deepEqual(rz.retention, { median: null, min: null, n: 0 })
                assert.equal(rz.nNeg, 2)
                assert.strictEqual(VM.memberHintOf(rz, cfg), null, '不適用 ⇒ 整條不判(負之半庫數超過上限亦然)')
            }
            //樹上之讀數: 所記之選集指紋 = 正本才現行
            assert.deepEqual(VM.memberRowOfTree({ raw: { metrics: { selHash: 's1' }, member: { at: 'a', row: r, selHash: 's1' } } }), r)
            assert.strictEqual(VM.memberRowOfTree({ raw: { metrics: { selHash: 's2' }, member: { at: 'a', row: r, selHash: 's1' } } }), null)
            assert.strictEqual(VM.memberRowOfTree({ raw: { metrics: { selHash: 's1' } } }), null)
        })

        it('memberHintOf:中位 < 門檻或負之半庫數 > 上限才命中(恰為門檻者不命中);字樣之字面值、不列門檻之值;關閉者 null', () => {
            //規格④
            let rowOf = (median, min, nNeg, K = 6) => ({ K, applicable: true, retention: { median, min, n: K }, nNeg })
            let cfg = { ...VM.memberCheckOf(undefined, {}), minRetention: 0.37, maxNegHalves: 1 }
            assert.strictEqual(VM.memberHintOf(rowOf(0.37, 0.1, 1), cfg), null, '中位恰為門檻、負數恰為上限')
            let h1 = VM.memberHintOf(rowOf(0.3699, 0.12, 0), cfg)
            assert.equal(h1, '提示(成員依賴): 隨機半庫 6 個(3 種切法 × 兩半)之內容保持率 中位 0.37、最小 0.12;相位平均為負之半庫 0 個 ⇒ 內容可能依賴特定成員;以子庫(--subset)核對其成立之範圍(不否決,由審計判定)')
            let h2 = VM.memberHintOf(rowOf(0.9, 0.8, 2, 4), cfg)
            assert.equal(h2, '提示(成員依賴): 隨機半庫 4 個(2 種切法 × 兩半)之內容保持率 中位 0.90、最小 0.80;相位平均為負之半庫 2 個 ⇒ 內容可能依賴特定成員;以子庫(--subset)核對其成立之範圍(不否決,由審計判定)')
            assert(VM.isMemberHint(h1) && !VM.isMemberHint('提示(側別曝險): x'))
            assert(!h2.includes('0.37') && !h2.includes('上限'), '不列門檻之值')
            //中位 null(皆缺值)而負數未超過 ⇒ 不命中; 中位 null 而負數超過 ⇒ 命中(中位寫「—」)
            assert.strictEqual(VM.memberHintOf({ K: 6, applicable: true, retention: { median: null, min: null, n: 0 }, nNeg: 1 }, cfg), null)
            assert(VM.memberHintOf({ K: 6, applicable: true, retention: { median: null, min: null, n: 0 }, nNeg: 2 }, cfg).includes('中位 —、最小 —'))
            assert.strictEqual(VM.memberHintOf(rowOf(0.1, 0.1, 5), null), null, '關閉')
            assert.strictEqual(VM.memberHintOf(null, cfg), null)
        })

        it('planFill 之 member:合格者之鍵、須算 / 現行、鍵之各成分改變即重算、正本之選集指紋;未給者無此項;強制;fillSigSrcOf、sameKey、fillDocOf、memberOfFill、memberInfoOf、memberLineOf、fillLinesOf', () => {
            //規格②⑥
            let sig = '0x1,0x2|n32'
            let row = { K: 4, salts: ['0x1', '0x2'], nullDraws: 32, kind: 'builtin', full: 8, applicable: true, halves: [{ tag: '0x1:0', n: 41, eqYrMean: 1.25, excess: 6, recent: null, retention: 0.75 }, { tag: '0x1:1', n: 39, eqYrMean: -0.5, excess: 2, recent: 3.5, retention: 0.25 }, { tag: '0x2:0', n: 42, eqYrMean: 2.5, excess: 4, recent: null, retention: 0.5 }, { tag: '0x2:1', n: 38, eqYrMean: 0, excess: 10, recent: null, retention: 1.25 }], retention: { median: 0.625, min: 0.25, n: 4 }, nNeg: 1 }
            let fillOf = (key, canonSel) => ({ schema: FP.FILL_SCHEMA, nodeId: 'a1', postfit: { key: { pick: 'pa', evaluator: 'e' }, at: 't0', row: { x: 1 } }, ext: {}, member: { key, at: 't1', row, canon: { selHash: canonSel, at: 'c0' } } })
            let base = { id: 'a1', pickHash: 'pa', evaluatedAt: null, extNames: [], selHash: 'sA' }
            let nodes = [{ ...base, fill: fillOf({ pick: 'pa', evaluator: 'e', member: sig }, 'sA') }, { id: 'b2', pickHash: 'pb', evaluatedAt: null, extNames: [], selHash: 'sB', fill: null }, { id: 'c3', pickHash: 'pc', evaluatedAt: null, extNames: [], selHash: 'sC', fill: null }]
            let P0 = (over = {}) => FP.planFill({ nodes, evaluator: 'e', now: '2026-01-01T00:00:00Z', postfit: false, ext: false, member: { sig, eligible: ['a1', 'b2'] }, ...over })
            //a1 現行、b2 須算、c3 不合格(不計畫)
            let p = P0()
            assert.deepEqual(p.tasks, [{ nodeId: 'b2', postfit: false, ext: [], keys: { postfit: null, ext: {}, member: { pick: 'pb', evaluator: 'e', member: sig } }, member: true }])
            assert.equal(p.nCurrent, 2)
            assert.equal('member' in p.backlog, false, '無待補算者不帶')
            //targets 以外 ⇒ 待補算之 member
            assert.deepEqual(P0({ targets: ['a1'] }).backlog, { postfit: [], ext: {}, member: ['b2'] })
            //鍵之各成分: 鹽 / 抽數、評估器、成品、正本之選集指紋 ⇒ a1 須算
            assert.equal(P0({ member: { sig: '0x1|n32', eligible: ['a1'] } }).tasks.length, 1)
            assert.equal(P0({ evaluator: 'e2' }).tasks.filter((x) => x.nodeId === 'a1').length, 1)
            assert.equal(FP.planFill({ nodes: [{ ...nodes[0], pickHash: 'pa2' }], evaluator: 'e', now: 'n', postfit: false, ext: false, member: { sig, eligible: ['a1'] } }).tasks.length, 1)
            assert.equal(FP.planFill({ nodes: [{ ...nodes[0], selHash: 'sA2' }], evaluator: 'e', now: 'n', postfit: false, ext: false, member: { sig, eligible: ['a1'] } }).tasks.length, 1, '正本之選集指紋不同 ⇒ 重算')
            //未給 / null ⇒ 無此項(任務、待補算與 member: null 者相同)
            let pn = FP.planFill({ nodes, evaluator: 'e', now: 'n', targets: ['a1'] })
            assert.deepEqual(FP.planFill({ nodes, evaluator: 'e', now: 'n', targets: ['a1'], member: null }), pn)
            assert(pn.tasks.every((x) => !('member' in x) && !('member' in x.keys)) && !('member' in pn.backlog))
            assert.throws(() => FP.planFill({ nodes, evaluator: 'e', now: 'n', member: { sig: '' } }), /invalid opt.member: must be null or \{ sig, eligible \}/)
            //強制: force 與 forced.member ⇒ 現行者亦算, forced 帶 member
            let pf = P0({ force: true, targets: ['a1'] })
            assert.deepEqual(pf.tasks.map((x) => [x.nodeId, x.member, x.forced]), [['a1', true, { postfit: false, ext: [], member: true }]])
            assert.deepEqual(P0({ forced: { a1: { member: true } } }).tasks.find((x) => x.nodeId === 'a1').forced, { postfit: false, ext: [], member: true })
            //fillSigSrcOf: 帶 member 之鍵者另列; only.member false ⇒ 與不帶者相同
            let tk = p.tasks[0]
            assert.equal(FP.fillSigSrcOf(tk), `{"postfit":null,"ext":[],"member":["pb","e","${sig}"]}`)
            assert.equal(FP.fillSigSrcOf(tk, { postfit: false, ext: [], member: false }), '{"postfit":null,"ext":[]}')
            assert.equal(FP.fillSigSrcOf({ ...tk, keys: { postfit: null, ext: {} } }), '{"postfit":null,"ext":[]}')
            //sameKey 比 member
            assert.equal(FP.sameKey({ pick: 'p', evaluator: 'e', member: 'x' }, { pick: 'p', evaluator: 'e', member: 'y' }), false)
            assert.equal(FP.sameKey({ pick: 'p', evaluator: 'e' }, { pick: 'p', evaluator: 'e', member: null }), true)
            //fillDocOf: 本次有 member 者取代; 未給者沿用; 兩者皆無者不帶此鍵
            let d1 = FP.fillDocOf(null, { nodeId: 'a1', at: 'T', member: { key: { k: 1 }, row, canon: { selHash: 's', at: 'c' } } })
            assert.deepEqual(d1.member, { key: { k: 1 }, at: 'T', row, canon: { selHash: 's', at: 'c' } })
            assert.deepEqual(FP.fillDocOf(d1, { nodeId: 'a1', at: 'T2', postfit: { key: {}, row: { y: 2 } } }).member, d1.member, '沿用')
            assert.equal('member' in FP.fillDocOf(null, { nodeId: 'a1', at: 'T', postfit: { key: {}, row: {} } }), false)
            //memberOfFill / memberInfoOf
            let f = fillOf({ pick: 'pa', evaluator: 'e', member: sig }, 'sA')
            assert.deepEqual(FP.memberOfFill(f, { pick: 'pa', evaluator: 'e', member: sig }, 'sA'), { at: 't1', row, canon: { selHash: 'sA', at: 'c0' } })
            assert.strictEqual(FP.memberOfFill(f, { pick: 'pa', evaluator: 'e', member: sig }, 'sZ'), null)
            assert.deepEqual(FP.memberInfoOf(f, { pick: 'pa', evaluator: 'e' }, 'sA'), { ...row, at: 't1', current: true })
            assert.equal(FP.memberInfoOf(f, { pick: 'pa', evaluator: 'e2' }, 'sA').current, false)
            assert.strictEqual(FP.memberInfoOf(f, { pick: 'pz', evaluator: 'e' }, 'sA'), null, '成品已重做')
            //memberLineOf 之字面值(不列門檻)
            assert.equal(FP.memberLineOf(row), '成員穩健性(佐證;非正本):隨機半庫 4 個(2 種切法 × 兩半)之內容保持率 中位 0.63、最小 0.25(內建組成對照之超額;全庫之內容 +8.0);各半之相位平均 1.3 / -0.5 / 2.5 / 0.0(為負者 1 個);不入 S、階梯與看板之排序')
            assert.equal(FP.memberLineOf({ ...row, kind: 'recent', applicable: false, full: -2 }), '成員穩健性(佐證;非正本):隨機半庫 4 個(2 種切法 × 兩半)之內容保持率 不適用(全庫之內容 ≤ 0 或無值)(近期活躍度版之超額;全庫之內容 -2.0);各半之相位平均 1.3 / -0.5 / 2.5 / 0.0(為負者 1 個);不入 S、階梯與看板之排序')
            //fillLinesOf: 成員穩健性一列; 派做夢之前之一次; 待補算之 member
            let res = [{ nodeId: 'aaaaaaaa1', postfit: 'ok', ext: { ok: [], failed: [] }, member: 'ok', memberHit: true }, { nodeId: 'bbbbbbbb2', postfit: null, ext: { ok: [], failed: [] }, member: 'failed', kind: 'transient', error: '成員穩健性(0x1:1):離開碼 1' }, { nodeId: 'cccccccc3', postfit: 'ok', ext: { ok: [], failed: [] } }]
            assert.deepEqual(FP.fillLinesOf({ results: res, backlog: { postfit: [], ext: {}, member: ['x', 'y'] }, sec: 12.4, source: 'round' }), [
                '附算(求解窗後段與擴充診斷;佐證,不改 S):2 個成品;求解窗後段 成功 2;擴充診斷 補入 0 項;12 秒',
                '附算(成員穩健性;佐證,不改 S):2 個成品;成功 1、**失敗 1**;其中命中「提示(成員依賴)」1 個;失敗者(下一次輪末重試):bbbbbbbb(成員穩健性(0x1:1):離開碼 1)',
                '待補算之成品(不在本次之範圍;以 `node g_rsi.mjs --mode fill` 補齊,可中斷續跑):求解窗後段 0 個;成員穩健性 2 個',
            ])
            assert.deepEqual(FP.fillLinesOf({ results: res.slice(1, 2), backlog: { postfit: ['z'], ext: {} }, sec: 3, source: 'round', retryInfo: [{ id: 'q', source: 'cli' }] }, { stage: 'preDream' }), [
                '附算(派做夢之前;成員穩健性;佐證,不改 S):1 個成品;成功 0、**失敗 1**;其中命中「提示(成員依賴)」0 個;3 秒;失敗者(下一次輪末重試):bbbbbbbb(成員穩健性(0x1:1):離開碼 1)',
            ], '派做夢之前: 只有成員穩健性者另列秒數; 待補算與來源為命令列之待重試不列')
            assert.deepEqual(FP.fillLinesOf({ results: res.slice(2), backlog: { postfit: [], ext: {} }, sec: 3, source: 'round' }, { stage: 'preDream' }), ['附算(派做夢之前;求解窗後段;佐證,不改 S):1 個成品;求解窗後段 成功 1;3 秒'])
            //retryAt: 失敗者之重試時機之字樣可取代(輪末之派做夢之前之一次而做夢未交付者用); 未給或空字串 ⇒ 依 source; 兩列(求解窗後段與擴充診斷之列、成員穩健性之列)皆取代
            let resF = [{ nodeId: 'aaaaaaaa1', postfit: 'failed', ext: { ok: [], failed: [] }, kind: 'transient', error: '求解窗後段:離開碼 1' }, res[1]]
            let linesF = (o) => FP.fillLinesOf({ results: resF, backlog: { postfit: [], ext: {} }, sec: 3, source: 'round' }, { stage: 'preDream', ...o })
            assert(linesF({}).every((l) => l.includes('失敗者(下一次輪末重試):')), JSON.stringify(linesF({})))
            assert.deepEqual(linesF({ retryAt: '' }), linesF({}), '空字串 ⇒ 預設')
            assert.deepEqual(linesF({ retryAt: null }), linesF({}))
            assert.deepEqual(linesF({ retryAt: '甲乙' }), linesF({}).map((l) => l.replace('失敗者(下一次輪末重試):', '失敗者(甲乙):')))
            assert(linesF({ retryAt: '甲乙' }).length === 2 && linesF({ retryAt: '甲乙' }).every((l) => l.includes('失敗者(甲乙):')))
        })

        it('planFill 之 member 與近期活躍度版之診斷(nullRecentAct):讀數依該診斷者之鍵併其雜湊(診斷改寫 ⇒ 重算)、不依者不併;正本之診斷值非現行而本次不補者延後(列待補算)、補者同任務;診斷檔不存在者鍵之 diag 為 null', () => {
            //規格②⑥: 快取之鍵含讀數所依之值。依: 內容之種類為近期版者 ⇒ 全庫與各半之內容取該診斷之輸出; 內建者 ⇒ 取評估器內建之組成對照(評估器之指紋已在鍵內)
            //  種類隨正本有無近期版之值而定 ⇒ 選集之每隻訊號數為全體隨機之 2 倍以上者(種類可為近期版)視為依; 否則恆為內建、不依
            let sig = '0x1|n32'
            let row = { K: 2, salts: ['0x1'], nullDraws: 32, kind: 'recent', full: 8, applicable: true, halves: [], retention: { median: 0.6, min: 0.5, n: 2 }, nNeg: 0 }
            let RD = 'nullRecentAct'
            let NOW = '2026-06-01T00:00:00Z'
            //M: planFill 之 member 選項(recent 所列者之讀數依診斷 RD; diagName 由領域層給)
            let M = (eligible, recent) => ({ sig, eligible, recent, diagName: RD })
            let nodeOf = (id, over = {}) => ({ id, pickHash: `p${id}`, evaluatedAt: '2026-01-01T00:00:00Z', extNames: [RD], selHash: 's', fill: null, ...over })
            let fillWith = (nd, dep, diag) => ({ schema: FP.FILL_SCHEMA, nodeId: nd.id, postfit: null, ext: {}, member: { key: FP.memberKeyOf({ pick: nd.pickHash, evaluator: 'e', sig, dep, diag }), at: 't1', row, canon: { selHash: 's', at: 'c0' } } })
            //a1 = 依診斷者(recent 列之內)、b2 = 不依者; 各自之補算檔於診斷 H1 時算成
            let a1 = nodeOf('a1')
            let b2 = nodeOf('b2')
            let nodes = [{ ...a1, fill: fillWith(a1, true, 'H1') }, { ...b2, fill: fillWith(b2, false, 'H1') }]
            let plan = (over = {}) => FP.planFill({ nodes, diags: [{ name: RD, hash: 'H1' }], registry: { [RD]: { hash: 'H1', since: null } }, evaluator: 'e', now: NOW, postfit: false, ext: false, member: M(['a1', 'b2'], ['a1']), ...over })
            //①鍵: 依者帶診斷之雜湊、不依者不帶(未給 recent 者不帶)
            assert.deepEqual(FP.memberKeyOf({ pick: 'p', evaluator: 'e', sig, dep: true, diag: 'H1' }), { pick: 'p', evaluator: 'e', member: sig, diag: 'H1' })
            assert.deepEqual(FP.memberKeyOf({ pick: 'p', evaluator: 'e', sig, dep: true }), { pick: 'p', evaluator: 'e', member: sig, diag: null }, '診斷檔不存在 ⇒ null')
            assert.deepEqual(FP.memberKeyOf({ pick: 'p', evaluator: 'e', sig, dep: false, diag: 'H1' }), { pick: 'p', evaluator: 'e', member: sig }, '不依者不帶(即使給了雜湊)')
            //②診斷未改: 皆現行
            let p0 = plan()
            assert.deepEqual([p0.tasks, p0.nCurrent, 'member' in p0.backlog], [[], 2, false])
            //③診斷被改寫(H2)、兩節點之正本之診斷值皆現行(評估時刻不早於診斷之 since): 只有 a1 重算(b2 不依 ⇒ 不重算); 任務之鍵帶新雜湊
            let reg2 = { [RD]: { hash: 'H1', since: null } }
            let diag2 = [{ name: RD, hash: 'H2' }]
            let cur = nodes.map((x) => ({ ...x, evaluatedAt: '2026-09-01T00:00:00Z' }))
            let p3 = FP.planFill({ nodes: cur, diags: diag2, registry: reg2, evaluator: 'e', now: NOW, postfit: false, ext: false, member: M(['a1', 'b2'], ['a1']) })
            assert.deepEqual(p3.tasks.map((x) => [x.nodeId, x.member, x.keys.member.diag, x.ext]), [['a1', true, 'H2', []]], '只有依診斷者重算')
            assert.equal(p3.nCurrent, 1)
            assert.deepEqual(p3.registry[RD], { hash: 'H2', since: NOW })
            //  不給 recent(沿用前版之呼叫形): 鍵不帶 diag; 補算檔亦不帶者照舊現行
            let noRec = FP.planFill({ nodes: [{ ...b2, fill: fillWith(b2, false, 'H1') }], diags: diag2, registry: reg2, evaluator: 'e', now: NOW, postfit: false, ext: false, member: { sig, eligible: ['b2'] } })
            assert.deepEqual([noRec.tasks.length, noRec.nCurrent], [0, 1], 'b2 之鍵不帶 diag、與診斷之改寫無關')
            //④正本之診斷值非現行(評估時刻早於診斷之 since)而本次不補該診斷(ext false 或名單不含): a1 延後 —— 不計畫、列入待補算之 member、不計為現行; b2 現行
            let p4 = FP.planFill({ nodes, diags: diag2, registry: reg2, evaluator: 'e', now: NOW, postfit: false, ext: false, member: M(['a1', 'b2'], ['a1']) })
            assert.deepEqual([p4.tasks, p4.backlog.member, p4.nCurrent], [[], ['a1'], 1], '延後')
            let p4b = FP.planFill({ nodes, diags: [...diag2, { name: 'zz', hash: 'Z' }], registry: { ...reg2, zz: { hash: 'Z', since: null } }, evaluator: 'e', now: NOW, postfit: false, ext: ['zz'], member: M(['a1', 'b2'], ['a1']) })
            assert.deepEqual([p4b.tasks.map((x) => [x.nodeId, x.ext, x.member === true]), p4b.backlog.member], [[['a1', ['zz'], false], ['b2', ['zz'], false]], ['a1']], '名單不含該診斷(只補另一個診斷)⇒ 仍延後;任務只含他診斷')
            //  延後者另有他項(求解窗後段)時: 任務只含他項、member 不入任務、列入待補算
            let p4c = FP.planFill({ nodes: [{ ...a1, fill: fillWith(a1, true, 'H1') }], diags: diag2, registry: reg2, evaluator: 'e', now: NOW, postfit: true, ext: false, member: M(['a1'], ['a1']) })
            assert.deepEqual(p4c.tasks.map((x) => [x.nodeId, x.postfit, 'member' in x, 'member' in x.keys]), [['a1', true, false, false]])
            assert.deepEqual(p4c.backlog.member, ['a1'])
            //⑤本次補該診斷(ext true、名單含): 同任務(先補診斷、後算讀數): a1 之任務含該診斷與 member(鍵帶新雜湊); b2 只補該診斷(讀數不依)
            let p5 = FP.planFill({ nodes, diags: diag2, registry: reg2, evaluator: 'e', now: NOW, postfit: false, ext: true, member: M(['a1', 'b2'], ['a1']) })
            assert.deepEqual(p5.tasks.map((x) => [x.nodeId, x.ext, x.member === true, x.keys.member ? x.keys.member.diag : undefined]), [['a1', [RD], true, 'H2'], ['b2', [RD], false, undefined]])
            assert(!('member' in p5.backlog))
            //  ext 為名單且含該診斷者亦然
            let p5b = FP.planFill({ nodes, diags: diag2, registry: reg2, evaluator: 'e', now: NOW, postfit: false, ext: [RD], member: M(['a1'], ['a1']) })
            assert.deepEqual(p5b.tasks.map((x) => [x.nodeId, x.ext, x.member === true]), [['a1', [RD], true], ['b2', [RD], false]])
            //⑥targets 以外(待補算): 依者須算而非延後 ⇒ 列待補算(同前版); 延後者亦列(同一個列)
            let p6 = FP.planFill({ nodes: cur, diags: diag2, registry: reg2, evaluator: 'e', now: NOW, targets: ['b2'], postfit: false, ext: false, member: M(['a1', 'b2'], ['a1']) })
            assert.deepEqual([p6.tasks, p6.backlog.member], [[], ['a1']])
            assert.equal(p6.backlog.member.length, 1, '同一節點只列一次')
            //⑦診斷檔不存在: 鍵之 diag 為 null(補算檔以 null 算成者現行); 其後診斷出現(H1)⇒ 鍵不同 ⇒ 算(正本之診斷值現行 ⇒ 不延後)
            let nd0 = nodeOf('a1', { extNames: [] })
            let f0 = fillWith(nd0, true, null)
            let p7 = FP.planFill({ nodes: [{ ...nd0, fill: f0 }], diags: [], evaluator: 'e', now: NOW, postfit: false, ext: false, member: M(['a1'], ['a1']) })
            assert.deepEqual([p7.tasks, p7.nCurrent], [[], 1], '診斷檔不存在: 鍵之 diag 為 null、現行、不延後')
            let p7b = FP.planFill({ nodes: [{ ...nd0, extNames: [RD], fill: f0 }], diags: [{ name: RD, hash: 'H1' }], registry: null, evaluator: 'e', now: NOW, postfit: false, ext: false, member: M(['a1'], ['a1']) })
            assert.deepEqual(p7b.tasks.map((x) => [x.nodeId, x.keys.member.diag]), [['a1', 'H1']], '診斷出現 ⇒ 算')
            //  診斷檔不存在而節點之正本無該診斷之值(extNames 不含): 不延後(無診斷可補)
            let p7c = FP.planFill({ nodes: [{ ...nd0, fill: null }], diags: [], evaluator: 'e', now: NOW, postfit: false, ext: false, member: M(['a1'], ['a1']) })
            assert.deepEqual(p7c.tasks.map((x) => [x.nodeId, x.keys.member.diag]), [['a1', null]])
            //⑧不合格者不入 recent 之效果: recent 所列而不在 eligible 者不計畫
            let p8 = plan({ member: M(['b2'], ['a1']), diags: diag2 })
            assert.deepEqual([p8.tasks, p8.nCurrent, 'member' in p8.backlog], [[], 2, false], 'a1 不合格 ⇒ 不計畫、不延後、不列待補算;b2 不依診斷 ⇒ 現行')
            //選項之形: recent 非陣列、或給了 recent 而無 diagName ⇒ 拋錯(同 member 之其餘形狀不合者之訊息)
            for (let bad of [{ sig, eligible: [], recent: 'a1', diagName: RD }, { sig, eligible: [], recent: ['a1'] }, { sig, eligible: [], recent: ['a1'], diagName: '' }]) {
                assert.throws(() => FP.planFill({ nodes, evaluator: 'e', now: 'n', member: bad }), /invalid opt.member: must be null or \{ sig, eligible \}/, JSON.stringify(bad))
            }
            assert.doesNotThrow(() => FP.planFill({ nodes, evaluator: 'e', now: 'n', member: { sig, eligible: [] } }), '不給 recent 者可不給 diagName(前版之呼叫形)')
            //⑨待算之鍵之正規字串(fillSigSrcOf): 帶 diag 者另接其值 ⇒ 診斷改寫後(同一失敗)之正規字串不同 ⇒ 不被當成「重跑結果相同」; 不帶者逐字同前
            let tkA = FP.planFill({ nodes: cur, diags: diag2, registry: reg2, evaluator: 'e', now: NOW, postfit: false, ext: false, member: M(['a1'], ['a1']) }).tasks[0]
            assert.equal(FP.fillSigSrcOf(tkA), `{"postfit":null,"ext":[],"member":["pa1","e","${sig}","H2"]}`)
            assert.notEqual(FP.fillSigSrcOf(tkA), FP.fillSigSrcOf({ ...tkA, keys: { ...tkA.keys, member: { ...tkA.keys.member, diag: 'H3' } } }))
            assert.equal(FP.fillSigSrcOf({ ...tkA, keys: { ...tkA.keys, member: { pick: 'pa1', evaluator: 'e', member: sig } } }), `{"postfit":null,"ext":[],"member":["pa1","e","${sig}"]}`)
            //sameKey 比 diag(member 之鍵之 diag 亦比)
            assert.equal(FP.sameKey({ pick: 'p', evaluator: 'e', member: sig, diag: 'H1' }, { pick: 'p', evaluator: 'e', member: sig, diag: 'H2' }), false)
            assert.equal(FP.sameKey({ pick: 'p', evaluator: 'e', member: sig, diag: null }, { pick: 'p', evaluator: 'e', member: sig }), true, '缺鍵視同 null')
            //⑩依診斷之判準(memberRecentCapableOf): 選集之每隻訊號數 ≥ 全體隨機之 2 倍(恰為 2 倍亦是)、全體隨機之每隻訊號數 > 0; 缺值或非數值者否
            let cap = (sel, nul) => VM.memberRecentCapableOf({ raw: { metrics: { sel: sel === undefined ? undefined : { sigPerPick: sel }, null: nul === undefined ? undefined : { sigPerPick: nul } } } })
            assert.deepEqual([cap(2, 1), cap(1.99, 1), cap(2.01, 1), cap(5, 0), cap(5, -1), cap(undefined, 1), cap(2, undefined), cap('2', 1), cap(2, '1'), cap(NaN, 1)], [true, false, true, false, false, false, false, false, false, false])
            assert.equal(VM.memberRecentCapableOf(null), false)
            assert.equal(VM.memberRecentCapableOf({}), false)
            assert.equal(VM.memberRecentCapableOf({ raw: null }), false)
        })
    })

    //── 執行與輪末(替身 runEval) ──
    //  5 個節點: 0 = 合格(階梯 2;內建;命中)、1 = 不合格(階梯 0)、2 = 不合格(被否決)、3 = 合格(trainLadder 1;極活躍 ⇒ 近期版;不命中)、4 = 合格(階梯 1;正本之超額為負 ⇒ 不適用)
    let ARMS = [['A01_nt'], ['A01_nt', 'B14_pitKey'], ['B14_pitKey'], ['A02_ntPit'], ['A04_act']]
    let HALF = {
        0: { ex: [4, 3, 6, 2, 7, 5], rc: [11, 12.5, 13, 14.5, 15, 16.5], eq: [2.1, 1.3, 0.4, 3.2, 1.7, 0.9] },
        3: { ex: [1, 2, 3, 4, 5, 6], rc: [7, 6.9, 8.1, 7.7, 6.6, 7.2], eq: [5.1, 4.2, 3.3, 6.4, 2.5, 4.6] },
        4: { ex: [3, 1, 2, 4, -1, 0.5], rc: [null, null, null, null, null, null], eq: [-1.1, 0.7, -2.3, 1.9, -0.4, 0] },
    }
    let FULL = { 0: 10, 3: 7.5, 4: -2 }
    let pfOf = (k) => ({ ok: true, period: { name: 'postfit', start: '2025-04-08T04:00:00', end: '2025-10-06T00:00:00' }, score: null, metrics: { selHash: `pf-sel-${k}`, nullSideAct: { p: 0.01 + k / 100, z: 2 + k, excess: 10 + k }, afterFit: { seatsKept: 20 + k, seatsDropped: 5 + k, orders: 100 } } })
    //mk: 暫存夾之專案(工作夾有 pick.mjs 與 harness_full.json、樹有正本之數字、節點文件); rsiExtra 併入 settings.rsi; opt.failM(k, j) → 替身之失敗之回傳(無則成功)
    //  dreamFail.on = true 者做夢派工失敗(未交付; 可於測試途中切換)
    let mk = ({ rsiExtra = {}, failM = null, failPf = new Set(), diags = ['dA'], dreamFail = { on: false } } = {}) => {
        let st = getSettings()
        //每個專案各自一夾(同一案內組多個專案者互不共用狀態根)
        let d = path.join(t.dir, `proj_${Math.random().toString(36).slice(2, 8)}`)
        st.resources = {}
        st.rsi = { ...st.rsi, fillParallel: 1, fillBacklogSec: 0, docLimits: false, ...rsiExtra }
        st.rsi.root = path.join(d, 'rsi')
        st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(d, 'ledger')
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthM' }), 'utf8')
        fs.mkdirSync(path.join(st.records.toolboxDir, 'metrics'), { recursive: true })
        for (let nm of diags) {
            fs.writeFileSync(path.join(st.records.toolboxDir, 'metrics', `${nm}.mjs`), `export default { v: '${nm}' }\n`, 'utf8')
        }
        let calls = []
        let snap = null
        //做夢: 依範本全部採納; 派做夢時記下任務書與各節點文件、樹之當下(做夢之審計範圍所見之值)
        let dispatch = async (role, { prompt }) => {
            if (dreamFail.on) {
                return { ok: false, error: 'fake' }
            }
            let m = /請閱讀 (\S+)\/brief\.md/.exec(prompt)
            let wd = path.resolve(st.FD_ROOT, m[1])
            snap = { brief: fs.readFileSync(path.join(wd, 'brief.md'), 'utf8'), docs: Object.fromEntries(ids.map((id) => [id, JSON.parse(JSON.stringify(P.records.getNodeDoc(id)))])), tree: Object.fromEntries(ids.map((id) => [id, JSON.parse(JSON.stringify(P.rsi.store.getNode(id)))])), nCalls: calls.length }
            let tpl = JSON.parse(fs.readFileSync(path.join(wd, 'dream.template.json'), 'utf8'))
            fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify({ audits: tpl.audits.map((a) => ({ nodeId: a.nodeId, trust: 'trusted', action: 'accept', evidence: ['假審計'], issues: [] })), synthesis: { summary: '假', worked: [], failed: [], patterns: [], prevDirections: [] }, guidance: { directions: [], avoid: [], openQuestions: [], improvements: [], armProposals: [] }, expansion: [], docsUpdated: [] }), 'utf8')
            return { ok: true, agent: { kind: 'fake', model: 'fake-dream', effort: 'none' } }
        }
        let ids = []
        let runEval = async ({ nodeId, kind, args }) => {
            calls.push({ nodeId, kind, args: args.slice() })
            let k = ids.indexOf(nodeId)
            let out = argOfA(args, '--out')
            if (kind === 'postfit') {
                if (failPf.has(k)) {
                    return { code: 1, timeout: false }
                }
                fs.writeFileSync(out, JSON.stringify(pfOf(k)), 'utf8')
                return { code: 0, timeout: false }
            }
            if (kind === 'member') {
                let tag = argOfA(args, '--member')
                let j = TAGS.indexOf(tag)
                let fr = failM ? failM(k, j, out, tag) : null
                if (fr) {
                    return fr
                }
                let h = HALF[k]
                let [salt, half] = tag.split(':')
                fs.writeFileSync(out, JSON.stringify({ ok: true, member: { tag, salt: parseInt(salt.slice(2), 16), half: Number(half), n: 30 + k * 2 + j }, metrics: { selHash: `half-${k}-${j}`, op: { eqYr: { mean: h.eq[j] } }, nullSideAct: { excess: h.ex[j], p: 0.01 + j / 100 }, ...(h.rc[j] === null ? {} : { ext: { nullRecentAct: { side: { excess: h.rc[j], p: 0.03 } } } }) } }), 'utf8')
                return { code: 0, timeout: false }
            }
            let names = argOfA(args, '--ext-only').split(',')
            fs.writeFileSync(out, JSON.stringify({ ok: true, metrics: { selHash: `sel-${k}`, ext: Object.fromEntries(names.map((nm) => [nm, { board: `${nm}-${k}` }])) } }), 'utf8')
            return { code: 0, timeout: false }
        }
        let P = makeProject(st, { dispatch, gate: null, catalogFile: path.join(d, 'catalog.json'), runEval })
        P.rsi.init()
        for (let [k, arms] of ARMS.entries()) {
            let spec = { arms, base: null }
            let id = P.idOf(spec)
            ids.push(id)
            let wd = path.join(st.records.workDir, id)
            fs.mkdirSync(wd, { recursive: true })
            fs.writeFileSync(path.join(wd, 'pick.mjs'), `export const meta = { arms: ${JSON.stringify(arms)}, desc: '成品 ${k}' }\nexport default function pick(ctx) {\n    return [${k}]\n}\n`, 'utf8')
            fs.writeFileSync(path.join(wd, 'harness_full.json'), JSON.stringify({ ok: true, at: `2026-01-0${k + 1}T00:00:00.000Z`, metrics: { selHash: `sel-${k}` } }), 'utf8')
            let active = k === 3
            let metrics = { selHash: `sel-${k}`, ext: active ? { nullRecentAct: { side: { excess: 7.5, p: 0.02 } } } : {}, op: { eqYr: { mean: 12.5 + k, min: -1.5 - k, byPhase: [1, 2, 3, 4, 5, 6, 7].map((v) => v + k) }, monthlyOrders: { mean: 90 + k }, peakHold: { max: 30 - k }, winRate: 0.4 + k / 100 }, null: { mean: -2 - k, excess: 5 + k, z: 1 + k / 10, p: 0.01, sigPerPick: 1 }, nullSideAct: { excess: k === 4 ? -2 : (k === 0 ? 10 : 9 + k / 10), p: 0.01 + k / 1000, share: 0.3 + k / 100, mean: 3 + k, half: 50, triggered: true }, sel: { sigPerPick: active ? 2.5 : 1.1 + k / 100, longRatio: 0.5 + k / 100, sizeMax: 4, sizeMean: 3 + k / 10 } }
            let score = { S: 10 + k, ladder: [2, 0, 3, 0, 1][k], flags: { vetoed: k === 2, why: k === 2 ? ['合成之否決'] : [], ...(k === 3 ? { trainLadder: 1 } : {}) } }
            P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round: 1, raw: { metrics, issues: [] }, score, evidence: { trust: 'trusted' } })
            P.records.putNodeDoc({ nodeId: id, round: 1, attempt: 1, status: 'verified', spec, task: { goal: 'g', type: 'explore' }, plan: {}, code: {}, results: { claimed: {} }, conclusion: { outcome: 'improved', summary: `摘要 ${k}` }, harness: { ok: true, summary: [`既有之列 ${k}`], notes: [`既有之判讀 ${k}`], checks: { issues: [`既有之檢查 ${k}`] }, score, raw: { metrics } } })
        }
        return { P, st, ids, calls, runEval, snap: () => snap }
    }
    //expRowOf, 依替身之值獨立算出之讀數(不經 memberRowOf)
    let expRowOf = (k) => {
        let h = HALF[k]
        let kind = k === 3 ? 'recent' : 'builtin'
        let full = FULL[k]
        let app = full > 0
        let vals = kind === 'recent' ? h.rc : h.ex
        let rets = vals.map((v) => (app && v !== null ? v / full : null))
        let ok = rets.filter((v) => v !== null).sort((a, b) => a - b)
        let median = ok.length ? (ok.length % 2 ? ok[(ok.length - 1) / 2] : (ok[ok.length / 2 - 1] + ok[ok.length / 2]) / 2) : null
        return { K: 6, salts: SALTS_HEX, nullDraws: 32, kind, full, applicable: app, halves: TAGS.map((tag, j) => ({ tag, n: 30 + k * 2 + j, eqYrMean: h.eq[j], excess: h.ex[j], recent: h.rc[j], retention: rets[j] })), retention: { median, min: ok.length ? ok[0] : null, n: ok.length }, nNeg: h.eq.filter((v) => v < 0).length }
    }
    let HINT0 = '提示(成員依賴): 隨機半庫 6 個(3 種切法 × 兩半)之內容保持率 中位 0.45、最小 0.20;相位平均為負之半庫 0 個 ⇒ 內容可能依賴特定成員;以子庫(--subset)核對其成立之範圍(不否決,由審計判定)'
    let memberIssues = (xs) => (xs || []).filter((s) => VM.isMemberHint(s))

    it('執行:合格者各 K 次半庫之完整評估(引數之字面值、依序);讀數寫入補算檔、節點文件(harness.member 與迴圈判讀之一列)、樹(raw.member)與迴圈檢查;不改 S、階梯、選集指紋;再跑不重算;鹽改變即重算;未給 member 者不算', async () => {
        let { P, st, ids, calls, runEval } = mk()
        let r = await P.fill({ ext: false, member: true, runEval })
        //規格②: 合格者 = 0、3、4(1 為階梯 0、2 被否決)
        let mcalls = calls.filter((c) => c.kind === 'member')
        assert.deepEqual([...new Set(mcalls.map((c) => ids.indexOf(c.nodeId)))].sort(), [0, 3, 4])
        for (let k of [0, 3, 4]) {
            let cs = mcalls.filter((c) => c.nodeId === ids[k])
            let fpPick = path.join(st.records.workDir, ids[k], 'pick.mjs')
            assert.deepEqual(cs.map((c) => c.args.filter((a, i) => i !== c.args.indexOf('--out') + 1)), TAGS.map((tag) => ['--pick', fpPick, '--mode', 'full', '--null', '32', '--ext-only', 'nullRecentAct', '--member', tag, '--out', '--no-log']), `節點 ${k} 之引數`)
            assert(cs.every((c) => !c.args.some((a) => String(a).startsWith('--member='))), '空白分隔(帶等號之寫法被評估器拒絕)')
        }
        let byId = Object.fromEntries(r.results.map((x) => [x.nodeId, x]))
        assert.deepEqual([0, 3, 4].map((k) => [byId[ids[k]].member, byId[ids[k]].memberHit]), [['ok', true], ['ok', false], ['ok', false]])
        assert.equal('member' in byId[ids[1]], false, '不合格者之結果不帶 member')
        let evaluator = FK.evaluatorFpOf(st)
        for (let k of [0, 3, 4]) {
            let id = ids[k]
            let f = JSON.parse(fs.readFileSync(FK.fillFileOf(st.rsi.root, id), 'utf8'))
            let pickHash = FK.pickHashOf(fs.readFileSync(path.join(st.records.workDir, id, 'pick.mjs')))
            //鍵: 讀數依近期活躍度版之診斷者(節點 3: 選集極活躍)另帶該診斷之內容雜湊(此夾之共用工具區無該診斷 ⇒ null); 不依者(內建)不帶
            assert.deepEqual(f.member.key, { pick: pickHash, evaluator, member: '0x5bd1e995,0x2545f491,0x9e3779b9|n32', ...(k === 3 ? { diag: null } : {}) })
            assert.deepEqual(f.member.row, expRowOf(k), `節點 ${k} 之讀數`)
            assert.deepEqual(f.member.canon, { selHash: `sel-${k}`, at: `2026-01-0${k + 1}T00:00:00.000Z` })
            let doc = P.records.getNodeDoc(id)
            assert.deepEqual(doc.harness.member, f.member)
            assert.deepEqual(doc.harness.notes, [`既有之判讀 ${k}`, FP.memberLineOf(expRowOf(k))], '迴圈判讀:既有之列照留 + 一列')
            let n = P.rsi.store.getNode(id)
            assert.deepEqual(n.raw.member, { at: f.member.at, row: expRowOf(k), selHash: `sel-${k}` })
            assert.equal(n.score.S, 10 + k, 'S 不動')
            assert.equal(n.raw.metrics.selHash, `sel-${k}`, '選集指紋不動')
            //提示: 0 命中(中位 0.45)、3 不命中、4 不適用(負之半庫 3 個亦不判)
            let want = k === 0 ? [HINT0] : []
            assert.deepEqual(memberIssues(doc.harness.checks.issues), want)
            assert.deepEqual(memberIssues(n.raw.issues), want)
            assert.equal(doc.harness.checks.issues[0], `既有之檢查 ${k}`)
        }
        //摘要之列
        assert(r.lines.includes('附算(成員穩健性;佐證,不改 S):3 個成品;成功 3;其中命中「提示(成員依賴)」1 個'), JSON.stringify(r.lines))
        //再跑: 現行 ⇒ 不評估
        let n0 = calls.length
        let r2 = await P.fill({ ext: false, member: true, runEval })
        assert.equal(calls.length, n0)
        assert.deepEqual(r2.lines, [])
        //未給 member(既有之呼叫者): 不計畫此項(其他項之行為不變)
        let { P: Pb, calls: cb, runEval: rb } = mk()
        await Pb.fill({ ext: false, runEval: rb })
        assert.equal(cb.filter((c) => c.kind === 'member').length, 0)
        //鹽改變 ⇒ 鍵不同 ⇒ 重算(K = 2)
        let P2 = makeProject({ ...st, rsi: { ...st.rsi, memberCheck: { salts: [0x5bd1e995] } } }, { dispatch: async () => ({ ok: false }), gate: null, catalogFile: path.join(path.dirname(st.rsi.root), 'catalog2.json'), runEval })
        let n1 = calls.length
        let r3 = await P2.fill({ ext: false, postfit: false, member: true, runEval })
        assert.equal(calls.length - n1, 3 * 2)
        assert.equal(JSON.parse(fs.readFileSync(FK.fillFileOf(st.rsi.root, ids[0]), 'utf8')).member.row.K, 2)
        assert.equal(r3.results.length, 3)
    })

    it('失敗:任一半失敗即止、整項失敗(暫時性 ⇒ 待重試;持倉超過本金 ⇒ 不重試之紀錄);標記不符者不採信;強制重算之失敗續為強制;成功之其他項照寫', async () => {
        //節點 0: 第 3 個半庫離開碼 1(暫時性); 節點 3: 第 1 個半庫為持倉超過研究用本金; 節點 4: 標記不符
        let failM = (k, j, out) => {
            if (k === 0 && j === 2) {
                return { code: 1, timeout: false }
            }
            if (k === 3 && j === 0) {
                fs.writeFileSync(out, JSON.stringify({ ok: false, code: 'EVAL_UNIT_CAPITAL', error: '持倉超過' }), 'utf8')
                return { code: 3, timeout: false }
            }
            if (k === 4 && j === 1) {
                fs.writeFileSync(out, JSON.stringify({ ok: true, member: { tag: '0x1:1' }, metrics: { op: { eqYr: { mean: 1 } } } }), 'utf8')
                return { code: 0, timeout: false }
            }
            return null
        }
        let { P, st, ids, calls, runEval } = mk({ failM })
        let r = await P.fill({ ext: false, member: true, runEval })
        let nOf = (k) => calls.filter((c) => c.kind === 'member' && c.nodeId === ids[k]).length
        assert.deepEqual([nOf(0), nOf(3), nOf(4)], [3, 1, 2], '失敗即止')
        let byId = Object.fromEntries(r.results.map((x) => [x.nodeId, x]))
        assert.deepEqual([0, 3, 4].map((k) => [byId[ids[k]].member, byId[ids[k]].kind]), [['failed', 'transient'], ['failed', 'capital'], ['failed', 'transient']])
        assert(byId[ids[0]].error.startsWith('成員穩健性(0x2545f491:0):離開碼 1'), byId[ids[0]].error)
        assert(byId[ids[4]].error.includes('member 之標記不符'), byId[ids[4]].error)
        //求解窗後段照寫、成員穩健性不寫
        for (let k of [0, 3, 4]) {
            let f = JSON.parse(fs.readFileSync(FK.fillFileOf(st.rsi.root, ids[k]), 'utf8'))
            assert(f.postfit && f.postfit.row && !('member' in f), `節點 ${k}`)
            assert.equal(P.rsi.store.getNode(ids[k]).raw.member, undefined)
            assert(!fs.readdirSync(path.join(st.rsi.root, FP.FILL_DIR)).some((x) => x.includes('.tmp-')), '暫存檔已移除')
        }
        assert.deepEqual(r.retry.slice().sort(), [ids[0], ids[4]].sort())
        assert.deepEqual(r.blocked.map((x) => [x.id, x.kind]), [[ids[3], 'capital']])
        let fst = JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'fill_state.json'), 'utf8'))
        assert.deepEqual(fst.blocked.map((x) => x.id), [ids[3]])
        assert(r.lines.some((l) => l.startsWith('附算(成員穩健性;佐證,不改 S):3 個成品;成功 0、**失敗 3**;其中命中「提示(成員依賴)」0 個;失敗者(再執行補算工具時重試):')), JSON.stringify(r.lines))
        //強制重算之失敗 ⇒ 待重試帶 force.member; 下一次(不帶 --force)續為強制(前次之值雖現行); 成功後移出
        let failOn = { v: false }
        let { P: Pf, st: sf, ids: idf, calls: cf, runEval: rf } = mk({ failM: (k, j) => (failOn.v && k === 0 && j === 5 ? { code: 1, timeout: false } : null) })
        await Pf.fill({ ext: false, postfit: false, member: true, runEval: rf })
        let at0 = JSON.parse(fs.readFileSync(FK.fillFileOf(sf.rsi.root, idf[0]), 'utf8')).member.at
        failOn.v = true
        let r4 = await Pf.fill({ targets: [idf[0]], ext: false, postfit: false, member: true, force: true, runEval: rf })
        assert.equal(r4.results[0].member, 'failed')
        assert.equal(JSON.parse(fs.readFileSync(FK.fillFileOf(sf.rsi.root, idf[0]), 'utf8')).member.at, at0, '失敗時前次之值照留')
        let rtOf = () => JSON.parse(fs.readFileSync(path.join(sf.rsi.root, 'fill_state.json'), 'utf8')).retry
        assert.deepEqual(rtOf().map((x) => [x.id, x.force]), [[idf[0], { member: true }]])
        let n5 = cf.length
        let r5 = await Pf.fill({ targets: [idf[0]], ext: false, postfit: false, member: true, runEval: rf })
        assert.equal(cf.length - n5, 6, '前次之值雖現行, 續為強制重算')
        assert.deepEqual(r5.results.map((x) => x.member), ['failed'])
        failOn.v = false
        await Pf.fill({ targets: [idf[0]], ext: false, postfit: false, member: true, runEval: rf })
        //成功 ⇒ force 移除(本專案之求解窗後段尚未算 ⇒ 以完整選項重算之計畫仍有待算, 照留於待重試)
        assert.deepEqual(rtOf().map((x) => [x.id, 'force' in x]), [[idf[0], false]])
    })

    it('提示之取代與移除;重驗後之補回(不評估);--mode validate 之重掃不誤刪、不重複;tools/scanCheck.mjs 之預覽不列入對照(該份照判相同);關閉者之重掃移除', async () => {
        let { P, st, ids, runEval, calls } = mk()
        await P.fill({ ext: false, member: true, runEval })
        //重驗之形: 節點文件之迴圈判讀被重寫(無成員穩健性之列)、樹之 raw.member 遺失 ⇒ 下一次附算只重寫(不評估)
        let d0 = P.records.getNodeDoc(ids[0])
        d0.harness = { ...d0.harness, notes: ['重驗之判讀'] }
        P.records.putNodeDoc(d0)
        P.rsi.store.updateNode(ids[3], (x) => {
            delete x.raw.member
        })
        let n0 = calls.length
        let r = await P.fill({ ext: false, member: true, runEval })
        assert.equal(calls.length, n0, '不評估')
        assert.deepEqual(r.memberFixed.slice().sort(), [ids[0], ids[3]].sort())
        assert(r.lines.some((l) => l.startsWith('附算:補回成員穩健性之值 2 個(節點文件或樹未帶而補算檔有現行之值;未評估):')), JSON.stringify(r.lines))
        assert.deepEqual(P.records.getNodeDoc(ids[0]).harness.notes, ['重驗之判讀', FP.memberLineOf(expRowOf(0))])
        assert.deepEqual(P.rsi.store.getNode(ids[3]).raw.member.row, expRowOf(3))
        //重掃(--mode validate 之 rescanTraces): 現行者照留一條、不重複; 兩條提示之重產(refreshEvalHints)亦然
        P.rescanTraces()
        P.refreshEvalHints(ids)
        P.refreshEvalHints(ids)
        assert.deepEqual(memberIssues(P.records.getNodeDoc(ids[0]).harness.checks.issues), [HINT0])
        assert.deepEqual(memberIssues(P.rsi.store.getNode(ids[0]).raw.issues), [HINT0])
        assert.deepEqual(memberIssues(P.records.getNodeDoc(ids[3]).harness.checks.issues), [])
        //重算而不命中 ⇒ 舊提示移除(節點文件與樹)
        let P2 = makeProject({ ...st, rsi: { ...st.rsi, memberCheck: { minRetention: 0.1 } } }, { dispatch: async () => ({ ok: false }), gate: null, catalogFile: path.join(path.dirname(st.rsi.root), 'c2.json'), runEval })
        await P2.fill({ targets: [ids[0]], ext: false, postfit: false, member: true, force: true, runEval })
        assert.deepEqual(memberIssues(P2.records.getNodeDoc(ids[0]).harness.checks.issues), [])
        assert.deepEqual(memberIssues(P2.rsi.store.getNode(ids[0]).raw.issues), [])
        //恢復命中; 正本之選集指紋改變(重驗)⇒ 讀數非現行 ⇒ 兩條提示之重產移除該提示
        await P.fill({ targets: [ids[0]], ext: false, postfit: false, member: true, force: true, runEval })
        assert.deepEqual(memberIssues(P.records.getNodeDoc(ids[0]).harness.checks.issues), [HINT0])
        //重算三次後迴圈判讀之成員穩健性之列仍只一列(同前綴取代)
        assert.equal(P.records.getNodeDoc(ids[0]).harness.notes.filter((s) => String(s).startsWith(FP.MEMBER_HEAD)).length, 1)
        //補回只取現行之值: 鹽不同之設定下, 補算檔之值(鍵不同)不補回樹(待重算, 由計畫處理)
        let P4 = makeProject({ ...st, rsi: { ...st.rsi, memberCheck: { salts: [7] } } }, { dispatch: async () => ({ ok: false }), gate: null, catalogFile: path.join(path.dirname(st.rsi.root), 'c4.json'), runEval })
        P4.rsi.store.updateNode(ids[3], (x) => {
            delete x.raw.member
        })
        let r4 = await P4.fill({ ext: false, postfit: false, runEval })
        assert.equal(r4.memberFixed, undefined)
        assert.equal(P4.rsi.store.getNode(ids[3]).raw.member, undefined, '鍵不同 ⇒ 不補回')
        await P.fill({ ext: false, postfit: false, runEval })
        assert.deepEqual(P.rsi.store.getNode(ids[3]).raw.member.row, expRowOf(3), '現行之設定 ⇒ 補回')
        //唯讀之預覽(scanCheck; 子行程之專案根 = 合成專案): 節點文件內之成員依賴之提示不列入「節點文件內」之項 ⇒ 相同
        let stJ = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
        stJ.eval = { ...stJ.eval, ledgerDir: './ledger' }
        stJ.resources = {}
        let pd = path.dirname(st.rsi.root)
        fs.writeFileSync(path.join(pd, 'settings.json'), JSON.stringify(stJ, null, 1), 'utf8')
        let sc = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'tools', 'scanCheck.mjs'), ids[0].slice(0, 8)], { cwd: pd, env: { ...process.env, ARSI_ROOT: pd }, encoding: 'utf8', windowsHide: true, timeout: 120000 })
        assert.equal(sc.status, 0, sc.stderr)
        assert(sc.stdout.includes(`${ids[0].slice(0, 8)} r1 相同 | 現行規則 0 項`) && /與節點文件不同者 0 份/.test(sc.stdout), sc.stdout)
        assert(!sc.stdout.includes('成員依賴'), '不列')
        P.rsi.store.updateNode(ids[0], (x) => {
            x.raw.metrics = { ...x.raw.metrics, selHash: 'sel-0-new' }
        })
        P.refreshEvalHints([ids[0]])
        assert.deepEqual(memberIssues(P.records.getNodeDoc(ids[0]).harness.checks.issues), [])
        P.rsi.store.updateNode(ids[0], (x) => {
            x.raw.metrics = { ...x.raw.metrics, selHash: 'sel-0' }
        })
        P.refreshEvalHints([ids[0]])
        assert.deepEqual(memberIssues(P.records.getNodeDoc(ids[0]).harness.checks.issues), [HINT0], '恢復現行 ⇒ 照產')
        //關閉者(memberCheck: false)之重掃: 不判 ⇒ 移除
        let P3 = makeProject({ ...st, rsi: { ...st.rsi, memberCheck: false } }, { dispatch: async () => ({ ok: false }), gate: null, catalogFile: path.join(path.dirname(st.rsi.root), 'c3.json'), runEval })
        P3.rescanTraces()
        assert.deepEqual(memberIssues(P3.records.getNodeDoc(ids[0]).harness.checks.issues), [])
    })

    it('輪末鉤子:派做夢之前算本輪之節點之求解窗後段與成員穩健性(做夢之審計範圍與節點文件即帶之);做夢之後只補擴充診斷,同一項不再執行;摘要之列與 fill 之回傳;派做夢之前之失敗由下一次輪末重試', async () => {
        //規格⑤; 節點 1 之求解窗後段失敗(暫時性)
        let failPf = new Set([1])
        let { P, st, ids, calls, snap } = mk({ failPf })
        let hk = await P.domain.hooks.afterRound({ round: 1, nodes: ids.map((id, k) => ({ id, status: 'executed', spec: { arms: ARMS[k], base: null } })) })
        let s = snap()
        //派做夢之前: 求解窗後段 5 個、成員穩健性 3 個(各 6 次)、擴充診斷 0
        let pre = calls.slice(0, s.nCalls)
        assert.deepEqual([pre.filter((c) => c.kind === 'postfit').length, pre.filter((c) => c.kind === 'member').length, pre.filter((c) => c.kind === 'ext').length], [5, 18, 0])
        //做夢之後: 擴充診斷 5 個; 求解窗後段與成員穩健性不再執行(節點 1 之失敗不在同一輪重試)
        let post = calls.slice(s.nCalls)
        assert.deepEqual([post.filter((c) => c.kind === 'postfit').length, post.filter((c) => c.kind === 'member').length, post.filter((c) => c.kind === 'ext').length], [0, 0, 5])
        //做夢之審計範圍(任務書 §1 之迴圈檢查)與節點文件於派做夢時即帶之
        let row0 = s.brief.split('\n').find((l) => l.startsWith(`| \`${ids[0]}\``))
        assert(row0.includes(HINT0), row0)
        assert(!s.brief.split('\n').find((l) => l.startsWith(`| \`${ids[3]}\``)).includes('成員依賴'))
        //做夢任務書「可疑方向」第 5 項指向迴圈之讀數(只改此一句; 門檻之字樣與其餘原文照舊)
        let item5 = s.brief.split('\n').find((l) => l.startsWith('  - **5. 成員依賴**'))
        assert.equal(item5, '  - **5. 成員依賴**(隨機半庫之內容保持率之中位 < 0.5,或任一半庫之相位平均為負):不列 `worked`。迴圈之讀數:合格之新成品於派做夢之前已以隨機半庫重跑 —— 命中者 §1 之「迴圈檢查」列「提示(成員依賴)」,其餘見節點文件之迴圈判讀之「成員穩健性」一列;無迴圈之讀數者以 `--member` 自行核對。**「顯著」不等於穩健**:各半庫內之 p 皆小只說明各半內有超額,不說明超額之量級仍在;判定看內容保持率之量級。')
        assert(s.docs[ids[0]].harness.summary.some((x) => String(x).startsWith(FP.POSTFIT_HEAD)), '求解窗後段之列已在')
        assert(s.docs[ids[0]].harness.notes.some((x) => String(x).startsWith(FP.MEMBER_HEAD)), '成員穩健性之列已在')
        assert(s.tree[ids[0]].raw.member && !s.tree[ids[1]].raw.member)
        //摘要之列: 派做夢之前之兩列在做夢之列之前; 做夢之後之附算之列在其後
        let li = (pfx) => hk.lines.findIndex((l) => l.startsWith(pfx))
        assert.deepEqual(hk.lines.slice(0, 2).map((l) => l.replace(/;\d+ 秒/, ';N 秒')), [
            `附算(派做夢之前;求解窗後段;佐證,不改 S):5 個成品;求解窗後段 成功 4、**失敗 1**;N 秒;失敗者(下一次輪末重試):${ids[1].slice(0, 8)}(求解窗後段:離開碼 1)`,
            '附算(派做夢之前;成員穩健性;佐證,不改 S):3 個成品;成功 3;其中命中「提示(成員依賴)」1 個',
        ])
        assert(li('附算(求解窗後段與擴充診斷;佐證,不改 S):5 個成品;求解窗後段 成功 0;擴充診斷 補入 5 項') > 1 && li('附算(求解窗後段與擴充診斷') < li('代理式做夢('), JSON.stringify(hk.lines))
        //回傳之 fill(round-done 事件與 ROUND.json 之 hook.fill 同一物件)
        assert.deepEqual(hk.fill, { n: 5, failed: 0, retry: 1, backlog: { postfit: 0, ext: 0 }, sec: hk.fill.sec, preDream: { n: 5, failed: 1, sec: hk.fill.preDream.sec }, member: { n: 3, failed: 0, hint: 1, backlog: 0 } })
        let rt = JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'fill_state.json'), 'utf8')).retry
        assert.deepEqual(rt.map((x) => [x.id, x.n, x.source]), [[ids[1], 1, 'round']], '失敗只記一次')
        //下一輪(本輪之節點皆現行 ⇒ 派做夢之前不執行; 待重試者於做夢之後重試)
        let n0 = calls.length
        failPf.delete(1)
        let hk2 = await P.domain.hooks.afterRound({ round: 2, nodes: [{ id: ids[3], status: 'executed', spec: { arms: ARMS[3], base: null } }] })
        let c2 = calls.slice(n0)
        assert.deepEqual(c2.map((c) => [ids.indexOf(c.nodeId), c.kind]), [[1, 'postfit']], '只重試節點 1 之求解窗後段(做夢之後)')
        assert(!hk2.lines.some((l) => l.includes('派做夢之前')), JSON.stringify(hk2.lines))
        assert.equal('preDream' in hk2.fill, false)
    })

    it('派做夢之前之結果之併入(prior):只併入 skip 所列之成品(其派做夢之前之結果仍屬現行);重做者(成品已換,不在 skip)與做夢刪除者之舊結果不併 —— 其舊失敗不入回傳之 blocked、摘要之「附算之失敗而不重試」與狀態檔', async () => {
        //規格⑤(同一項每輪至多一次、紀錄每輪一次): 做夢之後之一次以 prior 併入派做夢之前之失敗以記待重試與不重試之失敗; 重做者之成品已換, 舊成品之失敗與現行之成品無關
        let { P, st, ids, runEval } = mk()
        let keyOf = (k) => ({ pick: `OLD${k}`, evaluator: 'e' })
        let pfx = (k, kind, err) => ({ nodeId: ids[k], postfit: 'failed', ext: { ok: [], failed: [] }, member: 'failed', error: err, kind })
        let tk = (k) => ({ nodeId: ids[k], postfit: true, ext: [], keys: { postfit: keyOf(k), ext: {}, member: { ...keyOf(k), member: 'm' } }, member: true })
        //節點 0 = 重做者(舊成品於派做夢之前以「持倉超過本金」失敗,不在 skip); 節點 3 = 本輪之成品(派做夢之前以暫時性之失敗,在 skip);
        //  節點 4 = 做夢刪除者(舊失敗為不重試之類; 在 skip, 但已不在樹上)
        P.rsi.invalidate([ids[4]], '做夢判刪除(合成)')
        assert.notEqual((P.rsi.store.getNode(ids[4]) || {}).status, 'executed', '節點 4 已不在附算之節點之列(鑑別前提)')
        let prior = { results: [pfx(0, 'capital', '舊成品之失敗0'), pfx(3, 'transient', '暫時之失敗3'), pfx(4, 'capital', '已刪除者之失敗4')], tasks: [tk(0), tk(3), tk(4)] }
        let r = await P.fill({ targets: [ids[0], ids[3]], ext: false, member: true, storeAfter: false, source: 'round', skip: { postfit: [ids[3], ids[4]], member: [ids[3], ids[4]] }, prior, runEval })
        //節點 0 之新成品照常於本次執行並成功;節點 3 被略過(不重跑)
        assert.deepEqual(r.results.map((x) => [ids.indexOf(x.nodeId), x.postfit, x.member]), [[0, 'ok', 'ok']], '本次只執行節點 0(節點 3 之項目已於派做夢之前執行 ⇒ 略過;節點 4 已刪)')
        //重做者(節點 0)與做夢刪除者(節點 4)之舊失敗不併: blocked 空、摘要無「附算之失敗而不重試」(修前:blocked 含節點 0 之 capital)
        assert.deepEqual(r.blocked, [], JSON.stringify(r.blocked))
        assert(!r.lines.some((l) => l.includes('附算之失敗而不重試')), JSON.stringify(r.lines))
        //節點 3 之暫時性之失敗併入 ⇒ 入待重試一次(來源 round)
        assert.deepEqual(r.retry, [ids[3]])
        let fsr = JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'fill_state.json'), 'utf8'))
        assert.deepEqual(fsr.retry.map((x) => [x.id, x.n, x.source]), [[ids[3], 1, 'round']])
        assert(!fsr.blocked || fsr.blocked.length === 0)
        //節點 0 之新成品已有現行之讀數(本次之執行所得)
        assert(!P.fillPlanOf({ member: true }).tasks.some((x) => x.nodeId === ids[0] && x.member), '節點 0 之新成品已有現行之讀數')
    })

    it('輪末鉤子:關閉(memberCheck false、salts 為空陣列)、autoFill false、無合格之成品者不算成員穩健性;一併處理待補算不取(只列);做夢未交付時仍回傳派做夢之前之 fill', async () => {
        for (let [name, rsiExtra] of [['memberCheck false', { memberCheck: false }], ['salts []', { memberCheck: { salts: [] } }], ['無合格之成品', { memberCheck: { minLadder: 9 } }]]) {
            let { P, ids, calls } = mk({ rsiExtra })
            let hk = await P.domain.hooks.afterRound({ round: 1, nodes: ids.map((id, k) => ({ id, status: 'executed', spec: { arms: ARMS[k], base: null } })) })
            assert.equal(calls.filter((c) => c.kind === 'member').length, 0, name)
            assert(!('member' in hk.fill), name)
            assert(!hk.lines.some((l) => l.includes('成員穩健性')), name)
        }
        let { P: Pa, ids: ia, calls: ca } = mk({ rsiExtra: { autoFill: false } })
        let ha = await Pa.domain.hooks.afterRound({ round: 1, nodes: ia.map((id, k) => ({ id, status: 'executed', spec: { arms: ARMS[k], base: null } })) })
        assert.equal(ca.length, 0)
        assert.equal('fill' in ha, false)
        //一併處理待補算(上限 > 0): 本輪只有節點 1 ⇒ 其餘合格之既有成品之成員穩健性只列於待補算(不算); 求解窗後段與擴充診斷照常一併處理
        let { P: Pb, ids: ib, calls: cb } = mk({ rsiExtra: { fillBacklogSec: 1800 } })
        let hb = await Pb.domain.hooks.afterRound({ round: 1, nodes: [{ id: ib[1], status: 'executed', spec: { arms: ARMS[1], base: null } }] })
        assert.equal(cb.filter((c) => c.kind === 'member').length, 0, '既有成品之成員穩健性不在輪末算')
        assert(cb.filter((c) => c.kind === 'postfit').length === 5, '求解窗後段之一併處理照常')
        assert(hb.lines.some((l) => l.startsWith('待補算之成品') && l.endsWith(';成員穩健性 3 個')), JSON.stringify(hb.lines))
        assert.deepEqual(hb.fill.member, { n: 0, failed: 0, hint: 0, backlog: 3 })
        //做夢未交付: 派做夢之前之附算已寫入, 回傳帶 fill(preDream 與 member)
        let { P: Pc, ids: ic } = mk()
        let Pd = makeProject(Pc.st, { dispatch: async () => ({ ok: false, error: 'fake' }), gate: null, catalogFile: path.join(path.dirname(Pc.st.rsi.root), 'cd.json'), runEval: (await mkRunEval(Pc, ic)) })
        let hd = await Pd.domain.hooks.afterRound({ round: 1, nodes: ic.map((id, k) => ({ id, status: 'executed', spec: { arms: ARMS[k], base: null } })) })
        assert.equal(hd.failed, true)
        assert.deepEqual(Object.keys(hd.fill).sort(), ['member', 'preDream'])
        assert.deepEqual(hd.fill.member, { n: 3, failed: 0, hint: 1, backlog: 0 })
    })
    it('近期活躍度版之診斷(nullRecentAct)被改寫:讀數依該診斷者(節點 3)重算、不依者(內建;節點 0、4)不重算;正本之診斷值過時者延後、與診斷之補算同一任務才算(全庫之值取新診斷之輸出、診斷之補算失敗則不算讀數);補回之鍵與計畫同一來源', async () => {
        //規格②⑥: 快取之鍵含讀數所依之值; 全庫之值(正本)與各半之值(現行之診斷)須同版
        let { P, st, ids, calls, runEval } = mk({ diags: ['nullRecentAct'] })
        let diagFile = path.join(st.records.toolboxDir, 'metrics', 'nullRecentAct.mjs')
        let diagHash = () => FK.diagsOf(st.records.toolboxDir).find((x) => x.name === 'nullRecentAct').hash
        let fillOf = (k) => JSON.parse(fs.readFileSync(FK.fillFileOf(st.rsi.root, ids[k]), 'utf8'))
        let memberCalls = () => calls.filter((c) => c.kind === 'member')
        let kinds = (k) => calls.filter((c) => c.nodeId === ids[k]).map((c) => c.kind)
        //①首次: 合格者 0、3、4 皆算; 節點 3(選集極活躍 ⇒ 讀數可取近期版)之鍵帶診斷之現行雜湊,0 與 4(內建)不帶
        let H1 = diagHash()
        await P.fill({ ext: false, postfit: false, member: true, storeAfter: false, runEval })
        assert.deepEqual([...new Set(memberCalls().map((c) => ids.indexOf(c.nodeId)))].sort(), [0, 3, 4])
        assert.equal(fillOf(3).member.key.diag, H1)
        assert.equal('diag' in fillOf(0).member.key, false)
        assert.equal('diag' in fillOf(4).member.key, false)
        assert.equal(fillOf(3).member.row.full, 7.5, '正本之近期版之超額')
        //②診斷未改: 再跑不重算
        calls.length = 0
        await P.fill({ ext: false, postfit: false, member: true, storeAfter: false, runEval })
        assert.equal(calls.length, 0)
        //③診斷被改寫: 節點 3 之讀數過時, 但其正本之診斷值亦過時(評估時刻早於診斷之改寫)而本次不補該診斷 ⇒ 延後(不評估、列待補算); 節點 0、4 不依 ⇒ 不重算
        fs.writeFileSync(diagFile, `export default { v: 'nullRecentAct', rev: 2 }\n`, 'utf8')
        let H2 = diagHash()
        assert.notEqual(H2, H1, '鑑別前提: 診斷之雜湊改變')
        let r3 = await P.fill({ ext: false, postfit: false, member: true, storeAfter: false, runEval })
        assert.equal(calls.length, 0, '延後者不評估; 不依者不重算')
        assert.deepEqual(r3.backlog.member, [ids[3]])
        assert.equal(fillOf(3).member.key.diag, H1, '補算檔照留(舊讀數未被取代)')
        assert(P.fillPlanOf({ ext: false, postfit: false, member: true }).backlog.member.includes(ids[3]))
        //④本次補該診斷(ext 含): 節點 3 同任務先補診斷、後算讀數; 全庫之值取本次補得之診斷之輸出(樹上仍為舊版 7.5, 併入在其後); 各半取現行之診斷
        let rE = async (a) => {
            if (a.kind === 'ext') {
                let k = ids.indexOf(a.nodeId)
                calls.push({ nodeId: a.nodeId, kind: a.kind, args: a.args.slice() })
                fs.writeFileSync(argOfA(a.args, '--out'), JSON.stringify({ ok: true, metrics: { selHash: `sel-${k}`, ext: { nullRecentAct: { board: `nullRecentAct-${k}`, side: { excess: 9, p: 0.01 } } } } }), 'utf8')
                return { code: 0, timeout: false }
            }
            return runEval(a)
        }
        calls.length = 0
        let r4 = await P.fill({ ext: true, postfit: false, member: true, storeAfter: false, runEval: rE })
        assert.deepEqual([...new Set(memberCalls().map((c) => ids.indexOf(c.nodeId)))], [3], '只有節點 3 算讀數(0、4 之讀數不依該診斷)')
        assert.deepEqual(kinds(3), ['ext', ...Array(6).fill('member')], '先補診斷、後算讀數')
        assert.deepEqual(kinds(0), ['ext'], '節點 0 只補診斷')
        let row3 = fillOf(3).member.row
        let rc = HALF[3].rc.map((v) => v / 9)
        let sorted = rc.slice().sort((a, b) => a - b)
        assert.equal(row3.full, 9, '全庫之值 = 本次補得之診斷之輸出(非樹上之舊值 7.5)')
        assert.equal(row3.kind, 'recent')
        assert.deepEqual(row3.halves.map((h) => h.retention), rc)
        assert.equal(row3.retention.median, (sorted[2] + sorted[3]) / 2)
        assert.equal(fillOf(3).member.key.diag, H2, '鍵 = 新雜湊')
        assert.equal(P.rsi.store.getNode(ids[3]).raw.metrics.ext.nullRecentAct.side.excess, 9, '診斷之值已併入樹(讀數之後)')
        assert.equal(r4.results.find((x) => x.nodeId === ids[3]).member, 'ok')
        //⑤補回: 節點文件與樹之讀數遺失而補算檔有現行者 ⇒ 只重寫(不評估); 比對之鍵與計畫同一來源(帶新雜湊)
        P.rsi.store.updateNode(ids[3], (x) => {
            let { member, ...rest } = x.raw
            x.raw = rest
        })
        let d3 = P.records.getNodeDoc(ids[3])
        delete d3.harness.member
        d3.harness.notes = d3.harness.notes.filter((s) => !String(s).startsWith(FP.MEMBER_HEAD))
        P.records.putNodeDoc(d3)
        calls.length = 0
        let r5 = await P.fill({ ext: false, postfit: false, member: true, storeAfter: false, runEval: rE })
        assert.equal(calls.length, 0, '不評估')
        assert.deepEqual(r5.memberFixed, [ids[3]])
        assert(P.rsi.store.getNode(ids[3]).raw.member && P.records.getNodeDoc(ids[3]).harness.member)
    })

    it('近期活躍度版之診斷之補算失敗:同任務之讀數不算(整項失敗;與診斷之失敗同入待重試)、下一次一併重算', async () => {
        let { P, st, ids, calls, runEval } = mk({ diags: ['nullRecentAct'] })
        await P.fill({ ext: false, postfit: false, member: true, storeAfter: false, runEval })
        fs.writeFileSync(path.join(st.records.toolboxDir, 'metrics', 'nullRecentAct.mjs'), `export default { v: 'nullRecentAct', rev: 3 }\n`, 'utf8')
        let okExt = true
        let rE = async (a) => {
            if (a.kind === 'ext') {
                let k = ids.indexOf(a.nodeId)
                calls.push({ nodeId: a.nodeId, kind: a.kind, args: a.args.slice() })
                if (!okExt && k === 3) {
                    return { code: 1, timeout: false }
                }
                fs.writeFileSync(argOfA(a.args, '--out'), JSON.stringify({ ok: true, metrics: { selHash: `sel-${k}`, ext: { nullRecentAct: { board: 'x', side: { excess: 9, p: 0.01 } } } } }), 'utf8')
                return { code: 0, timeout: false }
            }
            return runEval(a)
        }
        okExt = false
        calls.length = 0
        let r = await P.fill({ ext: true, postfit: false, member: true, storeAfter: false, runEval: rE, source: 'round' })
        let x3 = r.results.find((x) => x.nodeId === ids[3])
        assert.equal(x3.member, 'failed')
        assert(String(x3.error).includes('成員穩健性:同任務之擴充診斷 nullRecentAct 未補入,讀數待其補入後再算'), String(x3.error))
        assert.equal(x3.kind, 'transient')
        assert.equal(calls.filter((c) => c.nodeId === ids[3] && c.kind === 'member').length, 0, '診斷未補入 ⇒ 不評估各半(全庫之值與各半之值不同版)')
        assert.deepEqual(r.retry, [ids[3]], '入待重試')
        //下一次(診斷補成): 節點 3 之診斷與讀數一併重算
        okExt = true
        calls.length = 0
        await P.fill({ ext: true, postfit: false, member: true, storeAfter: false, runEval: rE, source: 'round' })
        assert.deepEqual(calls.filter((c) => c.nodeId === ids[3]).map((c) => c.kind), ['ext', ...Array(6).fill('member')])
        assert.equal(JSON.parse(fs.readFileSync(FK.fillFileOf(st.rsi.root, ids[3]), 'utf8')).member.row.full, 9)
    })

    it('設定之門檻為數字字串者於整條路徑生效(領域層之設定 → 提示之判定 → 節點文件與樹):與給數值者之讀數與提示逐位相同;無效之字串(布林、空字串、非數字)用預設', async () => {
        //規格①④(跨套件規格 K4: 檢測通過者轉為數值後使用): 節點 3 之保持率中位約 0.94 ⇒ 門檻 0.99 命中、預設 0.5 不命中
        let run = async (minRetention) => {
            let { P, ids, runEval } = mk({ rsiExtra: minRetention === undefined ? {} : { memberCheck: { minRetention } } })
            await P.fill({ ext: false, postfit: false, member: true, storeAfter: false, runEval })
            let n3 = P.rsi.store.getNode(ids[3])
            return { hint3: memberIssues(n3.raw.issues).length, doc3: memberIssues(P.records.getNodeDoc(ids[3]).harness.checks.issues).length, med: n3.raw.member.row.retention.median }
        }
        let byNum = await run(0.99)
        assert.equal(byNum.hint3, 1, '鑑別前提: 數值 0.99 ⇒ 節點 3 命中')
        assert(byNum.med > 0.9 && byNum.med < 0.99, String(byNum.med))
        for (let v of ['0.99', ' 0.99 ', '9.9e-1']) {
            assert.deepEqual(await run(v), byNum, JSON.stringify(v))
        }
        let byDef = await run(undefined)
        assert.equal(byDef.hint3, 0, '鑑別前提: 預設 0.5 ⇒ 不命中')
        for (let v of [true, '', 'abc', '0x10']) {
            assert.deepEqual(await run(v), byDef, `${JSON.stringify(v)} ⇒ 預設`)
        }
    })

    it('做夢未交付:派做夢之前之失敗之摘要列之重試時機字樣與處置相符(未記入待重試;補做夢時重算);做夢交付者照舊「下一次輪末重試」', async () => {
        //規格⑤: 派做夢之前之一次不更新待重試之紀錄; 做夢未交付 ⇒ 無做夢之後之一次併入 ⇒ 失敗者於補做夢時依計畫重算
        let failPf = new Set([1])
        let mFail = { on: true }
        let failM = (k, j) => (mFail.on && k === 0 && j === 1 ? { code: 1, timeout: false } : null)
        let dreamFail = { on: true }
        let { P, st, ids, calls } = mk({ failPf, failM, dreamFail })
        let nodes = ids.map((id, k) => ({ id, status: 'executed', spec: { arms: ARMS[k], base: null } }))
        let hd = await P.domain.hooks.afterRound({ round: 1, nodes })
        assert.equal(hd.failed, true)
        let WHY = '做夢未交付,未記入待重試;補做夢時重算'
        let l1 = hd.lines.find((l) => l.startsWith('附算(派做夢之前;求解窗後段;'))
        let l2 = hd.lines.find((l) => l.startsWith('附算(派做夢之前;成員穩健性;'))
        assert(l1 && l1.includes(`失敗者(${WHY}):${ids[1].slice(0, 8)}(求解窗後段:離開碼 1)`), String(l1))
        assert(l2 && l2.includes(`失敗者(${WHY}):${ids[0].slice(0, 8)}(成員穩健性(0x5bd1e995:1):離開碼 1)`), String(l2))
        assert(!hd.lines.some((l) => l.includes('下一次輪末重試')), JSON.stringify(hd.lines))
        assert.equal(hd.lines.filter((l) => l.startsWith('附算(')).length, 2, '兩列各一(不重複)')
        //處置: 未記入待重試(狀態檔無待重試); 回傳之 fill 帶 preDream(失敗 2: 節點 1 之求解窗後段、節點 0 之成員穩健性)
        let fsp = path.join(st.rsi.root, 'fill_state.json')
        assert.deepEqual(fs.existsSync(fsp) ? JSON.parse(fs.readFileSync(fsp, 'utf8')).retry : [], [])
        assert.equal(hd.fill.preDream.failed, 2)
        //補做夢(做夢交付): 失敗者依計畫重算(節點 1 之求解窗後段、節點 0 之成員穩健性)—— 字樣所述之處置
        failPf.delete(1)
        mFail.on = false
        dreamFail.on = false
        calls.length = 0
        let hk = await P.domain.hooks.afterRound({ round: 1, nodes })
        let again = calls.filter((c) => (c.kind === 'postfit' && ids.indexOf(c.nodeId) === 1) || (c.kind === 'member' && ids.indexOf(c.nodeId) === 0))
        assert.equal(again.filter((c) => c.kind === 'postfit').length, 1)
        assert.equal(again.filter((c) => c.kind === 'member').length, 6, '節點 0 之成員穩健性整項重算(任一半失敗即止 ⇒ 前次無讀數)')
        //做夢交付而派做夢之前有失敗者: 照舊「下一次輪末重試」
        let { P: P2, ids: ids2 } = mk({ failPf: new Set([1]) })
        let h2 = await P2.domain.hooks.afterRound({ round: 1, nodes: ids2.map((id, k) => ({ id, status: 'executed', spec: { arms: ARMS[k], base: null } })) })
        assert(h2.lines.some((l) => l.startsWith('附算(派做夢之前;求解窗後段;') && l.includes('失敗者(下一次輪末重試):')), JSON.stringify(h2.lines))
        assert(!h2.lines.some((l) => l.includes('做夢未交付,未記入待重試')))
        assert(hk.dream, '補做夢(做夢交付)')
        assert(!hk.lines.some((l) => l.includes('做夢未交付')), JSON.stringify(hk.lines))
    })

    it('做夢任務書「可疑方向」第 5 項之「迴圈之讀數」一句隨設定:成員穩健性於該輪執行者(memberCheck 未關閉且 autoFill 非 false)照寫;不執行者(memberCheck false、salts 為空陣列、autoFill false)略去整句 —— 其任務書與未加入本項時全文相同', () => {
        //規格⑤⑥: 句所述(合格之新成品於派做夢之前已以隨機半庫重跑)僅於該輪執行成員穩健性時為真; 判定同一來源(memberCfgOfSt、autoFillOf)
        let st0 = getSettings()
        let toolbox = { dir: 'rsi/toolbox', index: 'rsi/toolbox/README.md', indexName: 'README.md', nTools: 3 }
        let node = { nodeId: 'n1', arms: ['A04_act'], base: null, S: -12.3, worst: -30.1, excess: 8.2, ladder: 0, vetoed: false, claimedS: -12.3, nEvals: 6, nFull: 4, nFullSel: 4, issues: [], from: null, type: 'explore', docMd: 'd.md', workDir: 'rsi/work/n1' }
        let brief = (rsiOver) => makeTexts({ st: { ...st0, rsi: { ...st0.rsi, guides: false, ...rsiOver } }, FD_ROOT: st0.FD_ROOT, nStrategies: 70000 }).dreamBrief({ round: 9, nodeIds: ['n1'], reworkedIds: [], workDir: path.join(st0.records.workDir, 'dream_r009'), context: { nodes: [node], failed: [], refs: [], prevDirections: [], maxDirections: 7, extra: '2. 更新文件', toolbox } })
        let SENT = '迴圈之讀數:合格之新成品於派做夢之前已以隨機半庫重跑 —— 命中者 §1 之「迴圈檢查」列「提示(成員依賴)」,其餘見節點文件之迴圈判讀之「成員穩健性」一列;無迴圈之讀數者以 `--member` 自行核對。'
        let HEAD5 = '  - **5. 成員依賴**(隨機半庫之內容保持率之中位 < 0.5,或任一半庫之相位平均為負):不列 `worked`。'
        let TAIL5 = '**「顯著」不等於穩健**:各半庫內之 p 皆小只說明各半內有超額,不說明超額之量級仍在;判定看內容保持率之量級。'
        let cnt = (s, p) => s.split(p).length - 1
        let on0 = brief({})
        assert.equal(cnt(on0, SENT), 1)
        //執行者: 預設、物件設定(含開啟而尚無合格之成品者 —— 句所述為機制)、不合之鍵用預設者、autoFill 非 false 之值
        for (let [name, over] of [['預設', {}], ['空物件', { memberCheck: {} }], ['門檻', { memberCheck: { minLadder: 9 } }], ['不合之鍵(用預設)', { memberCheck: 'x' }], ['不合之鹽(用預設)', { memberCheck: { salts: [1, 'x'] } }], ['autoFill 為字串 false(非確切 false)', { autoFill: 'false' }], ['autoFill 0(非確切 false)', { autoFill: 0 }], ['autoFill 空字串(非確切 false)', { autoFill: '' }], ['autoFill true', { autoFill: true }]]) {
            let b = brief(over)
            assert.equal(cnt(b, SENT), 1, name)
            assert(b.includes(`${HEAD5}${SENT}${TAIL5}`), name)
        }
        //不執行者: 略去整句(含後半)⇒ 第 5 項為未加入本項時之原文; 其餘全文逐位相同
        for (let [name, over, bl] of [['memberCheck false', { memberCheck: false }, false], ['salts 空陣列', { memberCheck: { salts: [] } }, false], ['autoFill false', { autoFill: false }, true], ['兩者皆關', { memberCheck: false, autoFill: false }, true]]) {
            let b = brief(over)
            assert.equal(cnt(b, SENT), 0, name)
            assert.equal(cnt(b, '無迴圈之讀數者'), 0, `${name}: 後半亦略去`)
            assert.equal(cnt(b, '--member'), cnt(on0, '--member') - 1, `${name}: 只少該句內之一處`)
            assert(b.includes(`${HEAD5}${TAIL5}`), `${name}: 第 5 項為原文`)
            //除該句外逐位相同(autoFill false 者另依既有規則〔R-REC-41〕改擴建一節之一句為改前之原文)
            let want = on0.split(SENT).join('')
            assert.equal(b, bl ? want.split(FILL_BACKLOG_ON).join(FILL_BACKLOG_OFF) : want, `${name}: 除該句外逐位相同`)
        }
    })

    //mkRunEval, 與 mk 同一組替身之值(做夢未交付之案另組專案物件時用)
    let mkRunEval = async (P, ids) => async ({ nodeId, kind, args }) => {
        let k = ids.indexOf(nodeId)
        let out = argOfA(args, '--out')
        if (kind === 'postfit') {
            fs.writeFileSync(out, JSON.stringify(pfOf(k)), 'utf8')
            return { code: 0, timeout: false }
        }
        let tag = argOfA(args, '--member')
        let j = TAGS.indexOf(tag)
        let h = HALF[k]
        fs.writeFileSync(out, JSON.stringify({ ok: true, member: { tag, n: 30 + k * 2 + j }, metrics: { op: { eqYr: { mean: h.eq[j] } }, nullSideAct: { excess: h.ex[j] }, ...(h.rc[j] === null ? {} : { ext: { nullRecentAct: { side: { excess: h.rc[j], p: 0.03 } } } }) } }), 'utf8')
        return { code: 0, timeout: false }
    }

    it('看板一欄與表前一段、搜尋地圖之註記、共同儲存區之 member 與欄位定義:有現行之讀數者才出現(不列門檻之值)', async () => {
        //規格⑥
        let { P, st, ids, runEval } = mk()
        //先只有求解窗後段之補算檔(無成員穩健性之值)
        await P.fill({ ext: false, runEval })
        P.writeBoard()
        let b0 = fs.readFileSync(path.join(st.rsi.root, 'ARMS_BOARD.md'), 'utf8')
        let m0 = fs.readFileSync(path.join(st.rsi.root, 'SEARCH_MAP.md'), 'utf8')
        assert(!b0.includes('成員穩健性') && !m0.includes('成員保持率'), '無讀數者不出現')
        await P.pickStore()
        let idx0 = JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'picks', 'index.json'), 'utf8'))
        assert(idx0.items.every((x) => !('member' in x) && x.postfit) && !idx0.fields.some((f) => f.key.startsWith('member.')), '補算檔皆無此項 ⇒ 不帶 member 之鍵與欄位定義')
        await P.fill({ ext: false, postfit: false, member: true, runEval })
        P.writeBoard()
        let b = fs.readFileSync(path.join(st.rsi.root, 'ARMS_BOARD.md'), 'utf8')
        let bl = b.split('\n')
        assert.equal(bl.filter((l) => l.startsWith('「成員穩健性」一欄 = ')).length, 1)
        let head = bl.find((l) => l.startsWith('| 節點 | 臂 |'))
        assert(head.includes('| 擴充診斷之看板值 | 成員穩健性(保持率 中位 / 最小;負之半庫 / 半庫數) | 每隻訊號數 |'), head)
        let cols = head.split('|').length
        assert.equal(bl[bl.indexOf(head) + 1].split('|').length, cols, '分隔列之欄數相符')
        let rowOf = (k) => bl.find((l) => l.startsWith(`| \`${ids[k]}\``))
        assert(rowOf(0).includes('| 0.45 / 0.20;0 / 6 |'), rowOf(0))
        assert(rowOf(3).includes(`| ${expRowOf(3).retention.median.toFixed(2)} / ${expRowOf(3).retention.min.toFixed(2)};0 / 6 |`), rowOf(3))
        assert(rowOf(4).includes('| 不適用;3 / 6 |') && rowOf(1).includes('| — |'), `${rowOf(4)}\n${rowOf(1)}`)
        assert.equal(rowOf(0).split('|').length, cols)
        assert(!/0\.5[^0-9]/.test(bl.find((l) => l.startsWith('「成員穩健性」一欄 = '))), '表前一段不列門檻')
        let m = fs.readFileSync(path.join(st.rsi.root, 'SEARCH_MAP.md'), 'utf8')
        let lineOf = (k) => m.split('\n').find((l) => l.includes(`\`${ids[k].slice(0, 8)}\` ${ARMS[k].join(' + ')}(`))
        assert(lineOf(0).includes(';成員保持率 中位 0.45 / 最小 0.20(負 0 / 6))'), lineOf(0))
        assert(lineOf(4).includes(';成員保持率 不適用(負 3 / 6))') && !lineOf(1).includes('成員保持率'), lineOf(4))
        await P.pickStore()
        let idx = JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'picks', 'index.json'), 'utf8'))
        let it0 = idx.items.find((x) => x.id === ids[0])
        let f0 = JSON.parse(fs.readFileSync(FK.fillFileOf(st.rsi.root, ids[0]), 'utf8'))
        assert.deepEqual(it0.member, { ...expRowOf(0), at: f0.member.at, current: true })
        assert.strictEqual(idx.items.find((x) => x.id === ids[1]).member, null)
        assert.deepEqual(Object.keys(it0).slice(Object.keys(it0).indexOf('postfit'), Object.keys(it0).indexOf('postfit') + 3), ['postfit', 'member', 'holdout'])
        assert.equal(idx.fields.filter((f) => f.key.startsWith('member.')).length, 1)
        assert(fs.readFileSync(path.join(st.rsi.root, 'picks', 'README.md'), 'utf8').includes('`member.K / salts'))
        assert(!fs.readFileSync(path.join(st.rsi.root, 'picks', 'INDEX.md'), 'utf8').includes('成員'), '總表不加此欄')
    })

    describe('命令列與不用替身之評估', function () {
        this.timeout(600000)
        //合成專案(同 unit-fillCli): 帳本 2400 棒; 節點之正本以評估入口實跑(選集指紋與正本之數字為實值)
        let PICK = 'export default function pick(ctx) {\n    let ids = []\n    for (let s = 0; s < ctx.n; s += 2) {\n        ids.push(s)\n    }\n    return ids\n}\n'
        let mkProject = (name, rsiExtra = {}) => {
            let root = path.join(t.dir, name)
            writeSynthLedger(path.join(root, 'ledger', 'eval'), { n: 60, nBars: 2400, seed: 11 })
            fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
            fs.mkdirSync(path.join(root, 'arms'), { recursive: true })
            fs.copyFileSync(path.join(FD_ROOT, 'arms', 'base.json'), path.join(root, 'arms', 'base.json'))
            let st0 = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
            let stJ = {
                ...st0,
                periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } },
                eval: { ledgerDir: './ledger/eval', warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7], nullDraws: 8, seed: 1, fitEnd: { long: '2022-11-01T00:00:00', short: '2023-02-01T00:00:00' }, limits: { monthlyOrders: 400, peakHold: 50 }, timeoutSec: 240 },
                rsi: { ...st0.rsi, root: './rsi', fillParallel: 1, memberCheck: { salts: [0x5bd1e995], nullDraws: 4 }, ...rsiExtra },
                records: { nodeDir: './rsi/records/nodes', dreamDir: './rsi/records/dreams', trashDir: './rsi/records/trash', workDir: './rsi/work', toolboxDir: './rsi/toolbox' },
                dispatch: { skillsRoot: path.join(root, 'skills'), envFile: path.join(root, '.env') },
                resources: {},
            }
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(stJ, null, 1), 'utf8')
            let sk = path.join(root, 'skills', 'node_modules', 'w-dispatch-ai')
            fs.mkdirSync(sk, { recursive: true })
            fs.writeFileSync(path.join(sk, 'package.json'), JSON.stringify({ name: 'w-dispatch-ai', main: 'index.cjs' }), 'utf8')
            fs.writeFileSync(path.join(sk, 'index.cjs'), 'module.exports = { providers: [], readEnvFile: () => ({}), dispatchOpencode: async () => ({ ok: false, error: \'stub\' }), dispatchClaude: async () => ({ ok: false, error: \'stub\' }) }\n', 'utf8')
            fs.writeFileSync(path.join(root, '.env'), '', 'utf8')
            fs.writeFileSync(path.join(root, 'g_eval.mjs'), `process.env.ARSI_ROOT = ${JSON.stringify(root)}\nawait import(${JSON.stringify(pathToFileURL(path.join(FD_ROOT, 'src', 'cli', 'eval.mjs')).href)})\n`, 'utf8')
            let s = getSettings()
            s.rsi.root = path.join(root, 'rsi')
            s.records = { nodeDir: path.join(root, 'rsi/records/nodes'), dreamDir: path.join(root, 'rsi/records/dreams'), trashDir: path.join(root, 'rsi/records/trash'), workDir: path.join(root, 'rsi/work'), toolboxDir: path.join(root, 'rsi/toolbox') }
            s.eval.ledgerDir = path.join(root, 'ledger', 'eval')
            let P = makeProject(s, { dispatch: async () => ({ ok: false, error: 'seed' }), gate: null, catalogFile: path.join(root, 'seed_catalog.json') })
            P.rsi.init()
            let spec = { arms: ['A01_nt'], base: null }
            let id = P.idOf(spec)
            let wd = path.join(s.records.workDir, id)
            fs.mkdirSync(wd, { recursive: true })
            fs.writeFileSync(path.join(wd, 'pick.mjs'), PICK, 'utf8')
            let env = { ...process.env, ARSI_ROOT: root, ARSI_HARNESS: '1' }
            for (let k of ['ARSI_LEDGER_DIR', 'ARSI_EVAL_FROM']) {
                delete env[k]
            }
            let ev = (args, fo) => {
                let rd = spawnSync(process.execPath, [path.join(root, 'g_eval.mjs'), '--pick', path.join(wd, 'pick.mjs'), '--mode', 'full', ...args, '--out', fo, '--no-log'], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 240000 })
                assert.equal(rd.status, 0, `${rd.stdout}\n${rd.stderr}`.slice(0, 1500))
                return JSON.parse(fs.readFileSync(fo, 'utf8'))
            }
            let canon = ev([], path.join(root, 'direct_full.json'))
            fs.writeFileSync(path.join(wd, 'harness_full.json'), JSON.stringify(canon), 'utf8')
            P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round: 1, raw: { metrics: canon.metrics, issues: [] }, score: { S: 3, ladder: 1, flags: { vetoed: false, why: [] } } })
            P.records.putNodeDoc({ nodeId: id, round: 1, attempt: 1, status: 'verified', spec, task: { goal: 'g', type: 'explore' }, plan: {}, code: {}, results: { claimed: {} }, conclusion: { outcome: 'neutral', summary: '合成' }, harness: { ok: true, summary: [], notes: [], checks: { issues: [] }, score: { S: 3, ladder: 1, flags: { vetoed: false, why: [] } }, raw: { metrics: canon.metrics } } })
            return { root, id, wd, ev, canon }
        }
        let rsiCli = (root, args) => {
            let env = { ...process.env, ARSI_ROOT: root }
            for (let k of ['ARSI_HARNESS', 'ARSI_LEDGER_DIR', 'ARSI_EVAL_FROM']) {
                delete env[k]
            }
            let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'rsi.mjs'), ...args], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 480000 })
            return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
        }

        it('--mode fill(不用替身):讀數與以評估入口手動跑 --member 之結果逐值相同;--dry 之選項列與待算;--no-member 不算', () => {
            //規格②③(B.8 第 9 點): 合成帳本上之結果與手動 g_eval.mjs --member 之結果逐值相同
            let { root, id, ev, canon } = mkProject('cli')
            let r0 = rsiCli(root, ['--mode', 'fill', '--dry'])
            assert.equal(r0.status, 0, r0.out.slice(0, 1500))
            assert(r0.out.includes(';併行 1;成員穩健性 算(合格之成品;半庫 2 個、虛無 4 抽)'), r0.out.slice(0, 1500))
            assert(r0.out.includes('待算 1 個成品(求解窗後段 1、擴充診斷 0 項、成員穩健性 1)') && r0.out.includes(`- ${id.slice(0, 8)}:求解窗後段;成員穩健性`), r0.out.slice(0, 1500))
            let rn = rsiCli(root, ['--mode', 'fill', '--dry', '--no-member'])
            assert(rn.out.includes('待算 1 個成品(求解窗後段 1、擴充診斷 0 項);') && !rn.out.includes('成員穩健性'), rn.out.slice(0, 1500))
            let r1 = rsiCli(root, ['--mode', 'fill', '--no-postfit', '--ext', 'none'])
            assert.equal(r1.status, 0, r1.out.slice(0, 2000))
            assert(r1.out.includes('附算(成員穩健性;佐證,不改 S):1 個成品;成功 1;'), r1.out.slice(0, 2000))
            let f = JSON.parse(fs.readFileSync(FK.fillFileOf(path.join(root, 'rsi'), id), 'utf8'))
            let halves = ['0x5bd1e995:0', '0x5bd1e995:1'].map((tag, j) => {
                let o = ev(['--null', '4', '--ext-only', 'nullRecentAct', '--member', tag], path.join(root, `manual_${j}.json`))
                return { tag, n: o.member.n, metrics: o.metrics }
            })
            let cfg = VM.memberCheckOf({ salts: [0x5bd1e995], nullDraws: 4 }, {})
            assert.deepEqual(f.member.row, VM.memberRowOf(canon.metrics, halves, cfg))
            assert.deepEqual(f.member.row.halves.map((h) => [h.n, h.eqYrMean, h.excess]), halves.map((h) => [h.n, h.metrics.op.eqYr.mean, h.metrics.nullSideAct.excess]), '逐值相同')
            assert.equal(halves[0].n + halves[1].n, 60, '兩半之和 = 全庫')
            //--no-member 之實跑: 不算(已現行者亦不重算); 不記入節點之評估紀錄(--no-log)
            let r2 = rsiCli(root, ['--mode', 'fill', '--no-member', '--force'])
            assert.equal(r2.status, 0, r2.out.slice(0, 2000))
            assert(!r2.out.includes('成員穩健性'), r2.out.slice(0, 2000))
            assert.equal(JSON.parse(fs.readFileSync(FK.fillFileOf(path.join(root, 'rsi'), id), 'utf8')).member.at, f.member.at)
        })
    })
})
