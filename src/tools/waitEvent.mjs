import path from 'path'
import { settingsOrExit, cliGuard, argNumOf, timeMsOf } from '../cfg.mjs'
import { waitRunEnd } from '../arsi/waitEnd.mjs'
import { roundLockPathOf } from '../arsi/roundLock.mjs'

//命令列之旗標只認 --timeout-min、--since、--poll-sec(TOOL_FLAGS.waitEvent; 空白分隔): 等號、未列、重複、無值、多餘之值一律拒收(離開碼 2; 於讀設定之前; 訊息固定、不帶輸入值; 原: 靜默忽略而等到預設之時限)
cliGuard('waitEvent')

//等待一次執行結束(監看端用; 唯讀): 等事件檔 rsi/logs/events.jsonl 出現新的結束類事件(run-done / run-failed / skipped), 印出後結束
//  node tools/waitEvent.mjs [--timeout-min 110] [--since <時間字串>] [--poll-sec 20]
//    --since      只看此時間以後之事件(預設 = 本工具啟動之時刻; 起跑後才啟動本工具而怕錯過者, 給起跑之時刻); 時間字串 = YYYY-MM-DDTHH:mm:ss(可帶 .SSS、可帶 Z 或 ±hh:mm; 如 2026-11-23T02:00:00Z; 不帶時區者依本機時區);
//                 其他寫法(空格分隔、只有日期、不存在之日期)拒收(離開碼 2; 原: 無效 ⇒ NaN ⇒ 比較恆假而永看不到事件)
//    --timeout-min 最長等待(預設 110 分; 背景指令之時限為 120 分, 逾時即印 TIMEOUT 並以離開碼 4 結束, 由呼叫端重掛); 正數且換成毫秒不超過 2147483647(即 ≤ 35791 分), 無效 ⇒ 拒收(0 亦拒收; 原: NaN ⇒ 永不結束)
//    --poll-sec   取樣間隔(預設 20 秒; 至少 2 秒); 正數且換成毫秒不超過 2147483647, 無效 ⇒ 拒收
//  輸出(最後一行為機器可讀之一列 JSON): 事件本身; 其間之 round-done 事件逐列印出
//  離開碼: 0 = run-done; 1 = run-failed; 3 = skipped; 4 = 逾時(執行仍在進行); 5 = 鎖檔之行程已不在而無結束事件(異常結束)
let st = settingsOrExit()
//旗標之值(排程第 607 項; 已於上之 cliGuard 檢查〔CLI_VALUES.waitEvent〕: --timeout-min 為正數且換成毫秒不超過 2147483647、--poll-sec 同(秒)、--since 為時間字串〔T2〕; 檢測之值即使用之值 —— 取轉換值, K4):
//  原: `Number(abc)` 為 NaN ⇒ 逾時之計時器與取樣間隔皆為 NaN ⇒ 永不結束 / 永看不到結束事件; --since 無效 ⇒ NaN ⇒ 比較恆假
let fdLogs = path.join(st.rsi.root, 'logs')
let fpEvents = path.join(fdLogs, 'events.jsonl')
let fpLock = roundLockPathOf(st.rsi.root)
let i0 = process.argv.indexOf('--since')
let since = i0 >= 0 ? timeMsOf(process.argv[i0 + 1]) : Date.now()
let timeoutMs = argNumOf('timeout-min', 'timerMin', 110) * 60000
let pollMs = Math.max(2, argNumOf('poll-sec', 'timerSec', 20)) * 1000
//本體在 src/arsi/waitEnd.mjs(注入時間與讀取、帶觀察回調 opt.onTrace, 供測試以事件同步; 輸出與離開碼與原迴圈逐字相同)
process.exit(await waitRunEnd({ fpEvents, fpLock, since, timeoutMs, pollMs }))
