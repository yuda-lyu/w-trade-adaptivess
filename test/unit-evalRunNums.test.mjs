import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { loadLedger } from '../src/eval/ledger.mjs'
import { mulberry32 } from '../src/eval/evalCore.mjs'
import { scoreOf } from '../src/eval/score.mjs'
import { pathToFileURL } from 'url'
import { spawnSync } from 'child_process'
import { getSettings } from '../src/cfg.mjs'
import { makeVerify } from '../src/domain/verify.mjs'
import { makeTexts } from '../src/domain/texts.mjs'
import { renderContract } from '../src/tools/initProject.mjs'
import * as CN from '../src/eval/cfgNum.mjs'
import * as BG from '../src/eval/barGrid.mjs'
import { makeTmp, writeSynthLedger, makeTrainEvaluator as makeEvaluator, FD_ROOT } from './tools/synthLedger.mjs'
//新增之具名匯出以命名空間取得(CN、BG): 修前之複本無此等匯出時, 本檔仍可載入, 各案以斷言失敗呈現而非整檔載入失敗


//評估之執行面之數字與 settings.eval 其餘之數值鍵(排程第 595 項之 eval.* 部分; 排程第 574 項之 api.replaceNull)
//  規格(主控之裁定): ①數值鍵依 K4、K7 收數字字串(去頭尾空白後轉為數值, 其後只用轉換值; 布林、NaN、±Infinity、空字串、BigInt 無效); ②同一鍵只有一個解讀之來源;
//  ③無效之處置沿用 settings.eval.* 既有之口徑(R-EV-44 ④之二: 給了而無效即拋 invalid eval.<鍵>; 未給 = 預設), 同一物件內一致; ④eval.seed 之字串相接必須消除; ⑤limits.* 評估端與合約文字端之預設取同一常數;
//  ⑥replaceNull 之 actDays、draws 與 fillRandom 同一口徑(收數字字串並轉型; 給了而無效即拋)
const BASE = { warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [3, 7], nullDraws: 8 }
let json = (x) => JSON.stringify(x)
let msgOf = (fn) => {
    try {
        fn()
    }
    catch (err) {
        return err instanceof Error ? err.message : `非 Error: ${String(err)}`
    }
    return null
}
let INVALID = [true, false, NaN, Infinity, -Infinity, 'abc', '', '  ', '1e', '0x10', [], [1], {}, () => 1, 10n, Symbol('s')]
let SECRET = 'secret-token-xyz'
let stripMs = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'ms' || k === 'at' || k === 'loadMs' ? undefined : v)))

describe('評估之執行面之數字(seed、tieSalt、replicaSeeds、replicaNullDraws、timeoutSec、geoTp、geoSl)與 eval.limits、phases、horizons', function () {
    this.timeout(300000)

    describe('cfgNum: evalRunNumsOf / evalRunNumOf(單一定義 EVAL_RUN_NUMS)', () => {
        it('未給(undefined、null)= 預設; 數字原樣; 數字字串(含頭尾空白、負號、科學記號)轉為數值; 各鍵之預設與次序', () => {
            //對應規格:「數值鍵依 K4／K7 收數字字串(去頭尾空白後 Number(…),其後只用轉換值)」
            assert.deepEqual(CN.evalRunNumsOf(undefined), { seed: 1, tieSalt: 0, replicaSeeds: 0, replicaNullDraws: 32, timeoutSec: 900, geoTp: 3, geoSl: 3 })
            assert.deepEqual(CN.evalRunNumsOf({ seed: null, tieSalt: null, timeoutSec: null }), CN.evalRunNumsOf({}))
            assert.deepEqual(Object.keys(CN.EVAL_RUN_NUMS), ['seed', 'tieSalt', 'replicaSeeds', 'replicaNullDraws', 'timeoutSec', 'geoTp', 'geoSl'])
            assert.deepEqual(CN.evalRunNumsOf({ seed: '20261110', tieSalt: ' -3 ', replicaSeeds: '2', replicaNullDraws: '16', timeoutSec: '600.5', geoTp: '2', geoSl: ' 4 ' }), { seed: 20261110, tieSalt: -3, replicaSeeds: 2, replicaNullDraws: 16, timeoutSec: 600.5, geoTp: 2, geoSl: 4 })
            assert.deepEqual(CN.evalRunNumsOf({ seed: 20261110, tieSalt: -3, replicaSeeds: 2, replicaNullDraws: 16, timeoutSec: 600.5, geoTp: 2, geoSl: 4 }), { seed: 20261110, tieSalt: -3, replicaSeeds: 2, replicaNullDraws: 16, timeoutSec: 600.5, geoTp: 2, geoSl: 4 }, '數字原樣')
            for (let v of [0, -7, Number.MAX_SAFE_INTEGER]) {
                assert.strictEqual(CN.evalRunNumsOf({ seed: v }).seed, v, `seed ${v} 為任意之整數`)
            }
            assert.strictEqual(CN.evalRunNumsOf({ replicaSeeds: 0, replicaNullDraws: 0 }).replicaNullDraws, 0, '0 合法(重放不算虛無)')
            //逾時: 換成毫秒不超過 2147483647(Node 計時器之上限; 超過者計時器溢位而立即觸發)之邊界
            assert.strictEqual(CN.evalRunNumsOf({ timeoutSec: 2147483 }).timeoutSec, 2147483)
            assert.strictEqual(CN.evalRunNumsOf({ timeoutSec: '2147483.647' }).timeoutSec, 2147483.647)
            assert.strictEqual(CN.evalRunNumsOf({ timeoutSec: 0.001 }).timeoutSec, 0.001)
        })

        it('給了而無效者拋 invalid <名>.<鍵>: must be <種類描述>(V19), 訊息不帶輸入值(V20); 布林、NaN、±Infinity、非數字字串、空字串、BigInt、陣列、物件一律無效; 值域外(小數之整數鍵、非正之正數鍵)無效', () => {
            //對應規格:「布林、NaN、±Infinity、空字串、BigInt 無效」「無效之處置沿用 settings.eval.* 既有之口徑(給了而無效即拋)」
            let want = { seed: 'an integer', tieSalt: 'an integer', replicaSeeds: 'a non-negative integer', replicaNullDraws: 'a non-negative integer', timeoutSec: 'a positive number of seconds that is at most 2147483', geoTp: 'a positive integer', geoSl: 'a positive integer' }
            let extra = { seed: [1.5, '1.5', 2 ** 53, '9007199254740993'], tieSalt: [0.5, 2 ** 53], replicaSeeds: [-1, '-1', 1.5], replicaNullDraws: [-1, 1.5, '2.5'], timeoutSec: [0, '0', -1, '-5', 2147484, '2147483.648', 3e6], geoTp: [0, '0', -1, 1.5], geoSl: [0, 1.5] }
            for (let [k, desc] of Object.entries(want)) {
                for (let v of [...INVALID, ...extra[k]]) {
                    let m = msgOf(() => CN.evalRunNumsOf({ [k]: v }, 'eval'))
                    assert.strictEqual(m, `invalid eval.${k}: must be ${desc}`, `${k} ${typeof v === 'bigint' ? `${v}n` : (typeof v === 'symbol' || typeof v === 'function' ? typeof v : json(v))}`)
                }
                assert.strictEqual(msgOf(() => CN.evalRunNumsOf({ [k]: 'abc' }, 'cfg')), `invalid cfg.${k}: must be ${desc}`, `${k}: 位置名稱 cfg(makeEvaluator 稱設定為 cfg)`)
                assert.strictEqual(msgOf(() => CN.evalRunNumsOf({ [k]: SECRET })).includes(SECRET), false, `${k}: 不回顯輸入值`)
            }
        })

        it('evalRunNumOf: 只讀所指之一鍵(他鍵無效不影響); 鍵名須為表內之鍵(含原型之名稱拒); 與 evalRunNumsOf 同值', () => {
            //對應規格:「同一鍵只有一個解讀之來源」: replicaNullDraws 於迴圈之重放與成員穩健性之附算共用
            let bad = { seed: 'abc', timeoutSec: -1, replicaNullDraws: '16' }
            assert.strictEqual(CN.evalRunNumOf(bad, 'replicaNullDraws'), 16)
            assert.strictEqual(msgOf(() => CN.evalRunNumsOf(bad)), 'invalid eval.seed: must be an integer')
            assert.strictEqual(CN.evalRunNumOf({}, 'timeoutSec'), 900)
            for (let k of ['constructor', '__proto__', 'toString', 'nullDraws', 'warmupDays', '']) {
                assert(/^invalid key: must be one of seed, tieSalt, /.test(msgOf(() => CN.evalRunNumOf({}, k))), k)
            }
            for (let k of Object.keys(CN.EVAL_RUN_NUMS)) {
                assert.strictEqual(CN.evalRunNumOf({ [k]: '2' }, k), CN.evalRunNumsOf({ [k]: '2' })[k], k)
            }
        })

        it('每個鍵只讀一次(檢查之值即使用之值): 存取子先後回傳不同之值者, 取第一次所讀者', () => {
            let n = 0
            let o = {
                get seed() {
                    n++
                    return n === 1 ? '7' : 'abc'
                },
            }
            assert.strictEqual(CN.evalRunNumsOf(o).seed, 7)
            assert.strictEqual(n, 1)
        })
    })

    describe('cfgNum: evalLimitsOf(硬上限; 評估端與合約文字端之預設同一常數)', () => {
        it('未給 = 400 / 50(EVAL_LIMITS 單一常數); 數字字串轉為數值; 0 合法; 部分給者其餘取預設', () => {
            assert.deepEqual(CN.EVAL_LIMITS, { monthlyOrders: 400, peakHold: 50 })
            for (let ev of [undefined, null, {}, { limits: undefined }, { limits: null }, { limits: {} }, { limits: { monthlyOrders: null, peakHold: undefined } }]) {
                assert.deepEqual(CN.evalLimitsOf(ev), { monthlyOrders: 400, peakHold: 50 }, json(ev))
            }
            assert.deepEqual(CN.evalLimitsOf({ limits: { monthlyOrders: '300', peakHold: ' 20 ' } }), { monthlyOrders: 300, peakHold: 20 })
            assert.deepEqual(CN.evalLimitsOf({ limits: { monthlyOrders: 250.5, peakHold: 0 } }), { monthlyOrders: 250.5, peakHold: 0 })
            assert.deepEqual(CN.evalLimitsOf({ limits: { peakHold: 7 } }), { monthlyOrders: 400, peakHold: 7 })
        })

        it('給了而無效 ⇒ 拋 invalid eval.limits.<鍵>: must be a non-negative number; limits 本身非物件(含陣列) ⇒ invalid eval.limits: must be an object; 訊息不帶輸入值', () => {
            //對應規格:「eval.limits.monthlyOrders／peakHold(評估端無檢測…)」: 原缺鍵或 'abc' ⇒ 永不否決、null 或 '' ⇒ 當 0 而一律否決
            for (let k of ['monthlyOrders', 'peakHold']) {
                for (let v of [...INVALID, -1, '-1', -0.5]) {
                    assert.strictEqual(msgOf(() => CN.evalLimitsOf({ limits: { [k]: v } })), `invalid eval.limits.${k}: must be a non-negative number`, `${k} ${typeof v === 'bigint' ? `${v}n` : (typeof v === 'symbol' || typeof v === 'function' ? typeof v : json(v))}`)
                }
                assert(!msgOf(() => CN.evalLimitsOf({ limits: { [k]: SECRET } })).includes(SECRET))
            }
            for (let l of [5, '400', true, [], [400, 50]]) {
                assert.strictEqual(msgOf(() => CN.evalLimitsOf({ limits: l })), 'invalid eval.limits: must be an object', json(l))
            }
        })

        it('scoreOf 與合約、任務書之預設為同一常數: 缺 limits 之鍵 ⇒ 月均單 > 400 或最大持倉 > 50 否決(恰為上限者不否決); 字串之上限轉為數值後才比較', () => {
            //對應規格:「limits.* 評估端與合約文字端之預設取同一常數」
            let OPT = { score: { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] } }
            let mk = (mo, pk) => ({ op: { eqYr: { mean: 40, min: 30 }, monthlyOrders: { mean: mo }, peakHold: { max: pk } }, fresh: { 7: { eqYr: { mean: 20 } } }, sel: { sizeMax: 40 }, null: { p: 0.01 } })
            for (let limits of [{}, undefined, null, { monthlyOrders: '400', peakHold: '50' }]) {
                let o = { ...OPT, limits }
                assert.strictEqual(scoreOf(mk(400, 50), o).flags.vetoed, false, `${json(limits)}: 恰為上限不否決`)
                assert.strictEqual(scoreOf(mk(401, 50), o).flags.vetoed, true, `${json(limits)}: 月均單 401`)
                assert.strictEqual(scoreOf(mk(400, 51), o).flags.vetoed, true, `${json(limits)}: 最大持倉 51`)
            }
            //字串之上限: 以數值比較(原: 字串與數字比較時雖隱式轉換, 但 'abc' 永不否決、null / '' 當 0 而一律否決)
            let s = scoreOf(mk(100, 5), { ...OPT, limits: { monthlyOrders: '99', peakHold: '4' } })
            assert.strictEqual(s.flags.vetoed, true)
            assert(s.flags.why.some((w) => w === '月均單 100 > 99') && s.flags.why.some((w) => w === '最大同時持倉 5 > 4'), s.flags.why.join('|'))
            for (let bad of ['abc', null, '', true, -1]) {
                assert.strictEqual(msgOf(() => scoreOf(mk(100, 5), { ...OPT, limits: { monthlyOrders: bad } })), bad === null ? null : 'invalid eval.limits.monthlyOrders: must be a non-negative number', json(bad))
            }
            //無評估結果者先回傳(不讀 limits)
            assert.strictEqual(scoreOf(null, { ...OPT, limits: { monthlyOrders: 'abc' } }).flags.vetoed, true)
        })

        it('合約之參考版(renderContract)與任務書(makeTexts)之硬限制: 缺 limits 之鍵 ⇒ 與參考設定之 400 / 50 逐字相同; 字串之上限寫為其數值; 同一個取值函數', () => {
            let st0 = getSettings()
            let ref = fs.readFileSync(path.join(FD_ROOT, 'contract', 'pick-contract.md'), 'utf8')
            let tpl = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
            let noLim = (s) => {
                let { limits, ...rest } = s.eval
                return { ...s, eval: rest }
            }
            let c0 = renderContract(ref, { barHours: 4, settings: tpl })
            assert.strictEqual(renderContract(ref, { barHours: 4, settings: noLim(tpl) }), c0, '缺 limits ⇒ 400 / 50')
            assert.strictEqual(renderContract(ref, { barHours: 4, settings: { ...tpl, eval: { ...tpl.eval, limits: { monthlyOrders: '400', peakHold: '50' } } } }), c0, '數字字串')
            let c1 = renderContract(ref, { barHours: 4, settings: { ...tpl, eval: { ...tpl.eval, limits: { monthlyOrders: '250', peakHold: 40 } } } })
            assert(c1.includes('月均單 ≤ 250、最大同時持倉 ≤ 40') && !c1.includes('月均單 ≤ 400、最大同時持倉 ≤ 50'), '依設定')
            assert.strictEqual(msgOf(() => renderContract(ref, { barHours: 4, settings: { ...tpl, eval: { ...tpl.eval, limits: { peakHold: 'abc' } } } })), 'invalid eval.limits.peakHold: must be a non-negative number')
            //任務書
            let arm = { id: 'A04_act', layer: 'A', layerName: 'A 資格', title: '活躍度', desc: '近期有進場者', grid: null }
            let task = { goal: 'g', type: 'explore', claim: null, arms: [arm], base: null, refs: [], direction: null, toolbox: { dir: 'rsi/toolbox', index: 'rsi/toolbox/README.md', indexName: 'README.md', nTools: 3 } }
            let brief = (st) => makeTexts({ st: { ...st, rsi: { ...st.rsi, guides: false } }, FD_ROOT: st.FD_ROOT }).nodeBrief({ workDir: path.join(st.records.workDir, 'nodeX'), task, round: 7, nodeId: 'nodeX', attempt: 1 })
            let b0 = brief(st0)
            assert(b0.includes('月均單 ≤ 400、最大同時持倉 ≤ 50'), '參考設定 400 / 50')
            assert.strictEqual(brief(noLim(st0)), b0, '缺 limits ⇒ 與 400 / 50 逐字相同(原: 寫出 undefined)')
            let b1 = brief({ ...st0, eval: { ...st0.eval, limits: { monthlyOrders: '250', peakHold: 40 } } })
            assert(b1.includes('月均單 ≤ 250、最大同時持倉 ≤ 40'))
        })
    })

    describe('cfgNum: cfgListOf / evalListsOf(phases、horizons)', () => {
        it('cfgListOf: 未給回 def; 數字字串轉為數值; 回新陣列(不改呼叫端); 元素不得為 undefined / null; 非陣列與(未允許時)空陣列無效', () => {
            assert.strictEqual(CN.cfgListOf(undefined, 'D', 'eval.phases', 'nonNegNum'), 'D')
            assert.strictEqual(CN.cfgListOf(null, 'D', 'eval.phases', 'nonNegNum'), 'D')
            let src = ['0', 3, ' 1.5 ']
            let out = CN.cfgListOf(src, null, 'eval.phases', 'nonNegNum')
            assert.deepEqual(out, [0, 3, 1.5])
            assert.notStrictEqual(out, src)
            assert.deepEqual(src, ['0', 3, ' 1.5 '], '不改呼叫端之陣列')
            assert.deepEqual(CN.cfgListOf([], null, 'eval.horizons', 'posNum', true), [], '允許空陣列者')
            assert.strictEqual(msgOf(() => CN.cfgListOf([], null, 'eval.phases', 'nonNegNum')), 'invalid eval.phases: must be a non-empty array of non-negative numbers')
            assert.strictEqual(msgOf(() => CN.cfgListOf([], null, 'eval.horizons', 'posNum', true)), null)
            for (let v of [5, 'abc', '0,3', {}, true, 10n]) {
                assert.strictEqual(msgOf(() => CN.cfgListOf(v, null, 'eval.phases', 'nonNegNum')), 'invalid eval.phases: must be a non-empty array of non-negative numbers', String(typeof v === 'bigint' ? `${v}n` : v))
                assert.strictEqual(msgOf(() => CN.cfgListOf(v, null, 'eval.horizons', 'posNum', true)), 'invalid eval.horizons: must be an array of positive numbers')
            }
            for (let v of [undefined, null, 'abc', '', true, NaN, Infinity, -1, '-1', 10n, [], {}]) {
                assert.strictEqual(msgOf(() => CN.cfgListOf([0, v, 3], null, 'eval.phases', 'nonNegNum')), 'invalid eval.phases[1]: must be a non-negative number', `元素 ${typeof v === 'bigint' ? `${v}n` : json(v)}`)
            }
            assert.strictEqual(msgOf(() => CN.cfgListOf([0, 0], null, 'eval.horizons', 'posNum')), 'invalid eval.horizons[0]: must be a positive number')
            assert(!msgOf(() => CN.cfgListOf([SECRET], null, 'eval.phases', 'nonNegNum')).includes(SECRET))
        })

        it('evalListsOf: 未給 ⇒ null(評估器取預設); 元素 × 每日棒數須為整數(每日 6 根者 0.5 日 = 3 根合法、0.1 日不合; 每日 1 根者 0.5 不合); horizons 之空陣列合法', () => {
            assert.deepStrictEqual(BG.evalListsOf({}, 6), { phases: null, horizons: null })
            assert.deepStrictEqual(BG.evalListsOf(undefined, 6), { phases: null, horizons: null })
            assert.deepEqual(BG.evalListsOf({ phases: ['0', 3], horizons: ['7', 14.5] }, 2), { phases: [0, 3], horizons: [7, 14.5] })
            assert.deepEqual(BG.evalListsOf({ phases: [0, 0.5] }, 6).phases, [0, 0.5])
            assert.deepStrictEqual(BG.evalListsOf({ horizons: [] }, 6), { phases: null, horizons: [] })
            assert.strictEqual(msgOf(() => BG.evalListsOf({ phases: [0, 0.1] }, 6, 'eval')), 'invalid eval.phases[1]: must be a non-negative number of days that is a whole number of bars')
            assert.strictEqual(msgOf(() => BG.evalListsOf({ phases: [0.5] }, 1, 'cfg')), 'invalid cfg.phases[0]: must be a non-negative number of days that is a whole number of bars')
            assert.strictEqual(msgOf(() => BG.evalListsOf({ horizons: [7, 0.5] }, 1)), 'invalid eval.horizons[1]: must be a positive number of days that is a whole number of bars')
            assert.strictEqual(msgOf(() => BG.evalListsOf({ phases: [] }, 6)), 'invalid eval.phases: must be a non-empty array of non-negative numbers')
        })

        it('checkEvalSettings(組裝時之預檢)與 makeEvaluator 同一組檢測: 任一鍵無效 ⇒ 拋 invalid eval.<鍵>(命令列印 ERROR 並離開碼 2: configMsgOf)', () => {
            let meta = { time0: '2022-07-01T00:00:00', barHours: 4 }
            let st = (ev) => ({ periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } }, eval: { ...BASE, ...ev } })
            assert.doesNotThrow(() => BG.checkEvalSettings(st({ seed: '20261110', tieSalt: '0', replicaSeeds: '2', replicaNullDraws: '16', timeoutSec: '900', geoTp: '3', geoSl: '3', limits: { monthlyOrders: '400', peakHold: '50' }, phases: ['0', '3'], horizons: ['3', '7'] }), meta))
            for (let [ev, want] of [
                [{ seed: 'abc' }, 'invalid eval.seed: must be an integer'],
                [{ tieSalt: 1.5 }, 'invalid eval.tieSalt: must be an integer'],
                [{ replicaSeeds: -1 }, 'invalid eval.replicaSeeds: must be a non-negative integer'],
                [{ replicaNullDraws: '2.5' }, 'invalid eval.replicaNullDraws: must be a non-negative integer'],
                [{ timeoutSec: 0 }, 'invalid eval.timeoutSec: must be a positive number of seconds that is at most 2147483'],
                [{ geoTp: 0 }, 'invalid eval.geoTp: must be a positive integer'],
                [{ geoSl: 'x' }, 'invalid eval.geoSl: must be a positive integer'],
                [{ limits: { peakHold: 'x' } }, 'invalid eval.limits.peakHold: must be a non-negative number'],
                [{ limits: 7 }, 'invalid eval.limits: must be an object'],
                [{ phases: [0, 'x'] }, 'invalid eval.phases[1]: must be a non-negative number'],
                [{ phases: [] }, 'invalid eval.phases: must be a non-empty array of non-negative numbers'],
                [{ horizons: [7, -1] }, 'invalid eval.horizons[1]: must be a positive number'],
                [{ phases: [0.1] }, 'invalid eval.phases[0]: must be a non-negative number of days that is a whole number of bars'],
            ]) {
                assert.strictEqual(msgOf(() => BG.checkEvalSettings(st(ev), meta)), want, json(ev))
                assert.strictEqual(BG.configMsgOf(new Error(want)), want, `configMsgOf: ${want}`)
            }
        })
    })

    describe('評估器(makeEvaluator / evalPolicy): 字串與數字之設定逐位相同; 無效即拒絕', () => {
        let t
        let L
        before(() => {
            t = makeTmp('evalRunNums')
            writeSynthLedger(t.dir, { n: 40, nBars: 1500, seed: 3 })
            L = loadLedger(t.dir)
        })
        after(() => {
            t.cleanup()
        })
        let pickRand = (ctx) => {
            let ids = []
            for (let s = 0; s < ctx.n; s++) {
                if (ctx.rand() < 0.3) {
                    ids.push(s)
                }
            }
            return ids
        }
        //pickTie: 入選者只依各策略固定之同分次鍵 ctx.meta.tie(同分次序之鹽改變之, 才使選集改變)
        let pickTie = (ctx) => {
            let ids = []
            for (let s = 0; s < ctx.n; s++) {
                if ((ctx.meta.tie[s] >>> 3) % 3 === 0) {
                    ids.push(s)
                }
            }
            return ids
        }
        let run = (cfg, opt = {}, pick = pickRand) => stripMs(makeEvaluator(L, { ...BASE, ...cfg }).evalPolicy(pick, { ...opt }))

        it('seed: 數字字串之種子 ≡ 數字之種子(原: `seed * 1000003` 與 `seed + …` 並存, 字串之種子於各抽之虛無被解讀為另一個數值); 不同種子之結果不同(鑑別前提)', () => {
            //對應規格:「eval.seed 之字串相接必須消除(以轉換後之數值運算)」
            let a = run({ seed: 20261110 })
            let b = run({ seed: '20261110' })
            let c = run({ seed: ' 20261110 ' })
            assert.strictEqual(json(b), json(a), '字串 ≡ 數字(含各虛無之 p、均、sd)')
            assert.strictEqual(json(c), json(a), '頭尾空白')
            assert.notStrictEqual(json(run({ seed: 20261111 })), json(a), '鑑別前提: 換種子結果不同(選集與虛無皆隨之)')
            assert.notStrictEqual(json(a.null), json(run({ seed: 20261111 }).null), '鑑別前提: 虛無之抽樣隨種子')
            //未給 = 1
            assert.strictEqual(json(run({})), json(run({ seed: 1 })))
            assert.strictEqual(json(run({ seed: null })), json(run({ seed: 1 })))
        })

        it('tieSalt: 數字字串 ≡ 數字(原: 非整數者靜默視為 0, 字串之鹽不生效); 非 0 之鹽改變結果(鑑別前提)', () => {
            let a = run({ seed: 5, tieSalt: 2 }, {}, pickTie)
            assert.strictEqual(json(run({ seed: 5, tieSalt: '2' }, {}, pickTie)), json(a))
            assert.notStrictEqual(json(a), json(run({ seed: 5 }, {}, pickTie)), '鑑別前提: 鹽 2 與鹽 0 之結果不同')
            assert.strictEqual(json(run({ seed: 5, tieSalt: '0' }, {}, pickTie)), json(run({ seed: 5 }, {}, pickTie)))
            assert.strictEqual(json(run({ seed: 5, tieSalt: ' -3 ' }, {}, pickTie)), json(run({ seed: 5, tieSalt: -3 }, {}, pickTie)), '負之鹽')
        })

        it('geoTp / geoSl: 數字字串 ≡ 數字且輸出 nTp、nSl 為數值(原: 字串之 nTp 與 `nTp * …` 之運算混用)', () => {
            let a = run({ seed: 5, geoTp: 2, geoSl: 4 })
            assert.strictEqual(a.nullSideGeo.nTp, 2)
            assert.strictEqual(a.nullSideGeo.nSl, 4)
            let b = run({ seed: 5, geoTp: '2', geoSl: '4' })
            assert.strictEqual(json(b), json(a))
            assert.strictEqual(b.nullSideGeo.nTp, 2, '轉為數值')
            assert.notStrictEqual(json(a.nullSideGeo), json(run({ seed: 5 }).nullSideGeo), '鑑別前提: 與預設之 3 × 3 不同')
        })

        it('phases / horizons: 數字字串 ≡ 數字且輸出之 phases、horizons 為數值陣列; 空之 horizons 合法(不算新鮮度); 未給 = 預設', () => {
            let a = run({ seed: 5, phases: [0, 3], horizons: [3, 7] })
            let b = run({ seed: 5, phases: ['0', ' 3 '], horizons: ['3', '7'] })
            assert.strictEqual(json(b), json(a))
            assert.deepEqual(b.phases, [0, 3])
            assert.deepEqual(b.horizons, [3, 7])
            assert.deepEqual(run({ seed: 5, horizons: [] }).horizons, [], '空之 horizons 合法')
            let d = run({ phases: undefined, horizons: undefined, nullDraws: 0 })
            assert.deepEqual(d.phases, [0, 1, 2, 3, 4, 5, 6])
            assert.deepEqual(d.horizons, [1, 3, 7, 14, 30])
            //opt 之 phases / horizons / seed 同口徑
            let o = run({ seed: 5 }, { phases: ['3'], horizons: ['7'], seed: '9' })
            let p = run({ seed: 5 }, { phases: [3], horizons: [7], seed: 9 })
            assert.strictEqual(json(o), json(p))
            assert.deepEqual(o.phases, [3])
        })

        it('給了而無效 ⇒ 拒絕建評估器(invalid cfg.<鍵>…, 不帶輸入值); evalPolicy 之 opt.seed / opt.phases / opt.horizons 亦然(invalid opt.<鍵>…); 無評估發生', () => {
            for (let [cfg, want] of [
                [{ seed: 'abc' }, 'invalid cfg.seed: must be an integer'],
                [{ seed: 1.5 }, 'invalid cfg.seed: must be an integer'],
                [{ seed: true }, 'invalid cfg.seed: must be an integer'],
                [{ tieSalt: 'x' }, 'invalid cfg.tieSalt: must be an integer'],
                [{ tieSalt: 0.5 }, 'invalid cfg.tieSalt: must be an integer'],
                [{ replicaSeeds: -1 }, 'invalid cfg.replicaSeeds: must be a non-negative integer'],
                [{ replicaNullDraws: 1.5 }, 'invalid cfg.replicaNullDraws: must be a non-negative integer'],
                [{ timeoutSec: -3 }, 'invalid cfg.timeoutSec: must be a positive number of seconds that is at most 2147483'],
                [{ geoTp: 0 }, 'invalid cfg.geoTp: must be a positive integer'],
                [{ geoSl: '2.5' }, 'invalid cfg.geoSl: must be a positive integer'],
                [{ phases: [0, 'x'] }, 'invalid cfg.phases[1]: must be a non-negative number'],
                [{ phases: [] }, 'invalid cfg.phases: must be a non-empty array of non-negative numbers'],
                [{ phases: 3 }, 'invalid cfg.phases: must be a non-empty array of non-negative numbers'],
                [{ phases: [0.1] }, 'invalid cfg.phases[0]: must be a non-negative number of days that is a whole number of bars'],
                [{ horizons: [7, 'x'] }, 'invalid cfg.horizons[1]: must be a positive number'],
                [{ horizons: [0] }, 'invalid cfg.horizons[0]: must be a positive number'],
                [{ horizons: '7' }, 'invalid cfg.horizons: must be an array of positive numbers'],
            ]) {
                assert.strictEqual(msgOf(() => makeEvaluator(L, { ...BASE, ...cfg })), want, json(cfg))
            }
            let ev = makeEvaluator(L, { ...BASE, seed: 7 })
            for (let [opt, want] of [
                [{ seed: 'abc' }, 'invalid opt.seed: must be an integer'],
                [{ seed: 1.5 }, 'invalid opt.seed: must be an integer'],
                [{ phases: ['x'] }, 'invalid opt.phases[0]: must be a non-negative number'],
                [{ phases: [] }, 'invalid opt.phases: must be a non-empty array of non-negative numbers'],
                [{ horizons: [-1] }, 'invalid opt.horizons[0]: must be a positive number'],
                [{ phases: [0.1] }, 'invalid opt.phases[0]: must be a non-negative number of days that is a whole number of bars'],
                [{ horizons: [0.1] }, 'invalid opt.horizons[0]: must be a positive number of days that is a whole number of bars'],
            ]) {
                assert.strictEqual(msgOf(() => ev.evalPolicy(pickRand, opt)), want, json(opt))
            }
        })

        it('原始碼之盤點: 除 cfgNum.mjs 之單一取值函數外, 無處直接讀 settings.eval / cfg 之 seed、tieSalt、replicaSeeds、replicaNullDraws、timeoutSec、geoTp、geoSl(各使用處皆用轉換值; 註解不計)', () => {
            //對應規格:「eval.seed 之各使用處是否皆用轉換值」: 先前之使用處 evalCore.mjs:807、1388、1488、1652(seed 之運算)、verify.mjs:978、984、cli/backtest.mjs:181、205
            let KEYS = '(?:seed|tieSalt|replicaSeeds|replicaNullDraws|timeoutSec|geoTp|geoSl)'
            let re = new RegExp(`\\b(?:st\\.eval|st0\\.eval|cfg|evalCfg|ev0?)\\.${KEYS}\\b`)
            let codeOf = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\/\/.*$/, '')).join('\n')
            let hits = []
            let walk = (d) => {
                for (let e of fs.readdirSync(d, { withFileTypes: true })) {
                    let fp = path.join(d, e.name)
                    if (e.isDirectory()) {
                        walk(fp)
                    }
                    else if (/\.mjs$/.test(e.name) && e.name !== 'cfgNum.mjs') {
                        codeOf(fs.readFileSync(fp, 'utf8')).split('\n').forEach((l, i) => {
                            if (re.test(l)) {
                                hits.push(`${path.relative(FD_ROOT, fp)}:${i + 1}: ${l.trim().slice(0, 120)}`)
                            }
                        })
                    }
                }
            }
            walk(path.join(FD_ROOT, 'src'))
            assert.deepEqual(hits, [])
        })
    })

    describe('api.replaceNull 之 actDays、draws、half(排程第 574 項)與 fillRandom 同一口徑', () => {
        let t
        let ev
        let evBig
        before(() => {
            t = makeTmp('replaceNumsExt')
            writeSynthLedger(t.dir, { n: 60, nBars: 2400, seed: 6 })
            ev = makeEvaluator(loadLedger(t.dir), { ...BASE, seed: 11 })
            //較大之策略庫(各側逾 2 × 50 + 1 隻): 名次寬度之預設 50 與他值之鄰域不同(60 隻者 40 與 50 之鄰域皆涵蓋整側, 分不出預設)
            writeSynthLedger(path.join(t.dir, 'big'), { n: 160, nBars: 1500, seed: 8 })
            evBig = makeEvaluator(loadLedger(path.join(t.dir, 'big')), { ...BASE, seed: 11 })
        })
        after(() => {
            t.cleanup()
        })
        let pickG = (ctx) => ({ ids: [1, 4, 7, 10, 13, 16, 19, 22].map((s) => (s + ctx.k) % ctx.n), group: [0, 0, 0, 1, 1, 1, 2, 2], tag: ctx.k % 2 ? 'a' : 'b' })
        let accept = (sig, book) => book.open < 4
        let runExt = (fn) => {
            let m = ev.evalPolicy(pickG, { accept, ext: [{ name: 'd', fn }] })
            assert.strictEqual(m.ext.d.error, undefined, `擴充診斷拋錯: ${m.ext.d.error}`)
            return m
        }
        let ERR_ACT = 'invalid opt.actDays: must be a non-negative integer (0 for the cumulative entry count)'
        let ERR_DRAWS = 'invalid opt.draws: must be an integer from 1 to 64'
        let label = (v) => (typeof v === 'bigint' ? `${v}n` : (typeof v === 'symbol' || typeof v === 'function' ? typeof v : json(v)))

        it('actDays: 數字字串 ≡ 數字(原: 以 Number.isFinite 篩, 數字字串被靜默當成 0); 0 = 累計、> 0 = 近期, 兩者結果不同(鑑別前提)', () => {
            //對應規格:「actDays 以 Number.isFinite 篩, 數字字串(如 '30')被靜默當成 0 ⇒ 收數字字串並轉型」
            runExt((api) => {
                let n30 = json(api.replaceNull({ actDays: 30, draws: 8 }))
                assert.strictEqual(json(api.replaceNull({ actDays: '30', draws: 8 })), n30, '字串 30 ≡ 數字 30')
                assert.strictEqual(json(api.replaceNull({ actDays: ' 30 ', draws: 8 })), n30, '頭尾空白')
                assert.notStrictEqual(n30, json(api.replaceNull({ actDays: 0, draws: 8 })), '鑑別前提: 近期(30 日)與累計(0)之結果不同')
                assert.strictEqual(json(api.replaceNull({ actDays: '0', draws: 8 })), json(api.replaceNull({ actDays: 0, draws: 8 })), '字串 0 ≡ 數字 0')
                //未給 = 0(累計): undefined 與 null 同
                assert.strictEqual(json(api.replaceNull({ actDays: null, draws: 8 })), json(api.replaceNull({ draws: 8 })))
                assert.strictEqual(json(api.replaceNull({ actDays: undefined, draws: 8 })), json(api.replaceNull({ actDays: 0, draws: 8 })))
                return { text: 'ok' }
            })
        })

        it('actDays 給了而無效 ⇒ 拋固定訊息(同 fillRandom; 不帶輸入值): 負數、小數、非數字字串、空字串、布林、NaN、±Infinity、BigInt、陣列、物件、超出安全整數', () => {
            runExt((api) => {
                let states = api.phases.map((p) => p.bars.map(() => ({ short: 1, long: 1 })))
                for (let v of [-1, '-1', 1.5, '1.5', 'abc', SECRET, '', ' ', true, false, NaN, Infinity, -Infinity, 10n, [], [30], {}, 2 ** 53, '9007199254740993', Symbol('s'), () => 1]) {
                    let m = msgOf(() => api.replaceNull({ actDays: v, draws: 4 }))
                    assert.strictEqual(m, ERR_ACT, `replaceNull actDays ${label(v)}`)
                    assert(!m.includes(SECRET))
                    assert.strictEqual(msgOf(() => api.fillRandom(states, { actDays: v })), m, `fillRandom 同訊息 ${label(v)}`)
                }
                return { text: 'ok' }
            })
        })

        it('draws: 數字字串 ≡ 數字; 上限 64(含)、下限 1; 超過 64 者拋(原: 靜默截斷為 64); 0、負數、小數、非數字、布林 ⇒ 拋(原: 靜默用預設); 與 fillRandom 同訊息', () => {
            //對應規格:「draws 超過 64 靜默截斷 ⇒ 依 K7 收數字字串並轉型、依 K3 定寬嚴(與 fillRandom 一致)」
            runExt((api) => {
                let states = api.phases.map((p) => p.bars.map(() => ({ short: 1, long: 1 })))
                let d8 = api.replaceNull({ draws: 8 })
                assert.strictEqual(d8.draws, 8)
                assert.strictEqual(json(api.replaceNull({ draws: '8' })), json(d8), '字串 8 ≡ 數字 8')
                assert.strictEqual(api.replaceNull({ draws: 64 }).draws, 64, '上限 64 合法')
                assert.strictEqual(api.replaceNull({ draws: '64' }).draws, 64)
                assert.strictEqual(api.replaceNull({ draws: 1 }).draws, 1, '下限 1 合法')
                //未給(undefined、null)= 評估之虛無抽數(此評估器 8 抽)
                assert.strictEqual(api.replaceNull({}).draws, 8)
                assert.strictEqual(api.replaceNull({ draws: null }).draws, 8)
                for (let v of [65, '65', 100, 1000, 0, '0', -1, 1.5, 'abc', SECRET, '', true, false, NaN, Infinity, 10n, [], [8], {}, Symbol('s')]) {
                    let m = msgOf(() => api.replaceNull({ draws: v }))
                    assert.strictEqual(m, ERR_DRAWS, `replaceNull draws ${label(v)}`)
                    assert(!m.includes(SECRET))
                    assert.strictEqual(msgOf(() => api.fillRandom(states, { draws: v })), m, `fillRandom 同訊息 ${label(v)}`)
                }
                return { text: 'ok' }
            })
        })

        it('half: 數字字串 ≡ 數字(原: 數字字串被靜默忽略而用 50); 不合者仍用預設 50(沿用其既有口徑: 負數、小數、非數字、布林); half 為 0 者鄰域只有自己', () => {
            runExt((api) => {
                let h3 = json(api.replaceNull({ half: 3, draws: 8 }))
                assert.strictEqual(json(api.replaceNull({ half: '3', draws: 8 })), h3, '字串 3 ≡ 數字 3')
                assert.notStrictEqual(h3, json(api.replaceNull({ draws: 8 })), '鑑別前提: half 3 與預設 50 之結果不同')
                let dflt = json(api.replaceNull({ draws: 8 }))
                for (let v of [-1, 1.5, 'abc', '', true, NaN, Infinity, [], {}, null, undefined]) {
                    assert.strictEqual(json(api.replaceNull({ half: v, draws: 8 })), dflt, `half ${label(v)} ⇒ 預設`)
                }
                assert.strictEqual(json(api.replaceNull({ half: '0', draws: 8 })), json(api.replaceNull({ half: 0, draws: 8 })))
                return { text: 'ok' }
            })
        })

        it('half 之預設為 50: 較大之策略庫(各側逾 101 隻)上, 未給 ≡ half 50(≢ 40 與 60); 不合者(負數、小數、非數字)≡ 未給', () => {
            let pickBig = (ctx) => ({ ids: [3, 8, 13, 21, 34, 55, 89, 101, 120, 140].map((s) => (s + ctx.k) % ctx.n), group: [0, 0, 0, 1, 1, 1, 2, 2, 3, 3] })
            let fn = (api) => {
                let at = (o) => json(api.replaceNull({ ...o, draws: 8 }))
                let dflt = at({})
                assert.strictEqual(at({ half: 50 }), dflt, '未給 ≡ 50')
                assert.strictEqual(at({ half: '50' }), dflt, '字串 50 ≡ 數字 50')
                assert.notStrictEqual(at({ half: 40 }), dflt, '鑑別前提: 40 之結果不同(鄰域較窄)')
                assert.notStrictEqual(at({ half: 60 }), dflt, '鑑別前提: 60 之結果不同(鄰域較寬)')
                for (let v of [-1, 1.5, 'abc', true, null]) {
                    assert.strictEqual(at({ half: v }), dflt, `half ${label(v)} ⇒ 預設 50`)
                }
                return { text: 'ok' }
            }
            let m = evBig.evalPolicy(pickBig, { accept, ext: [{ name: 'd', fn }] })
            assert.strictEqual(m.ext.d.error, undefined, `擴充診斷拋錯: ${m.ext.d.error}`)
        })

        it('驗證之次序: 形狀之錯(grp、onlyGroups、onlyDecisions)先於 actDays、draws 之值之錯; actDays 先於 draws; 於「成品未分帳」之不適用情形亦先檢查(不因短路而放行)', () => {
            runExt((api) => {
                assert.strictEqual(msgOf(() => api.replaceNull({ grp: 'x', actDays: 'abc', draws: 'abc' })), 'invalid opt.grp: must be an array or typed array with one integer from 0 to opt.nGroups - 1 per strategy (api.n entries)')
                assert.strictEqual(msgOf(() => api.replaceNull({ actDays: 'abc', draws: 'abc' })), ERR_ACT)
                assert.strictEqual(msgOf(() => api.replaceNull({ draws: 'abc' })), ERR_DRAWS)
                assert.strictEqual(msgOf(() => api.replaceNull({ onlyGroups: [0], actDays: -1 })), ERR_ACT, '只換子帳者之 actDays 亦檢查')
                return { text: 'ok' }
            })
            //成品未分帳(pick 未回傳 group): onlyGroups 不適用 ⇒ 不重放; actDays 不合者仍拋
            let m = ev.evalPolicy((ctx) => [1, 4, 7].map((s) => (s + ctx.k) % ctx.n), { accept, ext: [{ name: 'd', fn: (api) => ({ text: String(msgOf(() => api.replaceNull({ onlyGroups: [0], actDays: -1 }))) }) }] })
            assert.strictEqual(m.ext.d.text, ERR_ACT)
        })
    })

    describe('nullGroupActOf 之「鄰域用盡 ⇒ 該席從缺」分支(排程第 574 項之測試守門)', () => {
        let t
        let L
        let ev
        before(() => {
            t = makeTmp('nullExhaust')
            writeSynthLedger(t.dir, { n: 40, nBars: 1500, seed: 11 })
            L = loadLedger(t.dir)
            ev = makeEvaluator(L, { ...BASE, seed: 7 })
        })
        after(() => {
            t.cleanup()
        })

        it('同側同活躍度虛無: 選集 = 做多側名次 5 ~ 9 之五隻、half = 1 ⇒ 部分決策之第 4 席之鄰域已被前面之席用盡而從缺(其後之第 5 席仍照常抽取); 各抽之等效年化 = 獨立之參考模型(依同一亂數與抽法)', () => {
            //對應規格(evalCore nullGroupActOf 檔頭): 「同一選集內不重複; 鄰域內無未用之策略時該席從缺」; 參考模型獨立寫一份(排名: 決策棒以前之累計進場數 → tie → 序號; 抽法: 自名次 ± half 內均勻抽、撞到已用者至多再抽 16 次、仍撞則依序找第一個未用者、全用盡則從缺)
            let longs = Array.from({ length: L.n }, (_, s) => s).filter((s) => L.mode[s] > 0)
            assert(longs.length >= 12, '做多側須有足夠之策略')
            let tie = ev.meta.tie
            let bars = ev.decisionBars(0)
            let ordAt = bars.map((b) => {
                let cnt = new Map(longs.map((s) => {
                    let c = 0
                    for (let j = L.off[s]; j < L.off[s + 1] && L.ent[j] < b; j++) {
                        c++
                    }
                    return [s, c]
                }))
                return longs.slice().sort((x, y) => (cnt.get(x) - cnt.get(y)) || (tie[x] - tie[y]) || (x - y))
            })
            //成品: 每次決策取做多側名次 5 ~ 9 之五隻(升冪序號): half = 1 時各席之鄰域為 3 隻, 第 4 席起才可能用盡(其後之第 5 席仍可抽)
            let sels = ordAt.map((ord) => Int32Array.from(ord.slice(5, 10).sort((a, b) => a - b)))
            let runs = [{ phase: 0, bars, sels, tags: bars.map(() => null) }]
            let DRAWS = 24
            let SEED = 123
            let HALF = 1
            //參考模型
            let refVals = []
            let refSig = 0 //各抽之下單訊號數之和(accept 為 null ⇒ 全收)
            let refSlot = 0 //各抽實際填得之席數之和(從缺之席不計)
            let nMissing = 0
            let nLateFill = 0
            for (let d = 0; d < DRAWS; d++) {
                let rng = mulberry32(SEED + (d + 1) * 7919 + 0 * 104723)
                let rs = bars.map((b, k) => {
                    let ord = ordAt[k]
                    let rankOf = new Map(ord.map((s, i) => [s, i]))
                    let used = new Set()
                    let out = []
                    let missingBefore = false
                    for (let s of sels[k]) {
                        let p = rankOf.get(s)
                        let lo = Math.max(0, p - HALF)
                        let hi = Math.min(ord.length - 1, p + HALF)
                        let v = ord[lo + Math.floor(rng() * (hi - lo + 1))]
                        for (let q = 0; q < 16 && used.has(v); q++) {
                            v = ord[lo + Math.floor(rng() * (hi - lo + 1))]
                        }
                        if (used.has(v)) {
                            v = -1
                            for (let q = lo; q <= hi; q++) {
                                if (!used.has(ord[q])) {
                                    v = ord[q]
                                    break
                                }
                            }
                        }
                        if (v < 0) {
                            nMissing++
                            missingBefore = true
                            continue
                        }
                        if (missingBefore) {
                            nLateFill++
                        }
                        used.add(v)
                        out.push(v)
                    }
                    return Int32Array.from(out).sort()
                })
                let o = ev.opOf(rs, bars, runs[0].tags, null)
                refVals.push(o.eqYr)
                refSig += o.nSignals
                refSlot += rs.reduce((a, s) => a + s.length, 0)
            }
            //鑑別前提(換種子 / 資料時此斷言使測試失敗而非靜默失去鑑別力): 參考模型中確有席從缺, 且確有「從缺之後仍有席抽到」者(使「從缺後即停止填席」之錯亦被抓)
            assert(nMissing > 0, `鑑別前提: 須有鄰域用盡之席(${nMissing}); 請換種子或資料`)
            assert(nLateFill > 0, `鑑別前提: 須有從缺之後仍抽到之席(${nLateFill}); 請換種子或資料`)
            let vals = ev.nullSideActOf(runs, null, DRAWS, SEED, HALF)
            assert.strictEqual(vals.length, DRAWS)
            for (let d = 0; d < DRAWS; d++) {
                assert(Number.isFinite(vals[d]), `抽 ${d}: 有限數(席從缺不得留下無效之序號 -1)`)
                assert(Math.abs(vals[d] - refVals[d]) < 1e-9, `抽 ${d}: ${vals[d]} ≠ 參考 ${refVals[d]}`)
            }
            //每席之平均訊號數(comp.sigPerPick = 各抽之訊號數之和 ÷ 各抽實際填得之席數之和): 從缺之席不計入分母(從缺者留下序號 -1 之席雖不產生訂單, 卻會被計入分母)
            assert(refSlot < DRAWS * bars.length * sels[0].length, '鑑別前提: 填得之席數少於全部之席(有席從缺)')
            assert(Math.abs(vals.comp.sigPerPick - refSig / refSlot) < 1e-9, `sigPerPick ${vals.comp.sigPerPick} ≠ 參考 ${refSig / refSlot}`)
            //另: 以 accept 記錄所下之單之策略: 每個決策之每一抽皆為做多側之策略、序號在 0 ~ n-1(從缺之席不留 -1)
            let seen = []
            ev.nullSideActOf(runs, (sig) => {
                seen.push(sig.sid)
                return true
            }, 4, SEED, HALF)
            assert(seen.length > 0 && seen.every((s) => Number.isInteger(s) && s >= 0 && s < L.n && L.mode[s] > 0), '所下之單皆為做多側之合法策略')
        })
    })

    describe('迴圈之重放(verify.mjs; 子行程: 合成帳本 + 真之評估入口): 設定以數字字串給者 ≡ 以數字給者', function () {
        let t
        before(() => {
            t = makeTmp('runNumsVerify')
        })
        after(() => {
            t.cleanup()
        })
        //含亂數之挑選(重放之選集與 S 隨種子而變)
        let PICK = 'export default function pick(ctx) {\n    let ids = []\n    for (let s = 0; s < ctx.n; s++) {\n        if (ctx.rand() < 0.3) {\n            ids.push(s)\n        }\n    }\n    return ids\n}\n'
        let mkProj = (name, evOver) => {
            let root = path.join(t.dir, name)
            writeSynthLedger(path.join(root, 'ledger', 'eval'), { n: 60, nBars: 2400, seed: 7 })
            fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
            let st0 = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
            let st = {
                ...st0,
                periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } },
                eval: { ledgerDir: './ledger/eval', warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7], nullDraws: 8, fitEnd: { long: '2022-11-01T00:00:00', short: '2023-02-01T00:00:00' }, limits: { monthlyOrders: 4000, peakHold: 500 }, ...evOver },
                rsi: { ...st0.rsi, root: './rsi' },
                records: { nodeDir: './rsi/records/nodes', dreamDir: './rsi/records/dreams', trashDir: './rsi/records/trash', workDir: './rsi/work', toolboxDir: './rsi/toolbox' },
                resources: {},
            }
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(st, null, 1), 'utf8')
            fs.writeFileSync(path.join(root, 'g_eval.mjs'), `process.env.ARSI_ROOT = ${JSON.stringify(root)}\nawait import(${JSON.stringify(pathToFileURL(path.join(FD_ROOT, 'src', 'cli', 'eval.mjs')).href)})\n`, 'utf8')
            let wd = path.join(root, 'rsi', 'work', 'n1')
            fs.mkdirSync(wd, { recursive: true })
            fs.writeFileSync(path.join(wd, 'pick.mjs'), PICK, 'utf8')
            let s = { ...st, FD_ROOT: root, eval: { ...st.eval, ledgerDir: path.join(root, 'ledger', 'eval') }, rsi: { ...st.rsi, root: path.join(root, 'rsi') }, records: { nodeDir: path.join(root, 'rsi/records/nodes'), dreamDir: path.join(root, 'rsi/records/dreams'), trashDir: path.join(root, 'rsi/records/trash'), workDir: path.join(root, 'rsi/work'), toolboxDir: path.join(root, 'rsi/toolbox') } }
            return { root, wd, st: s }
        }
        let verifyOf = async (p) => makeVerify({ st: p.st, FD_ROOT: p.root, layerOfSpec: () => 'A' })({ nodeId: 'n1', spec: { arms: ['A01_nt'], base: null }, workDir: p.wd })
        let seedJson = (p, i) => JSON.parse(fs.readFileSync(path.join(p.wd, `harness_seed${i}.json`), 'utf8'))

        it('seed、replicaSeeds、replicaNullDraws、timeoutSec、limits 為數字字串 ⇒ 重放之次數、各次之種子(seed + i)與同分次序之鹽、虛無抽數、結果與以數字給者逐位相同(原: replicaSeeds、replicaNullDraws 不收字串 ⇒ 不重放或抽數用預設; `seed + i` 於字串之種子為字串相接)', async () => {
            //對應規格:「eval.seed 之字串相接必須消除」「eval.replicaNullDraws 同鍵兩處處置不一致」「eval.replicaSeeds、timeoutSec 不收數字字串」
            let num = mkProj('num', { seed: 20261110, replicaSeeds: 2, replicaNullDraws: 6, timeoutSec: 240 })
            let str = mkProj('str', { seed: '20261110', replicaSeeds: '2', replicaNullDraws: ' 6 ', timeoutSec: '240', limits: { monthlyOrders: '4000', peakHold: '500' } })
            let a = await verifyOf(num)
            let b = await verifyOf(str)
            assert.equal(a.ok, true, JSON.stringify(a).slice(0, 500))
            assert.equal(b.ok, true, JSON.stringify(b).slice(0, 500))
            assert.equal(a.raw.replays.length, 2, '鑑別前提: 兩次重放皆執行(含亂數之成品)')
            assert.notDeepEqual(a.raw.replays[0].S, a.raw.replays[1].S, '鑑別前提: 兩次重放之結果不同(種子不同)')
            for (let i of [1, 2]) {
                //各次重放之種子 = 設定之種子 + i(數值之和; 非字串相接)、同分次序之鹽 = i、虛無抽數 = replicaNullDraws
                for (let p of [num, str]) {
                    let o = seedJson(p, i)
                    assert.strictEqual(o.seed, 20261110 + i, `重放 ${i} 之種子`)
                    assert.strictEqual(o.tieSalt, i)
                    assert.strictEqual(o.metrics.null.draws, 6, '虛無抽數取 replicaNullDraws')
                }
            }
            assert.equal(JSON.stringify(stripMs(b.raw.replays)), JSON.stringify(stripMs(a.raw.replays)), '重放之紀錄逐位相同')
            assert.deepEqual(b.raw.seedS, a.raw.seedS)
            assert.equal(b.raw.metrics.selHash, a.raw.metrics.selHash)
            assert.equal(b.raw.metrics.null.p, a.raw.metrics.null.p)
            assert.equal(JSON.stringify(b.score), JSON.stringify(a.score), '判讀(含以字串給之硬上限)相同')
        })

        it('timeoutSec(字串)為重跑之逾時上限(秒): "0.02" ⇒ 20 毫秒即逾時(行程啟動即逾此; 原 "0.2" 於機器較空閒時評估可於 200 毫秒內完成而偶發不逾時), 訊息帶轉換後之數值; 以字串給之合理值(如 "240")不逾時', async () => {
            let slow = mkProj('tmo', { seed: 3, replicaSeeds: 0, timeoutSec: '0.02' })
            let v = await verifyOf(slow)
            assert.equal(v.ok, false)
            assert.strictEqual(v.error, '重跑逾時(0.02s; 挑選模組過慢)')
            let fine = mkProj('tmoOk', { seed: 3, replicaSeeds: 0, timeoutSec: '240' })
            assert.equal((await verifyOf(fine)).ok, true)
        })

        it('replicaSeeds 為 0(含 "0")⇒ 不重放; 設定給了而無效(replicaSeeds: "x")⇒ 拋 invalid eval.replicaSeeds(原: 靜默為 0 = 不重放)', async () => {
            let z = mkProj('zero', { seed: 3, replicaSeeds: '0' })
            let v = await verifyOf(z)
            assert.equal(v.ok, true)
            assert.equal(v.raw.replays.length, 0)
            let bad = mkProj('bad', { seed: 3, replicaSeeds: 'x' })
            let msg = null
            try {
                await verifyOf(bad)
            }
            catch (err) {
                msg = err.message
            }
            assert.strictEqual(msg, 'invalid eval.replicaSeeds: must be a non-negative integer')
        })
    })

    describe('g_backtest.mjs(回測期重放; 評估帳本與全期帳本為同一份合成): 各複製版之種子 = 設定之種子 + i(數值之和)', function () {
        let t
        before(() => {
            t = makeTmp('runNumsBacktest')
            for (let d of ['eval', 'full']) {
                writeSynthLedger(path.join(t.dir, 'ledger', d), { n: 40, nBars: 2400, seed: 7 })
            }
            fs.mkdirSync(path.join(t.dir, 'rsi'), { recursive: true })
            fs.writeFileSync(path.join(t.dir, 'pick_rand.mjs'), 'export default function pick(ctx) {\n    let ids = []\n    for (let s = 0; s < ctx.n; s++) {\n        if (ctx.rand() < 0.3) {\n            ids.push(s)\n        }\n    }\n    return ids\n}\n', 'utf8')
        })
        after(() => {
            t.cleanup()
        })
        let runBt = (evOver, args = []) => {
            let st = {
                periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } },
                eval: { ledgerDir: './ledger/eval', warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7], nullDraws: 4, limits: { monthlyOrders: 400, peakHold: 50 }, ...evOver },
                score: { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] },
                backtest: { enabled: true, ledgerDir: path.join(t.dir, 'ledger', 'full'), resultDir: path.join(t.dir, 'bt_out'), privateRoot: path.join(t.dir, 'private'), replicas: 2, nullDraws: 4 },
                rsi: { root: './rsi' },
                records: {},
                dispatch: {},
            }
            fs.writeFileSync(path.join(t.dir, 'settings.json'), JSON.stringify(st), 'utf8')
            fs.rmSync(path.join(t.dir, 'bt_out'), { recursive: true, force: true })
            let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'backtest.mjs'), '--pick', path.join(t.dir, 'pick_rand.mjs'), '--name', 'x', '--dir', path.join(t.dir, 'bt_out'), ...args], { cwd: t.dir, env: { ...process.env, ARSI_ROOT: t.dir, ARSI_HARNESS: '1' }, windowsHide: true, encoding: 'utf8', timeout: 300000 })
            let o = null
            try {
                o = stripMs(JSON.parse(fs.readFileSync(path.join(t.dir, 'bt_out', 'x.json'), 'utf8')))
            }
            catch (err) {}
            return { status: r.status, out: `${r.stdout}\n${r.stderr}`, o }
        }

        it('seed 為數字字串 ⇒ 複製版之種子為數值之和(原: 字串相接 "202611101"), 結果與數字者逐位相同; --seed 整數者採用、小數與非數字者拒收', () => {
            let a = runBt({ seed: 20261110 })
            let b = runBt({ seed: '20261110' })
            assert.equal(a.status, 0, a.out.slice(0, 400))
            assert.equal(b.status, 0, b.out.slice(0, 400))
            assert.deepEqual(a.o.replicas.map((x) => x.seed), [20261110, 20261111])
            assert.deepEqual(b.o.replicas.map((x) => x.seed), [20261110, 20261111], '字串之種子 + i 為數值之和')
            assert.equal(JSON.stringify(b.o), JSON.stringify(a.o), '結果檔逐位相同')
            assert.notDeepEqual(a.o.replicas[0].byPhase, a.o.replicas[1].byPhase, '鑑別前提: 兩個複製版之結果不同(含亂數之成品, 種子不同)')
            let s5 = runBt({ seed: 20261110 }, ['--seed', '5'])
            assert.deepEqual(s5.o.replicas.map((x) => x.seed), [5, 6], '--seed 整數者採用')
            //--seed 給了而不是整數(小數、非數字、超出安全整數)⇒ 拒收(離開碼 2; 排程第 595 項之接續, R-EV-53 ③; 原: 說明後忽略而沿用設定之種子 —— 結果與使用者所指定者不同); 不寫結果檔
            for (let sd of ['1.5', 'abc', '1000000000000000000000']) {
                let r = runBt({ seed: 20261110 }, ['--seed', sd])
                assert.equal(r.status, 2, `${sd}: ${r.out.slice(0, 300)}`)
                assert(r.out.split('\n').includes('invalid --seed: must be an integer'), `${sd}: ${r.out.slice(0, 300)}`)
                assert.strictEqual(r.o, null, `${sd}: 不寫結果檔`)
            }
        })

        it('設定之 eval.* 無效 ⇒ ERROR invalid eval.<鍵>、離開碼 2、不寫結果檔; phases 缺鍵 ⇒ 評估器之預設七個相位(原: TypeError)', () => {
            let bad = runBt({ seed: 'abc' })
            assert.equal(bad.status, 2, bad.out.slice(0, 300))
            assert(bad.out.includes('ERROR invalid eval.seed: must be an integer'), bad.out.slice(0, 300))
            assert.strictEqual(bad.o, null, '不寫結果檔')
            let noPhases = runBt({ seed: 1, phases: undefined })
            assert.equal(noPhases.status, 0, noPhases.out.slice(0, 400))
            assert.equal(noPhases.o.op.eqYr.byPhase.length, 7, '七個相位')
        })
    })
})
