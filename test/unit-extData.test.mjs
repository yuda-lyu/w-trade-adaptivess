import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { loadLedger } from '../src/eval/ledger.mjs'
import { makeTmp, writeSynthLedger, makeTrainEvaluator as makeEvaluator } from './tools/synthLedger.mjs'
//makeEvaluator: 合成帳本即訓練期帳本 ⇒ makeTrainEvaluator 補上 L.ntStatic 再建評估器(見 test/tools/synthLedger.mjs)


//擴充診斷之資料存取(規則 R-EV-36): api.market(bar, nBack)、api.factor(ki, bar, nBack)、api.series(name, bar, nBack)
//  合約 §7: 棒序 < bar 之最近 nBack 根之 K 線 / 因子 / 外部序列之值(複本; 由舊至新; nBack 預設 180); 取值與 ctx.market / ctx.factor / ctx.series 於決策棒 bar 之呼叫逐位相同(同一份實作);
//    bar 須為 0 ~ K 棒數之整數(依 wsemi iseint 判定; 否則拋錯); ki 與 name 之錯誤、各錯誤訊息一律不帶輸入值(跨套件規格〈輸入參數之檢測機制〉§6 V20); 不改 S、階梯、selHash 與任何既有欄
//  內建物件被改時之行為(與既有之 api 函數一致)見 unit-evalIntegrity.test.mjs
const CFG = { warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [3, 7], nullDraws: 16, seed: 11 }
let bytesOf = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)
//sameArr, 逐位相同(位元組逐一比對: 區分 NaN 之位元與 -0)
let sameArr = (a, b) => a instanceof Float64Array && b instanceof Float64Array && a.length === b.length && Buffer.compare(bytesOf(a), bytesOf(b)) === 0
let MK = ['open', 'high', 'low', 'close', 'volume']
let sameMkt = (a, b) => Object.keys(a).join() === MK.join() && Object.keys(b).join() === MK.join() && MK.every((k) => sameArr(a[k], b[k]))
let pick = (ctx) => ({ ids: [1, 4, 7, 10, 13, 16, 19, 22].map((s) => (s + ctx.k) % ctx.n), tag: ctx.k % 2 ? 'a' : 'b' })
let accept = (sig, book) => book.open < 3
//runExt, 以一個擴充診斷跑一次完整評估; 診斷內之斷言失敗會被評估器記為 ext.<名>.error ⇒ 於此轉為測試失敗
let runExt = (ev, fn, pk = pick, opt = {}) => {
    let m = ev.evalPolicy(pk, { accept, ...opt, ext: [{ name: 'd', fn }] })
    assert.strictEqual(m.ext.d.error, undefined, `擴充診斷拋錯: ${m.ext.d.error}`)
    return m
}
//msgOf, 呼叫 fn 取得拋出之錯誤訊息(未拋錯者回 null)
let msgOf = (fn) => {
    try {
        fn()
    }
    catch (err) {
        return err instanceof Error ? err.message : `非 Error: ${String(err)}`
    }
    return null
}

describe('擴充診斷之資料存取(api.market / api.factor / api.series)', function () {
    let t
    let L
    let ev
    before(() => {
        t = makeTmp('extData')
        writeSynthLedger(path.join(t.dir, 's'), { n: 60, nBars: 2400, seed: 5, series: ['ser_a', 'ser_b'] })
        L = loadLedger(path.join(t.dir, 's'))
        ev = makeEvaluator(L, CFG)
    })
    after(() => {
        t.cleanup()
    })

    //NB, nBack 之各種寫法(含預設、非有限數、字串、null、小數、包裝物件): 兩邊於同一棒之取值皆須逐位相同(含「慣例」之怪異處, 如 market 對 '5' 取 5 根而 factor / series 取 0 根)
    let NB = [[], [undefined], [7], [1e9], [0], [-3], [NaN], [Infinity], [-Infinity], ['5'], [null], [1.5], [2.4], [new Number(4)]]

    it('於成品之每個決策棒:三者之取值與該次決策時 ctx.market / ctx.factor / ctx.series 所得逐位相同(含預設之 nBack、超過已有棒數、非有限數、字串、小數等各種寫法;全期與僅評估期間之重放)', () => {
        //合約 §7: 取值與 ctx 之同名介面於決策棒 bar 之呼叫逐位相同
        let check = (opt, label) => {
            let cap = new Map()
            let pk = (ctx) => {
                cap.set(`${ctx.phase}|${ctx.bar}`, NB.map((a) => [ctx.market(...a), ctx.factor(1, ...a), ctx.series('ser_b', ...a), ctx.factor(0, ...a), ctx.series('ser_a', ...a)]))
                return pick(ctx)
            }
            let m = runExt(ev, (api) => {
                let checked = 0
                for (let p of api.phases) {
                    for (let bar of p.bars) {
                        let c = cap.get(`${p.phase}|${bar}`)
                        assert(c, `相位 ${p.phase} 決策棒 ${bar} 應有挑選函數之紀錄`)
                        for (let i = 0; i < NB.length; i++) {
                            let a = NB[i]
                            let w = `${label} 相位 ${p.phase} 決策棒 ${bar} nBack ${String(a[0])}(第 ${i} 種)`
                            assert(sameMkt(api.market(bar, ...a), c[i][0]), `market ${w}`)
                            assert(sameArr(api.factor(1, bar, ...a), c[i][1]), `factor(1) ${w}`)
                            assert(sameArr(api.series('ser_b', bar, ...a), c[i][2]), `series(ser_b) ${w}`)
                            assert(sameArr(api.factor(0, bar, ...a), c[i][3]), `factor(0) ${w}`)
                            assert(sameArr(api.series('ser_a', bar, ...a), c[i][4]), `series(ser_a) ${w}`)
                        }
                        checked++
                    }
                }
                return { text: 'ok', checked }
            }, pk, opt)
            return m.ext.d.checked
        }
        assert(check({}, '全期') > 60, '已核對之決策數(全期)')
        //評估期間之切片(回測期重放): api.phases 只含落在 [fromBar, toBar) 之決策, 取值同樣與 ctx 相同
        let n2 = check({ fromBar: 900, toBar: 1700 }, '評估期間')
        assert(n2 > 8 && n2 < 60, `已核對之決策數(評估期間) ${n2}`)
    })

    it('只含棒序 < bar 者:末格 = bar 之前一棒、長度 = min(nBack, bar);bar = 0 為空、bar = K 棒數取到帳本之末棒', () => {
        //合約 §7: 棒序 < bar 之最近 nBack 根(由舊至新; 不含 bar)
        let nB = L.nBars
        runExt(ev, (api) => {
            for (let bar of [1, 2, 13, 361, 1000, nB - 1, nB]) {
                for (let nBack of [1, 3, 12, 500]) {
                    let m = Math.min(nBack, bar)
                    let mk = api.market(bar, nBack)
                    let f = api.factor(1, bar, nBack)
                    let s = api.series('ser_b', bar, nBack)
                    assert(MK.every((k) => mk[k].length === m) && f.length === m && s.length === m, `長度 bar ${bar} nBack ${nBack}`)
                    for (let i = 0; i < m; i++) {
                        let b = bar - m + i //所取之棒: 由 bar - m 至 bar - 1
                        assert(b < bar)
                        for (let j = 0; j < 5; j++) {
                            assert(Object.is(mk[MK[j]][i], L.px[b * 5 + j]), `market ${MK[j]} 棒 ${b}`)
                        }
                        assert(Object.is(f[i], L.fac[1 * nB + b]), `factor 棒 ${b}`)
                        assert(Object.is(s[i], L.ser[1 * nB + b]), `series 棒 ${b}`)
                    }
                }
            }
            assert(MK.every((k) => api.market(0, 5)[k].length === 0) && api.factor(0, 0, 5).length === 0 && api.series('ser_a', 0, 5).length === 0, 'bar = 0: 其前無棒')
            assert(Object.is(api.series('ser_a', nB, 1)[0], L.ser[nB - 1]) && Object.is(api.market(nB, 1).close[0], L.px[(nB - 1) * 5 + 3]), 'bar = K 棒數: 末格 = 帳本之末棒')
            return { text: 'ok' }
        })
    })

    it('序列之值 = 其棒序號時:各 bar、各 nBack 回傳之最大值 = bar - 1(全部 < bar)', () => {
        //另建一份帳本並把外部序列欄改寫為「值 = 序列序號 × 1e6 + 棒序號」⇒ 由值即可讀出所取之棒
        let dir = path.join(t.dir, 'enc')
        writeSynthLedger(dir, { n: 20, nBars: 600, seed: 5, series: ['ser_a', 'ser_b'] })
        let ser = new Float64Array(2 * 600)
        for (let si = 0; si < 2; si++) {
            for (let i = 0; i < 600; i++) {
                ser[si * 600 + i] = si * 1e6 + i
            }
        }
        fs.writeFileSync(path.join(dir, 'ser.f64'), Buffer.from(ser.buffer))
        let ev2 = makeEvaluator(loadLedger(dir), { ...CFG, warmupDays: 20 })
        let m = runExt(ev2, (api) => {
            let n = 0
            for (let p of api.phases) {
                for (let bar of p.bars) {
                    for (let [si, nm] of [[0, 'ser_a'], [1, 'ser_b']]) {
                        for (let nBack of [1, 2, 7, 180, 1e9]) {
                            let v = Array.from(api.series(nm, bar, nBack)).map((x) => x - si * 1e6)
                            assert.equal(v[v.length - 1], bar - 1, `末格應為決策棒之前一棒(${nm}, bar ${bar}, nBack ${nBack})`)
                            assert(v.every((x, i) => x === bar - v.length + i), '由舊至新、連續')
                            n++
                        }
                    }
                }
            }
            return { text: 'ok', n }
        })
        assert(m.ext.d.n > 50)
    })

    it('nBack 之慣例同 ctx(取整、負數與非有限數為 0、封頂於 bar、預設 180)', () => {
        runExt(ev, (api) => {
            let bar = 1000
            assert.equal(api.series('ser_a', bar).length, 180)
            assert.equal(api.factor(0, bar).length, 180)
            assert.equal(api.market(bar).close.length, 180)
            assert.equal(api.series('ser_a', 100).length, 100, '預設 180 封頂於 bar')
            assert.equal(api.series('ser_a', bar, 1.5).length, 2, 'Math.round(1.5) = 2')
            assert.equal(api.factor(0, bar, 2.4).length, 2)
            assert.equal(api.market(bar, 2.4).open.length, 2)
            for (let x of [-3, NaN, Infinity, -Infinity, '5', null]) {
                assert.equal(api.series('ser_a', bar, x).length, 0, `series nBack ${String(x)}`)
                assert.equal(api.factor(0, bar, x).length, 0, `factor nBack ${String(x)}`)
            }
            assert.equal(api.market(bar, -3).close.length, 0)
            //market 之 nBack 轉換沿用 ctx.market(Math.round): 與 factor / series 不同之處(合約 §7 明寫)—— 正無限為封頂值(全部)、數字字串依 Math.round 轉為數字、NaN / 負無限 / null 為 0
            assert.equal(api.market(bar, Infinity).close.length, bar, 'market: +Infinity ⇒ 封頂於 bar')
            assert.equal(api.market(bar, '5').close.length, 5, 'market: 數字字串 ⇒ 轉為數字')
            assert.equal(api.market(bar, new Number(4)).close.length, 4, 'market: 包裝物件 ⇒ 轉為數字')
            for (let x of [NaN, -Infinity, null]) {
                assert.equal(api.market(bar, x).close.length, 0, `market nBack ${String(x)}`)
            }
            assert.equal(api.series('ser_a', bar, Infinity).length, 0, 'series: +Infinity ⇒ 非有限數為 0')
            assert.equal(api.factor(0, bar, new Number(4)).length, 0, 'factor: 包裝物件非數字型 ⇒ 0')
            return { text: 'ok' }
        })
    })

    it('函數物件凍結且每個診斷各一份:一個診斷於 api.market / factor / series 上掛屬性、改 call ⇒ 不影響其他診斷(既有之六個 api 函數見下一案)', () => {
        //R-EV-35 ① / R-EV-36: 資料不共用 —— 新增之三個函數不新增診斷之間之旁路
        let seen = []
        let rec = (api) => {
            seen.push(api)
            return { c: Array.from(api.market(700, 3).close), s: Array.from(api.series('ser_a', 700, 3)), f: Array.from(api.factor(1, 700, 3)), call: String(api.market.call === Function.prototype.call) }
        }
        let m = ev.evalPolicy(pick, {
            accept,
            ext: [
                { name: 'before', fn: rec },
                { name: 'mut', fn: (api) => {
                    let errs = []
                    for (let k of ['market', 'factor', 'series']) {
                        for (let prop of ['call', 'apply', 'extra']) {
                            try {
                                api[k][prop] = function () {
                                    return null
                                }
                            }
                            catch (e) {
                                errs.push(e instanceof TypeError)
                            }
                        }
                    }
                    return { text: 'mut', frozen: [api.market, api.factor, api.series].every((f) => Object.isFrozen(f)), errs: errs.length, allType: errs.every((x) => x) }
                } },
                { name: 'after', fn: rec },
            ],
        })
        assert.deepEqual([m.ext.mut.frozen, m.ext.mut.errs, m.ext.mut.allType], [true, 9, true], '凍結: 掛屬性與改 call 皆被拒(TypeError)')
        let { ms: _a, ...before } = m.ext.before
        let { ms: _b, ...after } = m.ext.after
        assert.deepEqual(after, before)
        assert.equal(before.call, 'true', 'api.market.call 仍為 Function.prototype.call')
        //各診斷各一份函數物件
        assert(seen.length === 2 && seen[0].market !== seen[1].market && seen[0].factor !== seen[1].factor && seen[0].series !== seen[1].series)
    })

    it('既有之六個 api 函數(simulate / summarize / replaceNull / sideGroups / geoGroups / rand)之函數物件亦凍結且每個診斷各一份:一個診斷於其上掛屬性、改 call ⇒ 不影響其他診斷;函數之行為不變', () => {
        //R-EV-35 ①: 資料不共用 —— 診斷之間不得有旁路(前一診斷改後一診斷所呼叫之函數); 函數物件為每個診斷另包並凍結, 其下之實作仍共用(行為不變)
        const NAMES = ['simulate', 'summarize', 'replaceNull', 'sideGroups', 'geoGroups', 'rand']
        let seen = []
        let rec = (api) => {
            seen.push(api)
            let sim = api.simulate(api.phases.map((p) => p.sels))
            let sg = api.sideGroups()
            let rd = api.rand(3)
            return {
                text: 'rec',
                mark: NAMES.map((k) => String(api[k].mark)),
                call: NAMES.map((k) => String(api[k].call === Function.prototype.call)),
                simMean: sim.mean,
                simBy: sim.byPhase,
                sg: [sg.nGroups, Array.from(sg.grp).slice(0, 20)],
                gg: api.geoGroups(2, 2).nGroups,
                sm: api.summarize([1, 2, 3]).mean,
                rn: api.replaceNull({ grp: sg.grp, nGroups: sg.nGroups, draws: 4 }),
                r1: rd(),
                r2: rd(),
                z: [api.rand()(), api.rand(1)(), api.rand(1.5)(), api.rand('3')()],
                obs: api.obs.mean,
            }
        }
        let m = ev.evalPolicy(pick, {
            accept,
            ext: [
                { name: 'before', fn: rec },
                { name: 'mut', fn: (api) => {
                    let errs = []
                    let tried = 0
                    for (let k of NAMES) {
                        for (let prop of ['call', 'apply', 'mark']) {
                            tried++
                            try {
                                api[k][prop] = function () {
                                    return null
                                }
                            }
                            catch (e) {
                                errs.push(e instanceof TypeError)
                            }
                        }
                    }
                    return { text: 'mut', frozen: NAMES.every((k) => Object.isFrozen(api[k])), tried, errs: errs.length, allType: errs.every((x) => x) }
                } },
                { name: 'after', fn: rec },
            ],
        })
        for (let k of ['before', 'mut', 'after']) {
            assert.strictEqual(m.ext[k].error, undefined, `${k}: ${m.ext[k].error}`)
        }
        assert.deepEqual([m.ext.mut.frozen, m.ext.mut.tried, m.ext.mut.errs, m.ext.mut.allType], [true, 18, 18, true], '凍結: 掛屬性與改 call 皆被拒(TypeError)')
        let { ms: _a, ...before } = m.ext.before
        let { ms: _b, ...after } = m.ext.after
        assert.deepEqual(after, before, '前一診斷之改動不影響後一診斷所得之值')
        assert.deepEqual(before.call, NAMES.map(() => 'true'), '各函數之 call 仍為 Function.prototype.call')
        assert.deepEqual(before.mark, NAMES.map(() => 'undefined'))
        //函數之行為不變: 以成品自己之選集重放 = 成品之績效; 兩個分組各 2 組; 亂數產生器可重現且逐次不同
        assert(Math.abs(before.simMean - before.obs) < 1e-9, `simulate(成品自己之選集) = 成品之績效: ${before.simMean} vs ${before.obs}`)
        assert.deepEqual([before.sg[0], before.sm], [2, 2])
        assert(before.gg >= 1 && before.rn.draws === 4 && before.r1 !== before.r2)
        //rand(k): 種子 = 評估之種子 + 32452843 + k × 7919(k 非整數者視為 0; 與成品、既有虛無之亂數互不相干); 產生器為 mulberry32 ⇒ 對獨立算出之值
        //固定值: 以獨立之 mulberry32 參考實作(公開算法; 種子 = 11 + 32452843 + k × 7919)算出, 不與被測之 mulberry32 共用實作(其常數被改時期望值不會跟著改)
        assert.deepEqual([before.r1, before.r2], [0.667054069461301, 0.1860890865791589], 'rand(3) 之序列')
        assert.deepEqual(before.z, [0.6773378413636237, 0.5891620756592602, 0.6773378413636237, 0.6773378413636237], 'rand() = rand(0)、rand(1) 不同於 rand(0)、非整數(1.5、字串 3)視為 0')
        //各診斷各一份函數物件
        assert(seen.length === 2 && NAMES.every((k) => seen[0][k] !== seen[1][k]), '每個診斷之函數物件不同一')
        assert(NAMES.every((k) => typeof seen[0][k] === 'function' && Object.isFrozen(seen[0][k]) && Object.isFrozen(seen[1][k])))
    })

    it('bar 須為 0 ~ K 棒數之整數(依 wsemi iseint):負數、小數、超出、非數字、非有限數、包裝物件者三個介面皆拋錯(不帶輸入值、不取值);邊界值與數字字串(通過後轉為數字)照常', () => {
        //合約 §7: bar 不合者拋錯, 訊息指明介面、參數名與範圍, 不帶輸入值(跨套件規格〈輸入參數之檢測機制〉§6 V20)
        let nB = L.nBars
        let touched = 0
        let sneaky = { valueOf() {
            touched++
            return 3
        }, toString() {
            touched++
            return '3'
        } }
        runExt(ev, (api) => {
            let bads = [-1, 1.5, nB + 1, 1e9, NaN, Infinity, -Infinity, undefined, null, 'abc', '', ' ', '1.5', '-1', String(nB + 1), [5], {}, 5n, true, Symbol('x'), new Number(3), sneaky]
            for (let bad of bads) {
                let w = typeof bad === 'symbol' ? 'symbol' : typeof bad === 'bigint' ? `${bad}n` : Array.isArray(bad) ? '[5]' : bad === sneaky ? 'sneaky' : JSON.stringify(bad) === undefined ? String(bad) : JSON.stringify(bad)
                //(V19、V20: 英文固定詞彙、不帶輸入值; 排程第 510 項④: 原中文訊息)
                assert.equal(msgOf(() => api.market(bad, 5)), `api.market: invalid bar: must be an integer from 0 to ${nB}`, `market bar ${w}`)
                assert.equal(msgOf(() => api.factor(0, bad, 5)), `api.factor: invalid bar: must be an integer from 0 to ${nB}`, `factor bar ${w}`)
                assert.equal(msgOf(() => api.series('ser_a', bad, 5)), `api.series: invalid bar: must be an integer from 0 to ${nB}`, `series bar ${w}`)
            }
            assert.equal(touched, 0, '被檢測之值不得被呼叫任何方法(valueOf / toString)')
            //邊界值不拋錯
            api.market(0, 5)
            api.market(nB, 5)
            api.factor(0, nB, 5)
            api.series('ser_a', nB, 5)
            assert.equal(api.series('ser_a', -0, 5).length, 0, '-0 視為 0')
            //數字字串: iseint 判定通過者轉為數字後使用(取值同其數字)
            for (let ok of ['3', ' 3 ', '3.0', '+3']) {
                assert(sameMkt(api.market(ok, 5), api.market(3, 5)) && sameArr(api.factor(1, ok, 5), api.factor(1, 3, 5)) && sameArr(api.series('ser_b', ok, 5), api.series('ser_b', 3, 5)), `數字字串 ${JSON.stringify(ok)}`)
            }
            assert.equal(api.series('ser_a', String(nB), 2).length, 2)
            return { text: 'ok' }
        })
    })

    it('名稱或序號不合者拋錯(訊息以 api. 起首、列出允許之集合、不帶輸入值;依參數位置先檢查 ki / name 再檢查 bar);未建入外部序列之帳本:api.meta.seriesNames 為空、api.series 拋錯', () => {
        runExt(ev, (api) => {
            assert.deepEqual(Array.from(api.meta.seriesNames), ['ser_a', 'ser_b'])
            //(V19、V20: 英文固定詞彙; 列舉類寫出允許之集合、不寫給定之值; 排程第 510 項④: 原中文訊息)
            let wantS = 'api.series: invalid name: must be one of meta.seriesNames (ser_a, ser_b)'
            for (let bad of ['nope', 'SER_A', '', 0, undefined, null, {}, ['ser_a']]) {
                let m = msgOf(() => api.series(bad, 10, 5))
                assert.equal(m, wantS, `series name ${JSON.stringify(bad)}`)
            }
            let wantF = 'api.factor: invalid ki: must be an integer from 0 to 1 (an index of meta.keyNames)'
            for (let bad of [2, -1, 1.5, '0', NaN, Infinity, undefined, null, {}, 0n]) {
                let m = msgOf(() => api.factor(bad, 10, 5))
                assert.equal(m, wantF, `factor ki ${typeof bad === 'bigint' ? `${bad}n` : JSON.stringify(bad)}`)
            }
            //先檢查 ki / name, 再檢查 bar
            assert.equal(msgOf(() => api.series('nope', -1, 5)), wantS)
            assert.equal(msgOf(() => api.factor(2, -1, 5)), wantF)
            return { text: 'ok' }
        })
        let dir = path.join(t.dir, 'noser')
        writeSynthLedger(dir, { n: 60, nBars: 2400, seed: 5 })
        runExt(makeEvaluator(loadLedger(dir), CFG), (api) => {
            assert.deepEqual(Array.from(api.meta.seriesNames), [])
            assert.equal(msgOf(() => api.series('ser_a', 10, 5)), 'api.series: invalid name: must be one of meta.seriesNames (none (the ledger has no external series))')
            //K 線與因子不受影響
            assert.equal(api.market(10, 5).close.length, 5)
            assert.equal(api.factor(0, 10, 5).length, 5)
            return { text: 'ok' }
        })
        //帳本無因子(meta.keyNames 為空): 任何 ki 皆不合, 訊息不寫「0 ~ -1」
        let dir2 = path.join(t.dir, 'nofac')
        writeSynthLedger(dir2, { n: 60, nBars: 2400, seed: 5 })
        let mp = path.join(dir2, 'meta.json')
        fs.writeFileSync(mp, JSON.stringify({ ...JSON.parse(fs.readFileSync(mp, 'utf8')), keyNames: [] }), 'utf8')
        runExt(makeEvaluator(loadLedger(dir2), CFG), (api) => {
            assert.equal(msgOf(() => api.factor(0, 10, 5)), 'api.factor: invalid ki: must be an index of meta.keyNames (the ledger has no factors)')
            assert.equal(api.market(10, 5).close.length, 5)
            return { text: 'ok' }
        })
    })

    it('帳本缺欄之錯誤(請重建帳本):api. 與 ctx. 之訊息僅前綴不同(同一份實作)', () => {
        //K 線欄、因子序列欄缺; 外部序列欄之位元組數與名稱不符
        let cases = [
            ['px', 'px.f64', null, '帳本無 K 線欄(請重建帳本)', 'market', (x) => x.market(10, 5), (x) => x.market(5)],
            ['fac', 'fac.f64', null, '帳本無因子序列欄(請重建帳本)', 'factor', (x) => x.factor(0, 10, 5), (x) => x.factor(0, 5)],
            ['facLen', 'fac.f64', (fp) => fs.writeFileSync(fp, fs.readFileSync(fp).subarray(0, 8 * (2 * 2400 - 1))), '帳本無因子序列欄(請重建帳本)', 'factor', (x) => x.factor(0, 10, 5), (x) => x.factor(0, 5)],
            ['ser', 'ser.f64', (fp) => fs.writeFileSync(fp, fs.readFileSync(fp).subarray(0, 8 * (2 * 2400 - 1))), '帳本之外部序列欄與名稱不符(請重建帳本)', 'series', (x) => x.series('ser_a', 10, 5), (x) => x.series('ser_a', 5)],
        ]
        for (let [nm, file, edit, tail, kind, callApi, callCtx] of cases) {
            let dir = path.join(t.dir, `miss_${nm}`)
            writeSynthLedger(dir, { n: 40, nBars: 2400, seed: 7, series: ['ser_a', 'ser_b'] })
            let fp = path.join(dir, file)
            if (edit) {
                edit(fp)
            }
            else {
                fs.rmSync(fp)
            }
            let ev2 = makeEvaluator(loadLedger(dir), CFG)
            let ctxMsg = null
            ev2.runPick((ctx) => {
                if (ctx.k === 3 && ctxMsg === null) {
                    ctxMsg = msgOf(() => callCtx(ctx))
                }
                return []
            }, 0)
            assert.equal(ctxMsg, `ctx.${kind}: ${tail}`, `ctx ${nm}`)
            let apiMsg = null
            ev2.evalPolicy(pick, { ext: [{ name: 'd', fn: (api) => {
                apiMsg = msgOf(() => callApi(api))
                return { text: 'ok' }
            } }] })
            assert.equal(apiMsg, `api.${kind}: ${tail}`, `api ${nm}`)
        }
    })

    it('ctx 之同名介面之錯誤訊息字面不變(改為呼叫共用實作之回歸;含其帶輸入值之既有寫法)', () => {
        let got = []
        ev.runPick((ctx) => {
            if (ctx.k === 2 && got.length === 0) {
                got = [msgOf(() => ctx.factor(2, 5)), msgOf(() => ctx.factor(0.5, 5)), msgOf(() => ctx.series('nope', 5)), msgOf(() => ctx.series(0, 5)), msgOf(() => ctx.series(undefined, 5))]
            }
            return []
        }, 0)
        assert.deepEqual(got, [
            'ctx.factor: 因子序號不合法 2',
            'ctx.factor: 因子序號不合法 0.5',
            'ctx.series: 無此序列 "nope"(可用: ser_a、ser_b)',
            'ctx.series: 無此序列 0(可用: ser_a、ser_b)',
            'ctx.series: 無此序列 undefined(可用: ser_a、ser_b)',
        ])
    })

    it('回傳為複本:改它不影響帳本與其後之呼叫;每次呼叫另給新物件(不共用緩衝);不與帳本共用記憶體', () => {
        let px0 = Float64Array.from(L.px)
        let fac0 = Float64Array.from(L.fac)
        let ser0 = Float64Array.from(L.ser)
        runExt(ev, (api) => {
            let bar = 500
            let s = api.series('ser_a', bar, 5)
            let f = api.factor(0, bar, 5)
            let mk = api.market(bar, 5)
            //不與帳本共用緩衝; 每次呼叫另給新物件
            assert(s.buffer !== L.ser.buffer && f.buffer !== L.fac.buffer && mk.close.buffer !== L.px.buffer, '不與帳本共用緩衝')
            assert(s !== api.series('ser_a', bar, 5) && f !== api.factor(0, bar, 5) && mk !== api.market(bar, 5) && mk.close !== api.market(bar, 5).close)
            assert(s.buffer !== api.series('ser_a', bar, 5).buffer && f.buffer !== api.factor(0, bar, 5).buffer)
            let keep = { s: Array.from(s), f: Array.from(f), c: Array.from(mk.close) }
            s.fill(12345)
            f.fill(12345)
            for (let k of MK) {
                mk[k].fill(12345)
            }
            assert(sameArr(api.series('ser_a', bar, 5), Float64Array.from(keep.s)) && sameArr(api.factor(0, bar, 5), Float64Array.from(keep.f)) && sameArr(api.market(bar, 5).close, Float64Array.from(keep.c)))
            return { text: 'ok' }
        })
        assert(sameArr(L.px, px0) && sameArr(L.fac, fac0) && sameArr(L.ser, ser0), '帳本之陣列不得被改動')
    })

    it('一個診斷改寫其取得之值,不影響同一次評估內其他診斷所得(各診斷各自取得複本)', () => {
        //R-EV-35 ①: 擴充診斷之 api 每個診斷一份; 取值為複本 ⇒ 前一個診斷改寫其值不改後一個診斷所得
        let rec = (api) => ({ s: Array.from(api.series('ser_a', 700, 4)), f: Array.from(api.factor(1, 700, 4)), c: Array.from(api.market(700, 4).close) })
        let m = ev.evalPolicy(pick, {
            accept,
            ext: [
                { name: 'before', fn: rec },
                { name: 'mut', fn: (api) => {
                    api.series('ser_a', 700, 4).fill(-1)
                    api.factor(1, 700, 4).fill(-1)
                    api.market(700, 4).close.fill(-1)
                    return { text: 'mut' }
                } },
                { name: 'after', fn: rec },
            ],
        })
        let { ms: _a, ...before } = m.ext.before
        let { ms: _b, ...after } = m.ext.after
        assert.deepEqual(after, before)
        assert.equal(before.s.length, 4)
    })

    it('用到資料存取之擴充診斷不改任何既有數字與 selHash;api 仍為凍結之物件且不外露帳本', () => {
        //R-EV-21 / R-EV-36: 擴充診斷拿不到帳本、也改不了 S、階梯、selHash
        let base = ev.evalPolicy(pick, { accept })
        let seen = null
        let m = runExt(ev, (api) => {
            seen = api
            let x = 0
            for (let p of api.phases) {
                for (let bar of p.bars) {
                    x += api.market(bar, 30).close.length + api.factor(0, bar, 30).length + api.series('ser_a', bar, 30).length
                }
            }
            return { text: 'ok', x }
        })
        assert(m.ext.d.x > 0)
        assert.equal(m.selHash, base.selHash)
        assert.deepEqual(m.op.eqYr, base.op.eqYr)
        assert.deepEqual(m.null, base.null)
        assert(Object.isFrozen(seen) && typeof seen.market === 'function' && typeof seen.factor === 'function' && typeof seen.series === 'function')
        assert(!('L' in seen) && !('px' in seen) && !('ser' in seen) && !('fac' in seen))
    })

    it('用法:依各決策之決策棒以前之序列狀態把成品之選集分成兩組,各自以 simulate 重放(另一組之決策留空)', () => {
        //合約 §7 之用途: 損益依「決策當時之狀態」之歸因; 為某次決策分組只用該決策自己之決策棒
        let m = runExt(ev, (api) => {
            let isHigh = (bar) => {
                let v = Array.from(api.series('ser_b', bar, 30)).filter((x) => !Number.isNaN(x))
                let sorted = v.slice().sort((a, b) => a - b)
                return v.length > 0 && v[v.length - 1] > sorted[Math.floor(sorted.length / 2)]
            }
            let nHi = 0
            let nAll = 0
            let part = (want) => api.phases.map((p) => p.sels.map((s, k) => {
                let hi = isHigh(p.bars[k])
                return hi === want ? s : new Int32Array(0)
            }))
            for (let p of api.phases) {
                for (let bar of p.bars) {
                    nAll++
                    nHi += isHigh(bar) ? 1 : 0
                }
            }
            let hi = api.simulate(part(true))
            let lo = api.simulate(part(false))
            let all = api.simulate(api.phases.map((p) => p.sels))
            return { text: `高 ${nHi} / ${nAll}`, nHi, nAll, hi: hi.mean, lo: lo.mean, all: all.mean, ordHi: hi.bySide.long.orders + hi.bySide.short.orders, ordLo: lo.bySide.long.orders + lo.bySide.short.orders, ordAll: all.bySide.long.orders + all.bySide.short.orders }
        })
        let d = m.ext.d
        assert(d.nHi > 0 && d.nHi < d.nAll, `兩組皆應有決策: ${d.text}`)
        assert(Number.isFinite(d.hi) && Number.isFinite(d.lo) && Math.abs(d.all - m.op.eqYr.mean) < 1e-3)
        assert(d.ordHi > 0 && d.ordLo > 0 && d.ordAll > 0, '兩組與全部之重放皆有下單')
    })
})
