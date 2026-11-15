// 產生臂目錄之基底 arms/base.json(74 臂: 自適應挑選之可探索方向; 專案根之預設基底, 專案可自行改寫本檔之定義後重產, 或直接以治理擴充)
//  每個臂只定義「機制之中性描述」與部分建議格點; 不含任何狀態、判定與數字結論(由使用專案之 rsi 由零探索)
//  全部臂之狀態為 proposed(J 層為 blocked: 僅列名, 預設不開); selectable = 可派給節點 agent 作為主軸之臂(A ~ G 層之可實作者)
//  生效之目錄 = 基底 + 狀態根之擴充(rsi/governance/extensions.json; 引擎之治理: 節點與做夢提、主控以 tools/armDecide.mjs 審; 規則 R-ARM-2):
//    由迴圈於組裝時合成(src/domain/domain.mjs), 重產看板時另寫 arms/catalog.json 供 agent 閱讀; 三檔皆不手改
//  用法: node tools/buildCatalog.mjs
import fs from 'fs'
import path from 'path'
import { P } from '../cfg.mjs'
import { mkArm } from '../domain/armCatalog.mjs'

let layers = {
    A: '資格層:誰能進候選池',
    B: '排序鍵層:池內怎麼排',
    C: '結構分群層:依行為結構把策略分群',
    D: '選集層:分群 / 排序後怎麼取',
    E: '執行層:選集之訊號哪些真的下單(accept)',
    F: '條件層:依市況或自身狀態切換',
    G: '組合層:多個規則怎麼合成',
    H: '搜尋與生成(rsi 迴圈自身之臂; 不派給節點)',
    I: '評估與對照(量尺; 不派給節點)',
    J: '封鎖(僅列名; 本專案不開)',
}

//[id, 名稱, 機制說明, 可選, 格點]
let T = [
    ['A01_nt', '交易數資格(靜態)', '以策略於整段訓練期之進場數(ctx.meta.ntAll)設上限或下限, 作為進候選池之資格。屬靜態之樣本內屬性。', true, { ntMax: [50, 100, 150, 200, 300, 500] }],
    ['A02_ntPit', '交易數資格(走勢前向)', '以決策日以前之累計進場數(ctx.stat(0).entries)或近 N 日進場數設上限、下限或區間。', true, null],
    ['A03_midHighFreq', '中高頻資格(走勢前向)', '只留決策日以前累計進場數達某下限者(例如 ≥ 100), 使候選有足夠之歷史單數可供統計。', true, null],
    ['A04_act', '近期活躍度門檻', '以近 N 日(例如 90 日)之進場數低於或高於門檻 θ 作為資格(近期安靜者 / 近期活躍者)。', true, { theta: [10, 20, 70, 80, 90, 100, 120, 150], windowDays: [90] }],
    ['A05_nKeys', '因子數資格', '依策略條件之因子個數(ctx.meta.nKeys)設下限或上限。', true, { nKeys: [2, 3, 4, 5] }],
    ['A06_scarce', '稀缺 / 常見因子資格', '以全庫各因子(或因子家族)之出現頻率定義稀缺因子, 依策略所含稀缺因子數設資格, 或提高含稀缺因子者被選中之機率。', true, { scarceCount: [1, 2, 3, 4] }],
    ['A07_modePure', '方向與純度資格', '依策略方向(做多 / 做空)分池或只取單邊; 或依策略之因子是否全屬同一時間尺度(純短週期 / 純長週期)設資格。', true, null],
    ['A08_win', '統計回看窗長', '建立資格、排序或結構時所用之歷史窗長(例如 365 / 550 / 1100 日); 窗長本身即為可調之臂。', true, { windowDays: [365, 550, 1100] }],
    ['A09_tpSl', '止盈止損幾何資格', '依策略之止盈 tp、止損 sl 或其比值(賠率)設資格。', true, null],
    ['A10_behaviorPre', '行為屬性資格', '依策略之行為特徵設資格: 各種市況下皆有交易、進場時點之獨特性(與他策略少重疊)、條件間之綁定程度、因子觸發之時機等。', true, null],
    ['A11_plateau', '參數鄰域平原度', '同一因子組合而門檻或 tp / sl 不同之鄰居策略, 其走勢前向績效是否一致; 以鄰域平穩者為資格。', true, null],
    ['A12_universe', '宇集上游規則', '候選宇集之建立規則(去重口徑、同組合取最佳變體等)。屬策略庫上游, 本專案不由節點處理。', false, null],
    ['B13_staticKey', '靜態績效鍵', '以策略求解時之樣本內績效排序。評估器不提供樣本內績效欄, 故不可選。', false, null],
    ['B14_pitKey', '走勢前向排序鍵', '以決策日以前之績效統計為排序鍵(近窗之每單平均損益、損益和、勝率、交易數、報酬對回撤比等; 升冪或降冪皆為可試之方向)。', true, { key: ['近窗每單平均損益', '近窗損益和', '近窗勝率', '近窗交易數(升冪)', '近窗報酬對回撤比'] }],
    ['B15_newKey', '新排序鍵', '其他走勢前向之排序鍵: 回撤、權益曲線斜率之穩定度(K-ratio)、因子家族之近期動能、每因子平均貢獻等。', true, null],
    ['B16_perTradeQuality', '每單品質鍵', '每單平均損益、超額勝率(實際勝率減去 tp / sl 隱含之損益兩平勝率)等以單為單位之品質鍵; 可分靜態期與近期。', true, null],
    ['B17_rollingKeys', '滾動與節奏鍵', '多窗滾動績效、扣除群體平均後之殘差績效、單位持倉時間之損益、訊號開火率、低頻 / 高頻節奏、取名次區間(非頂端)等。', true, null],
    ['B18_keyAgree', '兩鍵共識 / 分歧', '以兩種排序鍵之名次一致(皆在前段)或分歧程度作為篩選或排序。', true, null],
    ['C19_jaccard', '進場日集合之 Jaccard 分群', '以各策略進場日集合之 Jaccard 相似度分群, 供群內取位、去重或分散。群數為可調格點。', true, { numGroup: [12, 18, 25, 40, '不分群'] }],
    ['C20_exitStruct', '出場時間結構分群', '以各策略之出場日集合(或其特徵)分群。', true, null],
    ['C21_holdStruct', '持倉時長結構', '以持倉時長之分佈(小時桶)分群或分層。', true, null],
    ['C22_calendar', '在場曆日結構', '以策略「有持倉之曆日集合」分群。', true, null],
    ['C23_recent365', '近一年進場集合', '只用近 365 日之進場日集合建立結構(使結構反映近期行為)。', true, null],
    ['C24_spectral', '頻域 / 模態分群', '對「策略 × 時間」之進場矩陣取模態(SVD、頻譜、Ochiai 等相似度變體)分群, 或移除主模態後以殘差分群。', true, null],
    ['C25_quantileBuckets', '分位切桶', '以某連續屬性之分位數切桶、多尺度集成, 或依進場採樣率重取樣後分桶。', true, null],
    ['C26_groupNull', '無結構分群對照', '隨機分群之對照(量尺)。', false, null],
    ['D27_dedup', '去重', '選集內行為高度重疊者(進場日重疊高、同因子組合等)只留其一; 重疊門檻為可調格點。', true, { overlapMax: [0.5, 0.7, 0.9] }],
    ['D28_trim', '截尾', '排序後先去掉頭尾一定比例(對稱, 或只截一端)再取。', true, { trimPct: [0, 0.2, 0.25] }],
    ['D29_pickPos', '取位', '群內依排序取某分位位置(例如 .65 / .75 / .85)而非最頂端; 或同時取兩個位置。', true, { pos: [0.65, 0.75, 0.85] }],
    ['D30_volumeCut', '量能截取', '以預期月下單量為預算截取選集, 或固定席次數。', true, { monthlyBudget: [6, 12, 30] }],
    ['D31_runawayGuard', '失控守門', '對下單量暴增之策略設守門(量尺性質之保護)。', false, null],
    ['D32_overlapNEff', '選集重疊與有效席次', '以選集內平均重疊度或有效獨立數 nEff 為目標或約束調整選集。', true, null],
    ['D33_antiSticky', '輪替與黏性', '對上期已選者加罰(反黏性輪替)或加分(在任者偏好); 用 ctx.prev / ctx.state。', true, null],
    ['D34_phaseConsensus', '時間錨共識', '以鄰近數個決策日(或不同起算點)之選集取交集 / 共識子集。', true, null],
    ['D35_sepModes', '分邊或合併', '做多與做空分開排序取位, 或合併為一池。', true, { sepModes: [true, false] }],
    ['D36_crossRuleConsensus', '跨規則共識', '多種挑選規則各自之選集取交集, 或依被幾種規則選中加權。', true, null],
    ['E37_dayCap', '每日下單上限', 'accept 以 book.dayCount 限制每日下單數。', true, { dayCap: [1, 3, 12, 999] }],
    ['E38_maxHoldN', '同時持倉上限', 'accept 以 book.open 限制同時持倉單數。', true, { maxHold: [15, 25, 35, 45] }],
    ['E39_skipWeekend', '週末閘', 'accept 於週末(或指定星期)不下單(sig.dow)。', true, { skipWeekend: [false, true] }],
    ['E40_otherDayGates', '其他日閘', '依曆法或需求稀薄日設閘(量尺性質)。', false, null],
    ['E41_sidePolicy', '側別政策', 'accept 依多空持倉(book.openLong / openShort)決定訊號是否下單: 每訊號皆下、須同向確認、停留期、多空差額上限等。', true, { side: ['每訊號', '同向確認', '停留期', '差額上限'] }],
    ['E42_seatAllocation', '席位配給', '多個子規則間之席位分配與准入 / 驅逐(須改評估器)。', false, null],
    ['E43_reorderSizing', '重排序與尺寸', '同數量之單重排序或加權(須改評估器之每單 1 單位假設)。', false, null],
    ['E44_positionSizing', '部位尺寸', '依信度調整每單尺寸(須改評估器)。', false, null],
    ['E45_costSensitivity', '成本敏感度', '交易成本 / 觸價口徑之敏感度(量尺)。', false, null],
    ['F46_retSign', '報酬符號條件', '依標的近 N 日報酬之正負(ctx.market)切換挑選分支或參數。可用「平移若干日之條件變數」作安慰劑對照。', true, { nDays: [30, 60, 90] }],
    ['F47_exogenousRegime', '外生市況條件', '依標的之波動、趨勢、量能狀態(由 ctx.market 自算)切換分支或參數。', true, null],
    ['F48_endogenousCond', '內生條件', '依策略庫或選集自身之狀態切換: 規則近期績效之動量、權益曲線濾網、全庫同時在場度、排序鍵近期之有效性等。', true, null],
    ['F49_xsecPersist', '橫斷面持續性量測', '市況條件下策略層績效之持續性(量尺)。', false, null],
    ['F50_condGate', '條件變數之前提篩', '新條件變數之准入檢查(量尺)。', false, null],
    ['G51_blendPools', '多池配比', '兩個以上之挑選規則各取一部分, 依比例合成選集(例如 50/50、75/25、三池)。', true, { ratio: ['50/50', '75/25', '三池'] }],
    ['G52_book', '分帳', '把席次分給數個獨立之子規則, 合併下單(以 pick 回傳之 tag 區分子帳)。', true, { books: [2, 3, 4] }],
    ['G53_unionFamily', '聯集族', '多規則選集之聯集(與 G51 / G36 重疊; 不另列為可選)。', false, null],
    ['G54_sideSplit', '分側組合', '做多半邊用規則 A、做空半邊用規則 B, 兩半合併。', true, null],
    ['G55_crossLayerTransplant', '跨層移植', '把某層之機制搬到另一層使用(例如排序鍵改當資格、資格改當條件)。', true, null],
    ['H56_globalSample', '全域取樣', 'rsi 迴圈之搜尋臂。', false, null],
    ['H57_localExpand', '局部展開', 'rsi 迴圈之搜尋臂。', false, null],
    ['H58_jump', '跳躍', 'rsi 迴圈之搜尋臂。', false, null],
    ['H59_turning', '轉折', 'rsi 迴圈之搜尋臂。', false, null],
    ['H60_novelty', '生成', 'rsi 迴圈之搜尋臂(生成新臂)。', false, null],
    ['H61_policyVersions', '探索策略版本', 'rsi 迴圈之策略版本。', false, null],
    ['I62_sameDoseNull', '同劑量虛無', '量尺: 評估器已內建。', false, null],
    ['I63_fitBalance', '擬合配平虛無', '量尺。', false, null],
    ['I64_seatNull', '席位層對照', '量尺。', false, null],
    ['I65_timingNullCI', '時機虛無與區間', '量尺。', false, null],
    ['I66_shrinkRetention', '縮庫保持率', '量尺。', false, null],
    ['I67_freshnessBreadth', '新鮮度廣度', '量尺: 評估器已內建 1 / 3 / 7 / 14 / 30 日。', false, null],
    ['I68_crossLibrary', '跨庫泛用', '量尺。', false, null],
    ['I69_catalogRedundancy', '型錄冗餘', '量尺。', false, null],
    ['I70_scales', '其他量尺', '量尺。', false, null],
    ['J71_vintage', '前段回推', '', false, null],
    ['J72_btcSide', 'BTC 側結構', '', false, null],
    ['J73_sideImb', '多空失衡狀態量', '', false, null],
    ['J74_scarceLibrary', '稀缺因子擴庫', '', false, null],
]

let baseArms = T.map(([id, title, desc, selectable, grid], i) => {
    let layer = id[0]
    if (layer === 'J') {
        let a = { id, n: i + 1, layer, title }
        if (desc) {
            a.desc = desc
        }
        a.status = 'blocked'
        a.selectable = false
        a.blockedBy = '本專案不開(僅列名)'
        a.realize = [{ kind: 'manual', how: '不開' }]
        return a
    }
    return mkArm({ id, n: i + 1, title, desc, selectable, grid })
})

let catalog = {
    version: 1,
    name: 'adaptivess arms',
    note: '74 臂之基底: 只定義可探索之方向與機制, 不含任何已試結果; 全部由使用專案之 rsi 由零探索',
    layers,
    arms: baseArms,
}
//--out <檔>: 寫到指定之檔(測試或預覽用; 預設 arms/base.json)
let iOut = process.argv.indexOf('--out')
let fpOut = iOut > 0 && process.argv[iOut + 1] ? path.resolve(process.argv[iOut + 1]) : P('arms', 'base.json')
fs.writeFileSync(fpOut, JSON.stringify(catalog, null, 1), 'utf8')
let sel = baseArms.filter((a) => a.selectable)
console.log(`基底 ${baseArms.length} 臂; 可選 ${sel.length}: ${Object.keys(layers).map((L) => `${L} ${sel.filter((a) => a.layer === L).length}`).join(' ')} → ${fpOut}`)
