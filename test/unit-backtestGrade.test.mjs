import assert from 'assert'
import { gradeOf, gradeRank, gradeVetoed, gradeLabel, GRADES, pUpper } from '../src/domain/backtestGrade.mjs'
import { backtestCfg } from '../src/domain/backtestCfg.mjs'


//回測期旗標之分級(src/domain/backtestGrade.mjs 檔頭之定義): 每條斷言對應檔頭之一句
describe('backtestGrade:回測期旗標之分級', function () {
    //各段 z 皆 2 ⇒ 合併 z = 4 ÷ √2 ≈ 2.83(單側 p ≈ 0.002)
    let base = { repsOk: [false, false, false], nOrders: 100, segZ: [2, 2], halves: [3, 2], repsAbove: [true, true, true] }

    it('標準常態之上尾機率', () => {
        assert(Math.abs(pUpper(0) - 0.5) < 1e-6)
        assert(Math.abs(pUpper(1.6449) - 0.05) < 1e-4)
        assert(Math.abs(pUpper(-1.6449) - 0.95) < 1e-4)
        assert(Math.abs(pUpper(2.3263) - 0.01) < 1e-4)
    })

    it('pass:各複製版皆達判準(不看其他輸入)', () => {
        //檔頭: pass 各複製版(換亂數種子)之七相位等效年化皆達判準
        assert.equal(gradeOf({ ...base, repsOk: [true, true, true] }), 'pass')
        assert.equal(gradeOf({ repsOk: [true], nOrders: 0, segZ: [], halves: [], repsAbove: [] }), 'pass')
        //有一個複製版未達即不是 pass; 無複製版資料不得判 pass
        assert.notEqual(gradeOf({ ...base, repsOk: [true, false, true] }), 'pass')
        assert.notEqual(gradeOf({ ...base, repsOk: [] }), 'pass')
    })

    it('above:各段合併後顯著高於參照、各段之超額皆為正、各複製版皆高於參照之平均', () => {
        assert.equal(gradeOf(base), 'above')
        //合併 z = 2.4 ÷ √2 ≈ 1.70(p ≈ 0.045)仍算; 2.2 ÷ √2 ≈ 1.56(p ≈ 0.06)不算
        assert.equal(gradeOf({ ...base, segZ: [1.2, 1.2] }), 'above')
        assert.equal(gradeOf({ ...base, segZ: [1.1, 1.1] }), 'level')
    })

    it('mixed:合併後顯著但分段或複製版不一致;或某一段單獨即明顯較高而合併後不顯著', () => {
        assert.equal(gradeOf({ ...base, segZ: [6, -1], halves: [48, -5] }), 'mixed', '合併顯著、分段超額不同號')
        assert.equal(gradeOf({ ...base, repsAbove: [true, false, true] }), 'mixed', '合併顯著、有一個亂數種子未高於參照')
        assert.equal(gradeOf({ ...base, halves: [0, 5] }), 'mixed', '超額為 0 不算正')
        //只在部分期間成立: 前段明顯較高、後段明顯較低, 合併後不顯著(合併 z ≈ 1.29)
        assert.equal(gradeOf({ ...base, segZ: [5.9, -4.07], halves: [48, -27] }), 'mixed')
        //單一分段只是普通顯著(z 1.97, p ≈ 0.024 > pStrong)而另一段為負 ⇒ 不算 mixed(兩段各看一次, 偶然過 0.05 並不少見)
        assert.equal(gradeOf({ ...base, segZ: [1.97, -0.87], halves: [16, -5] }), 'level')
    })

    it('level:與參照無顯著差異;回測期內沒有下單者亦為 level(不因「不下單勝過虧損之隨機挑」而得高等級)', () => {
        assert.equal(gradeOf({ ...base, segZ: [0.6, 0.6] }), 'level')
        assert.equal(gradeOf({ ...base, segZ: [-0.5, 0.2] }), 'level')
        assert.equal(gradeOf({ ...base, nOrders: 0 }), 'level')
        assert.equal(gradeOf({ ...base, segZ: [], p: null }), 'level')
        assert.equal(gradeOf({ ...base, segZ: [NaN], p: NaN }), 'level')
        assert.equal(gradeOf(), 'level')
    })

    it('below:各段合併後顯著低於參照', () => {
        assert.equal(gradeOf({ ...base, segZ: [-2.5, -3.7], halves: [-8, -27] }), 'below')
        assert.equal(gradeOf({ ...base, segZ: [-1.2, -1.2], halves: [-1, -1] }), 'below')
        assert.equal(gradeOf({ ...base, segZ: [-1.1, -1.1], halves: [-1, -1] }), 'level')
    })

    it('無分段資料時退回全段之單側 p', () => {
        assert.equal(gradeOf({ ...base, segZ: [], p: 0.0154 }), 'above')
        assert.equal(gradeOf({ ...base, segZ: [], p: 0.3 }), 'level')
        assert.equal(gradeOf({ ...base, segZ: [], p: 1 }), 'below')
    })

    it('門檻可由設定給定', () => {
        assert.equal(gradeOf({ ...base, segZ: [1.1, 1.1] }, { pAbove: 0.1, pBelow: 0.9 }), 'above')
        assert.equal(gradeOf({ ...base, segZ: [1.97, -0.87], halves: [16, -5] }, { pStrong: 0.05 }), 'mixed')
    })

    it('等級之序、否決與說明:below < level < mixed < above < pass;level / below / 舊制 fail 否決;說明不含數字', () => {
        assert.deepEqual(GRADES, ['below', 'level', 'mixed', 'above', 'pass'])
        assert.deepEqual(GRADES.map(gradeRank), [0, 1, 2, 3, 4])
        assert.equal(gradeRank('fail'), gradeRank('level'), '舊制之 fail 視同 level')
        assert.equal(gradeRank(null), -1)
        assert.deepEqual(['pass', 'above', 'mixed', 'level', 'below', 'fail'].map(gradeVetoed), [false, false, false, true, true, true])
        for (let g of [...GRADES, 'fail']) {
            assert(gradeLabel(g).startsWith(g), g)
            assert(!/\d/.test(gradeLabel(g)), `說明不得含數字: ${gradeLabel(g)}`)
        }
    })

    it('設定之預設:分級啟用、參照固定做多比例、合併門檻 0.05 / 0.95、單段明顯門檻 0.01、回測期分 2 段;enabled false 即回到二元旗標', () => {
        //backtestCfg 檔頭: grade 分級旗標(預設啟用); matchSides 預設 true
        assert.deepEqual(backtestCfg({}).grade, { enabled: true, pAbove: 0.05, pBelow: 0.95, pStrong: 0.01, splits: 2, matchSides: true })
        assert.equal(backtestCfg({ backtest: { grade: { enabled: false } } }).grade.enabled, false)
        assert.equal(backtestCfg({ backtest: { grade: { splits: 3, matchSides: false } } }).grade.splits, 3)
        assert.equal(backtestCfg({ backtest: { grade: { matchSides: false } } }).grade.matchSides, false)
    })
})
