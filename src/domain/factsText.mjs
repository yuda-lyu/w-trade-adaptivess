import { evalCfgNumsOf } from '../eval/cfgNum.mjs'


//套件文字中之策略庫規模、期間與節奏之寫法(規則 R-REC-36): 任務書(./texts.mjs)與合約之參考版(../tools/initProject.mjs 之 renderContract)共用
//  一律由設定與帳本產生; 未給者用評估器之預設(決策間隔 7 日、新鮮度地平線 1 / 3 / 7 / 14 / 30 日、相位 7 個、虛無 64 抽、暖機 180 日);
//  數值類設定之取值與評估器同一函數(cfgNumOf: 數字字串轉為數值; 給了而無效即拋 invalid eval.<鍵>, 不退回預設)

/**
 * 策略隻數之寫法:1 萬隻以上「約 N 萬隻」(四捨五入至萬),未滿「約 N 隻」;不是正整數者回 null(略去隻數)
 *
 * @param {*} n 輸入策略隻數
 * @returns {String|null} 回傳寫法,不是正整數者回傳 null
 * @example
 * libSizeText(30000)
 * // => '約 3 萬隻'
 */
let libSizeText = (n) => {
    if (!(Number.isInteger(n) && n > 0)) {
        return null
    }
    return n >= 10000 ? `約 ${Math.round(n / 10000)} 萬隻` : `約 ${n} 隻`
}

/**
 * 期間長度之寫法:日數 ÷ 30.4375 四捨五入成月(「約 N 個月」),不滿 1 個月者「約 N 日」
 *
 * @param {String} start 輸入起點(無時區之時刻字串)
 * @param {String} end 輸入終點(無時區之時刻字串)
 * @returns {String} 回傳寫法
 * @example
 * periodLenText('2030-01-01T00:00:00', '2030-06-01T00:00:00')
 * // => '約 5 個月'
 */
let periodLenText = (start, end) => {
    let days = (Date.parse(`${end}Z`) - Date.parse(`${start}Z`)) / 86400000
    let mo = Math.round(days / 30.4375)
    return mo >= 1 ? `約 ${mo} 個月` : `約 ${Math.round(days)} 日`
}

/**
 * 決策間隔(日):settings.eval.cadenceDays 之值(cfgNumOf;與評估器同一取值:數字字串轉為數值),未給為評估器之預設 7;給了而不是正數者拋 invalid eval.cadenceDays(不退回預設)
 *
 * @param {Object} ev 輸入 settings.eval(可為 null)
 * @returns {Number} 回傳決策間隔之日數
 * @example
 * cadenceOf({ cadenceDays: 5 })
 * // => 5
 */
let cadenceOf = (ev) => evalCfgNumsOf(ev, 'eval').cadenceDays

/**
 * 虛無抽數:settings.eval.nullDraws 之值(cfgNumOf;數字字串轉為數值),未給為評估器之預設 64;給了而不是非負整數者拋 invalid eval.nullDraws
 *
 * @param {Object} ev 輸入 settings.eval(可為 null)
 * @returns {Number} 回傳虛無抽數
 * @example
 * nullDrawsOf({ nullDraws: '32' })
 * // => 32
 */
let nullDrawsOf = (ev) => evalCfgNumsOf(ev, 'eval').nullDraws

/**
 * 相位數:settings.eval.phases 為非空陣列者為其長度,否則為評估器之預設 7(0 ~ 6 日各一個起始相位)
 *
 * @param {Object} ev 輸入 settings.eval(可為 null)
 * @returns {Integer} 回傳相位數
 * @example
 * phaseCountOf({ phases: [0, 3] })
 * // => 2
 */
let phaseCountOf = (ev) => (ev && Array.isArray(ev.phases) && ev.phases.length > 0 ? ev.phases.length : 7)

/**
 * 相位數之寫法:1 ~ 10 為國字(七)、其餘為阿拉伯數字加空白(12 ),後接 tail(如「相位」「個相位」「個起始相位」)
 *
 * @param {Integer} n 輸入相位數
 * @param {String} tail 輸入接續之字
 * @returns {String} 回傳寫法
 * @example
 * phaseText(7, '相位')
 * // => '七相位'
 */
let phaseText = (n, tail) => (Number.isInteger(n) && n >= 1 && n <= 10 ? '一二三四五六七八九十'[n - 1] : `${n} `) + tail

/**
 * 虛無 p 於 draws 抽之下限:1 ÷ (1 + draws) 四捨五入至小數第 4 位(同評估器之 r4;64 抽為 0.0154)
 *
 * @param {Integer} draws 輸入虛無抽數
 * @returns {String} 回傳寫法
 * @example
 * nullFloorText(64)
 * // => '0.0154'
 */
let nullFloorText = (draws) => String(Math.round((1 / (1 + draws)) * 10000) / 10000)

/**
 * 新鮮度地平線(日):settings.eval.horizons,未給或為空陣列者為評估器之預設 [1, 3, 7, 14, 30]
 *
 * @param {Object} ev 輸入 settings.eval(可為 null)
 * @returns {Array} 回傳地平線之陣列
 * @example
 * horizonsOf({})
 * // => [1, 3, 7, 14, 30]
 */
let horizonsOf = (ev) => (ev && Array.isArray(ev.horizons) && ev.horizons.length ? ev.horizons : [1, 3, 7, 14, 30])

/**
 * 時刻字串之日期部分(非空字串者取前 10 字;其餘回 null)
 *
 * @param {*} t 輸入時刻字串
 * @returns {String|null} 回傳日期部分
 * @example
 * dateOf('2030-05-01T00:00:00')
 * // => '2030-05-01'
 */
let dateOf = (t) => (typeof t === 'string' && t ? t.slice(0, 10) : null)


export { libSizeText, periodLenText, cadenceOf, nullDrawsOf, phaseCountOf, phaseText, nullFloorText, horizonsOf, dateOf }
