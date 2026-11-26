import fs from 'node:fs'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'


//測試用之預載(node --import): 讓被測之命令列入口於結束時、釋放輪次鎖之前暫停, 供父行程於「入口仍持有鎖」之時點起第二個入口、觀察互斥(事件同步, 不以延時)
//  環境變數(由 test/tools/synthProject.mjs 之 holdEntry 設定; 取得後即自行程環境刪除, 使其子行程不再受影響):
//    HOLD_SIGNAL  信號檔(JSON): { pid, lockAtExit: 結束時之鎖檔內容(無 = null), firstWrite: { op, rel, lock: 當時之鎖檔內容 } | null }
//    HOLD_GO      暫停至此檔出現(最長 120 秒, 防懸置)
//    HOLD_LOCK    輪次鎖之路徑(<狀態根>/logs/round.lock)
//    HOLD_ROOT    專案根: 只記其下之寫入(排除鎖檔本身與 logs/ 之事件檔)
//  firstWrite: 包裝 fs 之寫入類函數(writeFileSync、appendFileSync、renameSync、copyFileSync、unlinkSync、rmSync; 不含 mkdirSync —— rsi.init() 之 paths.ensure() 於既有之狀態根只是重複建夾),
//    記「專案根下首次被寫」之那一刻之鎖檔內容 ⇒ 證明鎖於首次寫入之前已取得
//  'exit' 之處理函數於預載時即登錄 ⇒ 先於入口自己登錄之「釋放鎖」(listener 依登錄次序呼叫)
let sig = process.env.HOLD_SIGNAL
let go = process.env.HOLD_GO
let lockFp = process.env.HOLD_LOCK
let root = process.env.HOLD_ROOT
for (let k of ['HOLD_SIGNAL', 'HOLD_GO', 'HOLD_LOCK', 'HOLD_ROOT']) {
    delete process.env[k]
}
if (sig && go && lockFp && root) {
    let norm = (p) => path.resolve(String(p)).replace(/\\/g, '/').toLowerCase()
    let rootN = norm(root)
    let lockN = norm(lockFp)
    let readLock = () => {
        try {
            return JSON.parse(fs.readFileSync(lockFp, 'utf8'))
        }
        catch (err) {
            return null
        }
    }
    let firstWrite = null
    let watch = (op) => {
        let orig = fs[op]
        fs[op] = function (...args) {
            let targets = op === 'renameSync' || op === 'copyFileSync' ? [args[0], args[1]] : [args[0]]
            if (firstWrite === null) {
                for (let t of targets) {
                    if (typeof t === 'string' || t instanceof URL) {
                        let n = norm(t instanceof URL ? t.pathname : t)
                        if (n.startsWith(`${rootN}/`) && n !== lockN && !n.includes('/logs/') && !n.includes('/_hold_')) {
                            firstWrite = { op, rel: n.slice(rootN.length + 1), lock: readLock() }
                            break
                        }
                    }
                }
            }
            return orig.apply(this, args)
        }
    }
    for (let op of ['writeFileSync', 'appendFileSync', 'renameSync', 'copyFileSync', 'unlinkSync', 'rmSync']) {
        watch(op)
    }
    syncBuiltinESMExports()
    process.on('exit', () => {
        fs.writeFileSync(sig, JSON.stringify({ pid: process.pid, lockAtExit: readLock(), firstWrite }), 'utf8')
        let cell = new Int32Array(new SharedArrayBuffer(4))
        let t0 = Date.now()
        while (!fs.existsSync(go) && Date.now() - t0 < 120000) {
            Atomics.wait(cell, 0, 0, 25)
        }
    })
}
