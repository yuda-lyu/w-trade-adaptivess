import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { loadLedger } from '../src/eval/ledger.mjs'
import { makeTmp, writeSynthLedger, FD_ROOT } from './tools/synthLedger.mjs'


//命令列(src/cli/eval.mjs、src/cli/backtest.mjs)對評估器之 L.ntStatic 之接線(規則 R-EV-6)
//  makeEvaluator 要求呼叫端明給 L.ntStatic(訓練期之進場數; 未給即拒絕建評估器): 命令列自設定之訓練期終點以 ntStaticOf 給界線 ——
//  帳本涵蓋訓練期以後者(回測期重放; 評估帳本含回測期)只計訓練期之進場, 帳本只涵蓋訓練期者(--period train 之診斷)為全期之進場數(皆須與原行為相同)
//  g_backtest.mjs 須授權(ARSI_HARNESS=1), 並核對「全期帳本之訓練期進場數」與「評估帳本(settings.eval.ledgerDir; g_build 之標準產物: 訓練期 + 回測期, 終點為回測期終點)之訓練期進場數」逐策略一致(排程第 496 項:
//  原讀評估帳本之 off.u32 當訓練期之進場數, 而它為全期計數 ⇒ 標準配置誤報離開碼 5) ⇒ 以較長之全期合成帳本與其前綴(評估帳本)實跑
describe('命令列對 L.ntStatic 之接線:g_eval.mjs 之兩條路徑(帳本涵蓋回測期 / 帳本只涵蓋訓練期)與 g_backtest.mjs', function () {
    let t
    before(() => {
        t = makeTmp('evalCli')
    })
    after(() => {
        t.cleanup()
    })
    //mkProject, 合成專案根: 帳本 nBars 根(4 小時一根; 起點 2022-07-01), 訓練期終點 2023-01-17(= 第 200 日 = 第 1200 棒)
    //  cut(選配): 評估帳本只寫出生成之前 cut 根(= 同一策略庫以較早之終點截斷所建者; 見 test/tools/synthLedger.mjs)
    let mkProject = (name, nBars, cut = 0) => {
        let root = path.join(t.dir, name)
        writeSynthLedger(path.join(root, 'ledger', 'eval'), { n: 60, nBars, seed: 7, cut })
        fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
            //回測期之起點(2023-02-01 = 第 1290 棒)晚於訓練期終點(第 1200 棒): 訓練期終點與回測期起點不可混用
            periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } },
            eval: { ledgerDir: './ledger/eval', warmupDays: 60, cadenceDays: 7, phases: [0], horizons: [7], nullDraws: 4, seed: 1, limits: { monthlyOrders: 400, peakHold: 50 } },
            score: { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] },
            rsi: { root: './rsi' },
            records: {},
            dispatch: {},
        }), 'utf8')
        //ctx.meta.ntAll 經錯誤訊息帶出(命令列印 ERROR PICK_RUN 與錯誤之前幾列)
        fs.writeFileSync(path.join(root, 'pick_nt.mjs'), 'export default function pick(ctx) { throw new Error("NT " + Array.from(ctx.meta.ntAll).join(",")) }\n', 'utf8')
        return root
    }
    let ntOf = (root, args) => {
        let env = { ...process.env, ARSI_ROOT: root }
        delete env.ARSI_HARNESS
        let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'eval.mjs'), '--pick', path.join(root, 'pick_nt.mjs'), '--mode', 'quick', ...args], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
        let out = `${r.stdout}\n${r.stderr}`
        let m = /Error: NT ([0-9,]+)/.exec(out)
        return { status: r.status, out, nt: m ? m[1].split(',').map(Number) : null }
    }
    //expectOf, 由帳本逐單核對: 進場棒 < trainEndBar 之單數(dir 預設為專案根下之評估帳本)
    let expectOf = (root, trainEndBar, dir = path.join(root, 'ledger', 'eval')) => {
        let L = loadLedger(dir)
        return Array.from({ length: L.n }, (_, s) => {
            let c = 0
            for (let j = L.off[s]; j < L.off[s + 1]; j++) {
                if (L.ent[j] < trainEndBar) {
                    c++
                }
            }
            return c
        })
    }

    it('g_eval.mjs:帳本涵蓋回測期(2400 棒 > 訓練期終點 1200 棒)⇒ ctx.meta.ntAll 只計訓練期之進場數(不含其後之進場)', () => {
        let root = mkProject('wide', 2400)
        let r = ntOf(root, [])
        assert.equal(r.status, 3, r.out.slice(0, 800))
        assert(r.nt && r.nt.length === 60, r.out.slice(0, 800))
        assert.deepEqual(r.nt, expectOf(root, 1200))
        let full = expectOf(root, 2400)
        assert(r.nt.some((v, s) => v < full[s]), '合成帳本於訓練期以後確有進場(否則上列比對無意義)')
    })

    it('g_eval.mjs:帳本只涵蓋訓練期(600 棒 ≤ 訓練期終點;--period train 之診斷)⇒ 照常建評估器(L.ntStatic 恆給), ctx.meta.ntAll = 帳本全期之進場數', () => {
        let root = mkProject('narrow', 600)
        let r = ntOf(root, ['--period', 'train'])
        assert.equal(r.status, 3, r.out.slice(0, 800))
        assert(!/invalid L\.ntStatic/.test(r.out), r.out.slice(0, 800))
        assert(r.nt && r.nt.length === 60, r.out.slice(0, 800))
        assert.deepEqual(r.nt, expectOf(root, 600))
    })

    //mkBt, g_backtest.mjs 之標準配置(排程第 496 項): 全期帳本(私有根; 3000 棒 = 訓練期 + 回測期 + 其後)、評估帳本(settings.eval.ledgerDir; g_build 之標準產物 = 同一策略庫以回測期終點〔第 2400 棒〕截斷; 其 off.u32 為訓練期 + 回測期之全期計數)
    //  evalMutate(選配): 於評估帳本寫入後、執行前改它(造不一致之樣本)
    //  fullBars / evalCut: 全期帳本之棒數(預設 3000)與評估帳本之截斷棒數(預設 2400; 0 = 不截斷, 與全期帳本同終點)
    let mkBt = (name, evalMutate = null, { fullBars = 3000, evalCut = 2400 } = {}) => {
        let root = mkProject(name, fullBars, evalCut)
        let full = path.join(root, 'ledger', 'full')
        writeSynthLedger(full, { n: 60, nBars: fullBars, seed: 7 })
        if (evalMutate) {
            evalMutate(path.join(root, 'ledger', 'eval'))
        }
        let st = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'))
        st.backtest = { ledgerDir: full, resultDir: path.join(root, 'bt_out'), privateRoot: path.join(t.dir, `${name}_private`), replicas: 1 }
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(st), 'utf8')
        return { root, full }
    }
    let runBt = (root) => {
        let env = { ...process.env, ARSI_ROOT: root, ARSI_HARNESS: '1' }
        let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'backtest.mjs'), '--pick', path.join(root, 'pick_nt.mjs'), '--name', 'x', '--dir', path.join(root, 'bt_out')], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
        let out = `${r.stdout}\n${r.stderr}`
        let m = /Error: NT ([0-9,]+)/.exec(out)
        return { status: r.status, out, nt: m ? m[1].split(',').map(Number) : null }
    }
    //moveEntry, 把評估帳本某隻策略之一筆進場棒移到訓練期終點(1200)之另一側(逐策略之進場棒依升冪, 移後仍升冪): 'fewer' = 訓練期最後一筆移到 1200(訓練期之進場數 -1)、'more' = 訓練期之後第一筆移到 1199(+1); 回該策略之序號
    //  'fewer' 取第一隻可移者(序號最小)、'more' 取最後一隻可移者(序號最大)⇒ 兩個方向合起來涵蓋比對迴圈之首尾
    let moveEntry = (dir, kind) => {
        let L = loadLedger(dir)
        let ent = Int32Array.from(L.ent)
        for (let i = 0; i < L.n; i++) {
            let s = kind === 'more' ? L.n - 1 - i : i
            let lo = L.off[s]
            let hi = L.off[s + 1]
            let j = lo
            while (j < hi && ent[j] < 1200) {
                j++
            }
            if (kind === 'fewer' && j > lo) {
                ent[j - 1] = 1200
            }
            else if (kind === 'more' && j < hi) {
                ent[j] = 1199
            }
            else {
                continue
            }
            fs.writeFileSync(path.join(dir, 'ent.i32'), Buffer.from(ent.buffer))
            return s
        }
        throw new Error('合成帳本找不到可移動之進場')
    }

    it('g_backtest.mjs(標準配置:評估帳本 = 全期帳本之前綴〔終點為回測期終點〕):不誤報帳本不一致;ctx.meta.ntAll 只計訓練期之進場數(實際交給挑選函數者, 不含回測期之進場)', () => {
        //排程第 496 項: 原讀評估帳本之 off.u32 當「訓練期帳本」之計數, 而評估帳本含回測期 ⇒ off.u32 為全期計數 ⇒ 與全期帳本之訓練期進場數比對必不符 ⇒ 誤報離開碼 5
        let { root, full } = mkBt('bt')
        let want = expectOf(root, 1200, full)
        let evalAll = expectOf(root, 2400)
        assert(want.some((v, s) => v < evalAll[s]), '評估帳本於訓練期以後(回測期)確有進場, 其 off.u32(全期計數)≠ 訓練期之進場數(否則下列「不誤報」無鑑別力)')
        assert.deepEqual(expectOf(root, 1200), want, '評估帳本之訓練期進場數 = 全期帳本之訓練期進場數(同一策略庫; 前綴)')
        let r = runBt(root)
        assert(!/不一致/.test(r.out), r.out.slice(0, 800))
        assert.equal(r.status, 3, r.out.slice(0, 800)) //挑選函數於第一個決策即拋錯(以此帶出 ntAll)
        assert(r.nt && r.nt.length === 60, r.out.slice(0, 800))
        assert.deepEqual(r.nt, want)
    })

    it('g_backtest.mjs:評估帳本之 time0 與全期帳本不同(同一時刻之進場以各自之棒序表示)⇒ 以各自之 time0 換算訓練期界線, 不誤報(界線 1201 棒 ≠ 全期帳本之 1200 棒)', () => {
        //評估帳本之 time0 早一棒(2022-06-30T20:00), 其進場棒與出場棒皆 +1 ⇒ 同一時刻之進場; 訓練期終點 2023-01-17 於其座標為第 1201 棒
        let { root, full } = mkBt('bt_time0', (dir) => {
            let L = loadLedger(dir)
            fs.writeFileSync(path.join(dir, 'ent.i32'), Buffer.from(Int32Array.from(L.ent, (v) => v + 1).buffer))
            fs.writeFileSync(path.join(dir, 'ext.i32'), Buffer.from(Int32Array.from(L.ext, (v) => (v >= 0 ? v + 1 : v)).buffer))
            let meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
            meta.time0 = '2022-06-30T20:00:00'
            fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8')
        })
        let want = expectOf(root, 1200, full)
        assert.deepEqual(expectOf(root, 1201), want, '同一時刻之訓練期進場數相同(座標差一棒)')
        assert(expectOf(root, 1200).some((v, s) => v !== want[s]), '以全期帳本之界線(1200)直接數評估帳本會得到不同之數字(否則下列比對無鑑別力)')
        let r = runBt(root)
        assert(!/不一致/.test(r.out), r.out.slice(0, 800))
        assert.equal(r.status, 3, r.out.slice(0, 800))
        assert.deepEqual(r.nt, want)
    })

    it('g_backtest.mjs:評估帳本之訓練期進場數與全期帳本不同(兩向:少一筆、多一筆)⇒ 拒絕, 離開碼 5, 訊息指出策略序號', () => {
        for (let kind of ['fewer', 'more']) {
            let s = -1
            let { root, full } = mkBt(`bt_${kind}`, (dir) => {
                s = moveEntry(dir, kind)
            })
            let want = expectOf(root, 1200, full)
            let got = expectOf(root, 1200)
            assert.equal(got[s], want[s] + (kind === 'fewer' ? -1 : 1), `${kind}: 樣本確使評估帳本之訓練期進場數 ${kind === 'fewer' ? '少' : '多'}一筆`)
            assert.deepEqual(got.filter((v, i) => i !== s), want.filter((v, i) => i !== s), `${kind}: 其餘策略不變`)
            let r = runBt(root)
            assert.equal(r.status, 5, `${kind}: ${r.out.slice(0, 800)}`)
            assert(r.out.includes('ERROR 全期帳本與評估帳本之訓練期進場數不一致'), `${kind}: ${r.out.slice(0, 800)}`)
            assert(r.out.includes(`策略序號 ${s} `), `${kind}: ${r.out.slice(0, 800)}`)
            assert.strictEqual(r.nt, null, `${kind}: 未進入挑選函數之執行`)
        }
    })

    it('g_backtest.mjs:評估帳本與全期帳本之策略數不同(兩向:少一隻、多一隻)⇒ 拒絕, 離開碼 5(訊息指出策略數不同)', () => {
        for (let nEval of [59, 61]) {
            let { root } = mkBt(`bt_n${nEval}`, (dir) => {
                //以另一個策略數重寫評估帳本(60 → 59 或 61 隻)
                fs.rmSync(dir, { recursive: true, force: true })
                writeSynthLedger(dir, { n: nEval, nBars: 3000, seed: 7, cut: 2400 })
            })
            let r = runBt(root)
            assert.equal(r.status, 5, `${nEval}: ${r.out.slice(0, 800)}`)
            assert(r.out.includes('ERROR 全期帳本與評估帳本之訓練期進場數不一致(策略數不同)'), `${nEval}: ${r.out.slice(0, 800)}`)
            assert.strictEqual(r.nt, null, `${nEval}: 未進入挑選函數之執行`)
        }
    })

    it('g_backtest.mjs:全期帳本與評估帳本同終點(各 2400 棒; 兩者皆為訓練期 + 回測期)⇒ 不誤報(原核對讀 off.u32 於此亦誤報)', () => {
        let { root, full } = mkBt('bt_same', null, { fullBars: 2400, evalCut: 0 })
        let want = expectOf(root, 1200, full)
        assert(want.some((v, s) => v < expectOf(root, 2400)[s]), '兩帳本於訓練期以後皆有進場(其 off.u32 為全期計數 ≠ 訓練期進場數)')
        let r = runBt(root)
        assert(!/不一致|不合核對之前提/.test(r.out), r.out.slice(0, 800))
        assert.equal(r.status, 3, r.out.slice(0, 800))
        assert.deepEqual(r.nt, want)
    })

    it('g_backtest.mjs:評估帳本之棒長與全期帳本不同(2 小時一根、同一時刻之進場以各自之棒序表示)⇒ 以各自之 barHours 換算界線, 不誤報', () => {
        let { root, full } = mkBt('bt_hours', (dir) => {
            let L = loadLedger(dir)
            fs.writeFileSync(path.join(dir, 'ent.i32'), Buffer.from(Int32Array.from(L.ent, (v) => v * 2).buffer))
            fs.writeFileSync(path.join(dir, 'ext.i32'), Buffer.from(Int32Array.from(L.ext, (v) => (v >= 0 ? v * 2 : v)).buffer))
            fs.writeFileSync(path.join(dir, 'px.f64'), Buffer.alloc(4800 * 40)) //meta.nBars 之 5 × 8 位元組 × 4800
            let meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
            meta.barHours = 2
            meta.nBars = 4800
            fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8')
        })
        let want = expectOf(root, 1200, full)
        let r = runBt(root)
        assert(!/不一致|不合核對之前提/.test(r.out), r.out.slice(0, 800))
        assert.equal(r.status, 3, r.out.slice(0, 800))
        assert.deepEqual(r.nt, want)
    })

    it('g_backtest.mjs:評估帳本無法載入(缺檔 / 缺 meta)⇒ 明確之錯誤訊息、離開碼 5(不印 Node 堆疊與路徑)', () => {
        for (let [w, f] of [['缺 pnl.f32', 'pnl.f32'], ['缺 off.u32', 'off.u32'], ['缺 meta.json', 'meta.json']]) {
            let { root } = mkBt(`bt_miss_${f.replace(/\W/g, '_')}`, (dir) => {
                fs.rmSync(path.join(dir, f))
            })
            let r = runBt(root)
            assert.equal(r.status, 5, `${w}: ${r.out.slice(0, 800)}`)
            assert(r.out.includes('ERROR 評估帳本無法載入'), `${w}: ${r.out.slice(0, 800)}`)
            assert(!/at |node:fs|ENOENT/.test(r.out) && !r.out.includes(root), `${w}: 不印堆疊與路徑`)
        }
    })

    it('g_backtest.mjs:不合核對之前提者 ⇒ 離開碼 5 與指明原因(off 欄長度與策略數不符〔評估帳本、全期帳本〕、time0 / barHours 無效〔含負棒長〕、評估帳本未涵蓋訓練期終點), 不進入挑選函數', () => {
        let cases = [
            ['評估帳本之 off 欄短一個', 'off 欄之長度與策略數不符', (dir) => {
                let L = loadLedger(dir)
                fs.writeFileSync(path.join(dir, 'off.u32'), Buffer.from(Uint32Array.from(L.off.subarray(0, L.n)).buffer))
            }],
            ['評估帳本之 off 欄為空', 'off 欄之長度與策略數不符', (dir) => {
                fs.writeFileSync(path.join(dir, 'off.u32'), Buffer.alloc(0))
            }],
            ['time0 無效', 'time0 或 barHours 無效', (dir) => {
                let meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
                meta.time0 = 'not-a-time'
                fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8')
            }],
            ['barHours 為 0', 'time0 或 barHours 無效', (dir) => {
                let meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
                meta.barHours = 0
                fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8')
            }],
            ['barHours 為負且 time0 為未來(兩個負號抵消得到相同之界線)', 'time0 或 barHours 無效', (dir) => {
                let meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
                meta.barHours = -4
                meta.time0 = '2023-12-31T00:00:00'
                fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8')
            }],
            ['time0 晚於訓練期終點(界線為負)', '訓練期終點不在帳本之棒序範圍內', (dir) => {
                let meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
                meta.time0 = '2023-06-01T00:00:00'
                fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8')
            }],
        ]
        for (let [ci, [w, why, mut]] of cases.entries()) {
            let { root } = mkBt(`bt_pre_${ci}`, mut)
            let r = runBt(root)
            assert.equal(r.status, 5, `${w}: ${r.out.slice(0, 800)}`)
            assert(r.out.includes(`ERROR 全期帳本與評估帳本不合核對之前提(${why})`), `${w}: ${r.out.slice(0, 800)}`)
            assert.strictEqual(r.nt, null, `${w}: 未進入挑選函數之執行`)
        }
        //全期帳本之 off 欄短一個
        let { root: root2 } = mkBt('bt_pre_full_off')
        let fullDir = path.join(root2, 'ledger', 'full')
        let Lf = loadLedger(fullDir)
        fs.writeFileSync(path.join(fullDir, 'off.u32'), Buffer.from(Uint32Array.from(Lf.off.subarray(0, Lf.n)).buffer))
        let r2 = runBt(root2)
        assert.equal(r2.status, 5, r2.out.slice(0, 800))
        assert(r2.out.includes('ERROR 全期帳本與評估帳本不合核對之前提(off 欄之長度與策略數不符)'), r2.out.slice(0, 800))
        //評估帳本無 px.f64(舊格式)且 meta.nBars 缺值: loadLedger 不驗 nBars ⇒ 以 `nBars < 界線` 比較會因 undefined 而放行; 須拒收
        let { root: root4 } = mkBt('bt_pre_nonbars', (dir) => {
            fs.rmSync(path.join(dir, 'px.f64'))
            let meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
            delete meta.nBars
            fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8')
        })
        let r4 = runBt(root4)
        assert.equal(r4.status, 5, r4.out.slice(0, 800))
        assert(r4.out.includes('ERROR 全期帳本與評估帳本不合核對之前提(帳本未涵蓋訓練期終點)'), r4.out.slice(0, 800))
        assert.strictEqual(r4.nt, null, '未進入挑選函數之執行')
        //meta.nBars 為數字字串或小數(無 px.f64 者 loadLedger 不驗): 比較式 `'3000' >= 1200` 為真而放行 ⇒ 須以整數檢查拒收(評估帳本、全期帳本各一)
        for (let [w, nb] of [['數字字串', '3000'], ['小數', 2400.5]]) {
            let { root: rootS } = mkBt(`bt_pre_strbars_${typeof nb}`, (dir) => {
                fs.rmSync(path.join(dir, 'px.f64'))
                let meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
                meta.nBars = nb
                fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8')
            })
            let rS = runBt(rootS)
            assert.equal(rS.status, 5, `評估帳本 nBars ${w}: ${rS.out.slice(0, 800)}`)
            assert(rS.out.includes('ERROR 全期帳本與評估帳本不合核對之前提(帳本未涵蓋訓練期終點)'), `評估帳本 nBars ${w}: ${rS.out.slice(0, 800)}`)
            let { root: rootF } = mkBt(`bt_pre_strbars_full_${typeof nb}`)
            let fullF = path.join(rootF, 'ledger', 'full')
            fs.rmSync(path.join(fullF, 'px.f64'))
            let metaF = JSON.parse(fs.readFileSync(path.join(fullF, 'meta.json'), 'utf8'))
            metaF.nBars = nb
            fs.writeFileSync(path.join(fullF, 'meta.json'), JSON.stringify(metaF), 'utf8')
            let rF = runBt(rootF)
            assert.equal(rF.status, 5, `全期帳本 nBars ${w}: ${rF.out.slice(0, 800)}`)
            assert(rF.out.includes('ERROR 全期帳本與評估帳本不合核對之前提(帳本未涵蓋訓練期終點)'), `全期帳本 nBars ${w}: ${rF.out.slice(0, 800)}`)
        }
        //全期帳本同上(無 px.f64、meta.nBars 缺值)
        let { root: root5 } = mkBt('bt_pre_full_nonbars')
        let full5 = path.join(root5, 'ledger', 'full')
        fs.rmSync(path.join(full5, 'px.f64'))
        let meta5 = JSON.parse(fs.readFileSync(path.join(full5, 'meta.json'), 'utf8'))
        delete meta5.nBars
        fs.writeFileSync(path.join(full5, 'meta.json'), JSON.stringify(meta5), 'utf8')
        let r5 = runBt(root5)
        assert.equal(r5.status, 5, r5.out.slice(0, 800))
        assert(r5.out.includes('ERROR 全期帳本與評估帳本不合核對之前提(帳本未涵蓋訓練期終點)'), r5.out.slice(0, 800))
        //全期帳本短於界線(1186 棒 < 1200)而評估帳本完整: 即使兩者之訓練期進場數恰相同亦拒絕(只檢查評估帳本者會放行)
        let { root: root6 } = mkBt('bt_pre_full_short')
        let full6 = path.join(root6, 'ledger', 'full')
        fs.rmSync(full6, { recursive: true, force: true })
        writeSynthLedger(full6, { n: 60, nBars: 3000, seed: 7, cut: 1186 })
        let r6 = runBt(root6)
        assert.equal(r6.status, 5, r6.out.slice(0, 800))
        assert(r6.out.includes('ERROR 全期帳本與評估帳本不合核對之前提(帳本未涵蓋訓練期終點)'), r6.out.slice(0, 800))
        //全期帳本之 time0 晚於訓練期終點(界線為負): 訓練期終點不在其棒序範圍內(兩帳本各自檢查)
        let { root: root7 } = mkBt('bt_pre_full_time0')
        let full7 = path.join(root7, 'ledger', 'full')
        let meta7 = JSON.parse(fs.readFileSync(path.join(full7, 'meta.json'), 'utf8'))
        meta7.time0 = '2023-06-01T00:00:00'
        fs.writeFileSync(path.join(full7, 'meta.json'), JSON.stringify(meta7), 'utf8')
        let r7 = runBt(root7)
        assert.equal(r7.status, 5, r7.out.slice(0, 800))
        assert(r7.out.includes('ERROR 全期帳本與評估帳本不合核對之前提(訓練期終點不在帳本之棒序範圍內)'), r7.out.slice(0, 800))
        //全期帳本涵蓋訓練期終點而未涵蓋回測期起點(1250 棒: 界線 1200 < 1250 ≤ 回測期起點 1290; 含恰止於回測期起點之 1290 棒): 重放無決策、旗標無意義 ⇒ 拒絕(原 g_backtest 於此輸出旗標、nDecisions 為 0)
        for (let nb of [1250, 1290]) {
            let { root: root8 } = mkBt(`bt_pre_nostart_${nb}`, null, { fullBars: nb, evalCut: 0 })
            let r8 = runBt(root8)
            assert.equal(r8.status, 5, `${nb}: ${r8.out.slice(0, 800)}`)
            assert(r8.out.includes('ERROR 全期帳本與評估帳本不合核對之前提(全期帳本未涵蓋回測期起點)'), `${nb}: ${r8.out.slice(0, 800)}`)
            assert.strictEqual(r8.nt, null, `${nb}: 未進入挑選函數之執行`)
        }
        //評估帳本未涵蓋訓練期終點(只有 1186 棒 < 界線 1200): 即使訓練期之進場數恰相同亦拒絕
        let { root: root3 } = mkBt('bt_pre_short', null, { evalCut: 1186 })
        let r3 = runBt(root3)
        assert.equal(r3.status, 5, r3.out.slice(0, 800))
        assert(r3.out.includes('ERROR 全期帳本與評估帳本不合核對之前提(帳本未涵蓋訓練期終點)'), r3.out.slice(0, 800))
    })
})
