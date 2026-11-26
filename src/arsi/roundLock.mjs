import path from 'path'
import { acquireRunLock } from './runner.mjs'


//輪次鎖(規則 R-RUN-4、R-RUN-15; 排程第 622 項 ②): 寫狀態根(樹、節點文件、做夢文件、看板、共同儲存區、臂目錄)之入口一律取同一把鎖 <狀態根>/logs/round.lock,
//  與輪次、重算(reverify、extfill、fill)、前緣之結案與改掛(--mode frontier --close / --rearm)不得並行; 取不到(另有執行中或疑似卡住)⇒ 本次不執行、離開碼 3(同既有之寫入入口)
//  原: --mode validate / annotate / dirtype / board / init 不取鎖; 工具 armDecide / armInactive / exposure / formSet 只 peekRunLock(只看一眼, 看完即放手 ⇒ 看與寫之間輪次可以起跑, 且兩個工具可同時寫)
//  取得後持有至行程結束(含 process.exit; 以 'exit' 事件釋放): 同一行程只取一次

//roundLockPathOf, 輪次鎖之路徑(單一定義; 輪次、重算、前緣操作、工具皆取此檔)
/**
 * 輪次鎖之路徑
 *
 * @param {String} stateRoot 輸入狀態根(settings.rsi.root 解析後之路徑)
 * @returns {String} 回傳 <狀態根>/logs/round.lock
 * @example
 * roundLockPathOf('./rsi') // => 'rsi/logs/round.lock'
 */
let roundLockPathOf = (stateRoot) => path.join(stateRoot, 'logs', 'round.lock')

//takeRoundLockOrExit, 取輪次鎖; 取不到 ⇒ 由 onBusy(lock) 印出訊息(各入口維持其既有之用字與輸出串流)後以離開碼 3 結束
/**
 * 寫入前取輪次鎖(取得後持有至行程結束);取不到時呼叫 onBusy(lock)(lock 為 acquireRunLock 之未取得結果:{ ok: false, why, pid, startedAt, beatAt })印訊息,再以離開碼 3 結束行程
 *
 * @param {String} stateRoot 輸入狀態根
 * @param {Function} onBusy 輸入取不到鎖時印訊息之函數 (lock) → void
 * @returns {Object} 回傳 acquireRunLock 取得之鎖 { ok: true, release, beat }
 * @example
 * let lock = takeRoundLockOrExit(root, (lk) => console.error(`輪次進行中(pid ${lk.pid})`))
 */
let takeRoundLockOrExit = (stateRoot, onBusy) => {
    let lock = acquireRunLock(roundLockPathOf(stateRoot))
    if (!lock.ok) {
        onBusy(lock)
        process.exit(3)
    }
    process.on('exit', () => lock.release())
    return lock
}

export { roundLockPathOf, takeRoundLockOrExit }
