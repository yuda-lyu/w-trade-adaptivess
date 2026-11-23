import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { scoreOf } from '../src/eval/score.mjs'
import * as CN from '../src/eval/cfgNum.mjs'
import { checkEvalSettings, configMsgOf } from '../src/eval/barGrid.mjs'
import { initProject } from '../src/tools/initProject.mjs'
import { makeTexts } from '../src/domain/texts.mjs'
import { FD_ROOT, makeTmp, writeSynthLedger } from './tools/synthLedger.mjs'


//settings.score.* 之取值與檢測(判讀之門檻; 排程第 606 項; R-EV-44 ④之二、R-EV-55): scoreOf 與設定之預檢、任務書、合約之參考版共用 evalScoreOf ⇒ 檢查之值即使用之值(K4)
//  規格之句 ⇒ 案: 「score.* 決定結果 ⇒ 給了而無效即拒絕」= 各鍵 × 無效值之全表(訊息固定、不帶輸入值)與預檢(g_eval 於評估之前即拒絕); 「未給 = 預設; 數字字串轉為數值」= 預設表與字串 ≡ 數字;
//    「原值比較」之各形(null 當 0、true 當 1、空字串當 0、陣列、非數字使比較恆假)於修前改變階梯之結果 ⇒ 現為拒絕
//  修前(1.0.47): scoreOf 以原值比較(`S >= score.ladder1.S` 等), 無檢測
let NODE = process.execPath
//新增之具名匯出以命名空間取得(修前之複本無此匯出時, 本檔仍可載入, 各案以斷言失敗呈現而非整檔載入失敗)
let { evalScoreOf, EVAL_SCORE } = CN
let OPT_LIM = { monthlyOrders: 400, peakHold: 50 }
let SC = { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] }
let mk = (o = {}) => ({
    op: { eqYr: { mean: o.mean === undefined ? 40 : o.mean, min: o.min === undefined ? 30 : o.min }, monthlyOrders: { mean: o.mo === undefined ? 80 : o.mo }, peakHold: { max: o.pk === undefined ? 25 : o.pk } },
    fresh: { 7: { eqYr: { mean: o.fresh === undefined ? 20 : o.fresh } }, 30: { eqYr: { mean: o.fresh === undefined ? 20 : o.fresh } } },
    sel: { sizeMax: 40 },
    null: { p: o.p === undefined ? 0.0154 : o.p },
})
let BAD = ['abc', '', '  ', true, false, [], {}, NaN, Infinity, -Infinity, '0x10', '1,5', 10n, [5], () => 1]

describe('settings.score.* 之取值與檢測(R-EV-55)', function () {
    this.timeout(300000)
    let t = makeTmp('scoreCfg')
    after(() => t.cleanup())

    describe('evalScoreOf: 各鍵之全值表', () => {
        //各鍵之預期(獨立寫成): [路徑, 預設, 有效值, 額外之無效值, 訊息之種類描述]
        let KEYS = [
            [['ladder1', 'S'], 15, [[20, 20], ['20', 20], [' 2e1 ', 20], [0, 0], [-5, -5]], [], 'a finite number'],
            [['ladder1', 'nullP'], 0.05, [[0.01, 0.01], ['0.01', 0.01], [0, 0], [1, 1]], [-0.1, 1.1, '2', '-0.01'], 'a number from 0 to 1'],
            [['ladder2', 'freshMin'], 10, [[8, 8], ['8', 8], [-2, -2]], [], 'a finite number'],
            [['ladder2', 'worstPhaseMin'], 5, [[4, 4], ['4', 4], [0, 0]], [], 'a finite number'],
            [['ladder3', 'monthlyOrders'], 300, [[250, 250], ['250', 250], [0, 0]], [-1, '-1'], 'a non-negative number'],
            [['ladder3', 'peakHold'], 30, [[25, 25], ['25', 25], [0, 0]], [-1, '-0.5'], 'a non-negative number'],
        ]
        it('預設: score 未給(undefined / null)或各層未給 ⇒ 15 / 0.05 / 10 / 5 / 300 / 30 / [100, 250](= 參考設定與合約之參考版所寫之值); 其餘之鍵(如 sideFlow)忽略、不入回傳', () => {
            let D = { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] }
            for (let s of [undefined, null, {}, { ladder1: null, ladder2: undefined, ladder3: {} }, { ladder1: {}, freqBands: null }]) {
                assert.deepEqual(evalScoreOf(s), D, JSON.stringify(s))
            }
            assert.deepEqual(evalScoreOf({ ...SC, sideFlow: { hi: 'x' }, extra: 1 }), D)
            assert.deepEqual(Object.keys(EVAL_SCORE), ['ladder1', 'ladder2', 'ladder3'])
            //與參考設定(套件根之 settings.json)一致
            let ref = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8')).score
            assert.deepEqual(evalScoreOf(ref), D, '預設 = 參考設定之值')
        })

        for (let [p, def, ok, extraBad, desc] of KEYS) {
            let name = p.join('.')
            let setAt = (v) => ({ [p[0]]: { [p[1]]: v } })
            it(`${name}: 有效值取轉換值(數字字串去頭尾空白; 轉為數值); 無效 ⇒ 拋 invalid score.${name}: must be ${desc}(固定訊息、不帶輸入值); undefined / null ⇒ 預設 ${def}`, () => {
                for (let [v, want] of ok) {
                    let r = evalScoreOf(setAt(v))
                    assert.strictEqual(r[p[0]][p[1]], want, `${name} = ${JSON.stringify(v)}`)
                    assert.strictEqual(typeof r[p[0]][p[1]], 'number')
                }
                for (let v of [undefined, null]) {
                    assert.strictEqual(evalScoreOf(setAt(v))[p[0]][p[1]], def)
                }
                let bads = [...BAD, ...extraBad]
                for (let v of bads) {
                    let err = null
                    try {
                        evalScoreOf(setAt(v))
                    }
                    catch (e) {
                        err = e
                    }
                    assert.ok(err !== null, `${name} 之無效值(第 ${bads.indexOf(v)} 個)應拋`)
                    assert.ok(err.message === `invalid score.${name}: must be ${desc}`, `${name}: 訊息 ${err.message}`)
                }
            })
        }

        it('freqBands: 兩個非負數(數字字串轉數值); 非陣列、長度不為 2、元素無效(含 null、undefined) ⇒ 拋固定訊息; 元素之訊息帶索引', () => {
            assert.deepEqual(evalScoreOf({ freqBands: ['100', ' 250 '] }).freqBands, [100, 250])
            assert.deepEqual(evalScoreOf({ freqBands: [0, 0] }).freqBands, [0, 0])
            for (let v of ['a', 5, true, {}, [], [1], [1, 2, 3]]) {
                assert.throws(() => evalScoreOf({ freqBands: v }), (e) => e.message === 'invalid score.freqBands: must be an array of two non-negative numbers', JSON.stringify(v))
            }
            for (let [v, i] of [[['a', 1], 0], [[1, 'b'], 1], [[null, 1], 0], [[1, undefined], 1], [[-1, 5], 0], [[1, true], 1], [[NaN, 1], 0], [[1, Infinity], 1]]) {
                assert.throws(() => evalScoreOf({ freqBands: v }), (e) => e.message === `invalid score.freqBands[${i}]: must be a non-negative number`, JSON.stringify(v))
            }
        })

        it('score、各 ladder 非物件(陣列、字串、數字、布林)⇒ 拋 invalid score: must be an object / invalid score.ladderN: must be an object; 呼叫端之物件不被改寫', () => {
            for (let v of [[], 'x', 5, true]) {
                assert.throws(() => evalScoreOf(v), (e) => e.message === 'invalid score: must be an object')
                for (let lad of ['ladder1', 'ladder2', 'ladder3']) {
                    assert.throws(() => evalScoreOf({ [lad]: v }), (e) => e.message === `invalid score.${lad}: must be an object`)
                }
            }
            let o = { ladder1: { S: '12' }, freqBands: ['1', '2'] }
            let snap = JSON.stringify(o)
            evalScoreOf(o)
            assert.strictEqual(JSON.stringify(o), snap)
            //who 可改: 任務書與命令列用 'score'; 其他呼叫端可自訂位置名稱
            assert.throws(() => evalScoreOf({ ladder1: { S: 'x' } }, 'cfg.score'), (e) => e.message === 'invalid cfg.score.ladder1.S: must be a finite number')
        })
    })

    describe('scoreOf: 檢查之值即使用之值', () => {
        let strSc = { ladder1: { S: ' 15 ', nullP: '0.05' }, ladder2: { freshMin: '10', worstPhaseMin: '5' }, ladder3: { monthlyOrders: '300', peakHold: '30' }, freqBands: ['100', '250'] }
        it('數字字串之門檻 ≡ 數字之門檻(S、階梯、旗標、cell、說明文字逐位相同); 於各階梯之邊界值(= 門檻)亦同', () => {
            let n = 0
            for (let o of [{}, { mean: 10, min: 10 }, { p: 0.05 }, { p: 0.06 }, { fresh: 10 }, { fresh: 9.9 }, { min: 5 }, { min: 4.9 }, { mo: 300 }, { mo: 301 }, { pk: 30 }, { pk: 31 }, { mo: 99 }, { mo: 100 }, { mo: 249 }, { mo: 250 }, { mean: 20, min: 10 }]) {
                let a = scoreOf(mk(o), { limits: OPT_LIM, score: SC, layer: 'L1' })
                let b = scoreOf(mk(o), { limits: OPT_LIM, score: strSc, layer: 'L1' })
                assert.deepEqual(b, a, JSON.stringify(o))
                n++
            }
            assert.equal(n, 17)
        })

        it('修前之「原值比較」之各形(null、空字串、true、陣列、非數字)於修前改變階梯 ⇒ 現為拒絕(拋 invalid score.<鍵>); 缺鍵不再為 TypeError(取預設)', () => {
            for (let [lad, key, vals] of [['ladder1', 'S', [true, '', [], 'abc']], ['ladder1', 'nullP', [true, '', [], 'abc']], ['ladder2', 'freshMin', [true, '', 'abc']], ['ladder2', 'worstPhaseMin', [[], 'abc']], ['ladder3', 'monthlyOrders', [true, '', 'abc']], ['ladder3', 'peakHold', [[], 'abc']]]) {
                for (let v of vals) {
                    assert.throws(() => scoreOf(mk(), { limits: OPT_LIM, score: { ...SC, [lad]: { ...SC[lad], [key]: v } } }), (e) => e.message.startsWith(`invalid score.${lad}.${key}: must be `), `${lad}.${key} = ${JSON.stringify(v)}`)
                }
            }
            //缺鍵(修前: TypeError Cannot read properties of undefined)⇒ 預設
            assert.doesNotThrow(() => scoreOf(mk(), { limits: OPT_LIM, score: { ladder1: { S: 15 } } }))
            assert.deepEqual(scoreOf(mk(), { limits: OPT_LIM, score: { ladder1: { S: 15 } } }), scoreOf(mk(), { limits: OPT_LIM, score: SC }))
            assert.doesNotThrow(() => scoreOf(mk(), { limits: OPT_LIM }))
            //無評估結果者(raw 為空)不讀門檻(同改前之先行回傳)
            assert.equal(scoreOf(null, { limits: OPT_LIM, score: { ladder1: 'x' } }).flags.vetoed, true)
        })

        it('門檻之值決定階梯(各門檻 ± 邊界: 單獨移動一個門檻使階梯改變)——以 evalScoreOf 取值後之比較', () => {
            let m = mk({ p: 0.05, fresh: 10, min: 5, mo: 300, pk: 30, mean: 20 })
            //S = 0.7 × 20 + 0.3 × 5 = 15.5
            let at = (patch) => scoreOf(m, { limits: OPT_LIM, score: { ...SC, ...patch } }).ladder
            assert.equal(at({}), 3)
            assert.equal(at({ ladder1: { S: '15.5', nullP: '0.05' } }), 3, 'S = 門檻 ⇒ 過')
            assert.equal(at({ ladder1: { S: '15.51', nullP: '0.05' } }), 0, 'S < 門檻 ⇒ 階梯 0')
            assert.equal(at({ ladder1: { S: 15, nullP: '0.0499' } }), 0)
            assert.equal(at({ ladder2: { freshMin: '10.1', worstPhaseMin: 5 } }), 1)
            assert.equal(at({ ladder2: { freshMin: 10, worstPhaseMin: '5.1' } }), 1)
            assert.equal(at({ ladder3: { monthlyOrders: '299', peakHold: 30 } }), 2)
            assert.equal(at({ ladder3: { monthlyOrders: 300, peakHold: '29' } }), 2)
        })
    })

    describe('設定之預檢與入口(評估之前即拒絕)', () => {
        it('checkEvalSettings: score 不合 ⇒ 拋 invalid score.…; configMsgOf 認得(命令列與迴圈之組裝皆經此)', () => {
            let meta = { time0: '2022-01-01T00:00:00', barHours: 24 }
            let st = (score) => ({ periods: { train: { start: '2022-01-01T00:00:00', end: '2022-06-01T00:00:00' }, backtest: { start: '2022-07-01T00:00:00', end: '2022-12-01T00:00:00' } }, eval: {}, score })
            assert.doesNotThrow(() => checkEvalSettings(st(SC), meta))
            assert.doesNotThrow(() => checkEvalSettings(st(undefined), meta), 'score 未給 ⇒ 預設')
            for (let [score, want] of [[{ ladder1: { S: 'abc' } }, 'invalid score.ladder1.S: must be a finite number'], [{ ladder3: { peakHold: -1 } }, 'invalid score.ladder3.peakHold: must be a non-negative number'], [{ freqBands: [1] }, 'invalid score.freqBands: must be an array of two non-negative numbers'], [[], 'invalid score: must be an object']]) {
                let err = null
                try {
                    checkEvalSettings(st(score), meta)
                }
                catch (e) {
                    err = e
                }
                assert.ok(err !== null && err.message === want, want)
                assert.strictEqual(configMsgOf(err), want, 'configMsgOf 認得 invalid score.')
            }
        })

        it('g_eval 實跑: score 不合 ⇒ 離開碼 2、`ERROR invalid score.…`(固定訊息)、結果檔 { ok: false, code: CONFIG_INVALID }、不記評估紀錄; 字串之門檻 ≡ 數字之門檻(結果檔之 score 相同); 合格者離開碼 0', function () {
            this.timeout(240000)
            let root = path.join(t.dir, 'ev')
            let W = path.join(root, 'rsi', 'work', 'w1')
            fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
            fs.mkdirSync(W, { recursive: true })
            writeSynthLedger(path.join(root, 'ledger', 'eval'), { n: 40, nBars: 2400, seed: 5 })
            let mkSettings = (score) => fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
                periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } },
                eval: { ledgerDir: './ledger/eval', warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7], nullDraws: 4, seed: 1, limits: { monthlyOrders: 400, peakHold: 50 } },
                score,
                rsi: { root: './rsi' },
                records: { workDir: './rsi/work' },
                dispatch: {},
            }), 'utf8')
            fs.writeFileSync(path.join(W, 'pick.mjs'), 'export default function pick(ctx) {\n    let ids = []\n    for (let s = 0; s < ctx.n; s++) {\n        if (ctx.rand() < 0.3) ids.push(s)\n    }\n    return ids\n}\n', 'utf8')
            let run = () => {
                let e = { ...process.env, ARSI_ROOT: root }
                delete e.ARSI_HARNESS
                let fpOut = path.join(root, 'out.json')
                fs.rmSync(fpOut, { force: true })
                fs.rmSync(path.join(W, '.evals.log'), { force: true })
                let r = spawnSync(NODE, [path.join(FD_ROOT, 'src', 'cli', 'eval.mjs'), '--pick', path.join(W, 'pick.mjs'), '--out', fpOut, '--mode', 'quick'], { cwd: root, env: e, windowsHide: true, encoding: 'utf8', timeout: 120000 })
                let o = null
                try {
                    o = JSON.parse(fs.readFileSync(fpOut, 'utf8'))
                }
                catch (err) {}
                return { status: r.status, out: `${r.stdout}`.split(/\r?\n/).filter(Boolean), o, logged: fs.existsSync(path.join(W, '.evals.log')) }
            }
            for (let [score, want] of [
                [{ ...SC, ladder1: { S: 'secret-token-xyz', nullP: 0.05 } }, 'ERROR invalid score.ladder1.S: must be a finite number'],
                [{ ...SC, ladder1: { S: 15, nullP: true } }, 'ERROR invalid score.ladder1.nullP: must be a number from 0 to 1'],
                [{ ...SC, ladder3: { monthlyOrders: -1, peakHold: 30 } }, 'ERROR invalid score.ladder3.monthlyOrders: must be a non-negative number'],
                [{ ...SC, freqBands: 'secret-token-xyz' }, 'ERROR invalid score.freqBands: must be an array of two non-negative numbers'],
            ]) {
                mkSettings(score)
                let r = run()
                assert.strictEqual(r.status, 2, `${want}: ${r.out.join('|').slice(0, 200)}`)
                assert.deepEqual(r.out, [want])
                assert.strictEqual(r.o.ok, false)
                assert.strictEqual(r.o.code, 'CONFIG_INVALID')
                assert.strictEqual(r.logged, false)
            }
            mkSettings(SC)
            let a = run()
            mkSettings({ ladder1: { S: '15', nullP: '0.05' }, ladder2: { freshMin: ' 10 ', worstPhaseMin: '5' }, ladder3: { monthlyOrders: '300', peakHold: '30' }, freqBands: ['100', '250'] })
            let b = run()
            assert.strictEqual(a.status, 0, a.out.join('|').slice(0, 200))
            assert.strictEqual(b.status, 0, b.out.join('|').slice(0, 200))
            let strip = (o) => JSON.stringify(o, (k, v) => (k === 'ms' || k === 'loadMs' || k === 'at' ? undefined : v))
            assert.strictEqual(strip(b.o.score), strip(a.o.score), '字串之門檻 ≡ 數字之門檻')
            assert(a.o.score && typeof a.o.score.S === 'number')
        })

        it('任務書(texts.mjs 之 ladderText): 門檻取 evalScoreOf 之轉換值(數字字串、頭尾空白 ⇒ 與數字之寫法逐字相同); 無效 ⇒ 拋 invalid score.<鍵>; 未給 ⇒ 預設', () => {
            let root = path.join(t.dir, 'txt')
            fs.mkdirSync(root, { recursive: true })
            let stOf = (score) => ({
                FD_ROOT: root,
                rsi: { root: path.join(root, 'rsi'), guides: false },
                records: { nodeDir: path.join(root, 'rsi/records/nodes'), dreamDir: path.join(root, 'rsi/records/dreams'), workDir: path.join(root, 'rsi/work') },
                eval: { ledgerDir: path.join(root, 'ledger'), limits: { monthlyOrders: 400, peakHold: 50 } },
                score,
                periods: { train: { start: '2030-01-01T00:00:00', end: '2031-01-01T00:00:00' }, backtest: { start: '2031-01-01T00:00:00', end: '2031-06-01T00:00:00' }, holdoutFrom: '2031-06-01T00:00:00' },
            })
            let ladder = (score) => [].concat(makeTexts({ st: stOf(score), FD_ROOT: root }).ladderText()).join('\n')
            let numSc = { ladder1: { S: 12, nullP: 0.02 }, ladder2: { freshMin: 8, worstPhaseMin: 4 }, ladder3: { monthlyOrders: 250, peakHold: 25 }, freqBands: [100, 250] }
            let strSc = { ladder1: { S: ' 12 ', nullP: '0.02' }, ladder2: { freshMin: ' 8', worstPhaseMin: '4 ' }, ladder3: { monthlyOrders: '250', peakHold: ' 25 ' }, freqBands: [100, 250] }
            let a = ladder(numSc)
            assert(a.includes('S ≥ 12 且同劑量虛無 p ≤ 0.02') && a.includes('≥ 8 且最差相位 ≥ 4') && a.includes('月均單 ≤ 250 且最大同時持倉 ≤ 25'), a.slice(0, 600))
            assert.strictEqual(ladder(strSc), a, '字串(含頭尾空白)之門檻 ≡ 數字之門檻(原: 字串原樣寫入任務書 —— 頭尾空白亦寫入)')
            assert(ladder(undefined).includes('S ≥ 15 且同劑量虛無 p ≤ 0.05'), '未給 = 預設')
            assert.throws(() => ladder({ ...numSc, ladder1: { S: 'abc', nullP: 0.02 } }), (e) => e.message === 'invalid score.ladder1.S: must be a finite number')
        })

        it('initProject(合約之參考版): score 之數字字串 ⇒ 寫入轉換值; 無效 ⇒ 拒絕(未寫任何檔; 原: 靜默改寫參考版之值); 未給 = 參考版所寫之值', () => {
            let mkRoot = (name, score) => {
                let dir = path.join(t.dir, name)
                fs.mkdirSync(dir, { recursive: true })
                let s = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
                s.resources = {} //資源閘關閉(同 unit-testResources 之守則)
                s.score = score
                if (score === undefined) {
                    delete s.score
                }
                fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(s), 'utf8')
                return dir
            }
            let d1 = mkRoot('ip1', { ladder1: { S: '12', nullP: '0.02' }, ladder2: { freshMin: ' 8 ', worstPhaseMin: '4' }, ladder3: { monthlyOrders: '250', peakHold: '25' } })
            initProject({ root: d1 })
            let c1 = fs.readFileSync(path.join(d1, 'docs', 'pick-contract.md'), 'utf8')
            assert(c1.includes('`S ≥ 12`') && c1.includes('最差相位 ≥ 4') && c1.includes('月均單 ≤ 250 且最大同時持倉 ≤ 25'), '轉換值寫入合約')
            let d2 = mkRoot('ip2', undefined)
            initProject({ root: d2 })
            assert(fs.readFileSync(path.join(d2, 'docs', 'pick-contract.md'), 'utf8').includes('`S ≥ 15`'), '未給 = 參考版之值')
            let d3 = mkRoot('ip3', { ladder1: { S: 'abc' } })
            let before = fs.readdirSync(d3).sort()
            assert.throws(() => initProject({ root: d3 }), (e) => e.message === 'invalid score.ladder1.S: must be a finite number')
            assert.deepEqual(fs.readdirSync(d3).sort(), before, '未寫任何檔')
        })
    })
})
