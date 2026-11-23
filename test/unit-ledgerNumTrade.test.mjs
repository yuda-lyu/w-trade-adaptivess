import assert from 'assert'
import path from 'path'
import { buildLedger } from '../src/eval/ledgerBuild.mjs'
import { makeTmp } from './tools/synthLedger.mjs'
import { writeSynthLib, readCol } from './tools/synthLib.mjs'


//帳本之一致性核對(meta.check)之進場數之來源(排程第 564 項; Gitea #194 §6 第 2 點; R-EV-45 之修訂): 頂層 numTrade(數字)為先; 頂層未帶(undefined 或 null)者以 summary.numTrade(數字)為後備; 兩者皆無者不核對(同改前)
//  規格之句 ⇒ 案: 「無頂層 numTrade 之策略檔以 summary.numTrade 為後備」= 各形之策略(頂層與 summary 之有無、型別、相符與否)之 meta.check(compared、same、diffs、skipped)與獨立重算之期望相同;
//    「兩者皆無則維持現行處置」= 不計入 compared、不計入 skipped; 「meta.check.compared 隨之增加」= 修前 3 → 現 6
//  修前(1.0.47): 只認頂層之數字 ⇒ 無頂層 numTrade 者整隻不核對(提出端實測某 4 小時策略庫 400 隻中 311 隻屬此形)
let quiet = () => {}
let END1 = '2021-12-01T00:00:00' //每根 1 日之帳本終點(第 700 根)

describe('一致性核對之進場數之來源: 頂層 numTrade 為先、summary.numTrade 為後備(R-EV-45)', function () {
    this.timeout(180000)
    let t
    let lib
    let L
    before(() => {
        t = makeTmp('ledgerNumTrade')
        let edits = {
            1: (s) => {
                delete s.numTrade //頂層缺、summary 相符 ⇒ 後備核對(相符)
            },
            2: (s) => {
                delete s.numTrade
                s.summary.numTrade += 1 //頂層缺、summary 不符 ⇒ 後備核對(不符; diffs.file 為 summary 之值)
            },
            3: (s) => {
                delete s.numTrade
                delete s.summary.numTrade //兩者皆無 ⇒ 不核對
            },
            4: (s) => {
                s.numTrade = null //頂層為 null(視同未帶)、summary 相符 ⇒ 後備核對(相符)
            },
            5: (s) => {
                s.numTrade = '5' //頂層已帶而不是數字 ⇒ 不核對(不以 summary 後備; 同改前)
            },
            6: (s) => {
                delete s.numTrade
                s.summary.numTrade = '5' //頂層缺、summary 不是數字 ⇒ 不核對
            },
            7: (s) => {
                s.summary.numTrade += 7 //頂層相符、summary 相異 ⇒ 頂層為先(相符)
            },
            8: (s) => {
                delete s.numTrade
                s.summary.numTrade = null //頂層缺、summary 為 null ⇒ 不核對
            },
            9: (s) => {
                s.numTrade += 1 //頂層不符、summary 相符 ⇒ 頂層為先(不符; diffs.file 為頂層之值)
            },
            10: (s) => {
                delete s.numTrade
                delete s.summary.timeOhlcEnd //頂層缺、summary 相符而無終點欄 ⇒ 不核對(終點不在)
            },
            11: (s) => {
                delete s.numTrade
                s.summary.timeOhlcStart = '2019-01-01T00:00:00' //頂層缺、summary 相符而起點不在帳本之棒上 ⇒ 略過(skipped)
            },
        }
        lib = path.join(t.dir, 'lib')
        L = writeSynthLib(lib, {
            key: 'SYN_1day',
            barHours: 24,
            nBars: 760,
            window: { start: 182, end: 425 },
            edit: (i, s) => {
                if (edits[i]) {
                    edits[i](s)
                }
            }
        })
        //對照: 未改之策略庫(帳本由「對照」案以其路徑建出)
        writeSynthLib(path.join(t.dir, 'libC'), { key: 'SYN_1day', barHours: 24, nBars: 760, window: { start: 182, end: 425 } })
    })
    after(() => t.cleanup())
    let build = (dir, lb = lib) => buildLedger({ libraryRoot: lb, keyOhlc: 'SYN_1day', endTime: END1, barHours: 24, outDir: dir, log: quiet })

    //oracle: 同窗(求解窗之起訖)之進場數由本檔獨立重算(synthLib 之 entries; 不經 buildLedger)
    let cntOf = (i) => {
        let { s, entries } = L.strategies[i]
        let iS = L.bars.findIndex((b) => b.time === (s.summary.timeOhlcStart === undefined ? L.bars[182].time : s.summary.timeOhlcStart))
        let iE = L.bars.findIndex((b) => b.time === L.bars[425].time)
        return entries.filter((x) => x >= iS && x <= iE).length
    }

    it('各形之策略檔之核對結果 = 獨立重算之期望: compared 6(0、1、2、4、7、9)、same 4、diffs 2 筆(第 2 隻 file = summary 之值、第 9 隻 file = 頂層之值)、skipped 1(第 11 隻); 其餘(3、5、6、8、10)不核對', async () => {
        let m = await build(path.join(t.dir, 'out'))
        //期望之 diffs(依檔序; file 為「所採用之進場數」: 頂層為先, 頂層未帶者 summary)
        let want = {
            compared: 6,
            same: 4,
            diffs: [{ f: 's02.json', ledger: cntOf(2), file: cntOf(2) + 1 }, { f: 's09.json', ledger: cntOf(9), file: cntOf(9) + 1 }],
            skipped: 1,
        }
        assert.deepEqual(m.check, want)
        //鑑別前提: 各形確如設計(第 2、9 隻之帳本計數 ≠ 其檔內值; 第 7 隻之 summary 與頂層相異)
        assert.equal(L.strategies[2].s.summary.numTrade, cntOf(2) + 1)
        assert.equal(L.strategies[9].s.numTrade, cntOf(9) + 1)
        assert.notEqual(L.strategies[7].s.summary.numTrade, L.strategies[7].s.numTrade)
        assert.equal(L.strategies[1].s.summary.numTrade, cntOf(1))
        assert(new Set([0, 1, 2, 4, 7, 9].map(cntOf)).size >= 4, '各隻之進場數互異(錯位可被看出)')
    })

    it('對照(未改之策略庫): 12 隻皆核對且相符(compared 12、same 12、無 diffs、無 skipped); 帳本之鍵與訂單數與改過之庫相同(只有 meta.check 與 fitNt 欄隨檔內之 numTrade 而異)', async () => {
        let mc = await build(path.join(t.dir, 'outC'), path.join(t.dir, 'libC'))
        assert.deepEqual(mc.check, { compared: 12, same: 12, diffs: [] })
        let m = await build(path.join(t.dir, 'out2'))
        assert.equal(m.key, mc.key, '帳本鍵不受影響')
        assert.equal(m.nOrders, mc.nOrders)
        //已知之邊界(本項只改一致性核對): fitNt 欄仍只取頂層之 numTrade(頂層缺者為 0; 與一致性核對之後備不同源 —— 見 sgud 之已知限制)
        let fit = Array.from(readCol(path.join(t.dir, 'out2'), 'fitNt.i32', Int32Array))
        for (let i of [1, 2, 3, 6, 8, 10, 11]) {
            assert.equal(fit[i], 0, `第 ${i} 隻頂層缺 ⇒ fitNt 為 0`)
        }
        assert.equal(fit[0], L.strategies[0].s.numTrade)
    })

    it('記錄(log)之計數: 「一致性 same/compared」取新之計數(6 之中 4); 全數以 summary 為來源者(頂層全缺之 4 小時策略庫之形)compared 為策略數', async () => {
        let logs = []
        await buildLedger({ libraryRoot: lib, keyOhlc: 'SYN_1day', endTime: END1, barHours: 24, outDir: path.join(t.dir, 'out3'), log: (s) => logs.push(s) })
        assert(logs.some((l) => /一致性 4\/6/.test(l)), logs.slice(-3).join('|'))
        //頂層全缺(summary 俱全)之庫: 全數以後備核對
        let libS = path.join(t.dir, 'libS')
        let S = writeSynthLib(libS, {
            key: 'SYN_1day',
            barHours: 24,
            nBars: 760,
            window: { start: 182, end: 425 },
            edit: (i, s) => {
                delete s.numTrade
            }
        })
        let ms = await buildLedger({ libraryRoot: libS, keyOhlc: 'SYN_1day', endTime: END1, barHours: 24, outDir: path.join(t.dir, 'outS'), log: quiet })
        assert.deepEqual(ms.check, { compared: 12, same: 12, diffs: [] })
        assert.equal(S.strategies.length, 12)
    })
})
