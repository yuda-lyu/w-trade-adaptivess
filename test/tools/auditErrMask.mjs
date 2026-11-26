//盤點「錯誤訊息之輸出」是否經遮罩(R-RUN-8 ⑨; 排程第 655 項 ②; test/unit-errMaskSites.test.mjs 之守門): 以原始碼逐列辨認「含錯誤文字之取得(.message、.stack、String(err)、`${err}`)之輸出」,
//  已遮 = 該取得全在 errText( 或 errTextOf( 之括號內(遮罩函數只有 dispatchers.mjs 之 errTextOf 一處定義; errText 為 makeErrText 之包裝)
//  未遮者須列於呼叫端給之允許表(附理由), 否則為違規 —— 新增一處未遮之 err.message / err.stack 輸出即紅
//  只辨認原始碼之文字(不執行); 整列之註解(// 、/* 、* 起首)不計

//codeLinesOf, 去除整列之註解後之 [{ n: 行號, t: 該列 }]
export let codeLinesOf = (src) => String(src).split(/\r?\n/).map((t, i) => ({ n: i + 1, t })).filter(({ t }) => !/^\s*(\/\/|\/\*|\*)/.test(t))

//coveredRangesOf, 該列內各個 errText( / errTextOf( 呼叫之括號範圍 [起, 迄)(逐字元配對括號; 字串內之括號不特別處理 —— 本庫之寫法於這些呼叫內不含不成對之括號字元)
let coveredRangesOf = (t) => {
    let out = []
    let re = /\berrText(?:Of)?\(/g
    let m
    while ((m = re.exec(t)) !== null) {
        let depth = 1
        let i = m.index + m[0].length
        while (i < t.length && depth > 0) {
            if (t[i] === '(') {
                depth++
            }
            else if (t[i] === ')') {
                depth--
            }
            i++
        }
        out.push([m.index + m[0].length, depth === 0 ? i - 1 : t.length])
    }
    return out
}

//SITE_RE, 錯誤文字之取得: err.message、err.stack(堆疊之首列即訊息)、String(err)、`${err}`
//  已知之盲點(靜態辨認之限制): 解構取得之 message、err['message']、JSON.stringify(err)、跨多列之表達式、字串內含括號者; 由行為案(unit-errMaskSites 之命令列實跑)補
let SITE_RE = /\.(?:message|stack)\b|\bString\(err\)|\$\{err\}/g

//messageSitesOf, 含錯誤文字之取得(SITE_RE)之各列: [{ n, t, masked }]; masked = 該列之每一處皆在 errText( / errTextOf( 之括號內
export let messageSitesOf = (src) => {
    let out = []
    for (let { n, t } of codeLinesOf(src)) {
        let hits = [...t.matchAll(SITE_RE)].map((m) => m.index)
        if (hits.length === 0) {
            continue
        }
        let ranges = coveredRangesOf(t)
        out.push({ n, t: t.trim(), masked: hits.every((h) => ranges.some(([a, b]) => h >= a && h < b)) })
    }
    return out
}

//unmaskedOf, 未遮且不在允許表之列; allow: [{ has: 該列須含之字, why: 理由 }]
export let unmaskedOf = (src, allow = []) => messageSitesOf(src).filter((s) => !s.masked && !allow.some((a) => s.t.includes(a.has)))

//staleAllowOf, 允許表中沒有對應到任何一列者(原始碼改動後失效之項; 不得靜默留著)
export let staleAllowOf = (src, allow = []) => allow.filter((a) => !messageSitesOf(src).some((s) => !s.masked && s.t.includes(a.has)))
