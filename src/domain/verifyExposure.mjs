import isenum from 'wsemi/src/isenum.mjs'
import { fixedSideOf, shortShareOf, sideFlowIssue, extSurfaceOf } from './verify.mjs'


//側別曝險之判定(規則 R-REC-48; 純函數): 交付版之優勢可能來自側別之曝險(評估期之行情方向經由選集之側別寫進模組)而不是挑選內容者
//  ⇒ 不作為補位之底與方向之起點(主控可經 tools/exposure.mjs 逐案放行); 只標示、不否決: 不改 S、階梯、否決、可信度、排序鍵
//  獨立成檔(檔名以 verify 起首): 節點之禁區字樣涵蓋 src/domain/verify*(同 verifyEvalHints.mjs), 判定之組合與門檻不被節點讀到而刻意規避
//  記號(皆由樹上之值重算, 不剖析迴圈檢查之字串):
//    fs(固定側別)= 訓練期與回測期之選集之做多比例皆偏一側(fixedSideOf; 與迴圈檢查之「固定側別」同一式)
//    sf(下單流量偏一側)= sideFlowIssue(回測期之做空單比例, 訓練期之做空單比例, settings.score.sideFlow)成立(與迴圈檢查之「下單流量偏一側」同一式)
//    fl(時機旗標)= 擴充診斷之提示(metrics.ext.<名>.flag)中, 名在 cfg.flags 之內者(診斷之算法在共用工具區, 套件只認其名)
//    P(席次之側別隨期改變)= |訓練期之做多比例 − 回測期之做多比例| ≥ cfg.minShift(兩者皆為數值; 差以 1e-9 取整後比較 ⇒ 恰為門檻者成立)
//  曝險 = fs ∨ (P ∧ (sf ∨ fl)); 訓練期之診斷(raw.train)缺者 fs、sf、P 皆不成立 ⇒ 不判為曝險
//  兩側席次固定之成品(每個決策恰 a 席做多、b 席做空)兩期之做多比例皆為 a ÷ (a + b) ⇒ P 不成立; 0.1 ≤ a ÷ (a + b) ≤ 0.9 者 fs 亦不成立 ⇒ 不論 sf 與 fl 皆不判為曝險
//  放行(tools/exposure.mjs): 樹之 evidence.exposureRelease 為物件且其 selHash = 正本之選集指紋 ⇒ released(仍標示; 不生「不作為底與起點」之效果); 選集指紋改變(重做、reverify)者放行自動失效
/**
 * 側別曝險之判定之預設設定(settings.rsi.exposure 未給或不合時所用):flags = 採計之擴充診斷之名,minShift = 席次之做多比例於兩期之差之門檻
 *
 * @type {Object}
 */
let EXPOSURE_DEFAULT = Object.freeze({ flags: Object.freeze(['fixedState', 'placeboTiming']), minShift: 0.1 })

/**
 * 側別曝險之判定之設定(settings.rsi.exposure 之解讀;無效即用預設、不拋錯)
 *
 * false 回 null(關閉);物件之 flags 須為非空字串之陣列(可為空陣列 = 不採計時機旗標)、minShift 須為 (0, 1] 之數值(數字或其數字字串,依 wsemi isenum 判定、轉為數值後使用;
 * 跨套件規格〈輸入參數之檢測機制〉K4、K7),不合之鍵(布林、NaN、±Infinity、空字串、非數字字串、範圍外)用預設;其餘(未給、非物件)回預設。
 *
 * @param {*} v 輸入 settings.rsi.exposure 之值
 * @returns {Object|null} 回傳 { flags, minShift } 或 null(關閉)
 * @example
 * let c = exposureCfgOf({ minShift: 0.2 })
 * // => { flags: ['fixedState', 'placeboTiming'], minShift: 0.2 }
 */
let exposureCfgOf = (v) => {
    if (v === false) {
        return null
    }
    let o = v && typeof v === 'object' && !Array.isArray(v) ? v : {}
    let flags = Array.isArray(o.flags) && o.flags.every((s) => typeof s === 'string' && s.trim() !== '') ? o.flags.slice() : EXPOSURE_DEFAULT.flags.slice()
    let minShift = isenum(o.minShift, { gt: 0, max: 1 }) ? Number(o.minShift) : EXPOSURE_DEFAULT.minShift
    return { flags, minShift }
}

/**
 * 節點是否為側別曝險之成品(純函數;規則 R-REC-48)
 *
 * 曝險 = 固定側別 ∨(席次之側別隨期改變 ∧(下單流量偏一側 ∨ 時機旗標));cfg 為 null(關閉)或節點無 metrics 者回不命中。why 為定性之理由(不含門檻之值;看板與迴圈檢查所用)。
 *
 * @param {Object} n 輸入樹上之節點(讀 raw.metrics、raw.train、raw.selHash、evidence.exposureRelease)
 * @param {Object|null} cfg 輸入 exposureCfgOf 之結果
 * @param {Object} [sideFlowCfg=null] 輸入 settings.score.sideFlow(下單流量偏一側之基準之覆寫)
 * @returns {Object} 回傳 { hit, released, blocked, fs, sf, shift, fl, why }:blocked = hit 且未放行(不作為補位之底與方向之起點者)
 * @example
 * let e = exposureOf({ raw: { metrics: { sel: { longRatio: 0.95, sizeMax: 5 } }, train: { longRatio: 0.97 } } }, exposureCfgOf())
 * // => e.hit === true(固定側別)
 */
let exposureOf = (n, cfg, sideFlowCfg = null) => {
    let none = { hit: false, released: false, blocked: false, fs: false, sf: false, shift: false, fl: [], why: '' }
    let raw = n && n.raw && typeof n.raw === 'object' ? n.raw : null
    let m = raw && raw.metrics && typeof raw.metrics === 'object' ? raw.metrics : null
    if (!cfg || !m) {
        return none
    }
    let tr = raw.train && typeof raw.train === 'object' ? raw.train : null
    let a = tr && typeof tr.longRatio === 'number' && Number.isFinite(tr.longRatio) ? tr.longRatio : null
    let b = m.sel && typeof m.sel.longRatio === 'number' && Number.isFinite(m.sel.longRatio) ? m.sel.longRatio : null
    let both = a !== null && b !== null
    let fs = both && fixedSideOf(a, b, m.sel.sizeMax)
    let shift = both && Math.round(Math.abs(a - b) * 1e9) / 1e9 >= cfg.minShift
    let sf = !!tr && sideFlowIssue(shortShareOf(m), tr.shortShare, sideFlowCfg) !== null
    let fl = extSurfaceOf(m).flags.filter((f) => cfg.flags.includes(f.name)).map((f) => f.name)
    let hit = fs || (shift && (sf || fl.length > 0))
    if (!hit) {
        return { ...none, fs, sf, shift, fl }
    }
    let rel = n.evidence && n.evidence.exposureRelease
    let released = !!rel && typeof rel === 'object' && typeof rel.selHash === 'string' && rel.selHash !== '' && rel.selHash === raw.selHash
    let why = [
        fs ? '固定側別' : null,
        !fs && shift && sf ? '席次之側別隨期改變、下單流量偏一側' : null,
        !fs && shift && fl.length ? `席次之側別隨期改變、擴充診斷 ${fl.join('、')} 之提示` : null,
    ].filter(Boolean).join(';')
    return { hit, released, blocked: !released, fs, sf, shift, fl, why }
}

let EXPOSURE_HEAD = '提示(側別曝險): '
let isExposureHint = (s) => String(s).startsWith(EXPOSURE_HEAD)
/**
 * 迴圈檢查之「提示(側別曝險)」一條(純函數):命中且未放行者回字串,其餘回 null
 *
 * @param {Object} e 輸入 exposureOf 之結果
 * @returns {String|null} 回傳提示字串或 null
 * @example
 * let s = exposureHintOf({ hit: true, released: false, blocked: true, why: '固定側別' })
 */
let exposureHintOf = (e) => (e && e.blocked ? `${EXPOSURE_HEAD}交付版之優勢可能來自側別之曝險(${e.why})⇒ 不作為補位之底與方向之起點(主控可逐案放行;不否決,由審計判定)` : null)


export { EXPOSURE_DEFAULT, exposureCfgOf, exposureOf, EXPOSURE_HEAD, isExposureHint, exposureHintOf }
