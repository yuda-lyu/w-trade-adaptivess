import { getSettings, argNumOf, cliGuard } from '../cfg.mjs'
import { makeProjectOrExit, rankKeyOf, contentOf } from '../domain/domain.mjs'
import { rankCompareOf } from '../domain/rankCompare.mjs'

//命令列之旗標只認 --k <前幾名>(TOOL_FLAGS.rankCompare): 等號、未列、重複、無值、多餘之值一律拒收(離開碼 2; 於讀設定之前; 訊息固定、不帶輸入值)
cliGuard('rankCompare')

//量尺之主鍵改為挑選內容時對名次之影響(唯讀; 規則 R-REC-49 之估法): 只印、不寫任何檔, 不評估; 供主控於設定 settings.rsi.rankBy 之前讀出兩種次序之差
//  node tools/rankCompare.mjs [--k <前幾名; 預設 10>]
//  候選 = 樹上已執行、可信(trusted)、未被否決、「有內容」(搜尋地圖之量尺與主鍵之同一定義; P.hasContent)且有挑選內容之值之成品; 量見 src/domain/rankCompare.mjs
//    另列「有挑選內容之值而不符有內容」者之個數(不計入候選; 主鍵視同無其值; 規則 R-REC-49 ⑤)
//  另列補位之底: 以「現行之排序鍵」與「挑選內容為主鍵」各組一次領域(只讀樹), 比較各可選臂之載體之起點(皆排除別名與側別曝險且未放行者)
let st = getSettings()
//--k 給了而不是正整數 ⇒ 已於上之 cliGuard 拒收(CLI_VALUES.rankCompare; 排程第 607 項; 原: 小數、0、非數字靜默取 10); 此處取檢查合格之轉換值(K4); 未給 = 10
let k = argNumOf('k', 'posInt', 10)
let mk = (rankBy) => {
    let s = { ...st, rsi: { ...st.rsi, rankBy } }
    let p = makeProjectOrExit(s, {})
    p.rsi.init()
    return p
}
let Pk = mk(undefined)
let Pc = mk('content')
let nodes = Pk.rsi.store.listIndex().filter((r) => r.status === 'executed').map((r) => Pk.rsi.store.getNode(r.id)).filter(Boolean)
let base = nodes.filter((n) => n.score && Number.isFinite(n.score.S) && !(n.score.flags && n.score.flags.vetoed) && n.evidence && n.evidence.trust === 'trusted' && contentOf(n) !== null && rankKeyOf(n) !== null)
let rows = base
    .filter((n) => Pk.hasContent(n))
    .map((n) => ({ id: n.id, key: rankKeyOf(n), content: contentOf(n).v, exposure: Pk.exposureOf(n).hit }))
let nNotContent = base.length - rows.length
let r = rankCompareOf(rows, { k })
let f2 = (v) => (v === null ? '—' : v.toFixed(2))
let s8 = (id) => (id ? id.slice(0, 8) : '—')
console.log(`量尺之主鍵:現行 = 排序鍵;試算 = 挑選內容(次鍵 = 排序鍵)(唯讀;不改任何檔)`)
console.log(`候選(可信、未被否決、有內容且有挑選內容之值)${r.n} 個;另有挑選內容之值而不符「有內容」者 ${nNotContent} 個(不計入;主鍵視同無其值)`)
console.log(`第一名:排序鍵 ${s8(r.firstKey)} / 挑選內容 ${s8(r.firstContent)}(${r.sameFirst ? '相同' : '不同'})`)
console.log(`兩種次序之相關:Spearman ρ ${f2(r.spearman)}、Kendall τ-b ${f2(r.kendall)}`)
console.log(`前 ${r.k} 名之交集 ${r.overlap} 個;其中側別曝險者:排序鍵之前 ${r.k} 名 ${r.exposureKey} 個、挑選內容之前 ${r.k} 名 ${r.exposureContent} 個`)
let ck = Pk.domain.carriers()
let cc = Pc.domain.carriers()
let arms = [...new Set([...Object.keys(ck), ...Object.keys(cc)])].sort()
let diff = arms.filter((a) => (ck[a] ? ck[a].base : null) !== (cc[a] ? cc[a].base : null))
console.log(`補位之底(各可選臂之載體之起點;${arms.length} 個載體):不同者 ${diff.length} 個${diff.length ? `(${diff.map((a) => `${a}:${s8(ck[a] ? ck[a].base : null)} → ${s8(cc[a] ? cc[a].base : null)}`).join(';')})` : ''}`)
