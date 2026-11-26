import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { pathToFileURL } from 'url'
import runStrategy from 'w-trade-backtest/src/runStrategy.mjs'
import ott from 'w-trade-backtest/src/ott.mjs'
import { normBarHours, onBarGrid, trainFromBarOf, checkEvalSettings } from '../src/eval/barGrid.mjs'
import { cfgNumOf } from '../src/eval/cfgNum.mjs'
import { buildLedger } from '../src/eval/ledgerBuild.mjs'
import { loadLedger, loadIds } from '../src/eval/ledger.mjs'
import { makeEvaluator, ntStaticOf } from '../src/eval/evalCore.mjs'
import { makeTexts } from '../src/domain/texts.mjs'
import { sideFlowCfgOf, SIDE_FLOW } from '../src/domain/verify.mjs'
import { buildPickStore } from '../src/domain/pickStore.mjs'
import { initProject, renderContract } from '../src/tools/initProject.mjs'
import { makeTmp, writeSynthLedger, FD_ROOT } from './tools/synthLedger.mjs'


//每根 K 棒之時長之一般化(規則 R-EV-44)與文字不寫死策略庫之事實(規則 R-REC-36)
//  合成資料: 自 2020-01-01(無時區字串, 當地 00:00)起 760 日之每根 4 小時 K 線(4560 根; 開高低收量逐根相異), 每根 1 日者由每日 6 根聚合;
//    3 個因子(序列逐根相異)、10 隻策略(方向、止盈、止損、手續費、條件與門檻逐隻相異); 同一價格路徑建兩種週期之策略庫
let DAY = 86400000
let H4 = 4 * 3600000
let TIME0 = '2020-01-01T00:00:00'
let tms = (s) => Date.parse(`${s}Z`)
let iso = (ms) => new Date(ms).toISOString().slice(0, 19)
let lcg = (seed) => {
    let a = seed >>> 0
    return () => {
        a = (Math.imul(a, 1664525) + 1013904223) >>> 0
        return a / 4294967296
    }
}
let barsOf = (days, seed) => {
    let r = lcg(seed)
    let b4 = []
    let c = 1000
    for (let i = 0; i < days * 6; i++) {
        let o = c * (1 + (r() - 0.5) * 0.002) + i * 1e-7
        c = Math.max(1, o * (1 + (r() - 0.5) * 0.04 + 0.0002))
        b4.push({ time: iso(tms(TIME0) + i * H4), Open: o, High: Math.max(o, c) * (1 + r() * 0.012) + i * 1e-7, Low: Math.min(o, c) * (1 - r() * 0.012) - i * 1e-7, Close: c, Volumn: 1000 + r() * 500 + i * 1e-3 })
    }
    let b1 = []
    for (let d = 0; d < days; d++) {
        let g = b4.slice(d * 6, d * 6 + 6)
        b1.push({ time: g[0].time, Open: g[0].Open, High: Math.max(...g.map((x) => x.High)), Low: Math.min(...g.map((x) => x.Low)), Close: g[5].Close, Volumn: g.reduce((s, x) => s + x.Volumn, 0) })
    }
    return { b4, b1 }
}
//writeLib, 合成策略庫(ohlc / param / strategies); intervalSecOf(s) 回各策略之 settings.intervalSec(undefined 為不帶)
let writeLib = (dir, key, bars, intervalSecOf = () => undefined) => {
    for (let d of ['ohlc', 'param', 'strategies']) {
        fs.mkdirSync(path.join(dir, d), { recursive: true })
    }
    fs.writeFileSync(path.join(dir, 'ohlc', `${key}.json`), JSON.stringify(bars))
    let F = { f_ret3: [], f_rng1: [], index_f_z5: [] }
    bars.forEach((b, i) => {
        if (i >= 3) {
            F.f_ret3.push({ time: b.time, param: (b.Close - bars[i - 3].Close) / bars[i - 3].Close })
        }
        F.f_rng1.push({ time: b.time, param: (b.High - b.Low) / b.Close })
        if (i >= 5) {
            F.index_f_z5.push({ time: b.time, param: Math.sin(i * 0.37) + i * 1e-6 })
        }
    })
    for (let [k, arr] of Object.entries(F)) {
        fs.writeFileSync(path.join(dir, 'param', `${k}.json`), JSON.stringify(arr))
    }
    let q = (arr, p) => arr.map((x) => x.param).sort((a, b) => a - b)[Math.floor(p * (arr.length - 1))]
    for (let s = 0; s < 10; s++) {
        let long = s % 2 === 0
        let conds = [{ key: 'f_ret3', sym: long ? '>' : '<', th: q(F.f_ret3, long ? 0.8 - s * 0.01 : 0.2 + s * 0.01), opr: 'and' }]
        if (s % 3 === 0) {
            conds.push({ key: 'f_rng1', sym: '>', th: q(F.f_rng1, 0.3 + s * 0.005), opr: 'and' })
        }
        if (s % 4 === 1) {
            conds.push({ key: 'index_f_z5', sym: '<', th: 0.5 + s * 0.01, opr: 'and' })
        }
        let isec = intervalSecOf(s)
        let settings = { rTakeProfit: 0.02 + s * 0.003, rStopLoss: 0.015 + s * 0.0025, rFee: 0.0005 + s * 0.00001, ...(isec !== undefined ? { intervalSec: isec } : {}) }
        fs.writeFileSync(path.join(dir, 'strategies', `s${String(s).padStart(2, '0')}.json`), JSON.stringify({ mode: long ? 'long' : 'short', settings, conds, levelNumTrade: s + 1 }))
    }
}
let quiet = () => {}
let filesOf = (dir) => fs.readdirSync(dir).sort()
//synthDaily, 合成帳本(test/tools/synthLedger.mjs)改標為每根 1 日(帳本之內容為抽象之棒序; time0 為 00:00 ⇒ 每根 1 日亦合法)
let synthDaily = (dir, opt) => {
    let info = writeSynthLedger(dir, opt)
    let fp = path.join(dir, 'meta.json')
    let m = JSON.parse(fs.readFileSync(fp, 'utf8'))
    m.barHours = 24
    fs.writeFileSync(fp, JSON.stringify(m), 'utf8')
    return info
}

describe('每根 K 棒之時長之一般化(規則 R-EV-44)', function () {
    this.timeout(180000)
    let t
    let lib4
    let lib1
    let bars
    before(async () => {
        t = makeTmp('barHours')
        bars = barsOf(760, 20261119)
        lib4 = path.join(t.dir, 'lib4')
        lib1 = path.join(t.dir, 'lib1')
        writeLib(lib4, 'SYN_4hr', bars.b4)
        writeLib(lib1, 'SYN_1day', bars.b1)
        //④⑤⑥ 共用之帳本: 同一價格路徑之兩種週期(終點 2021-12-01)
        await buildLedger({ libraryRoot: lib4, keyOhlc: 'SYN_4hr', endTime: '2021-12-01T00:00:00', outDir: path.join(t.dir, 'e4'), barHours: 4, log: quiet })
        await buildLedger({ libraryRoot: lib1, keyOhlc: 'SYN_1day', endTime: '2021-12-01T00:00:00', outDir: path.join(t.dir, 'e1'), barHours: 24, log: quiet })
    })
    after(() => {
        t.cleanup()
    })

    describe('① barHours 須整除 24 小時(normBarHours;buildLedger 於讀任何檔之前檢查)', function () {
        it('整除 24 者通過並轉為數值(數字字串亦收);其餘(5、7、48、168、0、負數、非數字、非有限、陣列)拋 invalid barHours,訊息不帶輸入值', () => {
            //R-EV-44 ①: 每根之分鐘數整除 1440
            for (let [v, want] of [[1, 1], [2, 2], [3, 3], [4, 4], [6, 6], [8, 8], [12, 12], [24, 24], [0.5, 0.5], ['24', 24], [' 4 ', 4]]) {
                assert.strictEqual(normBarHours(v), want, JSON.stringify(v))
            }
            //onBarGrid: 與 time0 之差為每根毫秒數之整數倍者才在格線上(非字串、無法解析者否)
            assert.deepEqual([onBarGrid('2020-01-08T00:00:00', tms(TIME0), DAY), onBarGrid('2020-01-08T04:00:00', tms(TIME0), DAY), onBarGrid('2020-01-08T04:00:00', tms(TIME0), H4), onBarGrid('abc', tms(TIME0), DAY), onBarGrid(12345, tms(TIME0), DAY)], [true, false, true, false, false])
            for (let v of [5, 7, 48, 168, 0, -4, '5', 'abc', '', null, undefined, NaN, Infinity, [24], { v: 24 }, true]) {
                assert.throws(() => normBarHours(v, 'source.barHours'), (err) => err.message === 'invalid source.barHours: must be a positive number of hours that divides 24 (e.g. 1, 2, 4, 6, 12 or 24)', JSON.stringify(v))
            }
        })

        it('buildLedger:barHours 不合者於讀任何檔之前拋錯(策略庫路徑不存在亦然)、不建輸出夾;數字字串之 24 與數字之 24 之帳本逐位相同', async () => {
            let out = path.join(t.dir, 'bad')
            //策略庫不存在: 若先讀檔會是 ENOENT; 拋 invalid barHours 即證明檢查先於讀檔
            await assert.rejects(buildLedger({ libraryRoot: path.join(t.dir, 'nolib'), keyOhlc: 'x', endTime: '2021-12-01T00:00:00', outDir: out, barHours: 48, log: quiet }), /^Error: invalid barHours: must be/)
            assert.equal(fs.existsSync(out), false, '未建輸出夾')
            let a = await buildLedger({ libraryRoot: lib1, keyOhlc: 'SYN_1day', endTime: '2021-12-01T00:00:00', outDir: path.join(t.dir, 'd_num'), barHours: 24, log: quiet })
            let b = await buildLedger({ libraryRoot: lib1, keyOhlc: 'SYN_1day', endTime: '2021-12-01T00:00:00', outDir: path.join(t.dir, 'd_str'), barHours: '24', log: quiet })
            assert.strictEqual(b.barHours, 24, '轉為數值')
            assert.equal(a.key, b.key)
            for (let f of filesOf(path.join(t.dir, 'd_num')).filter((f) => f !== 'meta.json')) {
                assert(fs.readFileSync(path.join(t.dir, 'd_num', f)).equals(fs.readFileSync(path.join(t.dir, 'd_str', f))), f)
            }
        })

        it('每根 1 日之策略庫:barHours 24 可建、載入之 barsPerDay 為 1;barHours 4(或未給 = 4)⇒ K 線不連續(不靜默)', async () => {
            let m = await buildLedger({ libraryRoot: lib1, keyOhlc: 'SYN_1day', endTime: '2021-12-01T00:00:00', outDir: path.join(t.dir, 'd1'), barHours: 24, log: quiet })
            assert.equal(m.barHours, 24)
            assert.equal(m.nBars, 700, '2020-01-01 ~ 2021-12-01(不含)= 700 日')
            assert.equal(loadLedger(path.join(t.dir, 'd1')).barsPerDay, 1)
            await assert.rejects(buildLedger({ libraryRoot: lib1, keyOhlc: 'SYN_1day', endTime: '2021-12-01T00:00:00', outDir: path.join(t.dir, 'dx'), log: quiet }), /K 線不連續/)
        })
    })

    describe('② 策略檔之每根秒數之宣告(settings.intervalSec)須等於 barHours × 3600', function () {
        it('等於者(數字與數字字串)照建、帳本與未帶此欄者逐位相同;不等者(含非數字)拋 invalid settings.intervalSec of strategy <檔>,不寫出', async () => {
            let ok = path.join(t.dir, 'libI_ok')
            writeLib(ok, 'SYN_1day', bars.b1, (s) => (s % 2 === 0 ? 86400 : '86400'))
            let a = await buildLedger({ libraryRoot: ok, keyOhlc: 'SYN_1day', endTime: '2021-12-01T00:00:00', outDir: path.join(t.dir, 'i_ok'), barHours: 24, log: quiet })
            let b = await buildLedger({ libraryRoot: lib1, keyOhlc: 'SYN_1day', endTime: '2021-12-01T00:00:00', outDir: path.join(t.dir, 'i_none'), barHours: 24, log: quiet })
            assert.equal(a.key, b.key)
            for (let f of filesOf(path.join(t.dir, 'i_ok')).filter((f) => f !== 'meta.json')) {
                assert(fs.readFileSync(path.join(t.dir, 'i_ok', f)).equals(fs.readFileSync(path.join(t.dir, 'i_none', f))), f)
            }
            //非整數之近值(86400.4)亦拒: 比較為數值相等, 不取整
            for (let [name, bad] of [['h4', 14400], ['str', 'abc'], ['zero', 0], ['frac', 86400.4], ['fracStr', '86399.6']]) {
                let lib = path.join(t.dir, `libI_${name}`)
                writeLib(lib, 'SYN_1day', bars.b1, (s) => (s === 7 ? bad : 86400))
                let out = path.join(t.dir, `i_${name}`)
                await assert.rejects(buildLedger({ libraryRoot: lib, keyOhlc: 'SYN_1day', endTime: '2021-12-01T00:00:00', outDir: out, barHours: 24, log: quiet }), (err) => err.message === 'invalid settings.intervalSec of strategy s07.json: must equal barHours * 3600', name)
                assert.equal(fs.existsSync(out), false, `${name}: 不寫出`)
            }
        })
    })

    describe('③ 外部序列對不到棒之比例上限(seriesOffGridMax;選配)', function () {
        let serDir
        before(() => {
            //每根 4 小時之序列(值逐列相異)餵給每根 1 日之帳本: 每日只對到 00:00 之一列
            serDir = path.join(t.dir, 'ser4')
            fs.mkdirSync(serDir, { recursive: true })
            fs.writeFileSync(path.join(serDir, 'fund.json'), JSON.stringify(bars.b4.map((b, i) => ({ time: b.time, value: 0.0001 * i + Math.cos(i) * 1e-3 }))))
        })
        it('未給 ⇒ 只記錄(行為不變);給了而占比超過 ⇒ 拋 invalid series <名>、不寫出;未超過(或恰等於)⇒ 照建且與未給者逐位相同', async () => {
            let base = { libraryRoot: lib1, keyOhlc: 'SYN_1day', endTime: '2021-12-01T00:00:00', barHours: 24, seriesDir: serDir }
            let logs = []
            await buildLedger({ ...base, outDir: path.join(t.dir, 's_none'), log: (s) => logs.push(s) })
            assert(logs.some((s) => /注意: 外部序列 fund: 3500 列之時間對不到棒/.test(s)), '未給: 只記錄(700 日 × 5 列)')
            let out = path.join(t.dir, 's_bad')
            await assert.rejects(buildLedger({ ...base, outDir: out, seriesOffGridMax: 0.5, log: quiet }), (err) => /^invalid series fund: off-grid rows exceed seriesOffGridMax \(3500 of 4200 rows within the ledger;/.test(err.message))
            assert.equal(fs.existsSync(out), false, '不寫出')
            //占比恰為 5/6: 上限 = 5/6 者通過(超過才拒)、略小於者拒
            await buildLedger({ ...base, outDir: path.join(t.dir, 's_eq'), seriesOffGridMax: 3500 / 4200, log: quiet })
            await assert.rejects(buildLedger({ ...base, outDir: path.join(t.dir, 's_lt'), seriesOffGridMax: 3500 / 4200 - 1e-9, log: quiet }), /^Error: invalid series fund/)
            for (let f of filesOf(path.join(t.dir, 's_none')).filter((f) => f !== 'meta.json')) {
                assert(fs.readFileSync(path.join(t.dir, 's_none', f)).equals(fs.readFileSync(path.join(t.dir, 's_eq', f))), f)
            }
        })
        it('對齊之序列(每根 1 日)於上限 0 亦通過;設定不合(負數、大於 1、非數字)於讀任何檔之前拋 invalid seriesOffGridMax', async () => {
            let d1 = path.join(t.dir, 'ser1')
            fs.mkdirSync(d1, { recursive: true })
            fs.writeFileSync(path.join(d1, 'fund.json'), JSON.stringify(bars.b1.map((b, i) => ({ time: b.time, value: 0.001 * i + 0.5 }))))
            await buildLedger({ libraryRoot: lib1, keyOhlc: 'SYN_1day', endTime: '2021-12-01T00:00:00', barHours: 24, seriesDir: d1, outDir: path.join(t.dir, 's_aligned'), seriesOffGridMax: 0, log: quiet })
            for (let v of [-0.1, 1.5, 'x', [0.5]]) {
                await assert.rejects(buildLedger({ libraryRoot: path.join(t.dir, 'nolib'), keyOhlc: 'x', endTime: '2021-12-01T00:00:00', barHours: 24, outDir: path.join(t.dir, 's_cfg'), seriesOffGridMax: v, log: quiet }), (err) => err.message === 'invalid seriesOffGridMax: must be a number from 0 to 1', JSON.stringify(v))
            }
        })
        it('給了上限而序列沒有任何列落在帳本範圍內(全在終點以後;分母 0)⇒ 拋 invalid series <名>: must have rows within the ledger、不寫出;未給上限者照建(只記錄)', async () => {
            let dz = path.join(t.dir, 'serAfter')
            fs.mkdirSync(dz, { recursive: true })
            fs.writeFileSync(path.join(dz, 'late.json'), JSON.stringify(bars.b1.slice(720).map((b, i) => ({ time: b.time, value: 7 + i * 0.01 }))))
            let base = { libraryRoot: lib1, keyOhlc: 'SYN_1day', endTime: '2021-12-01T00:00:00', barHours: 24, seriesDir: dz, log: quiet }
            let out = path.join(t.dir, 's_den0')
            await assert.rejects(buildLedger({ ...base, outDir: out, seriesOffGridMax: 1 }), (err) => err.message === 'invalid series late: must have rows within the ledger (required by seriesOffGridMax)')
            assert.equal(fs.existsSync(out), false, '不寫出')
            await buildLedger({ ...base, outDir: path.join(t.dir, 's_den0_none') })
        })
    })

    describe('①②③ 之命令列(g_build.mjs)', function () {
        it('source.barHours 24 照建;不合(48)⇒ ERROR invalid source.barHours、離開碼 2、不寫出;source.seriesOffGridMax 轉交建帳本(超過 ⇒ ERROR invalid series …、離開碼 2;不合 ⇒ ERROR invalid source.seriesOffGridMax);策略檔之每根秒數不合 ⇒ 離開碼 2', () => {
            let serDir = path.join(t.dir, 'gb_ser')
            fs.mkdirSync(serDir, { recursive: true })
            fs.writeFileSync(path.join(serDir, 'fund.json'), JSON.stringify(bars.b4.map((b, i) => ({ time: b.time, value: 0.0002 * i + 1 }))))
            let libBad = path.join(t.dir, 'gb_libI')
            writeLib(libBad, 'SYN_1day', bars.b1, (s) => (s === 3 ? 14400 : undefined))
            let run = (name, source) => {
                let root = path.join(t.dir, `gb_${name}`)
                fs.mkdirSync(root, { recursive: true })
                fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
                    source: { libraryRoot: lib1, keyOhlc: 'SYN_1day', ...source },
                    periods: { train: { start: '2020-07-01T00:00:00', end: '2021-03-01T00:00:00' }, backtest: { start: '2021-03-01T00:00:00', end: '2021-12-01T00:00:00' }, holdoutFrom: '2021-12-15T00:00:00' },
                    eval: { ledgerDir: './ledger/eval' },
                    rsi: { root: './rsi' },
                    records: {},
                    dispatch: {},
                }), 'utf8')
                let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'build.mjs')], { cwd: root, env: { ...process.env, ARSI_ROOT: root }, windowsHide: true, encoding: 'utf8', timeout: 120000 })
                return { status: r.status, out: `${r.stdout}\n${r.stderr}`, built: fs.existsSync(path.join(root, 'ledger', 'eval', 'meta.json')) }
            }
            let ok = run('ok', { barHours: 24, seriesDir: serDir })
            assert.equal(ok.status, 0, ok.out.slice(0, 600))
            assert(ok.built && /注意: 外部序列 fund/.test(ok.out), '未給上限 ⇒ 只記錄')
            for (let [name, source, re] of [
                ['h48', { barHours: 48 }, /ERROR invalid source\.barHours: must be a positive number of hours that divides 24/],
                ['og', { barHours: 24, seriesDir: serDir, seriesOffGridMax: 0.5 }, /ERROR invalid series fund: off-grid rows exceed seriesOffGridMax/],
                ['ogCfg', { barHours: 24, seriesOffGridMax: 2 }, /ERROR invalid source\.seriesOffGridMax: must be a number from 0 to 1/],
                ['isec', { barHours: 24, libraryRoot: libBad }, /ERROR invalid settings\.intervalSec of strategy s03\.json: must equal barHours \* 3600/],
            ]) {
                let r = run(name, source)
                assert.equal(r.status, 2, `${name}: ${r.out.slice(0, 600)}`)
                assert(re.test(r.out), `${name}: ${r.out.slice(0, 600)}`)
                assert.equal(r.built, false, `${name}: 不寫出`)
            }
        })
    })

    describe('④ eval.fitEnd 須落在帳本之棒格線上(makeEvaluator)', function () {
        it('格線上者換成該棒(每根 4 小時與每根 1 日);不在格線上(含沿用 4 小時之 20:00 於日線)、無法解析、非字串者拋 invalid cfg.fitEnd.<側>;未給之側為 -1', async () => {
            let L4 = loadLedger(path.join(t.dir, 'e4'))
            let L1 = loadLedger(path.join(t.dir, 'e1'))
            for (let L of [L4, L1]) {
                L.ntStatic = ntStaticOf(L, 100)
            }
            let iL = Array.from(L1.mode).findIndex((m) => m > 0)
            let iS = Array.from(L1.mode).findIndex((m) => m < 0)
            //日線: 2020-06-30 = 第 181 根; 4 小時: 2020-06-30T20:00 = 第 181 × 6 + 5 根
            let e1 = makeEvaluator(L1, { warmupDays: 60, fitEnd: { long: '2020-06-30T00:00:00', short: '' } })
            assert.deepEqual([e1.meta.fitEndBar[iL], e1.meta.fitEndBar[iS]], [181, -1])
            let e4 = makeEvaluator(L4, { warmupDays: 60, fitEnd: { long: '2020-06-30T20:00:00' } })
            assert.equal(e4.meta.fitEndBar[iL], 181 * 6 + 5)
            for (let [L, side, v] of [[L1, 'long', '2020-06-30T20:00:00'], [L4, 'short', '2020-06-30T03:00:00'], [L1, 'long', 'abc'], [L1, 'short', 12345]]) {
                assert.throws(() => makeEvaluator(L, { warmupDays: 60, fitEnd: { [side]: v } }), (err) => err.message.startsWith(`invalid cfg.fitEnd.${side}: must be a time on the bar grid of the ledger`) && !err.message.includes(String(v)), `${side} ${v}`)
            }
        })
    })

    describe('⑤ eval.trainFromStart:ntAll 與 --period train 以訓練期起點為下界', function () {
        it('ntStaticOf 之 fromBar:未給 / null / 0 ⇒ 自帳本起點(與原寫法同);給 f ⇒ 只計 [f, 終點) 之進場(以帳本逐單獨立計數);不合者拋 invalid fromBar', () => {
            let L = loadLedger(path.join(t.dir, 'e1'))
            let cnt = (lo, hi) => Array.from({ length: L.n }, (_, s) => {
                let c = 0
                for (let j = L.off[s]; j < L.off[s + 1]; j++) {
                    c += L.ent[j] >= lo && L.ent[j] < hi ? 1 : 0
                }
                return c
            })
            let base = Array.from(ntStaticOf(L, 500))
            assert.deepEqual(base, cnt(0, 500))
            assert.deepEqual(Array.from(ntStaticOf(L, 500, null)), base)
            assert.deepEqual(Array.from(ntStaticOf(L, 500, 0)), base)
            let f = Array.from(ntStaticOf(L, 500, 182))
            assert.deepEqual(f, cnt(182, 500))
            assert(f.some((v, s) => v < base[s]), '鑑別前提: 下界以前確有進場')
            assert.deepEqual(Array.from(ntStaticOf(L, 500, '182')), f, '數字字串(iseint)')
            for (let v of [-1, 501, 1.5, 'x', NaN]) {
                assert.throws(() => ntStaticOf(L, 500, v), /^Error: invalid fromBar: must be an integer from 0 to trainEndBar$/, String(v))
            }
        })

        it('trainFromBarOf:未給 / null / false ⇒ null;true ⇒ 訓練期起點之棒序(早於帳本起點者為 0);非布林、起點不在格線上、起點晚於終點 ⇒ 拋錯', () => {
            let meta = { time0: TIME0, barHours: 24 }
            let st = (v, start = '2020-07-01T00:00:00') => ({ eval: { trainFromStart: v }, periods: { train: { start } } })
            assert.strictEqual(trainFromBarOf({ eval: {} }, meta, 500), null)
            assert.strictEqual(trainFromBarOf(st(null), meta, 500), null)
            assert.strictEqual(trainFromBarOf(st(false), meta, 500), null)
            assert.equal(trainFromBarOf(st(true), meta, 500), 182, '2020-01-01 → 2020-07-01 = 182 日')
            assert.equal(trainFromBarOf(st(true, '2019-12-01T00:00:00'), meta, 500), 0)
            assert.equal(trainFromBarOf(st(true, '2020-07-01T04:00:00'), { time0: TIME0, barHours: 4 }, 5000), 182 * 6 + 1)
            assert.throws(() => trainFromBarOf(st('true'), meta, 500), /^Error: invalid eval\.trainFromStart: must be a boolean$/)
            assert.throws(() => trainFromBarOf(st(1), meta, 500), /^Error: invalid eval\.trainFromStart/)
            assert.throws(() => trainFromBarOf(st(true, '2020-07-01T04:00:00'), meta, 500), /^Error: invalid periods\.train\.start: must be a time on the bar grid/)
            assert.throws(() => trainFromBarOf(st(true, '2022-01-01T00:00:00'), meta, 500), /^Error: invalid periods\.train\.start: must not be later than periods\.train\.end/)
        })

        //命令列: 合成帳本(60 隻, 2400 根)標為每根 1 日; 訓練期 2022-07-01 + 30 日 ~ 第 400 日, 回測期第 430 ~ 900 日
        let mkProj = (name, evalExtra = {}) => {
            let root = path.join(t.dir, name)
            synthDaily(path.join(root, 'ledger', 'eval'), { n: 60, nBars: 2400, seed: 7 })
            fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
            let d = (k) => iso(tms('2022-07-01T00:00:00') + k * DAY)
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
                periods: { train: { start: d(30), end: d(400) }, backtest: { start: d(430), end: d(900) } },
                eval: { ledgerDir: './ledger/eval', warmupDays: 10, cadenceDays: 7, phases: [0], horizons: [7], nullDraws: 4, seed: 1, limits: { monthlyOrders: 400, peakHold: 50 }, ...evalExtra },
                score: { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] },
                rsi: { root: './rsi' },
                records: {},
                dispatch: {},
            }), 'utf8')
            fs.writeFileSync(path.join(root, 'pick_nt.mjs'), 'export default function pick(ctx) { throw new Error("NT " + Array.from(ctx.meta.ntAll).join(",")) }\n', 'utf8')
            fs.writeFileSync(path.join(root, 'pick_all.mjs'), 'export default function pick(ctx) { return [0, 1, 2, 3, 4, 5] }\n', 'utf8')
            return root
        }
        let run = (root, args) => {
            let env = { ...process.env, ARSI_ROOT: root }
            delete env.ARSI_HARNESS
            let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'eval.mjs'), ...args], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            let out = `${r.stdout}\n${r.stderr}`
            let m = /Error: NT ([0-9,]+)/.exec(out)
            return { status: r.status, out, nt: m ? m[1].split(',').map(Number) : null }
        }
        let expectOf = (root, lo, hi) => {
            let L = loadLedger(path.join(root, 'ledger', 'eval'))
            return Array.from({ length: L.n }, (_, s) => {
                let c = 0
                for (let j = L.off[s]; j < L.off[s + 1]; j++) {
                    c += L.ent[j] >= lo && L.ent[j] < hi ? 1 : 0
                }
                return c
            })
        }

        it('g_eval.mjs:未給 ⇒ ntAll 自帳本起點計數(行為不變);true ⇒ 只計訓練期起點(第 30 根)~ 終點(第 400 根)之進場;--period train 之第一個所評估之決策不早於訓練期起點', () => {
            let r0 = run(mkProj('cli0'), ['--pick', 'pick_nt.mjs', '--mode', 'quick'])
            let root = mkProj('cli1', { trainFromStart: true })
            let r1 = run(root, ['--pick', 'pick_nt.mjs', '--mode', 'quick'])
            assert.equal(r0.status, 3, r0.out.slice(0, 600))
            assert.deepEqual(r0.nt, expectOf(root, 0, 400))
            assert.equal(r1.status, 3, r1.out.slice(0, 600))
            assert.deepEqual(r1.nt, expectOf(root, 30, 400))
            assert(r1.nt.some((v, s) => v < r0.nt[s]), '鑑別前提: 訓練期起點以前確有進場')
            let fp = path.join(root, 'train.json')
            let r2 = run(root, ['--pick', 'pick_all.mjs', '--mode', 'quick', '--period', 'train', '--out', fp])
            assert.equal(r2.status, 0, r2.out.slice(0, 600))
            let m = JSON.parse(fs.readFileSync(fp, 'utf8')).metrics
            assert.equal(m.period.evalFrom, iso(tms('2022-07-01T00:00:00') + 30 * DAY))
            assert(m.period.firstEvalDecision >= m.period.evalFrom && m.period.firstDecision < m.period.evalFrom, `${m.period.firstDecision} / ${m.period.firstEvalDecision}`)
            let fp0 = path.join(t.dir, 'train0.json')
            assert.equal(run(mkProj('cli0b'), ['--pick', 'pick_all.mjs', '--mode', 'quick', '--period', 'train', '--out', fp0]).status, 0)
            assert.strictEqual(JSON.parse(fs.readFileSync(fp0, 'utf8')).metrics.period.evalFrom, null, '未給: 自第一個決策起(評估期間之起點為 null)')
        })

        it('g_backtest.mjs(標準配置:評估帳本 = 全期帳本之前綴):true ⇒ 兩帳本各以自身之棒序換算下界、核對不誤報、ntAll 只計 [訓練期起點, 終點);未給 ⇒ 自帳本起點;設定不合 ⇒ 離開碼 2', () => {
            let mkBt = (name, extra) => {
                let root = mkProj(name, extra)
                synthDaily(path.join(root, 'ledger', 'eval'), { n: 60, nBars: 3000, seed: 7, cut: 2400 })
                let full = path.join(root, 'ledger', 'full')
                synthDaily(full, { n: 60, nBars: 3000, seed: 7 })
                let fpS = path.join(root, 'settings.json')
                let s = JSON.parse(fs.readFileSync(fpS, 'utf8'))
                s.backtest = { ledgerDir: full, resultDir: path.join(root, 'bt_out'), privateRoot: path.join(t.dir, `${name}_private`), replicas: 1 }
                fs.writeFileSync(fpS, JSON.stringify(s), 'utf8')
                return root
            }
            let runBt = (root) => {
                let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'backtest.mjs'), '--pick', path.join(root, 'pick_nt.mjs'), '--name', 'x', '--dir', path.join(root, 'bt_out')], { cwd: root, env: { ...process.env, ARSI_ROOT: root, ARSI_HARNESS: '1' }, windowsHide: true, encoding: 'utf8', timeout: 120000 })
                let out = `${r.stdout}\n${r.stderr}`
                let m = /Error: NT ([0-9,]+)/.exec(out)
                return { status: r.status, out, nt: m ? m[1].split(',').map(Number) : null }
            }
            let r1root = mkBt('bt1', { trainFromStart: true })
            let r1 = runBt(r1root)
            assert(!/不一致|不合核對/.test(r1.out), r1.out.slice(0, 600))
            assert.equal(r1.status, 3, r1.out.slice(0, 600))
            assert.deepEqual(r1.nt, expectOf(r1root, 30, 400))
            let r0 = runBt(mkBt('bt0'))
            assert.equal(r0.status, 3, r0.out.slice(0, 600))
            assert.deepEqual(r0.nt, expectOf(r1root, 0, 400))
            assert(r1.nt.some((v, s) => v < r0.nt[s]), '鑑別前提: 訓練期起點以前確有進場')
            let r2 = runBt(mkBt('bt2', { trainFromStart: 1 }))
            assert.equal(r2.status, 2, r2.out.slice(0, 600))
            assert(/ERROR invalid eval\.trainFromStart: must be a boolean/.test(r2.out))
            let r3 = runBt(mkBt('bt3', { fitEnd: { long: '2022-08-01T20:00:00' } }))
            assert.equal(r3.status, 2, r3.out.slice(0, 600))
            assert(/ERROR invalid eval\.fitEnd\.long: must be a time on the bar grid/.test(r3.out))
        })

        //editPeriods, 改合成專案之期間(f 改寫 settings.periods)
        let editPeriods = (root, f) => {
            let fpS = path.join(root, 'settings.json')
            let s = JSON.parse(fs.readFileSync(fpS, 'utf8'))
            f(s.periods)
            fs.writeFileSync(fpS, JSON.stringify(s), 'utf8')
            return root
        }
        it('g_eval.mjs:設定不合(eval.trainFromStart 非布林、訓練期起點 / 訓練期終點 / 回測期起點不在格線上、eval.fitEnd 不在格線上)⇒ ERROR invalid …、離開碼 2、不記評估紀錄;給 --out 者寫 { ok: false, code: CONFIG_INVALID, error }', () => {
            let off = (t) => t.replace('T00:', 'T05:')
            for (let [name, mk, re] of [
                ['nb', () => mkProj('bad_nb', { trainFromStart: 'yes' }), /invalid eval\.trainFromStart: must be a boolean/],
                ['fe', () => mkProj('bad_fe', { fitEnd: { long: '2022-08-01T20:00:00' } }), /invalid eval\.fitEnd\.long: must be a time on the bar grid/],
                ['ts', () => editPeriods(mkProj('bad_ts', { trainFromStart: true }), (p) => {
                    p.train.start = off(p.train.start)
                }), /invalid periods\.train\.start: must be a time on the bar grid/],
                ['te', () => editPeriods(mkProj('bad_te'), (p) => {
                    p.train.end = off(p.train.end)
                }), /invalid periods\.train\.end: must be a time on the bar grid of the ledger/],
                ['bs', () => editPeriods(mkProj('bad_bs'), (p) => {
                    p.backtest.start = off(p.backtest.start)
                }), /invalid periods\.backtest\.start: must be a time on the bar grid of the ledger/],
            ]) {
                let root = mk()
                let fp = path.join(root, 'out.json')
                let r = run(root, ['--pick', 'pick_all.mjs', '--mode', 'quick', '--out', fp])
                assert.equal(r.status, 2, `${name}: ${r.out.slice(0, 400)}`)
                assert(new RegExp(`ERROR ${re.source}`).test(r.out), `${name}: ${r.out.slice(0, 400)}`)
                let o = JSON.parse(fs.readFileSync(fp, 'utf8'))
                assert.deepEqual([o.ok, o.code], [false, 'CONFIG_INVALID'], name)
                assert(re.test(o.error), name)
                assert.equal(fs.existsSync(path.join(root, '.evals.log')), false, `${name}: 不記評估紀錄`)
            }
            //未給 --out ⇒ 不寫任何結果檔
            let root = mkProj('bad_nb_noout', { trainFromStart: 'yes' })
            assert.equal(run(root, ['--pick', 'pick_all.mjs', '--mode', 'quick']).status, 2)
            assert.deepEqual(fs.readdirSync(root).filter((f) => f.endsWith('.json') && f !== 'settings.json'), [])
            //迴圈之重放(ARSI_HARNESS=1)之評估起點 ARSI_EVAL_FROM 不在格線上 ⇒ 訊息之位置為 ARSI_EVAL_FROM(設定之回測期起點本身合法)
            let rootH = mkProj('bad_evalfrom_env')
            let sH = JSON.parse(fs.readFileSync(path.join(rootH, 'settings.json'), 'utf8'))
            let fpH = path.join(rootH, 'out_env.json')
            let rH = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'eval.mjs'), '--pick', 'pick_all.mjs', '--mode', 'quick', '--out', fpH], { cwd: rootH, env: { ...process.env, ARSI_ROOT: rootH, ARSI_HARNESS: '1', ARSI_EVAL_FROM: off(sH.periods.backtest.start) }, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            assert.equal(rH.status, 2, rH.stdout.slice(0, 400))
            assert(/^ERROR invalid ARSI_EVAL_FROM: must be a time on the bar grid of the ledger/m.test(rH.stdout) && !/periods\.backtest\.start/.test(rH.stdout), rH.stdout.slice(0, 400))
            assert.deepEqual([JSON.parse(fs.readFileSync(fpH, 'utf8')).code], ['CONFIG_INVALID'])
        })

        it('每根 4 小時之帳本上落在 4 小時格線上之期間(例:04:00)不被誤拒', () => {
            //合成帳本(4 小時一根;起點 2022-07-01T00:00);期間取 04:00 之界線
            let root = path.join(t.dir, 'grid4h')
            writeSynthLedger(path.join(root, 'ledger', 'eval'), { n: 30, nBars: 2400, seed: 5 })
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
                periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T04:00:00' }, backtest: { start: '2023-02-01T04:00:00', end: '2023-08-05T00:00:00' } },
                eval: { ledgerDir: './ledger/eval', warmupDays: 60, cadenceDays: 7, phases: [0], horizons: [7], nullDraws: 4, seed: 1, fitEnd: { long: '2022-12-01T08:00:00' }, limits: { monthlyOrders: 400, peakHold: 50 } },
                score: { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] },
                rsi: { root: './rsi' },
                records: {},
                dispatch: {},
            }), 'utf8')
            fs.writeFileSync(path.join(root, 'pick_all.mjs'), 'export default function pick(ctx) { return [0, 1, 2] }\n', 'utf8')
            let r = run(root, ['--pick', 'pick_all.mjs', '--mode', 'quick'])
            assert.equal(r.status, 0, r.out.slice(0, 600))
        })

        it('帳本起點 = 訓練期起點(下界為第 0 根)時,給 eval.trainFromStart 與不給之結果檔逐位相同(--period train 與回測期;去除時刻與耗時)', () => {
            let strip = (fp) => {
                let o = JSON.parse(fs.readFileSync(fp, 'utf8'))
                delete o.at
                delete o.loadMs
                delete o.pick
                delete o.metrics.ms
                return JSON.stringify(o)
            }
            let pair = []
            for (let [name, extra] of [['eq0', {}], ['eq1', { trainFromStart: true }]]) {
                let root = editPeriods(mkProj(name, extra), (p) => {
                    p.train.start = '2022-07-01T00:00:00'
                })
                let outs = []
                for (let args of [['--period', 'train'], []]) {
                    let fp = path.join(root, `r${outs.length}.json`)
                    let r = run(root, ['--pick', 'pick_all.mjs', '--mode', 'quick', ...args, '--out', fp])
                    assert.equal(r.status, 0, r.out.slice(0, 400))
                    outs.push(strip(fp))
                }
                pair.push(outs)
            }
            assert.equal(pair[1][0], pair[0][0], '--period train')
            assert.equal(pair[1][1], pair[0][1], '回測期')
            assert.strictEqual(JSON.parse(pair[1][0]).metrics.period.evalFrom, null)
        })

        it('g_backtest.mjs:評估帳本之 time0 與全期帳本不同(早一日、同一時刻之進場以各自之棒序表示)⇒ 兩帳本各以自身之 time0 換算下界,核對不誤報', () => {
            let root = mkProj('bt_t0', { trainFromStart: true })
            let ev = path.join(root, 'ledger', 'eval')
            synthDaily(ev, { n: 60, nBars: 3000, seed: 7, cut: 2400 })
            let full = path.join(root, 'ledger', 'full')
            synthDaily(full, { n: 60, nBars: 3000, seed: 7 })
            let Le = loadLedger(ev)
            fs.writeFileSync(path.join(ev, 'ent.i32'), Buffer.from(Int32Array.from(Le.ent, (v) => v + 1).buffer))
            fs.writeFileSync(path.join(ev, 'ext.i32'), Buffer.from(Int32Array.from(Le.ext, (v) => (v >= 0 ? v + 1 : v)).buffer))
            let meta = JSON.parse(fs.readFileSync(path.join(ev, 'meta.json'), 'utf8'))
            meta.time0 = '2022-06-30T00:00:00'
            fs.writeFileSync(path.join(ev, 'meta.json'), JSON.stringify(meta), 'utf8')
            let s = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'))
            s.backtest = { ledgerDir: full, resultDir: path.join(root, 'bt_out'), privateRoot: path.join(t.dir, 'bt_t0_private'), replicas: 1 }
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(s), 'utf8')
            //鑑別前提: 全期帳本之第 29 根(訓練期起點之前一根)確有進場 ⇒ 以全期帳本之下界(30)直接數評估帳本(座標差一根)會多計
            let Lf = loadLedger(full)
            assert(Array.from(Lf.ent).includes(29), '全期帳本之第 29 根有進場')
            let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'backtest.mjs'), '--pick', path.join(root, 'pick_nt.mjs'), '--name', 'x', '--dir', path.join(root, 'bt_out')], { cwd: root, env: { ...process.env, ARSI_ROOT: root, ARSI_HARNESS: '1' }, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            let out = `${r.stdout}\n${r.stderr}`
            assert(!/不一致|不合核對/.test(out), out.slice(0, 600))
            assert.equal(r.status, 3, out.slice(0, 600))
            let m = /Error: NT ([0-9,]+)/.exec(out)
            let want = Array.from({ length: Lf.n }, (_, k) => {
                let c = 0
                for (let j = Lf.off[k]; j < Lf.off[k + 1]; j++) {
                    c += Lf.ent[j] >= 30 && Lf.ent[j] < 400 ? 1 : 0
                }
                return c
            })
            assert.deepEqual(m[1].split(',').map(Number), want)
        })

        it('g_backtest.mjs:期間之界線不在格線上(訓練期終點〔兩帳本各自核對〕、回測期起點、回測期終點)⇒ ERROR invalid periods.…、離開碼 2', () => {
            let off = (x) => x.replace('T00:', 'T05:')
            //shiftT0, 把某一帳本之格線移半日(meta.time0 改為前一日之 12:00; 每根 1 日)⇒ 00:00 之界線只在另一帳本之格線上
            let shiftT0 = (dir) => {
                let meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
                meta.time0 = '2022-06-30T12:00:00'
                fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8')
            }
            let keep = () => {}
            for (let [name, f, re, shift] of [['te', (p) => {
                p.train.end = off(p.train.end)
            }, /ERROR invalid periods\.train\.end: must be a time on the bar grid/], ['bs', (p) => {
                p.backtest.start = off(p.backtest.start)
            }, /ERROR invalid periods\.backtest\.start: must be a time on the bar grid/], ['be', (p) => {
                p.backtest.end = off(p.backtest.end)
            }, /ERROR invalid periods\.backtest\.end: must be a time on the bar grid/],
            //訓練期終點只在全期帳本之格線上(評估帳本移半日)/ 只在評估帳本之格線上(全期帳本移半日;其回測期起點亦不在格線上, 而訊息須先指訓練期終點)
            ['teE', keep, /ERROR invalid periods\.train\.end: must be a time on the bar grid/, 'eval'], ['teL', keep, /ERROR invalid periods\.train\.end: must be a time on the bar grid/, 'full']]) {
                let root = editPeriods(mkProj(`btg_${name}`), f)
                synthDaily(path.join(root, 'ledger', 'eval'), { n: 60, nBars: 3000, seed: 7, cut: 2400 })
                let full = path.join(root, 'ledger', 'full')
                synthDaily(full, { n: 60, nBars: 3000, seed: 7 })
                if (shift) {
                    shiftT0(path.join(root, 'ledger', shift))
                }
                let s = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'))
                s.backtest = { ledgerDir: full, resultDir: path.join(root, 'bt_out'), privateRoot: path.join(t.dir, `btg_${name}_private`), replicas: 1 }
                fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(s), 'utf8')
                let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'backtest.mjs'), '--pick', path.join(root, 'pick_nt.mjs'), '--name', 'x', '--dir', path.join(root, 'bt_out')], { cwd: root, env: { ...process.env, ARSI_ROOT: root, ARSI_HARNESS: '1' }, windowsHide: true, encoding: 'utf8', timeout: 120000 })
                assert.equal(r.status, 2, `${name}: ${r.stdout}`.slice(0, 400))
                assert(re.test(r.stdout), `${name}: ${r.stdout}`.slice(0, 400))
                assert.equal(fs.existsSync(path.join(root, 'bt_out')), false, `${name}: 未寫結果`)
            }
        })

    })

    describe('⑥ 每根 1 日之帳本:評估器之時間語意與每根 4 小時者等義;帳本與官方回測逐張一致', function () {
        let L4
        let L1
        before(() => {
            L4 = loadLedger(path.join(t.dir, 'e4'))
            L1 = loadLedger(path.join(t.dir, 'e1'))
            L4.ntStatic = ntStaticOf(L4, 400 * 6)
            L1.ntStatic = ntStaticOf(L1, 400)
        })

        it('決策時刻(七相位)兩週期逐一相同;ctx.dow = ctx.time 之星期、ctx.day = 自 time0 之日數;ctx.stat(30).entries 與 ctx.entryDays(s, 30) = 決策時刻前 30 日內之進場(以時刻獨立計)', () => {
            let e4 = makeEvaluator(L4, { warmupDays: 60, cadenceDays: 7 })
            let e1 = makeEvaluator(L1, { warmupDays: 60, cadenceDays: 7 })
            for (let ph = 0; ph < 7; ph++) {
                assert.deepEqual(e1.decisionBars(ph).map((b) => e1.timeOf(b)), e4.decisionBars(ph).map((b) => e4.timeOf(b)), `相位 ${ph}`)
            }
            for (let [L, ev] of [[L1, e1], [L4, e4]]) {
                let barMs = L.meta.barHours * 3600000
                let t0 = tms(L.meta.time0)
                let n = 0
                ev.runPick((ctx) => {
                    let tDec = tms(ctx.time)
                    assert.equal(new Date(tDec).getUTCDay(), ctx.dow)
                    assert.equal((tDec - t0) / DAY, ctx.day)
                    let st = ctx.stat(30)
                    for (let s = 0; s < ctx.n; s++) {
                        let days = []
                        for (let j = L.off[s]; j < L.off[s + 1]; j++) {
                            let te = t0 + L.ent[j] * barMs
                            if (te < tDec && te >= tDec - 30 * DAY) {
                                days.push(Math.floor((te - t0) / DAY))
                            }
                        }
                        assert.equal(st.entries[s], days.length)
                        assert.deepEqual(Array.from(ctx.entryDays(s, 30)), days)
                    }
                    n++
                    return []
                }, 0)
                assert(n > 50)
            }
        })

        it('日線:sig.day = sig.bar、sig.dow 正確、book.dayCount 於每根(每日)歸零;全選全收之峰值持倉、等效年化、月均單 = 以時刻獨立計算之值', () => {
            let e1 = makeEvaluator(L1, { warmupDays: 60, cadenceDays: 7 })
            let from = 430
            let all = (ctx) => Array.from({ length: ctx.n }, (_, i) => i)
            let rec = []
            let accept = (sig, book) => {
                rec.push([sig.bar, sig.day, sig.dow, book.dayCount])
                return book.dayCount < 2
            }
            let m = e1.evalPolicy(all, { phases: [0], horizons: [], nullDraws: 0, fromBar: from, accept })
            assert(rec.length > 100)
            let prev = -1
            let c = 0
            for (let [bar, day, dow, dc] of rec) {
                if (bar !== prev) {
                    prev = bar
                    c = 0
                }
                assert.equal(day, bar)
                assert.equal(dow, new Date(tms(TIME0) + bar * DAY).getUTCDay())
                assert.equal(dc, Math.min(c, 2))
                c += dc < 2 ? 1 : 0
            }
            assert(m.op.nOrders[0] < rec.length, '鑑別前提: 每日上限確有擋單')
            //全收: 獨立之定義(持倉 = 進場棒 ≤ i < 出場棒, 未結者至期末)
            let r = e1.evalPolicy(all, { phases: [0], horizons: [7], nullDraws: 0, fromBar: from })
            let bars = e1.decisionBars(0).filter((b) => b >= from)
            let lo = bars[0]
            let hi = bars[bars.length - 1] + 7
            let ords = []
            for (let s = 0; s < L1.n; s++) {
                for (let j = L1.off[s]; j < L1.off[s + 1]; j++) {
                    if (L1.ent[j] >= lo && L1.ent[j] < hi) {
                        ords.push(j)
                    }
                }
            }
            let peak = 0
            for (let i = lo; i < L1.nBars; i++) {
                peak = Math.max(peak, ords.filter((j) => L1.ent[j] <= i && (L1.ext[j] < 0 || L1.ext[j] > i)).length)
            }
            let pnl = ords.reduce((a, j) => a + (L1.ext[j] >= 0 ? L1.pnl[j] : 0), 0)
            let years = bars.length * 7 / 365.25
            assert.equal(r.op.peakHold.max, peak)
            assert.equal(r.op.nOrders[0], ords.length)
            assert(Math.abs(r.op.eqYr.mean - pnl / peak / years * 100) <= 0.5e-4)
            assert(Math.abs(r.op.monthlyOrders.mean - ords.length / (bars.length * 7 / 30.4375)) <= 0.5e-4)
        })

        it('數值類設定以數字字串給者(cadenceDays、warmupDays、nullDraws、actBins、sideActHalf)與數字者之評估結果逐位相同(cfgNumOf;任務書與合約之參考版用同一取值)', () => {
            //R-EV-44 ④之二: 未給(undefined、null)= 預設; 數字原樣; 數字字串轉為數值(無效者之拒絕見 unit-evalNums.test.mjs)
            assert.deepEqual([cfgNumOf('32', 64, 'eval.nullDraws', 'nonNegInt'), cfgNumOf(32, 64, 'eval.nullDraws', 'nonNegInt'), cfgNumOf(undefined, 64, 'eval.nullDraws', 'nonNegInt'), cfgNumOf(' 5 ', 7, 'eval.cadenceDays', 'posNum'), cfgNumOf(null, 7, 'eval.cadenceDays', 'posNum')], [32, 32, 64, 5, 7])
            //挑訊號最多之 3 隻(選集之訊號數偏離全體隨機 ⇒ 同訊號量 / 同活躍度虛無與組成對照皆算)
            let pick = (ctx) => {
                let s = ctx.stat(0)
                return Array.from({ length: ctx.n }, (_, i) => i).sort((a, b) => s.entries[b] - s.entries[a] || a - b).slice(0, 3)
            }
            let accept = (sig, book) => book.open < 6
            //結果(去除耗時 ms)
            let run = (cfg, opt = {}) => {
                let m = makeEvaluator(L4, cfg).evalPolicy(pick, { phases: [0, 3], horizons: [7], accept, seed: 3, ...opt })
                delete m.ms
                return JSON.stringify(m)
            }
            let num = run({ warmupDays: 60, cadenceDays: 5, nullDraws: 6, actBins: 4, sideActHalf: 3 })
            assert.strictEqual(run({ warmupDays: '60', cadenceDays: '5', nullDraws: '6', actBins: '4', sideActHalf: '3' }), num, '設定之數字字串')
            //命令列之完整評估以設定之原值傳 opt.nullDraws
            assert.strictEqual(run({ warmupDays: 60, cadenceDays: 5, actBins: 4, sideActHalf: 3 }, { nullDraws: '6' }), num, 'opt.nullDraws 之數字字串')
            //鑑別前提: 各虛無皆算出且用到所給之值(p 之分母為 1 + 抽數)
            let m = JSON.parse(num)
            assert(m.null && m.null.draws === 6 && m.nullAct && m.nullAct.bins === 4 && m.nullSideAct && m.nullSideAct.half === 3, JSON.stringify([m.null, m.nullAct, m.nullSideAct]).slice(0, 400))
            //只留求解窗已結束之席(afterFitOnly;其組成對照之名次寬度另讀 sideActHalf)
            let fe = { long: '2020-06-30T20:00:00', short: '2020-06-30T20:00:00' }
            let pf = run({ warmupDays: 60, cadenceDays: 5, nullDraws: 6, actBins: 4, sideActHalf: 3, fitEnd: fe }, { afterFitOnly: true })
            assert.strictEqual(run({ warmupDays: '60', cadenceDays: '5', nullDraws: '6', actBins: '4', sideActHalf: '3', fitEnd: fe }, { afterFitOnly: true }), pf, 'afterFitOnly 之數字字串')
            let mf = JSON.parse(pf)
            assert(mf.afterFit && mf.afterFit.sideActRecent && mf.afterFit.sideActRecent.half === 3, JSON.stringify(mf.afterFit).slice(0, 400))
        })

        it('日線帳本之逐張(進場棒、出場棒、每單位損益)= 官方 runStrategy(settings 帶 intervalSec 86400;timeBasis 為 open 與 span 皆然)', async () => {
            let ids = loadIds(path.join(t.dir, 'e1'))
            let arr = JSON.parse(fs.readFileSync(path.join(lib1, 'ohlc', 'SYN_1day.json'), 'utf8')).filter((r) => r.time < L1.meta.endTime)
            let ind = new Map(arr.map((r, i) => [r.time, i]))
            let get = async (k) => (k === 'SYN_1day' ? arr : JSON.parse(fs.readFileSync(path.join(lib1, 'param', `${k}.json`), 'utf8')).filter((r) => r.time < L1.meta.endTime))
            let nOrd = 0
            for (let basis of ['open', 'span']) {
                for (let si = 0; si < L1.n; si++) {
                    let s = JSON.parse(fs.readFileSync(path.join(lib1, 'strategies', ids[si]), 'utf8'))
                    let r = await runStrategy(ott, { ...s, keyOhlc: 'SYN_1day', settings: { uIni: 1000, uTrade: 1, ...s.settings, intervalSec: 86400, timeBasis: basis } }, get, { withSummary: false })
                    assert.equal(r.orders.length, L1.off[si + 1] - L1.off[si], `${basis} ${ids[si]}`)
                    r.orders.forEach((o, q) => {
                        let j = L1.off[si] + q
                        assert.equal(ind.get(o.timeStart), L1.ent[j])
                        assert.equal(o.timeEnd ? ind.get(o.timeEnd) : -1, L1.ext[j])
                        assert(Math.abs((o.timeEnd ? o.uProfitOrLoss / o.uTrade : 0) - L1.pnl[j]) < 1e-6)
                    })
                    nOrd += r.orders.length
                }
            }
            assert(nOrd > 500)
        })
    })
})

describe('文字不寫死策略庫之事實(規則 R-REC-36)', function () {
    this.timeout(180000)
    let t
    before(() => {
        t = makeTmp('noFacts')
    })
    after(() => {
        t.cleanup()
    })
    let stOf = (root, ev = {}, extra = {}) => ({
        FD_ROOT: root,
        rsi: { root: path.join(root, 'rsi'), guides: false },
        records: { nodeDir: path.join(root, 'rsi/records/nodes'), dreamDir: path.join(root, 'rsi/records/dreams'), workDir: path.join(root, 'rsi/work') },
        eval: { ledgerDir: path.join(root, 'ledger'), limits: { monthlyOrders: 400, peakHold: 50 }, ...ev },
        score: { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] },
        periods: { train: { start: '2030-01-01T00:00:00', end: '2031-01-01T00:00:00' }, backtest: { start: '2031-01-01T00:00:00', end: '2031-06-01T00:00:00' }, holdoutFrom: '2031-06-01T00:00:00' },
        ...extra,
    })
    let toolbox = { dir: 'rsi/toolbox', index: 'rsi/toolbox/README.md', indexName: 'README.md', nTools: 3 }
    let node = { nodeId: 'n1', arms: ['A04_act'], base: null, S: 1, worst: 0, excess: 0, ladder: 0, vetoed: false, claimedS: 1, nEvals: 3, nFull: 2, nFullSel: 2, issues: [], from: null, type: 'explore', docMd: 'd.md', workDir: 'rsi/work/n1' }
    let arm = { id: 'A04_act', layer: 'A', layerName: '資格層', title: '近期活躍度門檻', desc: 'd', grid: null }
    let briefs = (tx, st) => [
        tx.nodeBrief({ workDir: path.join(st.records.workDir, 'nodeX'), task: { goal: 'g', type: 'explore', claim: null, arms: [arm], base: null, refs: [], direction: null, toolbox }, round: 2, nodeId: 'nodeX', attempt: 1 }),
        tx.dreamBrief({ round: 2, nodeIds: ['n1'], reworkedIds: [], workDir: path.join(st.records.workDir, 'dream_r002'), context: { nodes: [node], failed: [], refs: [], prevDirections: [], maxDirections: 7, extra: '2. 更新文件', toolbox } }),
    ]

    it('任務書:策略隻數取 opt.nStrategies 或評估帳本之 meta.nStrategies(皆無則略去);決策間隔、新鮮度地平線、求解窗、回測期長度取自設定', () => {
        let root = path.join(t.dir, 'p1')
        let st = stOf(root, { cadenceDays: 5, horizons: [1, 3, 9], fitEnd: { long: '2030-05-01T00:00:00', short: '2030-11-02T00:00:00' } })
        let [nb, db] = briefs(makeTexts({ st, FD_ROOT: root, nStrategies: 31234 }), st)
        assert(nb.includes('本專案要從一個約 3 萬隻策略之策略庫裡') && db.includes('背景:策略庫約 3 萬隻策略;'), '隻數(四捨五入至萬)')
        assert(nb.includes('每 5 日只憑過去之資訊挑一組策略') && db.includes('挑選模組每 5 日只憑過去資訊挑一組'), '決策間隔')
        assert(db.includes('- 階梯 2(平原): 1 / 3 / 9 日新鮮度之七相位平均皆 ≥ 10'), '新鮮度地平線')
        assert(db.includes('之資料求得(做多策略之求解窗止於 2030-05-01,做空策略止於 2030-11-02)。'), '求解窗')
        assert(nb.includes('回測期只有約 5 個月') && db.includes('**回測期只有約 5 個月,試得越多越容易挑到偶然**') && db.includes('(回測期只有約 5 個月,節點可反覆回測)'), '回測期長度(151 日 ⇒ 約 5 個月)')
        assert(!/7 萬|每週只憑|每 7 日只憑|1 \/ 3 \/ 7 \/ 14 \/ 30|10 個月/.test(nb + db), '不含其他策略庫之事實')
        //隻數之來源: 帳本之 meta.json; 皆無 ⇒ 略去; 未滿 1 萬者寫實數; 只有一側之求解窗; 每 7 日 ⇒ 每週
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ nStrategies: 8642 }), 'utf8')
        let st2 = stOf(root, { cadenceDays: 7, fitEnd: { short: '2030-11-02T00:00:00' } })
        let [nb2, db2] = briefs(makeTexts({ st: st2, FD_ROOT: root }), st2)
        assert(nb2.includes('本專案要從一個約 8642 隻策略之策略庫裡') && db2.includes('背景:策略庫約 8642 隻策略;'))
        assert(nb2.includes('每週只憑過去之資訊') && db2.includes('之資料求得(做空策略之求解窗止於 2030-11-02)。'))
        assert(db2.includes('1 / 3 / 7 / 14 / 30 日新鮮度'), '未給地平線 ⇒ 評估器之預設')
        let st3 = stOf(path.join(t.dir, 'p3'))
        let [nb3, db3] = briefs(makeTexts({ st: st3, FD_ROOT: root }), st3)
        assert(nb3.includes('本專案要從一個策略庫裡') && db3.includes('背景:挑選模組每 7 日只憑過去資訊挑一組'), '無帳本 ⇒ 略去隻數')
        assert(db3.includes('之資料求得。在訓練期內'), '未給求解窗 ⇒ 略去括號')
        //隻數四捨五入至萬(8.65 萬 ⇒ 9 萬、1.5 萬 ⇒ 2 萬; 無條件捨去者分別為 8、1); 間隔 7 日以外者一律寫日數(14 日不寫「每週」)
        for (let [n, want] of [[86500, '約 9 萬隻'], [15000, '約 2 萬隻'], [10000, '約 1 萬隻'], [9999, '約 9999 隻']]) {
            let [nbN, dbN] = briefs(makeTexts({ st, FD_ROOT: root, nStrategies: n }), st)
            assert(nbN.includes(`本專案要從一個${want}策略之策略庫裡`) && dbN.includes(`背景:策略庫${want}策略;`), `隻數 ${n}`)
        }
        let st14 = stOf(root, { cadenceDays: 14 })
        let [nb14, db14] = briefs(makeTexts({ st: st14, FD_ROOT: root }), st14)
        assert(nb14.includes('每 14 日只憑過去之資訊挑一組策略') && db14.includes('挑選模組每 14 日只憑過去資訊挑一組') && !nb14.includes('每週只憑'), '間隔 14 日')
        //數字字串 ⇒ 與數字者逐字相同(與評估器同一取值 cfgNumOf)
        let st14s = stOf(root, { cadenceDays: '14' })
        assert.deepEqual(briefs(makeTexts({ st: st14s, FD_ROOT: root }), st14s), [nb14, db14], '間隔之數字字串')
    })

    it('看板之「全體隨機約 …」與下單流量偏一側之判讀取同一份基準(settings.score.sideFlow 與內建值之合併)', () => {
        assert.deepEqual(sideFlowCfgOf(null), SIDE_FLOW)
        assert.deepEqual(sideFlowCfgOf({ baseShort: { train: 0.31 } }).baseShort, { backtest: SIDE_FLOW.baseShort.backtest, train: 0.31 })
        assert.equal(sideFlowCfgOf({ hi: 3 }).hi, 3)
        //看板之接線(真領域; 合成專案根之子行程): 未設 ⇒ 內建值;設了 ⇒ 該值
        let board = (sideFlow, nd = 4) => {
            let root = path.join(t.dir, `board_${sideFlow ? 'set' : 'none'}_${nd}`)
            let ld = path.join(root, 'ledger', 'eval')
            writeSynthLedger(ld, { n: 20, nBars: 400, seed: 3 })
            fs.mkdirSync(path.join(root, 'arms'), { recursive: true })
            fs.copyFileSync(path.join(FD_ROOT, 'arms', 'base.json'), path.join(root, 'arms', 'base.json'))
            //其餘之鍵沿用套件之參考設定(同 unit-reworkId); 判讀之門檻(score)明給, sideFlow 只在本案給
            let base = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
            let my = stOf(root, { ledgerDir: ld })
            let st = {
                ...base,
                periods: my.periods,
                eval: { ...my.eval, replicaSeeds: 0, warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7], nullDraws: nd, seed: 1, timeoutSec: 900 },
                score: { ...my.score, ...(sideFlow ? { sideFlow } : {}) },
                backtest: { ...base.backtest, enabled: false },
                rsi: { ...base.rsi, root: path.join(root, 'rsi') },
                records: { nodeDir: path.join(root, 'rsi/records/nodes'), dreamDir: path.join(root, 'rsi/records/dreams'), trashDir: path.join(root, 'rsi/records/trash'), workDir: path.join(root, 'rsi/work'), toolboxDir: path.join(root, 'rsi/toolbox') },
                resources: {},
            }
            fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(st), 'utf8')
            let SRC = pathToFileURL(path.join(FD_ROOT, 'src')).href + '/'
            fs.writeFileSync(path.join(root, 'child.mjs'), `let { getSettings } = await import(${JSON.stringify(SRC + 'cfg.mjs')})\nlet { makeProject } = await import(${JSON.stringify(SRC + 'domain/domain.mjs')})\nlet p = makeProject(getSettings(), { dispatch: async () => ({ ok: false }) })\nawait p.writeBoard()\n`, 'utf8')
            let r = spawnSync(process.execPath, [path.join(root, 'child.mjs')], { cwd: root, env: { ...process.env, ARSI_ROOT: root }, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(0, 800))
            let fp = path.join(root, 'rsi', 'ARMS_BOARD.md')
            return fs.readFileSync(fp, 'utf8')
        }
        assert(board(null).includes('(訓練期之診斷 / 回測期;全體隨機約 0.22 / 0.16)'))
        let b = board({ baseShort: { backtest: 0.27, train: 0.33 } })
        assert(b.includes('(訓練期之診斷 / 回測期;全體隨機約 0.33 / 0.27)') && !b.includes('約 0.22 / 0.16'))
        //看板之「虛無 p 於 N 抽之下限」取自 eval.nullDraws(R-REC-36): 下限 = 1 ÷ (1 + 抽數)四捨五入至小數第 4 位(同評估器之 p); 64 抽 = 0.0154(寫死時之值)
        for (let [nd, floor] of [[4, '0.2'], [32, '0.0303'], [64, '0.0154'], ['64', '0.0154']]) {
            let bn = board(null, nd)
            assert(bn.includes(`虛無 p 於 ${nd} 抽之下限為 ${floor}。`), `${nd} 抽: ${bn.split('\n').find((x) => x.includes('之下限為')) || ''}`.slice(0, 300))
        }
        assert(!board(null, 32).includes('0.0154'), '不留 64 抽之下限')
    })

    it('節點文件之「下單之做空比例」一列所附之「全體隨機約 …」亦取同一份基準:迴圈之驗證(reverifyAll → verify)與補算(rescanSideFlow)兩個呼叫點皆帶入 settings.score.sideFlow;補算重產之補充列與迴圈之驗證所產者一致(含半庫版之說明列)', function () {
        this.timeout(600000)
        //接縫不用替身: 真 w-recursi + 本套件真實之領域(makeProject 之 reverifyAll → verify → 子行程之評估入口; rescanSideFlow 讀工作夾內之重放結果檔); 只有「派工」換成假的(本案不派)
        //  評估入口以專案根之進入檔起(其設 ARSI_ROOT = 自身所在) ⇒ 整段於子行程內執行(ARSI_ROOT = 合成專案之根)
        //  pk(選配): 成品之形狀 { half?: 成品自述之 meta.params.half, rand: 成品用 ctx.rand, dropMeta?: 'full' | 'train'(補算前去掉該結果檔之 pickMeta) }; 給了才重放(replicaSeeds 1、虛無 4 抽), 未給者同前(不重放、成品不自述 params)
        let run = (sideFlow, pk = null) => {
            let root = path.join(t.dir, `notes_${sideFlow ? 'set' : 'none'}${pk ? `_h${String(JSON.stringify(pk.half)).replace(/\W/g, 'q')}${pk.dropMeta ? `_drop${pk.dropMeta}` : ''}` : ''}`)
            let ld = path.join(root, 'ledger', 'eval')
            writeSynthLedger(ld, { n: 60, nBars: 2400, seed: 7 })
            let base = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
            let st = {
                ...base,
                periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' }, holdoutFrom: '2099-01-01T00:00:00' },
                source: { libraryRoot: path.join(root, 'nolib'), keyOhlc: 'SYM_4hr', barHours: 4 },
                eval: { ledgerDir: ld, replicaSeeds: pk ? 1 : 0, ...(pk ? { replicaNullDraws: 4 } : {}), warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7], nullDraws: 4, seed: 1, limits: { monthlyOrders: 400, peakHold: 50 }, timeoutSec: 900 },
                score: { ...base.score, ...(sideFlow ? { sideFlow } : {}) },
                backtest: { ...base.backtest, enabled: false },
                rsi: { ...base.rsi, root: path.join(root, 'rsi') },
                records: { nodeDir: path.join(root, 'rsi/records/nodes'), dreamDir: path.join(root, 'rsi/records/dreams'), trashDir: path.join(root, 'rsi/records/trash'), workDir: path.join(root, 'rsi/work'), toolboxDir: path.join(root, 'rsi/toolbox') },
                //資源閘關閉: 參考設定之門檻依全機負載而定, 測試之成敗不得隨機器之負載而變
                resources: {},
            }
            assert.strictEqual(base.score.sideFlow, undefined, '前提: 套件之參考設定未設 score.sideFlow(未設之案才是內建值)')
            fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
            fs.mkdirSync(path.join(root, 'arms'), { recursive: true })
            fs.copyFileSync(path.join(FD_ROOT, 'arms', 'base.json'), path.join(root, 'arms', 'base.json'))
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(st), 'utf8')
            let SRC = pathToFileURL(path.join(FD_ROOT, 'src')).href + '/'
            fs.writeFileSync(path.join(root, 'g_eval.mjs'), `import path from 'path'\nimport { fileURLToPath } from 'url'\nprocess.env.ARSI_ROOT = path.dirname(fileURLToPath(import.meta.url))\nawait import(${JSON.stringify(SRC + 'cli/eval.mjs')})\n`, 'utf8')
            fs.writeFileSync(path.join(root, 'child.mjs'), `import fs from 'fs'
import path from 'path'
let { getSettings } = await import(${JSON.stringify(SRC + 'cfg.mjs')})
let { makeProject } = await import(${JSON.stringify(SRC + 'domain/domain.mjs')})
let { specHash } = await import(${JSON.stringify(SRC + 'engineApi.mjs')})
let root = process.env.ARSI_ROOT
let P = makeProject(getSettings(), { dispatch: async () => ({ ok: false, error: 'no dispatch in test' }), gate: null, catalogFile: path.join(root, 'catalog.json') })
P.rsi.init()
let arm = P.selectable[0].id
let spec = { arms: [arm], base: null }
let id = P.idOf(spec)
P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round: 1, raw: { attempt: 1 } })
let wd = path.join(root, 'rsi', 'work', id)
fs.mkdirSync(wd, { recursive: true })
let pk = ${JSON.stringify(pk || {})}
let metaSrc = "{ arms: ['" + arm + "']" + (pk.half === undefined ? '' : ', params: { half: ' + JSON.stringify(pk.half) + ' }') + ' }'
let shiftSrc = pk.rand ? 'Math.floor(ctx.rand() * ctx.n)' : '0'
fs.writeFileSync(path.join(wd, 'pick.mjs'), 'export const meta = ' + metaSrc + '\\nexport default function pick(ctx) { let r = ' + shiftSrc + '; return [1, 5, 9, 13, 17, 21, 25].map((s) => (s + ctx.k + r) % ctx.n) }\\nexport function accept(sig, book) { return book.open < 5 }\\n', 'utf8')
P.records.putNodeDoc({ nodeId: id, round: 1, attempt: 1, status: 'verified', spec, task: { goal: 'g', type: 'explore' }, plan: {}, code: {}, results: { claimed: {} }, conclusion: { outcome: 'neutral', summary: 's' }, harness: { ok: true, summary: [], notes: [], checks: { issues: [] }, score: { S: 0, ladder: 0, flags: { vetoed: false, why: [] } }, raw: {} } })
let notesOfDoc = () => ((P.records.getNodeDoc(id).harness || {}).notes || []).map(String)
let lineOf = () => (notesOfDoc().find((s) => s.startsWith('下單之做空比例')) || null)
let res = {}
//呼叫點一: 迴圈之驗證(verify 之回傳 notes 經 reverifyAll 寫入節點文件)
res.rv = await P.reverifyAll({ why: 'wiring' })
res.a = lineOf()
res.nA = notesOfDoc()
//(選配)去掉某一個重放結果檔之 pickMeta: 補算之半庫判定只可取 harness_full.json 者(迴圈所判之同一份資料)
if (pk.dropMeta) {
    let fpM = path.join(wd, pk.dropMeta === 'full' ? 'harness_full.json' : 'harness_train.json')
    let jM = JSON.parse(fs.readFileSync(fpM, 'utf8'))
    delete jM.pickMeta
    fs.writeFileSync(fpM, JSON.stringify(jM), 'utf8')
}
//呼叫點二: 補算。先把樹上之 raw.train.shortShare 改成他值(使其判為有變動)、節點文件之補充列清空 ⇒ 其後之該列必出自 rescanSideFlow
P.rsi.store.updateNode(id, (x) => {
    x.raw = { ...x.raw, train: { ...x.raw.train, shortShare: -1 } }
})
let d = P.records.getNodeDoc(id)
P.records.putNodeDoc({ ...d, harness: { ...d.harness, notes: [] } })
res.cleared = lineOf()
res.k = P.rescanSideFlow()
res.b = lineOf()
res.nB = notesOfDoc()
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
            assert.equal(res.rv.length, 1)
            assert.equal(res.rv[0].ok, true, JSON.stringify(res.rv))
            assert(typeof res.a === 'string', '驗證後之節點文件須有「下單之做空比例」一列(合成帳本兩側皆有下單)')
            assert.strictEqual(res.cleared, null, '清空後該列不在')
            assert.equal(res.k, 1, '補算有變動之節點數')
            assert(typeof res.b === 'string', '補算後之節點文件須有該列')
            return res
        }
        //未設 ⇒ 內建值(與改前逐字相同)
        let dft = `;全體隨機約 ${SIDE_FLOW.baseShort.train} / ${SIDE_FLOW.baseShort.backtest} ——`
        let r0 = run(null)
        assert(r0.a.includes(dft), r0.a)
        assert(r0.b.includes(dft), r0.b)
        //「——」與其後之說明與改前逐字相同(基準以外之字一字不差; 改前之原文為固定字面值)
        let tail = ' 席次之做多比例正常而下單偏在一側者,是兩側活躍度不對稱所致之組成;兩期皆遠高(或遠低)於隨機者,回測期之方向可能經此寫進模組'
        assert(r0.a.endsWith(dft + tail), `驗證: ${r0.a}`)
        assert(r0.b.endsWith(dft + tail), `補算: ${r0.b}`)
        //設了 ⇒ 兩個呼叫點皆為該值, 不留內建值
        let r1 = run({ baseShort: { backtest: 0.27, train: 0.33 } })
        assert(r1.a.includes(';全體隨機約 0.33 / 0.27 ——') && !r1.a.includes(dft), `驗證: ${r1.a}`)
        assert(r1.b.includes(';全體隨機約 0.33 / 0.27 ——') && !r1.b.includes(dft), `補算: ${r1.b}`)
        //兩個呼叫點所產之該列逐字相同(同一組比例、同一份基準)
        assert(r1.a.endsWith(`;全體隨機約 0.33 / 0.27 ——${tail}`) && r1.b.endsWith(`;全體隨機約 0.33 / 0.27 ——${tail}`), `設了之 ⇒ 只有基準之數字不同: ${r1.a}`)
        assert.equal(r1.a, r1.b)
        assert.equal(r0.a, r0.b)
        //補算重產之補充列與迴圈之驗證所產者逐列相同(含「半庫版」之說明列): 是否為半庫版取節點工作夾內重放結果檔(harness_full.json)之 pickMeta —— 迴圈所判之同一份資料(成品自述 meta.params.half 為 0 或 1)
        //  成品用 ctx.rand ⇒ 換亂數種子之重放與正本之選集不同, 有重放之 S(半庫版之說明列只在有重放之 S 時出現; 否則兩處皆不出現而分辨不出補算有沒有帶 half)
        let isHalfNote = (s) => s.startsWith('半庫版(成品之 meta.params.half 為 0 或 1')
        let isReplayNote = (s) => s.startsWith('換亂數種子與同分次序之重放')
        let strip = (ns) => ns.filter((s) => !/以改版後之評估器重跑/.test(s)) //reverifyAll 於首列加之重跑註記(補算保留首列者, 本案之補算前已清空)
        //  列: [成品自述之 meta.params.half, 迴圈之驗證是否有該列, 補算是否有該列, 補算前去掉哪一個結果檔之 pickMeta]
        //  half 之判定值只有數字 0 與 1: 字串 '0'、true、2 皆否(寬鬆相等之寫法會把 '0'、true 當半庫版); 補算只取 harness_full.json 之 pickMeta(去掉 harness_train.json 者不影響; 去掉 harness_full.json 者 ⇒ 無從判定 ⇒ 非半庫版)
        for (let [half, wantA, wantB, dropMeta] of [[0, true, true], [1, true, true], [undefined, false, false], [2, false, false], ['0', false, false], [true, false, false], [0, true, true, 'train'], [0, true, false, 'full']]) {
            let tag = `meta.params.half = ${JSON.stringify(half)}${dropMeta ? `(補算前去掉 harness_${dropMeta}.json 之 pickMeta)` : ''}`
            let r = run(null, { half, rand: true, dropMeta })
            assert(r.nA.some(isReplayNote) && r.nB.some(isReplayNote), `${tag}: 前提: 迴圈有重放之 S(驗證與補算之補充列皆有重放列)`)
            assert.equal(r.nA.filter(isHalfNote).length, wantA ? 1 : 0, `${tag}: 迴圈之驗證 ${wantA ? '須' : '不得'}有「半庫版」之說明列`)
            assert.equal(r.nB.filter(isHalfNote).length, wantB ? 1 : 0, `${tag}: 補算 ${wantB ? '須' : '不得'}有「半庫版」之說明列`)
            assert.deepStrictEqual(strip(r.nB), strip(r.nA).filter((s) => wantA === wantB || !isHalfNote(s)), `${tag}: 補算與迴圈之驗證所產之補充列逐列相同${wantA === wantB ? '' : '(除「半庫版」之說明列)'}`)
        }
        //補算之該列與基準亦同(設了基準 + 半庫版: 兩處皆為設定值)
        let rh = run({ baseShort: { backtest: 0.27, train: 0.33 } }, { half: 0, rand: true })
        assert(rh.nB.some(isHalfNote) && rh.nB.some((s) => s.includes(';全體隨機約 0.33 / 0.27 ——')), `設了基準 + 半庫版: ${rh.nB.length} 列`)
        assert.deepStrictEqual(strip(rh.nB), strip(rh.nA), '設了基準 + 半庫版: 補算與迴圈之驗證逐列相同')
    })

    //套件之參考設定(settings.json)與合約之參考版: 兩者所寫之事實相同(合約依設定產出時逐字不變)
    let refText = () => fs.readFileSync(path.join(FD_ROOT, 'contract', 'pick-contract.md'), 'utf8')
    let tplText = () => fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8')
    //另一個策略庫之設定(每項皆與參考版所寫者不同)
    let otherSt = () => {
        let s = JSON.parse(tplText())
        s.source.barHours = 24
        s.periods = { train: { start: '2030-01-01T00:00:00', end: '2031-01-01T00:00:00' }, backtest: { start: '2031-01-01T00:00:00', end: '2031-06-01T00:00:00' }, holdoutFrom: '2031-06-02T00:00:00' }
        Object.assign(s.eval, { cadenceDays: 5, warmupDays: 120, horizons: [1, 3, 9], nullDraws: 32, fitEnd: { long: '2030-05-01T00:00:00', short: '2030-11-02T00:00:00' }, limits: { monthlyOrders: 350, peakHold: 40 }, actBins: 8, sideActHalf: 40 })
        s.score = { ...s.score, ladder1: { S: 12, nullP: 0.02 }, ladder2: { freshMin: 8, worstPhaseMin: 4 }, ladder3: { monthlyOrders: 250, peakHold: 25 } }
        s.resources = { ...s.resources, evalMaxWaitSec: 120 }
        return s
    }

    it('合約之參考版(renderContract):每根 4 小時且依套件之參考設定(或未給設定)⇒ 與參考版逐字相同;其他之週期改寫與週期有關之字句;期間、保留期起點、回測期長度、求解窗、決策間隔、地平線、虛無抽數、門檻、硬上限等一律取自設定;錨點不合即拋', () => {
        let ref = refText()
        let tpl = JSON.parse(tplText())
        assert.strictEqual(renderContract(ref), ref)
        assert.strictEqual(renderContract(ref, { barHours: 4, settings: tpl }), ref, '參考設定 ⇒ 逐字相同')
        //另一個策略庫之設定(每根 1 日): 週期之字句與各項事實皆改寫, 不留參考版之值
        let d = renderContract(ref, { barHours: 24, settings: otherSt() })
        for (let s of [
            '決策棒序號(24 小時一根)', '(24 小時棒 ⇒ 每日 1 根;', '、`barsPerDay`(1)', '`lastEntryAgo`(距最近一次進場之 K 棒數〔每根 24 小時〕;', '`nBack` 預設 180〔根;每根 24 小時 ⇒ 約 180 日〕,', '`nBack` 預設 180〔根;每根 24 小時〕,取整', '供以進場棒之價為準之計算(每日只有 1 根,無日內之進場時刻結構)',
            '- 每 5 日決策一次;七個起始相位(日)各跑一遍取平均。第一個決策日在數據起點後 120 日(暖機)。', '回傳之策略於其後 5 日內的每個進場訊號', '訓練期(2030-01-01 ~ 2031-01-01)= 策略庫之求解期', '(做多策略之求解窗止於 2030-05-01,做空止於 2030-11-02)', '**回測期(2031-01-01 ~ 2031-06-01)= 評估期**', '2031-06-02 以後之資料不提供', '回測期只有約 5 個月',
            '做多 = 2030-05-01、做空 = 2030-11-02 所對應之棒序號', '硬限制:**月均單 ≤ 350、最大同時持倉 ≤ 40**', '相位 0 與 3、5 日地平線、不算虛無', '七相位、1/3/9 日新鮮度、同劑量虛無 32 抽', '選集於其後 1 / 3 / 9 日內之等效年化', '重複 32 次',
            '1 = `S ≥ 12` 且各虛無(同劑量;有算時另含同訊號量、同活躍度、同側同活躍度)之 `p ≤ 0.02`;2 = 各地平線之新鮮度皆 ≥ 8 且最差相位 ≥ 4;3 = 月均單 ≤ 250 且最大同時持倉 ≤ 25。', '分為 8 層', '只分 8 層', '名次 ±40 名內', '每個決策視窗(5 日)之訊號數', '至多約 120 秒', '(如 `2030-01-01T00:00:00`;',
        ]) {
            assert(d.includes(s), s)
        }
        assert.equal(d.split('p ≤ 0.02').length - 1, 5, '虛無之 p 之門檻: 5 處皆改寫')
        //數值類設定以數字字串給者 ⇒ 與數字者逐字相同(與評估器同一取值 cfgNumOf;判讀與硬上限以數值比較)
        let sStr = otherSt()
        for (let k of ['cadenceDays', 'warmupDays', 'nullDraws', 'actBins', 'sideActHalf']) {
            sStr.eval[k] = String(sStr.eval[k])
        }
        sStr.eval.limits = { monthlyOrders: '350', peakHold: '40' }
        sStr.score = { ...sStr.score, ladder1: { S: '12', nullP: '0.02' }, ladder2: { freshMin: '8', worstPhaseMin: '4' }, ladder3: { monthlyOrders: '250', peakHold: '25' } }
        assert.strictEqual(renderContract(ref, { barHours: 24, settings: sStr }), d, '數字字串')
        for (let s of ['(4 小時一根)', '每日 6 根', '`barsPerDay`(6)', '供日內層級之進場時刻結構', '2022-07-01', '2025-04-08', '2025-10-06', '2026-07-31', '2026-08-01', '約 10 個月', '每 7 日', '後 7 日', '(7 日)', '1/3/7/14/30', '1 / 3 / 7 / 14 / 30', '64 抽', '64 次', '≤ 400', '≤ 50', 'S ≥ 15', 'p ≤ 0.05', '≥ 10 且', '分為 10 層', '只分 10 層', '10 層', '±50', '約 90 秒']) {
            assert(!d.includes(s), `不留參考版之「${s}」`)
        }
        //每根 4 小時而求解窗之日期不同 ⇒ 仍取自設定
        let s4 = JSON.parse(tplText())
        s4.eval.fitEnd = { long: '2030-05-01T00:00:00', short: '2030-11-02T00:00:00' }
        let d4 = renderContract(ref, { barHours: 4, settings: s4 })
        assert(d4.includes('(做多策略之求解窗止於 2030-05-01,做空止於 2030-11-02)') && d4.includes('做多 = 2030-05-01、做空 = 2030-11-02 所對應之棒序號') && !d4.includes('2025-04-08') && d4.includes('(4 小時一根)'), '每根 4 小時 + 另一組求解窗')
        //求解窗只給一側 / 未給; 未給保留期之起點
        let s1 = JSON.parse(tplText())
        s1.eval.fitEnd = { short: '2030-11-02T00:00:00' }
        delete s1.periods.holdoutFrom
        let d1 = renderContract(ref, { settings: s1 })
        assert(d1.includes('(做空策略之求解窗止於 2030-11-02)') && d1.includes('做空 = 2030-11-02 所對應之棒序號(另一側為 -1)') && d1.includes('回測期以後之資料不提供'), '只給一側')
        let s0 = JSON.parse(tplText())
        delete s0.eval.fitEnd
        let d0 = renderContract(ref, { settings: s0 })
        assert(d0.includes('設定 `eval.fitEnd` 所對應之棒序號(未設定者為 -1)') && !d0.includes('求解窗止於') && d0.includes('= 策略庫之求解期'), '未給求解窗 ⇒ 通稱、不寫日期')
        //只給 barHours(未給設定): 只改週期之字句
        let h1 = renderContract(ref, { barHours: 1 })
        assert(h1.includes('(1 小時棒 ⇒ 每日 24 根;') && h1.includes('約 7.5 日') && h1.includes('供日內層級之進場時刻結構'), '每日多根者保留日內結構之用途')
        assert.throws(() => renderContract(ref.replace('、`barsPerDay`(6)', ''), { barHours: 24 }), /renderContract: the reference contract must contain the anchor/)
        assert.throws(() => renderContract(ref.replace('重複 64 次', ''), { settings: tpl }), /renderContract: the reference contract must contain the anchor/, '事實之錨點')
        assert.throws(() => renderContract(ref, { barHours: 5 }), /^Error: invalid barHours/)
    })

    it('initProject:全新專案根之參考設定之 source.barHours = --bar-hours(4 小時者與套件之參考設定逐位相同), 合約依其產出;重複同一指令為冪等;既有之設定照其值產出合約;兩處不同或不合 ⇒ 拋錯且未寫任何檔', () => {
        let ref = refText()
        let tpl = tplText()
        let rd = (r, rel) => fs.readFileSync(path.join(r, rel), 'utf8')
        let r0 = path.join(t.dir, 'ip0')
        initProject({ root: r0 })
        assert.strictEqual(rd(r0, 'docs/pick-contract.md'), ref)
        assert.strictEqual(rd(r0, 'settings.json'), tpl, '每根 4 小時 ⇒ 參考設定原樣')
        //全新專案根 + 每根 24 小時: 參考設定只改 source.barHours, 合約與之一致
        let r2 = path.join(t.dir, 'ip2')
        initProject({ root: r2, barHours: '24' })
        let st2 = rd(r2, 'settings.json')
        let want = JSON.parse(tpl)
        want.source.barHours = 24
        assert.deepEqual(JSON.parse(st2), want)
        assert.equal(st2.length, tpl.length + 1, '其餘逐字不變')
        let c2 = rd(r2, 'docs/pick-contract.md')
        assert.strictEqual(c2, renderContract(ref, { barHours: 24, settings: want }))
        assert(c2.includes('(24 小時棒 ⇒ 每日 1 根;'))
        //重複同一指令(及不帶旗標)⇒ 冪等
        for (let opt of [{ barHours: 24 }, {}]) {
            let again = initProject({ root: r2, ...opt })
            assert(again.kept.includes('settings.json') && again.kept.includes('docs/pick-contract.md') && !again.written.includes('settings.json') && !again.written.includes('docs/pick-contract.md'), JSON.stringify(opt))
            assert.strictEqual(rd(r2, 'settings.json'), st2)
            assert.strictEqual(rd(r2, 'docs/pick-contract.md'), c2)
            assert(!fs.existsSync(path.join(r2, 'docs', 'pick-contract.pkg.md')))
        }
        assert.throws(() => initProject({ root: r2, barHours: 4 }), /^Error: invalid barHours: must equal source\.barHours of settings\.json$/)
        assert.strictEqual(rd(r2, 'settings.json'), st2)
        //既有之設定(另一個策略庫): 合約依其值
        let r1 = path.join(t.dir, 'ip1')
        fs.mkdirSync(r1, { recursive: true })
        let o = otherSt()
        fs.writeFileSync(path.join(r1, 'settings.json'), JSON.stringify(o), 'utf8')
        initProject({ root: r1 })
        let c1 = rd(r1, 'docs/pick-contract.md')
        assert.strictEqual(c1, renderContract(ref, { barHours: 24, settings: o }))
        assert(c1.includes('`barsPerDay`(1)') && c1.includes('做多 = 2030-05-01') && c1.includes('**回測期(2031-01-01 ~ 2031-06-01)= 評估期**'))
        assert.strictEqual(rd(r1, 'settings.json'), JSON.stringify(o), '既有之設定不覆寫')
        let again = initProject({ root: r1 })
        assert(again.kept.includes('docs/pick-contract.md') && !fs.existsSync(path.join(r1, 'docs', 'pick-contract.pkg.md')))
        for (let [name, set, opt, re] of [['conflict', { source: { barHours: 4 } }, { barHours: 24 }, /^Error: invalid barHours: must equal source\.barHours of settings\.json$/], ['badSt', { source: { barHours: 5 } }, {}, /^Error: invalid source\.barHours: must be/], ['badOpt', null, { barHours: 'x' }, /^Error: invalid barHours: must be/], ['emptyOpt', null, { barHours: '' }, /^Error: invalid barHours: must be/]]) {
            let r = path.join(t.dir, `ip_${name}`)
            fs.mkdirSync(r, { recursive: true })
            if (set) {
                fs.writeFileSync(path.join(r, 'settings.json'), JSON.stringify(set), 'utf8')
            }
            assert.throws(() => initProject({ root: r, ...opt }), re, name)
            assert.deepEqual(fs.readdirSync(r), set ? ['settings.json'] : [], `${name}: 未寫任何檔`)
        }
    })

    it('initProject 之命令列:--bar-hours 其後無值、為另一個旗標或不合 ⇒ 離開碼 2 且未寫任何檔;有效之值 ⇒ 參考設定與合約皆依之', () => {
        let cli = path.join(FD_ROOT, 'src', 'tools', 'initProject.mjs')
        let run = (r, args) => spawnSync(process.execPath, [cli, '--root', r, ...args], { cwd: t.dir, windowsHide: true, encoding: 'utf8', timeout: 60000 })
        for (let [name, args] of [['noValue', ['--bar-hours']], ['flagNext', ['--bar-hours', '--dry']], ['bad', ['--bar-hours', 'x']], ['notDivide', ['--bar-hours', '5']]]) {
            let r = path.join(t.dir, `cli_${name}`)
            let o = run(r, args)
            assert.equal(o.status, 2, `${name}: ${o.stdout}${o.stderr}`)
            assert(/未執行: invalid barHours: must be/.test(o.stdout), `${name}: ${o.stdout}`)
            assert(!fs.existsSync(r), `${name}: 未寫任何檔`)
        }
        let r24 = path.join(t.dir, 'cli_24')
        let o24 = run(r24, ['--bar-hours', '24'])
        assert.equal(o24.status, 0, `${o24.stdout}${o24.stderr}`)
        assert.equal(JSON.parse(fs.readFileSync(path.join(r24, 'settings.json'), 'utf8')).source.barHours, 24)
        assert(fs.readFileSync(path.join(r24, 'docs', 'pick-contract.md'), 'utf8').includes('(24 小時棒 ⇒ 每日 1 根;'))
        let o24b = run(r24, ['--bar-hours', '24'])
        assert(o24b.status === 0 && /已寫入 0 檔/.test(o24b.stdout), `冪等: ${o24b.stdout}`)
        let r4 = path.join(t.dir, 'cli_none')
        let o4 = run(r4, [])
        assert.equal(o4.status, 0)
        assert.strictEqual(fs.readFileSync(path.join(r4, 'settings.json'), 'utf8'), tplText())
        assert.strictEqual(fs.readFileSync(path.join(r4, 'docs', 'pick-contract.md'), 'utf8'), refText())
    })

    it('迴圈組裝專案時之預檢(makeProject;規則 R-EV-44,借用本節之專案夾具):期間之界線、求解窗不在帳本之棒格線上、或 eval.trainFromStart 不合 ⇒ 拒絕(與評估時同一訊息);合法之設定照常', () => {
        let pre = (name, patch) => {
            let root = path.join(t.dir, `pre_${name}`)
            let ld = path.join(root, 'ledger', 'eval')
            writeSynthLedger(ld, { n: 12, nBars: 300, seed: 5 })
            fs.mkdirSync(path.join(root, 'arms'), { recursive: true })
            fs.copyFileSync(path.join(FD_ROOT, 'arms', 'base.json'), path.join(root, 'arms', 'base.json'))
            let base = JSON.parse(tplText())
            let my = stOf(root, { ledgerDir: ld })
            let st = {
                ...base,
                periods: my.periods,
                eval: { ...my.eval, replicaSeeds: 0, warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7], nullDraws: 4, seed: 1, timeoutSec: 900 },
                score: my.score,
                backtest: { ...base.backtest, enabled: false },
                rsi: { ...base.rsi, root: path.join(root, 'rsi') },
                records: { nodeDir: path.join(root, 'rsi/records/nodes'), dreamDir: path.join(root, 'rsi/records/dreams'), trashDir: path.join(root, 'rsi/records/trash'), workDir: path.join(root, 'rsi/work'), toolboxDir: path.join(root, 'rsi/toolbox') },
                resources: {},
            }
            patch(st)
            fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(st), 'utf8')
            let SRC = pathToFileURL(path.join(FD_ROOT, 'src')).href + '/'
            fs.writeFileSync(path.join(root, 'child.mjs'), `let { getSettings } = await import(${JSON.stringify(SRC + 'cfg.mjs')})\nlet { makeProject } = await import(${JSON.stringify(SRC + 'domain/domain.mjs')})\ntry {\n    makeProject(getSettings(), { dispatch: async () => ({ ok: false }) })\n    console.log('PRE OK')\n}\ncatch (err) {\n    console.log('PRE ERR ' + err.message)\n}\n`, 'utf8')
            let r = spawnSync(process.execPath, [path.join(root, 'child.mjs')], { cwd: root, env: { ...process.env, ARSI_ROOT: root }, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(0, 800))
            return (r.stdout.split(/\r?\n/).find((x) => x.startsWith('PRE ')) || '').slice(4)
        }
        assert.equal(pre('ok', (st) => Object.assign(st.eval, { fitEnd: { long: '2030-05-01T04:00:00' }, trainFromStart: true })), 'OK')
        for (let [name, patch, msg] of [
            ['fitEnd', (st) => {
                st.eval.fitEnd = { long: '2030-05-01T02:00:00' }
            }, 'ERR invalid eval.fitEnd.long: must be a time on the bar grid of the ledger'],
            ['trainEnd', (st) => {
                st.periods.train.end = '2031-01-01T00:30:00'
            }, 'ERR invalid periods.train.end: must be a time on the bar grid of the ledger'],
            ['btStart', (st) => {
                st.periods.backtest.start = '2031-01-01T01:00:00'
            }, 'ERR invalid periods.backtest.start: must be a time on the bar grid of the ledger'],
            ['tfsType', (st) => {
                st.eval.trainFromStart = 'yes'
            }, 'ERR invalid eval.trainFromStart: must be a boolean'],
            ['tfsStart', (st) => {
                st.eval.trainFromStart = true
                st.periods.train.start = '2030-01-01T03:00:00'
            }, 'ERR invalid periods.train.start: must be a time on the bar grid of the ledger (required by eval.trainFromStart)'],
            //求解窗只給做空一側而不在格線上(兩側各自核對)
            ['fitEndS', (st) => {
                st.eval.fitEnd = { long: '2030-05-01T04:00:00', short: '2030-11-02T06:00:00' }
            }, 'ERR invalid eval.fitEnd.short: must be a time on the bar grid of the ledger'],
            //缺 periods.train ⇒ 設定錯誤(invalid …;不是 TypeError)
            ['noTrain', (st) => {
                delete st.periods.train
            }, 'ERR invalid periods.train.end: must be a time on the bar grid of the ledger'],
            //影響評估之數字(暖機日數、決策間隔、虛無抽數、活躍度分層數、名次寬度)給了而無效 ⇒ 設定錯誤(R-EV-44 ④之二; 訊息不帶輸入值); 帳本為每根 4 小時(每日 6 根)
            ['nullDraws', (st) => {
                st.eval.nullDraws = -1
            }, 'ERR invalid eval.nullDraws: must be a non-negative integer'],
            ['cadence', (st) => {
                st.eval.cadenceDays = 'x'
            }, 'ERR invalid eval.cadenceDays: must be a positive number'],
            ['warmup', (st) => {
                st.eval.warmupDays = true
            }, 'ERR invalid eval.warmupDays: must be a non-negative number'],
            ['actBins', (st) => {
                st.eval.actBins = 0
            }, 'ERR invalid eval.actBins: must be an integer from 1 to 256'],
            //分層數以 Uint8Array 存層號 ⇒ 至多 256(257 層溢位而靜默算錯)
            ['actBins257', (st) => {
                st.eval.actBins = 257
            }, 'ERR invalid eval.actBins: must be an integer from 1 to 256'],
            //訓練期起點、回測期終點缺 ⇒ 設定錯誤(不是組裝任務書時之 TypeError)
            ['noTrainStart', (st) => {
                delete st.periods.train.start
            }, 'ERR invalid periods.train.start: must be a time string'],
            ['noBtEnd', (st) => {
                st.periods.backtest.end = 20310601
            }, 'ERR invalid periods.backtest.end: must be a time string'],
            ['half', (st) => {
                st.eval.sideActHalf = 1.5
            }, 'ERR invalid eval.sideActHalf: must be a non-negative integer'],
            //0.1 日 × 每日 6 根 = 0.6 根 ⇒ 不是整數之棒序
            ['cadBars', (st) => {
                st.eval.cadenceDays = 0.1
            }, 'ERR invalid eval.cadenceDays: must be a positive number of days that is a whole number of bars'],
            //數字字串 ⇒ 收受(K7), 與數字者同一路徑
            ['strNums', (st) => Object.assign(st.eval, { warmupDays: '60', cadenceDays: '7', nullDraws: '4', actBins: '10', sideActHalf: '50' }), 'OK'],
        ]) {
            let got = pre(name, patch)
            assert(got.startsWith(msg), `${name}: ${got}`)
        }
        //預檢函數本身: 缺 periods / periods.train / periods.backtest(或非物件)⇒ invalid periods.…(Error, 不是 TypeError)
        let meta4 = { time0: '2022-07-01T00:00:00', barHours: 4 }
        for (let [st, where] of [[{}, 'train.end'], [{ periods: null }, 'train.end'], [{ periods: { train: null } }, 'train.end'], [{ periods: { train: 'x' } }, 'train.end'], [{ periods: { train: { end: '2023-01-01T00:00:00' } } }, 'backtest.start']]) {
            assert.throws(() => checkEvalSettings(st, meta4), (err) => !(err instanceof TypeError) && err.message === `invalid periods.${where}: must be a time on the bar grid of the ledger`, JSON.stringify(st))
        }
        //命令列(g_rsi.mjs 與用到專案組裝之工具): 印 ERROR invalid …、離開碼 2(不印堆疊); 合法之設定照常
        let runIn = (root, file, args = []) => spawnSync(process.execPath, [path.join(FD_ROOT, 'src', file), ...args], { cwd: root, env: { ...process.env, ARSI_ROOT: root }, windowsHide: true, encoding: 'utf8', timeout: 120000 })
        let noStack = (r) => !/\n\s+at |at makeProject/.test(`${r.stdout}\n${r.stderr}`)
        for (let [name, want, re] of [['fitEnd', 2, /^ERROR invalid eval\.fitEnd\.long: must be a time on the bar grid of the ledger/m], ['trainEnd', 2, /^ERROR invalid periods\.train\.end: must be a time on the bar grid of the ledger/m], ['btStart', 2, /^ERROR invalid periods\.backtest\.start: must be a time on the bar grid of the ledger/m], ['nullDraws', 2, /^ERROR invalid eval\.nullDraws: must be a non-negative integer/m], ['cadBars', 2, /^ERROR invalid eval\.cadenceDays: must be a positive number of days that is a whole number of bars/m], ['strNums', 0, null], ['ok', 0, null]]) {
            let root = path.join(t.dir, `pre_${name}`)
            let r = runIn(root, 'cli/rsi.mjs', ['--mode', 'status'])
            assert.equal(r.status, want, `${name}: ${r.stdout}\n${r.stderr}`.slice(0, 800))
            if (re) {
                assert(re.test(r.stdout) && noStack(r), `${name}: ${r.stdout}\n${r.stderr}`.slice(0, 800))
            }
        }
        //工具(searchMap、briefPreview、armInactive、armDecide、fakeRound)與 g_rsi.mjs 一致: 設定不合 ⇒ 離開碼 2、ERROR、無堆疊
        let rootT = path.join(t.dir, 'pre_trainEnd')
        fs.mkdirSync(path.join(rootT, 'examples'), { recursive: true })
        fs.copyFileSync(path.join(FD_ROOT, 'examples', 'pick_example.mjs'), path.join(rootT, 'examples', 'pick_example.mjs'))
        for (let tool of ['searchMap', 'briefPreview', 'armInactive', 'armDecide', 'fakeRound']) {
            let r = runIn(rootT, `tools/${tool}.mjs`)
            assert.equal(r.status, 2, `${tool}: ${r.stdout}\n${r.stderr}`.slice(0, 800))
            assert(/^ERROR invalid periods\.train\.end: must be a time on the bar grid of the ledger/m.test(r.stdout) && noStack(r), `${tool}: ${r.stdout}\n${r.stderr}`.slice(0, 800))
        }
    })

    it('共同儲存區之說明:保留期之起點取自 settings.periods.holdoutFrom(未給者略去括號)', async () => {
        for (let [name, ho, want] of [['set', '2031-06-01T00:00:00', '- 保留期 = 回測期之後、未用於搜尋之期間(2031-06-01 起)。'], ['none', null, '- 保留期 = 回測期之後、未用於搜尋之期間。檢定由主控執行']]) {
            let root = path.join(t.dir, `ps_${name}`)
            let st = stOf(root)
            if (!ho) {
                delete st.periods.holdoutFrom
            }
            for (let k of Object.keys(st.records)) {
                fs.mkdirSync(st.records[k], { recursive: true })
            }
            await buildPickStore(st)
            let md = fs.readFileSync(path.join(st.rsi.root, 'picks', 'README.md'), 'utf8')
            assert(md.includes(want), name)
        }
    })
})
