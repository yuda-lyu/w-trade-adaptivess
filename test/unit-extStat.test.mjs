import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { loadLedger, memberLedger } from '../src/eval/ledger.mjs'
import { loadExt } from '../src/eval/pickLoader.mjs'
import { makeTmp, writeSynthLedger, FD_ROOT, makeTrainEvaluator as makeEvaluator } from './tools/synthLedger.mjs'
//makeEvaluator: 合成帳本即訓練期帳本 ⇒ makeTrainEvaluator 補上 L.ntStatic 再建評估器(見 test/tools/synthLedger.mjs)


//擴充診斷之各策略自身之歷史統計(規則 R-EV-59): api.stat(bar, days)
//  合約 §7: 「挑選函數於決策棒 bar 呼叫 ctx.stat(days) 所見者」之複本 { closed, wins, pnl, entries, open, lastEntryAgo }(各長度 n; 定義同 §3 之 ctx.stat);
//    取值與 ctx.stat 於同一棒、同一 days 逐位相同(同一份實作); days 省略或 0 = 全部歷史, 其餘寫法之處理同 ctx.stat;
//    bar 之規定與錯誤之寫法同 market(0 ~ K 棒數之整數; 不合者拋 api.stat: invalid bar: must be …, 不帶輸入值);
//    每次呼叫另給一組新陣列(回傳之物件凍結; 可留用、可改寫, 不影響評估器、其後之呼叫與其他診斷); 不重放, 不受重入之限; 兩段用法示例可直接存為 metrics/ 之檔
//  R-EV-35 ①: 函數物件每個診斷各一份並凍結; R-EV-21: 不改 S、階梯、selHash 與任何既有欄
//  內建物件被改時之行為(與既有之 api 函數一致)見 unit-evalIntegrity.test.mjs
const CFG = { warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [3, 7], nullDraws: 16, seed: 11 }
const KEYS = ['closed', 'wins', 'pnl', 'entries', 'open', 'lastEntryAgo']
const TYPES = ['Int32Array', 'Int32Array', 'Float64Array', 'Int32Array', 'Int32Array', 'Int32Array']
let kindOf = (a) => Object.prototype.toString.call(a).slice(8, -1)
let bytesOf = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)
//sameStat, 六欄之鍵序、型別、長度與位元組逐一相同(位元組比對: 區分 -0 與 NaN 之位元)
let sameStat = (a, b) => Object.keys(a).join() === KEYS.join() && Object.keys(b).join() === KEYS.join() && KEYS.every((k, i) => kindOf(a[k]) === TYPES[i] && kindOf(b[k]) === TYPES[i] && a[k].length === b[k].length && Buffer.compare(bytesOf(a[k]), bytesOf(b[k])) === 0)
//copyStat, ctx.stat 之陣列為每次決策重寫之暫存(合約 §3) ⇒ 於挑選函數內當場複製
let copyStat = (S) => Object.fromEntries(KEYS.map((k) => [k, S[k].slice()]))
let ids = (ctx) => [1, 4, 7, 10, 13, 16, 19, 22].map((s) => (s + ctx.k) % ctx.n)
let accept = (sig, book) => book.open < 3
//runExt, 以一個擴充診斷跑一次完整評估; 診斷內之斷言失敗會被評估器記為 ext.<名>.error ⇒ 於此轉為測試失敗
let runExt = (ev, fn, pk = ids, opt = {}) => {
    let m = ev.evalPolicy(pk, { accept, ...opt, ext: [{ name: 'd', fn }] })
    assert.equal(m.ext.d.error, undefined, `擴充診斷拋錯: ${m.ext.d.error}`)
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
//DAYS, days 之各種寫法(含預設、0、小數、超大、負數、非有限數、字串、null、布林、BigInt、包裝物件、物件): 兩邊於同一棒之取值皆須逐位相同(含「慣例」之處, 如 '5' 與包裝物件皆為全部歷史)
let DAYS = [[], [undefined], [0], [30], [1], [3], [2.4], [2.5], [1e9], [-3], [NaN], [Infinity], [-Infinity], ['5'], [null], [true], [5n], [Object(4)], [{}]] //Object(4) = 包裝物件(同 new Number(4))
//brute, 由帳本之原始逐單欄(off / ent / ext / pnl)逐單計算棒 b 以前之六欄(不借用評估器之已結單欄與游標; 同 unit-evalCore 之 ctx.stat 之核對寫法)
let brute = (L, b, days) => {
    let from = days > 0 ? b - days * L.barsPerDay : -Infinity
    let out = { closed: [], wins: [], pnl: [], entries: [], open: [], lastEntryAgo: [] }
    for (let s = 0; s < L.n; s++) {
        let closed = 0
        let wins = 0
        let pnl = 0
        let entries = 0
        let open = 0
        let last = -1
        for (let j = L.off[s]; j < L.off[s + 1]; j++) {
            let e = L.ent[j]
            let x = L.ext[j]
            if (e < b) {
                if (e >= from) {
                    entries++
                }
                last = e
                if (!(x >= 0 && x < b)) {
                    open++
                }
            }
            if (x >= 0 && x < b && x >= from) {
                closed++
                pnl += L.pnl[j]
                if (L.pnl[j] > 0) {
                    wins++
                }
            }
        }
        out.closed.push(closed)
        out.wins.push(wins)
        out.pnl.push(pnl)
        out.entries.push(entries)
        out.open.push(open)
        out.lastEntryAgo.push(last >= 0 ? b - 1 - last : 1000000000)
    }
    return out
}
//contractExamples, 合約 §7 中含 api.stat( 之 js 程式區塊(去除列表之縮排)
let contractExamples = () => {
    let text = fs.readFileSync(path.join(FD_ROOT, 'contract', 'pick-contract.md'), 'utf8').replace(/\r\n/g, '\n')
    let out = []
    for (let m of text.matchAll(/^( *)```js\n([\s\S]*?)^\1```$/gm)) {
        let ind = m[1].length
        let code = m[2].split('\n').map((l) => l.slice(Math.min(ind, l.length - l.trimStart().length))).join('\n')
        if (code.includes('api.stat(')) {
            out.push(code)
        }
    }
    return { text, out }
}

describe('擴充診斷之各策略自身之歷史統計(api.stat;R-EV-59)', function () {
    this.timeout(180000)
    let t
    let L
    let ev
    before(() => {
        t = makeTmp('extStat')
        writeSynthLedger(path.join(t.dir, 's'), { n: 60, nBars: 2400, seed: 5 })
        L = loadLedger(path.join(t.dir, 's'))
        ev = makeEvaluator(L, CFG)
    })
    after(() => {
        t.cleanup()
    })

    //check, 於成品之每個決策棒: api.stat 與該次決策時 ctx.stat 所得逐位相同 —— 經挑選函數之 tag(既有之回傳管道)與挑選函數內之記錄(days 之各種寫法)兩條路核對
    let check = (evX, LX, opt, label) => {
        let cap = new Map()
        let pk = (ctx) => {
            cap.set(`${ctx.phase}|${ctx.bar}`, DAYS.map((a) => copyStat(ctx.stat(...a))))
            return { ids: ids(ctx), tag: { s0: copyStat(ctx.stat(0)), s30: copyStat(ctx.stat(30)) } }
        }
        let m = runExt(evX, (api) => {
            let checked = 0
            let viaTag = 0
            let entAt = 0 //(鑑別前提)有策略恰於決策棒進場之格數: 游標多含決策棒一根者會取到它
            let extAt = 0 //(鑑別前提)有策略之單恰於決策棒出場之格數
            let daysDiff = 0 //(鑑別前提)stat(bar, 30) 與 stat(bar) 不同之決策數: 忽略 days 者會取到全部歷史
            let spread = 0 //(鑑別前提)各策略之進場數不全相同之決策數: 各欄逐策略相異, 序號錯位可被察覺
            for (let p of api.phases) {
                for (let k = 0; k < p.bars.length; k++) {
                    let bar = p.bars[k]
                    let c = cap.get(`${p.phase}|${bar}`)
                    assert(c, `${label}: 相位 ${p.phase} 決策棒 ${bar} 應有挑選函數之紀錄`)
                    for (let i = 0; i < DAYS.length; i++) {
                        //合約 §7: 取值與挑選函數於決策棒 bar 呼叫 ctx.stat(days) 逐位相同(days 之處理同 ctx.stat)
                        assert(sameStat(api.stat(bar, ...DAYS[i]), c[i]), `${label}: 相位 ${p.phase} 決策棒 ${bar} days 之第 ${i} 種寫法`)
                    }
                    //經 tag(挑選函數之既有回傳管道)
                    assert(sameStat(api.stat(bar), p.tags[k].s0) && sameStat(api.stat(bar, 30), p.tags[k].s30), `${label}: 相位 ${p.phase} 決策棒 ${bar} 經 tag 之值`)
                    viaTag++
                    let a0 = api.stat(bar)
                    let a30 = api.stat(bar, 30)
                    if (!sameStat(a0, a30)) {
                        daysDiff++
                    }
                    if (new Set(a0.entries).size > 1) {
                        spread++
                    }
                    for (let s = 0; s < LX.n; s++) {
                        for (let j = LX.off[s]; j < LX.off[s + 1]; j++) {
                            entAt += LX.ent[j] === bar ? 1 : 0
                            extAt += LX.ext[j] === bar ? 1 : 0
                        }
                    }
                    checked++
                }
            }
            return { text: 'ok', checked, viaTag, entAt, extAt, daysDiff, spread }
        }, pk, opt)
        let d = m.ext.d
        assert.equal(d.viaTag, d.checked)
        assert(d.entAt > 0 && d.extAt > 0 && d.daysDiff > 0 && d.spread > 0, `${label}: 鑑別前提(恰於決策棒進場 ${d.entAt}、出場 ${d.extAt}、days 有別 ${d.daysDiff}、逐策略相異 ${d.spread})`)
        return d.checked
    }

    it('於成品之每個決策棒:api.stat 與該次決策時 ctx.stat 所得逐位相同(經 tag 與挑選函數內之記錄;days 之各種寫法;全期、僅評估期間之重放、逐棒進場之帳本、半庫帳本)', () => {
        assert(check(ev, L, {}, '全期') > 60, '已核對之決策數(全期)')
        //評估期間之切片(回測期重放): api.phases 只含落在 [fromBar, toBar) 之決策, 取值同樣與 ctx 相同
        let n2 = check(ev, L, { fromBar: 900, toBar: 1700 }, '評估期間')
        assert(n2 > 8 && n2 < 60, `已核對之決策數(評估期間) ${n2}`)
        //逐棒進場之帳本(dense: 各策略每 1 ~ 3 棒進場 ⇒ 持倉中之單數大、各決策棒皆有進場)
        writeSynthLedger(path.join(t.dir, 'dense'), { n: 37, nBars: 1800, seed: 9, dense: true })
        let LD = loadLedger(path.join(t.dir, 'dense'))
        assert(check(makeEvaluator(LD, CFG), LD, {}, '逐棒進場') > 40)
        //半庫帳本(R-EV-40; 序號重新編號、逐單欄為新建之複本): 評估器以半庫帳本建者, 兩邊皆為半庫內之序號
        let LH = memberLedger(L, 12345, 1)
        assert(LH.n > 10 && LH.n < L.n)
        assert(check(makeEvaluator(LH, CFG), LH, {}, '半庫') > 60)
    })

    it('任意棒(含非決策棒、0、K 棒數)之取值 = 由帳本之原始逐單欄逐單計算者:只含棒序 < bar 之進場與出場(entries / open / lastEntryAgo 依進場棒,closed / wins / pnl 依出場棒)', () => {
        //合約 §3 之 ctx.stat 之定義(api.stat 同): 決策日以前最近 days 日; days 0 = 全部歷史; open 與 days 無關; lastEntryAgo 從未進場為 1e9
        let nB = L.nBars
        let bars = [0, 1, 2, 3, 5, 7, 13, 41, 359, 360, 361, 997, 1000, 1001, 1500, 2011, nB - 1, nB]
        let n = 0
        runExt(ev, (api) => {
            for (let bar of bars) {
                for (let days of [0, 1, 3, 30, 90, 1000]) {
                    let got = api.stat(bar, days)
                    let want = brute(L, bar, days)
                    for (let k of ['closed', 'wins', 'entries', 'open', 'lastEntryAgo']) {
                        assert.deepEqual(Array.from(got[k]), want[k], `${k} bar ${bar} days ${days}`)
                    }
                    //pnl: 已結單之損益和(評估器以依出場棒之前綴和相減; 浮點之加總次序不同 ⇒ 容差)
                    assert(want.pnl.every((v, s) => Math.abs(got.pnl[s] - v) < 1e-6), `pnl bar ${bar} days ${days}`)
                    n++
                }
            }
            return { text: 'ok' }
        })
        assert.equal(n, bars.length * 6)
        //鑑別前提: 所列之棒中有策略恰於該棒進場或出場者(含該棒即錯)
        let hit = bars.filter((b) => Array.from(L.ent).includes(b) || Array.from(L.ext).includes(b)).length
        assert(hit >= 5, `恰於所列之棒進出場之棒數 ${hit}`)
    })

    it('無前視:同一策略庫以較早之終點截斷之帳本(前綴),於不晚於其終點之各棒之取值與全期帳本逐位相同', () => {
        //帳本之前綴(writeSynthLedger 之 cut: 進場棒 ≥ 終點之單不收、出場棒 ≥ 終點者記為未結)= 棒 b 以後之資訊全部不同; 只用棒序 < bar 者 ⇒ 結果不變
        let cut = 1500
        writeSynthLedger(path.join(t.dir, 'cut'), { n: 60, nBars: 2400, seed: 5, cut })
        let LC = loadLedger(path.join(t.dir, 'cut'))
        assert.equal(LC.nBars, cut)
        let evC = makeEvaluator(LC, CFG)
        let bars = [0, 1, 361, 700, 1001, 1333, cut - 1, cut]
        let collect = (evX) => {
            let rows = []
            runExt(evX, (api) => {
                for (let bar of bars) {
                    for (let days of [0, 2, 30]) {
                        rows.push(api.stat(bar, days))
                    }
                }
                return { text: 'ok' }
            })
            return rows
        }
        let full = collect(ev)
        let part = collect(evC)
        assert.equal(full.length, bars.length * 3)
        full.forEach((r, i) => assert(sameStat(r, part[i]), `第 ${i} 格`))
        //鑑別前提: 全期帳本於終點以後確有進場與出場(兩帳本之內容不同)
        assert(Array.from(L.ent).some((e) => e >= cut) && L.ent.length > LC.ent.length)
    })

    it('bar 須為 0 ~ K 棒數之整數(依 wsemi iseint):負數、小數、超出、非數字、非有限數、包裝物件者拋錯(訊息不帶輸入值、不呼叫其方法);邊界值與數字字串(轉為數字)照常', () => {
        //合約 §7: bar 之規定與錯誤之寫法同 market(跨套件規格〈輸入參數之檢測機制〉§6 V19、V20)
        let nB = L.nBars
        let touched = 0
        let sneaky = {
            valueOf() {
                touched++
                return 3
            },
            toString() {
                touched++
                return '3'
            },
        }
        runExt(ev, (api) => {
            let bads = [-1, 1.5, nB + 1, 1e9, NaN, Infinity, -Infinity, undefined, null, 'abc', '', ' ', '1.5', '-1', String(nB + 1), [5], {}, 5n, true, Symbol('x'), Object(3), sneaky] //Object(3) = 包裝物件
            for (let i = 0; i < bads.length; i++) {
                assert.equal(msgOf(() => api.stat(bads[i])), `api.stat: invalid bar: must be an integer from 0 to ${nB}`, `bar 之第 ${i} 種`)
                assert.equal(msgOf(() => api.stat(bads[i], 30)), `api.stat: invalid bar: must be an integer from 0 to ${nB}`, `bar 之第 ${i} 種(帶 days)`)
            }
            assert.equal(touched, 0, '被檢測之值不得被呼叫任何方法(valueOf / toString)')
            //邊界值: bar = 0 其前無棒(全為 0、lastEntryAgo 為 1e9); bar = K 棒數取到帳本之末棒
            let z = api.stat(0)
            assert(KEYS.every((k) => z[k].length === api.n) && Array.from(z.entries).every((v) => v === 0) && Array.from(z.closed).every((v) => v === 0) && Array.from(z.lastEntryAgo).every((v) => v === 1000000000))
            assert(sameStat(api.stat(-0), z), '-0 視為 0')
            let e = api.stat(nB)
            assert.equal(Array.from(e.entries).reduce((a, v) => a + v, 0), L.ent.length, 'bar = K 棒數: 全部之進場')
            //數字字串: iseint 判定通過者轉為數字後使用(取值同其數字)
            for (let ok of ['700', ' 700 ', '700.0', '+700']) {
                assert(sameStat(api.stat(ok, 30), api.stat(700, 30)), `數字字串 ${JSON.stringify(ok)}`)
            }
            return { text: 'ok' }
        })
    })

    it('回傳為每次呼叫另建之凍結物件:六欄之鍵序與型別同 ctx.stat;改寫其陣列不影響其後之呼叫、其他診斷與帳本;不與其他呼叫共用記憶體', () => {
        //合約 §7: 每次呼叫另給一組新陣列(回傳之物件凍結); 可留用、可改寫, 不影響評估器、其後之呼叫與其他診斷
        let keep = { xPnlCum: Float64Array.from(L.xPnlCum), xWinCum: Int32Array.from(L.xWinCum), ent: Int32Array.from(L.ent), ext: Int32Array.from(L.ext) }
        let rec = (api) => {
            let a = api.stat(700, 30)
            return { c: KEYS.map((k) => Array.from(a[k])) }
        }
        let m = ev.evalPolicy(ids, {
            accept,
            ext: [
                { name: 'before', fn: rec },
                {
                    name: 'mut',
                    fn: (api) => {
                        let a = api.stat(700, 30)
                        let b = api.stat(700, 30)
                        let errs = 0
                        try {
                            a.closed = new Int32Array(api.n)
                        }
                        catch (err) {
                            errs += err instanceof TypeError ? 1 : 0
                        }
                        let shape = Object.isFrozen(a) && Object.keys(a).join() === KEYS.join() && KEYS.every((k, i) => kindOf(a[k]) === TYPES[i] && a[k].length === api.n)
                        let fresh = a !== b && KEYS.every((k) => a[k] !== b[k] && a[k].buffer !== b[k].buffer)
                        let same = KEYS.every((k) => Buffer.compare(bytesOf(a[k]), bytesOf(b[k])) === 0)
                        for (let k of KEYS) {
                            a[k].fill(-7)
                        }
                        let after = api.stat(700, 30)
                        return { text: 'mut', errs, shape, fresh, same, untouched: KEYS.every((k) => Buffer.compare(bytesOf(after[k]), bytesOf(b[k])) === 0), filled: Array.from(a.entries).every((v) => v === -7) }
                    },
                },
                { name: 'after', fn: rec },
            ],
        })
        for (let k of ['before', 'mut', 'after']) {
            assert.equal(m.ext[k].error, undefined, `${k}: ${m.ext[k].error}`)
        }
        let x = m.ext.mut
        assert.deepEqual([x.errs, x.shape, x.fresh, x.same, x.untouched, x.filled], [1, true, true, true, true, true])
        let { ms: _a, ...before } = m.ext.before
        let { ms: _b, ...after } = m.ext.after
        assert.deepEqual(after, before, '前一診斷改寫其所得之陣列不影響後一診斷')
        assert(before.c[3].some((v) => v > 0), '鑑別前提: 所取之棒有進場')
        //帳本之陣列不得被改動
        assert(Buffer.compare(bytesOf(L.xPnlCum), bytesOf(keep.xPnlCum)) === 0 && Buffer.compare(bytesOf(L.xWinCum), bytesOf(keep.xWinCum)) === 0 && Buffer.compare(bytesOf(L.ent), bytesOf(keep.ent)) === 0 && Buffer.compare(bytesOf(L.ext), bytesOf(keep.ext)) === 0)
    })

    it('函數物件凍結且每個診斷各一份:一個診斷於 api.stat 上掛屬性、改 call ⇒ 被拒且不影響其他診斷;api 之函數由十增為十一(stat 附於末尾)', () => {
        //R-EV-35 ①: 資料不共用 —— 新增之函數不新增診斷之間之旁路
        let seen = []
        let rec = (api) => {
            seen.push(api)
            return { text: 'rec', e: Array.from(api.stat(900, 30).entries), call: String(api.stat.call === Function.prototype.call), mark: String(api.stat.mark) }
        }
        let m = ev.evalPolicy(ids, {
            accept,
            ext: [
                { name: 'before', fn: rec },
                {
                    name: 'mut',
                    fn: (api) => {
                        let errs = 0
                        for (let prop of ['call', 'apply', 'mark']) {
                            try {
                                api.stat[prop] = () => null
                            }
                            catch (e) {
                                errs += e instanceof TypeError ? 1 : 0
                            }
                        }
                        return { text: 'mut', frozen: Object.isFrozen(api.stat), errs, keys: Object.keys(api).filter((x) => typeof api[x] === 'function') }
                    },
                },
                { name: 'after', fn: rec },
            ],
        })
        for (let k of ['before', 'mut', 'after']) {
            assert.equal(m.ext[k].error, undefined, `${k}: ${m.ext[k].error}`)
        }
        assert.deepEqual([m.ext.mut.frozen, m.ext.mut.errs], [true, 3], '凍結: 掛屬性與改 call 皆被拒(TypeError)')
        assert.deepEqual(m.ext.mut.keys, ['simulate', 'summarize', 'replaceNull', 'sideGroups', 'geoGroups', 'market', 'factor', 'series', 'rand', 'fillRandom', 'stat'])
        let { ms: _a, ...before } = m.ext.before
        let { ms: _b, ...after } = m.ext.after
        assert.deepEqual(after, before, '前一診斷之改動不影響後一診斷')
        assert.deepEqual([before.call, before.mark], ['true', 'undefined'])
        assert(seen.length === 2 && seen[0].stat !== seen[1].stat && Object.isFrozen(seen[0].stat) && Object.isFrozen(seen[1].stat), '各診斷各一份函數物件')
    })

    it('不重放:於 simulate 之 opts.accept 之內呼叫 ⇒ 照常回傳(與外面之呼叫逐位相同),外層之重放結果與未呼叫者逐位相同', () => {
        //合約 §7: api.stat 不重放, 不受「opts.accept 之內不得再呼叫 simulate / replaceNull」之限
        runExt(ev, (api) => {
            let sels = api.phases.map((p) => p.sels)
            let outside = api.stat(800, 30)
            let base = api.simulate(sels, null, { accept: (sig, book) => book.open < 3 })
            let inside = null
            let n = 0
            let nested = api.simulate(sels, null, {
                accept: (sig, book) => {
                    if (n++ === 3) {
                        inside = api.stat(800, 30)
                    }
                    return book.open < 3
                },
            })
            assert(inside !== null && sameStat(inside, outside), '重放之內呼叫: 與外面之呼叫逐位相同')
            assert.equal(JSON.stringify(nested), JSON.stringify(base), '外層之重放結果不變')
            return { text: 'ok' }
        })
    })

    it('用到 api.stat 之擴充診斷不改任何既有數字與 selHash;同一次評估內其他診斷之輸出不變', () => {
        //R-EV-21 / R-EV-59: 擴充診斷拿不到帳本、也改不了 S、階梯、selHash
        let other = { name: 'other', fn: (api) => ({ text: 'o', rn: api.replaceNull({ draws: 4 }), sim: api.simulate(api.phases.map((p) => p.sels)).mean, mk: Array.from(api.market(700, 5).close) }) }
        let useStat = {
            name: 'useStat',
            fn: (api) => {
                let x = 0
                for (let p of api.phases) {
                    for (let bar of p.bars) {
                        let S = api.stat(bar, 30)
                        x += S.entries[0] + S.open[1] + api.stat(bar).closed[2]
                    }
                }
                return { text: 'ok', x }
            },
        }
        let base = ev.evalPolicy(ids, { accept, ext: [other] })
        let m = ev.evalPolicy(ids, { accept, ext: [useStat, other] })
        assert.equal(m.ext.useStat.error, undefined, m.ext.useStat.error)
        assert(m.ext.useStat.x > 0)
        assert.equal(m.selHash, base.selHash)
        for (let k of ['op', 'fresh', 'sel', 'null', 'nullVol', 'nullAct', 'nullSideAct', 'nullSideGeo']) {
            assert.deepEqual(m[k], base[k], k)
        }
        let { ms: _a, ...o1 } = base.ext.other
        let { ms: _b, ...o2 } = m.ext.other
        assert.deepEqual(o2, o1, '其他診斷之輸出不變')
        //api 仍為凍結之物件且不外露帳本
        let seen = null
        runExt(ev, (api) => {
            seen = api
            return { text: 'ok' }
        })
        assert(Object.isFrozen(seen) && typeof seen.stat === 'function' && !('L' in seen) && !('ent' in seen) && !('xPnlCum' in seen))
    })

    it('合約之兩段用法示例可執行(存為擴充診斷之檔、經 loadExt 之靜態檢查與載入、以合成帳本跑一次完整評估):行情足跡之組成對照與持倉中 / 非持倉中之兩個基準;合約寫明靜態分組之取值時點', async () => {
        //合約 §7: 兩例可直接存為 metrics/ 之檔; 靜態分組(replaceNull 之 grp)之取值之棒須不晚於評估期間之第一個決策棒(否則為前視)
        let { text, out } = contractExamples()
        assert.equal(out.length, 2, '合約 §7 含 api.stat 之 js 區塊 2 段')
        assert(text.includes('取值之棒須不晚於評估期間之第一個決策棒'), '合約寫明靜態分組之取值時點(前視之界線)')
        assert(text.includes('**以 `market` / `factor` / `series` / `stat` 為某次決策分組時亦同**'), '合約之前視條涵蓋 stat')
        assert(text.includes('`api.market` / `factor` / `series` / `stat` 之 `bar` 只核對為 0 ~ K 棒數之整數'), '合約 §1 之「只靠本合約與審計」涵蓋 stat')
        let fns = []
        for (let i = 0; i < out.length; i++) {
            let fp = path.join(t.dir, `example${i}.mjs`)
            fs.writeFileSync(fp, `${out[i]}\n`, 'utf8')
            fns.push(await loadExt(fp))
        }
        let m = ev.evalPolicy(ids, { accept, ext: fns })
        let foot = m.ext.example0
        let hold = m.ext.example1
        assert.equal(foot.error, undefined, foot.error)
        assert.equal(hold.error, undefined, hold.error)
        //行情足跡: 兩種組成對照皆有值; 分組非退化(至少兩種行情足跡各有策略)
        assert(Number.isFinite(foot.excessSide) && Number.isFinite(foot.excessFoot) && Number.isFinite(foot.pFoot), JSON.stringify(foot))
        assert.equal(foot.nClass.reduce((a, v) => a + v, 0), L.n)
        assert(foot.nClass.filter((v) => v > 0).length >= 2, `行情足跡之分組: ${JSON.stringify(foot.nClass)}`)
        assert(/^組成對照之超額: 同側 /.test(foot.text))
        //行情足跡: 與獨立重算者逐位相同 —— 取值之棒 b0 = 評估期間之第一個決策棒; 各窗之行情取帳本之 K 線、各策略於窗內之進場數取帳本之原始逐單欄(只用 b0 以前之資訊);
        //  以同一組分組交給 replaceNull ⇒ 超額與 p 相同(示例若取較晚之棒〔前視〕或窗與棒錯位, 分組即不同)
        let b0 = Math.min(...CFG.phases.map((ph) => ev.decisionBars(ph)[0]))
        let W = 10 * L.barsPerDay
        let cnt = [new Float64Array(L.n), new Float64Array(L.n), new Float64Array(L.n)]
        let nWin = 0
        for (let end = b0; end - W >= 0; end -= W) {
            let r = L.px[(end - 1) * 5 + 3] / L.px[(end - W) * 5] - 1
            let regime = r < -0.03 ? 0 : (r > 0.03 ? 2 : 1)
            for (let s = 0; s < L.n; s++) {
                for (let j = L.off[s]; j < L.off[s + 1]; j++) {
                    cnt[regime][s] += L.ent[j] >= end - W && L.ent[j] < end ? 1 : 0
                }
            }
            nWin++
        }
        let fpRef = Array.from({ length: L.n }, (_, s) => {
            let c = [cnt[0][s], cnt[1][s], cnt[2][s]]
            return c[0] + c[1] + c[2] === 0 ? 3 : (c[0] >= c[1] && c[0] >= c[2] ? 0 : (c[2] >= c[1] ? 2 : 1))
        })
        assert(nWin >= 5, `窗數 ${nWin}`)
        assert.deepEqual(foot.nClass, [0, 1, 2, 3].map((c) => fpRef.filter((v) => v === c).length), '行情足跡之分佈')
        let ref = runExt(ev, (api) => {
            let side = api.sideGroups()
            let g = new Int32Array(api.n)
            for (let s = 0; s < api.n; s++) {
                g[s] = side.grp[s] * 4 + fpRef[s]
            }
            let rf = api.replaceNull({ grp: g, nGroups: side.nGroups * 4 })
            return { text: 'ref', excess: rf.excess, p: rf.p, base: api.replaceNull().excess }
        }).ext.d
        //只分側別之組成對照 = 內建之預設(replaceNull 未給 grp)
        assert.deepEqual([foot.excessFoot, foot.pFoot, foot.excessSide], [ref.excess, ref.p, ref.base])
        //持倉中 / 非持倉中: 兩個基準皆有值; 與「池取自帳本之原始逐單欄於各決策棒之持倉中單數」之重算相同(示例若不用該決策自己之決策棒, 池即不同)
        assert(Number.isFinite(hold.excessHolding) && Number.isFinite(hold.excessFlat), JSON.stringify(hold))
        assert(/^超額: 對持倉中之隨機 /.test(hold.text))
        let refH = runExt(ev, (api) => {
            let mode = api.meta.mode
            let rng = api.rand(1)
            let pools = api.phases.map((p) => p.bars.map((bar) => {
                let open = brute(L, bar, 0).open
                let q = { L1: [], L0: [], S1: [], S0: [] }
                for (let s = 0; s < api.n; s++) {
                    q[(mode[s] > 0 ? 'L' : 'S') + (open[s] > 0 ? '1' : '0')].push(s)
                }
                return q
            }))
            let draw = (pool, m) => {
                let a = pool.slice()
                let out = []
                for (let i = 0; i < m && i < a.length; i++) {
                    let j = i + Math.floor(rng() * (a.length - i))
                    let tmp = a[i]
                    a[i] = a[j]
                    a[j] = tmp
                    out.push(a[i])
                }
                return out
            }
            let nullOf = (flag) => {
                let vals = []
                for (let d = 0; d < 8; d++) {
                    vals.push(api.simulate(api.phases.map((p, i) => p.sels.map((sel, k) => {
                        let nl = Array.from(sel).filter((s) => mode[s] > 0).length
                        return draw(pools[i][k][`L${flag}`], nl).concat(draw(pools[i][k][`S${flag}`], sel.length - nl))
                    }))).mean)
                }
                return api.summarize(vals)
            }
            let nHold = pools.flat().reduce((a, q) => a + q.L1.length + q.S1.length, 0)
            return { text: 'refH', hold: nullOf('1').excess, flat: nullOf('0').excess, nHold }
        }).ext.d
        assert(refH.nHold > 0, '鑑別前提: 有持倉中之策略')
        assert.deepEqual([hold.excessHolding, hold.excessFlat], [refH.hold, refH.flat])
        //示例之結果可重現(同一評估、同一種子)
        let m2 = ev.evalPolicy(ids, { accept, ext: fns })
        let strip = (o) => {
            let { ms: _m, ...r } = o
            return r
        }
        assert.deepEqual(strip(m2.ext.example0), strip(foot))
        assert.deepEqual(strip(m2.ext.example1), strip(hold))
    })
})
