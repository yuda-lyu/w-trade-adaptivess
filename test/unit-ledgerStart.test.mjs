import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import runStrategy from 'w-trade-backtest/src/runStrategy.mjs'
import ott from 'w-trade-backtest/src/ott.mjs'
import { buildLedger } from '../src/eval/ledgerBuild.mjs'
import { loadLedger } from '../src/eval/ledger.mjs'
import { makeTmp, makeTrainEvaluator, FD_ROOT } from './tools/synthLedger.mjs'
import { writeSynthLib, writeSynthSeries, readCol, ledgerDigestOf, tms, iso, DAY } from './tools/synthLib.mjs'


//帳本之起點與求解窗之一致性核對(規則 R-EV-45): 選配之 opt.startTime / settings.source.startTime(①~⑤)、一致性核對之下界(⑥)
//  合成資料: test/tools/synthLib.mjs(各欄逐筆相異; 進場由該檔獨立重算, 不經 buildLedger); 每根 1 日之策略庫 760 根(自 2020-01-01; 求解窗第 182 ~ 425 根)與每根 4 小時之策略庫 3000 根
let quiet = () => {}
let END1 = '2021-12-01T00:00:00' //每根 1 日之帳本終點(第 700 根)
let END4 = '2021-04-01T00:00:00' //每根 4 小時之帳本終點(第 2736 根)
let MSG = 'invalid startTime: must be the open time of a bar of the K lines (a time string in the same format as the K lines) and earlier than endTime'
let MSG_FEW = 'invalid startTime: must leave at least 100 bars before endTime'
let UNIT = { rule: { stepSize: 0.001, minQty: 0.001, minNotional: 20 }, buffer: 0.1, uIni: 10000 }
//釘死值: 以發布版(1.0.30)之 buildLedger 於「① 之合成資料」取得之指紋與帳本鍵(未給 startTime 者之輸出須與之逐位相同)
//  釘死值轉紅時: **先辨明是 w-trade-backtest 等相依之行為變更,還是本套件之回歸**(不得未辨明即更新值)—— 本檔不存舊碼之夾具(舊碼之夾具會使相依之變更兩邊同變而不被察覺;釘死值正是要讓相依之行為變更改變帳本鍵與評估紀錄時被察覺);
//  重取程序(相依之 w-trade-backtest 升版而使釘死案變紅時 —— 其 genKLinesTpSl / settleOrderPnl / calcBaseUnitQuantity 之行為改變會使兩值改變):
//    ① 以 1.0.30 之發布包(npm pack w-trade-adaptivess@1.0.30;未含 startTime 之版本)之 src/eval/ledgerBuild.mjs,於同一份合成資料(本檔 ① 與 ① 之二之建法)與新相依各建一次,取其指紋與帳本鍵;
//    ② 與本套件現行碼於同一份資料之輸出相同 ⇒ 差異來自相依(相依之行為變更;更新本檔之值並於 sgud/state 記錄);不同 ⇒ 本套件之回歸(修碼,不改值);新值取 ① 之輸出,不得未經 ① 之比對而直接取現行碼之輸出(那使守門恆綠)
let PIN = { digest: 'e9721e0fa5a6b9f3', key: 'e79912cf6379c884' }
//擴充輸入之釘死值(同上之取得與重取程序):含基礎單位(unit)、只有 summary.numTrade 而無頂層 numTrade 之策略檔、_vbs_ 類因子名、非 > / < 之比較符號、外部序列
//  digest = 發布版(1.0.30)所得之值(其 meta.check 為 compared 8 / same 8); digest2 = 1.0.48 起之值(頂層 numTrade 缺者以 summary.numTrade 為後備核對 ⇒ meta.check 為 compared 12 / same 12; 其餘逐位相同, 以 ledgerDigestOf 之 editMeta 證明)
let PIN_Q = { digest: '60bf5e1ea06af719', digest2: 'd46b2bad13ef1ba5', key: 'c07df2dac28348be' }

describe('帳本之起點(opt.startTime)與求解窗核對之下界(規則 R-EV-45)', function () {
    this.timeout(180000)
    let t
    let L1 //每根 1 日之合成策略庫 { bars, F, strategies, key }
    let L4 //每根 4 小時者
    let lib1
    let lib4
    let ser1
    let ser4
    let libP //釘死案之合成策略庫(每根 4 小時;求解窗自第 0 根起 = 同 K 線起點 = 求解窗起點之策略庫之形狀)與其外部序列
    let serP
    let P
    before(() => {
        t = makeTmp('ledgerStart')
        lib1 = path.join(t.dir, 'lib1')
        lib4 = path.join(t.dir, 'lib4')
        L1 = writeSynthLib(lib1, { key: 'SYN_1day', barHours: 24, nBars: 760, window: { start: 182, end: 425 }, intervalSec: true })
        L4 = writeSynthLib(lib4, { key: 'SYN_4hr', barHours: 4, nBars: 3000, window: { start: 1092, end: 2550 } })
        ser1 = path.join(t.dir, 'ser1')
        ser4 = path.join(t.dir, 'ser4')
        writeSynthSeries(ser1, L1.bars)
        writeSynthSeries(ser4, L4.bars)
        //資料: 求解窗自第 0 根起; 第 3 隻之 numTrade 多 1(⇒ check.diffs 有一筆)、第 4 隻無 timeOhlcStart、第 5 隻無 summary、第 6 隻之 timeOhlcEnd 在帳本終點之外(不核對)、第 7 隻之 timeOhlcStart 為 null
        libP = path.join(t.dir, 'libP')
        P = writeSynthLib(libP, {
            key: 'SYN_4hr',
            barHours: 4,
            nBars: 3000,
            seed: 7,
            windowOf: (i, bars) => {
                if (i === 4) {
                    return { end: bars[1500].time }
                }
                if (i === 5) {
                    return null
                }
                if (i === 6) {
                    return { start: bars[0].time, end: bars[2900].time }
                }
                if (i === 7) {
                    return { start: null, end: bars[1500].time }
                }
                return { start: bars[0].time, end: bars[1500].time }
            },
            edit: (i, s) => {
                if (i === 3) {
                    s.numTrade += 1
                    s.summary.numTrade += 1
                }
            },
        })
        serP = path.join(t.dir, 'serP')
        writeSynthSeries(serP, P.bars)
    })
    after(() => {
        t.cleanup()
    })

    let b1 = (outDir, extra = {}) => buildLedger({ libraryRoot: lib1, keyOhlc: 'SYN_1day', endTime: END1, barHours: 24, outDir, log: quiet, ...extra })
    let b4 = (outDir, extra = {}) => buildLedger({ libraryRoot: lib4, keyOhlc: 'SYN_4hr', endTime: END4, barHours: 4, outDir, log: quiet, ...extra })
    let idxOf = (bars, time) => bars.findIndex((b) => b.time === time)

    describe('① 未給(undefined / null)⇒ 與未加入本選項時逐位相同', function () {
        it('K 線起點 = 求解窗起點之策略庫(每根 4 小時;含各種策略檔之寫法與外部序列):輸出之指紋與帳本鍵 = 發布版所得之釘死值;undefined / null 與不給逐位相同;meta 無 startTime、check 無 skipped', async () => {
            //R-EV-45 ①: 未給新選項者,各檔之位元組、meta 之各鍵與鍵之次序(builtAt / buildSec / libraryRoot 除外)與發布版逐位相同
            //  資料見 before(求解窗自第 0 根起; 第 3 隻之 numTrade 多 1、第 4 隻無 timeOhlcStart、第 5 隻無 summary、第 6 隻之 timeOhlcEnd 在帳本終點之外、第 7 隻之 timeOhlcStart 為 null)
            let base = { libraryRoot: libP, keyOhlc: 'SYN_4hr', endTime: END4, barHours: 4, seriesDir: serP, log: quiet }
            let d = ['u0', 'u1', 'u2'].map((x) => path.join(t.dir, x))
            let m0 = await buildLedger({ ...base, outDir: d[0] })
            let m1 = await buildLedger({ ...base, outDir: d[1], startTime: undefined })
            let m2 = await buildLedger({ ...base, outDir: d[2], startTime: null })
            assert.equal(ledgerDigestOf(d[1]), ledgerDigestOf(d[0]), 'startTime: undefined')
            assert.equal(ledgerDigestOf(d[2]), ledgerDigestOf(d[0]), 'startTime: null')
            for (let m of [m0, m1, m2]) {
                assert(!('startTime' in m) && !('skipped' in m.check), JSON.stringify(Object.keys(m)))
            }
            //核對之結果與策略檔之寫法(第 3 隻差 1;第 4、7 隻無起點欄或為 null ⇒ 自第 0 根;第 5 隻無 summary、第 6 隻終點在帳本外 ⇒ 不核對)
            assert.deepEqual(m0.check, { compared: 10, same: 9, diffs: [{ f: 's03.json', ledger: 300, file: 301 }] })
            assert.equal(m0.key, PIN.key)
            assert.equal(ledgerDigestOf(d[0]), PIN.digest, `指紋 ${ledgerDigestOf(d[0])}`)
        })

        it('擴充輸入(① 之二):基礎單位、只有 summary.numTrade 而無頂層 numTrade 之策略檔、_vbs_ 類因子名、非 > / < 之比較符號、外部序列 ⇒ 指紋與帳本鍵 = 發布版所得之釘死值;undefined / null 與不給逐位相同', async () => {
            //R-EV-45 ①(擴充): 釘死案之輸入涵蓋 unit(meta.unit / meta.unitStat / unit.f64)、頂層 numTrade 缺而只有 summary.numTrade(發布版之核對略過、compared 只計有頂層者 = 8; 1.0.48 起以 summary.numTrade 為後備核對 = 12; 見下 digest2)、
            //  因子名含 _vbs_(cls 之第 3 類)、比較符號 '>='(帳本當作 '<'、meta.rule.nSymOther = 1); 值取自發布版(1.0.30)於同一份合成資料之輸出
            let libQ = path.join(t.dir, 'libQ')
            let Q = writeSynthLib(libQ, {
                key: 'SYN_4hr',
                barHours: 4,
                nBars: 3000,
                seed: 11,
                vbs: true,
                windowOf: (i, bars) => ({ start: bars[0].time, end: bars[1500].time }),
                edit: (i, s) => {
                    if (i % 3 === 1) {
                        delete s.numTrade
                    }
                    if (i === 5) {
                        s.conds[0].sym = '>='
                    }
                },
            })
            let serQ = path.join(t.dir, 'serQ')
            writeSynthSeries(serQ, Q.bars)
            let base = { libraryRoot: libQ, keyOhlc: 'SYN_4hr', endTime: END4, barHours: 4, seriesDir: serQ, unit: UNIT, log: quiet }
            let d = ['q0', 'q1', 'q2'].map((x) => path.join(t.dir, x))
            let m0 = await buildLedger({ ...base, outDir: d[0] })
            await buildLedger({ ...base, outDir: d[1], startTime: undefined })
            await buildLedger({ ...base, outDir: d[2], startTime: null })
            assert.equal(ledgerDigestOf(d[1]), ledgerDigestOf(d[0]))
            assert.equal(ledgerDigestOf(d[2]), ledgerDigestOf(d[0]))
            //鑑別前提: 輸入確含上列各形
            //排程第 564 項(1.0.48): 頂層 numTrade 缺而有 summary.numTrade 者(4 隻)改以 summary.numTrade 為後備核對 ⇒ compared 由 8 增為 12、same 同(原: 整隻不核對)
            assert.deepEqual(m0.check, { compared: 12, same: 12, diffs: [] }, '頂層 numTrade 缺者 4 隻以 summary.numTrade 核對(原: 不核對 ⇒ compared 8)')
            assert.equal(m0.rule.nSymOther, 1)
            assert(m0.keyNames.some((k) => k.includes('_vbs_')) && m0.unit && m0.unitStat)
            assert.equal(m0.key, PIN_Q.key)
            //帳本之各檔與 meta 之其餘各鍵不變: 把 meta.check 改回改前之值(compared 8、same 8)後之指紋 = 發布版(1.0.30)所得之釘死值(PIN_Q.digest); 現行之指紋 = PIN_Q.digest2(只多 check.compared / same 之改變)
            let revertCheck = (m) => {
                m.check.compared = 8
                m.check.same = 8
            }
            assert.equal(ledgerDigestOf(d[0], revertCheck), PIN_Q.digest, '改回 compared 8 / same 8 後 ⇒ 與發布版逐位相同(只有 meta.check 變)')
            assert.equal(ledgerDigestOf(d[0]), PIN_Q.digest2, `指紋 ${ledgerDigestOf(d[0])}`)
        })
    })

    describe('② 起點之檢查(於寫出之前;訊息不帶輸入值)', function () {
        it('型別不合(非字串、無法解析)於讀任何檔之前拋 invalid startTime(策略庫路徑不存在亦然)、不建輸出夾', async () => {
            //R-EV-45 ②: 型別於讀任何檔之前檢查
            //含帶時區字尾者(Z、+08:00): 一律於讀檔之前拒絕(型別檢查以 Date.parse(`${s}Z`) 判定, 帶字尾者無法解析)
            for (let v of [20200701, 0, true, false, {}, [], ['2020-07-01T00:00:00'], '', ' ', 'abc', '2020-13-45T00:00:00', '2020-07-01T00:00:00Z', '2020-07-01T00:00:00+08:00', NaN, Infinity]) {
                let out = path.join(t.dir, 'bad_type')
                await assert.rejects(buildLedger({ libraryRoot: path.join(t.dir, 'nolib'), keyOhlc: 'x', endTime: END1, startTime: v, barHours: 24, outDir: out, log: quiet }), (err) => err.message === MSG, JSON.stringify(v))
                assert.equal(fs.existsSync(out), false, `未建輸出夾 ${JSON.stringify(v)}`)
            }
        })

        it('不是 K 線檔內之棒之開盤時間(不在棒上、格式不同、早於第一根、晚於最後一根)或不早於 endTime(恰等於、之後)⇒ 拋 invalid startTime、不寫出任何檔', async () => {
            //R-EV-45 ②: 須為 K 線檔內某一根之開盤時間(同一字串格式)且早於 endTime
            for (let [why, v] of [['不在棒上', '2020-07-01T01:00:00'], ['格式不同', '2020-07-01'], ['早於第一根', '2019-12-31T00:00:00'], ['晚於最後一根', '2099-01-01T00:00:00'], ['恰為 endTime', END1], ['晚於 endTime(在 K 線上)', iso(tms(END1) + DAY)]]) {
                let out = path.join(t.dir, 'bad_bar')
                await assert.rejects(b1(out, { startTime: v }), (err) => err.message === MSG, why)
                assert.equal(fs.existsSync(out), false, `${why}: 不寫出`)
            }
            //已有帳本之資料夾:失敗者不動既有之 meta.json
            let keep = path.join(t.dir, 'keep')
            await b1(keep)
            let before = fs.readFileSync(path.join(keep, 'meta.json'), 'utf8')
            await assert.rejects(b1(keep, { startTime: '2020-07-01T01:00:00' }), (err) => err.message === MSG)
            assert.equal(fs.readFileSync(path.join(keep, 'meta.json'), 'utf8'), before, '失敗不動既有帳本')
        })

        it('起點之後之 K 線不滿 100 根 ⇒ 拋 invalid startTime: must leave at least 100 bars before endTime(不帶輸入值)、不寫出;恰 100 根者照建;未給起點而 K 線不滿 100 根者沿用「K 線過少」之原訊息', async () => {
            //R-EV-45 ②: 起點之後不滿 100 根亦為起點不合之錯誤(命令列轉為 ERROR invalid source.startTime…、離開碼 2); 未給者之訊息不變
            let out = path.join(t.dir, 'few')
            await assert.rejects(b1(out, { startTime: L1.bars[700 - 99].time }), (err) => err.message === MSG_FEW)
            assert.equal(fs.existsSync(out), false)
            let m = await b1(out, { startTime: L1.bars[700 - 100].time })
            assert.equal(m.nBars, 100)
            //未給起點: endTime 之前只有 50 根 ⇒ 原訊息(與發布版逐字相同)
            let out2 = path.join(t.dir, 'few2')
            await assert.rejects(b1(out2, { endTime: L1.bars[50].time }), (err) => err.message === `K 線過少(50); endTime ${L1.bars[50].time}`)
            assert.equal(fs.existsSync(out2), false)
        })

        it('與外部序列之比例上限(seriesOffGridMax)並用:對不到棒之列以帳本起點(= startTime)為界 —— 起點以前之列不計(beforeStart)、起點以後(至終點)之列計入', async () => {
            //R-EV-45 ①: 起點以前之列不在帳本範圍內(「時間落在帳本範圍內而對不到棒之開盤時間」之列才計); 序列之範圍判定以 time0 = 起點(不是 K 線檔之第一根)
            //  序列 fund: 每根皆有一列(第 0 ~ 699 根), 另加一列「第 50 根之日期 12:00」(日線之棒皆為 00:00:00 ⇒ 不是棒之開盤時間)
            let iS = 100
            let offAt = (i) => `${L1.bars[i].time.slice(0, 10)}T12:00:00`
            let mkSer = (name, offIdx) => {
                let d = path.join(t.dir, name)
                fs.mkdirSync(d, { recursive: true })
                let rows = L1.bars.slice(0, 700).map((b, i) => ({ time: b.time, value: 0.001 * i + Math.sin(i) * 0.01 }))
                rows.push({ time: offAt(offIdx), value: 123.456 })
                fs.writeFileSync(path.join(d, 'fund.json'), JSON.stringify(rows))
                return d
            }
            let serBefore = mkSer('ser_off_before', 50) //錯位之列在起點(第 100 根)以前
            let serAfter = mkSer('ser_off_after', 200) //錯位之列在起點以後
            let reject = /^Error: invalid series fund: off-grid rows exceed seriesOffGridMax/
            //未給起點: 該列在帳本範圍內(第 0 根起)⇒ 上限 0 拒建(對照; 同發布版)
            await assert.rejects(b1(path.join(t.dir, 'sg0'), { seriesDir: serBefore, seriesOffGridMax: 0 }), reject)
            //給了起點(第 100 根): 該列在起點以前 ⇒ 不計、照建
            let m = await b1(path.join(t.dir, 'sg1'), { seriesDir: serBefore, seriesOffGridMax: 0, startTime: L1.bars[iS].time })
            assert.equal(m.time0, L1.bars[iS].time)
            assert.equal(m.nBars, 700 - iS)
            //該列在起點以後 ⇒ 計入、拒建(起點以前之界不是「全部放行」)
            await assert.rejects(b1(path.join(t.dir, 'sg2'), { seriesDir: serAfter, seriesOffGridMax: 0, startTime: L1.bars[iS].time }), reject)
            assert.equal(fs.existsSync(path.join(t.dir, 'sg2')), false, '拒建者不寫出')
        })
    })

    //assertShifted, 起點為 iT 之帳本 B ≡ 未給起點之帳本 A「只留進場棒 ≥ iT、棒序平移 iT」(R-EV-45 ③)
    //  Lib: 合成策略庫(進場由 synthLib 獨立重算); nEnd: A 之棒數(= endTime 之棒序); 回 { straddle, early, unsettled }(供鑑別前提)
    let assertShifted = (dirA, dirB, iT, Lib, nEnd, { series, unit }) => {
        let A = loadLedger(dirA)
        let B = loadLedger(dirB)
        let n = A.n
        assert.equal(B.n, n)
        assert.equal(A.nBars, nEnd)
        assert.equal(B.nBars, nEnd - iT, 'nBars')
        let early = 0 //起點以前有進場之策略數
        let straddle = 0 //進場在起點以前而出場在起點(含)以後之單數(不入 B)
        let unsettled = 0
        let nOrders = 0
        for (let s = 0; s < n; s++) {
            let ent = []
            let ext = []
            let pnl = []
            for (let j = A.off[s]; j < A.off[s + 1]; j++) {
                if (A.ent[j] >= iT) {
                    ent.push(A.ent[j] - iT)
                    ext.push(A.ext[j] >= 0 ? A.ext[j] - iT : -1)
                    pnl.push(A.pnl[j])
                }
                else {
                    straddle += A.ext[j] >= iT || A.ext[j] === -1 ? 1 : 0
                }
            }
            early += A.off[s + 1] - A.off[s] > ent.length ? 1 : 0
            let gotEnt = Array.from(B.ent.subarray(B.off[s], B.off[s + 1]))
            //B 之進場棒 = 由 synthLib 獨立重算之進場(K 線之棒序 ≥ iT、< 帳本終點)平移; 並 = 自 A 切出者
            assert.deepEqual(gotEnt, Lib.strategies[s].entries.filter((e) => e >= iT && e < nEnd).map((e) => e - iT), `第 ${s} 隻之進場棒(獨立重算)`)
            assert.deepEqual(gotEnt, ent, `第 ${s} 隻之進場棒`)
            assert.deepEqual(Array.from(B.ext.subarray(B.off[s], B.off[s + 1])), ext, `第 ${s} 隻之出場棒(未結仍為 -1)`)
            let gotPnl = B.pnl.subarray(B.off[s], B.off[s + 1])
            assert(pnl.length === gotPnl.length && pnl.every((v, q) => Object.is(v, gotPnl[q])), `第 ${s} 隻之損益`)
            unsettled += ext.filter((x) => x === -1).length
            nOrders += ent.length
        }
        //靜態欄與條件欄逐位相同(與起點無關)
        for (let f of ['mode.i8', 'tp.f32', 'sl.f32', 'nKeys.u8', 'lv.i32', 'fitNt.i32', 'cls.u8', 'keyOff.u32', 'keyIdx.u16', 'keySym.i8', 'keyTh.f64', 'keyOr.u8', 'ids.json']) {
            assert(fs.readFileSync(path.join(dirA, f)).equals(fs.readFileSync(path.join(dirB, f))), f)
        }
        //逐棒之欄 = 原欄之切片(因子:列 = 因子、行 = 棒; K 線:每棒 5 個值; 外部序列;基礎單位名義)
        let slice = (a, rows, w, nA, nB) => {
            for (let r = 0; r < rows; r++) {
                let x = a.A.subarray((r * nA + iT) * w, (r * nA + nA) * w)
                let y = a.B.subarray(r * nB * w, (r * nB + nB) * w)
                assert(x.length === y.length && x.every((v, q) => Object.is(v, y[q])), `${a.name} 第 ${r} 列`)
            }
        }
        let nK = A.meta.keyNames.length
        slice({ name: 'fac', A: readCol(dirA, 'fac.f64', Float64Array), B: readCol(dirB, 'fac.f64', Float64Array) }, nK, 1, nEnd, nEnd - iT)
        slice({ name: 'px', A: readCol(dirA, 'px.f64', Float64Array), B: readCol(dirB, 'px.f64', Float64Array) }, 1, 5, nEnd, nEnd - iT)
        if (series) {
            assert.deepEqual(B.meta.seriesNames, A.meta.seriesNames)
            slice({ name: 'ser', A: readCol(dirA, 'ser.f64', Float64Array), B: readCol(dirB, 'ser.f64', Float64Array) }, A.meta.seriesNames.length, 1, nEnd, nEnd - iT)
        }
        if (unit) {
            slice({ name: 'unit', A: readCol(dirA, 'unit.f64', Float64Array), B: readCol(dirB, 'unit.f64', Float64Array) }, 1, 1, nEnd, nEnd - iT)
            assert.deepEqual(B.meta.unit, A.meta.unit)
        }
        //meta
        let mA = A.meta
        let mB = B.meta
        assert.equal(mB.time0, Lib.bars[iT].time, 'time0 = 起點')
        assert.equal(mB.startTime, Lib.bars[iT].time, 'meta.startTime')
        assert.equal(mB.endTime, mA.endTime)
        assert.equal(mB.nOrders, nOrders)
        assert.equal(mB.nUnsettled, unsettled)
        for (let k of ['version', 'barHours', 'nStrategies', 'nFirstTouch', 'keyNames', 'rule']) {
            assert.deepEqual(mB[k], mA[k], k)
        }
        return { early, straddle, unsettled }
    }

    describe('③ 給了起點之帳本 ≡ 未給者只留進場棒 ≥ 起點、棒序平移(進場棒、出場棒、損益、各逐棒之欄)', function () {
        let nEnd1 = 700
        let nEnd4 = 2736
        for (let [name, mk, iTs] of [['每根 1 日(含外部序列與基礎單位)', 1, [182, 333]], ['每根 4 小時(含外部序列與基礎單位)', 4, [1092, 1517]]]) {
            it(`${name}:起點 = 求解窗起點、與另一個不在第一根亦非求解窗起點之棒`, async () => {
                let Lib = mk === 1 ? L1 : L4
                let build = mk === 1 ? b1 : b4
                let ser = mk === 1 ? ser1 : ser4
                let nEnd = mk === 1 ? nEnd1 : nEnd4
                let extra = { seriesDir: ser, unit: UNIT }
                let dA = path.join(t.dir, `eq${mk}_A`)
                let mA = await build(dA, extra)
                assert.equal(mA.nBars, nEnd)
                let seen = new Set([mA.key])
                for (let iT of iTs) {
                    let dB = path.join(t.dir, `eq${mk}_B${iT}`)
                    let mB = await build(dB, { ...extra, startTime: Lib.bars[iT].time })
                    let r = assertShifted(dA, dB, iT, Lib, nEnd, { series: true, unit: true })
                    //鑑別前提: 起點以前確有進場、確有進場在起點以前而出場在其後之單(不入 B)、確有未結之單
                    assert(r.early >= 6 && r.straddle > 0 && r.unsettled > 0, JSON.stringify(r))
                    assert(!seen.has(mB.key), '起點不同 ⇒ 帳本鍵不同')
                    seen.add(mB.key)
                }
            })
        }

        it('起點 = K 線檔之第一根(帳本與未給者相同):各檔之位元組與帳本鍵逐位相同,meta 只多 startTime', async () => {
            let dA = path.join(t.dir, 'first_A')
            let dB = path.join(t.dir, 'first_B')
            let mA = await b1(dA, { seriesDir: ser1 })
            let mB = await b1(dB, { seriesDir: ser1, startTime: L1.bars[0].time })
            assert.equal(mB.key, mA.key, '同一帳本 ⇒ 同一鍵')
            for (let f of fs.readdirSync(dA).filter((f) => f !== 'meta.json')) {
                assert(fs.readFileSync(path.join(dA, f)).equals(fs.readFileSync(path.join(dB, f))), f)
            }
            let strip = (m) => {
                let o = { ...m }
                delete o.builtAt
                delete o.buildSec
                delete o.startTime
                return JSON.stringify(o)
            }
            assert.equal(strip(mB), strip(mA))
            assert.equal(mB.startTime, L1.bars[0].time)
            //meta.startTime 置於 endTime 之後、time0 之前(未給者無此鍵,其餘鍵之次序不變)
            let ks = Object.keys(mB)
            assert.equal(ks[ks.indexOf('endTime') + 1], 'startTime')
            assert.equal(ks[ks.indexOf('startTime') + 1], 'time0')
            assert.deepEqual(ks.filter((k) => k !== 'startTime'), Object.keys(mA))
        })

        it('給了起點之帳本之逐張(進場棒、出場棒、每單位損益)= 官方 runStrategy 於自起點起之 K 線與因子之結果(做多、做空、含 or 條件)', async () => {
            //R-EV-45 ③: 官方回測為真理源; 以自起點起之資料重放, 與帳本逐張一致
            let iT = 333
            let T = L1.bars[iT].time
            let dB = path.join(t.dir, 'off_B')
            await b1(dB, { startTime: T })
            let B = loadLedger(dB)
            let arr = L1.bars.filter((b) => b.time >= T && b.time < END1)
            let ind = new Map(arr.map((r, i) => [r.time, i]))
            let get = async (k) => (k === 'SYN_1day' ? arr : L1.F[k].filter((r) => r.time >= T && r.time < END1))
            let nOrd = 0
            for (let si of [0, 1, 2, 5, 7]) {
                let s = JSON.parse(fs.readFileSync(path.join(lib1, 'strategies', L1.strategies[si].file), 'utf8'))
                let r = await runStrategy(ott, { ...s, keyOhlc: 'SYN_1day', settings: { uIni: 1000, uTrade: 1, ...s.settings, timeBasis: 'open' } }, get, { withSummary: false })
                assert.equal(r.orders.length, B.off[si + 1] - B.off[si], `第 ${si} 隻之單數`)
                r.orders.forEach((o, q) => {
                    let j = B.off[si] + q
                    assert.equal(ind.get(o.timeStart), B.ent[j])
                    assert.equal(o.timeEnd ? ind.get(o.timeEnd) : -1, B.ext[j])
                    assert(Math.abs((o.timeEnd ? o.uProfitOrLoss / o.uTrade : 0) - B.pnl[j]) < 1e-6)
                })
                nOrd += r.orders.length
            }
            assert(nOrd > 100, `核對之單數 ${nOrd}`)
        })
    })

    describe('④ 帳本鍵', function () {
        it('雜湊輸入含 time0、棒數與逐單之進場棒:起點不同之帳本鍵必不同;同一起點重建之鍵相同(決定性);meta.key 與位元組之關係不變', async () => {
            //R-EV-45 ④: 「同一批訂單、起點不同之兩份帳本」之鍵不同(進場棒隨起點平移、time0 與棒數亦入雜湊), 不須另加雜湊輸入
            let keys = []
            for (let iT of [0, 100, 182, 183, 333]) {
                let m = await b1(path.join(t.dir, `key_${iT}`), iT === 0 ? {} : { startTime: L1.bars[iT].time })
                keys.push(m.key)
            }
            assert.equal(new Set(keys).size, keys.length, keys.join(','))
            let again = await b1(path.join(t.dir, 'key_again'), { startTime: L1.bars[182].time })
            assert.equal(again.key, keys[2], '同一起點 ⇒ 同一鍵')
        })
    })

    describe('⑤ 評估器不改:暖機自帳本起點(= 起點)起算,第一個決策 = 起點 + 暖機日數', function () {
        it('未給起點:第一個決策 = 帳本第一根 + 暖機日數;給了起點:= 起點 + 暖機日數(每根 1 日與每根 4 小時;決策棒序、時刻皆對)', async () => {
            for (let [name, Lib, build, iT, bpd] of [['每根 1 日', L1, b1, 182, 1], ['每根 4 小時', L4, b4, 1092, 6]]) {
                let dA = path.join(t.dir, `ev_A${bpd}`)
                let dB = path.join(t.dir, `ev_B${bpd}`)
                await build(dA)
                await build(dB, { startTime: Lib.bars[iT].time })
                let warm = 60
                for (let [dir, first] of [[dA, Lib.bars[0].time], [dB, Lib.bars[iT].time]]) {
                    let ev = makeTrainEvaluator(loadLedger(dir), { warmupDays: warm, cadenceDays: 7 })
                    let bar0 = ev.decisionBars(0)[0]
                    assert.equal(bar0, warm * bpd, `${name}: 第一個決策之棒序 = 暖機日數 × 每日棒數`)
                    assert.equal(ev.timeOf(bar0), iso(tms(first) + warm * DAY), `${name}: 第一個決策之時刻 = 帳本第一根 + 暖機日數`)
                }
            }
        })
    })

    describe('⑥ 一致性核對(meta.check)之下界:求解窗起點棒 ≤ 進場棒 ≤ 求解窗終點棒', function () {
        //expectCheck, 獨立之期望值: iT = 帳本第一根於 K 線檔之棒序, nEnd = 帳本終點之棒序
        let firstSkipped = null //最近一次 expectCheck 所見第一個被略過者 { f, t }(供核對記錄之文字)
        let expectCheck = (Lib, iT, nEnd) => {
            let out = { compared: 0, same: 0, diffs: [] }
            let skipped = 0
            firstSkipped = null
            for (let { file, s, entries } of Lib.strategies) {
                if (!s.summary || typeof s.numTrade !== 'number') {
                    continue
                }
                let e = idxOf(Lib.bars, s.summary.timeOhlcEnd)
                if (!(e >= iT && e < nEnd)) {
                    continue //終點不在帳本內 ⇒ 不核對(同發布版)
                }
                let a = s.summary.timeOhlcStart
                let lo = iT
                if (a !== undefined && a !== null) {
                    lo = idxOf(Lib.bars, a)
                    if (lo < iT) {
                        skipped++ //起點早於帳本起點(含不在棒上者、空字串與非字串)⇒ 帳本未涵蓋完整之求解窗
                        firstSkipped = firstSkipped || { f: file, t: a }
                        continue
                    }
                }
                let cnt = entries.filter((x) => x >= lo && x <= e).length
                out.compared++
                if (cnt === s.numTrade) {
                    out.same++
                }
                else {
                    out.diffs.push({ f: file, ledger: cnt, file: s.numTrade })
                }
            }
            return { ...out, ...(skipped > 0 ? { skipped } : {}) }
        }

        it('K 線早於求解窗起點之策略庫(每根 1 日;未給 startTime):全數相符(舊寫法自第 0 根計而誤報不符);startTime = 求解窗起點者之 check 逐位相同', async () => {
            //R-EV-45 ⑥: 起點 = 求解窗起點之棒(第 182 根)為下界
            let mA = await b1(path.join(t.dir, 'ck_A'))
            let mB = await b1(path.join(t.dir, 'ck_B'), { startTime: L1.bars[182].time })
            assert.deepEqual(mA.check, { compared: 12, same: 12, diffs: [] })
            assert.deepEqual(mB.check, mA.check, 'startTime = 求解窗起點 ⇒ 同一核對')
            assert.deepEqual(mA.check, expectCheck(L1, 0, 700))
            //鑑別前提: 舊寫法(自第 0 根起、只計 ≤ 終點)之計數與 numTrade 不同(求解窗以前確有進場)⇒ 本案確會於舊寫法下不符
            let oldDiff = L1.strategies.filter(({ s, entries }) => entries.filter((x) => x <= idxOf(L1.bars, s.summary.timeOhlcEnd)).length !== s.numTrade).length
            assert(oldDiff >= 6, `舊寫法不符之策略數 ${oldDiff}`)
        })

        it('逐策略之求解窗起點:在帳本內者以該棒為下界;無起點欄(或 null)者自第 0 根;早於帳本起點或不在棒之開盤時間者不納入核對(compared 不計、check.skipped 計隻數、記錄註明);終點不在帳本內者不核對', async () => {
            let libW = path.join(t.dir, 'libW')
            let W = writeSynthLib(libW, {
                key: 'SYN_1day',
                barHours: 24,
                nBars: 760,
                windowOf: (i, bars) => {
                    let end = bars[425].time
                    if (i === 7) {
                        return { start: '2020-07-01T05:00:00', end: bars[750].time } //終點在帳本外 ⇒ 不核對、也不計 skipped
                    }
                    if (i === 11) {
                        return { start: null, end }
                    }
                    if (i % 4 === 0) {
                        return { start: bars[182].time, end }
                    }
                    if (i % 4 === 1) {
                        return { start: bars[220].time, end }
                    }
                    if (i % 4 === 2) {
                        return { end } //無起點欄
                    }
                    return { start: '2020-07-01T05:00:00', end } //不在棒之開盤時間
                },
            })
            let logs = []
            let bw = (out, extra = {}) => buildLedger({ libraryRoot: libW, keyOhlc: 'SYN_1day', endTime: END1, barHours: 24, outDir: out, log: (s) => logs.push(s), ...extra })
            for (let iT of [0, 182, 300]) {
                logs.length = 0
                let m = await bw(path.join(t.dir, `ckW_${iT}`), iT === 0 ? {} : { startTime: W.bars[iT].time })
                let want = expectCheck(W, iT, 700)
                assert.deepEqual(m.check, want, `起點第 ${iT} 根`)
                assert.strictEqual('skipped' in m.check, want.skipped !== undefined)
                //記錄: 「注意:」起首(有受核對者)、附第一個被略過者之檔名與其 summary.timeOhlcStart(JSON 字串化後截至 40 字)
                let note = logs.find((s) => s.startsWith(`注意: ${want.skipped} 隻策略之求解窗起點`))
                assert(want.skipped > 0 && note !== undefined, logs.join('\n'))
                assert(note.endsWith(`; 第一個: ${firstSkipped.f} 之 summary.timeOhlcStart = ${JSON.stringify(firstSkipped.t).slice(0, 40)}`), note)
                //記錄之第一列:給了起點者註明起點(含);未給者與未加入本選項時相同
                let first = logs.find((s) => s.startsWith('ohlc SYN_1day:'))
                assert.equal(first, iT === 0 ? `ohlc SYN_1day: 700 根, ${W.bars[0].time} ~ ${W.bars[699].time}(endTime ${END1} 不含)` : `ohlc SYN_1day: ${700 - iT} 根, ${W.bars[iT].time} ~ ${W.bars[699].time}(startTime ${W.bars[iT].time} 含; endTime ${END1} 不含)`)
                //鑑別前提(各起點): 納入核對者中有不同之下界、且部分策略確被略過(第 0 根起者只有不在棒上之一隻)
                if (iT === 0) {
                    assert.deepEqual([want.compared, want.skipped], [10, 1])
                }
                if (iT === 182) {
                    assert(want.diffs.length >= 2 && want.skipped === 1, JSON.stringify(want)) //無起點欄 / null 者自帳本第 0 根 ⇒ 與自棒序 0 起算之 numTrade 不同
                }
                if (iT === 300) {
                    assert(want.skipped >= 6, JSON.stringify(want))
                }
            }
        })

        it('帳本未涵蓋完整之求解窗(startTime 晚於全部策略之求解窗起點):全部略過 ⇒ { compared: 0, same: 0, diffs: [], skipped: N };記錄以 WARN 起首並附第一個被略過者', async () => {
            let logs = []
            let m = await b1(path.join(t.dir, 'ck_late'), { startTime: L1.bars[183].time, log: (s) => logs.push(s) })
            assert.deepEqual(m.check, { compared: 0, same: 0, diffs: [], skipped: 12 })
            //全數略過(無一隻受核對)⇒ WARN; 第一個 = 檔名排序之第一隻(s00)與其起點欄
            let w = logs.find((s) => s.startsWith('WARN '))
            assert(w !== undefined && !logs.some((s) => s.startsWith('注意: ')), logs.join('\n'))
            assert(w.startsWith('WARN 12 隻策略之求解窗起點(summary.timeOhlcStart)不在本帳本之棒上') && w.includes('(全數略過 ⇒ 無一隻受核對)'), w)
            assert(w.endsWith(`; 第一個: s00.json 之 summary.timeOhlcStart = ${JSON.stringify(L1.bars[182].time)}`), w)
        })

        it('起點欄之寫法(規格:「未帶」= undefined 或 null;其餘〔空字串、0、false 等非字串〕而不在本帳本之棒上者不納入核對);起點晚於終點者照核對(計為不符)', async () => {
            //R-EV-45 ⑥: 固定「未帶」之定義(undefined / null)與「起點晚於終點」之現行行為
            let libZ = path.join(t.dir, 'libZ')
            let Zl = writeSynthLib(libZ, {
                key: 'SYN_1day',
                barHours: 24,
                nBars: 760,
                n: 8,
                windowOf: (i, bars) => {
                    let end = bars[425].time
                    if (i === 0) {
                        return { start: '', end }
                    }
                    if (i === 1) {
                        return { start: 0, end }
                    }
                    if (i === 2) {
                        return { start: false, end }
                    }
                    if (i === 3) {
                        return { start: bars[300].time, end: bars[250].time } //起點晚於終點
                    }
                    if (i === 4) {
                        return { start: undefined, end } //欄位不存在
                    }
                    if (i === 5) {
                        return { start: null, end }
                    }
                    return { start: bars[182].time, end }
                },
                edit: (i, s) => {
                    if (i === 3) {
                        s.numTrade = 5 //起點晚於終點 ⇒ 窗內無進場(0)≠ 5
                        s.summary.numTrade = 5
                    }
                },
            })
            let m = await buildLedger({ libraryRoot: libZ, keyOhlc: 'SYN_1day', endTime: END1, barHours: 24, outDir: path.join(t.dir, 'ck_z'), log: quiet })
            //s00 ~ s02(空字串、0、false)⇒ 略過; s03(起點晚於終點)⇒ 核對、計為不符(ledger 0 對 file 5); s04、s05(未帶、null)⇒ 自第 0 根; s06、s07(帳本內之起點)⇒ 核對
            assert.deepEqual(m.check, { compared: 5, same: 4, diffs: [{ f: 's03.json', ledger: 0, file: 5 }], skipped: 3 })
            assert.deepEqual(m.check, expectCheck(Zl, 0, 700))
        })

        it('每根 4 小時:求解窗起點 = 帳本起點(第 0 根)者核對全數相符(同發布版);帳本起點早於求解窗起點(求解窗自第 1092 根起)者核對與獨立期望值相同,給 startTime = 求解窗起點者之 check 相同', async () => {
            //「4 小時、起點 = 第 0 根」之逐位不變另由 ① 之釘死案(含 ① 之二)涵蓋; 此處之 L4 之求解窗起於第 1092 根(帳本起點早於求解窗起點)
            let m = await b4(path.join(t.dir, 'ck4_A'))
            assert.deepEqual(m.check, expectCheck(L4, 0, 2736))
            assert.deepEqual(m.check, { compared: 12, same: 12, diffs: [] })
            let m2 = await b4(path.join(t.dir, 'ck4_B'), { startTime: L4.bars[1092].time })
            assert.deepEqual(m2.check, m.check)
            //求解窗自第 0 根起(同 K 線起點 = 求解窗起點之策略庫之形狀): 未給與給了第 0 根為起點之 check 皆全數相符
            let mP = await buildLedger({ libraryRoot: libP, keyOhlc: 'SYN_4hr', endTime: END4, barHours: 4, seriesDir: serP, startTime: P.bars[0].time, outDir: path.join(t.dir, 'ck4_P'), log: quiet })
            assert.deepEqual(mP.check, { compared: 10, same: 9, diffs: [{ f: 's03.json', ledger: 300, file: 301 }] })
        })
    })

    describe('①②③ 之命令列(g_build.mjs;settings.source.startTime)與評估', function () {
        //mkProj, 合成專案(settings.json 與挑選模組); source 覆寫設定之 source; extra: { periods(覆寫期間), eval(併入 eval) }
        let mkProj = (name, source = {}, extra = {}) => {
            let root = path.join(t.dir, `cli_${name}`)
            fs.mkdirSync(root, { recursive: true })
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
                source: { libraryRoot: lib1, keyOhlc: 'SYN_1day', barHours: 24, ...source },
                periods: extra.periods || { train: { start: '2020-07-01T00:00:00', end: '2021-03-01T00:00:00' }, backtest: { start: '2021-03-01T00:00:00', end: END1 }, holdoutFrom: '2021-12-15T00:00:00' },
                eval: { ledgerDir: './ledger/eval', warmupDays: 10, cadenceDays: 7, phases: [0], horizons: [7], nullDraws: 4, seed: 1, limits: { monthlyOrders: 400, peakHold: 50 }, ...(extra.eval || {}) },
                score: { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] },
                rsi: { root: './rsi' },
                records: {},
                dispatch: {},
            }), 'utf8')
            fs.writeFileSync(path.join(root, 'pick_all.mjs'), 'export default function pick(ctx) { return [0, 1, 2, 3, 4, 5] }\n', 'utf8')
            return root
        }
        let outDirOf = (root, sub = 'eval') => path.resolve(root, 'ledger', sub)
        //1.0.30 之起首列(逐字): 起點不回顯
        let headerOf = (root, endTime, train = false) => `建帳本: ${train ? '訓練期' : '評估(訓練期 + 回測期)'} 終點 ${endTime} → ${outDirOf(root, train ? 'train' : 'eval')}`
        let run = (root, cli, args = []) => {
            let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', cli), ...args], { cwd: root, env: { ...process.env, ARSI_ROOT: root }, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            return { status: r.status, out: `${r.stdout}\n${r.stderr}`, stdout: r.stdout }
        }
        let metaOf = (root, sub = 'eval') => JSON.parse(fs.readFileSync(path.join(root, 'ledger', sub, 'meta.json'), 'utf8'))

        it('未給(或 null):起首列與摘要行之鍵與 1.0.30 逐字相同、帳本之指紋與帳本鍵 = 釘死之 1.0.30 值(不再與自己比)、meta 無 startTime、無 WARN', () => {
            //R-EV-45 ①(命令列): 未給者之標準輸出(起首列、ohlc 列、摘要行之鍵序)與帳本逐位同 1.0.30; 資料 = ① 之釘死案之合成策略庫(每根 4 小時, 帳本終點 END4)
            let periods = { train: { start: '2020-07-01T00:00:00', end: '2021-03-01T00:00:00' }, backtest: { start: '2021-03-01T00:00:00', end: END4 }, holdoutFrom: '2021-05-01T00:00:00' }
            for (let [name, source] of [['none', {}], ['null', { startTime: null }]]) {
                let root = mkProj(`pin_${name}`, { libraryRoot: libP, keyOhlc: 'SYN_4hr', barHours: 4, seriesDir: serP, ...source }, { periods })
                let r = run(root, 'build.mjs')
                assert.equal(r.status, 0, `${name}: ${r.out.slice(0, 500)}`)
                let ls = r.stdout.split('\n')
                assert.equal(ls[0], headerOf(root, END4), `${name}: 起首列`)
                assert(ls.includes(`ohlc SYN_4hr: 2736 根, ${P.bars[0].time} ~ ${P.bars[2735].time}(endTime ${END4} 不含)`), `${name}: ${ls.slice(0, 4).join(' | ')}`)
                let line = JSON.parse(ls.find((x) => x.startsWith('{')))
                assert.deepEqual(Object.keys(line), ['key', 'endTime', 'nBars', 'nStrategies', 'nOrders', 'nUnsettled', 'check', 'seriesNames', 'buildSec'], `${name}: 摘要行之鍵序`)
                assert.equal(line.key, PIN.key)
                assert.deepEqual(line.check, { compared: 10, same: 9, diffs: [{ f: 's03.json', ledger: 300, file: 301 }] })
                assert.equal(ledgerDigestOf(outDirOf(root)), PIN.digest, `${name}: 帳本指紋`)
                assert(!/startTime|起點|WARN/.test(r.stdout.replace(/訓練期起點/g, '')), `${name}: ${r.stdout.slice(0, 500)}`)
            }
        })

        it('給了 startTime:起首列不回顯起點(同 1.0.30)、起點見於 ohlc 記錄列與摘要行;帳本自該根起(評估帳本與 --train 帳本皆然);起點 = 訓練期起點者無 WARN', () => {
            let T = '2020-07-01T00:00:00'
            let root = mkProj('start', { startTime: T })
            let r2 = run(root, 'build.mjs')
            assert.equal(r2.status, 0, r2.out.slice(0, 500))
            let m = metaOf(root)
            assert.deepEqual([m.time0, m.startTime, m.endTime, m.nBars], [T, T, END1, 700 - 182])
            let ls = r2.stdout.split('\n')
            assert.equal(ls[0], headerOf(root, END1), '起首列不回顯起點')
            assert(ls.includes(`ohlc SYN_1day: ${700 - 182} 根, ${T} ~ ${L1.bars[699].time}(startTime ${T} 含; endTime ${END1} 不含)`), ls.slice(0, 4).join(' | '))
            let line = JSON.parse(ls.find((x) => x.startsWith('{')))
            assert.deepEqual(Object.keys(line).slice(0, 3), ['key', 'endTime', 'startTime'])
            assert.equal(line.startTime, T)
            assert.deepEqual(line.check, { compared: 12, same: 12, diffs: [] })
            assert(!/WARN/.test(r2.stdout), '起點 = 訓練期起點 ⇒ 無 WARN')
            //--train: 終點 = 訓練期終點, 同樣自起點起
            let r3 = run(root, 'build.mjs', ['--train'])
            assert.equal(r3.status, 0, r3.out.slice(0, 500))
            assert.equal(r3.stdout.split('\n')[0], headerOf(root, '2021-03-01T00:00:00', true))
            let mt = metaOf(root, 'train')
            assert.deepEqual([mt.time0, mt.startTime, mt.endTime, mt.nBars], [T, T, '2021-03-01T00:00:00', 425 - 182])
        })

        it('帳本起點晚於訓練期起點 ⇒ 建置成功後印一行 WARN(離開碼仍 0;評估帳本與 --train 帳本皆然);起點 = 或早於訓練期起點、未給者不印', () => {
            //R-EV-45: 帳本未涵蓋訓練期起點 ⇒ 暖機與 ctx.meta.ntAll 自帳本起點起算; 只提示(以時刻比較; 寫法不同之案見下一案)
            let warn = (T) => `WARN 帳本起點 ${T} 晚於訓練期起點 2020-07-01T00:00:00:帳本未涵蓋訓練期起點,暖機與 ctx.meta.ntAll 自帳本起點起算`
            let late = '2020-07-02T00:00:00'
            let root = mkProj('warn_late', { startTime: late })
            for (let args of [[], ['--train']]) {
                let r = run(root, 'build.mjs', args)
                assert.equal(r.status, 0, r.out.slice(0, 500))
                let ls = r.stdout.split('\n')
                //(起點晚於全部求解窗起點者另有一致性核對全數略過之 WARN; 此處只數「帳本起點晚於訓練期起點」那一行)
                assert.equal(ls.filter((x) => x.startsWith('WARN 帳本起點')).length, 1, `${args.join(' ')}: ${r.stdout.slice(0, 500)}`)
                assert(ls.includes(warn(late)), `${args.join(' ')}: ${r.stdout.slice(0, 500)}`)
            }
            for (let [name, source] of [['eq', { startTime: '2020-07-01T00:00:00' }], ['early', { startTime: '2020-03-01T00:00:00' }], ['none', {}]]) {
                for (let args of [[], ['--train']]) {
                    let r = run(mkProj(`warn_${name}`, source), 'build.mjs', args)
                    assert.equal(r.status, 0, `${name} ${args.join(' ')}: ${r.out.slice(0, 500)}`)
                    assert(!/WARN 帳本起點/.test(r.stdout), `${name} ${args.join(' ')}: ${r.stdout.slice(0, 500)}`)
                }
            }
        })

        it('WARN 以時刻比較:訓練期起點寫法不同(空格分隔)而同一時刻或較晚者不印、較早者印;訓練期起點非字串(陣列、數字、物件)或無法解析者不印', () => {
            //R-EV-45: 以 Date.parse(`${x}Z`) 比較, 不是字串比較(空格分隔之寫法於字串比較下 'T' > ' ' 而誤報); 訓練期起點須為字串且可解析, 其餘不印(含 [] 與單元素陣列: 陣列轉字串後會被解析, 故須先判型別)
            let T0 = '2020-07-01T00:00:00'
            let per = (start) => ({ train: { start, end: '2021-03-01T00:00:00' }, backtest: { start: '2021-03-01T00:00:00', end: END1 }, holdoutFrom: '2021-12-15T00:00:00' })
            for (let [name, v, doWarn] of [
                ['same_space', '2020-07-01 00:00:00', false], //同一時刻、空格分隔
                ['later_space', '2020-07-01 12:00:00', false], //訓練期起點較晚
                ['earlier_space', '2020-06-30 12:00:00', true], //訓練期起點較早 ⇒ 印
                ['abc', 'abc', false],
                ['arr_empty', [], false],
                ['arr_one', ['2020-01-01T00:00:00'], false],
                ['num', 20200701, false],
                ['obj', {}, false]
            ]) {
                for (let args of [[], ['--train']]) {
                    let r = run(mkProj(`warnfmt_${name}`, { startTime: T0 }, { periods: per(v) }), 'build.mjs', args)
                    assert.equal(r.status, 0, `${name} ${args.join(' ')}: ${r.out.slice(0, 500)}`)
                    let ws = r.stdout.split('\n').filter((x) => x.startsWith('WARN 帳本起點'))
                    if (doWarn) {
                        assert.deepEqual(ws, [`WARN 帳本起點 ${T0} 晚於訓練期起點 ${v}:帳本未涵蓋訓練期起點,暖機與 ctx.meta.ntAll 自帳本起點起算`], `${name} ${args.join(' ')}`)
                    }
                    else {
                        assert.deepEqual(ws, [], `${name} ${args.join(' ')}: ${r.stdout.slice(0, 500)}`)
                    }
                }
            }
        })

        it('起點不合(非字串、不在 K 線上、不早於終點、無法解析、帶時區字尾、其後不滿 100 根)⇒ ERROR invalid source.startTime、離開碼 2、不寫出任何檔;起首列不回顯輸入', () => {
            let msg = (m) => `ERROR ${m.replace('invalid startTime', 'invalid source.startTime')}`
            for (let [name, v, want] of [['num', 20200701, MSG], ['off', '2020-07-01T05:00:00', MSG], ['end', END1, MSG], ['late', '2022-01-01T00:00:00', MSG], ['abc', 'abc', MSG], ['bool', true, MSG], ['z', '2020-07-01T00:00:00Z', MSG], ['few', L1.bars[700 - 99].time, MSG_FEW],
                //假值(空字串、0、false、空陣列、空物件)亦為「給了」而不合: 只有 undefined 與 null 為未給(不得以真假值判斷而靜默忽略)
                ['empty', '', MSG], ['zero', 0, MSG], ['false', false, MSG], ['arr', [], MSG], ['obj', {}, MSG]]) {
                let root = mkProj(`bad_${name}`, { startTime: v })
                let r = run(root, 'build.mjs')
                assert.equal(r.status, 2, `${name}: ${r.out.slice(0, 500)}`)
                assert(r.stdout.split('\n').includes(msg(want)), `${name}: ${r.out.slice(0, 500)}`)
                assert.equal(r.stdout.split('\n')[0], headerOf(root, END1), `${name}: 起首列同 1.0.30(不回顯輸入)`)
                assert.equal(fs.existsSync(path.join(root, 'ledger')), false, `${name}: 不寫出`)
            }
        })

        it('K 線不滿 100 根:給了起點者 ERROR invalid source.startTime: must leave at least 100 bars before endTime、離開碼 2;未給起點者維持 1.0.30 之行為(拋出「K 線過少」、離開碼不為 2)', () => {
            let periods = { train: { start: '2020-01-02T00:00:00', end: '2020-02-01T00:00:00' }, backtest: { start: '2020-02-01T00:00:00', end: L1.bars[50].time }, holdoutFrom: '2020-06-01T00:00:00' }
            let r1 = run(mkProj('few_start', { startTime: L1.bars[10].time }, { periods }), 'build.mjs')
            assert.equal(r1.status, 2, r1.out.slice(0, 500))
            assert(r1.stdout.split('\n').includes(`ERROR ${MSG_FEW.replace('invalid startTime', 'invalid source.startTime')}`), r1.out.slice(0, 500))
            let r0 = run(mkProj('few_none', {}, { periods }), 'build.mjs')
            assert.notEqual(r0.status, 0)
            assert.notEqual(r0.status, 2, '未給起點:不轉為離開碼 2(同 1.0.30)')
            assert(r0.out.includes(`K 線過少(50); endTime ${L1.bars[50].time}`), r0.out.slice(0, 500))
        })

        it('評估:以該帳本跑 g_eval.mjs ⇒ 第一個決策之時刻 = 起點 + 暖機日數(未給者 = 帳本第一根 + 暖機日數);結果檔之 period.time0 = 起點', () => {
            let first = (root) => {
                let fp = path.join(root, 'out.json')
                let r = run(root, 'eval.mjs', ['--pick', 'pick_all.mjs', '--mode', 'quick', '--period', 'train', '--out', fp])
                assert.equal(r.status, 0, r.out.slice(0, 600))
                return JSON.parse(fs.readFileSync(fp, 'utf8')).metrics.period
            }
            let r0 = mkProj('ev0')
            run(r0, 'build.mjs')
            let p0 = first(r0)
            assert.deepEqual([p0.time0, p0.firstDecision], ['2020-01-01T00:00:00', '2020-01-11T00:00:00'])
            let r1 = mkProj('ev1', { startTime: '2020-07-01T00:00:00' })
            assert.equal(run(r1, 'build.mjs').status, 0)
            let p1 = first(r1)
            assert.deepEqual([p1.time0, p1.firstDecision], ['2020-07-01T00:00:00', '2020-07-11T00:00:00'])
        })

        //⑧ 回測期旗標(g_backtest.mjs): 全期帳本(backtest.ledgerDir; 使用端以 buildLedger 自建)須與評估帳本同一個起點 —— 任一帳本給了 startTime 而兩帳本之 time0 不同 ⇒ 專屬 ERROR、離開碼 5(帳本不一致)
        //  合成: 評估帳本以 g_build.mjs 建(source.startTime 選配; 終點 END1)、全期帳本以 buildLedger 建(終點 2022-01-20); 挑選模組於第一個決策即拋 NT(離開碼 3 = 已通過帳本之核對、進入重放)
        let ENDF = '2022-01-20T00:00:00'
        let mkBt = async (name, { evalStart = null, fullStart = null, evalCfg = {} } = {}) => {
            let root = mkProj(`bt_${name}`, evalStart ? { startTime: evalStart } : {}, { eval: evalCfg })
            assert.equal(run(root, 'build.mjs').status, 0)
            let full = path.join(root, 'ledger', 'full')
            await buildLedger({ libraryRoot: lib1, keyOhlc: 'SYN_1day', endTime: ENDF, barHours: 24, outDir: full, log: quiet, ...(fullStart ? { startTime: fullStart } : {}) })
            let fpS = path.join(root, 'settings.json')
            let s = JSON.parse(fs.readFileSync(fpS, 'utf8'))
            s.backtest = { ledgerDir: full, resultDir: path.join(root, 'bt_out'), privateRoot: path.join(t.dir, `bt_${name}_private`), replicas: 1 }
            fs.writeFileSync(fpS, JSON.stringify(s), 'utf8')
            fs.writeFileSync(path.join(root, 'pick_nt.mjs'), 'export default function pick(ctx) { throw new Error("NT " + Array.from(ctx.meta.ntAll).join(",")) }\n', 'utf8')
            return root
        }
        let runBt = (root) => {
            let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'backtest.mjs'), '--pick', path.join(root, 'pick_nt.mjs'), '--name', 'x', '--dir', path.join(root, 'bt_out')], { cwd: root, env: { ...process.env, ARSI_ROOT: root, ARSI_HARNESS: '1' }, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            return { status: r.status, stdout: r.stdout, out: `${r.stdout}\n${r.stderr}` }
        }
        let startMsg = (tFull, tEval) => `ERROR 全期帳本與評估帳本之起點不同(全期帳本 time0 ${tFull}、評估帳本 time0 ${tEval}; 其中至少一份給了 startTime): 全期帳本須以與評估帳本同一個 startTime 建(可見範圍與暖機皆自起點起算); 請以同一 startTime 重建全期帳本`

        it('g_backtest.mjs:評估帳本給了起點而全期帳本未同起點 ⇒ 專屬 ERROR(兩個 time0)、離開碼 5、不寫結果;給 eval.trainFromStart 使訓練期進場數核對通過者亦被擋(可見範圍不一致)', async () => {
            for (let [name, evalCfg] of [['a', {}], ['b', { trainFromStart: true }]]) {
                let root = await mkBt(name, { evalStart: '2020-07-01T00:00:00', evalCfg })
                let r = runBt(root)
                assert.equal(r.status, 5, `${name}: ${r.out.slice(0, 600)}`)
                assert(r.stdout.split('\n').includes(startMsg('2020-01-01T00:00:00', '2020-07-01T00:00:00')), `${name}: ${r.out.slice(0, 600)}`)
                assert.equal(fs.existsSync(path.join(root, 'bt_out')), false, `${name}: 未寫結果`)
            }
        })

        it('g_backtest.mjs:全期帳本給了起點而評估帳本未給 ⇒ 同樣被擋(兩份之 time0 互換於訊息)', async () => {
            let root = await mkBt('g', { fullStart: '2020-07-01T00:00:00' })
            let r = runBt(root)
            assert.equal(r.status, 5, r.out.slice(0, 600))
            assert(r.stdout.split('\n').includes(startMsg('2020-07-01T00:00:00', '2020-01-01T00:00:00')), r.out.slice(0, 600))
        })

        it('g_backtest.mjs:兩帳本同一起點 ⇒ 通過核對(進入重放:挑選模組拋 NT、離開碼 3);評估帳本之 startTime = K 線第一根而全期帳本未給(time0 相同)⇒ 不擋;兩帳本皆未給 ⇒ 與改前相同(通過)', async () => {
            for (let [name, opt] of [['same', { evalStart: '2020-07-01T00:00:00', fullStart: '2020-07-01T00:00:00' }], ['first', { evalStart: '2020-01-01T00:00:00' }], ['none', {}]]) {
                let root = await mkBt(name, opt)
                let r = runBt(root)
                assert.equal(r.status, 3, `${name}: ${r.out.slice(0, 600)}`)
                let nt = /Error: NT ([0-9,]+)/.exec(r.out)
                assert(nt !== null && !/之起點不同/.test(r.out), `${name}: ${r.out.slice(0, 600)}`)
            }
        })
    })
})
