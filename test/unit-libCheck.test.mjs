import assert from 'assert'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { spawnSync } from 'child_process'
import { loadLedger } from '../src/eval/ledger.mjs'
import { libReportOf, libTextOf, directionalOf, LIB_DIR_HI, LIB_DIR_LO } from '../src/domain/libStats.mjs'
import { ENTRY_RULES, entryWrites, guardEntry } from '../src/domain/agentEntries.mjs'
import { makeTmp, writeSynthLedger, FD_ROOT } from './tools/synthLedger.mjs'


//庫況體檢(規則 R-EV-48): src/domain/libStats.mjs 之計算與 tools/libCheck.mjs(主控用; 唯讀、只印; agent 一律拒跑)
//  合成帳本之止盈、止損改寫為「候選值之格點」(各策略依序號取格點之一, 各值之隻數不同), 兩側依序號而定(每 3 隻 1 隻做空)
const N = 61
const NB = 2400
const TRAIN_END = 1200
const EV_FROM = 1290
let w = (dir, name, arr) => fs.writeFileSync(path.join(dir, name), Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength))
let patchGrid = (dir) => {
    w(dir, 'tp.f32', Float32Array.from({ length: N }, (_, s) => (1 + (s % 4)) / 100))
    w(dir, 'sl.f32', Float32Array.from({ length: N }, (_, s) => (2 + (s % 7)) / 100))
}
let settingsOf = () => ({
    periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } },
    eval: { ledgerDir: './ledger/eval', warmupDays: 60, cadenceDays: 7, phases: [0], horizons: [7], nullDraws: 4, seed: 1, limits: { monthlyOrders: 400, peakHold: 50 } },
    score: { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] },
    rsi: { root: './rsi' },
    records: { workDir: './rsi/work' },
    dispatch: {},
})
//q, 分位(排序後之第 ⌊p × n⌋ 個; 獨立寫一份)
let r4 = (x) => Math.round(x * 10000) / 10000
let distOf = (xs) => {
    if (!xs.length) {
        return { n: 0, min: null, p10: null, p50: null, p90: null, max: null }
    }
    let s = [...xs].sort((a, b) => a - b)
    let q = (p) => r4(s[Math.min(s.length - 1, Math.floor(p * s.length))])
    return { n: s.length, min: r4(s[0]), p10: q(0.1), p50: q(0.5), p90: q(0.9), max: r4(s[s.length - 1]) }
}
let hashTree = (dir) => {
    let out = []
    let walk = (d) => {
        for (let e of fs.readdirSync(d, { withFileTypes: true })) {
            let fp = path.join(d, e.name)
            if (e.isDirectory()) {
                walk(fp)
            }
            else {
                out.push(`${path.relative(dir, fp)}:${crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex')}`)
            }
        }
    }
    walk(dir)
    return out.sort().join('\n')
}

describe('庫況體檢(libStats 與 tools/libCheck.mjs)', function () {
    this.timeout(300000)
    let t
    let root
    let L
    let mk = (name, patch = null) => {
        let r = path.join(t.dir, name)
        writeSynthLedger(path.join(r, 'ledger', 'eval'), { n: N, nBars: NB, seed: 9 })
        patchGrid(path.join(r, 'ledger', 'eval'))
        if (patch) {
            patch(path.join(r, 'ledger', 'eval'))
        }
        fs.mkdirSync(path.join(r, 'rsi'), { recursive: true })
        fs.writeFileSync(path.join(r, 'settings.json'), JSON.stringify(settingsOf()), 'utf8')
        return r
    }
    let run = (r, args, role = null) => {
        let env = { ...process.env, ARSI_ROOT: r }
        delete env.ARSI_AGENT_ROLE
        if (role) {
            env.ARSI_AGENT_ROLE = role
        }
        let x = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'tools', 'libCheck.mjs'), ...args], { cwd: r, env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
        return { status: x.status, stdout: x.stdout, stderr: x.stderr }
    }
    before(() => {
        t = makeTmp('libCheck')
        root = mk('p')
        L = loadLedger(path.join(root, 'ledger', 'eval'))
    })
    after(() => {
        t.cleanup()
    })

    it('libReportOf:兩側之策略與訂單之比例、候選值之占比、持倉天數、勝率與獲利因子(訓練期 / 評估期 / 評估期三等分)、進場頻率與獨立之算式相同(逐單依進場棒歸期)', () => {
        //對應規格(主控之裁定):「兩側之策略數與訂單之比例;止盈、止損各候選值之占比;持倉天數之分佈;兩側於訓練期與評估期之勝率與獲利因子(另列評估期三等分);進場頻率之分佈」
        let from = 300
        let rep = libReportOf(L, { trainFrom: from, trainEnd: TRAIN_END, evFrom: EV_FROM, evTo: NB })
        let isLong = (s) => L.mode[s] > 0
        let nLong = [...Array(N).keys()].filter(isLong).length
        assert.deepEqual(rep.sides.strategies, { long: nLong, short: N - nLong, longShare: r4(nLong / N) })
        let len = NB - EV_FROM
        let wins = [['train', from, TRAIN_END], ['eval', EV_FROM, NB], ['e1', EV_FROM, EV_FROM + Math.floor(len / 3)], ['e2', EV_FROM + Math.floor(len / 3), EV_FROM + Math.floor((2 * len) / 3)], ['e3', EV_FROM + Math.floor((2 * len) / 3), NB]]
        let indep = {}
        for (let [k, a, b] of wins) {
            let x = { long: { orders: 0, closed: 0, wins: 0, pos: 0, neg: 0, sum: 0, days: [], freq: [] }, short: { orders: 0, closed: 0, wins: 0, pos: 0, neg: 0, sum: 0, days: [], freq: [] } }
            for (let s = 0; s < N; s++) {
                let y = x[isLong(s) ? 'long' : 'short']
                let c = 0
                for (let j = L.off[s]; j < L.off[s + 1]; j++) {
                    if (L.ent[j] >= a && L.ent[j] < b) {
                        y.orders++
                        c++
                        if (L.ext[j] !== -1) {
                            y.closed++
                            y.wins += L.pnl[j] > 0 ? 1 : 0
                            y.pos += Math.max(0, L.pnl[j])
                            y.neg += Math.max(0, -L.pnl[j])
                            y.sum += L.pnl[j]
                            y.days.push((L.ext[j] - L.ent[j]) / 6)
                        }
                    }
                }
                y.freq.push(c / ((b - a) / 6) * 30)
            }
            indep[k] = x
        }
        assert.deepEqual(rep.sides.orders.train, { long: indep.train.long.orders, short: indep.train.short.orders, longShare: r4(indep.train.long.orders / (indep.train.long.orders + indep.train.short.orders)) })
        assert.deepEqual(rep.sides.orders.eval, { long: indep.eval.long.orders, short: indep.eval.short.orders, longShare: r4(indep.eval.long.orders / (indep.eval.long.orders + indep.eval.short.orders)) })
        assert.equal(rep.sides.orders.all.long + rep.sides.orders.all.short, L.off[N])
        let wp = (y) => ({ closed: y.closed, winRate: r4(y.wins / y.closed), profitFactor: r4(y.pos / y.neg), meanPnl: r4(y.sum / y.closed) })
        for (let side of ['long', 'short']) {
            assert.deepEqual(rep.winRate.train[side], wp(indep.train[side]), `訓練期 ${side}`)
            assert.deepEqual(rep.winRate.eval[side], wp(indep.eval[side]), `評估期 ${side}`)
            assert.deepEqual(rep.winRate.evalThirds.map((x) => x[side]), ['e1', 'e2', 'e3'].map((k) => wp(indep[k][side])), `三等分 ${side}`)
            assert.deepEqual(rep.holdDays.train[side], distOf(indep.train[side].days), `持倉天數 訓練期 ${side}`)
            assert.deepEqual(rep.holdDays.eval[side], distOf(indep.eval[side].days), `持倉天數 評估期 ${side}`)
            assert.deepEqual(rep.entryFreq30d.train[side], distOf(indep.train[side].freq), `進場頻率 訓練期 ${side}`)
            assert.deepEqual(rep.entryFreq30d.eval[side], distOf(indep.eval[side].freq), `進場頻率 評估期 ${side}`)
        }
        //鑑別之前提: 有進場在訓練期內而出場在其後之單(依進場棒歸期)、三等分之勝率與全段不同、有進場在下界之前之單
        let cross = 0
        let early = 0
        for (let j = 0; j < L.off[N]; j++) {
            cross += L.ent[j] < TRAIN_END && L.ent[j] >= from && L.ext[j] >= TRAIN_END ? 1 : 0
            early += L.ent[j] < from ? 1 : 0
        }
        assert(cross > 0 && early > 0)
        assert(rep.winRate.evalThirds.some((x) => x.long.winRate !== rep.winRate.eval.long.winRate))
        //各策略之進場與出場皆在訓練期內之已結單之持倉天數之中位(獨立寫一份; 偶數筆取中間兩數之均; 主控之裁定)
        let med = { long: [], short: [] }
        let none = { long: 0, short: 0 }
        for (let s = 0; s < N; s++) {
            let ds = []
            for (let j = L.off[s]; j < L.off[s + 1]; j++) {
                if (L.ent[j] >= from && L.ext[j] !== -1 && L.ext[j] < TRAIN_END) {
                    ds.push((L.ext[j] - L.ent[j]) / 6)
                }
            }
            ds.sort((a, b) => a - b)
            let k = isLong(s) ? 'long' : 'short'
            if (!ds.length) {
                none[k]++
            }
            else {
                med[k].push(ds.length % 2 ? ds[(ds.length - 1) / 2] : (ds[ds.length / 2 - 1] + ds[ds.length / 2]) / 2)
            }
        }
        assert.deepEqual(rep.holdDays.strategyMedianTrain, { long: distOf(med.long), short: distOf(med.short), noClosed: none })
        //候選值: 依值由小到大, 各值之隻數、占比與兩側各幾隻
        for (let [k, col] of [['tp', L.tp], ['sl', L.sl]]) {
            let vals = [...new Set(Array.from(col))].sort((a, b) => a - b)
            assert.equal(rep.candidates[k].kinds, vals.length)
            assert.deepEqual(rep.candidates[k].values, vals.map((v) => {
                let ss = [...Array(N).keys()].filter((s) => col[s] === v)
                return { value: Number(v.toPrecision(6)), n: ss.length, share: r4(ss.length / N), long: ss.filter(isLong).length, short: ss.filter((s) => !isLong(s)).length }
            }))
            assert(new Set(rep.candidates[k].values.map((x) => x.n)).size > 1, '前提:各值之隻數不全同')
        }
        assert.deepEqual(rep.candidates.tp.values.map((x) => x.value), [0.01, 0.02, 0.03, 0.04])
        assert.deepEqual(rep.directional, { hit: directionalOf(rep.winRate.eval.long.winRate, rep.winRate.eval.short.winRate), evalWinRate: { long: rep.winRate.eval.long.winRate, short: rep.winRate.eval.short.winRate }, hi: LIB_DIR_HI, lo: LIB_DIR_LO })
    })

    it('方向性之庫之判定:一側之勝率 ≥ 0.75 而另一側 ≤ 0.30(兩端皆含;兩個方向);任一側無值者否;門檻可改', () => {
        //對應規格(主控之裁定):「判方向性之庫(評估期一側之勝率 ≥ 75% 而另一側 ≤ 30%;門檻可由參數覆寫)」
        assert.equal(LIB_DIR_HI, 0.75)
        assert.equal(LIB_DIR_LO, 0.3)
        assert.equal(directionalOf(0.75, 0.3), true)
        assert.equal(directionalOf(0.3, 0.75), true)
        assert.equal(directionalOf(0.7499, 0.3), false)
        assert.equal(directionalOf(0.75, 0.3001), false)
        assert.equal(directionalOf(0.9, 0.5), false)
        assert.equal(directionalOf(null, 0.1), false)
        assert.equal(directionalOf(0.9, null), false)
        assert.equal(directionalOf(0.6, 0.4, 0.6, 0.4), true)
        assert.equal(directionalOf(0.6, 0.4), false)
    })

    it('命令列:--json 之輸出 = libReportOf(期間取自設定);文字之輸出 = libTextOf;離開碼 0;不寫任何檔', () => {
        //對應規格:「唯讀、只印」「期間: 訓練期 = [下界, 訓練期終點); 評估期 = [回測期起點, min(回測期終點, 帳本終點))」
        let h0 = hashTree(root)
        let a = run(root, ['--json'])
        assert.equal(a.status, 0, a.stdout + a.stderr)
        let time0 = Date.parse('2022-07-01T00:00:00Z')
        let isoOf = (b) => new Date(time0 + b * 4 * 3600000).toISOString().slice(0, 19)
        let want = libReportOf(L, { trainFrom: 0, trainEnd: TRAIN_END, evFrom: EV_FROM, evTo: NB, isoOf })
        assert.deepEqual(JSON.parse(a.stdout), want)
        assert.equal(want.periods.eval.to, '2023-08-05T00:00:00')
        assert.equal(want.periods.eval.from, '2023-02-01T00:00:00')
        assert.equal(want.periods.train.to, '2023-01-17T00:00:00')
        let b = run(root, [])
        assert.equal(b.status, 0, b.stdout + b.stderr)
        assert.equal(b.stdout, `${libTextOf(want)}\n`)
        for (let head of ['# 庫況體檢', '期間:', '1. 兩側:', '2. 止盈、止損之候選值之占比', '- 止盈之候選值(4 種)', '- 止損之候選值(7 種)', '3. 持倉天數', '   各策略之進場與出場皆在訓練期內之已結單之持倉天數之中位', '4. 勝率與獲利因子', '   評估期三等分:', '5. 進場頻率', '6. 方向性之庫:']) {
            assert(b.stdout.split('\n').some((l) => l.startsWith(head)), head)
        }
        assert.equal(hashTree(root), h0, '專案夾不變')
    })

    it('命令列:評估期一側全勝、另一側全敗之庫 ⇒ 判為方向性之庫;--dir-hi / --dir-lo 可改門檻;不合之值 ⇒ 離開碼 2(訊息不帶輸入值);帳本讀不到 ⇒ 離開碼 2', () => {
        let r2 = mk('dir', (dir) => {
            let rd = (name, C) => {
                let b = fs.readFileSync(path.join(dir, name))
                return new C(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
            }
            let off = rd('off.u32', Uint32Array)
            let ent = rd('ent.i32', Int32Array)
            let ext = rd('ext.i32', Int32Array)
            let pnl = rd('pnl.f32', Float32Array)
            for (let s = 0; s < N; s++) {
                for (let j = off[s]; j < off[s + 1]; j++) {
                    if (ent[j] >= EV_FROM && ext[j] >= 0) {
                        pnl[j] = s % 3 === 0 ? -1 - (j % 5) : 1 + (j % 7)
                    }
                }
            }
            w(dir, 'pnl.f32', pnl)
        })
        let a = run(r2, ['--json'])
        assert.equal(a.status, 0, a.stdout + a.stderr)
        let rep = JSON.parse(a.stdout)
        assert.deepEqual([rep.directional.hit, rep.directional.evalWinRate], [true, { long: 1, short: 0 }])
        let b = run(r2, [])
        assert(b.stdout.split('\n').some((l) => l.startsWith('6. 方向性之庫:**是**(評估期之勝率 做多 100.0%、做空 0.0%;判準:一側 ≥ 75.0% 而另一側 ≤ 30.0%) —— ')), b.stdout)
        //改門檻: 原庫(未改損益)於 --dir-hi 0 --dir-lo 1 即命中, --dir-hi 1 --dir-lo 0 即不命中
        assert.equal(JSON.parse(run(root, ['--json', '--dir-hi', '0', '--dir-lo', '1']).stdout).directional.hit, true)
        assert.deepEqual(JSON.parse(run(r2, ['--json', '--dir-hi', '1', '--dir-lo', '0']).stdout).directional, { hit: true, evalWinRate: { long: 1, short: 0 }, hi: 1, lo: 0 })
        assert.equal(JSON.parse(run(r2, ['--json', '--dir-hi', '1', '--dir-lo', '0.0']).stdout).directional.lo, 0)
        for (let [k, v] of [['dir-hi', '2'], ['dir-hi', 'abc'], ['dir-lo', '-0.1'], ['dir-lo', 'secret-token-xyz'], ['dir-hi', '']]) {
            let x = run(root, [`--${k}`, v])
            assert.equal(x.status, 2, `${k} ${v}`)
            assert.equal(x.stdout, `invalid --${k}: must be a number from 0 to 1\n`, `${k} ${v}`)
        }
        let r3 = path.join(t.dir, 'noLedger')
        fs.mkdirSync(r3, { recursive: true })
        fs.writeFileSync(path.join(r3, 'settings.json'), JSON.stringify(settingsOf()), 'utf8')
        let c = run(r3, [])
        assert.equal(c.status, 2)
        assert(c.stdout.startsWith('ERROR 無法載入評估帳本(settings.eval.ledgerDir;'), c.stdout)
    })

    it('設定讀不到(settings.json 不存在、為資料夾、不是合法之 JSON、缺必要欄位):離開碼 2、訊息一句固定(只帶 settings.json 之路徑,不帶原錯誤之內容)、不輸出庫況、無例外堆疊', () => {
        //對應規格(主控之裁定,排程第 589 項之接續輪;文件「設定不合 ⇒ 2」):「settings.json 不存在或不可讀時改為捕捉,離開碼 2,訊息一句(不帶路徑以外之內容; 依診斷輸出與遮罩)」
        let msgOf = (r) => `ERROR 無法讀取專案設定(settings.json 不存在、不可讀或內容不合; ${path.resolve(r, 'settings.json')});請於專案根執行, 或設定 ARSI_ROOT\n`
        let mkRoot = (name, put) => {
            let r = path.join(t.dir, name)
            fs.mkdirSync(r, { recursive: true })
            put(path.join(r, 'settings.json'))
            return r
        }
        let cases = [
            ['不存在', mkRoot('setNone', () => {})],
            ['為資料夾(不可讀)', mkRoot('setDir', (fp) => fs.mkdirSync(fp))],
            ['不是合法之 JSON(內含不應回顯之字樣)', mkRoot('setBadJson', (fp) => fs.writeFileSync(fp, '{ "secret-token-xyz": ', 'utf8'))],
            //節或路徑欄不合者(排程第 611 項 ①: 經 settingsOrExit, 與各進入檔、工具同一入口): 印 `ERROR invalid settings.<節或欄>: must be …`(原: 同為上列之固定訊息)
            ['缺 eval 欄位', mkRoot('setNoEval', (fp) => fs.writeFileSync(fp, JSON.stringify({ rsi: { root: './rsi' }, records: {}, dispatch: {} }), 'utf8')), 'ERROR invalid settings.eval: must be an object\n'],
            ['缺 records 欄位', mkRoot('setNoRec', (fp) => fs.writeFileSync(fp, JSON.stringify({ ...settingsOf(), records: undefined }), 'utf8')), 'ERROR invalid settings.records: must be an object\n'],
        ]
        for (let [what, r, want] of cases) {
            for (let args of [[], ['--json']]) {
                let x = run(r, args)
                assert.equal(x.status, 2, `${what} ${args.join(' ')}: ${x.stdout}${x.stderr}`)
                assert.strictEqual(x.stdout, want === undefined ? msgOf(r) : want, what)
                assert.equal(x.stderr, '', `${what}: 無例外堆疊`)
                assert(!x.stdout.includes('secret-token-xyz'), `${what}: 不回顯設定之內容`)
            }
        }
        //不合之參數先於讀設定檢查(訊息為參數之訊息); agent 之拒跑先於一切
        let x1 = run(cases[0][1], ['--dir-hi', '2'])
        assert.equal(x1.status, 2)
        assert.equal(x1.stdout, 'invalid --dir-hi: must be a number from 0 to 1\n')
        let x2 = run(cases[0][1], [], 'dream')
        assert.equal(x2.status, 2)
        assert(x2.stdout.startsWith('拒跑: tools/libCheck.mjs'), x2.stdout)
        //設定合格(只是帳本讀不到)者訊息不變
        let r3 = path.join(t.dir, 'noLedger2')
        fs.mkdirSync(r3, { recursive: true })
        fs.writeFileSync(path.join(r3, 'settings.json'), JSON.stringify(settingsOf()), 'utf8')
        let c = run(r3, [])
        assert.equal(c.status, 2)
        assert(c.stdout.startsWith('ERROR 無法載入評估帳本(settings.eval.ledgerDir;'), c.stdout)
    })

    it('agent(ARSI_AGENT_ROLE = node / dream)一律拒跑:印一行理由(主控專用、含事後資訊;不帶輸入值)、離開碼 2、不輸出庫況;未設角色者照常', () => {
        //對應規格(主控之裁定):「libCheck:節點與做夢之 agent 皆拒跑(其輸出含評估期內全庫之勝率,屬事後資訊);另加一種拒跑訊息」
        assert.equal(entryWrites('libCheck', []), true)
        assert.equal(entryWrites('libCheck', ['--json']), true)
        assert.equal(ENTRY_RULES.libCheck.hindsight, true)
        let logs = []
        let codes = []
        assert.equal(guardEntry('libCheck', ['--dir-hi', 'SECRET_INPUT_VALUE'], { env: { ARSI_AGENT_ROLE: 'node' }, log: (s) => logs.push(s), exit: (c) => codes.push(c) }), true)
        assert.deepEqual(codes, [2])
        assert.deepEqual(logs, ['拒跑: tools/libCheck.mjs 之輸出含評估期內全庫之統計(事後資訊), 只供主控使用, 不得由 agent 執行(ARSI_AGENT_ROLE=node; 評估用 g_eval.mjs, 共用工具區之自檢用 g_toolbox.mjs)'])
        //其他進入檔之理由照舊(只有標 hindsight 者用另一句)
        let l2 = []
        guardEntry('pickStore', [], { env: { ARSI_AGENT_ROLE: 'dream' }, log: (s) => l2.push(s), exit: () => {} })
        assert.deepEqual(l2, ['拒跑: tools/pickStore.mjs 會寫入專案之檔或起行程, 不得由 agent 執行(ARSI_AGENT_ROLE=dream; 評估用 g_eval.mjs, 共用工具區之自檢用 g_toolbox.mjs)'])
        for (let [role, args] of [['node', []], ['dream', ['--json']], ['node', ['--dir-hi', 'secret-token-xyz']]]) {
            let x = run(root, args, role)
            assert.equal(x.status, 2, `${role} ${args.join(' ')}`)
            assert.equal(x.stderr, '')
            assert.equal(x.stdout, `拒跑: tools/libCheck.mjs 之輸出含評估期內全庫之統計(事後資訊), 只供主控使用, 不得由 agent 執行(ARSI_AGENT_ROLE=${role}; 評估用 g_eval.mjs, 共用工具區之自檢用 g_toolbox.mjs)\n`)
        }
        let ok = run(root, ['--json'], null)
        assert.equal(ok.status, 0)
    })
})
