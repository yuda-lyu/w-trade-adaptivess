import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { pathToFileURL } from 'url'
import * as LEDGER from '../src/eval/ledger.mjs'
import { loadLedger } from '../src/eval/ledger.mjs'
import { makeEvaluator, ntStaticOf } from '../src/eval/evalCore.mjs'
import buildLedger from '../src/eval/ledgerBuild.mjs'
import { makeTmp, FD_ROOT } from './tools/synthLedger.mjs'
import { writeSynthLib, iso, tms } from './tools/synthLib.mjs'
//具名匯出以命名空間取得(修前之複本無 clipLedger 時, 本檔仍可載入, 各案以斷言失敗呈現而非整檔載入失敗)
let { clipLedger, memberLedger, subsetLedger } = LEDGER


//回測期旗標之重放以回測期終點為界(排程第 510 項②; 規則 R-EV-52): 全期帳本(settings.backtest.ledgerDir)長於回測期終點者(涵蓋回測期之後之資料; 評估帳本止於回測期終點),
//  原: g_backtest.mjs 之重放無終點之上界 —— 回測期終點之後之決策被計入旗標與參照, 且跨過終點之單(進場於回測期內、出場在終點之後)以其真實之出場與損益計入(評估帳本中該單為未結)
//  規格之句: ① 決策只計 [回測期起點, 回測期終點) 內者, 且其後一個決策間隔須在終點之內(同評估帳本止於終點時 decisionBars 之界線)
//            ② 單之出場以終點為界: 出場棒 ≥ 終點者視為未結(出場棒 -1、損益 0; 同 buildLedger 於帳本終點截止時)
//            ③ 結果 = 評估器對「止於回測期終點之評估帳本」所算之結果(同一策略庫建出之兩帳本於回測期內之重放逐位相同)
//            ④ 全期帳本止於回測期終點者不受影響(clipLedger 回原物件)
//            ⑤ 回測期終點須落在全期帳本之棒格線上(原: 只在分級啟用且虛無抽數 > 0 時檢查)
let NODE = process.execPath
let BARS = 900 //策略庫之 K 線數(日線; time0 2020-01-01)
let B_TRAIN_END = 300 //訓練期終點之棒序
let B_BT_START = 330 //回測期起點
let B_BT_END = 560 //回測期終點(評估帳本止於此)
let t0 = '2020-01-01T00:00:00'
let isoBar = (b) => iso(tms(t0) + b * 86400000)
let PICK = [
    'export default function pick(ctx) {',
    '    //確定性之挑法(不含亂數): 依決策序輪流取一段策略之序號; 最後 3 個決策空手(讀 ctx.nDecisions: 重放所見之決策總數須同評估帳本止於回測期終點者)',
    '    if (ctx.nDecisions - ctx.k <= 3) {',
    '        return []',
    '    }',
    '    let ids = []',
    '    for (let s = 0; s < ctx.n; s++) {',
    '        if ((s + ctx.k) % 3 !== 0) {',
    '            ids.push(s)',
    '        }',
    '    }',
    '    return ids',
    '}',
    '',
].join('\n')

describe('g_backtest.mjs 之重放以回測期終點為界(排程第 510 項②)', function () {
    this.timeout(600000)
    let t
    let lib
    let dirE
    let dirF
    let dirG //全期帳本止於回測期終點(與評估帳本同一終點)
    before(async () => {
        t = makeTmp('backtestEnd')
        lib = path.join(t.dir, 'lib')
        writeSynthLib(lib, { key: 'SYN_1day', barHours: 24, nBars: BARS, time0: t0, n: 14, seed: 20261123 })
        dirE = path.join(t.dir, 'ledger', 'eval')
        dirF = path.join(t.dir, 'ledger', 'full')
        dirG = path.join(t.dir, 'ledger', 'fullSameEnd')
        let q = { libraryRoot: lib, keyOhlc: 'SYN_1day', barHours: 24, log: () => {} }
        await buildLedger({ ...q, endTime: isoBar(B_BT_END), outDir: dirE })
        await buildLedger({ ...q, endTime: isoBar(BARS), outDir: dirF })
        await buildLedger({ ...q, endTime: isoBar(B_BT_END), outDir: dirG })
        fs.writeFileSync(path.join(t.dir, 'pick.mjs'), PICK, 'utf8')
    })
    after(() => {
        t.cleanup()
    })

    describe('clipLedger(帳本之截止視圖)', () => {
        it('對「止於終點之帳本」逐欄相同: 進場棒 < 終點之單保留、出場棒 ≥ 終點者改為未結(出場 -1、損益 0)、依出場棒排序之已結單欄重建 —— 與同一策略庫以終點建出之帳本逐位相同', () => {
            //對應規格 ②③: 同一策略庫建出之兩帳本於終點以前之內容相同, 終點之後才出場之單於短帳本為未結
            let LF = loadLedger(dirF)
            let LE = loadLedger(dirE)
            let C = clipLedger(LF, B_BT_END)
            assert.strictEqual(C.n, LE.n)
            for (let col of ['off', 'ent', 'ext', 'pnl', 'xoff', 'xExt', 'xPnlCum', 'xWinCum']) {
                assert.strictEqual(C[col].length, LE[col].length, `${col}: 長度`)
                assert(Buffer.from(C[col].buffer, C[col].byteOffset, C[col].byteLength).equals(Buffer.from(LE[col].buffer, LE[col].byteOffset, LE[col].byteLength)), `${col}: 逐位相同`)
            }
            //鑑別前提: 全期帳本確有「進場於終點之前、出場在終點之後」之單(未截者之 ext 與短帳本不同), 且確有終點之後之進場
            let nCross = 0
            let nAfter = 0
            for (let j = 0; j < LF.ent.length; j++) {
                if (LF.ent[j] < B_BT_END && LF.ext[j] >= B_BT_END) {
                    nCross++
                }
                if (LF.ent[j] >= B_BT_END) {
                    nAfter++
                }
            }
            assert(nCross >= 3 && nAfter >= 50, `鑑別前提: 跨過終點之單 ${nCross}、終點之後之進場 ${nAfter}`)
            assert.notDeepEqual(Array.from(LF.ext).slice(0, LE.ext.length), Array.from(LE.ext), '未截之帳本之出場與短帳本不同')
        })

        it('終點恰為某張單之出場棒(出場棒 = 終點): 該單視為未結(與同一策略庫以該終點建出之帳本逐位相同; 出場棒 < 終點者為已結之界線)', async () => {
            //對應規格 ②: 出場棒 ≥ 終點者改為未結 —— 界線上(出場棒 = 終點)之單在止於終點之帳本中為未結(終點棒不含於帳本)
            let LF = loadLedger(dirF)
            let endX = -1
            for (let j = 0; j < LF.ext.length; j++) {
                if (LF.ext[j] >= 570 && LF.ext[j] <= 800 && (endX < 0 || LF.ext[j] < endX)) {
                    endX = LF.ext[j]
                }
            }
            assert(endX > 0, '鑑別前提: 有出場棒於 570 ~ 800 之單')
            let dirX = path.join(t.dir, 'ledger', 'evalX')
            await buildLedger({ libraryRoot: lib, keyOhlc: 'SYN_1day', barHours: 24, log: () => {}, endTime: isoBar(endX), outDir: dirX })
            let LX = loadLedger(dirX)
            let C = clipLedger(LF, endX)
            for (let col of ['off', 'ent', 'ext', 'pnl', 'xoff', 'xExt', 'xPnlCum', 'xWinCum']) {
                assert(Buffer.from(C[col].buffer, C[col].byteOffset, C[col].byteLength).equals(Buffer.from(LX[col].buffer, LX[col].byteOffset, LX[col].byteLength)), `${col}: 逐位相同(終點 = ${endX})`)
            }
            let nAt = 0
            for (let j = 0; j < LF.ext.length; j++) {
                if (LF.ent[j] < endX && LF.ext[j] === endX) {
                    nAt++
                }
            }
            assert(nAt >= 1, `鑑別前提: 確有出場棒 = 終點之單(${nAt} 張)`)
        })

        it('不改動傳入之帳本; 逐棒之欄與靜態欄共用; fac 與 ser 之讀取沿用原帳本; nBars 不變; ntStatic 等已帶之欄一併帶入; 另帶 endBar(= 終點); 終點 ≥ nBars 者回原物件(不帶 endBar)', () => {
            let LF = loadLedger(dirF)
            let ext0 = Array.from(LF.ext)
            let off0 = Array.from(LF.off)
            LF.ntStatic = ntStaticOf(LF, B_TRAIN_END)
            let C = clipLedger(LF, B_BT_END)
            assert.deepEqual(Array.from(LF.ext), ext0, '原帳本之出場欄不變')
            assert.deepEqual(Array.from(LF.off), off0)
            assert.notStrictEqual(C, LF)
            assert.strictEqual(C.nBars, LF.nBars)
            assert.strictEqual(C.endBar, B_BT_END)
            assert.strictEqual(LF.endBar, undefined)
            assert.strictEqual(C.px, LF.px)
            assert.strictEqual(C.mode, LF.mode)
            assert.strictEqual(C.ntStatic, LF.ntStatic)
            assert.strictEqual(C.fac, LF.fac, 'fac 沿用原帳本之讀取')
            assert.strictEqual(clipLedger(LF, LF.nBars), LF)
            assert.strictEqual(clipLedger(LF, LF.nBars + 100), LF)
            assert.strictEqual(LF.endBar, undefined, '回原物件者不帶 endBar')
        })

        //評估器對「截至終點之全期帳本」與對「止於終點之評估帳本」: 決策棒(各相位)、挑選函數所見之 ctx.nDecisions 與評估結果逐位相同(規格 ① ③; 排程第 510 項②)
        //  比對項: op、fresh、null(虛無之抽樣)、sel、selHash、phases、horizons —— 不含帳本自身之欄(period.endTime、ledgerKey 隨帳本而異)
        let parityOf = async (dirShort, dirLong, unitOn) => {
            let cfg = { warmupDays: 60, cadenceDays: 7, phases: [0, 3, 5], horizons: [7, 14], nullDraws: 4, seed: 7 }
            let LE = loadLedger(dirShort)
            LE.ntStatic = ntStaticOf(LE, B_TRAIN_END)
            let LF = loadLedger(dirLong)
            LF.ntStatic = ntStaticOf(LF, B_TRAIN_END)
            let C = clipLedger(LF, B_BT_END)
            let evE = makeEvaluator(LE, cfg)
            let evC = makeEvaluator(C, cfg)
            let evF = makeEvaluator(LF, cfg)
            for (let ph of [0, 1, 2, 3, 4, 5, 6]) {
                assert.deepEqual(evC.decisionBars(ph), evE.decisionBars(ph), `決策棒 相位 ${ph}`)
                assert(evF.decisionBars(ph).length > evE.decisionBars(ph).length, `鑑別前提: 未截者之決策較多(相位 ${ph})`)
            }
            //挑選函數: 讀 ctx.nDecisions 與 ctx.k(最後 3 個決策空手) —— 重放所見之決策總數不同者選集即不同
            let pick = (ctx) => {
                if (ctx.nDecisions - ctx.k <= 3) {
                    return []
                }
                let ids = []
                for (let s = 0; s < ctx.n; s++) {
                    if ((s + ctx.k) % 3 !== 0) {
                        ids.push(s)
                    }
                }
                return ids
            }
            let run = (ev) => {
                let m = ev.evalPolicy(pick, { phases: [0, 3, 5], horizons: [7, 14], nullDraws: 4, seed: 7, fromBar: B_BT_START })
                return JSON.stringify(Object.fromEntries(['op', 'fresh', 'null', 'sel', 'selHash', 'phases', 'horizons'].map((k) => [k, m[k]])))
            }
            let a = run(evE)
            let b = run(evC)
            assert.strictEqual(b, a, '評估結果逐位相同')
            assert.notStrictEqual(run(evF), a, '鑑別前提: 未截之全期帳本之結果不同')
            if (unitOn) {
                assert.strictEqual(C.unitN, LF.unitN, '基礎單位之名義共用')
                assert(JSON.parse(a).op.peakNotional.max > 0, '鑑別前提: 結果含基礎單位之名義(op.peakNotional 為 { mean, min, max, sd, byPhase })')
            }
        }
        it('評估器對截至終點之全期帳本與對止於終點之評估帳本: 決策棒、ctx.nDecisions 與評估結果(op、fresh、null、sel、selHash)逐位相同', async () => {
            await parityOf(dirE, dirF, false)
        })

        it('帳本帶基礎單位(unit)者同: 名義共用、等效年化之分母(最大同時持倉名義)逐位相同', async () => {
            let q = { libraryRoot: lib, keyOhlc: 'SYN_1day', barHours: 24, log: () => {}, unit: { rule: { stepSize: 0.001, minQty: 0.001, minNotional: 20 }, buffer: 0.1, uIni: 1e12 } }
            let dU = path.join(t.dir, 'ledger', 'evalU')
            let dUF = path.join(t.dir, 'ledger', 'fullU')
            await buildLedger({ ...q, endTime: isoBar(B_BT_END), outDir: dU })
            await buildLedger({ ...q, endTime: isoBar(BARS), outDir: dUF })
            await parityOf(dU, dUF, true)
        })

        it('終點之參數不合 ⇒ 拋 invalid endBar(不帶輸入值); 數字字串轉為數值(K7)', () => {
            let LF = loadLedger(dirF)
            for (let bad of [-1, 1.5, 'abc', NaN, true, null, undefined, {}, []]) {
                assert.throws(() => clipLedger(LF, bad), (e) => e.message === 'invalid endBar: must be a non-negative integer', String(bad))
            }
            let a = clipLedger(LF, String(B_BT_END))
            let b = clipLedger(LF, B_BT_END)
            assert.deepEqual(Array.from(a.ext), Array.from(b.ext))
        })
    })

    describe('g_backtest.mjs(子行程): 結果 = 評估器對止於回測期終點之評估帳本所算者', () => {
        let mkRoot = (name, ledgerDirFull, over = {}) => {
            let root = path.join(t.dir, name)
            fs.mkdirSync(path.join(root, 'rsi'), { recursive: true })
            let st = {
                periods: { train: { start: t0, end: isoBar(B_TRAIN_END) }, backtest: { start: isoBar(B_BT_START), end: isoBar(B_BT_END) } },
                eval: { ledgerDir: dirE, warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7], nullDraws: 4, seed: 7, limits: { monthlyOrders: 400, peakHold: 50 } },
                score: { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] },
                backtest: { enabled: true, ledgerDir: ledgerDirFull, resultDir: path.join(root, 'bt_out'), privateRoot: path.join(t.dir, 'private'), replicas: 2, nullDraws: 0, ...over },
                rsi: { root: './rsi' },
                records: {},
                dispatch: {},
            }
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(st), 'utf8')
            return { root, st }
        }
        let runBt = (root) => {
            fs.rmSync(path.join(root, 'bt_out'), { recursive: true, force: true })
            let r = spawnSync(NODE, [path.join(FD_ROOT, 'src', 'cli', 'backtest.mjs'), '--pick', path.join(t.dir, 'pick.mjs'), '--name', 'x', '--dir', path.join(root, 'bt_out')], { cwd: root, env: { ...process.env, ARSI_ROOT: root, ARSI_HARNESS: '1' }, windowsHide: true, encoding: 'utf8', timeout: 300000 })
            let o = null
            try {
                o = JSON.parse(fs.readFileSync(path.join(root, 'bt_out', 'x.json'), 'utf8'))
            }
            catch (err) {}
            return { status: r.status, out: `${r.stdout}\n${r.stderr}`, o }
        }
        //oracle: 評估器對止於回測期終點之評估帳本(或全期帳本)所算之各相位之操作績效(決策棒 ≥ 回測期起點者; 同 g_backtest.mjs 之 replay 之取法, 但不經其程式)
        let oracle = async (dirLedger, st) => {
            let L = loadLedger(dirLedger)
            L.ntStatic = ntStaticOf(L, B_TRAIN_END)
            let ev = makeEvaluator(L, st.eval)
            let mod = await import(pathToFileURL(path.join(t.dir, 'pick.mjs')).href)
            let r2 = (x) => Math.round(x * 100) / 100
            let rows = []
            for (let ph of st.eval.phases) {
                let r = ev.runPick(mod.default, ph, st.eval.seed)
                let i0 = r.bars.findIndex((b) => b >= B_BT_START)
                let o = ev.opOf(r.sels.slice(i0), r.bars.slice(i0), r.tags.slice(i0), null, { k0: i0 })
                rows.push({ eqYr: r2(o.eqYr), nOrders: o.nOrders, nDecisions: o.nDecisions })
            }
            return rows
        }
        let rowsOf = (o) => o.op.eqYr.byPhase.map((v, i) => ({ eqYr: v, nOrders: o.op.nOrders[i], nDecisions: o.op.nDecisions[i] }))

        it('全期帳本長於回測期終點: 各相位之等效年化、下單數、決策數 = 評估器對評估帳本所算者(修前: 終點之後之決策與損益被計入 ⇒ 不同)', async () => {
            let { root, st } = mkRoot('proj_long', dirF)
            let r = runBt(root)
            assert.strictEqual(r.status, 0, r.out.slice(0, 600))
            let want = await oracle(dirE, st)
            assert.deepEqual(rowsOf(r.o), want, '重放 = 評估帳本之評估')
            //鑑別前提: 不截時(評估器直接對全期帳本)之結果與評估帳本之結果不同 —— 決策數(終點之後之決策)與下單數皆多
            let unclipped = await oracle(dirF, st)
            assert(unclipped.every((u, i) => u.nDecisions > want[i].nDecisions && u.nOrders > want[i].nOrders), `鑑別前提: 未截者之決策與下單較多: ${JSON.stringify(unclipped)} vs ${JSON.stringify(want)}`)
            assert.notDeepEqual(unclipped.map((u) => u.eqYr), want.map((w) => w.eqYr), '鑑別前提: 等效年化不同')
        })

        it('全期帳本止於回測期終點(與評估帳本同終點): 不受影響 —— 結果 = 評估器對該帳本所算者; 與長帳本之結果一致', async () => {
            let { root, st } = mkRoot('proj_same', dirG)
            let r = runBt(root)
            assert.strictEqual(r.status, 0, r.out.slice(0, 600))
            assert.deepEqual(rowsOf(r.o), await oracle(dirG, st))
            let { root: rootL } = mkRoot('proj_long2', dirF)
            let rl = runBt(rootL)
            assert.deepEqual(rowsOf(rl.o), rowsOf(r.o), '同終點與長帳本之重放一致')
        })

        it('分級啟用(虛無抽數 > 0): 回測期之分段只含終點以內之決策(決策數 = 評估帳本者); 結果檔之 period.end = 設定之終點', async () => {
            let { root, st } = mkRoot('proj_grade', dirF, { nullDraws: 4 })
            let r = runBt(root)
            assert.strictEqual(r.status, 0, r.out.slice(0, 600))
            assert.deepEqual(rowsOf(r.o).map((x) => x.nDecisions), (await oracle(dirE, st)).map((x) => x.nDecisions))
            assert.strictEqual(r.o.period.end, isoBar(B_BT_END))
            assert(r.o.segments.length === 2 && r.o.segments.every((s) => typeof s.eq === 'number'), '兩段之分段')
        })

        it('回測期終點不在全期帳本之棒格線上 ⇒ ERROR invalid periods.backtest.end、離開碼 2、不寫結果檔(分級關閉時亦然; 原: 只在分級啟用且虛無抽數 > 0 時檢查)', () => {
            let { root, st } = mkRoot('proj_off', dirF, { grade: { enabled: false } })
            st.periods.backtest.end = isoBar(B_BT_END).replace('T00:00:00', 'T05:00:00')
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(st), 'utf8')
            let r = runBt(root)
            assert.strictEqual(r.status, 2, r.out.slice(0, 600))
            assert(r.out.includes('ERROR invalid periods.backtest.end: must be a time on the bar grid of the ledger'), r.out.slice(0, 600))
            assert.strictEqual(r.o, null, '不寫結果檔')
        })

        it('回測期終點不晚於起點、或回測期內無任何決策(視窗短於一個決策視窗)⇒ ERROR、離開碼 2、不寫結果檔(原: 靜默為決策數全 0 之 fail 旗標; 本輪之終點之界使之可能)', () => {
            for (let [endBar, want] of [
                [B_BT_START, 'ERROR invalid periods.backtest.end: must be later than periods.backtest.start'],
                [B_BT_START - 20, 'ERROR invalid periods.backtest.end: must be later than periods.backtest.start'],
                [B_BT_START + 3, 'ERROR invalid periods.backtest: must contain at least one decision'],
            ]) {
                let { root, st } = mkRoot(`proj_degen${endBar}`, dirF)
                st.periods.backtest.end = isoBar(endBar)
                fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(st), 'utf8')
                let r = runBt(root)
                assert.strictEqual(r.status, 2, `${endBar}: ${r.out.slice(0, 400)}`)
                assert(r.out.includes(want), `${endBar}: ${r.out.slice(0, 400)}`)
                assert.strictEqual(r.o, null, `${endBar}: 不寫結果檔`)
            }
            //對照: 合格之設定(終點 = B_BT_END)照常執行
            let { root } = mkRoot('proj_degen_ok', dirF)
            assert.strictEqual(runBt(root).status, 0)
        })
    })

    describe('clipLedger 之組合(先截再切半 / 子庫 = 先切半再截; 已截者再截取較早之終點)', () => {
        it('memberLedger / subsetLedger 沿用 endBar: 評估結果與「先切半再截」逐位相同; 再截: 較晚之終點回原物件、較早之終點取較小者', async () => {
            let LF = loadLedger(dirF)
            LF.ntStatic = ntStaticOf(LF, B_TRAIN_END)
            let C = clipLedger(LF, B_BT_END)
            //再截: 已截至 B_BT_END 者於較晚之終點回原物件(endBar 不被放寬), 於較早之終點取較早者
            assert.strictEqual(clipLedger(C, B_BT_END + 50), C, '較晚之終點回原物件')
            assert.strictEqual(clipLedger(C, B_BT_END), C, '同終點回原物件')
            let C2 = clipLedger(C, B_BT_END - 30)
            assert.strictEqual(C2.endBar, B_BT_END - 30, '較早之終點取較小者')
            let C3 = clipLedger(LF, B_BT_END - 30)
            for (let col of ['off', 'ent', 'ext', 'pnl', 'xoff', 'xExt', 'xPnlCum', 'xWinCum']) {
                assert(Buffer.from(C2[col].buffer, C2[col].byteOffset, C2[col].byteLength).equals(Buffer.from(C3[col].buffer, C3[col].byteOffset, C3[col].byteLength)), `${col}: 先截兩次 = 直接截至較早之終點`)
            }
            //半庫 / 子庫沿用 endBar, 且結果 = 先切半再截
            let cfg = { warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7], nullDraws: 4, seed: 7 }
            let pick = (ctx) => {
                let ids = []
                for (let s = 0; s < ctx.n; s++) {
                    if ((s + ctx.k) % 2 === 0) {
                        ids.push(s)
                    }
                }
                return ids
            }
            let run = (L) => {
                L.ntStatic = ntStaticOf(L, B_TRAIN_END)
                let m = makeEvaluator(L, cfg).evalPolicy(pick, { phases: [0, 3], horizons: [7], nullDraws: 4, seed: 7, fromBar: B_BT_START })
                return JSON.stringify(Object.fromEntries(['op', 'fresh', 'null', 'sel', 'selHash'].map((k) => [k, m[k]])))
            }
            let halfA = memberLedger(C, 3, 0)
            assert.strictEqual(halfA.endBar, B_BT_END, '半庫沿用 endBar')
            let halfB = clipLedger(memberLedger(LF, 3, 0), B_BT_END)
            assert.strictEqual(run(halfA), run(halfB), '先截再切半 = 先切半再截')
            //子庫: 遮罩(逐隻 0 / 1; 此處取每 3 隻留 1 隻)與規則之名(只作標記)
            let sel = new Uint8Array(LF.n)
            for (let s = 0; s < LF.n; s += 3) {
                sel[s] = 1
            }
            let sub = subsetLedger(C, sel, 'side:long')
            assert.strictEqual(sub.endBar, B_BT_END, '子庫沿用 endBar')
            assert.strictEqual(run(sub), run(clipLedger(subsetLedger(LF, sel, 'side:long'), B_BT_END)), '子庫: 先截再切 = 先切再截')
            //鑑別前提: 不沿用 endBar(回到全期之決策視窗; 修前之寫法)者之結果不同
            let lost = Object.defineProperties({}, Object.getOwnPropertyDescriptors(halfA))
            delete lost.endBar
            assert.notStrictEqual(run(lost), run(halfA), '鑑別前提: 丟掉 endBar 之結果不同')
        })
    })
})
