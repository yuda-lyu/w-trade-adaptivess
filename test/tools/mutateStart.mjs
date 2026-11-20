/* eslint-disable quotes, no-template-curly-in-string -- 本檔之字串多為「原始碼之片段」(含單引號與 ${…}), 以雙引號書寫以免逐一跳脫 */
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { spawnSync } from 'child_process'
import { FD_ROOT, FD_TMP } from './synthLedger.mjs'


//變異檢查(規則 R-EV-45 之守門之鑑別力): 於 test/_tmp/ 之複本逐一植入一處變異(把新檢測或新接線改回舊行為, 或改成錯的寫法), 跑守門之測試, 須轉紅(被殺)
//  用法: node test/tools/mutateStart.mjs [--list] [--check] [--only <id,id…>] [--out <結果.json>]
//    --check 只核對各變異之錨點(須恰出現一次; all 者至少一次), 不跑測試; 未被殺者(SURVIVED)為測試之缺口 —— 補測試(或資料),不是補斷言
//  複本不含 node_modules(由上層 node_modules 解析); 每個變異跑完還原; 結束刪複本
let GUARDS = ['unit-ledgerStart', 'unit-fakeRound', 'unit-fullLedgerHint'] //對照(無變異之複本)跑之測試; 各變異只跑其「優先跑之測試」(第 4 欄)

//M, [編號, 檔(相對套件根), 變異之編輯 [[找, 換, 全部?]…], 優先跑之測試, 分類(選配): 'equiv'(語意等價: 輸出與行為逐位不變) 或 'survive'(已知存活: 行為確有改變而測試未能不加測試掛鉤地觀察; 逐項註明)]
let M = [
    //── src/eval/ledgerBuild.mjs: 起點之檢查與截取 ──
    ['S01', 'src/eval/ledgerBuild.mjs', [["if (hasStart && !(typeof startTime === 'string' && Number.isFinite(Date.parse(`${startTime}Z`)))) {", 'if (false) {']], ['unit-ledgerStart']],
    ['S02', 'src/eval/ledgerBuild.mjs', [["if (hasStart && !(typeof startTime === 'string' && Number.isFinite(Date.parse(`${startTime}Z`)))) {", 'if (hasStart && !Number.isFinite(Date.parse(`${startTime}Z`))) {']], ['unit-ledgerStart']],
    ['S03', 'src/eval/ledgerBuild.mjs', [["if (hasStart && !(typeof startTime === 'string' && Number.isFinite(Date.parse(`${startTime}Z`)))) {", "if (hasStart && typeof startTime !== 'string') {"]], ['unit-ledgerStart']],
    ['S04', 'src/eval/ledgerBuild.mjs', [['if (hasStart && !(startTime < endTime && arrAll.some((r) => r.time === startTime))) {', 'if (hasStart && !arrAll.some((r) => r.time === startTime)) {']], ['unit-ledgerStart']],
    ['S05', 'src/eval/ledgerBuild.mjs', [['if (hasStart && !(startTime < endTime && arrAll.some((r) => r.time === startTime))) {', 'if (hasStart && !(startTime < endTime)) {']], ['unit-ledgerStart']],
    ['S06', 'src/eval/ledgerBuild.mjs', [['if (hasStart && !(startTime < endTime && arrAll.some((r) => r.time === startTime))) {', 'if (hasStart && !(startTime <= endTime && arrAll.some((r) => r.time === startTime))) {']], ['unit-ledgerStart']],
    ['S07', 'src/eval/ledgerBuild.mjs', [['let arrOhlc = arrAll.filter((r) => (hasStart ? r.time >= startTime : true) && r.time < endTime)', 'let arrOhlc = arrAll.filter((r) => r.time < endTime)']], ['unit-ledgerStart']],
    ['S08', 'src/eval/ledgerBuild.mjs', [['let arrOhlc = arrAll.filter((r) => (hasStart ? r.time >= startTime : true) && r.time < endTime)', 'let arrOhlc = arrAll.filter((r) => (hasStart ? r.time > startTime : true) && r.time < endTime)']], ['unit-ledgerStart']],
    ['S09', 'src/eval/ledgerBuild.mjs', [['let arrOhlc = arrAll.filter((r) => (hasStart ? r.time >= startTime : true) && r.time < endTime)', 'let arrOhlc = arrAll.filter((r) => (hasStart ? r.time >= startTime : true) && r.time <= endTime)']], ['unit-ledgerStart']],
    ['S10', 'src/eval/ledgerBuild.mjs', [['    let hasStart = startTime !== undefined && startTime !== null', '    let hasStart = startTime !== undefined']], ['unit-ledgerStart']],
    //── meta ──
    ['S11', 'src/eval/ledgerBuild.mjs', [['        ...(hasStart ? { startTime } : {}),\n', '        ...(hasStart ? {} : {}),\n']], ['unit-ledgerStart']],
    ['S12', 'src/eval/ledgerBuild.mjs', [['        ...(hasStart ? { startTime } : {}),\n', '        ...{ startTime: hasStart ? startTime : null },\n']], ['unit-ledgerStart']],
    ['S13', 'src/eval/ledgerBuild.mjs', [['        endTime,\n        ...(hasStart ? { startTime } : {}),\n        time0,', '        endTime,\n        time0,\n        ...(hasStart ? { startTime } : {}),']], ['unit-ledgerStart']],
    //── 一致性核對之下界 ──
    ['S20', 'src/eval/ledgerBuild.mjs', [['                    if (e[j] >= iStart && e[j] <= iEnd) {', '                    if (e[j] <= iEnd) {']], ['unit-ledgerStart']],
    ['S21', 'src/eval/ledgerBuild.mjs', [['                    if (e[j] >= iStart && e[j] <= iEnd) {', '                    if (e[j] > iStart && e[j] <= iEnd) {']], ['unit-ledgerStart']],
    ['S22', 'src/eval/ledgerBuild.mjs', [['                    if (e[j] >= iStart && e[j] <= iEnd) {', '                    if (e[j] >= iStart && e[j] < iEnd) {']], ['unit-ledgerStart']],
    ['S23', 'src/eval/ledgerBuild.mjs', [['let iStart = tStart === undefined || tStart === null ? 0 : kpTimeInd.get(tStart)', 'let iStart = tStart === undefined ? 0 : kpTimeInd.get(tStart)']], ['unit-ledgerStart']],
    ['S24', 'src/eval/ledgerBuild.mjs', [['let iStart = tStart === undefined || tStart === null ? 0 : kpTimeInd.get(tStart)', 'let iStart = tStart === undefined || tStart === null ? 0 : (kpTimeInd.get(tStart) ?? 0)']], ['unit-ledgerStart']],
    ['S25', 'src/eval/ledgerBuild.mjs', [['                chk.skipped++\n                if (chk.skippedFirst === null) {', '                chk.n++\n                if (chk.skippedFirst === null) {']], ['unit-ledgerStart']],
    ['S26', 'src/eval/ledgerBuild.mjs', [['                chk.skipped++\n                if (chk.skippedFirst === null) {', '                chk.skipped++\n                chk.n++\n                if (chk.skippedFirst === null) {']], ['unit-ledgerStart']],
    ['S27', 'src/eval/ledgerBuild.mjs', [['...(chk.skipped > 0 ? { skipped: chk.skipped } : {}) },', '...{ skipped: chk.skipped } },']], ['unit-ledgerStart']],
    ['S28', 'src/eval/ledgerBuild.mjs', [['...(chk.skipped > 0 ? { skipped: chk.skipped } : {}) },', '...{} },']], ['unit-ledgerStart']],
    ['S29', 'src/eval/ledgerBuild.mjs', [['    if (chk.skipped > 0) {\n        //記錄', '    if (false) {\n        //記錄']], ['unit-ledgerStart']],
    ['S30', 'src/eval/ledgerBuild.mjs', [['        if (hasStart) {\n            throw new Error(START_FEW_MSG)\n        }\n', '']], ['unit-ledgerStart']],
    ['S33', 'src/eval/ledgerBuild.mjs', [["${chk.n === 0 ? 'WARN' : '注意:'} ${chk.skipped}", '注意: ${chk.skipped}']], ['unit-ledgerStart']],
    ['S34', 'src/eval/ledgerBuild.mjs', [['; 第一個: ${chk.skippedFirst.f} 之 summary.timeOhlcStart = ${tfs}`)', '`)']], ['unit-ledgerStart']],
    ['S35', 'src/eval/ledgerBuild.mjs', [['String(JSON.stringify(chk.skippedFirst.t)).slice(0, 40)', 'String(JSON.stringify(chk.skippedFirst.t)).slice(0, 10)']], ['unit-ledgerStart']],
    ['S36', 'src/eval/ledgerBuild.mjs', [['let iStart = tStart === undefined || tStart === null ? 0 : kpTimeInd.get(tStart)', 'let iStart = !tStart ? 0 : kpTimeInd.get(tStart)']], ['unit-ledgerStart']],
    ['S37', 'src/eval/ledgerBuild.mjs', [['            if (iStart === undefined) {\n', '            if (iStart === undefined || iStart > iEnd) {\n']], ['unit-ledgerStart']],
    ['S38', 'src/eval/ledgerBuild.mjs', [["Number.isFinite(Date.parse(`${startTime}Z`))", 'Number.isFinite(Date.parse(startTime))']], ['unit-ledgerStart']],
    ['S39', 'src/eval/ledgerBuild.mjs', [["${chk.n === 0 ? '(全數略過 ⇒ 無一隻受核對)' : ''}", '']], ['unit-ledgerStart']],
    ['S31', 'src/eval/ledgerBuild.mjs', [["    log(`ohlc ${keyOhlc}: ${n} 根, ${time0} ~ ${arrOhlc[n - 1].time}(${hasStart ? `startTime ${startTime} 含; ` : ''}endTime ${endTime} 不含)`)", "    log(`ohlc ${keyOhlc}: ${n} 根, ${time0} ~ ${arrOhlc[n - 1].time}(endTime ${endTime} 不含)`)"]], ['unit-ledgerStart']],
    //── src/cli/build.mjs ──
    ['B01', 'src/cli/build.mjs', [['        ...(startTime !== undefined && startTime !== null ? { startTime } : {}),\n', '']], ['unit-ledgerStart']],
    ['B02', 'src/cli/build.mjs', [['if (/^invalid (barHours|seriesOffGridMax|startTime|series |settings\\.intervalSec)/.test(m)) {', 'if (/^invalid (barHours|seriesOffGridMax|series |settings\\.intervalSec)/.test(m)) {']], ['unit-ledgerStart']],
    ['B03', 'src/cli/build.mjs', [[".replace(/^invalid (barHours|seriesOffGridMax|startTime)/, 'invalid source.$1')", ".replace(/^invalid (barHours|seriesOffGridMax)/, 'invalid source.$1')"]], ['unit-ledgerStart']],
    ['B04', 'src/cli/build.mjs', [['...(meta.startTime !== undefined ? { startTime: meta.startTime } : {}), ', '']], ['unit-ledgerStart']],
    //B05: 起首列回顯起點(1.0.30 之起首列不回顯; 輸入無效時亦回顯輸入值)
    ['B05', 'src/cli/build.mjs', [['終點 ${endTime} → ${path.resolve(outDir)}`)', "終點 ${endTime}${typeof startTime === 'string' ? `(起點 ${startTime})` : ''} → ${path.resolve(outDir)}`)"]], ['unit-ledgerStart']],
    ['B06', 'src/cli/build.mjs', [['        ...(startTime !== undefined && startTime !== null ? { startTime } : {}),\n', '        ...(startTime !== undefined && startTime !== null && !train ? { startTime } : {}),\n']], ['unit-ledgerStart']],
    //B07 為等價變異: 設定為 null 者傳入 buildLedger 之 startTime: null 與未給同義(hasStart 為假), 輸出逐位相同
    ['B07', 'src/cli/build.mjs', [['        ...(startTime !== undefined && startTime !== null ? { startTime } : {}),\n', '        ...(startTime !== undefined ? { startTime } : {}),\n']], ['unit-ledgerStart'], 'equiv'],
    //帳本起點晚於訓練期起點之 WARN(以時刻比較; 訓練期起點須為字串且可解析)
    ['B09', 'src/cli/build.mjs', [['Date.parse(`${meta.startTime}Z`) > tTrain', 'Date.parse(`${meta.startTime}Z`) >= tTrain']], ['unit-ledgerStart']],
    ['B10', 'src/cli/build.mjs', [['if (meta.startTime !== undefined && st.periods && st.periods.train', 'if (!train && meta.startTime !== undefined && st.periods && st.periods.train']], ['unit-ledgerStart']],
    ['B11', 'src/cli/build.mjs', [['if (meta.startTime !== undefined && st.periods && st.periods.train', 'if (false && meta.startTime !== undefined && st.periods && st.periods.train']], ['unit-ledgerStart']],
    //B12: 拿掉訓練期起點之型別判斷 —— 單元素陣列轉字串後可被解析(['2020-01-01T00:00:00'] ⇒ 該時刻)而誤印 WARN, 由「訓練期起點非字串」案殺
    ['B12', 'src/cli/build.mjs', [[" && typeof st.periods.train.start === 'string') {", ') {']], ['unit-ledgerStart']],
    //B13: 改回字串比較(空格分隔之同一時刻或較晚者因 'T' > ' ' 而誤印 WARN), 由「寫法不同」案殺
    ['B13', 'src/cli/build.mjs', [['Date.parse(`${meta.startTime}Z`) > tTrain', 'meta.startTime > st.periods.train.start']], ['unit-ledgerStart']],
    //S40: 外部序列之範圍判定改以 K 線檔之第一根(而非帳本起點)為界 ⇒ 起點以前之列被計為對不到棒 ⇒ 與 seriesOffGridMax 並用之案殺; B08: 命令列以真假值判斷是否給了起點(假值 '' / 0 / false 等被靜默忽略)⇒ 命令列之假值案殺
    ['S40', 'src/eval/ledgerBuild.mjs', [['                let stat = { endTime, time0 }', '                let stat = { endTime, time0: arrAll[0].time }']], ['unit-ledgerStart']],
    ['B08', 'src/cli/build.mjs', [['        ...(startTime !== undefined && startTime !== null ? { startTime } : {}),\n', '        ...(startTime ? { startTime } : {}),\n']], ['unit-ledgerStart']],
    //── src/cli/backtest.mjs: 回測期旗標之兩帳本起點核對(R-EV-45 ⑧) ──
    ['BT01', 'src/cli/backtest.mjs', [['if ((L.meta.startTime !== undefined || Le.meta.startTime !== undefined) && L.meta.time0 !== Le.meta.time0) {', 'if (false) {']], ['unit-ledgerStart']],
    ['BT02', 'src/cli/backtest.mjs', [['if ((L.meta.startTime !== undefined || Le.meta.startTime !== undefined) && L.meta.time0 !== Le.meta.time0) {', 'if ((L.meta.startTime !== undefined && Le.meta.startTime !== undefined) && L.meta.time0 !== Le.meta.time0) {']], ['unit-ledgerStart']],
    ['BT03', 'src/cli/backtest.mjs', [['if ((L.meta.startTime !== undefined || Le.meta.startTime !== undefined) && L.meta.time0 !== Le.meta.time0) {', 'if ((L.meta.startTime !== undefined || Le.meta.startTime !== undefined)) {']], ['unit-ledgerStart']],
    ['BT04', 'src/cli/backtest.mjs', [['請以同一 startTime 重建全期帳本`)\n        process.exit(5)', '請以同一 startTime 重建全期帳本`)\n        process.exit(2)']], ['unit-ledgerStart']],
    ['BT05', 'src/cli/backtest.mjs', [['if ((L.meta.startTime !== undefined || Le.meta.startTime !== undefined) && L.meta.time0 !== Le.meta.time0) {', 'if ((Le.meta.startTime !== undefined) && L.meta.time0 !== Le.meta.time0) {']], ['unit-ledgerStart']],
    ['BT06', 'src/cli/backtest.mjs', [['if ((L.meta.startTime !== undefined || Le.meta.startTime !== undefined) && L.meta.time0 !== Le.meta.time0) {', 'if ((L.meta.startTime !== undefined) && L.meta.time0 !== Le.meta.time0) {']], ['unit-ledgerStart']],
    ['BT07', 'src/cli/backtest.mjs', [['(全期帳本 time0 ${L.meta.time0}、評估帳本 time0 ${Le.meta.time0};', '(全期帳本 time0 ${Le.meta.time0}、評估帳本 time0 ${L.meta.time0};']], ['unit-ledgerStart']],
    //── src/tools/fakeRound.mjs: 擴充診斷之補算略過不計失敗、自備假診斷之補算(unit-fakeRound) ──
    //F01 / F11: 「有診斷而補算失敗」不計入離開碼(F01: 離開碼之判斷只留子集之項; F11: 補算失敗一律當作略過)⇒ 由 ④(故障注入: 補算之評估失敗)殺
    ['F01', 'src/tools/fakeRound.mjs', [['            let failMain = !okSub || (!fillSkipped && !okFill)', '            let failMain = !okSub']], ['unit-fakeRound']],
    ['F11', 'src/tools/fakeRound.mjs', [['            let fillSkipped = info.skipped !== undefined', '            let fillSkipped = info.skipped !== undefined || !okFill']], ['unit-fakeRound']],
    ['F02', 'src/tools/fakeRound.mjs', [["JSON.stringify({ subset: okSub, fill: fillSkipped ? 'skipped' : okFill, ...info })", 'JSON.stringify({ subset: okSub, fill: okFill, ...info })']], ['unit-fakeRound']],
    ['F03', 'src/tools/fakeRound.mjs', [['            let fillSkipped = info.skipped !== undefined', '            let fillSkipped = false']], ['unit-fakeRound']],
    //F12: 值為錯誤者當作「無其值」而略過(1.0.30 之離開碼 15 變 0)⇒ 由 ③ 殺
    ['F12', 'src/tools/fakeRound.mjs', [['info = { valueError:', "info = { skipped: '第一個節點無其值', valueErrorIgnored:"]], ['unit-fakeRound']],
    //F16: 「無其值」改回 !orig(null、0、false 等假值亦當作無其值而略過;離開碼 15 變 0)⇒ 由 ③ 之 null 案殺; F17: valueError 之文字改回直接取 orig.error(對 null 拋 TypeError)⇒ 由同案殺
    ['F16', 'src/tools/fakeRound.mjs', [['else if (orig === undefined) {', 'else if (!orig) {']], ['unit-fakeRound']],
    ['F17', 'src/tools/fakeRound.mjs', [["(orig && orig.error ? String(orig.error).split('\\n')[0] : `非診斷之結果(${JSON.stringify(orig)})`)", "String(orig.error).split('\\n')[0]"]], ['unit-fakeRound']],
    //F13: 無該診斷檔者之原因字樣與「第一個節點無其值」互換 ⇒ 由 ①、② 殺
    ['F13', 'src/tools/fakeRound.mjs', [["info = { skipped: '第一個節點無其值' }", 'info = { skipped: `正式之共用工具區無此診斷(無 metrics/${nm}.mjs)` }']], ['unit-fakeRound']],
    //F05、F14、F15: 離開碼 / 訊息之判斷拿掉「自備假診斷」之項(F05: 離開碼; F14: 專屬訊息; F15: 判斷恆為真)—— 自備假診斷於測試之專案下皆通過(probe: true), 其失敗須對套件之補算接線注入故障才造得出,
    //  而本案不加「只為測試而設之產品程式掛鉤」⇒ 此三項**存活**(survive; 已知; 其輸出之各欄由 F06 ~ F10 守住)
    ['F05', 'src/tools/fakeRound.mjs', [['            if (failMain || !okProbe) {', '            if (failMain) {']], ['unit-fakeRound'], 'survive'],
    ['F14', 'src/tools/fakeRound.mjs', [["            if (!okProbe) {\n                console.error('自備假診斷之補算(替身評估)不如預期 —— 套件之補算接線有誤(與專案之共用工具區無關)')\n            }\n", '']], ['unit-fakeRound'], 'survive'],
    ['F15', 'src/tools/fakeRound.mjs', [['okProbe = threw2 && rp.nNodes === 1', 'okProbe = true || threw2 && rp.nNodes === 1']], ['unit-fakeRound'], 'survive'],
    ['F06', 'src/tools/fakeRound.mjs', [["threw2 = /無此擴充診斷/.test(String(err.message))", 'threw2 = false']], ['unit-fakeRound']],
    ['F07', 'src/tools/fakeRound.mjs', [["{ ok: true, metrics: { selHash: sel4, ext: { [pn]: val } } }", "{ ok: true, metrics: { selHash: 'x', ext: { [pn]: val } } }"]], ['unit-fakeRound']],
    ['F08', 'src/tools/fakeRound.mjs', [["                fs.writeFileSync(path.join(fdM, `${pn}.mjs`), 'export default function (api) {\\n    return { text: \\'假探針\\' }\\n}\\n', 'utf8')\n", '']], ['unit-fakeRound']],
    ['F09', 'src/tools/fakeRound.mjs', [['let rp2 = await Pj.extFill({ names: [pn], only: [x0.id], runEval: stub })', 'let rp2 = await Pj.extFill({ names: [pn], only: [x0.id], force: true, runEval: stub })']], ['unit-fakeRound']],
    ['F10', 'src/tools/fakeRound.mjs', [['ext: { [pn]: val } } }', "ext: { [pn]: { ...val, n: 4 } } } }"]], ['unit-fakeRound']],
    //── src/tools/fakeRound.mjs: 「真實診斷」取檔之夾 = 評估之子行程之解析(records.toolboxDir, 未給 = <rsi.root>/toolbox; unit-fakeRound ⑥ 兩案與 ⑤)——
    //F20: 改回取 <rsi.root>/toolbox/metrics(未依 records.toolboxDir; 提案 §7 所述之舊寫法)⇒ ⑥(診斷檔只在 records.toolboxDir 指向之夾)殺; F21: 未給 records.toolboxDir 時之預設位置錯 ⇒ ⑥(設定未給 records.toolboxDir)殺〔⑤ 不殺:initProject 之參考設定帶 records.toolboxDir,走不到預設分支〕;
    //F22: 取檔改為假專案之共用工具區(取得之時機錯: st.rsi.root 已改為假根之後)⇒ ⑤、⑥ 殺(實跑先被 ② 殺)
    ['F20', 'src/tools/fakeRound.mjs', [["let srcM = path.join(realToolboxDir, 'metrics', `${nm}.mjs`)", "let srcM = path.join(realRoot, 'toolbox', 'metrics', `${nm}.mjs`)"]], ['unit-fakeRound']],
    ['F21', 'src/tools/fakeRound.mjs', [["let realToolboxDir = st.records.toolboxDir || path.join(realRoot, 'toolbox')", "let realToolboxDir = st.records.toolboxDir || path.join(realRoot, 'toolbox_x')"]], ['unit-fakeRound']],
    ['F22', 'src/tools/fakeRound.mjs', [["let srcM = path.join(realToolboxDir, 'metrics', `${nm}.mjs`)", "let srcM = path.join(fdM, `${nm}.mjs`)"]], ['unit-fakeRound']],
    //── src/tools/fakeRound.mjs: 特別之節點(臂目錄之提案者、自報可共用之輔助與未作用之臂、用另一份挑選模組者)= 第 1 輪之計畫第 1 個節點, 與派工先後無關(unit-fakeRound ⑦)——
    //F30: 特別之節點取計畫第 2 個(假做夢之重做者: 節點文件被重做之交付覆寫而無提案一行; 重做之交付不再特別〔firstDone〕)⇒ 殺(離開碼 8); F31: 取計畫第 3 個(假做夢之刪除者: 節點文件移入回收夾; 發布版之寬鬆核對〔節點夾或回收夾任一文件含該行〕不殺此變異, 改後之核對只認節點夾)⇒ 殺
    //F32: 改回發布版之寫法(第 1 次被呼叫者 = 第 1 個被派工者)⇒ ⑦ 之「第 2 個先派工」兩案殺; F33: 不讀計畫(無特別之節點)⇒ 殺
    //F34 ~ F36: 特別之節點之三項自報(臂目錄之提案、可共用之輔助、未作用之臂)各自拿掉 ⇒ 殺(離開碼 8、5、10): 三項皆於各種派工次序下被核對
    //F37、F38: 提案者之節點文件之核對改查 .json(不含該行)/ 改查回收夾 ⇒ 殺; F40: 節點文件之渲染不列提案一行(src/arsi/records.mjs)⇒ 殺(只有提案者之節點文件之核對看得到; 離開碼 8)
    //F39(equiv): 提案者之節點文件之核對改回發布版之寫法(節點夾或回收夾任一文件含該行)⇒ 於特別之節點 = 計畫第 1 個(採納者)時兩者結果逐位相同(兩者只在特別之節點為被刪除者時有別 —— 見 F31、F41)⇒ 語意等價
    //F41: F31 + F39(特別之節點為被刪除者 + 寬鬆之核對 ⇒ fakeRound 自身之核對放行)⇒ 由 ⑦ 之三處斷言殺(提案帳之出處與「再提」、做夢任務書列之節點、提案者之節點文件)—— 測試不只倚賴 fakeRound 自身之核對
    //F42: 派工次序之複本(test/tools/fakeRoundCopy.mjs)不依 order 排序 ⇒ ⑦ 之「鑑別前提: 範本第 k 個節點最先派工」殺
    //F43(equiv): 拿掉「特別之派工只發生一次」之守衛(firstDone)⇒ 特別之節點 = 計畫第 1 個(採納者; 不被重做、第 2 輪之計畫不含它)時其派工本來就只有一次, 結果逐位相同 ⇒ 語意等價;
    //  守衛之作用只在「特別之節點被重做」時(計畫次序與範本次序不一致之故障)令提案者之核對失敗(F30), 而不被重做之交付補上提案
    //F44: F43 + F30(特別之節點為重做者,且重做之交付仍帶提案 ⇒ fakeRound 自身之核對放行)⇒ 由 ⑦ 之三處斷言殺(提案帳之「再提」與出處、做夢任務書列之節點、提案者之節點文件)
    ['F30', 'src/tools/fakeRound.mjs', [['    return items[0].id\n', '    return items[1].id\n']], ['unit-fakeRound']],
    ['F31', 'src/tools/fakeRound.mjs', [['    return items[0].id\n', '    return items[2].id\n']], ['unit-fakeRound']],
    ['F32', 'src/tools/fakeRound.mjs', [['        let first = !firstDone && path.basename(wd) === firstId\n', '        let first = nNodeCalls++ === 0\n'], ['let firstId = null\n', 'let firstId = null\nlet nNodeCalls = 0\n']], ['unit-fakeRound']],
    ['F33', 'src/tools/fakeRound.mjs', [['            firstId = planFirstId()\n', "            firstId = ''\n"]], ['unit-fakeRound']],
    ['F34', 'src/tools/fakeRound.mjs', [['...(first ? { armProposals:', '...(false ? { armProposals:']], ['unit-fakeRound']],
    ['F35', 'src/tools/fakeRound.mjs', [["shareable: first ? [{ file: 'helper.mjs'", "shareable: false ? [{ file: 'helper.mjs'"]], ['unit-fakeRound']],
    ['F36', 'src/tools/fakeRound.mjs', [["inactiveArms: first ? arms.split(',')", "inactiveArms: false ? arms.split(',')"]], ['unit-fakeRound']],
    ['F37', 'src/tools/fakeRound.mjs', [["(readOr(path.join(st.records.nodeDir, `${firstId}.md`))", "(readOr(path.join(st.records.nodeDir, `${firstId}.json`))"]], ['unit-fakeRound']],
    ['F38', 'src/tools/fakeRound.mjs', [["(readOr(path.join(st.records.nodeDir, `${firstId}.md`))", "(readOr(path.join(st.records.trashDir, `${firstId}.md`))"]], ['unit-fakeRound']],
    ['F39', 'src/tools/fakeRound.mjs', [["        (readOr(path.join(st.records.nodeDir, `${firstId}.md`)) || '').includes('- 臂目錄之提案(由做夢彙整、主控審查):') &&\n", "        [st.records.nodeDir, st.records.trashDir].some((dir) => fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.md') && fs.readFileSync(path.join(dir, f), 'utf8').includes('- 臂目錄之提案(由做夢彙整、主控審查):'))) &&\n"]], ['unit-fakeRound'], 'equiv'],
    ['F40', 'src/arsi/records.mjs', [['    if (d.conclusion && isArr(d.conclusion.armProposals) && d.conclusion.armProposals.length) {\n', '    if (false) {\n']], ['unit-fakeRound']],
    ['F41', 'src/tools/fakeRound.mjs', [['    return items[0].id\n', '    return items[2].id\n'], ["        (readOr(path.join(st.records.nodeDir, `${firstId}.md`)) || '').includes('- 臂目錄之提案(由做夢彙整、主控審查):') &&\n", "        [st.records.nodeDir, st.records.trashDir].some((dir) => fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.md') && fs.readFileSync(path.join(dir, f), 'utf8').includes('- 臂目錄之提案(由做夢彙整、主控審查):'))) &&\n"]], ['unit-fakeRound']],
    ['F42', 'test/tools/fakeRoundCopy.mjs', [["'        __ord.seq = [...first, ...ids.filter((x) => !first.includes(x))]',", "'        __ord.seq = ids',"]], ['unit-fakeRound']],
    ['F43', 'src/tools/fakeRound.mjs', [['        let first = !firstDone && path.basename(wd) === firstId\n', '        let first = path.basename(wd) === firstId\n']], ['unit-fakeRound'], 'equiv'],
    ['F44', 'src/tools/fakeRound.mjs', [['        let first = !firstDone && path.basename(wd) === firstId\n', '        let first = path.basename(wd) === firstId\n'], ['    return items[0].id\n', '    return items[1].id\n']], ['unit-fakeRound']],
    //F45: 讀不到本輪之計畫時改以派工次序決定(第 1 個被派工者 = 改前之寫法; 不拋錯)⇒ ⑦ 之「讀不到計畫(故障注入)離開碼非 0」殺
    ['F45', 'src/tools/fakeRound.mjs', [['            firstId = planFirstId()\n', '            firstId = (() => { try { return planFirstId() } catch (err) { return path.basename(wd) } })()\n']], ['unit-fakeRound']],
    //── src/domain/backtest.mjs、domain.mjs、cli/rsi.mjs: 全期帳本未建之說明與訊息不指向不存在之 g_build.mjs --full(unit-fullLedgerHint; 規則 R-EV-45 ⑨)──
    //T01: 共用訊息改回舊字樣 ⇒ ①②③ 殺; T02: validatePending 之出口改回舊字樣 ⇒ ②③ 殺; T03: 命令列說明改回舊字樣 ⇒ ③ 殺;
    //T04: 訊息不註明與評估帳本用同一個起點 ⇒ ①② 殺; T05: 回測期旗標之出口把「未啟用」與「全期帳本未建」對調 ⇒ ① 殺
    ['T01', 'src/domain/backtest.mjs', [["let FULL_LEDGER_MSG = '全期帳本未建(由使用端以聚合入口之 buildLedger 自建於 settings.backtest.ledgerDir, 與評估帳本用同一個 source.startTime; g_build.mjs 不建它)'", "let FULL_LEDGER_MSG = '全期帳本未建(node g_build.mjs --full)'"]], ['unit-fullLedgerHint']],
    ['T02', 'src/domain/domain.mjs', [["bt.cfg.enabled ? FULL_LEDGER_MSG :", "bt.cfg.enabled ? '全期帳本未建(node g_build.mjs --full)' :"]], ['unit-fullLedgerHint']],
    ['T03', 'src/cli/rsi.mjs', [['(需先有全期帳本: 由使用端以聚合入口之 buildLedger 自建於 settings.backtest.ledgerDir, 與評估帳本用同一個 source.startTime; g_build.mjs 不建它)', '(需先 node g_build.mjs --full)']], ['unit-fullLedgerHint']],
    ['T04', 'src/domain/backtest.mjs', [["與評估帳本用同一個 source.startTime; g_build.mjs 不建它)'", "與評估帳本用同一個起點; g_build.mjs 不建它)'"]], ['unit-fullLedgerHint']],
    ['T05', 'src/domain/backtest.mjs', [["error: bt.enabled ? FULL_LEDGER_MSG : '未啟用'", "error: bt.enabled ? '未啟用' : FULL_LEDGER_MSG"]], ['unit-fullLedgerHint']],
]

let args = process.argv.slice(2)
let argv = (k, d = null) => {
    let i = args.indexOf(`--${k}`)
    return i < 0 ? d : (args[i + 1] === undefined || args[i + 1].startsWith('--') ? true : args[i + 1])
}
if (args.includes('--list')) {
    console.log(M.map((m) => `${m[0]} ${m[1]}`).join('\n'))
    process.exit(0)
}
let only = argv('only') ? String(argv('only')).split(',') : null
let sel = M.map((m, i) => ({ m, i: i + 1 })).filter((x) => (only ? only.includes(x.m[0]) : true))
let check = args.includes('--check')

let normNl = (s) => s.replace(/\r\n/g, '\n')
let root = path.join(FD_TMP, `mutStart_${process.pid}`)
fs.rmSync(root, { recursive: true, force: true })
fs.mkdirSync(root, { recursive: true })
for (let d of ['src', 'contract', 'arms', 'examples']) {
    fs.cpSync(path.join(FD_ROOT, d), path.join(root, d), { recursive: true })
}
fs.mkdirSync(path.join(root, 'test', 'tools'), { recursive: true })
for (let f of fs.readdirSync(path.join(FD_ROOT, 'test', 'tools'))) {
    fs.copyFileSync(path.join(FD_ROOT, 'test', 'tools', f), path.join(root, 'test', 'tools', f))
}
let testFiles = new Set(sel.flatMap((x) => [...x.m[3], ...GUARDS]))
for (let g of testFiles) {
    let f = `${g}.test.mjs`
    if (fs.existsSync(path.join(FD_ROOT, 'test', f))) {
        fs.copyFileSync(path.join(FD_ROOT, 'test', f), path.join(root, 'test', f))
    }
}
for (let f of ['settings.json', 'package.json']) {
    fs.copyFileSync(path.join(FD_ROOT, f), path.join(root, f))
}
let mocha = createRequire(import.meta.url).resolve('mocha/bin/mocha.js')
let runMocha = (files, extra = []) => spawnSync(process.execPath, [mocha, ...extra, '--no-parallel', ...files, '--timeout', '180000'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 900000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ARSI_ROOT: '' } })
let guardFiles = (hint) => hint.filter((g) => fs.existsSync(path.join(root, 'test', `${g}.test.mjs`))).map((g) => path.join('test', `${g}.test.mjs`))

//對照(每次執行之第一步; --check 除外): 無變異之複本須全綠 —— 否則「被殺」可能只是複本內之測試本身失敗而非變異之效果
if (!check) {
    let r = runMocha(guardFiles(GUARDS))
    let m = /(\d+) passing/.exec(`${r.stdout}`)
    console.log(`對照(無變異之複本): ${r.status === 0 ? '全綠' : '失敗(變異之結果不可信,中止)'}${m ? `,${m[1]} 項通過` : ''}`)
    if (r.status !== 0) {
        console.log(`${r.stdout}\n${r.stderr}`.slice(-1500))
        fs.rmSync(root, { recursive: true, force: true })
        process.exit(3)
    }
}
let results = []
let apply = (text, edits, id) => {
    let t = text
    for (let [find, rep, all] of edits) {
        let n = t.split(find).length - 1
        if (all ? n < 1 : n !== 1) {
            throw new Error(`${id}: 錨點出現 ${n} 次(須${all ? '至少' : '恰'} 1 次): ${find.slice(0, 60)}`)
        }
        t = t.split(find).join(rep)
    }
    return t
}
for (let { m, i } of sel) {
    let [id, file, edits, hint] = m
    let fp = path.join(root, file)
    let orig = fs.readFileSync(fp, 'utf8')
    let o = { id, i, file }
    try {
        //錨點以 LF 比對(複本可能為 CRLF): 先把檔轉為 LF 再套用(複本只供測試, 行尾不影響行為)
        let mutated = apply(normNl(orig), edits, id)
        if (check) {
            o.status = 'anchor-ok'
        }
        else {
            fs.writeFileSync(fp, mutated, 'utf8')
            let t0 = Date.now()
            let r = runMocha(guardFiles(hint), ['--bail'])
            let out = `${r.stdout}\n${r.stderr}`
            let fail = /\n\s+1\) ([^\n]+)\n\s+([^\n]+)/.exec(out)
            //分類(照實): equiv = 語意等價(輸出與行為逐位不變; 存活為預期); survive = 已知存活(非等價: 行為確有改變, 但測試未能不加「只為測試而設之產品程式掛鉤」而觀察到; 逐項說明於其編輯旁之註解; 存活為預期, 被殺亦可);
            //  其餘者須被殺, 存活即 SURVIVED(測試之缺口)
            o.status = r.status === 0 ? (m[4] === 'equiv' ? 'equivalent' : (m[4] === 'survive' ? 'survived-known' : 'SURVIVED')) : (m[4] === 'equiv' ? 'EQUIV-KILLED' : 'killed')
            o.by = r.status === 0 ? '' : (fail ? `${fail[1]} / ${fail[2]}`.slice(0, 140) : out.slice(-200).replace(/\s+/g, ' '))
            o.sec = Math.round((Date.now() - t0) / 100) / 10
        }
    }
    catch (err) {
        o.status = 'ANCHOR-ERROR'
        o.by = String(err.message).slice(0, 200)
    }
    finally {
        fs.writeFileSync(fp, orig, 'utf8')
    }
    results.push(o)
    console.log(`${String(i).padStart(3)} ${o.id} ${o.status}${o.sec !== undefined ? ` (${o.sec}s)` : ''}${o.by ? ` — ${o.by}` : ''}`)
}
fs.rmSync(root, { recursive: true, force: true })
let st = (s) => results.filter((x) => x.status === s).length
console.log(`\n共 ${results.length} 項:killed ${st('killed')}、equivalent(語意等價,預期存活)${st('equivalent')}、survived-known(已知存活,非等價)${st('survived-known')}、SURVIVED(非預期) ${st('SURVIVED')}、ANCHOR-ERROR ${st('ANCHOR-ERROR')}${check ? `、anchor-ok ${st('anchor-ok')}` : ''}`)
if (argv('out')) {
    fs.writeFileSync(path.resolve(String(argv('out'))), JSON.stringify(results, null, 2), 'utf8')
}
process.exit(st('SURVIVED') + st('ANCHOR-ERROR') > 0 ? 1 : 0)
