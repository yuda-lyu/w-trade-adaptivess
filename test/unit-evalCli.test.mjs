import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { loadLedger } from '../src/eval/ledger.mjs'
import { makeTmp, writeSynthLedger, FD_ROOT } from './tools/synthLedger.mjs'


//命令列(src/cli/eval.mjs、src/cli/backtest.mjs)對評估器之 L.ntStatic 之接線(規則 R-EV-6)
//  makeEvaluator 要求呼叫端明給 L.ntStatic(訓練期之進場數; 未給即拒絕建評估器): 命令列自設定之訓練期終點以 ntStaticOf 給界線 ——
//  帳本涵蓋訓練期以後者(回測期重放; 評估帳本含回測期)只計訓練期之進場, 帳本只涵蓋訓練期者(--period train 之診斷)為全期之進場數(皆須與原行為相同)
//  g_backtest.mjs 須授權(ARSI_HARNESS=1), 並核對全期帳本之訓練期進場數與訓練期帳本之 off.u32 逐策略一致 ⇒ 以全期之合成帳本與只含 off.u32 之訓練期帳本夾實跑
describe('命令列對 L.ntStatic 之接線:g_eval.mjs 之兩條路徑(帳本涵蓋回測期 / 帳本只涵蓋訓練期)與 g_backtest.mjs', function () {
    let t
    before(() => {
        t = makeTmp('evalCli')
    })
    after(() => {
        t.cleanup()
    })
    //mkProject, 合成專案根: 帳本 nBars 根(4 小時一根; 起點 2022-07-01), 訓練期終點 2023-01-17(= 第 200 日 = 第 1200 棒)
    let mkProject = (name, nBars) => {
        let root = path.join(t.dir, name)
        writeSynthLedger(path.join(root, 'ledger', 'eval'), { n: 60, nBars, seed: 7 })
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
    //expectOf, 由帳本逐單核對: 進場棒 < trainEndBar 之單數
    let expectOf = (root, trainEndBar) => {
        let L = loadLedger(path.join(root, 'ledger', 'eval'))
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

    it('g_backtest.mjs(回測期重放;全期帳本):ctx.meta.ntAll 只計訓練期之進場數(實際交給挑選函數者, 不含回測期之進場);全期帳本與訓練期帳本之訓練期進場數不一致 ⇒ 離開碼 5', () => {
        //全期帳本 2400 棒、訓練期終點第 1200 棒; 訓練期帳本夾只需 off.u32(g_backtest 以之核對全期帳本之訓練期進場數)
        let root = mkProject('bt', 2400)
        let full = path.join(root, 'ledger', 'full')
        writeSynthLedger(full, { n: 60, nBars: 2400, seed: 7 })
        let want = expectOf(root, 1200)
        let all = expectOf(root, 2400)
        assert(want.some((v, s) => v < all[s]), '全期帳本於訓練期以後確有進場(否則下列比對無意義)')
        let writeOff = (counts) => {
            let off = new Uint32Array(counts.length + 1)
            counts.forEach((c, s) => {
                off[s + 1] = off[s] + c
            })
            fs.writeFileSync(path.join(root, 'ledger', 'eval', 'off.u32'), Buffer.from(off.buffer))
        }
        //g_backtest.mjs 以 <settings.eval.ledgerDir>/off.u32 為「訓練期帳本」之逐策略進場數核對全期帳本之訓練期進場數(既有之核對;
        //  g_build 之評估帳本含回測期,其 off.u32 為全期計數 ⇒ 與此核對之假設不合, 見 sgud/state/state.md §5);
        //  此處把 eval.ledgerDir 夾內之 off.u32 改為只含訓練期計數, 以使核對通過而驗 L.ntStatic 之接線(mkProject 原寫入 2400 棒之合成帳本供 g_eval)
        writeOff(want)
        let st = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'))
        st.backtest = { ledgerDir: full, resultDir: path.join(root, 'bt_out'), privateRoot: path.join(t.dir, 'bt_private'), replicas: 1 }
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(st), 'utf8')
        let run = () => {
            let env = { ...process.env, ARSI_ROOT: root, ARSI_HARNESS: '1' }
            let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'backtest.mjs'), '--pick', path.join(root, 'pick_nt.mjs'), '--name', 'x', '--dir', path.join(root, 'bt_out')], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            let out = `${r.stdout}\n${r.stderr}`
            let m = /Error: NT ([0-9,]+)/.exec(out)
            return { status: r.status, out, nt: m ? m[1].split(',').map(Number) : null }
        }
        let r = run()
        assert.equal(r.status, 3, r.out.slice(0, 800))
        assert(r.nt && r.nt.length === 60, r.out.slice(0, 800))
        assert.deepEqual(r.nt, want)
        //訓練期帳本之計數與全期帳本之訓練期進場數不一致 ⇒ 拒絕(離開碼 5)
        writeOff(want.map((c, s) => (s === 7 ? c + 1 : c)))
        let r5 = run()
        assert.equal(r5.status, 5, r5.out.slice(0, 800))
        assert(/全期帳本與訓練期帳本不一致/.test(r5.out))
    })
})
