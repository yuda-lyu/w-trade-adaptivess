import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { cfgNumOf, evalCfgNumsOf, EVAL_NUMS } from '../src/eval/cfgNum.mjs'
import { evalNumsOf, checkEvalSettings, configMsgOf, periodAt } from '../src/eval/barGrid.mjs'
import { loadLedger } from '../src/eval/ledger.mjs'
import { makeEvaluator, ntStaticOf } from '../src/eval/evalCore.mjs'
import { makeTmp, writeSynthLedger, FD_ROOT } from './tools/synthLedger.mjs'


//影響評估之數字(warmupDays、cadenceDays、nullDraws、actBins、sideActHalf)給了而無效即拒絕(規則 R-EV-44 ④之二、④之三)
//  依據: 輸入參數之檢測機制 K3(決定資料口徑之 opt 不退回預設)、K4(檢測之值即使用之值)、K5(布林不當數字)、K7(數字字串收受)、V19(訊息格式)、V20(訊息不帶輸入值)
//  合成帳本: test/tools/synthLedger.mjs(每根 4 小時, 每日 6 根; 起點 2022-07-01T00:00:00); 每根 1 日者以改 meta.barHours 為 24 取得(同 unit-barHours.test.mjs)
let DAY = 86400000
let tms = (s) => Date.parse(`${s}Z`)
let iso = (ms) => new Date(ms).toISOString().slice(0, 19)
let d = (k) => iso(tms('2022-07-01T00:00:00') + k * DAY)
let synthAs = (dir, barHours, opt) => {
    writeSynthLedger(dir, opt)
    if (barHours !== 4) {
        let fp = path.join(dir, 'meta.json')
        let m = JSON.parse(fs.readFileSync(fp, 'utf8'))
        m.barHours = barHours
        fs.writeFileSync(fp, JSON.stringify(m), 'utf8')
    }
}

//INVALID, 五個鍵之共同無效值(布林不當 1 / 0、NaN、±Infinity、非數字字串、十六進位、千分位、全形、空字串、陣列、物件、BigInt、函數、包裝物件)
//eslint-disable-next-line no-new-wrappers
let WRAPPED = new Number(5)
let INVALID = [true, false, NaN, Infinity, -Infinity, 'abc', '', '  ', '0x10', '1,000', '１２３', [5], ['5'], {}, { v: 5 }, 10n, () => 5, WRAPPED]

describe('影響評估之數字給了而無效即拒絕(規則 R-EV-44 ④之二、④之三)', function () {
    this.timeout(180000)
    let t
    before(() => {
        t = makeTmp('evalNums')
    })
    after(() => {
        t.cleanup()
    })

    describe('cfgNumOf / evalCfgNumsOf(單一定義 EVAL_NUMS)', function () {
        it('未給(undefined、null)= 預設;數字原樣;數字字串(含頭尾空白、科學記號)轉為數值;各種類之有效邊界', () => {
            //K3 / V5: undefined 與 null 取預設; K4、K7: 數字字串轉為數值
            for (let kind of ['nonNegNum', 'posNum', 'nonNegInt', 'posInt']) {
                assert.strictEqual(cfgNumOf(undefined, 'DEF', 'x', kind), 'DEF', kind)
                assert.strictEqual(cfgNumOf(null, 'DEF', 'x', kind), 'DEF', kind)
            }
            assert.deepEqual([cfgNumOf(7, 0, 'x', 'posNum'), cfgNumOf('7', 0, 'x', 'posNum'), cfgNumOf(' 7 ', 0, 'x', 'posNum'), cfgNumOf('1e1', 0, 'x', 'posNum'), cfgNumOf(0.5, 0, 'x', 'posNum'), cfgNumOf('0.5', 0, 'x', 'posNum')], [7, 7, 7, 10, 0.5, 0.5])
            assert.deepEqual([cfgNumOf(0, 9, 'x', 'nonNegNum'), cfgNumOf('0', 9, 'x', 'nonNegNum'), cfgNumOf(0, 9, 'x', 'nonNegInt'), cfgNumOf(1, 9, 'x', 'posInt'), cfgNumOf(Number.MAX_SAFE_INTEGER, 9, 'x', 'nonNegInt')], [0, 0, 0, 1, Number.MAX_SAFE_INTEGER])
            //數字逐位不變(含負零之外之一般浮點)
            for (let v of [180, 0.1 + 0.2, 1e-7, 123456789.125]) {
                assert(Object.is(cfgNumOf(v, 0, 'x', 'nonNegNum'), v), String(v))
            }
            assert.deepEqual(evalCfgNumsOf(undefined), { warmupDays: 180, cadenceDays: 7, nullDraws: 64, actBins: 10, sideActHalf: 50 }, '五個鍵之預設')
            assert.deepEqual(evalCfgNumsOf({ warmupDays: '60', cadenceDays: '5', nullDraws: '6', actBins: '4', sideActHalf: '3' }), { warmupDays: 60, cadenceDays: 5, nullDraws: 6, actBins: 4, sideActHalf: 3 })
            assert.deepEqual(Object.keys(EVAL_NUMS), ['warmupDays', 'cadenceDays', 'nullDraws', 'actBins', 'sideActHalf'], '單一定義之鍵')
        })

        it('無效者拋 invalid <名>: must be <種類描述>(V19),訊息不帶輸入值(V20);布林、NaN、±Infinity、非數字字串、BigInt、物件一律無效;值域外(負數、0、小數、超出安全整數)無效', () => {
            let want = { nonNegNum: 'a non-negative number', posNum: 'a positive number', nonNegInt: 'a non-negative integer', posInt: 'a positive integer', binCount: 'an integer from 1 to 256' }
            for (let [kind, desc] of Object.entries(want)) {
                for (let v of INVALID) {
                    assert.throws(() => cfgNumOf(v, 1, 'eval.k', kind), (err) => err instanceof Error && err.message === `invalid eval.k: must be ${desc}`, `${kind} ${String(typeof v === 'bigint' ? `${v}n` : (typeof v === 'function' ? 'fn' : JSON.stringify(v)))}`)
                }
            }
            //值域外
            for (let [kind, vs] of Object.entries({ nonNegNum: [-1, '-1', -0.5, '-1e-3'], posNum: [0, '0', -1, '-2'], nonNegInt: [-1, '-1', 1.5, '1.5', 2 ** 53, '9007199254740993'], posInt: [0, '0', 1.5, -3, 2 ** 53], binCount: [0, '0', 1.5, 257, '1000', -1] })) {
                for (let v of vs) {
                    assert.throws(() => cfgNumOf(v, 1, 'eval.k', kind), (err) => err.message === `invalid eval.k: must be ${want[kind]}`, `${kind} ${String(v)}`)
                }
            }
            //不帶輸入值(V20): 輸入值為獨特字串時, 訊息不含它
            assert.throws(() => cfgNumOf('secret-value-77', 1, 'eval.k', 'posNum'), (err) => !err.message.includes('secret-value-77'))
            //種類名稱本身須合法(內部呼叫之守門)
            assert.throws(() => cfgNumOf(1, 1, 'x', 'nope'), /^Error: invalid kind/)
        })

        it('五個鍵各自之種類與訊息(evalCfgNumsOf;makeEvaluator 稱 cfg、設定之預檢稱 eval)', () => {
            let kinds = { warmupDays: 'a non-negative number', cadenceDays: 'a positive number', nullDraws: 'a non-negative integer', actBins: 'an integer from 1 to 256', sideActHalf: 'a non-negative integer' }
            let bad = { warmupDays: -1, cadenceDays: 0, nullDraws: 1.5, actBins: 0, sideActHalf: -2 }
            for (let [k, desc] of Object.entries(kinds)) {
                assert.throws(() => evalCfgNumsOf({ [k]: bad[k] }, 'eval'), (err) => err.message === `invalid eval.${k}: must be ${desc}`, k)
                assert.throws(() => evalCfgNumsOf({ [k]: 'abc' }, 'cfg'), (err) => err.message === `invalid cfg.${k}: must be ${desc}`, k)
                //其餘之鍵不受影響(只拒絕給了而無效者)
                for (let k2 of Object.keys(kinds).filter((x) => x !== k)) {
                    assert.doesNotThrow(() => evalCfgNumsOf({ [k2]: String(EVAL_NUMS[k2][0]) }), k2)
                }
            }
            //nullDraws 0 = 不算虛無(合法); actBins 0 無效(分層數至少 1)
            assert.equal(evalCfgNumsOf({ nullDraws: 0 }).nullDraws, 0)
            assert.throws(() => evalCfgNumsOf({ actBins: '0' }), /invalid eval\.actBins/)
            //actBins 之上界 256(評估器以 Uint8Array 存層號): 256 合法、257 與 '300' 拒絕
            assert.equal(evalCfgNumsOf({ actBins: 256 }).actBins, 256)
            assert.equal(evalCfgNumsOf({ actBins: '256' }).actBins, 256)
            for (let v of [257, '257', 300, 1e6]) {
                assert.throws(() => evalCfgNumsOf({ actBins: v }), (err) => err.message === 'invalid eval.actBins: must be an integer from 1 to 256', String(v))
            }
        })

        it('evalNumsOf:暖機日數與決策間隔 × 每日棒數須為整數(決策棒以此遞增並作索引);每日 6 根者 0.5 日 = 3 根、0.1 日 = 0.6 根 ⇒ 拒絕;每日 1 根者 0.5 日 ⇒ 拒絕', () => {
            assert.equal(evalNumsOf({ cadenceDays: 0.5 }, 6, 'eval').cadenceDays, 0.5)
            assert.equal(evalNumsOf({ warmupDays: '60.5' }, 2, 'eval').warmupDays, 60.5, '60.5 日 × 每日 2 根 = 121 根')
            assert.equal(evalNumsOf({ warmupDays: 0 }, 1, 'eval').warmupDays, 0, '暖機 0 日合法')
            for (let [ev, bpd, k, kind] of [[{ cadenceDays: 0.1 }, 6, 'cadenceDays', 'a positive'], [{ cadenceDays: 0.5 }, 1, 'cadenceDays', 'a positive'], [{ warmupDays: 0.25 }, 1, 'warmupDays', 'a non-negative'], [{ warmupDays: '180.4' }, 6, 'warmupDays', 'a non-negative']]) {
                assert.throws(() => evalNumsOf(ev, bpd, 'eval'), (err) => err.message === `invalid eval.${k}: must be ${kind} number of days that is a whole number of bars`, JSON.stringify([ev, bpd]))
            }
            //取值之函數同 evalCfgNumsOf(型別之拒絕先於整數之檢查)
            assert.throws(() => evalNumsOf({ cadenceDays: 'x' }, 6, 'eval'), /^Error: invalid eval\.cadenceDays: must be a positive number$/)
        })

        it('configMsgOf:invalid cfg.<鍵> 改稱 invalid eval.<鍵>;設定不合者回訊息,其餘(含 TypeError)回 null', () => {
            assert.equal(configMsgOf(new Error('invalid cfg.nullDraws: must be a non-negative integer')), 'invalid eval.nullDraws: must be a non-negative integer')
            assert.equal(configMsgOf(new Error('invalid cfg.fitEnd.long: must be a time on the bar grid of the ledger')), 'invalid eval.fitEnd.long: must be a time on the bar grid of the ledger')
            for (let m of ['invalid eval.actBins: must be an integer from 1 to 256', 'invalid periods.train.end: must bea time on the bar grid of the ledger', 'invalid ARSI_EVAL_FROM: must be a time on the bar grid of the ledger', 'invalid opt.nullDraws: must be a non-negative integer', 'invalid --null: must be a non-negative integer']) {
                assert.equal(configMsgOf(new Error(m)), m)
            }
            for (let e of [new TypeError('Cannot read properties of undefined (reading \'train\')'), new Error('ENOENT: no such file'), new Error('invalid barHours: must be a positive number of hours that divides 24'), 'oops', null]) {
                assert.strictEqual(configMsgOf(e), null, String(e))
            }
            assert.strictEqual(periodAt({}, 'train', 'end'), undefined)
            assert.strictEqual(periodAt({ periods: { train: null } }, 'train', 'end'), undefined)
            assert.equal(periodAt({ periods: { train: { end: 'E' } } }, 'train', 'end'), 'E')
        })
    })

    describe('評估器(makeEvaluator、evalPolicy)', function () {
        let L4
        let L1
        let pick = (ctx) => [0, 1, 2]
        before(() => {
            synthAs(path.join(t.dir, 'l4'), 4, { n: 24, nBars: 600, seed: 3 })
            synthAs(path.join(t.dir, 'l1'), 24, { n: 24, nBars: 600, seed: 3 })
            L4 = loadLedger(path.join(t.dir, 'l4'))
            L1 = loadLedger(path.join(t.dir, 'l1'))
            for (let L of [L4, L1]) {
                L.ntStatic = ntStaticOf(L, L.nBars)
            }
        })

        it('makeEvaluator:五個鍵各自給了而無效 ⇒ 拋 invalid cfg.<鍵>(每根 4 小時與每根 1 日);數字字串與合法值照常建立', () => {
            let cases = { warmupDays: [-1, 'x', true, NaN], cadenceDays: [0, -3, 'x', true], nullDraws: [-1, 1.5, '1.5', 'x'], actBins: [0, 2.5, 'x', 257], sideActHalf: [-1, 0.5, 'x'] }
            let desc = { warmupDays: 'a non-negative number', cadenceDays: 'a positive number', nullDraws: 'a non-negative integer', actBins: 'an integer from 1 to 256', sideActHalf: 'a non-negative integer' }
            for (let L of [L4, L1]) {
                for (let [k, vs] of Object.entries(cases)) {
                    for (let v of vs) {
                        assert.throws(() => makeEvaluator(L, { warmupDays: 10, cadenceDays: 7, [k]: v }), (err) => err.message === `invalid cfg.${k}: must be ${desc[k]}`, `${L.barsPerDay} ${k} ${String(v)}`)
                    }
                }
                assert.doesNotThrow(() => makeEvaluator(L, { warmupDays: '10', cadenceDays: '7', nullDraws: '4', actBins: '5', sideActHalf: '2' }))
            }
            //日數 × 每日棒數: 3.5 日 = 每日 6 根者 21 根(合法)、每日 1 根者 3.5 根(拒絕)
            assert.doesNotThrow(() => makeEvaluator(L4, { warmupDays: 10, cadenceDays: 3.5 }))
            assert.throws(() => makeEvaluator(L1, { warmupDays: 10, cadenceDays: 3.5 }), (err) => err.message === 'invalid cfg.cadenceDays: must be a positive number of days that is a whole number of bars')
            assert.throws(() => makeEvaluator(L1, { warmupDays: 10.5, cadenceDays: 7 }), (err) => err.message === 'invalid cfg.warmupDays: must be a non-negative number of days that is a whole number of bars')
        })

        it('evalPolicy 之 opt.nullDraws:給了而無效 ⇒ 拋 invalid opt.nullDraws(不退回設定值);未給或 null ⇒ 設定值;數字字串 ⇒ 數值;0 ⇒ 不算虛無', () => {
            let ev = makeEvaluator(L4, { warmupDays: 10, cadenceDays: 7, nullDraws: 5 })
            let calls = 0
            let spy = (ctx) => {
                calls++
                return [0, 1, 2]
            }
            let run = (opt) => ev.evalPolicy(pick, { phases: [0], horizons: [7], seed: 2, ...opt })
            for (let v of [-1, 1.5, 'x', true, [3], {}, NaN, Infinity]) {
                assert.throws(() => run({ nullDraws: v }), (err) => err.message === 'invalid opt.nullDraws: must be a non-negative integer', String(JSON.stringify(v)))
                //檢測先於執行挑選函數(V17: 無效時不留副作用、不耗時)
                assert.throws(() => ev.evalPolicy(spy, { phases: [0], horizons: [7], seed: 2, nullDraws: v }), /invalid opt\.nullDraws/)
            }
            assert.equal(calls, 0, '無效之 opt.nullDraws ⇒ 挑選函數一次都沒被呼叫')
            ev.evalPolicy(spy, { phases: [0], horizons: [7], seed: 2, nullDraws: 2 })
            assert(calls > 0, '鑑別前提: 合法者確會呼叫挑選函數')
            let m0 = run({})
            assert.equal(m0.null.draws, 5, '未給 ⇒ 設定值')
            assert.equal(run({ nullDraws: null }).null.draws, 5, 'null ⇒ 設定值(K3 / V5)')
            assert.equal(run({ nullDraws: '3' }).null.draws, 3, '數字字串 ⇒ 數值')
            assert.equal(run({ nullDraws: 3 }).null.draws, 3)
            assert.strictEqual(run({ nullDraws: 0 }).null, null, '0 ⇒ 不算虛無')
            //p 之分母為 1 + 抽數(數字字串不得字串相接: 1 + '3' = '13')
            let m3 = run({ nullDraws: '3' })
            assert([0.25, 0.5, 0.75, 1].includes(m3.null.p), `p = (1 + ge) / (1 + 3): ${m3.null.p}`)
        })

        it('設定之預檢(checkEvalSettings)與 makeEvaluator 同一取值:合法 ⇒ 不拋;給了而無效 ⇒ 同一種類之拒絕(稱 eval);缺 eval ⇒ 預設合法', () => {
            let meta4 = { time0: '2022-07-01T00:00:00', barHours: 4 }
            let meta1 = { time0: '2022-07-01T00:00:00', barHours: 24 }
            let base = (ev) => ({ periods: { train: { start: d(0), end: d(100) }, backtest: { start: d(110), end: d(150) } }, eval: ev })
            assert.doesNotThrow(() => checkEvalSettings(base(undefined), meta4))
            assert.doesNotThrow(() => checkEvalSettings(base({ warmupDays: '60', cadenceDays: '7', nullDraws: '4', actBins: '5', sideActHalf: '2' }), meta4))
            for (let [ev, msg] of [
                [{ nullDraws: -1 }, 'invalid eval.nullDraws: must be a non-negative integer'],
                [{ actBins: 0 }, 'invalid eval.actBins: must be an integer from 1 to 256'],
                [{ sideActHalf: 'x' }, 'invalid eval.sideActHalf: must be a non-negative integer'],
                [{ warmupDays: false }, 'invalid eval.warmupDays: must be a non-negative number'],
                [{ cadenceDays: [7] }, 'invalid eval.cadenceDays: must be a positive number'],
            ]) {
                for (let meta of [meta4, meta1]) {
                    assert.throws(() => checkEvalSettings(base(ev), meta), (err) => err.message === msg, msg)
                }
            }
            //期間之另兩端(訓練期起點、回測期終點): 缺或不是可解析之時刻字串 ⇒ 設定錯誤(組裝任務書時取其日期, 缺者否則為 TypeError)
            for (let [mut, msg] of [
                [(s) => delete s.periods.train.start, 'invalid periods.train.start: must be a time string (the same format as the K lines)'],
                [(s) => {
                    s.periods.train.start = 20220701
                }, 'invalid periods.train.start: must be a time string (the same format as the K lines)'],
                [(s) => delete s.periods.backtest.end, 'invalid periods.backtest.end: must be a time string (the same format as the K lines)'],
                [(s) => {
                    s.periods.backtest.end = 'soon'
                }, 'invalid periods.backtest.end: must be a time string (the same format as the K lines)'],
            ]) {
                let s = base({})
                mut(s)
                assert.throws(() => checkEvalSettings(s, meta4), (err) => err.message === msg, msg)
            }
            //每日棒數取自帳本: 每根 1 日者 3.5 日 ⇒ 拒絕; 每根 4 小時者合法
            assert.doesNotThrow(() => checkEvalSettings(base({ cadenceDays: 3.5 }), meta4))
            assert.throws(() => checkEvalSettings(base({ cadenceDays: 3.5 }), meta1), (err) => err.message === 'invalid eval.cadenceDays: must be a positive number of days that is a whole number of bars')
        })
    })

    describe('命令列(g_eval.mjs、g_backtest.mjs):設定不合 ⇒ ERROR invalid …、離開碼 2、不印堆疊', function () {
        //合成專案: 評估帳本(每根 4 小時, 2400 根 = 400 日)、訓練期第 10 ~ 250 日、回測期第 270 ~ 390 日
        let mkProj = (name, mut = null) => {
            let root = path.join(t.dir, name)
            writeSynthLedger(path.join(root, 'ledger', 'eval'), { n: 40, nBars: 2400, seed: 7 })
            fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
            let s = {
                periods: { train: { start: d(10), end: d(250) }, backtest: { start: d(270), end: d(390) } },
                eval: { ledgerDir: './ledger/eval', warmupDays: 10, cadenceDays: 7, phases: [0], horizons: [7], nullDraws: 4, seed: 1, limits: { monthlyOrders: 400, peakHold: 50 } },
                score: { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] },
                rsi: { root: './rsi' },
                records: {},
                dispatch: {},
            }
            if (mut) {
                mut(s)
            }
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(s), 'utf8')
            fs.writeFileSync(path.join(root, 'pick_all.mjs'), 'export default function pick(ctx) { return [0, 1, 2, 3, 4, 5] }\n', 'utf8')
            return root
        }
        let run = (root, args, env = {}) => {
            let e = { ...process.env, ARSI_ROOT: root, ...env }
            if (!('ARSI_HARNESS' in env)) {
                delete e.ARSI_HARNESS
            }
            let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'eval.mjs'), ...args], { cwd: root, env: e, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            return { status: r.status, out: `${r.stdout}\n${r.stderr}`, stdout: r.stdout }
        }
        let noStack = (out) => !/\n\s+at |TypeError/.test(out)

        it('g_eval.mjs:影響評估之數字給了而無效 ⇒ ERROR invalid eval.<鍵>、離開碼 2、不記評估紀錄;給 --out 者寫 { ok: false, code: CONFIG_INVALID }', () => {
            for (let [k, v, msg] of [
                ['nullDraws', -1, 'invalid eval.nullDraws: must be a non-negative integer'],
                ['nullDraws', 'x', 'invalid eval.nullDraws: must be a non-negative integer'],
                ['cadenceDays', 0, 'invalid eval.cadenceDays: must be a positive number'],
                ['cadenceDays', 0.1, 'invalid eval.cadenceDays: must be a positive number of days that is a whole number of bars'],
                ['warmupDays', true, 'invalid eval.warmupDays: must be a non-negative number'],
                ['actBins', 0, 'invalid eval.actBins: must be an integer from 1 to 256'],
                ['actBins', 300, 'invalid eval.actBins: must be an integer from 1 to 256'],
                ['sideActHalf', 2.5, 'invalid eval.sideActHalf: must be a non-negative integer'],
            ]) {
                for (let mode of ['quick', 'full']) {
                    let root = mkProj(`bad_${k}_${mode}_${String(v).replace(/\W/g, '')}`, (s) => {
                        s.eval[k] = v
                    })
                    let fp = path.join(root, 'out.json')
                    let r = run(root, ['--pick', 'pick_all.mjs', '--mode', mode, '--out', fp])
                    assert.equal(r.status, 2, `${k}=${String(v)} ${mode}: ${r.out.slice(0, 300)}`)
                    assert(r.out.includes(`ERROR ${msg}`) && noStack(r.out), `${k}=${String(v)} ${mode}: ${r.out.slice(0, 300)}`)
                    let o = JSON.parse(fs.readFileSync(fp, 'utf8'))
                    assert.deepEqual([o.ok, o.code, o.error], [false, 'CONFIG_INVALID', msg])
                    assert.equal(fs.existsSync(path.join(root, '.evals.log')), false, '不記評估紀錄')
                }
            }
        })

        it('g_eval.mjs:數值類設定以數字字串給者與數字者之結果逐位相同(quick 與 full;決策間隔之地平線、虛無抽數、活躍度分層、名次寬度皆取轉型後之數值)', () => {
            let evs = [{ warmupDays: 10, cadenceDays: 5, nullDraws: 4, actBins: 4, sideActHalf: 3 }, { warmupDays: '10', cadenceDays: '5', nullDraws: '4', actBins: '4', sideActHalf: '3' }]
            //(--ext-test 之試跑另有一處以決策間隔為地平線,但不寫結果檔、api 亦不暴露地平線 ⇒ 觀察不到, 見變異 V13 之等價說明)
            for (let mode of ['quick', 'full']) {
                let outs = evs.map((ev, i) => {
                    let root = mkProj(`str_${mode}_${i}`, (s) => Object.assign(s.eval, ev))
                    let fp = path.join(root, 'out.json')
                    let r = run(root, ['--pick', 'pick_all.mjs', '--mode', mode, '--out', fp])
                    assert.equal(r.status, 0, `${mode} ${i}: ${r.out.slice(0, 400)}`)
                    let o = JSON.parse(fs.readFileSync(fp, 'utf8'))
                    delete o.metrics.ms
                    return o
                })
                //嚴格比對(deepStrictEqual): 數字字串不得以字串留在結果內(例: quick 之 horizons 為 [5] 不是 ['5'])
                assert.deepStrictEqual(outs[1].metrics, outs[0].metrics, `${mode}: 數字字串 = 數字`)
                assert.deepStrictEqual(outs[1].metrics.horizons, [mode === 'full' ? 7 : 5], `${mode}: 地平線為數值(quick 取決策間隔 5 日;full 取設定之 horizons)`)
                assert.strictEqual(outs[1].metrics.period.cadenceDays, 5, '結果檔之決策間隔為數值')
                assert.strictEqual(outs[1].metrics.period.warmupDays, 10)
                if (mode === 'quick') {
                    //quick 之地平線取決策間隔(5 日): 數字字串不得以字串進入 opt.horizons
                    assert.deepEqual(Object.keys(outs[1].metrics.fresh), ['5'], 'quick 之地平線')
                }
                else {
                    assert.strictEqual(outs[1].metrics.null.draws, 4, '虛無抽數為數值')
                }
            }
        })

        it('g_eval.mjs --null:給了而不是非負整數(負數、小數、非數字、無值)⇒ invalid --null、離開碼 2(不靜默忽略);0 與正整數照常;未給 ⇒ 依模式與設定', () => {
            let root = mkProj('nullArg')
            for (let args of [['--null', '-1'], ['--null', '1.5'], ['--null', 'abc'], ['--null'], ['--period', 'train', '--null', 'abc'], ['--period', 'postfit', '--mode', 'full', '--null', '-3']]) {
                //單值旗標不重複給(排程第 547 項: 重複之 --mode 於通用之檢查即拒): 自帶 --mode 者不再加預設之 --mode quick
                let r = run(root, ['--pick', 'pick_all.mjs', ...(args.includes('--mode') ? [] : ['--mode', 'quick']), ...args])
                assert.equal(r.status, 2, `${args.join(' ')}: ${r.out.slice(0, 300)}`)
                assert(/^invalid --null: must be a non-negative integer$/m.test(r.stdout) && noStack(r.out), `${args.join(' ')}: ${r.out.slice(0, 300)}`)
            }
            let fp = path.join(root, 'n3.json')
            assert.equal(run(root, ['--pick', 'pick_all.mjs', '--mode', 'quick', '--null', '3', '--out', fp]).status, 0)
            assert.equal(JSON.parse(fs.readFileSync(fp, 'utf8')).metrics.null.draws, 3)
            let fp0 = path.join(root, 'n0.json')
            assert.equal(run(root, ['--pick', 'pick_all.mjs', '--mode', 'full', '--null', '0', '--out', fp0]).status, 0)
            assert.strictEqual(JSON.parse(fs.readFileSync(fp0, 'utf8')).metrics.null, null, '--null 0 ⇒ 不算虛無')
            //--period postfit 須有虛無: 設定之 nullDraws 無效 ⇒ 同樣拒絕(離開碼 2), 不以 TypeError 結束
            let rootP = mkProj('nullArgPostfit', (s) => {
                s.eval.nullDraws = 'x'
            })
            let rp = run(rootP, ['--pick', 'pick_all.mjs', '--mode', 'full', '--period', 'postfit'])
            assert.equal(rp.status, 2)
            assert(/^ERROR invalid eval\.nullDraws: must be a non-negative integer$/m.test(rp.stdout) && noStack(rp.out), rp.out.slice(0, 300))
        })

        it('g_eval.mjs:缺 periods / periods.train / periods.backtest(或非物件)⇒ ERROR invalid periods.…、離開碼 2、寫 CONFIG_INVALID,不以 TypeError 結束(與組裝專案時同一組檢查)', () => {
            for (let [name, mut, msg] of [
                ['noPeriods', (s) => {
                    delete s.periods
                }, 'invalid periods.train.end: must be a time on the bar grid of the ledger'],
                ['noTrain', (s) => {
                    delete s.periods.train
                }, 'invalid periods.train.end: must be a time on the bar grid of the ledger'],
                ['noBt', (s) => {
                    delete s.periods.backtest
                }, 'invalid periods.backtest.start: must be a time on the bar grid of the ledger'],
                ['btStr', (s) => {
                    s.periods.backtest = 'x'
                }, 'invalid periods.backtest.start: must be a time on the bar grid of the ledger'],
                ['noBtStart', (s) => {
                    delete s.periods.backtest.start
                }, 'invalid periods.backtest.start: must be a time on the bar grid of the ledger'],
                ['noTrainStart', (s) => {
                    delete s.periods.train.start
                }, 'invalid periods.train.start: must be a time string (the same format as the K lines)'],
                ['noBtEnd', (s) => {
                    delete s.periods.backtest.end
                }, 'invalid periods.backtest.end: must be a time string (the same format as the K lines)'],
            ]) {
                let root = mkProj(`np_${name}`, mut)
                let fp = path.join(root, 'out.json')
                let r = run(root, ['--pick', 'pick_all.mjs', '--mode', 'quick', '--out', fp])
                assert.equal(r.status, 2, `${name}: ${r.out.slice(0, 400)}`)
                assert(r.out.includes(`ERROR ${msg}`) && noStack(r.out), `${name}: ${r.out.slice(0, 400)}`)
                assert.deepEqual([JSON.parse(fs.readFileSync(fp, 'utf8')).code], ['CONFIG_INVALID'], name)
            }
        })

        it('g_backtest.mjs:缺 periods.train / periods.backtest ⇒ ERROR invalid periods.…、離開碼 2;影響評估之數字無效 ⇒ ERROR invalid eval.<鍵>、離開碼 2;不以 TypeError 結束、不寫結果檔', () => {
            let mkBt = (name, mut) => {
                let root = mkProj(name, (s) => {
                    s.backtest = { ledgerDir: path.join(t.dir, name, 'ledger', 'full'), resultDir: path.join(t.dir, name, 'bt_out'), privateRoot: path.join(t.dir, `${name}_private`), replicas: 1 }
                    mut(s)
                })
                writeSynthLedger(path.join(root, 'ledger', 'full'), { n: 40, nBars: 2400, seed: 7 })
                return root
            }
            let runBt = (root) => {
                let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'backtest.mjs'), '--pick', path.join(root, 'pick_all.mjs'), '--name', 'x', '--dir', path.join(root, 'bt_out')], { cwd: root, env: { ...process.env, ARSI_ROOT: root, ARSI_HARNESS: '1' }, windowsHide: true, encoding: 'utf8', timeout: 120000 })
                return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
            }
            for (let [name, mut, msg] of [
                ['noPeriods', (s) => {
                    delete s.periods
                }, 'invalid periods.train.end: must be a time on the bar grid of the ledger'],
                ['noTrain', (s) => {
                    delete s.periods.train
                }, 'invalid periods.train.end: must be a time on the bar grid of the ledger'],
                ['noBt', (s) => {
                    delete s.periods.backtest
                }, 'invalid periods.backtest.start: must be a time on the bar grid of the ledger'],
                ['nullDraws', (s) => {
                    s.eval.nullDraws = -2
                }, 'invalid eval.nullDraws: must be a non-negative integer'],
                ['cadence', (s) => {
                    s.eval.cadenceDays = 'x'
                }, 'invalid eval.cadenceDays: must be a positive number'],
            ]) {
                let root = mkBt(`bt_${name}`, mut)
                let r = runBt(root)
                assert.equal(r.status, 2, `${name}: ${r.out.slice(0, 400)}`)
                assert(r.out.includes(`ERROR ${msg}`) && noStack(r.out), `${name}: ${r.out.slice(0, 400)}`)
                assert.equal(fs.existsSync(path.join(root, 'bt_out')), false, `${name}: 不寫結果檔`)
            }
            //全期帳本之 time0 無效而又缺 periods.train:預檢對無效之帳本 meta 不檢(交由既有之離開碼 5 路徑),其後之各處讀取仍不得以 TypeError 結束
            let rootX = mkBt('bt_badmeta', (s) => {
                delete s.periods.train
            })
            let fpM = path.join(rootX, 'ledger', 'full', 'meta.json')
            let mm = JSON.parse(fs.readFileSync(fpM, 'utf8'))
            mm.time0 = 'garbage'
            fs.writeFileSync(fpM, JSON.stringify(mm), 'utf8')
            let rx = runBt(rootX)
            assert.equal(rx.status, 5, rx.out.slice(0, 400))
            assert(/time0 或 barHours 無效/.test(rx.out) && noStack(rx.out), rx.out.slice(0, 400))
        })
    })
})
