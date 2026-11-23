import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { settingsOrExit, argOf, argStrOf, cliMsgOf } from '../cfg.mjs'
import { loadLedger, memberLedger, subsetLedger } from '../eval/ledger.mjs'
import { parseSubsetRule, subsetMaskOf, SUBSET_MSG, SUBSET_MEMBER_MSG } from '../eval/subsetRule.mjs'
import { makeEvaluator, ntStaticOf, isCapitalError } from '../eval/evalCore.mjs'
import { normUnit, sameUnit } from '../eval/unit.mjs'
import { trainFromBarOf, gridCheck, checkEvalSettings, evalNumsOf, evalListsOf, wholeBarsOf, periodAt, configMsgOf } from '../eval/barGrid.mjs'
import { cfgNumOf, cfgListOf, evalRunNumsOf, phaseCountOf, phaseText, phaseCountOfMetrics, phaseCountOfAll } from '../eval/cfgNum.mjs'
import { loadPick, loadExt } from '../eval/pickLoader.mjs'
import { P as PI, pushOwn, safeJson, assertIntrinsics, isIntegrityError } from '../eval/intrinsics.mjs'
import { scoreOf } from '../eval/score.mjs'
import { createResourceMonitor } from '../arsi/resources.mjs'
import { resourceCfgOf } from '../arsi/rsiNums.mjs'


//評估一個挑選模組(節點 agent、做夢 agent 與人共用之唯一驗證入口)
//  **預設評估回測期**(settings.periods.backtest): 目標 = 回測期之等效年化更佳
//    挑選函數自帳本起點(暖機後之第一個決策)連續執行到回測期終點, 每個決策只看得到決策棒以前之資訊;
//    只有決策棒落在回測期者計入績效、新鮮度、虛無與選集統計(持倉簿自回測期起點為空)。ctx.meta.ntAll 只計訓練期之進場數(策略庫之靜態屬性)
//  node g_eval.mjs --pick <挑選模組.mjs> [--mode quick|full] [--period backtest|train|postfit] [--out <結果.json>] [--null N] [--phases 0,3] [--ref <參考模組.mjs>[,<參考模組2.mjs>…]]
//  旗標一律寫成 --key value(空白分隔); 帶等號之 --key=value(含布林旗標之 --no-log=1)一律不評估: 印固定之單行訊息(不帶輸入值)、離開碼 2、於讀設定與載入模組之前(規則 R-EV-49; 旗標之單一定義見 cfg.mjs 之 CLI_FLAGS)
//  --null N: 虛無抽數(非負整數; 覆寫設定之 eval.nullDraws); 給了而不是非負整數(含無值、非數字)⇒ 印 invalid --null: must be a non-negative integer、離開碼 2(規則 R-EV-44; 不靜默忽略)
//  --phases 0,3: 相位之起始日數(覆寫設定之 eval.phases); 各項須為非負數且與每日棒數之積為整數, 不合 ⇒ 印 invalid --phases[<i>]: must be …、離開碼 2(規則 R-EV-50)
//  設定不合(影響評估之數字 warmupDays、cadenceDays、nullDraws、actBins、sideActHalf 給了而無效;期間之界線缺或不在棒格線上;eval.fitEnd、eval.trainFromStart 不合)⇒ 印 ERROR invalid …、離開碼 2
//    quick: 相位 0 與 3、地平線 7 日、不算虛無(數秒; 迭代用)
//    full : 七相位、全部地平線、同劑量虛無 64 抽(交付用; 結果之 selHash 為選集序列之指紋)
//    --period train: 改看訓練期內之決策(診斷用; 訓練期是策略庫之求解期 = 樣本內, 不計入判讀); 自帳本之第一個決策起, 設定 eval.trainFromStart 為 true 者改自訓練期起點起(規則 R-EV-44)
//    --period postfit(規則 R-EV-41; 診斷用; **此結果不是正本**): 求解窗後段 —— 只計決策棒落在「帳本內最早之求解窗終點棒之次一根 ~ 回測期起點(不含)」之決策,
//           且每個決策只留選集中「求解窗終點棒早於該決策棒」之席(評估器之 fitEndBar 逐席判定; 設定 eval.fitEnd)
//           挑選函數照常自帳本起點連續執行(ctx.prev、ctx.state 為其完整之選集); 輸出所留之席之等效年化、組成對照(同側同活躍度; 只換所留之席)之超額與 p、下單數,
//           另列前段 / 後段(依決策序各半; 各段自空倉起算)之同一組量(metrics.afterFit);
//           另列近 90 日活躍度版之組成對照(規則 R-EV-42; 全段與前段 / 後段各列超額 / z / p; metrics.afterFit.sideActRecent 與 halves[].sideActRecent):
//             活躍度改為決策棒以前最近 90 日之進場數(算法同擴充診斷 api.replaceNull 之 actDays 90; 擴充診斷於此段不載入)—— 所留之席近期比其累計之同儕更活躍或更安靜時, 兩種定義同向才算穩
//           決策棒皆早於回測期起點(最後一個決策之視窗可跨過回測期起點至多一個決策間隔, 同 --period train 於訓練期終點之寫法; 帳本止於回測期終點)
//           用途: 回測期以外、策略未見過之另一段期間, 判一條線之內容是否換期仍成立(佐證; 不入 S、階梯與看板之排序; 結果檔之 score 為 null、不印判讀列;
//             評估紀錄記 period, 不算版本之評估; 以之挑參數即失去其獨立性)
//           **效度限制**: 此段內, 決策棒以前之單多在求解窗內(樣本內); 以過往之損益為輸入之排序鍵, 其輸入於此段與回測期性質不同
//             (回看 N 日之鍵要到求解窗終點之後 N 日, 其輸入才全為求解窗外之單)⇒ 看分段(前段 / 後段); 以進場時點或結構為輸入之鍵不受此限
//           同劑量 / 同訊號量 / 同活躍度虛無之替換池為全庫(含求解窗涵蓋此段之策略)⇒ 此段讀組成對照(同側; 同側之 fitEndBar 相同為其前提, 見 evalPolicy 之註解)
//           須有虛無(--mode full, 或 --null N 且 N ≥ 1); 不與 --ref、--ext-test 併用; 迴圈之重放之 ARSI_LEDGER_DIR / ARSI_EVAL_FROM 不與之併用(皆離開碼 2); --member、--phases 可併用; 擴充診斷不載入
//           每一個所評估之相位於段內皆須有決策棒(某相位無決策者其等效年化為 0, 併入各相位之平均會稀釋所留之席之數字 ⇒ 不評估, 離開碼 2)
//    --seed N: 換亂數種子(**只在迴圈之重放(ARSI_HARNESS=1)時生效**; 其他呼叫者帶此旗標即忽略 —— 節點不得藉換種子挑結果); 給了而不是整數(小數、非數字、超出安全整數)⇒ 印 invalid --seed: must be an integer、離開碼 2(不評估; 1.0.48 起, 原: 忽略並說明)
//    --tie-salt N: 換同分次序(ctx.meta.tie 與同一進場棒之訊號先後; 同樣只在迴圈之重放時生效; 節點要自檢同分之影響用共用工具區之 snippets/tieAlt.mjs); 給了而不是整數 ⇒ 印 invalid --tie-salt: must be an integer、離開碼 2(同上)
//    --member <鹽>:<0|1>: 成員重抽(規則 R-EV-40)—— 只把策略庫之一半交給挑選函數(0 = 甲半、1 = 乙半; 鹽為 0 ~ 4294967295 之整數, 十進位或 0x 開頭之十六進位; 換鹽 = 換一種切法),
//           模組不必改寫: ctx.n 為半庫之隻數, ctx.meta 之各陣列與 ctx.stat 等皆為半庫內之序號, 各策略之 ctx.meta.tie 與其於全庫時相同; 期間、相位、虛無、擴充診斷照舊
//           用途: 檢驗成品之內容是否依賴特定成員(「換一批策略」之重複; 兩半皆成立才算不依賴); **此結果不是正本**(結果檔與評估紀錄另記 member), 節點、做夢與迴圈皆可用; 格式不合、帶等號之 --member=… 者不評估(離開碼 2)
//    --subset <規則>[,<規則>…]: 子庫(規則 R-EV-47; --member 之一般化)—— 只把符合全部規則之策略交給挑選函數與虛無抽樣(規則見 src/eval/subsetRule.mjs 之檔頭與 README §3;
//           rand:0.5:<鹽>:<h> 之子庫 = --member <鹽>:<h> 之半庫); 其餘同 --member(此結果不是正本; 結果檔與評估紀錄另記 subset; 與 --ref、--ext-test、--period 之併用同 --member);
//           不與 --member 併用; 格式不合、旗標重複給、帶等號之 --subset=… 者不評估(離開碼 2); 規則使留下 0 隻者照常評估, 畫面於「子庫」一列之後另加一句警示
//    --ref: 另以參考模組之 pick 於同相位、同亂數種子逐決策執行(各有自己的 ctx.state / ctx.rand, 與本模組互不影響),
//           輸出兩者選集之重疊率(交集 ÷ 本模組之選集大小)依決策段(各相位最前 10% / 中段 / 最後 10% 之決策)之分佈;
//           只增輸出(結果檔之 refOverlap), 既有數字與 selHash 不變; 可給多個(逗號分隔): refOverlap = 第一個, 另有 refOverlaps = 全部依序
//  基礎單位(規則 R-EV-43; 設定 source.unit 有給、且帳本以之建成者): 損益與等效年化依實際名義計(等效年化 = 損益和 ÷ 最大同時持倉名義 ÷ 年數), 另印峰值持倉名義;
//    帳本之 meta.unit 與設定之 source.unit 不同(含一方未給)者不評估(離開碼 2; 請重建帳本)—— 迴圈之重放改用他份帳本者(ARSI_LEDGER_DIR)以該帳本自帶之交易規則為準、不比對;
//    操作績效之最大同時持倉名義超過研究用本金 ⇒ 評估中止(ERROR EVAL_UNIT_CAPITAL; 離開碼 3)
//  離開碼: 0 完成 / 2 挑選模組不存在或未過靜態檢查 / 3 挑選函數執行錯誤(含內建物件被改: ERROR EVAL_INTEGRITY)
//  內建物件之完整性(規則 R-EV-35 ②): 挑選模組、擴充診斷模組、參考模組各於載入後比對; 讀帳本前與輸出前(最後一個 await 之後)再比對 ——
//    模組可排入延後執行之程式(微任務), 於其後之 await 期間才改內建物件; 評估本身為同步, 執行中不會插入
//    被改 ⇒ 評估失敗(離開碼 3; 有 --out 者寫 { ok: false, code: 'EVAL_INTEGRITY', where, items }), 結果檔與評估紀錄以擷取之 JSON.stringify 寫出
//命令列之旗標只認 --key value(空白分隔; 排程第 590、547 項): 帶等號之 --key=value、未列之旗標(含拼錯、--period:postfit 之冒號寫法)、單值旗標重複、帶值旗標無值、--mode / --period 之值不在列舉、
//  多餘之值(--phases 0 3、--ref a.mjs b.mjs)一律不評估(離開碼 2; 於讀設定、載入模組與等資源閘之前即檢查, 不寫結果檔、不記評估紀錄; 訊息固定、不帶輸入值〔K9〕)
//  原: argOf 不識以上各種寫法而視為旗標未給或只取第一個 —— --period=postfit 退回回測期之評估而記為正本列、--null=8 / --phases=0,3 / --mode=full 之設定被忽略而以預設評估、--ref=… / --ext-test=… 不執行、--no-log=1 不生效、
//    --mode ful 當成 quick、重複給之 --pick 取第一個、--phases 0 3 只取 0, 皆靜默
//  本進入檔認得之全部旗標見 cfg.mjs 之 CLI_FLAGS.eval(單一定義)、列舉之值見 CLI_ENUMS.eval、無值或重複由本檔自己解析者見 CLI_OWN.eval; 同時帶 --member= 與 --subset= 者先報 --member(沿用 1.0.42)
{
    let argMsg = cliMsgOf('eval', process.argv.slice(2), { first: ['member', 'subset'] })
    if (argMsg !== null) {
        console.log(argMsg)
        process.exit(2)
    }
}
let fpPick = argOf('pick', '')
if (!fpPick || fpPick === true) {
    console.log('用法: node g_eval.mjs --pick <挑選模組.mjs> [--mode quick|full] [--period backtest|train|postfit] [--out <結果.json>] [--null N] [--phases 0,3] [--ref <參考模組.mjs>]')
    process.exit(2)
}
let mode = argOf('mode', 'quick')
let periodArg = String(argOf('period', 'backtest'))
if (!['backtest', 'train', 'postfit'].includes(periodArg)) {
    console.log('invalid --period: must be one of backtest, train, postfit')
    process.exit(2)
}
//求解窗後段(--period postfit; 規則 R-EV-41)與其他參數之併用 —— 不合者不評估(離開碼 2; 於載入模組與等資源閘之前即檢查, 不寫結果檔、不記評估紀錄; 訊息依 V19、V20, 不帶輸入值)
//  須有虛無(組成對照是此段之判讀所在): 實際之抽數 = --null N(給數字者)或完整評估之設定值(quick 為 0)
//  --ref(重疊率以完整之選集定義)、--ext-test(擴充診斷以完整之選集為前提)不併用; 迴圈之重放改帳本 / 評估起點之環境變數不併用(此段之終點固定為回測期起點)
//  --ext-test 與其他期間之併用維持現狀(不在本規則範圍)
let isPostfit = periodArg === 'postfit'
//--null N(虛無抽數; 規則 R-EV-44): 給了(含無值或非數字)而不是非負整數 ⇒ 不評估(離開碼 2; 決定資料口徑之 opt 不退回預設、不靜默忽略); 未給 ⇒ 依模式與設定
let nullArg = argOf('null', null)
if (nullArg !== null && !(typeof nullArg === 'number' && Number.isSafeInteger(nullArg) && nullArg >= 0)) {
    console.log('invalid --null: must be a non-negative integer')
    process.exit(2)
}
//--phases <日,日,…>(相位之起始日數; 覆寫設定之 eval.phases; 排程第 595 項): 各項須為非負數(數字或數字字串; 轉為數值後才使用); 給了而不合 ⇒ 不評估(離開碼 2; 訊息依 V19、V20, 不帶輸入值;
//  原: Number(x) 之隱式轉換, 非數字者為 NaN ⇒ 該相位無決策棒而靜默算錯, 空項被當 0); 無值(只給旗標)者已於檔首之通用檢查拒收(cliMsgOf; 原: 忽略而沿用設定); 與每日棒數之積須為整數者於讀帳本之後檢查
let phasesArg = argOf('phases', null)
let phasesList = null
if (phasesArg !== null && phasesArg !== true) {
    try {
        phasesList = cfgListOf(String(phasesArg).split(','), null, '--phases', 'nonNegNum')
    }
    catch (err) {
        console.log(err.message)
        process.exit(2)
    }
}
//--seed N(亂數種子)、--tie-salt N(同分次序之鹽)(排程第 606 項; R-EV-55; 決定資料口徑之 opt): 給了而不是整數(安全整數之範圍內; 小數、非數字、無值、超出安全整數)⇒ 不評估(離開碼 2; 訊息固定、不帶輸入值; 於讀設定、載入模組與等資源閘之前, 不寫結果檔、不記評估紀錄; 同 --null 與 g_backtest.mjs 之 --seed)
//  原: 不合者「已忽略(沿用設定之亂數種子 / 正本之同分次序)」並照常評估 —— 以為換了種子卻沒換; 合格之整數而非迴圈之重放(ARSI_HARNESS 不為 1)者仍「只供迴圈之重放使用, 已忽略」(設計: 節點不得藉換種子挑結果; 見下方生效處)
let seedArg = argOf('seed', null)
if (seedArg !== null && !(typeof seedArg === 'number' && Number.isSafeInteger(seedArg))) {
    console.log('invalid --seed: must be an integer')
    process.exit(2)
}
let tieArg = argOf('tie-salt', null)
if (tieArg !== null && !(typeof tieArg === 'number' && Number.isSafeInteger(tieArg))) {
    console.log('invalid --tie-salt: must be an integer')
    process.exit(2)
}
//成員重抽(規則 R-EV-40): --member <鹽>:<0|1> ⇒ 以半庫帳本(memberLedger: 只含該半之策略、重新編號、保留各策略於全庫之同分次鍵)評估; 未給 ⇒ 全庫(行為不變)
//  格式不合者不評估(離開碼 2; 不靜默改用全庫: 那會把全庫之結果當成半庫之結果); 於載入模組與等資源閘之前即檢查(不先耗時), 不寫結果檔、不記評估紀錄
//  鹽之 0x 十六進位寫法只於此處解析(memberLedger 收整數, 依 iseint); memberTag 為標記('0x<鹽之十六進位>:<0|1>'; 未給為 null): 結果檔之 member.tag 與評估紀錄之每一列(含失敗者)帶之 —— 帶此標記者不是正本之評估
//  帶等號之 --member=<鹽>:<半> 同拒(離開碼 2; 同上之時點與處置): 命令列之旗標只認 --key value; 此寫法被忽略會使成員重抽之評估變成全庫之評估而評估紀錄記為正本列
//    (全部旗標之 --key=value 皆於檔首以 eqFlagMsgOf 一併拒收〔排程第 590 項; 1.0.42 先處理 --member=、--subset=〕, 訊息同 1.0.42)
let memberArg = argOf('member', null)
let member = null
let memberTag = null
if (memberArg !== null) {
    //格式 <鹽>:<0|1>: 鹽之位數不另限(前導零無妨), 以數值 ≤ 4294967295 為界(過大者轉為 Infinity 或大數而拒收); 旗標重複給者拒收(argOf 只取第一個, 其餘靜默忽略會誤跑)
    let mm = /^(0x[0-9a-fA-F]+|[0-9]+):([01])$/.exec(String(memberArg))
    let saltV = mm ? (mm[1].startsWith('0x') ? parseInt(mm[1].slice(2), 16) : Number(mm[1])) : NaN
    if (!mm || !(saltV <= 0xFFFFFFFF) || process.argv.filter((a) => a === '--member').length > 1) {
        console.log('invalid --member: must be <salt>:<half>, where salt is an integer from 0 to 4294967295 (decimal or 0x hexadecimal) and half is 0 or 1')
        process.exit(2)
    }
    member = { salt: saltV, half: Number(mm[2]) }
    memberTag = `0x${saltV.toString(16)}:${member.half}`
}
//子庫之規則(規則 R-EV-47): --subset <規則>[,<規則>…] ⇒ 以子庫帳本(subsetLedger: 只含符合全部規則之策略、重新編號、保留各策略於全庫之同分次鍵)評估; 未給 ⇒ 全庫(行為不變)
//  格式不合(parseSubsetRule 拋錯)、旗標重複給、只給旗標、與 --member 併用、帶等號者不評估(離開碼 2; 同 --member 之時點與處置: 於載入模組與資源閘之前, 不寫結果檔、不記評估紀錄, 訊息不帶輸入值)
//  subset.rule = 正規化之規則字串(parseSubsetRule 之 tag): 結果檔之 subset.rule 與評估紀錄之每一列(含失敗者)帶之 —— 帶此標記者不是正本之評估
//  帶等號之 --subset=<規則> 同拒(離開碼 2; 同上; 於檔首, 故不被「第一個 --subset」之合格值遮蔽): 同上, 被忽略會以全庫評估而評估紀錄記為正本列
let subsetArg = argStrOf('subset', null)
let subset = null
if (subsetArg !== null) {
    let ps = null
    try {
        ps = process.argv.filter((a) => a === '--subset').length > 1 || subsetArg === true ? null : parseSubsetRule(subsetArg)
    }
    catch (err) {
        ps = null
    }
    if (ps === null) {
        console.log(SUBSET_MSG)
        process.exit(2)
    }
    if (memberArg !== null) {
        console.log(SUBSET_MEMBER_MSG)
        process.exit(2)
    }
    subset = { rules: ps.rules, rule: ps.tag }
}
//設定(排程第 547 項: 旗標之檢查皆已於此之前; 其餘依設定者如下)
let st = settingsOrExit()
if (isPostfit) {
    let nullArg0 = nullArg
    let nDraws = 0
    try {
        nDraws = nullArg0 !== null ? nullArg0 : (mode === 'full' ? cfgNumOf(st.eval && st.eval.nullDraws, 64, 'eval.nullDraws', 'nonNegInt') : 0)
    }
    catch (err) {
        console.log(`ERROR ${err.message}`)
        process.exit(2)
    }
    let bad = null
    if (argOf('ref', null) !== null) {
        bad = 'cannot be combined with --ref'
    }
    else if (argOf('ext-test', null) !== null) {
        bad = 'cannot be combined with --ext-test'
    }
    else if (!(Number.isInteger(nDraws) && nDraws >= 1)) {
        bad = 'must have null draws (--mode full, or --null N with N >= 1)'
    }
    else if (process.env.ARSI_HARNESS === '1' && (process.env.ARSI_LEDGER_DIR || process.env.ARSI_EVAL_FROM)) {
        bad = 'cannot be combined with ARSI_LEDGER_DIR or ARSI_EVAL_FROM'
    }
    if (bad) {
        console.log(`invalid --period postfit: ${bad}`)
        process.exit(2)
    }
}
//memberInfo, 失敗之結果檔所帶之 member / subset(帳本尚未載入, 無 n / nFull): 成功之結果檔之 member / subset 另含 n 與 nFull 等
let memberInfo = () => ({ ...(member ? { member: { tag: memberTag, salt: member.salt, half: member.half } } : {}), ...(subset ? { subset: { rule: subset.rule } } : {}) })
let fpOut = argOf('out', '')
let t0 = Date.now()
//評估紀錄: 挑選模組位於節點 / 做夢之工作夾內時, 每次執行於其所在資料夾之 .evals.log 附加一列(時間、檔名、模式、結果), 供迴圈計數「交付前評估了幾次」
//  (不靠解析 agent 之指令字串: shell 迴圈與 && 串接會漏數); --no-log 不記, **只在迴圈之重跑(環境變數 ARSI_HARNESS=1)時生效**;
//  其他呼叫者帶 --no-log 照樣記錄並標記 noLogIgnored(節點不得以此繞過評估次數之記錄)
//  每列另記 h(模組內容之雜湊; 迴圈據以查「已評估之版本是否仍有檔可重現」)與 waitedSec(資源閘之等待秒數; 有等才記)
let pickHash = null
try {
    pickHash = crypto.createHash('sha1').update(fs.readFileSync(path.resolve(String(fpPick)))).digest('hex').slice(0, 12)
}
catch (err) {}
let waitedSec = 0
let logEval = (o) => {
    try {
        let noLog = argOf('no-log', false) === true
        if (noLog && process.env.ARSI_HARNESS === '1') {
            return
        }
        if (noLog) {
            o = { ...o, noLogIgnored: true }
        }
        let dir = path.dirname(path.resolve(String(fpPick)))
        let relToWork = path.relative(st.records.workDir, dir)
        if (relToWork.startsWith('..') || path.isAbsolute(relToWork)) {
            return
        }
        fs.appendFileSync(path.join(dir, '.evals.log'), safeJson({ at: new Date().toISOString(), pick: path.basename(String(fpPick)), mode, ...(periodArg !== 'backtest' ? { period: periodArg } : {}), h: pickHash, ...(memberTag ? { member: memberTag } : {}), ...(subset ? { subset: subset.rule } : {}), ...(waitedSec > 0 ? { waitedSec } : {}), ...o }) + '\n')
    }
    catch (err) {}
}
//writeJson, 寫結果檔(格式同 cfg.mjs 之 writeJson: 縮排 2、UTF-8); 以載入時擷取之 JSON.stringify 序列化(規則 R-EV-35 ②)
let writeJson = (fp, obj) => {
    fs.mkdirSync(path.dirname(fp), { recursive: true })
    fs.writeFileSync(fp, PI.JSONStringify(obj, null, 2), 'utf8')
}
//failIntegrity, 內建物件被改(err 為 intrinsics 之完整性錯誤): 評估失敗, 離開碼 3(--ext-test 時印 EXT_FAIL、離開碼 4)
//  結果檔以擷取之 JSON.stringify 寫出(此時內建物件已被改; 見上方之 writeJson)
//  此時內建物件已被改: 輸出用擷取之 console.log, 結果檔與評估紀錄以 safeJson 序列化(不經原型上之 toJSON)
let failIntegrity = (err, extTestName = null) => {
    if (extTestName) {
        PI.ConsoleLog(`EXT_FAIL ${extTestName}: ${err.message}`)
        process.exit(4)
    }
    PI.ConsoleLog(`ERROR ${err.message}`)
    if (fpOut && fpOut !== true) {
        try {
            fs.mkdirSync(path.dirname(path.resolve(fpOut)), { recursive: true })
            fs.writeFileSync(path.resolve(fpOut), safeJson({ ok: false, ...memberInfo(), error: err.message, code: 'EVAL_INTEGRITY', where: err.where, items: err.items }, true), 'utf8')
        }
        catch (e) {}
    }
    logEval({ ok: false, code: 'EVAL_INTEGRITY' })
    process.exit(3)
}
//checkOrFail, 比對內建物件; 被改即 failIntegrity
let checkOrFail = (where, extTestName = null) => {
    try {
        assertIntrinsics(where)
    }
    catch (err) {
        failIntegrity(err, extTestName)
    }
}
let pk
try {
    pk = await loadPick(fpPick)
}
catch (err) {
    if (isIntegrityError(err)) {
        failIntegrity(err)
    }
    console.log(`ERROR ${err.code || ''} ${err.message}`)
    if (fpOut && fpOut !== true) {
        writeJson(path.resolve(fpOut), { ok: false, ...memberInfo(), error: err.message, code: err.code || null, issues: err.issues || [] })
    }
    logEval({ ok: false, code: err.code || 'PICK_LOAD' })
    process.exit(2)
}
//資源閘(評估層): 全機 CPU 或已用記憶體逼近上限(settings.resources)時, 先等一下再開始 —— 多個節點同時評估、或機器上另有他人之負載時, 讓評估錯開
//  門檻: CPU ≤ evalCpuStart(預設 cpuMax − 5)、已用記憶體 ≤ ramStartGB; 最長等 evalMaxWaitSec(預設 90)秒, 逾時照常開始; 不影響任何數字
//  迴圈之重跑(ARSI_HARNESS=1)已於迴圈內經資源閘, 此處不再等
//  settings.resources 之取值(排程第 606 項; R-EV-55; 資源上限屬執行面之設定〔K3〕, 不決定評估之數字): 經 resourceCfgOf —— 與迴圈之資源閘(domain.mjs)與合約之參考版(initProject.mjs)同一函數, 同一鍵單一解讀:
//    數字字串轉為數值後才使用; 無效 ⇒ 視為未給(用預設); 計時值(evalMaxWaitSec)為非負數且換成毫秒不超過 2147483647(原: 只收 number; 迴圈與評估層各自判定)
if (st.resources && process.env.ARSI_HARNESS !== '1') {
    try {
        let gateCfg = resourceCfgOf(st.resources).evalGate
        if (gateCfg.cpuMax !== null || gateCfg.ramUsedMaxGB !== null) {
            let gate = createResourceMonitor({
                ...gateCfg,
                pollSec: 5,
                jitter: 0.6,
            })
            let w = await gate.wait('eval')
            if (w.waitedSec >= 3) {
                waitedSec = w.waitedSec
                console.log(`資源閘: 全機負載偏高, 等待 ${w.waitedSec} 秒後開始評估${w.forced ? '(已達最長等待, 照常開始)' : ''};不影響結果`)
            }
        }
    }
    catch (err) {}
}
//保留期之檢定(主控專用; 規則 R-BT-4): 只在迴圈專用之環境(ARSI_HARNESS=1)下, 環境變數 ARSI_LEDGER_DIR 改用另一份帳本(私有根; 終點在回測期之後)、
//  ARSI_EVAL_FROM 改評估起點(保留期之起點); 節點與做夢之任務不使用(其操作紀錄含 ARSI_HARNESS 即被稽核列出), 其數字不對 agent 揭露
let harnessEnv = process.env.ARSI_HARNESS === '1'
let ledgerDir = harnessEnv && process.env.ARSI_LEDGER_DIR ? path.resolve(process.env.ARSI_LEDGER_DIR) : st.eval.ledgerDir
let evalFrom = harnessEnv && process.env.ARSI_EVAL_FROM ? process.env.ARSI_EVAL_FROM : periodAt(st, 'backtest', 'start')
//讀帳本前比對內建物件(挑選模組已載入; 其延後執行之程式可能於上方之 await 期間才執行): 讀帳本與建評估器為同步, 其間不會再執行模組之程式
checkOrFail('before-ledger')
let Lfull = loadLedger(ledgerDir)
//基礎單位(規則 R-EV-43): 帳本之 meta.unit 須與設定之 source.unit 相同(交易規則之三個數值、緩衝、研究用本金; 皆未給亦可)—— 改了設定而未重建帳本者不評估
//  (離開碼 2; 給 --out 者寫失敗之結果檔 { ok: false, code: 'LEDGER_UNIT_MISMATCH', mismatch }, 不留前次之結果; 不記評估紀錄)
//  迴圈之重放改用他份帳本者(ARSI_HARNESS=1 且 ARSI_LEDGER_DIR; 保留期、其他標的): 只放寬「交易規則之三個數值」(以該帳本自帶者為準; 其他標的之交易規則隨其帳本),
//    仍須「設定有給 ⇔ 帳本帶 meta.unit」且緩衝與研究用本金相同(不合 ⇒ 同上, 不以另一口徑評估; 訊息不指 g_build.mjs —— 他份帳本不由其建)
//  設定之 source.unit 本身不合者同樣不評估(離開碼 2; 給 --out 者寫失敗之結果檔 { ok: false, code: 'SOURCE_UNIT_INVALID' }; 不記評估紀錄)
//  mismatch, 不合之項: ['presence'](一方未給)或 'rule'(交易規則之三個數值; 他份帳本不比)、'buffer'、'uIni' 之子集
{
    let su = null
    try {
        su = normUnit(st.source && st.source.unit !== undefined ? st.source.unit : null, 'source.unit')
    }
    catch (err) {
        console.log(err.message)
        if (fpOut && fpOut !== true) {
            writeJson(path.resolve(fpOut), { ok: false, ...memberInfo(), error: err.message, code: 'SOURCE_UNIT_INVALID' })
        }
        process.exit(2)
    }
    let lu = Lfull.unit === undefined ? null : Lfull.unit
    let other = harnessEnv && Boolean(process.env.ARSI_LEDGER_DIR)
    let mismatch = []
    if ((su === null) !== (lu === null)) {
        mismatch.push('presence')
    }
    else if (su !== null) {
        if (!other && (su.rule.stepSize !== lu.rule.stepSize || su.rule.minQty !== lu.rule.minQty || su.rule.minNotional !== lu.rule.minNotional)) {
            mismatch.push('rule')
        }
        if (su.buffer !== lu.buffer) {
            mismatch.push('buffer')
        }
        if (su.uIni !== lu.uIni) {
            mismatch.push('uIni')
        }
    }
    let ok = other ? mismatch.length === 0 : sameUnit(su, lu)
    if (!ok) {
        let msg = other ? 'invalid ledger: must have the same presence, buffer and uIni of unit as source.unit of settings (ledger of ARSI_LEDGER_DIR)' : 'invalid ledger: must be rebuilt with the current source.unit of settings'
        console.log(other ? msg : `${msg} (node g_build.mjs)`)
        if (fpOut && fpOut !== true) {
            writeJson(path.resolve(fpOut), { ok: false, ...memberInfo(), error: msg, code: 'LEDGER_UNIT_MISMATCH', mismatch })
        }
        process.exit(2)
    }
}
//成員重抽: 半庫帳本(memberLedger 之入口另比對內建物件; 與讀帳本同為同步, 其間不會再執行模組之程式); 之後之評估期間、訓練期之進場數、評估器皆以半庫帳本為準
let L = member ? memberLedger(Lfull, member.salt, member.half) : Lfull
if (member) {
    member = { ...member, n: L.n, nFull: Lfull.n }
}
//評估期間: 帳本涵蓋訓練期 + 回測期; 預設只計回測期內之決策, --period train 只計訓練期內之決策(診斷)
let barMs = L.meta.barHours * 3600000
let time0Ms = Date.parse(`${L.meta.time0}Z`)
let barOf = (iso) => Math.round((Date.parse(`${iso}Z`) - time0Ms) / barMs)
//設定不合(規則 R-EV-44: 期間之界線與 eval.fitEnd 不在帳本之棒格線上、eval.trainFromStart 不合)⇒ 印 ERROR invalid …、離開碼 2(於評估之前; 不記評估紀錄);
//  給 --out 者寫失敗之結果檔 { ok: false, code: 'CONFIG_INVALID', error }(同 SOURCE_UNIT_INVALID 之寫法)
let configExit = (err) => {
    let msg = configMsgOf(err)
    if (msg !== null) {
        console.log(`ERROR ${msg}`)
        if (fpOut && fpOut !== true) {
            writeJson(path.resolve(fpOut), { ok: false, ...memberInfo(), error: msg, code: 'CONFIG_INVALID' })
        }
        process.exit(2)
    }
    throw err
}
//  檢查 = 迴圈組裝專案時之預檢(checkEvalSettings): 缺 periods.train / periods.backtest 亦為 invalid periods.…(不是 TypeError); 並含影響評估之數字(暖機日數、決策間隔、虛無抽數、活躍度分層數、名次寬度; 給了而無效即拒絕)
try {
    checkEvalSettings(st, L.meta)
    gridCheck(evalFrom, L.meta, harnessEnv && process.env.ARSI_EVAL_FROM ? 'ARSI_EVAL_FROM' : 'periods.backtest.start')
}
catch (err) {
    configExit(err)
}
let trainEndBar = barOf(st.periods.train.end)
let btStartBar = barOf(evalFrom)
if (periodArg === 'backtest' && btStartBar >= L.nBars) {
    console.log(`ERROR 評估帳本(${st.eval.ledgerDir};終點 ${L.meta.endTime})未涵蓋回測期(${st.periods.backtest.start} 起);請先建帳本: node g_build.mjs`)
    process.exit(2)
}
//靜態欄 ctx.meta.ntAll: 只計訓練期之進場數(策略庫之屬性; 不含訓練期以後之資訊); makeEvaluator 要求明給訓練期之界線
//  帳本只涵蓋訓練期者(終點 ≤ 訓練期之終點)其值 = 帳本全期之進場數(進場棒皆小於帳本之 K 棒數)
//  eval.trainFromStart(選配; 規則 R-EV-44): true ⇒ 計數與 --period train 之決策皆以訓練期起點為下界(帳本之資料起點早於訓練期起點者用之); 未給 ⇒ 自帳本起點(行為不變)
//    下界為第 0 根(帳本起點 = 訓練期起點, 或更晚)者與未給者相同(不設下界 ⇒ 結果檔逐位相同)
let trainFrom = null
try {
    trainFrom = trainFromBarOf(st, L.meta, trainEndBar)
}
catch (err) {
    configExit(err)
}
if (trainFrom === 0) {
    trainFrom = null
}
//子庫(規則 R-EV-47): 訓練期之界線求得之後才套用(hold 之規則以之為訓練期); 其前之檢查與換算只讀 meta 與 nBars(子庫與全庫相同)
//  遮罩(subsetMaskOf)與帳本之重組(subsetLedger)之入口各比對內建物件; 與讀帳本同為同步, 其間不會再執行模組之程式
if (subset) {
    let sm = subsetMaskOf(Lfull, subset.rules, { trainEndBar, trainFromBar: trainFrom === null ? 0 : trainFrom })
    L = subsetLedger(Lfull, sm.sel, subset.rule)
    let nLong = 0
    for (let s = 0; s < L.n; s++) {
        nLong += L.mode[s] > 0 ? 1 : 0
    }
    subset = { ...subset, n: L.n, nFull: Lfull.n, nLong, nShort: L.n - nLong, ...(sm.topFamilies ? { topFamilies: sm.topFamilies } : {}) }
}
L.ntStatic = trainFrom === null ? ntStaticOf(L, trainEndBar) : ntStaticOf(L, trainEndBar, trainFrom)
let win = periodArg === 'train' ? { toBar: trainEndBar } : { fromBar: btStartBar }
if (periodArg === 'train' && trainFrom !== null) {
    win = { fromBar: trainFrom, toBar: trainEndBar }
}
//亂數種子: 預設 settings.eval.seed; --seed 只在迴圈之重放(ARSI_HARNESS=1)時生效(值之檢查已於上: 整數; 其他呼叫者帶合格之整數者即忽略並說明)
let seedOverride = null
if (seedArg !== null) {
    if (process.env.ARSI_HARNESS === '1') {
        seedOverride = seedArg
    }
    else {
        console.log('--seed 只供迴圈之重放使用,已忽略(沿用設定之亂數種子)')
    }
}
//同分次序: 預設為正本; --tie-salt N(整數; 0 = 正本)以另一組固定之同分次序重放(ctx.meta.tie 與同一進場棒之訊號先後), 同樣只在迴圈之重放(ARSI_HARNESS=1)時生效(值之檢查已於上)
let tieSalt = 0
if (tieArg !== null) {
    if (process.env.ARSI_HARNESS === '1') {
        tieSalt = tieArg
    }
    else {
        console.log('--tie-salt 只供迴圈之重放使用,已忽略(沿用正本之同分次序)')
    }
}
let ev
let evNums
let evRun
let evLists
try {
    ev = makeEvaluator(L, tieSalt !== 0 ? { ...st.eval, tieSalt } : st.eval)
    //設定之數值(與評估器、上方之預檢同一組函數; 規則 R-EV-44 ④之二): 決策間隔、虛無抽數、亂數種子、相位與新鮮度地平線取轉型後之數值(數字字串之設定不以字串進入 opt)
    //  亂數種子: 數字字串轉為數值後才使用(原: 字串之種子於 `seed * 1000003` 與 `seed + …` 被解讀為不同之數值)
    evNums = evalNumsOf(st.eval, L.barsPerDay, 'eval')
    evRun = evalRunNumsOf(st.eval, 'eval')
    evLists = evalListsOf(st.eval, L.barsPerDay, 'eval')
}
catch (err) {
    configExit(err)
}
let seed = seedOverride !== null ? seedOverride : evRun.seed
let opt = mode === 'full'
    ? { phases: evLists.phases, horizons: evLists.horizons, nullDraws: evNums.nullDraws }
    : { phases: [0, 3], horizons: [evNums.cadenceDays], nullDraws: 0 }
if (phasesList !== null) {
    //--phases(上方已檢各項為非負數): 與每日棒數之積須為整數(同設定之 eval.phases)
    try {
        wholeBarsOf(phasesList, L.barsPerDay, '--phases', 'a non-negative')
    }
    catch (err) {
        console.log(err.message)
        process.exit(2)
    }
    opt.phases = phasesList
}
if (nullArg !== null) {
    opt.nullDraws = nullArg
}
//求解窗後段(--period postfit; 規則 R-EV-41): 起 = 評估器之 fitEndBar 之最小者(0 以上)之次一根(終點棒本身在求解窗內); 終 = 回測期起點(設定之回測期, 不含; 不取環境變數)
//  不合者不評估(離開碼 2; 不寫結果檔、不記評估紀錄; 訊息依 V19、V20): 設定無 eval.fitEnd、帳本未涵蓋至回測期起點、所評估之相位於段內皆無決策棒
let postfit = null
if (isPostfit) {
    let fe = ev.meta.fitEndBar
    let minFe = -1
    for (let s = 0; s < fe.length; s++) {
        if (fe[s] >= 0 && (minFe < 0 || fe[s] < minFe)) {
            minFe = fe[s]
        }
    }
    if (minFe < 0) {
        console.log('invalid --period postfit: must have eval.fitEnd in settings (the end of the fitting window of each side)')
        process.exit(2)
    }
    let pfTo = barOf(st.periods.backtest.start)
    if (pfTo > L.nBars) {
        console.log('invalid --period postfit: must have a ledger that covers the start of the backtest period (rebuild it: node g_build.mjs)')
        process.exit(2)
    }
    let pfFrom = minFe + 1
    //所評估之相位(同 evalPolicy 之預設: opt.phases ?? settings.eval.phases ?? 0 ~ 6)**每一個**須於段內有決策棒:
    //  某相位無決策者其等效年化為 0, 併入各相位之平均會稀釋所留之席之數字(且分段不成立) ⇒ 與其輸出被誤讀, 不如不評估(拒絕)
    let pfPhases = opt.phases || [0, 1, 2, 3, 4, 5, 6]
    if (!(pfPhases.length > 0 && pfPhases.every((ph) => ev.decisionBars(ph).some((b) => b >= pfFrom && b < pfTo)))) {
        console.log('invalid --period postfit: must have at least one decision bar in every evaluated phase after the earliest end of the fitting windows and before the start of the backtest period')
        process.exit(2)
    }
    postfit = { fromBar: pfFrom, toBar: pfTo }
    win = { fromBar: pfFrom, toBar: pfTo }
}
//擴充診斷(共用工具區之 metrics/*.mjs; 由做夢擴建; 規則 R-EV-21): 完整評估且有算虛無時逐一載入, 結果附於 metrics.ext.<檔名>
//  每個檔 `export default function (api) { … return { text, … } }`; 與挑選模組同一組字樣限制(不得匯入、不得碰檔案 / 行程 / 時鐘); api 見 src/eval/evalCore.mjs
//  --ext-test <檔>: 只載入該檔、以小規模(相位 0,3、8 抽)試跑一次, 印 EXT_OK / EXT_FAIL(迴圈之機械檢查與自檢入口用; 不記評估紀錄、不寫結果檔)
let extTest = argOf('ext-test', null)
let extList = []
let extLoadErrors = []
//  載入器 loadExt 在 src/eval/pickLoader.mjs(與挑選模組之 loadPick 同處、同一種匯入快取鍵)
if (typeof extTest === 'string' && extTest) {
    opt = { phases: [0, 3], horizons: [evNums.cadenceDays], nullDraws: 8 }
    try {
        //await 恢復後先比對(其間模組之延後程式可能已改), 再以 pushOwn 收集
        let ex = await loadExt(extTest)
        assertIntrinsics('ext-load')
        pushOwn(extList, ex)
    }
    catch (err) {
        if (isIntegrityError(err)) {
            failIntegrity(err, path.basename(extTest))
        }
        console.log(`EXT_FAIL ${path.basename(extTest)}: ${String((err && err.message) || err).split('\n')[0]}`)
        process.exit(4)
    }
}
else if (mode === 'full' && opt.nullDraws > 0 && periodArg === 'backtest') {
    let fdExt = path.join(st.records.toolboxDir || path.join(st.rsi.root, 'toolbox'), 'metrics')
    let fs2 = []
    try {
        fs2 = fs.readdirSync(fdExt).filter((f) => /\.mjs$/i.test(f)).sort()
    }
    catch (err) {}
    //--ext-only a,b: 只載入指名之擴充診斷(迴圈之重放用: 只需其中一兩項, 省時間); 同樣只在迴圈之重放(ARSI_HARNESS=1)時生效
    let extOnly = argOf('ext-only', null)
    if (typeof extOnly === 'string' && extOnly && process.env.ARSI_HARNESS === '1') {
        let want = new Set(extOnly.split(',').map((x) => x.trim()).filter((x) => x.length > 0))
        fs2 = fs2.filter((f) => want.has(f.replace(/\.mjs$/i, '')))
    }
    for (let f of fs2) {
        try {
            let ex = await loadExt(path.join(fdExt, f))
            assertIntrinsics('ext-load')
            pushOwn(extList, ex)
        }
        catch (err) {
            //內建物件被改: 不是單一診斷之載入失敗, 整次評估失敗
            if (isIntegrityError(err)) {
                failIntegrity(err)
            }
            extLoadErrors.push({ name: f.replace(/\.mjs$/i, ''), error: String((err && err.message) || err).split('\n')[0].slice(0, 300) })
        }
    }
}
//--ref 可給多個參考模組(逗號分隔): 一次評估即得對各參考之重疊率(不必為每個參考各跑一次)
let refArg = argOf('ref', null)
let refList = typeof refArg === 'string' && refArg.length > 0 ? refArg.split(',').map((x) => x.trim()).filter((x) => x.length > 0) : []
let hasRef = refList.length > 0
let runsMain = null
let m
try {
    m = ev.evalPolicy(pk.pick, {
        ...opt,
        ...win,
        ...(postfit ? { afterFitOnly: true } : {}),
        seed,
        accept: pk.accept,
        ...(extList.length ? { ext: extList } : {}),
        ...(hasRef
            ? {
                onRuns: (rs) => {
                    runsMain = rs
                }
            }
            : {})
    })
    if (extLoadErrors.length) {
        m.ext = { ...(m.ext || {}), ...Object.fromEntries(extLoadErrors.map((x) => [x.name, { error: `載入失敗: ${x.error}` }])) }
    }
    if (typeof extTest === 'string' && extTest) {
        let nm = extList[0].name
        let r = (m.ext && m.ext[nm]) || { error: '無輸出' }
        console.log(r.error ? `EXT_FAIL ${nm}: ${r.error}` : `EXT_OK ${nm}(${r.ms} ms): ${typeof r.text === 'string' ? r.text.slice(0, 300) : JSON.stringify(r).slice(0, 300)}`)
        process.exit(r.error ? 4 : 0)
    }
}
catch (err) {
    if (isIntegrityError(err)) {
        failIntegrity(err, typeof extTest === 'string' && extTest && String(err.where).startsWith('ext') ? extList[0].name : null)
    }
    //寫錯誤結果前再比對一次(驗證拋錯之訊息組字可能執行模組之 toString)
    checkOrFail('pick')
    //研究用本金之檢查(規則 R-EV-43; 評估器自建之錯誤): 操作績效之最大同時持倉名義超過研究用本金 ⇒ 評估中止並回報(離開碼 3)
    if (isCapitalError(err)) {
        //相位、峰值持倉名義與研究用本金皆為評估器之計算值(非輸入值); 畫面之峰值持倉名義至多印 4 位小數(結果檔保留原值)
        let capInfo = { phase: err.phase, peakNotional: err.peakNotional, uIni: err.uIni }
        let pkTxt = typeof capInfo.peakNotional === 'number' && Number.isFinite(capInfo.peakNotional) ? String(Number(capInfo.peakNotional.toFixed(4))) : String(capInfo.peakNotional)
        console.log(`ERROR EVAL_UNIT_CAPITAL ${err.message}(相位 ${capInfo.phase}:峰值持倉名義 ${pkTxt}u > 研究用本金 ${capInfo.uIni}u)`)
        if (fpOut && fpOut !== true) {
            writeJson(path.resolve(fpOut), { ok: false, ...memberInfo(), error: err.message, code: 'EVAL_UNIT_CAPITAL', ...capInfo })
        }
        logEval({ ok: false, code: 'EVAL_UNIT_CAPITAL' })
        process.exit(3)
    }
    console.log(`ERROR PICK_RUN ${String((err && err.stack) || err).split('\n').slice(0, 6).join('\n')}`)
    if (fpOut && fpOut !== true) {
        writeJson(path.resolve(fpOut), { ok: false, ...memberInfo(), error: String((err && err.message) || err), code: 'PICK_RUN' })
    }
    logEval({ ok: false, code: 'PICK_RUN' })
    process.exit(3)
}
//求解窗後段(--period postfit)為佐證、不入 S、階梯與量尺之排序: 不計 S(結果檔之 score 與評估紀錄之 S 為 null)、不印判讀列(與回測期之 S 並列易被當成分數)
let sc = postfit ? null : scoreOf(m, { limits: st.eval.limits, score: st.score, nPh: phaseCountOf(st.eval) })
//與參考模組之選集重疊率(--ref): 診斷用; 參考模組執行失敗只記錯誤, 不影響本模組之評估結果
//  結果檔: refOverlap = 第一個參考(物件; 單一參考時與舊版逐欄相同); 給多個參考時另有 refOverlaps = 全部參考依序之陣列(各自之 ctx.state / ctx.rand)
let overlapOf = async (refPath) => {
    let r4 = (x) => Math.round(x * 10000) / 10000
    try {
        let rk = await loadPick(refPath)
        //await 恢復後先比對, 才走訪本模組之選集(runsMain)
        assertIntrinsics('ref-load')
        //兩個已排序之序號陣列之交集大小
        let inter = (A, B) => {
            let i = 0
            let j = 0
            let c = 0
            while (i < A.length && j < B.length) {
                if (A[i] === B[j]) {
                    c++
                    i++
                    j++
                }
                else if (A[i] < B[j]) {
                    i++
                }
                else {
                    j++
                }
            }
            return c
        }
        let seg = { head: [], mid: [], tail: [] }
        let ofRef = []
        let refSizes = []
        for (let r of runsMain) {
            //參考模組同樣自帳本起點連續執行; 本模組之切片(評估期間內之決策)自其第 k0 個決策起, 逐決策對齊
            let b = ev.runPick(rk.pick, r.phase, seed)
            let k0 = r.k0 || 0
            let nD = r.sels.length
            let nEdge = Math.max(1, Math.round(nD * 0.1))
            for (let k = 0; k < nD; k++) {
                let A = r.sels[k]
                let B = b.sels[k + k0]
                refSizes.push(B.length)
                if (A.length === 0) {
                    continue
                }
                let c = inter(A, B)
                let to = k < nEdge ? seg.head : (k >= nD - nEdge ? seg.tail : seg.mid)
                to.push(c / A.length)
                if (B.length > 0) {
                    ofRef.push(c / B.length)
                }
            }
        }
        let dist = (a) => {
            if (a.length === 0) {
                return { n: 0, mean: null, p10: null, p50: null, p90: null }
            }
            let s = a.slice().sort((x, y) => x - y)
            let q = (p) => r4(s[Math.min(s.length - 1, Math.floor(p * s.length))])
            return { n: a.length, mean: r4(a.reduce((t, v) => t + v, 0) / a.length), p10: q(0.1), p50: q(0.5), p90: q(0.9) }
        }
        let all = [...seg.head, ...seg.mid, ...seg.tail]
        return { ref: path.resolve(refPath), refBytes: rk.bytes, refDesc: rk.meta && rk.meta.desc ? String(rk.meta.desc).slice(0, 160) : null, refSizeMean: r4(refSizes.reduce((t, v) => t + v, 0) / Math.max(1, refSizes.length)), all: dist(all), head: dist(seg.head), mid: dist(seg.mid), tail: dist(seg.tail), ofRefMean: ofRef.length ? r4(ofRef.reduce((t, v) => t + v, 0) / ofRef.length) : null }
    }
    catch (err) {
        //內建物件被改(參考模組違約): 不只是參考模組無法執行 —— 其後之輸出段已不可信, 整次評估失敗
        if (isIntegrityError(err)) {
            failIntegrity(err)
        }
        return { ref: path.resolve(refPath), error: String((err && err.message) || err).split('\n')[0].slice(0, 300) }
    }
}
let refOverlaps = []
if (hasRef && runsMain) {
    for (let rp of refList) {
        let ro = await overlapOf(rp)
        checkOrFail('ref')
        pushOwn(refOverlaps, ro)
    }
}
//輸出前(最後一個 await 之後)比對內建物件: 其後之輸出段為同步, 不會再執行模組之程式
checkOrFail('output')
let refOverlap = refOverlaps.length ? refOverlaps[0] : null
let periodInfo = periodArg === 'train'
    ? { name: 'train', label: '訓練期(診斷;樣本內,不計入判讀)', start: st.periods.train.start, end: st.periods.train.end }
    : (postfit
        ? { name: 'postfit', label: '求解窗後段(診斷;只留求解窗已結束之席;非正本)', start: ev.timeOf(postfit.fromBar), end: st.periods.backtest.start, canonical: false }
        : { name: 'backtest', label: '回測期', start: st.periods.backtest.start, end: st.periods.backtest.end })
let out = { ok: true, mode, period: periodInfo, seed, ...(tieSalt !== 0 ? { tieSalt } : {}), ...(member ? { member: { tag: memberTag, ...member } } : {}), ...(subset ? { subset: { rule: subset.rule, n: subset.n, nFull: subset.nFull, nLong: subset.nLong, nShort: subset.nShort, ...(subset.topFamilies ? { topFamilies: subset.topFamilies } : {}) } } : {}), pick: path.resolve(fpPick), pickBytes: pk.bytes, pickMeta: pk.meta, at: new Date().toISOString(), metrics: m, score: sc, limits: st.eval.limits, loadMs: Date.now() - t0 - m.ms.total, ...(refOverlap ? { refOverlap } : {}), ...(refOverlaps.length > 1 ? { refOverlaps } : {}) }
let f1 = (x) => (typeof x === 'number' ? x.toFixed(1) : String(x))
if (member) {
    console.log(`成員重抽 ${memberTag}: 只用策略庫之${member.half === 0 ? '甲' : '乙'}半(${member.n} 隻 / 全庫 ${member.nFull} 隻;各策略之同分次鍵同全庫)—— 此結果不是正本`)
}
if (subset) {
    let tf = subset.topFamilies ? `;nofam:top 去除之家族 ${subset.topFamilies.map((x) => x.length).join(' / ')} 個(見結果檔之 subset.topFamilies)` : ''
    console.log(`子庫 ${subset.rule}: 留 ${subset.n} 隻 / 全庫 ${subset.nFull} 隻(做多 ${subset.nLong}、做空 ${subset.nShort};各策略之同分次鍵同全庫${tf})—— 此結果不是正本`)
    //空子庫(規則使留下 0 隻; R-EV-47): 評估照常(結果不變), 畫面另加一句警示(規則多半是寫過嚴或互斥, 結果恆為空選集)
    if (subset.n === 0) {
        console.log('警告: 子庫為空(規則使留下 0 隻): 選集恆空、結果無判讀價值; 請檢查 --subset 之規則')
    }
}
if (postfit) {
    console.log(`求解窗後段(--period postfit): 只計決策棒落在 ${periodInfo.start} ~ ${periodInfo.end}(不含)之決策, 且每次決策只留「求解窗之終點棒早於決策棒」之席 —— 此結果不是正本(佐證; 不入 S、階梯與看板之排序; 不印判讀)`)
}
console.log(`[${mode}|${periodInfo.label} ${periodInfo.start.slice(0, 10)} ~ ${periodInfo.end.slice(0, 10)}] 相位 ${m.phases.join(',')} | 決策 ${m.op.nDecisions.join('/')} 次 | 選集大小 均 ${f1(m.sel.sizeMean)}(${m.sel.sizeMin} ~ ${m.sel.sizeMax}), 空 ${m.sel.nEmpty}, 換手 Jaccard ${m.sel.turnoverJaccard}`)
if (m.unit) {
    console.log(`基礎單位(交易規則 步長 ${m.unit.rule.stepSize} / 最小數量 ${m.unit.rule.minQty} / 最小名義價值 ${m.unit.rule.minNotional}, 緩衝 ${m.unit.buffer}, 研究用本金 ${m.unit.uIni}u): 每單之損益 = 每單位損益 × 該單之基礎單位名義; 等效年化 = 損益和 ÷ 最大同時持倉名義 ÷ 年數(挑選與執行規則所見之統計仍為每單位損益與單數)`)
}
console.log(`操作績效(${m.period.cadenceDays} 日一換): 等效年化 均 ${f1(m.op.eqYr.mean)}% 最差相位 ${f1(m.op.eqYr.min)}% 最佳 ${f1(m.op.eqYr.max)}% | 月均單 ${f1(m.op.monthlyOrders.mean)} | 最大同時持倉 ${m.op.peakHold.max}${m.op.peakNotional ? `(名義 ${f1(m.op.peakNotional.max)}u)` : ''} | 勝率 ${(m.op.winRate * 100).toFixed(1)}% | 執行規則 ${m.hasAccept ? `有(下單率 ${(m.op.acceptRate * 100).toFixed(1)}%)` : '無(全收)'}`)
//新鮮度列之相位數 = 本次評估實際所算者(m.phases 之長度; --mode quick 為 2、--phases 覆寫者為其個數; 不取設定之 eval.phases 之長度; 排程第 547 項②之接續)
console.log(`新鮮度(${phaseText(phaseCountOfAll([phaseCountOfMetrics(m)], st.eval), '相位')}均 %): ${m.horizons.map((H) => `${H}d ${f1(m.fresh[H].eqYr.mean)}`).join(' | ')}`)
if (m.null) {
    console.log(`同劑量虛無(${m.null.draws} 抽): 均 ${f1(m.null.mean)}% sd ${f1(m.null.sd)} p95 ${f1(m.null.p95)} | 超額 ${f1(m.null.excess)} z ${m.null.z} p ${m.null.p}`)
}
if (m.nullVol) {
    console.log(`同訊號量虛無(選集之每隻訊號數為全體隨機之 ${m.nullVol.ratio} 倍 ⇒ 改以隨機 ${f1(m.nullVol.sizeMean)} 隻、訊號量相當者比較): 均 ${f1(m.nullVol.mean)}% sd ${f1(m.nullVol.sd)} | 超額 ${f1(m.nullVol.excess)} z ${m.nullVol.z} p ${m.nullVol.p}`)
}
if (m.nullAct) {
    console.log(`同活躍度虛無(隨機選集之活躍度分層與成品相同: 各決策依決策日以前之累計進場數分 ${m.nullAct.bins} 層、各層抽同樣隻數): 均 ${f1(m.nullAct.mean)}% sd ${f1(m.nullAct.sd)} | 超額 ${f1(m.nullAct.excess)} z ${m.nullAct.z} p ${m.nullAct.p}(選集比隨機安靜或活躍時, 同訊號量之超額含活躍度層本身之樣本內差異; 扣掉後剩多少看此列)`)
}
//組成對照與幾何對照: 各三等分段之均(thirdsMean)與成品之三等分並列, 一眼可見成品之超額是否只集中於某一段
let th3 = (x) => (Array.isArray(x.thirdsMean) && m.op.thirds && m.op.thirds.length === 3 ? ` | 三等分之均 ${x.thirdsMean.map((v) => f1(v)).join(' / ')}(成品 ${m.op.thirds.map((g) => f1(g.eqYr.mean)).join(' / ')})` : '')
if (m.nullSideAct) {
    console.log(`同側同活躍度虛無(組成對照: 把選集之每一隻換成同方向、決策日以前累計進場數之名次 ±${m.nullSideAct.half} 名內之隨機一隻): 均 ${f1(m.nullSideAct.mean)}% sd ${f1(m.nullSideAct.sd)} | 超額 ${f1(m.nullSideAct.excess)} z ${m.nullSideAct.z} p ${m.nullSideAct.p}${m.nullSideAct.share === null ? '' : ` | 組成可重現之比例 ${(m.nullSideAct.share * 100).toFixed(0)}%`}${th3(m.nullSideAct)}(${m.nullSideAct.triggered === false ? '選集之每隻訊號數與做多比例皆與全體隨機相近, 此列不入階梯; ' : ''}「方向 × 活躍度」之組成本身就有績效; 同組成內是否挑得比隨機好看此列)`)
}
if (m.nullSideGeo) {
    console.log(`同側同幾何同活躍度虛無(幾何對照: 再匹配該側內止盈 ${m.nullSideGeo.nTp} 等分 × 止損 ${m.nullSideGeo.nSl} 等分; 只供判讀、不入階梯): 均 ${f1(m.nullSideGeo.mean)}% sd ${f1(m.nullSideGeo.sd)} | 超額 ${f1(m.nullSideGeo.excess)} z ${m.nullSideGeo.z} p ${m.nullSideGeo.p}${m.nullSideGeo.share === null ? '' : ` | 可重現之比例 ${(m.nullSideGeo.share * 100).toFixed(0)}%`}${th3(m.nullSideGeo)}`)
}
console.log(`選集組成: 每隻每個決策視窗之訊號數 ${m.sel.sigPerPick}${m.null ? `(虛無 ${m.null.sigPerPick})` : ''} | 做多比例 ${m.sel.longRatio}${m.null ? `(虛無 ${m.null.longRatio})` : ''} | 平均因子數 ${m.sel.nKeysMean} | 平均止盈 / 止損 ${m.sel.tpMean} / ${m.sel.slMean}`)
if (m.op.bySide) {
    let sd = (x) => `${f1(x.orders)} 單、損益 ${x.pnl}、勝率 ${(x.winRate * 100).toFixed(1)}%`
    console.log(`損益歸因(各相位平均;損益 = ${m.unit ? '各單依其基礎單位名義計之損益和(u)' : '每單 1 單位之損益和'}, 合計 ${m.op.pnl}): 做多 ${sd(m.op.bySide.long)} | 做空 ${sd(m.op.bySide.short)}${Array.isArray(m.op.byGroup) && m.op.byGroup.length > 1 ? ` | 依子帳: ${m.op.byGroup.map((g) => `子帳 ${g.group}(每次決策 ${f1(g.seats)} 席)${sd(g)}`).join('、')}` : ''}${m.sel.tagPerf ? ` | 依 tag(共 ${m.sel.tagPerf.length} 種${m.sel.tagPerf.length > 8 ? ';列前 8 種, 全部見 metrics.sel.tagPerf' : ''}): ${m.sel.tagPerf.slice(0, 8).map((t) => `${t.tag} ${t.decisions} 次決策 ${f1(t.orders)} 單 損益 ${t.pnl}`).join('、')}` : ''}`)
}
for (let [nm, r] of Object.entries(m.ext || {})) {
    console.log(`擴充診斷 ${nm}(共用工具區 metrics/${nm}.mjs): ${r.error ? `未算(${r.error})` : (typeof r.text === 'string' ? r.text : JSON.stringify(r).slice(0, 400))}`)
}
if (m.op.thirds && m.op.thirds.length) {
    console.log(`評估期間三等分(各段自空倉起算;看績效是否集中於某一段): ${m.op.thirds.map((g) => `${g.from.slice(0, 10)} ~ ${g.to.slice(0, 10)} 均 ${f1(g.eqYr.mean)}%(最差相位 ${f1(g.eqYr.min)}${g.nullMean === undefined ? '' : `;隨機挑 ${f1(g.nullMean)}`})`).join(' | ')}`)
}
if (m.sel.orders) {
    console.log(`下單集中度(各相位平均): 實際下單之不同策略 ${f1(m.sel.orders.strats)} 隻、不同因子組合 ${f1(m.sel.orders.combos)} 種 | 下單最多之前 1% 進場棒占全部下單 ${(m.sel.orders.barTop1Share * 100).toFixed(1)}% | 單一進場棒最多 ${m.sel.orders.perBarMax} 單`)
}
if (m.sel.sizeDist) {
    console.log(`選集大小之分佈(各決策): p10 ${m.sel.sizeDist.p10} / 中位 ${m.sel.sizeDist.p50} / p90 ${m.sel.sizeDist.p90} | 空選集之決策比例 ${m.sel.emptyRate}${m.sel.tags && m.sel.tags.length ? ` | tag 之決策比例(共 ${m.sel.tagKinds} 種${m.sel.tags.length > 8 ? ';此處列前 8 種, 全部見結果檔之 metrics.sel.tags' : ''}): ${m.sel.tags.slice(0, 8).map((t) => `${t.tag} ${t.share}`).join('、')}${m.sel.tagStats ? ` | 數值 tag 之統計(${m.sel.tagStats.n} 次決策): 均 ${m.sel.tagStats.mean} / p10 ${m.sel.tagStats.p10} / 中位 ${m.sel.tagStats.p50} / p90 ${m.sel.tagStats.p90}` : ''}` : ''}`)
}
for (let ro of refOverlaps) {
    if (ro.error) {
        console.log(`與參考模組之重疊率: 參考模組 ${path.basename(ro.ref)} 無法執行(${ro.error});本模組之評估結果不受影響`)
    }
    else {
        let d = (x) => (x.n ? `均 ${x.mean}(p10 ${x.p10} / 中位 ${x.p50} / p90 ${x.p90};${x.n} 次決策)` : '—')
        console.log(`與參考模組 ${path.basename(ro.ref)} 之選集重疊率(交集 ÷ 本模組之選集大小;參考選集平均 ${ro.refSizeMean} 隻;交集 ÷ 參考選集 均 ${ro.ofRefMean}): 全部 ${d(ro.all)} | 各相位最前 10% 之決策 ${d(ro.head)} | 中段 ${d(ro.mid)} | 最後 10% ${d(ro.tail)}`)
    }
}
if (m.afterFit) {
    let af = m.afterFit
    let ctl = (x) => (x ? `組成對照(同側同活躍度;只換所留之席) 超額 ${f1(x.excess)} z ${x.z} p ${x.p}` : '組成對照 未算(所留之席無訊號)')
    console.log(`求解窗後段之席(每次決策只留求解窗已結束之席): 所留 均 ${f1(af.seatsKept)} 隻、所捨 均 ${f1(af.seatsDropped)} 隻 | 所留之席之等效年化 均 ${f1(m.op.eqYr.mean)}% 最差相位 ${f1(m.op.eqYr.min)}% | ${ctl(m.nullSideAct)} | 下單 ${f1(af.orders)} 單(各相位平均)`)
    if (af.halves) {
        console.log(`求解窗後段之分段(依決策序各半;各段自空倉起算): ${af.halves.map((g, i) => `${i === 0 ? '前段' : '後段'} ${g.from.slice(0, 10)} ~ ${g.to.slice(0, 10)} 等效年化 均 ${f1(g.eqYr.mean)}%(最差相位 ${f1(g.eqYr.min)}), ${ctl(g.sideAct)}, 下單 ${f1(g.orders)} 單`).join(' | ')}`)
    }
    //近期活躍度版之組成對照(規則 R-EV-42): 全段與各段; 未算(所留之席無訊號)者照列; 名次之寬與抽數取自結果
    let rct = (x) => (x ? `超額 ${f1(x.excess)} z ${x.z} p ${x.p}` : '未算(所留之席無訊號)')
    let ra = af.sideActRecent
    console.log(`近 90 日活躍度版之組成對照(把所留之每一席換成同方向、決策日以前近 90 日進場數之名次相鄰之隨機一隻;只換所留之席${ra ? `;名次 ±${ra.half} 名內、${ra.draws} 抽` : ''}): 全段 ${rct(af.sideActRecent)}${af.halves ? ` | 前段 ${rct(af.halves[0].sideActRecent)} | 後段 ${rct(af.halves[1].sideActRecent)}` : ''}(所留之席近期比其累計之同儕更活躍或更安靜時, 與上列之累計活躍度版同向才算穩)`)
    console.log('效度限制: 此段內, 決策棒以前之單多在求解窗內(樣本內); 以過往之損益為輸入之排序鍵, 其輸入於此段與回測期性質不同(回看 N 日之鍵要到求解窗終點之後 N 日, 其輸入才全為求解窗外之單)⇒ 看分段; 以進場時點或結構為輸入之鍵不受此限。同劑量 / 同訊號量 / 同活躍度虛無之替換池為全庫(含求解窗涵蓋此段之策略)⇒ 此段讀組成對照。最後一個決策之視窗可跨過回測期起點至多一個決策間隔')
}
//判讀列: 求解窗後段不印(此段為佐證, 不是成績)
if (!postfit) {
    console.log(`判讀${periodArg === 'train' ? '(訓練期之診斷;不是成績)' : '(回測期)'}: S ${sc.S} 階梯 ${sc.ladder}${sc.flags.vetoed ? ' 否決' : ''} | 各相位之等效年化 ${m.op.eqYr.byPhase.map((v) => f1(v)).join(' / ')}${sc.flags.why.length ? ` | ${sc.flags.why.join('; ')}` : ''}`)
}
logEval({ ok: true, S: sc ? sc.S : null, selHash: m.selHash, ...(hasRef ? { ref: refList.map((x) => path.basename(x)).join(',') } : {}) })
console.log(`selHash ${m.selHash} | 耗時 挑選 ${m.ms.pick}ms 指標 ${m.ms.metrics}ms 虛無 ${m.ms.null}ms(載入 ${out.loadMs}ms)`)
if (fpOut && fpOut !== true) {
    writeJson(path.resolve(fpOut), out)
    console.log(`→ ${path.resolve(fpOut)}`)
}
if (!fs.existsSync(path.resolve(fpPick))) {
    process.exit(2)
}
